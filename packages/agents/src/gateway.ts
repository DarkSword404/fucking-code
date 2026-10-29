import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { opencodeFetch } from "./opencode-client.js";

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface ModelFile {
  name: string;
  mime: string;
  size?: number;
  /** Local absolute path; preferred on a host that shares storage with OpenCode. */
  path?: string;
  /** Base64 payload without the data: prefix; fallback for remote gateways. */
  data?: string;
}

/** Backwards-compatible alias for image-only callers. */
export type ModelImage = ModelFile;

export interface ModelTextRequest {
  system: string;
  prompt: string;
  model: ModelRef;
  files?: ModelFile[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Small inference-only abstraction. Fucking Code's agent loop should depend on
 * this, not on OpenCode sessions. `opencode` reuses the local subscription as
 * a model gateway; `openai` can point at any OpenAI-compatible endpoint when
 * the user has an API key.
 */
export interface ModelGateway {
  readonly name: string;
  generateText(request: ModelTextRequest): Promise<string>;
}

export class OpenCodeGateway implements ModelGateway {
  readonly name = "opencode";

  async generateText(request: ModelTextRequest): Promise<string> {
    if (request.files?.length) return this.generateWithFiles(request);
    const response = await opencodeFetch<{ data?: { text?: string }; message?: string }>(
      "/api/experimental/generate",
      {
        method: "POST",
        body: JSON.stringify({
          prompt: `${request.system}\n\n---\n\n${request.prompt}`,
          model: { providerID: request.model.providerID, id: request.model.id },
        }),
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? 90_000,
      },
    );
    if (!response.ok) {
      const parsed = response.data as { message?: string; _tag?: string } | null;
      const message = parsed?.message ?? parsed?._tag ?? response.raw.slice(0, 500);
      throw new Error(`OpenCode gateway failed (${response.status}): ${message}`);
    }
    const text = (response.data as { data?: { text?: string } } | null)?.data?.text ?? "";
    if (!text.trim()) throw new Error("OpenCode gateway returned empty text");
    return text;
  }

  /**
   * OpenCode's stateless generate endpoint does not accept images. For image
   * turns we use a short-lived, tool-denied session, then delete it. Text-only
   * chat stays stateless.
   */
  private async generateWithFiles(request: ModelTextRequest): Promise<string> {
    const files = request.files ?? [];
    const timeoutMs = request.timeoutMs ?? 120_000;
    const created = await opencodeFetch<{ data?: { id?: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "[Fucking Code] image turn",
        location: { directory: process.env.MULTIMODAL_WORKDIR ?? tmpdir() },
        model: request.model,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
      signal: request.signal,
      timeoutMs: 30_000,
    });
    const sessionId = (created.data as { data?: { id?: string } } | null)?.data?.id;
    if (!created.ok || !sessionId) {
      throw new Error(
        `OpenCode vision session failed (${created.status}): ${created.raw.slice(0, 400)}`,
      );
    }

    try {
      const prompted = await opencodeFetch(`/api/session/${sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({
          text: `${request.system}\n\n---\n\n${request.prompt}`,
          files: await Promise.all(
            files.map(async (file) => {
              const useUri =
                process.env.MULTIMODAL_FILE_URI !== "0" && Boolean(file.path);
              const data = useUri
                ? ""
                : file.data ??
                  (file.path ? (await readFile(file.path)).toString("base64") : "");
              return {
                uri: useUri
                  ? pathToFileURL(file.path!).href
                  : `data:${file.mime};base64,${data}`,
                name: file.name,
              };
            }),
          ),
        }),
        signal: request.signal,
        timeoutMs: 30_000,
      });
      if (!prompted.ok) {
        throw new Error(
          `OpenCode vision prompt failed (${prompted.status}): ${prompted.raw.slice(0, 400)}`,
        );
      }

      const deadline = Date.now() + timeoutMs;
      let outcome = "";
      while (Date.now() < deadline) {
        if (request.signal?.aborted) throw new Error("vision generation cancelled");
        await new Promise((resolve) => setTimeout(resolve, 700));
        const status = await opencodeFetch<{ data?: Record<string, unknown> }>(
          `/api/session/${sessionId}`,
          { signal: request.signal, timeoutMs: 15_000 },
        );
        const data = (status.data as { data?: Record<string, unknown> } | null)?.data;
        outcome = String(data?.outcome ?? "");
        if (outcome) break;
      }
      if (!outcome) throw new Error("OpenCode vision generation timed out");

      const messages = await opencodeFetch<{ data?: Array<Record<string, unknown>> }>(
        `/api/session/${sessionId}/message?order=asc&limit=200`,
        { signal: request.signal, timeoutMs: 20_000 },
      );
      const rows = (messages.data as { data?: Array<Record<string, unknown>> } | null)?.data ?? [];
      const assistantRows = rows.filter((row) => row.type === "assistant");
      const text = assistantRows
        .map((row) =>
          Array.isArray(row.content)
            ? (row.content as Array<Record<string, unknown>>)
                .filter((part) => part.type === "text")
                .map((part) => String(part.text ?? ""))
                .join("")
            : "",
        )
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) {
        const error = assistantRows
          .map((row) => row.error as { message?: string } | undefined)
          .find((item) => item?.message)?.message;
        throw new Error(`OpenCode vision generation ${outcome}${error ? `: ${error}` : ""}`);
      }
      return text;
    } finally {
      await opencodeFetch(`/api/session/${sessionId}`, {
        method: "DELETE",
        timeoutMs: 15_000,
      }).catch(() => undefined);
    }
  }
}

export class OpenAICompatibleGateway implements ModelGateway {
  readonly name = "openai-compatible";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async generateText(request: ModelTextRequest): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model.id,
        temperature: 0.2,
        messages: [
          { role: "system", content: request.system },
          {
            role: "user",
            content: request.files?.length
              ? [
                  { type: "text", text: request.prompt },
                  ...(await Promise.all(
                    request.files.map(async (file) => {
                      if (file.mime.startsWith("image/")) {
                        const data =
                          file.data ??
                          (file.path
                            ? (await readFile(file.path)).toString("base64")
                            : "");
                        return {
                          type: "image_url",
                          image_url: { url: `data:${file.mime};base64,${data}` },
                        };
                      }
                      if (
                        file.mime.startsWith("text/") ||
                        file.mime === "application/json" ||
                        file.mime === "application/xml"
                      ) {
                        const content =
                          file.data ??
                          (file.path ? await readFile(file.path, "utf8") : "");
                        return {
                          type: "text",
                          text: `\n\n文件 ${file.name}:\n${content.slice(0, 20_000)}`,
                        };
                      }
                      return { type: "text", text: `\n\n附件：${file.name}（${file.mime}）` };
                    }),
                  )),
                ]
              : request.prompt,
          },
        ],
      }),
      signal: request.signal ?? AbortSignal.timeout(request.timeoutMs ?? 90_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Model gateway failed (${response.status}): ${raw.slice(0, 500)}`);
    }
    let parsed: {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new Error(`Model gateway returned non-JSON: ${raw.slice(0, 300)}`);
    }
    const content = parsed.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : (content ?? "");
    if (!text.trim()) throw new Error("Model gateway returned empty text");
    return text;
  }
}

/** Deterministic gateway for offline smoke tests and CI. */
export class EchoGateway implements ModelGateway {
  readonly name = "echo";
  async generateText(request: ModelTextRequest): Promise<string> {
    return `OK\n${request.prompt.slice(0, 200)}`;
  }
}

export function createModelGateway(): ModelGateway {
  const mode = (process.env.MODEL_GATEWAY ?? "opencode").toLowerCase();
  if (mode === "echo" || mode === "mock") return new EchoGateway();
  if (mode === "openai" || mode === "openai-compatible") {
    const baseUrl =
      process.env.MODEL_API_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1";
    const apiKey = process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("MODEL_GATEWAY=openai requires MODEL_API_KEY or OPENAI_API_KEY");
    }
    return new OpenAICompatibleGateway(baseUrl, apiKey);
  }
  return new OpenCodeGateway();
}
