# ADR-0001: OpenCode Runtime 与事件游标

- 状态：Accepted（v0.1 基线）
- 日期：2026-10-22
- 关联：E04 / E05 / E06

## 背景

Fucking Code 需要两类完全不同的 Agent 能力：

1. **讨论**：多个角色在聊天室里快速、低成本地发言，不需要工具。
2. **编码**：在隔离工作区里读文件、改代码、跑测试，需要工具、权限和较长时间。

同时，前端需要断线可恢复的事件流，而 OpenCode 的运行时事件不是业务事件。

## 验证过的事实（OpenCode v2.0.32）

- HTTP API 有 146 个 operation，覆盖 session 创建、prompt、interrupt、message、event、
  worktree、vcs diff、fs、shell、permission、credential、project。
- `POST /api/experimental/generate` 支持一次性文本生成（`{prompt, model}`），适合讨论。
- `POST /api/session` 支持 `location.directory`、`model`、`permissions`；`/prompt` 异步执行，
  `GET /api/session/:id` 返回 `outcome`、`cost`、`tokens`。
- 事件订阅 `client.event.subscribe()` 是 **live-only，无 replay、无自动重连**。
- 服务以 location（目录）为作用域，是单用户本地服务模型，没有租户概念。
- 仓库 MIT；`@opencode/ui` 已发布（MIT），`@opencode/session-ui` / `@opencode/app` 未发布。

## 决策

1. **讨论走 one-shot generate**，不建 session。原因：无工具、上下文可控、延迟低、成本低。
2. **编码走 session**，`location` 绑定到任务 worktree，并下发 deny 规则：
   `git push` / `reset --hard` / `rm -rf` / `external_directory` / `.env` / 子 Agent / 联网工具。
3. **事件游标只用我们自己的 `events.seq`**。OpenCode 事件不进入业务游标；服务端先落库再推 SSE。
4. **runtime 不共享给多租户**。一个 OpenCode 实例只服务一个用户/项目边界；生产按项目池化。
5. **UI 不深度 fork OpenCode**。`@opencode/ui` 可以按依赖复用；聊天/Diff/任务/门禁工作台自建。

## 影响

- 讨论和编码的运行时解耦，讨论延迟和成本可控；编码可以长跑而不拖住聊天。
- 需要自己维护 `AgentRun`、`Workspace`、`TestRun` 和事件表，不能把 OpenCode 当业务数据库。
- 编码会话的超时、权限拒绝、outcome 失败必须显式处理；不能假设 session 一定成功。
- 生产必须补容器沙箱；当前 worktree 只解决 Git 目录冲突，不是安全边界。

## 回滚 / 替代

- 讨论可以替换为任意 OpenAI-compatible 文本接口（`OpenCodeRuntime` 只有 `generate` 一个方法）。
- 编码可以替换为远程 Runner 或自建 sandbox + agent loop；`AgentRuntime` 和 `runTaskWork`
  的边界保持不变。
