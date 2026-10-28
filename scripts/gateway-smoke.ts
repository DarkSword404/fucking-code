import { createModelGateway } from "@devteam/agents";

const gateway = createModelGateway();
const provider = process.env.AGENT_MODEL_PROVIDER ?? "opencode-go";
const id = process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash";
const started = Date.now();
const text = await gateway.generateText({
  system: "You are a smoke test. Reply with exactly: GATEWAY_OK",
  prompt: "Reply now.",
  model: { providerID: provider, id },
  timeoutMs: 60_000,
});
console.log(
  JSON.stringify(
    {
      gateway: gateway.name,
      elapsedMs: Date.now() - started,
      text: text.trim().slice(0, 300),
    },
    null,
    2,
  ),
);
