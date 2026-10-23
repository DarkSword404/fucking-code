import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/atom-one-dark.css";
import { api, type FileEntry, type WorkspaceItem } from "../lib/api";
import { parseDiff, type DiffFileStatus, type DiffHunk } from "../lib/diff";
import {
  activeWorkspaceId,
  canEditCurrentProject,
  cancelCodeWorkspace,
  codeDiff,
  codeError,
  codeFiles,
  codeLoading,
  codeSource,
  codeTab,
  codeTestRuns,
  loadCodeView,
  saveCodeFile,
  selectCodeFile,
  selectCodeSource,
  selectCodeTab,
  selectWorkspace,
  runs,
  selectedFileContent,
  selectedFilePath,
  snapshot,
  verifyCodeWorkspace,
  workspaces,
} from "../lib/store";

interface TreeDir {
  name: string;
  path: string;
  dirs: Map<string, TreeDir>;
  files: FileEntry[];
}

function emptyDir(name: string, path: string): TreeDir {
  return { name, path, dirs: new Map(), files: [] };
}

function buildTree(files: FileEntry[]): TreeDir {
  const root = emptyDir("", "");
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      const path = node.path ? `${node.path}/${name}` : name;
      let next = node.dirs.get(name);
      if (!next) {
        next = emptyDir(name, path);
        node.dirs.set(name, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
  toml: "ini",
  ini: "ini",
};

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

const DIFF_STATUS_LABEL: Record<DiffFileStatus, string> = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
  renamed: "重命名",
  binary: "二进制",
};

function hunkLocation(hunk: DiffHunk): string {
  if (hunk.oldCount === 0) return `新增于第 ${hunk.newStart} 行`;
  if (hunk.newCount === 0) return `删除原第 ${hunk.oldStart} 行`;
  return `第 ${hunk.newStart} 行附近`;
}

function FileTree(props: { node: TreeDir; depth: number }) {
  const dirs = () =>
    [...props.node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = () => [...props.node.files].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <>
      <For each={dirs()}>
        {(dir) => (
          <details open={props.depth < 2}>
            <summary class="file-dir" style={{ "padding-left": `${props.depth * 12 + 6}px` }}>
              {dir.name}
            </summary>
            <FileTree node={dir} depth={props.depth + 1} />
          </details>
        )}
      </For>
      <For each={files()}>
        {(file) => (
          <button
            class={`file-item ${selectedFilePath() === file.path ? "active" : ""}`}
            style={{ "padding-left": `${props.depth * 12 + 16}px` }}
            title={file.path}
            onClick={() => selectCodeFile(file.path)}
          >
            <span class="file-name">{file.path.split("/").at(-1)}</span>
            <Show when={file.status && file.status !== "tracked"}>
              <span class={`file-status ${file.status}`}>{file.status}</span>
            </Show>
          </button>
        )}
      </For>
    </>
  );
}

export function CodeView() {
  const [editing, setEditing] = createSignal(false);
  const [editContent, setEditContent] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [showContext, setShowContext] = createSignal(false);
  const [showRawDiff, setShowRawDiff] = createSignal(false);
  const [command, setCommand] = createSignal("npm test");
  const [commandOutput, setCommandOutput] = createSignal("");
  const [commandStatus, setCommandStatus] = createSignal("");
  const [commandRunning, setCommandRunning] = createSignal(false);

  onMount(() => {
    if (!codeFiles().length) void loadCodeView();
  });

  createEffect(() => {
    selectedFilePath();
    codeSource();
    activeWorkspaceId();
    setShowRawDiff(false);
    setEditing(false);
    setCommandOutput("");
    setCommandStatus("");
  });

  const parsedDiff = createMemo(() => parseDiff(codeDiff()));
  const activeRun = () =>
    runs().find(
      (run) =>
        run.status === "running" &&
        run.metadata?.["workspaceId"] === activeWorkspaceId(),
    );

  const startEdit = () => {
    setEditContent(selectedFileContent() ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    const path = selectedFilePath();
    if (!path) return;
    setSaving(true);
    const ok = await saveCodeFile(path, editContent());
    setSaving(false);
    if (ok) setEditing(false);
  };

  const runCommand = async () => {
    const workspaceId = activeWorkspaceId();
    const text = command().trim();
    if (!workspaceId || !text || commandRunning()) return;
    setCommandRunning(true);
    setCommandStatus("");
    setCommandOutput(`$ ${text}\n\n运行中…`);
    try {
      const result = await api.runWorkspaceCommand(workspaceId, text);
      setCommandOutput(
        `$ ${result.command}\n\n${result.output}\n\n[${result.status} · exit ${
          result.exitCode ?? "?"
        } · ${result.durationMs}ms]`,
      );
      setCommandStatus(result.status);
    } catch (err) {
      setCommandOutput(`$ ${text}\n\n${err instanceof Error ? err.message : String(err)}`);
      setCommandStatus("error");
    } finally {
      setCommandRunning(false);
    }
  };

  const tree = createMemo(() => buildTree(codeFiles()));
  const highlighted = createMemo(() => {
    const content = selectedFileContent();
    if (content === null) return "";
    const path = selectedFilePath() ?? "";
    try {
      return hljs.highlight(content, { language: languageFor(path) }).value;
    } catch {
      return hljs.highlightAuto(content).value;
    }
  });

  const workspaceLabel = (workspace: WorkspaceItem) => {
    const task = snapshot()?.tasks.find((item) => item.id === workspace.taskId);
    return task ? task.title : workspace.branch;
  };

  return (
    <div class="code-view">
      <aside class="code-side">
        <div class="code-side-head">
          <span class="panel-title" style={{ margin: "0" }}>
            代码 / 目录
          </span>
          <button class="icon-btn" title="刷新" onClick={() => void loadCodeView()}>
            ⟳
          </button>
        </div>

        <div class="code-source">
          <button
            class={`code-source-btn ${codeSource() === "repo" ? "active" : ""}`}
            onClick={() => selectCodeSource("repo")}
          >
            仓库
          </button>
          <button
            class={`code-source-btn ${codeSource() === "workspace" ? "active" : ""}`}
            disabled={!workspaces().length}
            onClick={() => selectCodeSource("workspace")}
          >
            工作区
          </button>
        </div>

        <Show when={workspaces().length && codeSource() === "workspace"}>
          <select
            class="code-workspace-select"
            value={activeWorkspaceId() ?? ""}
            onChange={(event) => selectWorkspace(event.currentTarget.value)}
          >
            <For each={workspaces()}>
              {(workspace) => <option value={workspace.id}>{workspaceLabel(workspace)}</option>}
            </For>
          </select>
        </Show>

        <Show when={codeError()}>
          <div class="code-empty">{codeError()}</div>
        </Show>

        <Show when={!codeError()}>
          <div class="code-tree">
            <FileTree node={tree()} depth={0} />
            <Show when={!codeFiles().length && !codeLoading()}>
              <div class="code-empty">没有可显示的文件。</div>
            </Show>
          </div>
        </Show>
      </aside>

      <section class="code-main">
        <div class="code-tabs">
          <button
            class={`code-tab ${codeTab() === "files" ? "active" : ""}`}
            onClick={() => selectCodeTab("files")}
          >
            文件
          </button>
          <button
            class={`code-tab ${codeTab() === "diff" ? "active" : ""}`}
            disabled={!activeWorkspaceId()}
            onClick={() => selectCodeTab("diff")}
          >
            变更
          </button>
          <button
            class={`code-tab ${codeTab() === "tests" ? "active" : ""}`}
            disabled={!activeWorkspaceId()}
            onClick={() => selectCodeTab("tests")}
          >
            测试
          </button>
          <button
            class={`code-tab ${codeTab() === "terminal" ? "active" : ""}`}
            disabled={!activeWorkspaceId()}
            onClick={() => selectCodeTab("terminal")}
          >
            终端
          </button>
          <span class="code-path">
            {codeTab() === "diff"
              ? `${parsedDiff().files.length} 个文件变更`
              : selectedFilePath() ?? (codeSource() === "repo" ? "仓库" : "工作区")}
          </span>
          <Show
            when={
              canEditCurrentProject() &&
              codeSource() === "workspace" &&
              activeWorkspaceId() &&
              selectedFilePath() &&
              codeTab() === "files" &&
              !editing()
            }
          >
            <button class="btn" style={{ padding: "3px 9px", "font-size": "11px" }} onClick={startEdit}>
              编辑
            </button>
          </Show>
          <Show when={canEditCurrentProject() && activeRun()}>
            <button
              class="btn danger"
              style={{ padding: "3px 9px", "font-size": "11px" }}
              onClick={() => void cancelCodeWorkspace()}
            >
              停止
            </button>
          </Show>
          <Show when={canEditCurrentProject() && codeSource() === "workspace" && activeWorkspaceId()}>
            <button
              class="btn"
              style={{ padding: "3px 9px", "font-size": "11px" }}
              onClick={() => void verifyCodeWorkspace()}
            >
              重新核对
            </button>
          </Show>
          <Show when={codeLoading()}>
            <span class="badge">加载中…</span>
          </Show>
        </div>

        <div class="code-body">
          <Show when={codeTab() === "files"}>
            <Show
              when={selectedFileContent() !== null}
              fallback={<div class="code-empty">从左侧选择一个文件。</div>}
            >
              <Show
                when={editing()}
                fallback={
                  <div class="code-scroll">
                    <div class="code-table">
                      <div class="code-gutter">
                        <For each={(selectedFileContent() ?? "").split("\n")}>
                          {(_, index) => <div>{index() + 1}</div>}
                        </For>
                      </div>
                      <pre class="code-pre">
                        <code innerHTML={highlighted()} />
                      </pre>
                    </div>
                  </div>
                }
              >
                <div class="code-edit">
                  <textarea
                    class="code-edit-area"
                    value={editContent()}
                    spellcheck={false}
                    onInput={(event) => setEditContent(event.currentTarget.value)}
                  />
                  <div class="code-edit-actions">
                    <span class="code-edit-note">
                      人工修改会写入工作区，并让任务回到进行中，需要重新运行测试与规格核对。
                    </span>
                    <button class="btn" onClick={() => setEditing(false)}>
                      取消
                    </button>
                    <button class="btn primary" disabled={saving()} onClick={() => void saveEdit()}>
                      {saving() ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={codeTab() === "diff"}>
            <Show
              when={activeWorkspaceId()}
              fallback={<div class="code-empty">运行一次代码任务后可以查看 Diff。</div>}
            >
              <Show when={codeDiff()} fallback={<div class="code-empty">这个工作区还没有代码变更。</div>}>
                <div class="diff-view">
                  <div class="diff-summary">
                    <div class="diff-summary-main">
                      <strong>{parsedDiff().files.length} 个文件</strong>
                      <span class="diff-total add">+{parsedDiff().additions}</span>
                      <span class="diff-total del">−{parsedDiff().deletions}</span>
                    </div>
                    <div class="diff-summary-actions">
                      <label class="diff-toggle">
                        <input
                          type="checkbox"
                          checked={showContext()}
                          onChange={(event) => setShowContext(event.currentTarget.checked)}
                        />
                        显示上下文
                      </label>
                      <button
                        class="diff-raw-toggle"
                        onClick={() => setShowRawDiff(!showRawDiff())}
                      >
                        {showRawDiff() ? "简洁视图" : "原始 Diff"}
                      </button>
                    </div>
                  </div>

                  <Show
                    when={showRawDiff()}
                    fallback={
                      <div class="diff-files">
                        <For each={parsedDiff().files}>
                          {(file) => (
                            <details
                              class="diff-file"
                              open={file.additions + file.deletions <= 80}
                            >
                              <summary class="diff-file-head">
                                <span
                                  class={`diff-file-status ${file.binary ? "binary" : file.status}`}
                                >
                                  {file.binary ? "二进制" : DIFF_STATUS_LABEL[file.status]}
                                </span>
                                <span class="diff-file-path" title={file.path}>
                                  {file.path}
                                </span>
                                <Show when={file.status === "renamed" && file.oldPath}>
                                  <span class="diff-file-oldpath">← {file.oldPath}</span>
                                </Show>
                                <span class="diff-file-stats">
                                  <span class="add">+{file.additions}</span>
                                  <span class="del">−{file.deletions}</span>
                                </span>
                                <span class="diff-file-chevron">▸</span>
                              </summary>

                              <Show
                                when={file.binary}
                                fallback={
                                  <Show
                                    when={file.hunks.length}
                                    fallback={
                                      <div class="diff-file-note">
                                        没有文本差异（可能只是重命名或权限变化）。
                                      </div>
                                    }
                                  >
                                    <For each={file.hunks}>
                                      {(hunk) => (
                                        <Show
                                          when={
                                            showContext() ||
                                            hunk.lines.some((line) => line.kind !== "context")
                                          }
                                        >
                                          <div class="diff-hunk">
                                            <div class="diff-hunk-head">
                                              <span>{hunkLocation(hunk)}</span>
                                              <Show when={hunk.heading}>
                                                <span class="diff-hunk-context">{hunk.heading}</span>
                                              </Show>
                                            </div>
                                            <div class="diff-lines">
                                              <For
                                                each={
                                                  showContext()
                                                    ? hunk.lines
                                                    : hunk.lines.filter((line) => line.kind !== "context")
                                                }
                                              >
                                                {(line) => (
                                                  <div class={`diff-row ${line.kind}`}>
                                                    <span class="diff-old">{line.oldLine ?? ""}</span>
                                                    <span class="diff-new">{line.newLine ?? ""}</span>
                                                    <span class="diff-sign">
                                                      {line.kind === "add"
                                                        ? "+"
                                                        : line.kind === "del"
                                                          ? "-"
                                                          : line.kind === "meta"
                                                            ? "\\"
                                                            : " "}
                                                    </span>
                                                    <span class="diff-text">{line.text || " "}</span>
                                                  </div>
                                                )}
                                              </For>
                                            </div>
                                          </div>
                                        </Show>
                                      )}
                                    </For>
                                  </Show>
                                }
                              >
                                <div class="diff-file-note">二进制文件，无法显示文本差异。</div>
                              </Show>
                            </details>
                          )}
                        </For>
                        <Show when={!parsedDiff().files.length}>
                          <div class="code-empty">这个工作区还没有代码变更。</div>
                        </Show>
                      </div>
                    }
                  >
                    <pre class="diff-raw">{codeDiff()}</pre>
                  </Show>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={codeTab() === "tests"}>
            <Show
              when={activeWorkspaceId()}
              fallback={<div class="code-empty">运行一次代码任务后可以查看测试输出。</div>}
            >
              <Show
                when={codeTestRuns().length}
                fallback={<div class="code-empty">还没有测试运行。</div>}
              >
                <div class="test-runs">
                  <For each={codeTestRuns()}>
                    {(run) => (
                      <div class="test-run">
                        <div class="test-run-head">
                          <span class={`badge ${run.status === "passed" ? "ok" : "bad"}`}>
                            {run.status}
                          </span>
                          <code>{run.command}</code>
                          <span class="run-meta">
                            exit {run.exitCode ?? "?"} · {run.durationMs ?? 0}ms
                          </span>
                        </div>
                        <pre class="test-output">{run.output.slice(0, 8000)}</pre>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={codeTab() === "terminal"}>
            <Show
              when={canEditCurrentProject()}
              fallback={<div class="code-empty">只读成员不能执行工作区命令。</div>}
            >
              <Show
                when={activeWorkspaceId()}
                fallback={<div class="code-empty">运行一次代码任务后可以使用命令终端。</div>}
              >
                <div class="code-terminal">
                  <div class="terminal-bar">
                    <span class="terminal-prompt">$</span>
                    <input
                      value={command()}
                      spellcheck={false}
                      placeholder="npm test"
                      onInput={(event) => setCommand(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void runCommand();
                      }}
                    />
                    <button
                      class="btn primary"
                      disabled={!command().trim() || commandRunning()}
                      onClick={() => void runCommand()}
                    >
                      {commandRunning() ? "运行中…" : "运行"}
                    </button>
                  </div>
                  <pre class={`terminal-output ${commandStatus()}`}>
                    {commandOutput() ||
                      "允许的命令：npm / npx / node / git / pnpm / bun / yarn。命令在隔离 worktree 中执行。"}
                  </pre>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
      </section>
    </div>
  );
}
