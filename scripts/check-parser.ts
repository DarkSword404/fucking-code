import { parseAgentOutput } from "@devteam/domain";

const raw = `方案如下。

\`\`\`devteam
{"actions":[
 {"type":"create_artifact","kind":"design","title":"测试方案","summary":"含裸换行","content":"# 标题
第一行
第二行，带 "引号" 和 'single'
- 列表
"},
 {"type":"ask_user","question":"这样可以吗？"}
]}
\`\`\``;

const parsed = parseAgentOutput(raw);
console.log("text:", JSON.stringify(parsed.text));
console.log("errors:", parsed.errors);
console.log("actions:", parsed.actions.map((a) => a.type));
const artifact = parsed.actions[0] as { content?: string };
console.log("content lines:", artifact.content?.split("\n").length);
