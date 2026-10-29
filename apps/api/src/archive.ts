import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createExtractorFromData } from "node-unrar-js";
import { path7za } from "7zip-bin";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import yauzl from "yauzl";

export interface ArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface ExtractedArchive {
  files: Array<{ name: string; path: string }>;
  entries: number;
  bytes: number;
}

const execFileAsync = promisify(execFile);

const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: Number(process.env.ARCHIVE_MAX_ENTRIES ?? 300),
  maxFileBytes: Number(process.env.ARCHIVE_MAX_FILE_BYTES ?? 20 * 1024 * 1024),
  maxTotalBytes: Number(process.env.ARCHIVE_MAX_TOTAL_BYTES ?? 60 * 1024 * 1024),
};

export function isArchive(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".7z") ||
    lower.endsWith(".rar") ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/x-tar" ||
    mime === "application/gzip" ||
    mime === "application/x-gzip" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/vnd.rar" ||
    mime === "application/x-rar-compressed"
  );
}

export function archiveKind(name: string): "zip" | "tar" | "tar.gz" | "7z" | "rar" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".7z")) return "7z";
  if (lower.endsWith(".rar")) return "rar";
  return null;
}

function safeTarget(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) throw new Error("invalid archive entry");
  const target = resolve(root, normalized);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`archive entry escapes extraction root: ${entryName}`);
  }
  return target;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

function skipNoise(name: string): boolean {
  return (
    name.startsWith("__MACOSX/") ||
    name.endsWith("/.DS_Store") ||
    name === ".DS_Store"
  );
}

async function listFiles(root: string, max: number): Promise<Array<{ name: string; path: string }>> {
  const out: Array<{ name: string; path: string }> = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= max) return;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        if (info.isFile()) {
          out.push({ name: relative(root, absolute), path: absolute });
        }
      }
    }
  }
  await walk(root);
  return out;
}

async function extractZip(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<ExtractedArchive> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (openError, zip) => {
        if (openError || !zip) {
          reject(openError ?? new Error("cannot open zip"));
          return;
        }
        let entries = 0;
        let total = 0;
        let failed = false;
        const fail = (error: Error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(error);
        };
        zip.on("error", fail);
        zip.on("end", async () => {
          if (failed) return;
          try {
            const files = await listFiles(destination, limits.maxEntries);
            resolvePromise({ files, entries, bytes: total });
          } catch (error) {
            reject(error);
          }
        });
        zip.on("entry", (entry) => {
          if (failed) return;
          const name = entry.fileName.replace(/\\/g, "/");
          if (skipNoise(name)) {
            zip.readEntry();
            return;
          }
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (isSymlinkEntry(entry)) {
            fail(new Error(`symlink entries are not allowed: ${name}`));
            return;
          }
          entries += 1;
          if (entries > limits.maxEntries) {
            fail(new Error(`archive has more than ${limits.maxEntries} entries`));
            return;
          }
          if (entry.uncompressedSize > limits.maxFileBytes) {
            fail(new Error(`archive entry too large: ${name}`));
            return;
          }
          total += entry.uncompressedSize;
          if (total > limits.maxTotalBytes) {
            fail(new Error("archive expands beyond the total size limit"));
            return;
          }
          let target: string;
          try {
            target = safeTarget(destination, name);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          zip.openReadStream(entry, async (streamError, stream) => {
            if (failed) return;
            if (streamError || !stream) {
              fail(streamError ?? new Error(`cannot read zip entry: ${name}`));
              return;
            }
            try {
              await mkdir(dirname(target), { recursive: true });
              await pipeline(stream, createWriteStream(target));
              zip.readEntry();
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });
        zip.readEntry();
      },
    );
  });
}

async function extractTar(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<ExtractedArchive> {
  let entries = 0;
  let total = 0;
  await mkdir(destination, { recursive: true });
  await tar.x({
    file: archivePath,
    cwd: destination,
    strict: true,
    preservePaths: false,
    noChmod: true,
    noMtime: true,
    filter: (path, entry) => {
      const name = path.replace(/\\/g, "/");
      if (skipNoise(name)) return false;
      if (!("type" in entry)) return true;
      if (entry.type !== "File" && entry.type !== "Directory") return false;
      safeTarget(destination, name);
      if (entry.type === "File") {
        const size = entry.size ?? 0;
        entries += 1;
        if (entries > limits.maxEntries) {
          throw new Error(`archive has more than ${limits.maxEntries} entries`);
        }
        if (size > limits.maxFileBytes) {
          throw new Error(`archive entry too large: ${name}`);
        }
        total += size;
        if (total > limits.maxTotalBytes) {
          throw new Error("archive expands beyond the total size limit");
        }
      }
      return true;
    },
  });
  const files = await listFiles(destination, limits.maxEntries);
  return { files, entries, bytes: total };
}

async function extract7z(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<ExtractedArchive> {
  await chmod(path7za, 0o755).catch(() => undefined);
  const { stdout } = await execFileAsync(path7za, ["l", "-slt", archivePath], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  let entries = 0;
  let total = 0;
  let current: Record<string, string> = {};
  const consume = () => {
    if (!current["Path"]) return;
    const name = current["Path"]!.replace(/\\/g, "/");
    const isDir = current["Folder"] === "+";
    if (isDir) return;
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new Error(`archive has more than ${limits.maxEntries} entries`);
    }
    const size = Number(current["Size"] ?? 0);
    if (Number.isFinite(size)) {
      if (size > limits.maxFileBytes) throw new Error(`archive entry too large: ${name}`);
      total += size;
      if (total > limits.maxTotalBytes) {
        throw new Error("archive expands beyond the total size limit");
      }
    }
    if (current["Attributes"]?.startsWith("l")) {
      throw new Error(`symlink entries are not allowed: ${name}`);
    }
    safeTarget(destination, name);
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      consume();
      current = {};
      continue;
    }
    const index = line.indexOf(" = ");
    if (index > 0) current[line.slice(0, index)] = line.slice(index + 3);
  }
  consume();

  const temporary = `${destination}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await execFileAsync(
      path7za,
      ["x", "-y", "-bd", `-o${temporary}`, archivePath],
      { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
    );
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const files = await listFiles(destination, limits.maxEntries);
  return { files, entries, bytes: total };
}

async function extractRar(
  archivePath: string,
  destination: string,
  limits: ArchiveLimits,
): Promise<ExtractedArchive> {
  const buffer = await readFile(archivePath);
  const extractor = await createExtractorFromData({
    data: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
  });
  const list = extractor.getFileList();
  if (list.arcHeader.flags.volume) {
    throw new Error("multi-volume RAR archives are not supported");
  }
  let entries = 0;
  let total = 0;
  const headers = [...list.fileHeaders];
  for (const header of headers) {
    if (header.flags.directory) continue;
    if (header.flags.encrypted) {
      throw new Error("encrypted RAR archives are not supported");
    }
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new Error(`archive has more than ${limits.maxEntries} entries`);
    }
    if (header.unpSize > limits.maxFileBytes) {
      throw new Error(`archive entry too large: ${header.name}`);
    }
    total += header.unpSize;
    if (total > limits.maxTotalBytes) {
      throw new Error("archive expands beyond the total size limit");
    }
    safeTarget(destination, header.name);
  }

  await mkdir(destination, { recursive: true });
  const extracted = extractor.extract();
  for (const file of extracted.files) {
    if (file.fileHeader.flags.directory) continue;
    if (!file.extraction) {
      throw new Error(`cannot read RAR entry: ${file.fileHeader.name}`);
    }
    const target = safeTarget(destination, file.fileHeader.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.extraction));
  }
  const files = await listFiles(destination, limits.maxEntries);
  return { files, entries, bytes: total };
}

export async function extractArchive(
  archivePath: string,
  name: string,
  destination: string,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<ExtractedArchive> {
  const kind = archiveKind(name);
  if (!kind) throw new Error("unsupported archive type; use zip, tar, tar.gz or tgz");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    if (kind === "zip") return await extractZip(archivePath, destination, limits);
    if (kind === "7z") return await extract7z(archivePath, destination, limits);
    if (kind === "rar") return await extractRar(archivePath, destination, limits);
    return await extractTar(archivePath, destination, limits);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".html": "text/html",
  ".css": "text/css",
};

export async function listExtractedFiles(
  root: string,
  max = 200,
): Promise<Array<{ name: string; path: string }>> {
  return listFiles(root, max);
}

export function mimeForFile(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}
