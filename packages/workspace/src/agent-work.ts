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

/** Last throttled progress notice per project/task. */
const lastProgressNotice = new Map<string, number>();
import { canonicalArtifactKey, initialArtifactStatus, uuidv7 } from "@devteam/domain";
import {
  detectTestCommand,
  runCommand,
  workspaceChangedFiles,
  workspaceDiff,
} from "./manager.js";
import { runBuiltinAgent } from "./builtin-agent.js";
import { verifyWork, type VerificationResult } from "./verification.js";

export type EmitFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface WorkRunInput {
  projectId: string;
  taskId: string;
  workspaceId: string;
  emit: EmitFn;
  signal?: AbortSignal;
  /** Started preview URL for this project, when one exists. */
  previewUrl?: string;
  /** Demo/test account injected by the platform; never ask the client for it. */
  seedUser?: string;
  seedPassword?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function latestToolProgress(sessionId: string): Promise<string | null> {
  const response = await opencodeFetch<{ data?: Array<Record<string, unknown>> }>(
    `/api/session/${sessionId}/message?order=desc&limit=8`,
    { timeoutMs: 6_000 },
  ).catch(() => null);
  const messages = response?.data?.data ?? [];
  for (const message of messages) {
    const parts = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i]!;
      if (part.type !== "tool") continue;
      const input = (part.input ?? {}) as Record<string, unknown>;
      const detail = String(
        input.command ?? input.path ?? input.query ?? input.description ?? "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 90);
      return `${String(part.name ?? "tool")}${detail ? `：${detail}` : ""}`;
    }
  }
  return null;
}

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

const WORKBENCH_PERMISSIONS = [
  { action: "shell", resource: "git push *", effect: "deny" },
  { action: "shell", resource: "git reset --hard *", effect: "deny" },
  { action: "shell", resource: "rm -rf *", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
];

function buildWorkbenchPrompt(input: {
  projectName: string;
  projectDescription: string;
  taskTitle: string;
  taskDescription: string;
  acceptance: string[];
  roleName: string;
  roleKey: string;
  previewUrl?: string;
  seedUser?: string;
  seedPassword?: string;
  specContext?: string;
}): string {
  return [
    `你是 ${input.roleName}，在 Fucking Code 的隔离工作区执行只读验证任务。`,
    "",
    `项目：${input.projectName}`,
    `项目背景：${input.projectDescription}`,
    `任务：${input.taskTitle}`,
    `描述：${input.taskDescription}`,
    "验收/检查项：",
    ...(input.acceptance.length ? input.acceptance.map((item) => `- ${item}`) : ["- 按任务描述执行"]),
    input.specContext ? `\n## 已确认的验收规格\n${input.specContext}` : "",
    "",
    "## 你拥有的工具",
    "- shell（在 worktree 内执行命令，可用 host 网络；可以 curl 预览地址、启动项目自带测试）",
    "- 文件读写（工作区内的测试/证据文件）",
    "- 如果 OpenCode 配置了 Playwright/browser MCP，可以直接打开、点击、截图页面",
    input.previewUrl
      ? `- 平台已提供的预览地址：${input.previewUrl}（优先用它，不要再启动第二个实例）`
      : "- 平台没有现成预览地址；需要时在 worktree 内用随机 PORT 启动项目，测试完关闭",
    input.seedUser ? `- 测试账号：${input.seedUser}` : "- 测试账号：security（本地默认）",
    input.seedPassword
      ? `- 测试口令：${input.seedPassword}（只用于登录，不要写入报告/产物）`
      : "- 测试口令：由平台默认值提供，不要向甲方索要",
    "",
    "## 规则",
    "1. 这是只读验证：不要修改产品代码；证据/报告可以写到 docs/qa-evidence/；浏览器 profile/缓存必须放 /tmp，不要放进 worktree。",
    "2. 不要访问或修改主仓库 data/、不要读取 .env、不要 git push/merge、不要 rm -rf。",
    "3. 每一条结论必须有证据：命令 + 原始输出，或截图路径 + 现象；不要用“看起来”代替。",
    "4. 页面走查要按验收顺序执行；需要登录时先说明用的是哪个测试账号。",
    "5. 无法覆盖的条目明确写“未覆盖/无法执行”，不要猜通过。",
    "6. 系统依赖（git/node/npm/浏览器）由运行环境提供；缺少时报告环境缺口，不要 sudo apt install 或修改系统。",
    "7. 结束时给出：逐条结果、未覆盖项、可复现步骤、剩余风险。",
  ].join("\n");
}

function buildWorkPrompt(input: {
  projectName: string;
  projectDescription: string;
  taskTitle: string;
  taskDescription: string;
  acceptance: string[];
  roleName: string;
  specContext: string;
  memoryContext?: string;
  previousFailure?: string;
  previewUrl?: string;
  seedUser?: string;
  seedPassword?: string;
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
    input.previousFailure ? `## 上次失败原因（必须先修复这一点）\n${input.previousFailure}` : "",
    "## 运行环境（平台已注入，不要向甲方索要）",
    input.previewUrl
      ? `- 预览地址：${input.previewUrl}`
      : "- 没有现成预览地址；需要时在 worktree 内用随机 PORT 启动项目，测试完关闭",
    `- 测试账号：${input.seedUser ?? "security"}`,
    `- 测试口令：${input.seedPassword ?? "（平台默认值）"}（只用于登录，不要写入报告/产物）`,
    "## 已确认的验收规格（必须满足，测试通过不等于规格满足）",
    input.specContext || "（没有绑定已确认规格，仅以测试为准）",
    input.memoryContext ? `\n## 项目长期记忆\n${input.memoryContext}` : "",
    "",
    "工作方式：",
    "1. 先读相关代码和测试，确认现状。",
    "2. 直接实现，改动要小而完整；不要重写无关文件。",
    "3. 运行测试，确保通过；如果失败，先修复再结束。",
    "4. 不要执行 git push、不要切换或合并主分支、不要删除仓库、不要访问工作目录之外的文件。",
    "5. node_modules / .venv 是从主仓库链接进来的共享依赖目录，只读使用；不要运行 npm install / yarn install 修改它，缺依赖时报告缺口而不是改共享目录。",
    "6. git/node/npm 是运行环境提供的系统依赖；缺少时报告环境缺口，不要 sudo apt install 或修改系统。",
    "7. 结束时用 3-5 句话总结：改了哪些文件、测试结果、剩余风险。",
  ].filter(Boolean).join("\n");
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
        status: initialArtifactStatus(input.kind),
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
    status: initialArtifactStatus(input.kind),
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
  transcript?: string;
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
    transcript,
    outcome,
    sessionId,
    toolCalls,
    info,
    emit,
  } = input;
  const mode = input.mode ?? "code";
    const isWorkbench = task.mode === "workbench";
    // A workbench is evidence collection, not a green-test gate. Its job is to
    // report the real state (including failing tests), so a failing project
    // test must not turn a completed workbench into a defect loop.
    const testsPassed = isWorkbench || !testResult || testResult.status === "passed";
    const specPassed = isWorkbench ? true : verification ? verification.verdict === "pass" : true;
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
    if (testResult && !isWorkbench) {
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

    if (isWorkbench) {
      reportArtifactId = await upsertArtifact({
        projectId: project.id,
        kind: "test_report",
        title: `验证报告：${task.title}`,
        summary: `${role.displayName} · ${success ? "完成" : "未完成"} · ${toolCalls} 次工具调用`,
        content: [
          `# 验证报告：${task.title}`,
          "",
          `- 执行角色：${role.displayName}`,
          `- 运行结果：${outcome}`,
          `- 测试命令：${testResult ? `${testResult.command}（${testResult.status}）` : "未运行"}`,
          `- 工具调用：${toolCalls}`,
          "",
          "## 验证记录",
          transcript?.trim() || summary || "（无输出）",
          "",
          "## 测试原始输出",
          testResult ? "```text\n" + testResult.output.slice(0, 20_000) + "\n```" : "（未运行测试命令）",
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

    let finalStatus: string = success ? (isWorkbench ? "done" : "review") : "failed";
    await db
      .update(tasks)
      .set({
        status: finalStatus,
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

    const testFailed = Boolean(testResult && testResult.status !== "passed");
    const specFailed = Boolean(verification && verification.verdict !== "pass");
    const failureSummary =
      testResult && testResult.status !== "passed"
        ? `测试未通过：${testResult.command} (exit ${testResult.exitCode ?? "?"})`
        : `规格核对未通过：${
            (verification?.missing ?? []).slice(0, 3).join("；") || "请查看规格核对报告"
          }`;
    const isDefectTask = task.title.startsWith("缺陷：");
    const reworkAttempts = Number(
      (task.evidence as Record<string, unknown> | null)?.["reworkAttempts"] ?? 0,
    );
    if (!success && isDefectTask && (testFailed || specFailed) && reworkAttempts < 3) {
      // Defect tasks are already the rework unit. Retrying them in the same
      // worktree is cheaper than creating 缺陷：缺陷：... chains, and the next
      // prompt carries the exact failure reason.
      const [current] = await db
        .select({ evidence: tasks.evidence })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);
      await db
        .update(tasks)
        .set({
          status: "ready",
          blockedReason: `第 ${reworkAttempts + 1} 次返工：${failureSummary}`,
          evidence: { ...(current?.evidence ?? {}), reworkAttempts: reworkAttempts + 1 },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
      finalStatus = "ready";
      await emit(EVENT_TYPES.taskChanged, {
        taskId: task.id,
        action: "rework",
        status: "ready",
        attempt: reworkAttempts + 1,
      });
    }
    if (!success && !isDefectTask && (testFailed || specFailed)) {
      const siblings = await db.select().from(tasks).where(eq(tasks.projectId, project.id));
      const existingDefect = siblings.find(
        (candidate) =>
          typeof candidate.evidence?.["defectOf"] === "string" &&
          candidate.evidence["defectOf"] === task.id,
      );
      let successorId = existingDefect?.id ?? null;
      if (!successorId) {
        const defectId = uuidv7();
        const failureTail =
          testResult && testResult.status !== "passed" ? testResult.output.slice(-2000) : "";
        const missing = verification?.missing ?? [];
        await db.insert(tasks).values({
          id: defectId,
          projectId: project.id,
          title: `缺陷：${task.title}`.slice(0, 240),
          description: [
            `由失败任务「${task.title}」自动创建。`,
            testResult && testResult.status !== "passed"
              ? `测试命令：${testResult.command}\n退出码：${testResult.exitCode ?? "?"}`
              : "规格核对未通过。",
            "",
            testResult && testResult.status !== "passed" ? "失败输出：" : "规格核对缺失：",
            "```text",
            testResult && testResult.status !== "passed"
              ? failureTail
              : missing.slice(0, 20).join("\n") || "请查看规格核对报告。",
            "```",
            "",
            "请定位根因、修复并补充回归测试。",
          ].join("\n"),
          status: "ready",
          mode: task.mode,
          priority: task.priority,
          roleKey: task.roleKey,
          requirementVersion: task.requirementVersion,
          spec: task.spec as Record<string, unknown>,
          acceptance: isWorkbench
            ? ["补齐缺失的只读证据与未覆盖口径", "不要修改业务代码", "回贴原始命令、输出与剩余风险"]
            : testResult && testResult.status !== "passed"
              ? ["修复失败用例并补充回归测试", "npm test 全部通过"]
              : ["补齐规格核对缺失项", "补充覆盖缺失项的测试", "npm test 全部通过"],
          evidence: { defectOf: task.id, sourceTaskTitle: task.title },
        });
        successorId = defectId;
        // Reuse the existing worktree for the defect. The implementation may
        // already be complete and only missing evidence; starting from a fresh
        // main checkout would silently throw that work away.
        await db
          .update(workspaces)
          .set({ taskId: defectId, status: "ready", updatedAt: new Date() })
          .where(and(eq(workspaces.projectId, project.id), eq(workspaces.taskId, task.id)));
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
          detail: { sourceTaskId: task.id, testStatus: testResult?.status ?? "not_run" },
        });
      }

      // The failed task is superseded by its defect. Keeping it `failed` would
      // hold the coding gate open forever while the scheduler only picks
      // `ready` tasks, which was a silent deadlock in the lifecycle.
      const [current] = await db
        .select({ evidence: tasks.evidence })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);
      await db
        .update(tasks)
        .set({
          status: "cancelled",
          blockedReason: `已由缺陷任务接续：${successorId}`,
          evidence: { ...(current?.evidence ?? {}), defectTaskId: successorId },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
      finalStatus = "cancelled";
      await emit(EVENT_TYPES.taskChanged, {
        taskId: task.id,
        action: "superseded",
        status: "cancelled",
        defectTaskId: successorId,
      });
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
      status: finalStatus,
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

async function runBuiltinTaskWork(input: {
  project: typeof projects.$inferSelect;
  task: typeof tasks.$inferSelect;
  workspace: typeof workspaces.$inferSelect;
  room: typeof rooms.$inferSelect;
  role: typeof agentRoles.$inferSelect;
  qaRole: typeof agentRoles.$inferSelect;
  runId: string;
  taskSpec: TaskSpec | null;
  specText: string;
  provider: string;
  modelId: string;
  emit: EmitFn;
  signal?: AbortSignal;
  previewUrl?: string;
  seedUser?: string;
  seedPassword?: string;
}): Promise<void> {
  const db = getDb();
  const isWorkbench = input.task.mode === "workbench";
  const runKind = isWorkbench ? "verify" : "code";
  const memoryRows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.projectId, input.project.id), eq(memories.status, "accepted")))
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

  const agent = await runBuiltinAgent({
    root: input.workspace.path,
    taskTitle: input.task.title,
    taskDescription:
      input.task.description + (memoryContext ? `\n\n## Project memory\n${memoryContext}` : ""),
    acceptance: input.task.acceptance,
    specText: input.specText,
    previousFailure: input.task.blockedReason ?? undefined,
    model: { providerID: input.provider, id: input.modelId },
    mode: isWorkbench ? "workbench" : "code",
    previewUrl: input.previewUrl,
    seedUser: input.seedUser,
    seedPassword: input.seedPassword,
    allowNetwork: isWorkbench || process.env.CODE_TASK_NETWORK === "1",
    maxSteps: Number(
      isWorkbench ? process.env.WORKBENCH_MAX_STEPS ?? 40 : process.env.CODE_AGENT_MAX_STEPS ?? 20,
    ),
    timeoutMs: Number(
      isWorkbench
        ? process.env.WORKBENCH_AGENT_TIMEOUT_MS ??
            process.env.WORKBENCH_TIMEOUT_MS ??
            30 * 60_000
        : process.env.CODE_AGENT_TIMEOUT_MS ?? 20 * 60_000,
    ),
    signal: input.signal,
    onProgress: async (tool) => {
      // A long code/workbench run can be silent for many minutes in the room.
      // Post a throttled progress note so "working" does not look like "dead".
      const noticeKey = `${input.project.id}:${input.task.id}`;
      const lastNotice = lastProgressNotice.get(noticeKey) ?? Date.now();
      lastProgressNotice.set(noticeKey, lastNotice);
      if (Date.now() - lastNotice >= 10 * 60_000) {
        lastProgressNotice.set(noticeKey, Date.now());
        const messageId = uuidv7();
        await insertMessage({
          id: messageId,
          tenantId: input.project.tenantId,
          projectId: input.project.id,
          roomId: input.room.id,
          senderType: "system",
          senderName: "系统",
          type: "system_event",
          content: `任务《${input.task.title}》仍在执行，最近步骤：${tool}。`,
          metadata: { kind: "task_progress", taskId: input.task.id, progress: tool },
        });
        await input.emit(EVENT_TYPES.messageCreated, {
          messageId,
          roomId: input.room.id,
          senderType: "system",
          senderName: "系统",
          type: "system_event",
        });
      }
      await db
        .update(agentRuns)
        .set({
          metadata: {
            kind: runKind,
            taskId: input.task.id,
            workspaceId: input.workspace.id,
            executor: "builtin",
            taskMode: input.task.mode,
            progress: tool,
          },
        })
        .where(eq(agentRuns.id, input.runId));
      await input.emit(EVENT_TYPES.runStatusChanged, {
        runId: input.runId,
        roleKey: input.role.key,
        roleName: input.role.displayName,
        status: "running",
        kind: runKind,
        taskId: input.task.id,
        progress: tool,
      });
    },
  });

  const testCommand = await detectTestCommand(input.workspace.path);
  const testResult = testCommand
    ? await runCommand(input.workspace.path, testCommand, 180_000, {
        network: isWorkbench || process.env.CODE_TASK_NETWORK === "1",
      })
    : null;
  let testRunId: string | null = null;
  if (testResult) {
    testRunId = uuidv7();
    await db.insert(testRuns).values({
      id: testRunId,
      projectId: input.project.id,
      workspaceId: input.workspace.id,
      command: testResult.command,
      exitCode: testResult.exitCode,
      status: testResult.status,
      output: testResult.output.slice(0, 50_000),
      durationMs: testResult.durationMs,
    });
  }

  const diff = isWorkbench
    ? ""
    : await workspaceDiff(input.workspace.path, input.workspace.baseCommit);
  const changed = isWorkbench
    ? []
    : (await workspaceChangedFiles(input.workspace.path, input.workspace.baseCommit)).map(
        (file) => `${file.status} ${file.path}`,
      );
  const workspaceContext = `Changed files:\n${
    changed.length ? changed.join("\n") : "(none)"
  }\nAll other files are unchanged from the base commit.`;

  let verification: VerificationResult | null = null;
  if (input.specText && !isWorkbench) {
    try {
      verification = await verifyWork({
        taskTitle: input.task.title,
        taskDescription: input.task.description,
        taskAcceptance: input.task.acceptance,
        spec: input.specText,
        diff,
        workspaceContext,
        testOutput: testResult
          ? `${testResult.command}\nexit ${testResult.exitCode}\n${testResult.output}`
          : "not run",
        model: {
          providerID: input.qaRole.modelProvider ?? input.provider,
          id: input.qaRole.modelId ?? input.modelId,
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

  await finalizeWork({
    project: input.project,
    task: input.task,
    workspace: input.workspace,
    room: input.room,
    role: input.role,
    qaRole: input.qaRole,
    runId: input.runId,
    taskSpec: input.taskSpec,
    testResult,
    testRunId,
    verification,
    diff,
    summary: agent.summary,
    transcript: agent.transcript,
    outcome: agent.outcome,
    sessionId: null,
    toolCalls: agent.toolCalls,
    info: { executor: "builtin", steps: agent.toolCalls, taskMode: input.task.mode },
    emit: input.emit,
    mode: isWorkbench ? "verify" : "code",
  });
  await db
    .update(agentRuns)
    .set({
      status:
        agent.outcome === "succeeded" && (!testResult || testResult.status === "passed")
          ? "succeeded"
          : "failed",
      endedAt: new Date(),
      metadata: {
        kind: runKind,
        taskId: input.task.id,
        workspaceId: input.workspace.id,
        executor: "builtin",
        taskMode: input.task.mode,
        outcome: agent.outcome,
        toolCalls: agent.toolCalls,
        testStatus: testResult?.status ?? "not_run",
        verification: verification?.verdict ?? null,
      },
    })
    .where(eq(agentRuns.id, input.runId));
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

  const initialKind = task.mode === "workbench" ? "verify" : "code";
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
    metadata: { kind: initialKind, taskId: task.id, workspaceId: workspace.id },
  });
  await input.emit(EVENT_TYPES.runStatusChanged, {
    runId,
    roleKey: role.key,
    roleName: role.displayName,
    status: "running",
    kind: initialKind,
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
    const executor = (
      task.mode === "workbench"
        ? process.env.WORKBENCH_EXECUTOR ?? "builtin"
        : process.env.CODE_EXECUTOR ?? "opencode"
    ).toLowerCase();
    if (executor === "builtin") {
      await runBuiltinTaskWork({
        project,
        task,
        workspace,
        room,
        role,
        qaRole,
        runId,
        taskSpec,
        specText,
        provider,
        modelId,
        emit: input.emit,
        signal: input.signal,
        previewUrl: input.previewUrl,
        seedUser: input.seedUser,
        seedPassword: input.seedPassword,
      });
      return;
    }
    const created = await opencodeFetch<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: `[${project.name}] ${task.title}`,
        location: { directory: workspace.path },
        model: { providerID: provider, id: modelId },
        permissions: task.mode === "workbench" ? WORKBENCH_PERMISSIONS : CODE_PERMISSIONS,
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

    const prompt =
      task.mode === "workbench"
        ? buildWorkbenchPrompt({
            projectName: project.name,
            projectDescription: project.description,
            taskTitle: task.title,
            taskDescription: task.description,
            acceptance: task.acceptance,
            roleName: role.displayName,
            roleKey: role.key,
            previewUrl: input.previewUrl,
            seedUser: input.seedUser,
            seedPassword: input.seedPassword,
            specContext: specText,
          })
        : buildWorkPrompt({
            projectName: project.name,
            projectDescription: project.description,
            taskTitle: task.title,
            taskDescription: task.description,
            acceptance: task.acceptance,
            roleName: role.displayName,
            specContext: specText,
            memoryContext,
            previousFailure: task.blockedReason ?? undefined,
            previewUrl: input.previewUrl,
            seedUser: input.seedUser,
            seedPassword: input.seedPassword,
          });

    const prompted = await opencodeFetch(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: prompt }),
      timeoutMs: 30_000,
    });
    if (!prompted.ok) throw new Error(`session prompt failed (${prompted.status}): ${prompted.raw.slice(0, 300)}`);

    const codeTimeoutMs = Number(
      task.mode === "workbench"
        ? process.env.WORKBENCH_TIMEOUT_MS ?? 45 * 60 * 1000
        : process.env.CODE_TASK_TIMEOUT_MS ?? 25 * 60 * 1000,
    );
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
      const progress = await latestToolProgress(sessionId);
      if (progress) {
        await db
          .update(agentRuns)
          .set({
            metadata: {
              kind: "code",
              taskId: task.id,
              workspaceId: workspace.id,
              sessionId,
              progress,
            },
          })
          .where(eq(agentRuns.id, runId));
        await input.emit(EVENT_TYPES.runStatusChanged, {
          runId,
          roleKey: role.key,
          roleName: role.displayName,
          status: "running",
          kind: "code",
          taskId: task.id,
          progress,
        });
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
    const transcript = assistantWithText.map((entry) => entry.text).join("\n\n---\n\n");
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
    const testResult = testCommand
      ? await runCommand(workspace.path, testCommand, 180_000, {
          network: task.mode === "workbench",
        })
      : null;
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

    const diff =
      task.mode === "workbench" ? "" : await workspaceDiff(workspace.path, workspace.baseCommit);
    const changed =
      task.mode === "workbench"
        ? []
        : (await workspaceChangedFiles(workspace.path, workspace.baseCommit)).map(
            (file) => `${file.status} ${file.path}`,
          );
    const workspaceContext = `Changed files:\n${
      changed.length ? changed.join("\n") : "(none)"
    }\nAll other files (including test/store.test.js if not listed above) are unchanged from the base commit.`;
    const outcome = String(info.outcome);

    let verification: VerificationResult | null = null;
    if (specText && task.mode !== "workbench") {
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
      transcript,
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
    // A wall-clock timeout is usually a scope problem, not a code failure. The
    // worktree keeps the partial work, so retry once or twice instead of
    // parking the task in `blocked` where the scheduler would never pick it up.
    const timedOut = /timed out/i.test(message);
    const infraUnavailable =
      /session create failed \((401|403|5\d\d)\)|ECONNREFUSED|fetch failed|service unavailable/i.test(
        message,
      );
    const timeoutAttempts = Number(
      (task.evidence as Record<string, unknown> | null)?.["timeoutAttempts"] ?? 0,
    );
    const infraAttempts = Number(
      (task.evidence as Record<string, unknown> | null)?.["infraAttempts"] ?? 0,
    );
    const timeoutRetry = timedOut && timeoutAttempts < 2 && !task.title.startsWith("缺陷：");
    // A server restart or a short OpenCode outage is not a task failure. Keep
    // the workspace and retry in the queue instead of parking it in blocked.
    const infraRetry = infraUnavailable && infraAttempts < 3;
    const retry = timeoutRetry || infraRetry;
    const retryLabel = infraRetry
      ? `OpenCode 暂不可用，自动重试第 ${infraAttempts + 1} 次`
      : `代码任务超时，自动重试第 ${timeoutAttempts + 1} 次`;
    await db
      .update(tasks)
      .set({
        status: retry ? "ready" : "blocked",
        blockedReason: retry ? retryLabel : message.slice(0, 500),
        evidence: {
          ...(task.evidence ?? {}),
          timeoutAttempts: timeoutAttempts + (timeoutRetry ? 1 : 0),
          infraAttempts: infraAttempts + (infraRetry ? 1 : 0),
        },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    await insertMessage({
      id: uuidv7(),
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content: retry
        ? `${role.displayName} 的代码任务${infraRetry ? "遇到 OpenCode 暂时不可用" : "超时"}，已保留工作区改动，${retryLabel}。`
        : `${role.displayName} 的代码任务没有跑完：${message.slice(0, 400)}`,
      metadata: { runId, taskId: task.id, workspaceId: workspace.id, sessionId, retry },
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
    const testResult = testCommand
      ? await runCommand(workspace.path, testCommand, 180_000, {
          network: task.mode === "workbench",
        })
      : null;
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
