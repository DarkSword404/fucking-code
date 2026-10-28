import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  artifacts,
  artifactVersions,
  getDb,
  projects,
  tasks,
} from "@devteam/db";

const execFileAsync = promisify(execFile);
const MAX_INLINE_CHARS = 600_000;

export interface ProjectPackage {
  filename: string;
  buffer: Buffer;
  manifest: Record<string, unknown>;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

async function optionalCopy(source: string, target: string): Promise<boolean> {
  try {
    await copyFile(source, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a self-contained migration package for one project:
 * git bundle + metadata + accepted/review artifact text + task list + env and
 * compose files that already live in the repository. Secrets are never copied.
 */
export async function buildProjectPackage(projectId: string): Promise<ProjectPackage> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("project not found");
  if (!project.repoPath) throw new Error("project has no repository path");

  const work = await mkdtemp(join(tmpdir(), "fc-export-"));
  const pkg = join(work, "package");
  try {
    await mkdir(pkg, { recursive: true });
    const bundlePath = join(pkg, "repo.bundle");
    await git(project.repoPath, ["bundle", "create", bundlePath, "--all"]);

    const [head, branch, status] = await Promise.all([
      git(project.repoPath, ["rev-parse", "HEAD"]).catch(() => ""),
      git(project.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "main"),
      git(project.repoPath, ["status", "--porcelain"]).catch(() => ""),
    ]);

    const artifactRows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.projectId, projectId));
    const artifactSections: string[] = [];
    const artifactIndex: Array<Record<string, unknown>> = [];
    let artifactChars = 0;
    for (const artifact of artifactRows) {
      const [version] = await db
        .select()
        .from(artifactVersions)
        .where(
          and(
            eq(artifactVersions.artifactId, artifact.id),
            eq(artifactVersions.version, artifact.currentVersion),
          ),
        )
        .limit(1);
      const content =
        version ?? (await db
          .select()
          .from(artifactVersions)
          .where(eq(artifactVersions.artifactId, artifact.id))
          .limit(1))[0];
      artifactIndex.push({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        status: artifact.status,
        version: artifact.currentVersion,
      });
      if (!content || artifactChars >= MAX_INLINE_CHARS) continue;
      const clipped = content.content.slice(0, MAX_INLINE_CHARS - artifactChars);
      artifactChars += clipped.length;
      artifactSections.push(
        `## ${artifact.title} (${artifact.kind}, ${artifact.status}, v${artifact.currentVersion})\n\n${clipped}\n`,
      );
    }

    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId));
    const taskIndex = taskRows.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      mode: task.mode,
      priority: task.priority,
      acceptance: task.acceptance,
      description: task.description,
    }));

    const bundle = await readFile(bundlePath);
    const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
    const exportedAt = new Date().toISOString();
    const publicBase = (
      process.env.PUBLIC_BASE_URL ??
      process.env.WEB_ORIGIN?.split(",")[0] ??
      "http://127.0.0.1:8787"
    ).replace(/\/$/, "");
    const cloneUrl = `${publicBase}/git/${project.id}.git`;
    const manifest = {
      format: "fucking-code-project-export",
      version: 1,
      exportedAt,
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        phase: project.phase,
        repoUrl: project.repoUrl,
      },
      repository: {
        branch,
        head,
        dirty: Boolean(status),
        bundle: "repo.bundle",
        bundleBytes: bundle.length,
        bundleSha256,
      },
      counts: {
        tasks: taskRows.length,
        artifacts: artifactRows.length,
      },
      tasks: taskIndex,
      artifacts: artifactIndex,
    };

    await writeFile(join(pkg, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(
      join(pkg, "artifacts.md"),
      artifactSections.length
        ? `# ${project.name} 产物\n\n${artifactSections.join("\n")}`
        : `# ${project.name} 产物\n\n没有可导出的产物。\n`,
      "utf8",
    );
    await writeFile(
      join(pkg, "README.md"),
      `# ${project.name} 迁移包

导出时间：${exportedAt}

## 内容

- \`repo.bundle\`：完整 Git 仓库（所有分支和标签）
- \`manifest.json\`：项目、提交、任务和产物索引
- \`artifacts.md\`：当前版本的需求、设计、测试报告等文本
- \`env.example\` / \`docker-compose.yml\` / \`Dockerfile\`：仓库里已有的部署文件（如果有）

## 恢复代码

\`\`\`bash
git clone repo.bundle app
cd app
git remote set-url origin <新服务器的仓库地址>
git push -u origin --all
git push --tags
\`\`\`

托管克隆地址（只读）：

\`\`\`bash
git -c http.extraHeader="Authorization: Bearer <session-token>" clone ${cloneUrl} app
\`\`\`

原始分支：\`${branch}\`
原始提交：\`${head}\`
Bundle SHA-256：\`${bundleSha256}\`

## 校验

\`\`\`bash
sha256sum repo.bundle
git bundle verify repo.bundle
\`\`\`

环境变量模板和 compose 文件来自原仓库；请自行填入服务器地址、数据库口令和密钥。
`,
      "utf8",
    );

    await optionalCopy(join(project.repoPath, ".env.example"), join(pkg, "env.example"));
    await optionalCopy(join(project.repoPath, "docker-compose.yml"), join(pkg, "docker-compose.yml"));
    await optionalCopy(join(project.repoPath, "docker-compose.yaml"), join(pkg, "docker-compose.yaml"));
    await optionalCopy(join(project.repoPath, "Dockerfile"), join(pkg, "Dockerfile"));
    await optionalCopy(join(project.repoPath, "README.md"), join(pkg, "repository-README.md"));

    const tarPath = join(work, "export.tar.gz");
    await execFileAsync("tar", ["-czf", tarPath, "-C", pkg, "."], {
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const info = await stat(tarPath);
    if (info.size > 250 * 1024 * 1024) {
      throw new Error("project package exceeds 250 MB");
    }
    const filename = `${safeSlug(project.slug || project.name)}-${exportedAt.slice(0, 10)}.tar.gz`;
    return { filename, buffer: await readFile(tarPath), manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
