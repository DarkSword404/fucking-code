import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { OpenAICompatibleGateway } from "@devteam/agents";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("openai-compatible multimodal gateway", () => {
  test("sends images as image_url content parts", async () => {
    let body: Record<string, unknown> | null = null;
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "seen" } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    const gateway = new OpenAICompatibleGateway(`http://127.0.0.1:${address.port}/v1`, "test");

    const text = await gateway.generateText({
      system: "system",
      prompt: "what is this?",
      model: { providerID: "test", id: "vision-model" },
      files: [{ name: "screen.png", mime: "image/png", data: "aGVsbG8=" }],
    });

    expect(text).toBe("seen");
    const messages = (body as { messages?: Array<{ content: unknown }> } | null)?.messages;
    const content = messages?.[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<Record<string, unknown>>)[0]).toEqual({
      type: "text",
      text: "what is this?",
    });
    expect((content as Array<Record<string, unknown>>)[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
  });
});
