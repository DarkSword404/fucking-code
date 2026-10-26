# Fucking Code

> 把 AI 研发团队变成你的乙方。

Fucking Code 是一个以共享聊天室为核心的 AI 研发工作台。你以甲方身份在群聊里说出想解决的问题，AI 团队以乙方方式接住：先问清楚，再给建议，必要时反驳，最后交付可审查的方案、代码、测试和验收证据。**聊天室不是界面，而是组织。**

它不是“一句话生成一个项目”，而是一支会轮流发言、会互相提问、会向甲方提问的 AI 研发团队。

- [产品介绍](docs/product/fucking-code.md)
- [设计论文](docs/paper/fucking-code-design-paper.md)
- [工程基线](docs/product/fucking-code-design.md)
- [当前完成度](#当前完成度)

> 当前仓库是 **v0.2 可运行基线**：核心协作链路、真实代码执行、验收合并、项目成员、长期记忆、命令沙箱和备份已经跑通；容器化编码 Agent、PostgreSQL RLS、GitHub OAuth 和 token 级流式聊天仍在路线图中。

---

## 1. 它现在能做什么

- **多 Agent 共享聊天室**：PM / Architect / Frontend / Backend / QA / Security / Lead 各自有角色、
  提示词、颜色和模型配置。**每条消息所有房间成员都会读到**，但每个 Agent 自己判断是否相关：
  相关才发言，无关就沉默；`@` 只是提高注意力，不是“才能读到”。
- **单发言人会话**：每轮只允许一个 Agent 回复，其他人读完这条消息后下一轮再判断，避免多人同时
  刷屏。需要甲方补充信息时使用 `ask_user`，本轮暂停等待；需要同事输入时 `@角色` 或 `handoff`。
- **自动开发与回馈**：项目进入 `build` 后可以自动启动就绪任务；每个任务完成后自动触发 QA/Lead
  的群聊回馈。代码仍需要测试、规格核对和人工验收合并。
- **决策弹窗与停机点**：待审批、待确认产物、待验收任务或待决策事项会自动弹出决策窗口；有待决策项时
  自动开发暂停。你处理完后也不会立刻继续，需要明确点「继续自动开发」。
- **审批简化**：设计、契约、计划、备注、仓库分析支持一键批量接受；PRD、验收标准、测试报告仍逐项确认。
- **用户是甲方**：用户不是被无条件服从的指令源，而是群聊中的甲方/客户。团队会先澄清目标、
  场景、边界和验收；发现方案风险或不合理需求时会反驳，并给出替代方案。
- **真实模型驱动**：默认调用本机 OpenCode Server 的模型（已验证 `opencode-go/deepseek-v4.1-flash`）。
  也可以用 `AGENT_RUNTIME=mock` 离线跑完整流程。
- **聊天 → 结构化状态**：Agent 通过受控的 `devteam` JSON 动作块创建任务、产物、决策、审批、
  阶段提议和交接。服务端逐条校验，提示词不是权限边界。
- **AI 主导的敏捷阶段机**：AI 根据证据判断该进入、回退还是开始新一轮，通过弹窗向甲方发起
  阶段确认；甲方批准后服务端才推进。阶段图允许 `test → build`、`review → build`、`done → planning`
  等循环，不把研发压成单向流水线。手动推进只作为负责人兜底。
- **版本化产物**：PRD、验收标准、技术方案、API 契约、测试报告、Diff 都有版本历史，可接受/退回。
- **真实代码执行**：从任务创建隔离 Git worktree，启动 OpenCode 编码会话，让 Agent 改代码、
  跑测试，然后把 Diff 和测试报告作为产物归档，任务进入 `review`。
- **任务与项目生命周期**：任务支持编辑、删除、取消运行和状态流转；删除任务会清理 worktree 和分支。
  项目所有者可以在项目设置里二次确认删除项目，删除前会清理全部代码工作区。
- **项目成员与权限**：项目设置里可以按邮箱添加成员，分配 Owner / Member / Viewer；
  Owner 管理成员和删除项目，Member 可编辑和跑任务，Viewer 只读。
- **验收合并**：代码任务通过测试和规格核对后，可以直接验收合并到项目默认分支，并写入审计。
- **长期记忆**：Agent 可以提出记忆候选，用户也可以手工添加；接受后的长期事实/约束会注入群聊和代码任务提示词。
- **其他**：任务/产物搜索、单命令终端、自助修改密码、失败任务一键转缺陷。
- **协作实时性**：SSE 在线成员 presence；任务和项目设置支持乐观锁，避免多人覆盖修改。
- **命令沙箱**：测试和终端命令通过 bubblewrap 在只读根文件系统、无网络、仅工作区可写的环境中执行；Git 终端只允许只读子命令。
- **备份与 GitHub**：提供 PGlite 备份/恢复脚本；配置 `GITHUB_TOKEN` 后可以把 review 分支推送并创建 GitHub PR。
- **持久化事件流**：SSE + 自增游标，断线后可以从未消费的位置恢复；事件先落库再推送。
- **项目隔离**：所有 API 都校验项目成员资格；文件路径、工作区、事件订阅都按项目作用域。
- **三栏工作台**：可收缩/拖宽的左右面板、聊天室、任务看板、产物审查、团队/门禁/运行面板。

## 2. 快速开始

### 依赖

- Node.js 22+
- Git
- 一个正在运行的 OpenCode V2 服务（可选；不装也能用 mock 模式）

### 启动

```sh
npm install
cp .env.example .env
npm run dev
```

打开 <http://127.0.0.1:5174>。

首次启动会自动：

1. 在 `data/pg` 创建内嵌 PostgreSQL（PGlite）并建表；
2. 创建本地用户、示例项目 **Acme Notes**、主聊天室和默认团队；
3. 在 `data/repos/acme-notes` 创建一个带失败测试的小型 Git 仓库，作为代码任务的目标。

### 两种 Agent 运行时

```env
# 真实模型：读取本机 OpenCode 服务
AGENT_RUNTIME=opencode
AGENT_MODEL_PROVIDER=opencode-go
AGENT_MODEL_ID=deepseek-v4.1-flash

# 离线/CI：确定性脚本 Agent，不调用模型
AGENT_RUNTIME=mock
```

OpenCode 服务发现顺序：

1. `OPENCODE_URL` 环境变量；
2. `opencode service status` 输出的 URL；
3. `http://127.0.0.1:4096`。

认证默认读取 `~/.config/opencode/service.json` 的 `password`，使用 Basic Auth
（用户名 `opencode`）。也可以用 `OPENCODE_PASSWORD` 显式覆盖。

### 登录与账号

默认 `AUTH_MODE=dev` 是本地自动登录，不显示登录页。当前工作区的 `.env` 已切换到
`session` 模式：

```env
AUTH_MODE=session
SIGNUP_INVITE_CODE=<your-invite-code>
WEB_ORIGIN=http://127.0.0.1:5174
COOKIE_SECURE=false   # HTTPS 下改为 true
```

- 打开登录页，用邀请码注册；每个账号自动获得独立的租户、项目和聊天室。
- 密码使用 scrypt 哈希；会话 token 只以 SHA-256 存库，浏览器侧是 HttpOnly +
  SameSite=Lax 的 7 天 cookie。
- 登录/注册按 IP 限流；所有非 GET 请求校验 `Origin`。
- 本地 seed 账号是 `dev@local.test`，拥有当前 4 个演示项目。设置/重置密码（先停掉
  API，避免 PGlite 文件锁）：

  ```sh
  npm run user:password -- 'your-new-password'
  ```

- 生产环境：`COOKIE_SECURE=true`，`WEB_ORIGIN=https://your-domain`，使用强邀请码。
  登录只是第一步；测试/终端命令已经用 bubblewrap 隔离，但编码 Agent 仍运行在宿主进程，开放执行前还需要容器化与配额。

### 公网 Demo

最短路径是用独立实例 + Cloudflare 临时 HTTPS：

```sh
# 独立数据库，别动本地开发数据
cp -a data/pg data/demo-pg

NODE_ENV=production ENV_FILE=./demo.env npx tsx apps/api/src/index.ts
```

`demo.env` 至少包含：

```env
PORT=8788
HOST=127.0.0.1
PGDATA=./data/demo-pg
AUTH_MODE=session
SIGNUP_INVITE_CODE=<strong-invite-code>
COOKIE_SECURE=true
WEB_ORIGIN=https://<your-tunnel-url>
DEMO_MODE=1
DEMO_MESSAGES_PER_USER_PER_DAY=10
DEMO_MESSAGES_PER_DAY=200
```

`DEMO_MODE=1` 会：

- 禁用 `/tasks/:id/work` 和所有 `/workspaces/*` 代码执行入口；
- 在 UI 顶部显示“演示模式”横幅；
- 隐藏仓库路径，避免泄露宿主机目录；
- 按访客和全局限制每日消息数。

然后用 Cloudflare Tunnel 指向 `8788` 即可。现有 Diff/测试报告仍然可以在「需求与产物」里查看。

### 常用命令

```sh
npm run dev            # API + Web（API 8787，Web 5174）
npm run typecheck      # TypeScript 全量检查
npm test               # 单元测试（41 个）
npm run build          # 构建 Web
npm start              # 生产模式，API 同时托管 apps/web/dist
npm run user:password  # 设置 seed 账号密码，例如 npm run user:password -- 'new-pass'
npm run db:reset       # 清空本地数据库（下次启动重新 seed）
```

## 3. 怎么用（推荐路径）

1. 打开 **Acme Notes**，在聊天室说：
   > 我想做一个支持 Markdown、标签和全文搜索的笔记应用，先帮我理清需求和验收标准。
2. PM 会追问最多一轮，然后产出 **PRD** 和 **验收标准**。
3. 右侧「门禁」→「待确认产物」里查看并接受。门禁满足后，AI 会主动发起「是否进入方案设计」的
   阶段确认；在弹窗里批准即可。正常流程不需要你点「手动推进」。
4. `@Architect 基于 PRD 出技术方案和接口契约`。接受方案后，AI 会再发起进入 `planning` 的确认。
5. `@Lead 把方案拆成任务，前后端并行，QA 在接口稳定后介入`。Lead 会创建带负责人和验收标准的任务。
6. 在「开发任务」里对任意任务点 **开始工作**。系统会：
   - 从 `repoPath` 创建隔离 worktree 和 `devteam/...` 分支；
   - 启动 OpenCode 编码会话（带工具、限权）；
   - 运行项目测试；
   - 归档 **Diff** 和 **测试报告**，任务进入 `review`。
7. 点任务上的 **查看变更** 审查 Diff；验收合并后，AI 会判断是否进入测试或回退返工。
8. `review` / `deliver` 阶段会自动生成待审批项，人工批准后才能继续。
9. 敏捷循环也走同一套确认：测试失败可以回 `build`，评审不通过可以回 `build`，交付后可以开始
   下一轮 `planning` / `discovery`。AI 提议、甲方确认、自动开发保持暂停，直到你点「继续自动开发」。

> 示例仓库里的 `list({tag})` 和 `search()` 是故意留空的，配套测试会失败，正好给 Agent 一个
> 真实的编码任务。

## 4. 架构

```text
apps/
  api/                 Hono HTTP API + SSE + orchestrator 触发
  web/                 SolidJS + Vite 工作台
packages/
  contracts/           前后端共享类型、事件名、状态枚举
  domain/              角色提示词、动作协议、任务状态机、阶段门禁、UUID
  db/                  Drizzle schema、PGlite 客户端、迁移、seed、仓储
  agents/              OpenCode 客户端、讨论运行时、上下文组装、编排器
  workspace/           Git worktree、文件读取、命令执行、编码 Agent 运行
tests/                 domain + workspace 单元测试
data/                  本地数据库、示例仓库、worktree（gitignored）
```

### 一次聊天回合（群聊）

```text
POST /messages
  → 持久化用户消息
  → 广播：所有房间成员同时阅读房间
  → 每个 Agent 独立判断：PASS（沉默）或 SPEAK
  → 本轮只选一个 Agent 讲话（阶段负责人/被 @/被交接优先）
  → 他的消息成为下一轮输入；所有房间成员再读、再判断
  → 需要甲方补充信息时暂停，等待甲方回答后开启下一轮
  → 直到无人发言 / 轮次上限 / 消息预算
  → 用户消息上记录本轮摘要：多少人收到、谁发言、谁沉默及原因
```

这里的“广播 + 自主判断 + 单发言人”是核心：不是路由器挑人，而是一个真正的群聊；但每次只让
一个人把话说完。沉默是合法结果，但会被记录和解释。`@` 只强制被点名者在下一轮发言，其他房间
成员仍然会读到并自行决定。Agent 可以问同事，也可以问甲方；甲方回答后，团队继续推进。

**房间成员 vs 本次参与**：

- **房间成员（持久）**：右侧「团队」面板里可以把 Agent 移出/加入房间。只有房间成员会收到消息；
  移出后不再广播给他，随时可以加回来。
- **本次参与（单次）**：输入框上方的「参与 N 人」可以只对下一条消息指定参与者；发完自动恢复房间默认。
- **`@` 自动拉人**：`@` 一个房间外的 Agent，会把他加入本次讨论，并在聊天室显示系统提示。
- 这三者都只改变“谁在房间里”，不改变群聊语义：房间里的人仍然全部收到每条消息，各自判断是否发言。


### 一次代码任务

进入 `build` 后，如果项目设置里开启「自动启动任务」，系统会自动挑选依赖已满足的 `ready` 任务；
每完成一个任务，会自动发起一次 QA/Lead 群聊回馈，再继续下一个。

```text
POST /tasks/:id/work
  → git worktree add -b devteam/<task>-<suffix>
  → POST /api/session（location = worktree，带 deny 规则）
  → POST /api/session/:id/prompt
  → 轮询 session outcome
  → GET session messages 取最终总结
  → 在 worktree 执行测试（命令白名单）
  → git add -A && git diff --cached
  → 归档 diff / test_report 产物 + test_runs + 任务证据
```

## 5. 数据与状态

- **权威存储**：PGlite（PostgreSQL 语义）保存项目、聊天、任务、产物、决策、审批、运行、事件、审计。
- **事件游标**：`events.seq`（BIGSERIAL）是唯一游标。OpenCode 的事件流是 live-only，不能作为恢复游标。
- **任务状态**：`proposed → ready → in_progress → review/testing → done`，非法跃迁返回 409。
- **阶段门禁**：
  - 阶段由 AI 提议、甲方确认；允许前进、回退和迭代循环，非法跳阶段返回 409
  - discovery：PRD 已接受 + 验收标准存在
  - design：技术方案已接受
  - planning：至少 1 个任务
  - build：所有任务完成/取消
  - test：测试报告已接受
  - review：`phase_review` 审批通过
  - deliver：`delivery` 审批通过
- **审计**：阶段变更、产物接受/退回、审批、项目创建等写入 `audit_events`。

## 6. 安全边界（重要）

这是本地开发基线，**不是生产级多租户系统**：

- **本地自动登录**：`AUTH_MODE=dev` 时默认使用 seed 用户，不校验登录；`AUTH_MODE=session`
  时使用 scrypt 密码 + HttpOnly 会话 cookie，并按 IP 限流。
- **会话安全**：HttpOnly、SameSite=Lax、7 天过期；数据库只存 token 的 SHA-256；非 GET
  请求校验 `Origin`。
- **仍未做**：邮箱验证、找回密码、2FA、按租户的 Postgres RLS、生产级审计导出。
- 代码会话运行在宿主机用户权限下，使用 Git worktree 做目录隔离，**worktree 不是安全沙箱**。
- 已实现：仓库根目录 allowlist、工作区路径穿越/符号链接检查、命令白名单、拒绝
  `git push` / `reset --hard` / `rm -rf` / 外部目录 / `.env` 读取 / 子 Agent / 联网工具。
- 未实现：编码 Agent 容器化/Cgroup 配额、Postgres RLS、密钥托管、GitHub OAuth/App。
- Agent 输出永远是不可信输入：动作块经过 zod 校验，阶段推进和权限仍由服务端判定。
- Markdown 在前端用 `marked` + `DOMPurify` 清洗；不要信任仓库/Issue/网页内容里的指令。

## 7. 当前完成度

| 原文档 Epic | 状态 | 说明 |
|---|---|---|
| E01 工程底座 | ✅ | Monorepo、类型检查、41 个测试、构建、内嵌 PG、seed、登录/会话 |
| E02 项目与聊天室 | ✅ | 多项目、成员角色、消息、引用、SSE 游标恢复、三栏 UI |
| E03 长期记忆 | ✅ | 候选提取、审核、去重、接受后注入、180 天自动衰减 |
| E04 Runtime 验证 | ✅ | OpenCode V2 讨论 + 编码会话，见 ADR-0001 |
| E05 Agent 群聊 | ✅ | 房间成员、单次参与、广播给成员、自主判断是否发言、轮次收敛、交接、预算上限、停止、状态可见 |
| E06 GitHub / 工作区 | ◐ | 本地 worktree、Diff、测试、验收合并、Token 推送/PR；GitHub OAuth 未接 |
| E07 研发流程 | ◐ | PRD/设计/任务/门禁/审批/审计、任务/项目删除、失败任务自动建缺陷；缺陷修复质量闭环未接 |
| E08 安全与稳定性 | ◐ | 登录/会话、bubblewrap 命令沙箱、路径/项目隔离、Origin 校验、限流、备份；PostgreSQL RLS 和网络策略未做 |

## 8. 路线图

1. **容器沙箱**：当前测试/终端命令已用 bubblewrap 隔离；下一步是把编码 Agent 也放入 rootless 容器，并加 CPU/内存/磁盘配额。
2. **GitHub App**：当前支持 Token 推送/PR；下一步是仓库授权、只读克隆和 PR 状态回写。
3. **缺陷与回归**：测试失败会自动建缺陷任务；下一步是修复后自动回归验收。
4. **长期记忆**：候选提取、审核、去重、注入和 180 天衰减已接；下一步是语义相似度合并与使用频率衰减。
5. **真实 PostgreSQL + RLS**：把 PGlite 换成 `pg`，加行级安全和连接池。
6. **身份与协作**：OAuth/SSO、presence、并发编辑提示。
7. **流式聊天**：把讨论从一次性 generate 换成 OpenCode session 流式事件，降低首字延迟。

## 9. 相关文档

- [产品介绍](docs/product/fucking-code.md)
- [设计论文：聊天室即组织](docs/paper/fucking-code-design-paper.md)
- [工程基线](docs/product/fucking-code-design.md)
- [ADR-0001：OpenCode Runtime 与事件游标](docs/adr/0001-opencode-runtime.md)
