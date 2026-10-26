import { and, desc, eq, inArray } from "drizzle-orm";
import { EVENT_TYPES, type TaskSpec } from "@devteam/contracts";
import { opencodeFetch } from "@devteam/agents";
import {
  agentRoles,
  agentRuns,
  artifacts,
  auditEvents,
  artifactVersions,
  getDb,
  insertMessage,
  memories,
  projects,
  rooms,
  specContent,
  tasks,
  testRuns,
  workspaces,
} from "@devteam/db";
import { canonicalArtifactKey, uuidv7 } from "@devteam/domain";
import {
  detectTestCommand,
  runCommand,
  workspaceChangedFiles,
  workspaceDiff,
} from "./manager.js";
import { verifyWork, type VerificationResult } from "./verification.js";

export type EmitFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface WorkRunInput {
  projectId: string;
  taskId: string;
  workspaceId: string;
  emit: EmitFn;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CODE_PERMISSIONS = [
  { action: "shell", resource: "git push *", effect: "deny" },
  { action: "shell", resource: "git reset --hard *", effect: "deny" },
  { action: "shell", resource: "rm -rf *", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
];

function buildWorkPrompt(input: {
  projectName: string;
  projectDescription: string;
  taskTitle: string;
  taskDescription: string;
  acceptance: string[];
  roleName: string;
  specContext: string;
  memoryContext?: string;
}): string {
  return [
    `你是 ${input.roleName}，在 Fucking Code 的一个隔离 Git worktree 中完成一个开发任务。`,
    "",
    `项目：${input.projectName}`,
    `项目背景：${input.projectDescription}`,
    "",
    `任务：${input.taskTitle}`,
    `描述：${input.taskDescription}`,
    "验收标准：",
    ...(input.acceptance.length ? input.acceptance.map((item) => `- ${item}`) : ["- 无额外验收标准"]),
    "",
    "## 已确认的验收规格（必须满足，测试通过不等于规格满足）",
    input.specContext || "（没有绑定已确认规格，仅以测试为准）",
    input.memoryContext ? `\n## 项目长期记忆\n${input.memoryContext}` : "",
    "",
    "工作方式：",
    "1. 先读相关代码和测试，确认现状。",
    "2. 直接实现，改动要小而完整；不要重写无关文件。",
    "3. 运行测试，确保通过；如果失败，先修复再结束。",
    "4. 不要执行 git push、不要切换或合并主分支、不要删除仓库、不要访问工作目录之外的文件。",
    "5. 结束时用 3-5 句话总结：改了哪些文件、测试结果、剩余风险。",
  ].join("\n");
}

async function upsertArtifact(input: {
  projectId: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  createdBy: string;
  messageId: string;
  emit: EmitFn;
}): Promise<string> {
  const db = getDb();
  const artifactKey = canonicalArtifactKey(input.kind, input.title);
  const [existing] = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, input.projectId),
        eq(artifacts.kind, input.kind),
        eq(artifacts.artifactKey, artifactKey),
      ),
    )
    .limit(1);

  if (existing) {
    const version = existing.currentVersion + 1;
    await db.insert(artifactVersions).values({
      id: uuidv7(),
      artifactId: existing.id,
      version,
      content: input.content,
      summary: input.summary,
      sourceMessageId: input.messageId,
      createdBy: input.createdBy,
    });
    await db
      .update(artifacts)
      .set({
        artifactKey,
        title: input.title,
        currentVersion: version,
        status: "in_review",
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, existing.id));
    await input.emit(EVENT_TYPES.artifactChanged, {
      artifactId: existing.id,
      artifactKey,
      action: "version_created",
      version,
      kind: input.kind,
      title: input.title,
    });
    return existing.id;
  }

  const id = uuidv7();
  await db.insert(artifacts).values({
    id,
    projectId: input.projectId,
    kind: input.kind,
    artifactKey,
    title: input.title,
    status: "in_review",
    currentVersion: 1,
    createdByType: "agent",
    updatedAt: new Date(),
  });
  await db.insert(artifactVersions).values({
    id: uuidv7(),
    artifactId: id,
    version: 1,
    content: input.content,
    summary: input.summary,
    sourceMessageId: input.messageId,
    createdBy: input.createdBy,
  });
  await input.emit(EVENT_TYPES.artifactChanged, {
    artifactId: id,
    artifactKey,
    action: "created",
    version: 1,
    kind: input.kind,
    title: input.title,
  });
  return id;
}

async function finalizeWork(input: {
  project: typeof projects.$inferSelect;
  task: typeof tasks.$inferSelect;
  workspace: typeof workspaces.$inferSelect;
  room: typeof rooms.$inferSelect;
  role: typeof agentRoles.$inferSelect;
  qaRole: typeof agentRoles.$inferSelect;
  runId: string;
  taskSpec: TaskSpec | null;
  testResult: Awaited<ReturnType<typeof runCommand>> | null;
  testRunId: string | null;
  verification: VerificationResult | null;
  diff: string;
  summary: string;
  outcome: string;
  sessionId: string | null;
  toolCalls: number;
  info: Record<string, unknown> | null;
  emit: EmitFn;
  mode?: "code" | "verify";
}): Promise<void> {
  const db = getDb();
  const {
    project,
    task,
    workspace,
    room,
    role,
    qaRole,
    runId,
    taskSpec,
    testResult,
    testRunId,
    verification,
    diff,
    summary,
    outcome,
    sessionId,
    toolCalls,
    info,
    emit,
  } = input;
  const mode = input.mode ?? "code";
    const testsPassed = !testResult || testResult.status === "passed";
    const specPassed = verification ? verification.verdict === "pass" : true;
    const success = (outcome === "succeeded" || outcome === "verified") && testsPassed && specPassed;

    const verificationNote =
      verification && verification.verdict !== "pass"
        ? `测试${testResult?.status === "passed" ? "通过" : "未通过"}，但规格核对${
            verification.verdict === "fail" ? "未通过" : "无法确认"
          }：${verification.missing.slice(0, 3).join("；") || "请查看规格核对报告"}`
        : "";

    const messageId = uuidv7();
    await insertMessage({
      id: messageId,
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "agent",
      senderId: role.id,
      senderName: role.displayName,
      type: "artifact",
      content:
        verificationNote ||
        summary ||
        (success
          ? "任务已完成，代码变更和测试证据已归档。"
          : "任务没有通过验证，请查看测试报告。"),
      metadata: {
        roleKey: role.key,
        kind: mode,
        runId,
        workspaceId: workspace.id,
        sessionId,
        outcome,
        toolCalls,
        testStatus: testResult?.status ?? "not_run",
        verification: verification?.verdict ?? null,
        chips: [
          { kind: "artifact", label: "代码变更" },
          ...(testResult ? [{ kind: "artifact", label: "测试报告" }] : []),
          ...(verification ? [{ kind: "artifact", label: "规格核对" }] : []),
        ],
      },
      runId,
    });

    const diffArtifactId = await upsertArtifact({
      projectId: project.id,
      kind: "diff",
      title: `变更：${task.title}`,
      summary: diff ? `${diff.split("\n").length} 行变更` : "没有代码变更",
      content: diff ? `\`\`\`diff\n${diff}\n\`\`\`` : "（本次运行没有产生代码变更）",
      createdBy: role.key,
      messageId,
      emit,
    });

    let reportArtifactId: string | null = null;
    if (testResult) {
      reportArtifactId = await upsertArtifact({
        projectId: project.id,
        kind: "test_report",
        title: `测试：${task.title}`,
        summary: `${testResult.command} · ${testResult.status}`,
        content: [
          `# 测试报告`,
          "",
          `- 命令：\`${testResult.command}\``,
          `- 退出码：${testResult.exitCode ?? "n/a"}`,
          `- 状态：**${testResult.status}**`,
          `- 耗时：${(testResult.durationMs / 1000).toFixed(1)}s`,
          "",
          "```text",
          testResult.output.slice(0, 20_000) || "(no output)",
          "```",
        ].join("\n"),
        createdBy: role.key,
        messageId,
        emit,
      });
    }

    let verificationArtifactId: string | null = null;
    if (verification) {
      const verificationContent = [
        "# 规格核对",
        "",
        `- 结论：**${verification.verdict}**`,
        `- 检查项：${verification.checks.length}`,
        "",
        "## 检查项",
        ...(verification.checks.length
          ? verification.checks.map(
              (check) =>
                `- [${check.status}] ${check.criterion}\n  - 证据：${check.evidence || "（无）"}`,
            )
          : ["- （无）"]),
        "",
        "## 缺失 / 风险",
        ...(verification.missing.length
          ? verification.missing.map((item) => `- ${item}`)
          : ["- 无"]),
      ].join("\n");
      verificationArtifactId = await upsertArtifact({
        projectId: project.id,
        kind: "spec_review",
        title: `规格核对：${task.title}`,
        summary: `${verification.verdict} · ${verification.checks.length} 项`,
        content: verificationContent,
        createdBy: qaRole.key,
        messageId,
        emit,
      });
    }

    await db
      .update(tasks)
      .set({
        status: success ? "review" : "failed",
        blockedReason: success
          ? null
          : testResult && testResult.status !== "passed"
            ? `测试未通过：${testResult.command} (exit ${testResult.exitCode ?? "?"})`
            : verification && verification.verdict !== "pass"
              ? `规格核对${verification.verdict === "fail" ? "未通过" : "无法确认"}：${
                  verification.missing.slice(0, 3).join("；") || "请查看规格核对报告"
                }`
              : `Agent 运行结果：${outcome}`,
        evidence: {
          runId,
          workspaceId: workspace.id,
          diffArtifactId,
          reportArtifactId,
          verificationArtifactId,
          testRunId,
          testStatus: testResult?.status ?? "not_run",
          outcome,
          toolCalls,
          verification: verification
            ? {
                verdict: verification.verdict,
                checks: verification.checks,
                missing: verification.missing,
              }
            : null,
          spec: taskSpec
            ? {
                prd: taskSpec.prd.version,
                acceptance: taskSpec.acceptance.version,
                contracts: taskSpec.contracts.map((contract) => contract.version),
              }
            : null,
        },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    if (testResult && testResult.status !== "passed" && !task.title.startsWith("缺陷：")) {
      const siblings = await db.select().from(tasks).where(eq(tasks.projectId, project.id));
      const alreadyFiled = siblings.some(
        (candidate) =>
          typeof candidate.evidence?.["defectOf"] === "string" &&
          candidate.evidence["defectOf"] === task.id,
      );
      if (!alreadyFiled) {
        const defectId = uuidv7();
        const failureTail = testResult.output.slice(-2000);
        await db.insert(tasks).values({
          id: defectId,
          projectId: project.id,
          title: `缺陷：${task.title}`.slice(0, 240),
          description: [
            `由失败任务「${task.title}」自动创建。`,
            `测试命令：${testResult.command}`,
            `退出码：${testResult.exitCode ?? "?"}`,
            "",
            "失败输出：",
            "```text",
            failureTail,
            "```",
            "",
            "请定位根因、修复并补充回归测试。",
          ].join("\n"),
          status: "ready",
          priority: task.priority,
          roleKey: task.roleKey,
          requirementVersion: task.requirementVersion,
          spec: task.spec as Record<string, unknown>,
          acceptance: ["修复失败用例并补充回归测试", "npm test 全部通过"],
          evidence: { defectOf: task.id, sourceTaskTitle: task.title },
        });
        await emit(EVENT_TYPES.taskChanged, {
          taskId: defectId,
          action: "created",
          title: `缺陷：${task.title}`,
          status: "ready",
          defectOf: task.id,
        });
        await db.insert(auditEvents).values({
          id: uuidv7(),
          tenantId: project.tenantId,
          projectId: project.id,
          actorType: "agent",
          actorId: role.key,
          action: "task.defect_created",
          targetType: "task",
          targetId: defectId,
          detail: { sourceTaskId: task.id, testStatus: testResult.status },
        });
      }
    }

    await db
      .update(agentRuns)
      .set({
        status: success ? "succeeded" : "failed",
        endedAt: new Date(),
        costCents: Math.round(Number(info?.cost ?? 0) * 100),
        metadata: {
          kind: mode,
          taskId: task.id,
          workspaceId: workspace.id,
          sessionId,
          outcome,
          toolCalls,
          testStatus: testResult?.status ?? "not_run",
          verification: verification?.verdict ?? null,
          specReviewArtifactId: verificationArtifactId,
          tokens: info?.tokens ?? null,
        },
      })
      .where(eq(agentRuns.id, runId));

    await input.emit(EVENT_TYPES.messageCreated, {
      messageId,
      roomId: room.id,
      senderName: role.displayName,
      senderType: "agent",
      type: "artifact",
    });
    await input.emit(EVENT_TYPES.taskChanged, {
      taskId: task.id,
      action: "updated",
      status: success ? "review" : "failed",
    });
    await input.emit(EVENT_TYPES.runStatusChanged, {
      runId,
      roleKey: role.key,
      roleName: role.displayName,
      status: success ? "succeeded" : "failed",
      kind: mode,
      taskId: task.id,
    });
}

/**
 * Runs one task in an isolated worktree through an OpenCode session, then
 * captures the diff and test evidence. This is intentionally explicit: the
 * user starts it from a task, never implicitly from a chat message.
 */
export async function runTaskWork(input: WorkRunInput): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new Error("project not found");
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
    .limit(1);
  if (!task) throw new Error("task not found");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.projectId, input.projectId)))
    .limit(1);
  if (!workspace) throw new Error("workspace not found");
  const [room] = await db.select().from(rooms).where(eq(rooms.projectId, project.id)).limit(1);
  if (!room) throw new Error("room not found");

  const roleRows = await db.select().from(agentRoles).where(eq(agentRoles.projectId, project.id));
  const role =
    roleRows.find((r) => r.key === task.roleKey) ??
    roleRows.find((r) => r.key === "lead") ??
    roleRows[0];
  if (!role) throw new Error("no agent role configured");

  const qaRole = roleRows.find((r) => r.key === "qa") ?? role;
  const rawSpec = task.spec as unknown as TaskSpec;
  const taskSpec = rawSpec?.prd && rawSpec?.acceptance ? rawSpec : null;
  const specText = taskSpec ? await specContent(taskSpec) : "";

  const provider = role.modelProvider ?? process.env.AGENT_MODEL_PROVIDER ?? "opencode-go";
  const modelId = role.modelId ?? process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash";
  const runId = uuidv7();

  await db.insert(agentRuns).values({
    id: runId,
    projectId: project.id,
    roomId: room.id,
    roleId: role.id,
    workspaceId: workspace.id,
    status: "running",
    startedAt: new Date(),
    modelProvider: provider,
    modelId,
    metadata: { kind: "code", taskId: task.id, workspaceId: workspace.id },
  });
  await input.emit(EVENT_TYPES.runStatusChanged, {
    runId,
    roleKey: role.key,
    roleName: role.displayName,
    status: "running",
    kind: "code",
    taskId: task.id,
  });

  if (["ready", "needs_replan", "blocked", "failed"].includes(task.status)) {
    await db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    await input.emit(EVENT_TYPES.taskChanged, {
      taskId: task.id,
      action: "updated",
      status: "in_progress",
    });
  }

  let sessionId: string | null = null;
  try {
    const created = await opencodeFetch<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: `[${project.name}] ${task.title}`,
        location: { directory: workspace.path },
        model: { providerID: provider, id: modelId },
        permissions: CODE_PERMISSIONS,
        metadata: { devteamProjectId: project.id, devteamTaskId: task.id, runId },
      }),
      timeoutMs: 30_000,
    });
    if (!created.ok) throw new Error(`session create failed (${created.status}): ${created.raw.slice(0, 300)}`);
    sessionId = created.data.data.id;
    // Persist the session id immediately so a future service restart can
    // interrupt an orphaned OpenCode session instead of letting it keep
    // editing the worktree in the background.
    await db
      .update(agentRuns)
      .set({
        metadata: {
          kind: "code",
          taskId: task.id,
          workspaceId: workspace.id,
          sessionId,
        },
      })
      .where(eq(agentRuns.id, runId));

    const memoryRows = await db
      .select()
      .from(memories)
      .where(and(eq(memories.projectId, project.id), eq(memories.status, "accepted")))
      .orderBy(desc(memories.updatedAt))
      .limit(10);
    if (memoryRows.length) {
      await db
        .update(memories)
        .set({ updatedAt: new Date() })
        .where(inArray(memories.id, memoryRows.map((memory) => memory.id)));
    }
    const memoryContext = memoryRows
      .map((memory) => `- [${memory.type}] ${memory.title}：${memory.content.slice(0, 600)}`)
      .join("\n");

    const prompt = buildWorkPrompt({
      projectName: project.name,
      projectDescription: project.description,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptance: task.acceptance,
      roleName: role.displayName,
      specContext: specText,
      memoryContext,
    });

    const prompted = await opencodeFetch(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: prompt }),
      timeoutMs: 30_000,
    });
    if (!prompted.ok) throw new Error(`session prompt failed (${prompted.status}): ${prompted.raw.slice(0, 300)}`);

    const codeTimeoutMs = Number(process.env.CODE_TASK_TIMEOUT_MS ?? 15 * 60 * 1000);
    const deadline = Date.now() + codeTimeoutMs;
    let info: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      if (input.signal?.aborted) {
        await opencodeFetch(`/api/session/${sessionId}/interrupt`, { method: "POST", timeoutMs: 10_000 });
        throw new Error("code run cancelled by user");
      }
      await sleep(2500);
      const res = await opencodeFetch<{ data: Record<string, unknown> }>(`/api/session/${sessionId}`, {
        timeoutMs: 15_000,
      });
      if (res.ok) {
        info = (res.data as { data?: Record<string, unknown> } | null)?.data ?? null;
        if (info?.outcome) break;
      }
    }
    if (input.signal?.aborted) {
      await opencodeFetch(`/api/session/${sessionId}/interrupt`, { method: "POST", timeoutMs: 10_000 });
      throw new Error("code run cancelled by user");
    }
    if (!info?.outcome) {
      await opencodeFetch(`/api/session/${sessionId}/interrupt`, { method: "POST", timeoutMs: 10_000 });
      throw new Error(`code run timed out after ${Math.round(codeTimeoutMs / 60000)} minutes`);
    }

    const messagesRes = await opencodeFetch<{ data: Array<Record<string, unknown>> }>(
      `/api/session/${sessionId}/message?order=asc&limit=200`,
      { timeoutMs: 20_000 },
    );
    const messages = (messagesRes.data as { data?: Array<Record<string, unknown>> } | null)?.data ?? [];
    const assistant = messages.filter((m) => m.type === "assistant");
    const assistantWithText = assistant
      .map((m) => ({
        text: Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>)
              .filter((part) => part.type === "text")
              .map((part) => String(part.text ?? ""))
              .filter(Boolean)
              .join("\n\n")
          : "",
        tools: Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>).filter((part) => part.type === "tool").length
          : 0,
      }))
      .filter((entry) => entry.text);
    const summary = assistantWithText.at(-1)?.text.trim() ?? "";
    const toolCalls = assistant.reduce(
      (total, m) =>
        total +
        (Array.isArray(m.content)
          ? (m.content as Array<Record<string, unknown>>).filter((part) => part.type === "tool").length
          : 0),
      0,
    );

    if (input.signal?.aborted) throw new Error("code run cancelled by user");
    const testCommand = await detectTestCommand(workspace.path);
    const testResult = testCommand ? await runCommand(workspace.path, testCommand, 180_000) : null;
    let testRunId: string | null = null;
    if (testResult) {
      testRunId = uuidv7();
      await db.insert(testRuns).values({
        id: testRunId,
        projectId: project.id,
        workspaceId: workspace.id,
        command: testResult.command,
        exitCode: testResult.exitCode,
        status: testResult.status,
        output: testResult.output.slice(0, 50_000),
        durationMs: testResult.durationMs,
      });
    }

    const diff = await workspaceDiff(workspace.path, workspace.baseCommit);
    const changed = (await workspaceChangedFiles(workspace.path, workspace.baseCommit)).map(
      (file) => `${file.status} ${file.path}`,
    );
    const workspaceContext = `Changed files:\n${
      changed.length ? changed.join("\n") : "(none)"
    }\nAll other files (including test/store.test.js if not listed above) are unchanged from the base commit.`;
    const outcome = String(info.outcome);

    let verification: VerificationResult | null = null;
    if (specText) {
      try {
        verification = await verifyWork({
          taskTitle: task.title,
          taskDescription: task.description,
          taskAcceptance: task.acceptance,
          spec: specText,
          diff,
          workspaceContext,
          testOutput: testResult
            ? `${testResult.command}\nexit ${testResult.exitCode}\n${testResult.output}`
            : "not run",
          model: {
            providerID: qaRole.modelProvider ?? provider,
            id: qaRole.modelId ?? modelId,
          },
        });
      } catch (error) {
        verification = {
          verdict: "unverified",
          checks: [],
          missing: [error instanceof Error ? error.message : String(error)],
          raw: "",
        };
      }
    }

    if (input.signal?.aborted) throw new Error("code run cancelled by user");
    await finalizeWork({
      project,
      task,
      workspace,
      room,
      role,
      qaRole,
      runId,
      taskSpec,
      testResult,
      testRunId,
      verification,
      diff,
      summary,
      outcome,
      sessionId,
      toolCalls,
      info,
      emit: input.emit,
      mode: "code",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (sessionId) {
      await opencodeFetch(`/api/session/${sessionId}/interrupt`, {
        method: "POST",
        timeoutMs: 10_000,
      }).catch(() => undefined);
    }
    await db
      .update(agentRuns)
      .set({ status: "failed", endedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(agentRuns.id, runId));
    await db
      .update(tasks)
      .set({ status: "blocked", blockedReason: message.slice(0, 500), updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    await insertMessage({
      id: uuidv7(),
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content: `${role.displayName} 的代码任务没有跑完：${message.slice(0, 400)}`,
      metadata: { runId, taskId: task.id, workspaceId: workspace.id, sessionId },
    });
    await input.emit(EVENT_TYPES.runStatusChanged, {
      runId,
      roleKey: role.key,
      roleName: role.displayName,
      status: "failed",
      kind: "code",
      taskId: task.id,
      error: message.slice(0, 500),
    });
  }
}

/**
 * Re-runs tests and the spec verifier against the current worktree without
 * invoking the code agent. This is used after a human edit (the edit reopens
 * the task) and for workspaces whose agent run timed out after writing code.
 */
export async function verifyTaskWork(input: WorkRunInput): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new Error("project not found");
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
    .limit(1);
  if (!task) throw new Error("task not found");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.projectId, input.projectId)))
    .limit(1);
  if (!workspace) throw new Error("workspace not found");
  const [room] = await db.select().from(rooms).where(eq(rooms.projectId, project.id)).limit(1);
  if (!room) throw new Error("room not found");

  const roleRows = await db.select().from(agentRoles).where(eq(agentRoles.projectId, project.id));
  const qaRole =
    roleRows.find((r) => r.key === "qa") ??
    roleRows.find((r) => r.key === task.roleKey) ??
    roleRows.find((r) => r.key === "lead") ??
    roleRows[0];
  if (!qaRole) throw new Error("no agent role configured");

  const rawSpec = task.spec as unknown as TaskSpec;
  const taskSpec = rawSpec?.prd && rawSpec?.acceptance ? rawSpec : null;
  const provider = qaRole.modelProvider ?? process.env.AGENT_MODEL_PROVIDER ?? "opencode-go";
  const modelId = qaRole.modelId ?? process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash";
  const runId = uuidv7();

  await db.insert(agentRuns).values({
    id: runId,
    projectId: project.id,
    roomId: room.id,
    roleId: qaRole.id,
    workspaceId: workspace.id,
    status: "running",
    startedAt: new Date(),
    modelProvider: provider,
    modelId,
    metadata: { kind: "verify", taskId: task.id, workspaceId: workspace.id },
  });
  await input.emit(EVENT_TYPES.runStatusChanged, {
    runId,
    roleKey: qaRole.key,
    roleName: qaRole.displayName,
    status: "running",
    kind: "verify",
    taskId: task.id,
  });

  try {
    if (input.signal?.aborted) throw new Error("verification cancelled by user");
    const testCommand = await detectTestCommand(workspace.path);
    const testResult = testCommand ? await runCommand(workspace.path, testCommand, 180_000) : null;
    const testRunId = testResult ? uuidv7() : null;
    if (testResult && testRunId) {
      await db.insert(testRuns).values({
        id: testRunId,
        projectId: project.id,
        workspaceId: workspace.id,
        command: testResult.command,
        exitCode: testResult.exitCode,
        status: testResult.status,
        output: testResult.output.slice(0, 50_000),
        durationMs: testResult.durationMs,
      });
    }

    const diff = await workspaceDiff(workspace.path, workspace.baseCommit);
    const changed = (await workspaceChangedFiles(workspace.path, workspace.baseCommit)).map(
      (file) => `${file.status} ${file.path}`,
    );
    const workspaceContext = `Changed files:\n${
      changed.length ? changed.join("\n") : "(none)"
    }\nAll other files (including test/store.test.js if not listed above) are unchanged from the base commit.`;
    let verification: VerificationResult | null = null;
    if (taskSpec) {
      try {
        verification = await verifyWork({
          taskTitle: task.title,
          taskDescription: task.description,
          taskAcceptance: task.acceptance,
          spec: await specContent(taskSpec),
          diff,
          workspaceContext,
          testOutput: testResult
            ? `${testResult.command}\nexit ${testResult.exitCode}\n${testResult.output}`
            : "not run",
          model: { providerID: provider, id: modelId },
        });
      } catch (error) {
        verification = {
          verdict: "unverified",
          checks: [],
          missing: [error instanceof Error ? error.message : String(error)],
          raw: "",
        };
      }
    }

    if (input.signal?.aborted) throw new Error("verification cancelled by user");
    await finalizeWork({
      project,
      task,
      workspace,
      room,
      role: qaRole,
      qaRole,
      runId,
      taskSpec,
      testResult,
      testRunId,
      verification,
      diff,
      summary: "已按当前工作区重新运行测试与规格核对。",
      outcome: "verified",
      sessionId: null,
      toolCalls: 0,
      info: null,
      emit: input.emit,
      mode: "verify",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(agentRuns)
      .set({ status: "failed", endedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(agentRuns.id, runId));
    await db
      .update(tasks)
      .set({ status: "blocked", blockedReason: `重新核对失败：${message.slice(0, 400)}`, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    await insertMessage({
      id: uuidv7(),
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content: `工作区重新核对没有完成：${message.slice(0, 400)}`,
      metadata: { runId, taskId: task.id, workspaceId: workspace.id },
    });
    await input.emit(EVENT_TYPES.runStatusChanged, {
      runId,
      roleKey: qaRole.key,
      roleName: qaRole.displayName,
      status: "failed",
      kind: "verify",
      taskId: task.id,
      error: message.slice(0, 500),
    });
  }
}
