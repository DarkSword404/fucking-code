import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { git } from "./git.js";

const PACKAGE_JSON = `{
  "name": "acme-notes",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`;

const NOTES_JS = `export class NoteStore {
  #notes = new Map();
  #nextId = 1;

  create({ title, body = "", tags = [] } = {}) {
    if (!title || !String(title).trim()) throw new Error("title is required");
    const note = {
      id: String(this.#nextId++),
      title: String(title).trim(),
      body: String(body ?? ""),
      tags: normalizeTags(tags),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.#notes.set(note.id, note);
    return { ...note };
  }

  get(id) {
    const note = this.#notes.get(String(id));
    return note ? { ...note } : null;
  }

  list({ tag } = {}) {
    const all = [...this.#notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // TODO: filter by tag (case-insensitive, single tag)
    return all.map((note) => ({ ...note }));
  }

  update(id, patch = {}) {
    const note = this.#notes.get(String(id));
    if (!note) return null;
    if (patch.title !== undefined) {
      if (!String(patch.title).trim()) throw new Error("title is required");
      note.title = String(patch.title).trim();
    }
    if (patch.body !== undefined) note.body = String(patch.body ?? "");
    if (patch.tags !== undefined) note.tags = normalizeTags(patch.tags);
    note.updatedAt = new Date().toISOString();
    return { ...note };
  }

  remove(id) {
    return this.#notes.delete(String(id));
  }

  search(query) {
    // TODO: case-insensitive search over title and body
    return [];
  }
}

export function normalizeTag(tag) {
  return String(tag ?? "").trim().toLowerCase();
}

export function normalizeTags(tags) {
  return [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
}
`;

const TEST_JS = `import test from "node:test";
import assert from "node:assert/strict";
import { NoteStore, normalizeTags } from "../src/notes.js";

test("creates and lists notes", () => {
  const store = new NoteStore();
  const note = store.create({ title: "First note", body: "hello", tags: ["Work"] });
  assert.equal(note.title, "First note");
  assert.deepEqual(note.tags, ["work"]);
  assert.equal(store.list().length, 1);
});

test("updates and removes notes", () => {
  const store = new NoteStore();
  const note = store.create({ title: "Draft" });
  const updated = store.update(note.id, { title: "Final", body: "done" });
  assert.equal(updated.title, "Final");
  assert.equal(store.remove(note.id), true);
  assert.equal(store.get(note.id), null);
});

test("normalizes tags", () => {
  assert.deepEqual(normalizeTags([" API ", "api", "Backend"]), ["api", "backend"]);
});

test("filters by tag", () => {
  const store = new NoteStore();
  store.create({ title: "A", tags: ["work"] });
  store.create({ title: "B", tags: ["life"] });
  assert.deepEqual(store.list({ tag: "WORK" }).map((n) => n.title), ["A"]);
});

test("searches title and body", () => {
  const store = new NoteStore();
  store.create({ title: "Deploy guide", body: "how to ship" });
  store.create({ title: "Grocery", body: "milk and eggs" });
  assert.deepEqual(store.search("DEPLOY").map((n) => n.title), ["Deploy guide"]);
  assert.deepEqual(store.search("eggs").map((n) => n.title), ["Grocery"]);
});
`;

const README = `# Acme Notes

A tiny, dependency-free note library used as the Fucking Code demo repository.

## Commands

\`\`\`sh
npm test
\`\`\`

## Known gaps

- \`NoteStore.list({ tag })\` accepts a tag but does not filter yet.
- \`NoteStore.search(query)\` returns an empty array.
- The tests for tag filtering and search exist but currently fail.
`;

const GITIGNORE = `node_modules/\ncoverage/\n.env\n`;

/**
 * Creates the local demo repository once. The fixture deliberately ships with
 * two failing tests so a code task has real work to do.
 */
export async function ensureDemoRepo(root: string): Promise<string> {
  const repoPath = resolve(root, "acme-notes");
  const gitDir = join(repoPath, ".git");
  const exists = await stat(gitDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (exists) return repoPath;

  await mkdir(join(repoPath, "src"), { recursive: true });
  await mkdir(join(repoPath, "test"), { recursive: true });
  await writeFile(join(repoPath, "package.json"), PACKAGE_JSON, "utf8");
  await writeFile(join(repoPath, "src/notes.js"), NOTES_JS, "utf8");
  await writeFile(join(repoPath, "test/notes.test.js"), TEST_JS, "utf8");
  await writeFile(join(repoPath, "README.md"), README, "utf8");
  await writeFile(join(repoPath, ".gitignore"), GITIGNORE, "utf8");

  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "devteam@local"]);
  await git(repoPath, ["config", "user.name", "Fucking Code"]);
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-m", "chore: initial notes library"]);
  return repoPath;
}

/**
 * Create an empty, isolated Git repository for a project that did not bring
 * its own repo. This is the default for non-technical clients: they should not
 * have to understand worktrees, branches or Git paths before starting.
 */
export async function ensureProjectRepo(input: {
  root: string;
  projectId: string;
  name: string;
}): Promise<string> {
  const repoPath = resolve(input.root, `project-${input.projectId}`);
  const gitDir = join(repoPath, ".git");
  const readme = `# ${input.name}

This repository was initialized automatically by Fucking Code.

The team will work on isolated branches and merge only after your approval.
`;
  const gitignore = `node_modules/
coverage/
.env
.env.*
dist/
build/
*.log
`;

  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), readme, "utf8").catch(() => undefined);
  await writeFile(join(repoPath, ".gitignore"), gitignore, "utf8").catch(() => undefined);

  const hasGit = await stat(gitDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!hasGit) await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "devteam@local"]);
  await git(repoPath, ["config", "user.name", "Fucking Code"]);

  const head = await git(repoPath, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  if (!head.trim()) {
    await git(repoPath, ["add", "-A"]);
    await git(repoPath, ["commit", "-m", "chore: initialize project repository"]);
  }
  return repoPath;
}
