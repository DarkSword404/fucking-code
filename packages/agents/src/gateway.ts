import { opencodeFetch } from "./opencode-client.js";

export interface ModelRef {
  providerID: string;
  id: string;
}

export interface ModelTextRequest {
  system: string;
  prompt: string;
  model: ModelRef;
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
          { role: "user", content: request.prompt },
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
