#!/usr/bin/env node
/**
 * Sync the current working tree to GitHub through the Git Data API.
 *
 * `git push` is unreliable in this environment, so this script mirrors the
 * committed tree instead. Usage:
 *
 *   GH_TOKEN=$(gh auth token) node scripts/sync-github.mjs "commit message"
 *
 * Optional env: GITHUB_REPO=owner/name, GITHUB_BRANCH=main
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

const repo = process.env.GITHUB_REPO ?? "DarkSword404/fucking-code";
const branch = process.env.GITHUB_BRANCH ?? "main";
const message = process.argv.slice(2).join(" ") || "Sync from working tree";
const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

const api = "https://api.github.com";

async function gh(path, init = {}, attempt = 0) {
  try {
    const response = await fetch(api + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "fucking-code",
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${path} ${response.status}: ${text.slice(0, 600)}`);
    }
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      return gh(path, init, attempt + 1);
    }
    throw error;
  }
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const current = index++;
        if (current >= items.length) return;
        output[current] = await fn(items[current], current);
      }
    }),
  );
  return output;
}

const repoPath = `/repos/${repo}`;
const head = await gh(`${repoPath}/git/ref/heads/${branch}`);
const parentSha = head.object.sha;

const lines = execFileSync("git", ["ls-files", "-s"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const files = lines.map((line) => {
  const [meta, path] = line.split("\t");
  return { mode: meta.split(" ")[0], path };
});

const entries = await mapLimit(files, 4, async (file) => {
  const content = file.mode === "120000" ? readlinkSync(file.path) : readFileSync(file.path);
  const blob = await gh(`${repoPath}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: Buffer.from(content).toString("base64"), encoding: "base64" }),
  });
  return {
    path: file.path,
    mode: file.mode === "100755" ? "100755" : file.mode === "120000" ? "120000" : "100644",
    type: "blob",
    sha: blob.sha,
  };
});

const tree = await gh(`${repoPath}/git/trees`, {
  method: "POST",
  body: JSON.stringify({ tree: entries }),
});
const commit = await gh(`${repoPath}/git/commits`, {
  method: "POST",
  body: JSON.stringify({
    message,
    tree: tree.sha,
    parents: [parentSha],
    author: { name: "Fucking Code", email: "dev@local.test" },
    committer: { name: "Fucking Code", email: "dev@local.test" },
  }),
});
await gh(`${repoPath}/git/refs/heads/${branch}`, {
  method: "PATCH",
  body: JSON.stringify({ sha: commit.sha, force: true }),
});

console.log(
  JSON.stringify(
    { repo, branch, parent: parentSha.slice(0, 8), commit: commit.sha, files: entries.length },
    null,
    2,
  ),
);
