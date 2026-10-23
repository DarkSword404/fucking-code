export interface DiffLine {
  kind: "add" | "del" | "context" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "binary";

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

function decodePath(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  const tab = value.indexOf("\t");
  if (tab >= 0) value = value.slice(0, tab);
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value;
}

function parseGitHeader(line: string): { oldPath: string | null; path: string | null } {
  const body = line.slice("diff --git ".length);
  let oldRaw = "";
  let newRaw = "";
  const quoted = body.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) {
    oldRaw = quoted[1]!;
    newRaw = quoted[2]!;
  } else {
    const splitAt = body.lastIndexOf(" b/");
    if (splitAt > 0) {
      oldRaw = body.slice(0, splitAt);
      newRaw = body.slice(splitAt + 1);
    }
  }
  if (!oldRaw || !newRaw) return { oldPath: null, path: null };
  return {
    oldPath: decodePath(oldRaw) || null,
    path: decodePath(newRaw) || null,
  };
}

function emptyFile(): DiffFile {
  return {
    path: "",
    oldPath: null,
    status: "modified",
    additions: 0,
    deletions: 0,
    hunks: [],
    binary: false,
  };
}

/**
 * Parses a unified git diff into files and hunks. Header noise such as
 * `diff --git`, `index`, `---` and `+++` is intentionally dropped so the UI
 * can focus on the changed lines.
 */
export function parseDiff(raw: string): ParsedDiff {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const header = parseGitHeader(line);
      const file = emptyFile();
      file.path = header.path ?? "";
      file.oldPath = header.oldPath;
      files.push(file);
      current = file;
      hunk = null;
      continue;
    }

    if (hunk) {
      if (line.startsWith("@@")) {
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
        if (match) {
          const file = current!;
          const oldStart = Number(match[1]);
          const oldCount = match[2] === undefined ? 1 : Number(match[2]);
          const newStart = Number(match[3]);
          const newCount = match[4] === undefined ? 1 : Number(match[4]);
          hunk = {
            oldStart,
            oldCount,
            newStart,
            newCount,
            heading: (match[5] ?? "").trim(),
            lines: [],
          };
          oldLine = file.status === "added" ? null : oldStart;
          newLine = file.status === "deleted" ? null : newStart;
          file.hunks.push(hunk);
          continue;
        }
      } else if (line.startsWith("\\")) {
        hunk.lines.push({
          kind: "meta",
          text: line.slice(1).trim(),
          oldLine: null,
          newLine: null,
        });
        continue;
      } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
        const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "context";
        const text = line.length ? line.slice(1) : "";
        hunk.lines.push({
          kind,
          text,
          oldLine: kind === "add" ? null : oldLine,
          newLine: kind === "del" ? null : newLine,
        });
        if (kind === "add") {
          current!.additions += 1;
          if (newLine !== null) newLine += 1;
        } else if (kind === "del") {
          current!.deletions += 1;
          if (oldLine !== null) oldLine += 1;
        } else {
          if (oldLine !== null) oldLine += 1;
          if (newLine !== null) newLine += 1;
        }
        continue;
      } else {
        hunk = null;
      }
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      current.oldPath = null;
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = decodePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = decodePath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      const rawPath = line.slice(4).trim();
      if (rawPath === "/dev/null") {
        current.status = "added";
        current.oldPath = null;
      } else {
        const path = decodePath(rawPath);
        if (!current.oldPath) current.oldPath = path;
        if (!current.path) current.path = path;
      }
    } else if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      if (rawPath === "/dev/null") {
        current.status = "deleted";
      } else {
        current.path = decodePath(rawPath);
        if (!current.oldPath) current.oldPath = current.path;
      }
    } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      current.binary = true;
    } else if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
      if (match) {
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        hunk = {
          oldStart,
          oldCount,
          newStart,
          newCount,
          heading: (match[5] ?? "").trim(),
          lines: [],
        };
        oldLine = current.status === "added" ? null : oldStart;
        newLine = current.status === "deleted" ? null : newStart;
        current.hunks.push(hunk);
      }
    }
  }

  const visible = files
    .map((file) => ({
      ...file,
      path: file.path || file.oldPath || "unknown",
    }))
    .filter((file) => file.path !== "unknown");

  return {
    files: visible,
    additions: visible.reduce((sum, file) => sum + file.additions, 0),
    deletions: visible.reduce((sum, file) => sum + file.deletions, 0),
  };
}
