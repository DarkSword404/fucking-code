import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { path7za } from "7zip-bin";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, test } from "vitest";
import { extractArchive, isArchive, mimeForFile } from "../apps/api/src/archive.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("archive extraction", () => {
  test("extracts a tar.gz and lists files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-archive-test-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "deploy.md"), "secret");
    const archive = join(root, "docs.tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: source }, ["deploy.md"]);

    const extracted = await extractArchive(archive, "docs.tar.gz", join(root, "out"));
    expect(extracted.entries).toBe(1);
    expect(extracted.files.map((file) => file.name)).toContain("deploy.md");
    expect(await readFile(join(root, "out", "deploy.md"), "utf8")).toBe("secret");
  });

  test("extracts a 7z archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-7z-test-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "note.md"), "seven zip");
    const archive = join(root, "docs.7z");
    execFileSync(path7za, ["a", archive, "note.md"], { cwd: source, stdio: "ignore" });

    const extracted = await extractArchive(archive, "docs.7z", join(root, "out"));
    expect(extracted.files.map((file) => file.name)).toContain("note.md");
    expect(await readFile(join(root, "out", "note.md"), "utf8")).toBe("seven zip");
  });

  test("recognises archive names and document mime types", () => {
    expect(isArchive("docs.zip", "application/octet-stream")).toBe(true);
    expect(isArchive("docs.tar.gz", "application/octet-stream")).toBe(true);
    expect(isArchive("docs.7z", "application/x-7z-compressed")).toBe(true);
    expect(isArchive("docs.rar", "application/vnd.rar")).toBe(true);
    expect(isArchive("readme.md", "text/markdown")).toBe(false);
    expect(mimeForFile("notes/deploy.md")).toBe("text/markdown");
    expect(mimeForFile("data.json")).toBe("application/json");
  });
});
