import { describe, expect, test } from "vitest";
import { parseDiff } from "../apps/web/src/lib/diff";

const SAMPLE = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,4 @@ function demo() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/src/new.js b/src/new.js
new file mode 100644
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/deleted.js b/src/deleted.js
deleted file mode 100644
--- a/src/deleted.js
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("parseDiff", () => {
  test("groups files and hides git header noise", () => {
    const parsed = parseDiff(SAMPLE);
    expect(parsed.files).toHaveLength(3);
    expect(parsed.files.map((file) => file.path)).toEqual([
      "src/a.js",
      "src/new.js",
      "src/deleted.js",
    ]);
    expect(parsed.additions).toBe(4);
    expect(parsed.deletions).toBe(2);
    expect(parsed.files[0]?.hunks[0]?.heading).toBe("function demo() {");
  });

  test("tracks old and new line numbers per line", () => {
    const file = parseDiff(SAMPLE).files[0]!;
    const lines = file.hunks[0]!.lines;
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
    ]);
  });

  test("handles added and deleted files", () => {
    const parsed = parseDiff(SAMPLE);
    const added = parsed.files[1]!;
    const deleted = parsed.files[2]!;
    expect(added.status).toBe("added");
    expect(added.hunks[0]!.lines.map((line) => line.oldLine)).toEqual([null, null]);
    expect(deleted.status).toBe("deleted");
    expect(deleted.hunks[0]!.lines[0]?.newLine).toBeNull();
  });

  test("parses renames and binary files", () => {
    const parsed = parseDiff(`diff --git a/old.js b/new.js
similarity index 90%
rename from old.js
rename to new.js
--- a/old.js
+++ b/new.js
@@ -1 +1 @@
-old
+new
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`);
    expect(parsed.files[0]).toMatchObject({
      path: "new.js",
      oldPath: "old.js",
      status: "renamed",
      additions: 1,
      deletions: 1,
    });
    expect(parsed.files[1]).toMatchObject({ path: "logo.png", binary: true });
  });

  test("parses multiple hunks with independent line numbers", () => {
    const parsed = parseDiff(`diff --git a/src/multi.js b/src/multi.js
--- a/src/multi.js
+++ b/src/multi.js
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
@@ -10,2 +10,2 @@
 const c = 10;
-const d = 11;
+const d = 12;
`);
    const file = parsed.files[0]!;
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[1]?.newStart).toBe(10);
    expect(file.hunks[1]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["context", 12, 12],
    ]);
  });

  test("returns an empty result for an empty diff", () => {
    expect(parseDiff("")).toEqual({ files: [], additions: 0, deletions: 0 });
  });
});
