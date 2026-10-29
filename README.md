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
- **自动开发与回馈**：项目进入 `coding` 后可以自动启动就绪任务；每个任务完成后自动触发 QA/Lead
  的群聊回馈。通过测试与规格核对后由团队内部评审自动合并，不再要求甲方处理分支和合并。
  长任务使用 30 分钟执行窗口；服务重启后
  会把没有 worker 的 `in_progress` 任务自动恢复为可调度状态。
- **决策弹窗只处理产品决策**：PRD、验收标准、技术方案、契约、计划、Diff、测试报告和规格核对
  全部由团队内部接受并记录；只有产品范围、优先级、取舍等甲方必须拍板的事项才弹窗。代码任务通过
  QA 核对后自动合并。
- **审批简化**：设计、契约、计划、备注、仓库分析、Diff、测试报告和规格核对自动接受；只有 PRD、
  验收标准和真正的产品决策留给甲方。
- **用户是甲方**：用户不是被无条件服从的指令源，而是群聊中的甲方/客户。团队会先澄清目标、
  场景、边界和验收；发现方案风险或不合理需求时会反驳，并给出替代方案。
- **真实模型驱动**：默认调用本机 OpenCode Server 的模型（已验证 `opencode-go/deepseek-v4.1-flash`）。
  也可以用 `AGENT_RUNTIME=mock` 离线跑完整流程。
- **实时工作进展**：左下角「团队进展」逐个显示成员当前在做什么、对应任务和已运行时间；讨论、开发、验证分别显示不同动作。
- **项目预览**：测试与安全通过、进入 `deployment` 后，点顶部「预览」启动隔离预览；DevOps 负责预览/部署/回滚。
- **聊天 → 结构化状态**：Agent 通过受控的 `devteam` JSON 动作块创建任务、产物、决策、审批、
  阶段请求和交接。服务端逐条校验，提示词不是权限边界。
- **六阶段敏捷图**：`requirements → design → coding → testing → deployment → operations`。
  AI 判断、服务端校验后内部推进；测试失败可回 `coding`，新需求可回 `requirements`，运维是持续态。
  阶段 Owner 负责内容，Lead 负责流程，Security 负责安全门禁。
- **版本化产物**：PRD、验收标准、技术方案、API 契约、测试报告、Diff 都有版本历史，可接受/退回。
- **自动准备代码仓库**：新建项目如果没有绑定仓库，会自动在 `PROJECT_REPO_ROOT` 下初始化一个
  带初始提交的空 Git 仓库；老项目点「继续自动开发」时也会自动补齐。用户不需要先理解 Git。
- **真实代码执行**：从任务创建隔离 Git worktree，启动 OpenCode 编码会话，让 Agent 改代码、
  跑测试，然后把 Diff 和测试报告作为产物归档；QA 核对通过后内部评审自动合并，任务进入 `done`。
- **任务与项目生命周期**：任务支持编辑、删除、取消运行和状态流转；删除任务会清理 worktree 和分支。
  项目所有者可以在项目设置里二次确认删除项目，删除前会清理全部代码工作区。
- **项目成员与权限**：项目设置里可以按邮箱添加成员，分配 Owner / Member / Viewer；
  Owner 管理成员和删除项目，Member 可编辑和跑任务，Viewer 只读。
- **内部评审与自动合并**：代码任务通过测试和规格核对后，由团队内部评审合并到默认分支并写入审计；
  甲方只对真正的产品决策做决定，技术产物不进入人工验收队列。
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

- Node.js 22.13+
- Git
- bubblewrap（`SANDBOX_MODE=bwrap` 时需要）
- OpenCode V2 CLI + 已登录账号（使用 `MODEL_GATEWAY=opencode` 时）
- Chromium/Chrome（workbench 浏览器走查需要，可选）

### 启动

本机：

```sh
./start.sh
```

新服务器一键安装：

```sh
./scripts/install-server.sh --url=https://dev.example.com
# 或先检查缺什么
./start.sh --doctor
```

它会安装系统依赖、Node、OpenCode、Chromium，创建 `.env`，同步 OpenCode 实际端口，初始化管理员账号并构建前端。无头服务器不需要在终端登录 OpenCode：启动后打开「管理后台 → OpenCode → 开始网页验证」，用手机/电脑输入验证码即可。完整步骤见 [服务器部署](docs/deploy/server.md)。

`start.sh` 会自动检查 Node 版本、首次安装依赖、从 `.env.example` 复制 `.env`、检测 OpenCode 服务与登录、构建前端并启动。打开 <http://127.0.0.1:8787>。需要热更新时用 `./start.sh --dev`，打开 <http://127.0.0.1:5174>。

服务器模式：

```sh
./start.sh --server --url=https://dev.example.com
```

会设置 `HOST=0.0.0.0`、`WEB_ORIGIN`、`PUBLIC_BASE_URL` 和 `COOKIE_SECURE`。

也可以手动启动：

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 <http://127.0.0.1:5174>。

首次启动会自动：

1. 在 `data/pg` 创建内嵌 PostgreSQL（PGlite）并建表；
2. 创建本地用户、示例项目 **Acme Notes**、主聊天室和默认团队；
3. 在 `data/repos/acme-notes` 创建一个带失败测试的小型 Git 仓库，作为代码任务的目标。

### 多模态聊天与文件

聊天输入框支持图片和文件：

- 点「附件」选择，或直接把截图粘贴到输入框；
- 单条消息最多 8 个附件，单张/单个最大 20 MB；
- 图片显示缩略图，PDF/文档/代码等显示文件卡片，可点击下载；
- 文件存在 `ATTACHMENTS_ROOT`（默认 `data/attachments`）；
- 上传 zip / tar / tar.gz / tgz / 7z / rar 会自动安全解压，解压后的文件也会一起交给模型；
- 解压限制：最多 300 个文件、单文件 20 MB、解压总量 60 MB；7z/rar 需要密码或多卷时会拒绝；
- 删除项目时会删除该项目附件目录。

模型侧：

```env
MULTIMODAL_MODEL_PROVIDER=opencode-go
MULTIMODAL_MODEL_ID=gemini-4-argon
```

准确地说，**OpenCode 本身支持在 session 里上传图片和文件**；限制只在于我们用于纯文本的无状态接口 `/api/experimental/generate` 只接收 `prompt` 和 `model`，没有 `files` 字段。因此带附件的回合改走 `/api/session/{id}/prompt` 的 `files`，创建一个**工具全部禁用的一次性 session**，拿到结果后立即删除；纯文本聊天仍然不创建 session。OpenCode 使用本地 `file://` URI 传递附件（`MULTIMODAL_FILE_URI=1`，默认），避免大文件 base64 膨胀。OpenAI-compatible 网关对图片发送 `image_url`，对文本类文件把内容拼进 prompt。压缩包会先解压，再把解压后的文件和原始压缩包一起交给 OpenCode `files`；二进制可执行文件不会被执行。

### Agent 工具与 workbench

聊天室里的成员默认是纯文本回合：他们没有 shell、浏览器，也不会直接改代码。需要真实执行时，让对应角色创建 **`mode=workbench`** 的任务：

- **QA**：浏览器走查、点击、截图、执行测试；
- **Security**：SCA/SAST、依赖扫描、渗透验证；
- **DevOps**：启动服务、健康检查、发布/回滚验证；
- **Frontend/Backend**：需要只读复现或读代码时也可以申请 workbench。

workbench 任务在隔离 Git worktree 中运行，拥有 shell、host 网络、文件读写和浏览器，并产出验证报告；它不要求改业务代码。聊天里的成员不能声称自己点过页面——必须由 workbench 工位执行并回贴证据。

workbench 默认也走内置执行器：

```env
WORKBENCH_EXECUTOR=builtin
WORKBENCH_MAX_STEPS=40
# WORKBENCH_AGENT_TIMEOUT_MS=1800000
```

内置 Agent 的动作包括：

- `run`：在 worktree 或 Docker 容器中执行测试/检查命令；
- `fetch`：请求预览地址或项目 HTTP 接口；
- `browser`：打开、快照、点击、填表、按键、截图、执行只读 JS；
- `write`：只允许写 `docs/` 和 `qa-evidence/` 下的证据文件；
- `done`：输出逐条结果、未覆盖项、复现步骤和剩余风险。

浏览器由 `playwright-core` 驱动本机 Chrome/Chromium，不再依赖 OpenCode 的 Playwright MCP：

```sh
./start.sh --install-browser   # 安装 Chromium
# 或指定系统浏览器
BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

没有浏览器时，workbench 仍可用 shell/HTTP 做接口级验证，但 UI 走查项必须标「未覆盖」。

### 模型网关与 OpenCode 解耦

聊天、注意力、规格核对、代码任务和 workbench 都已经通过 `MODEL_GATEWAY` 访问模型，不再创建 OpenCode session；OpenCode 只保留为推理网关。

```env
# 复用本机 OpenCode 套餐作为推理网关
MODEL_GATEWAY=opencode

# 或使用任意 OpenAI-compatible API
MODEL_GATEWAY=openai
MODEL_API_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=...
```

代码任务执行器：

```env
# builtin = 自研工具循环；opencode = 旧的 OpenCode session（回退用）
CODE_EXECUTOR=builtin
WORKBENCH_EXECUTOR=builtin
CODE_AGENT_MAX_STEPS=20
# CODE_AGENT_TIMEOUT_MS=1200000
```

已用临时项目验证：

- 代码任务：`npm test` 从失败到通过、规格核对通过、任务进入 review；
- workbench：HTTP 200、页面标题 `Workbench Home`、截图落盘 `docs/qa-evidence/`；
- 两次运行 OpenCode session 数量都保持 0 增长。

### Docker 命令隔离

代码任务里的 `npm test` / build / lint 等命令可以放进一次性容器执行，避免多项目共享宿主机环境：

```env
RUNNER_MODE=docker
PREVIEW_MODE=docker
# 默认按仓库内容选 node:22-bookworm-slim 或 python:3.12-slim
# RUNNER_IMAGE=node:22-bookworm-slim
RUNNER_MEMORY=1g
RUNNER_CPUS=2
RUNNER_PIDS_LIMIT=256
# 多实例同机时给每个实例唯一值，便于清理自己的孤儿容器
APP_INSTANCE_ID=fucking-code
```

隔离边界：

- 只挂载当前 worktree 到 `/workspace`，不挂宿主机根目录；
- 默认 `--network none`，需要联网的依赖安装在显式允许时走 `bridge`；
- `--memory` / `--cpus` / `--pids-limit` 限制资源；
- 超时会强制删除容器；
- 容器内使用宿主 uid/gid，避免生成 root 所有的文件；
- `git` 命令仍在宿主机执行，不进入容器。

使用前先拉取镜像，例如 `docker pull node:22-bookworm-slim`。Docker Hub 不可达时可用镜像站并设置 `RUNNER_IMAGE`。

预览也可以放进容器：

```env
PREVIEW_MODE=docker
# PREVIEW_IMAGE=node:22-bookworm-slim
PREVIEW_TTL_MS=1800000
```

预览容器只发布到 `127.0.0.1`，默认 30 分钟 TTL，退出或超时会自动删除；仍使用同一个 worktree 挂载和资源限制。应用重启时会按 `fucking-code.managed` + `APP_INSTANCE_ID` 清理上一次遗留的 runner/preview 容器。

需要数据库或外部服务的项目仍建议先用 `PREVIEW_MODE=host`。

新服务器可一键开启：

```bash
./scripts/install-server.sh --url=https://dev.example.com --docker --systemd
```

### 一键迁移包

代码页右上角的「导出迁移包」会下载一个 tar.gz：

- `repo.bundle`：`git bundle --all`，包含所有分支和标签；
- `manifest.json`：项目阶段、HEAD、bundle SHA-256、任务和产物索引；
- `artifacts.md`：当前版本的 PRD、验收标准、设计、测试报告等；
- `env.example` / `docker-compose.yml` / `Dockerfile`：仓库里已有的部署文件；
- `README.md`：恢复和校验步骤。

不会复制 `.env`、密钥、数据库或 worktree。恢复：

```bash
git clone repo.bundle app
cd app
git remote set-url origin <新仓库地址>
git push -u origin --all && git push --tags
```

对应 API：`GET /api/v1/projects/:projectId/export`。

### Git 仓库托管与自动推送

给项目设置 `repoUrl` 后：

- 内部评审合并完任务，主分支会自动推送到远程；
- 代码页「推送远程」可以手动补推；
- 推送状态和提交号记录在项目上，失败不会影响本地合并，但会显示错误。第一次点代码页「推送远程」时会提示输入 `repoUrl`，之后自动推送。

支持 HTTPS Token：

```env
# GitHub
GITHUB_TOKEN=github_pat_xxx
# GitLab / Gitee / 其他 HTTPS 远程
GIT_PUSH_TOKEN=
GIT_PUSH_USERNAME=oauth2
```

只读 clone 仍然可用。每个项目会自动维护一个只读 bare mirror，可直接 `git clone` 到别的机器：

代码页点「克隆地址」会生成一个只显示一次的只读 Token（默认 30 天），并给出可直接复制的命令：

```bash
git -c http.extraHeader="Authorization: Bearer <repo-token>" \
  clone http://<host>:8787/git/<projectId>.git app
```

也可以用登录会话的 Bearer token。Token 绑定单个项目，只能 clone/fetch。

- GET/POST 都走 Token 或会话鉴权；未登录返回 401，无项目权限返回 404。
- 只开放 upload-pack（clone/fetch）；`git-receive-pack` 返回 403。
- 推送仍走任务/评审/合并流程，不能绕过门禁直接改主分支。
- mirror 位于 `PROJECT_GIT_ROOT`（默认 `data/git`），每次请求前从项目仓库同步分支和标签。

### 生产部署（Caddy）

仓库提供单机生产模板：

```bash
cp .env.example .env
# 至少设置：
#   PUBLIC_BASE_URL=https://dev.example.com
#   APP_DOMAIN=dev.example.com
#   AUTH_MODE=session
#   COOKIE_SECURE=true
#   MODEL_GATEWAY=opencode
#   OPENCODE_URL=http://host.docker.internal:49374
docker compose -f docker-compose.prod.yml up -d --build
```

它包含：

- `app`：只在内网监听 8787，数据放在 `app-data` 持久卷的 `/data`；
- `caddy`：自动 HTTPS、反向代理、SSE 不缓冲、基础安全头；
- 健康检查、`restart: unless-stopped`、优雅停止；
- 默认 `RUNNER_MODE=host`，因为默认镜像只装 git/CA；要用 Docker runner，需要自定义镜像加 docker CLI/Chrome，并打开 compose 里的 socket 挂载和 `PROD_RUNNER_MODE=docker`。

容器内 workbench 浏览器也需要镜像里有 Chrome/Chromium，并设置 `BROWSER_EXECUTABLE_PATH`；没有浏览器时 UI 走查会明确标「未覆盖」。

数据备份：

```bash
tsx scripts/backup.ts
# 或直接备份 app-data 卷
```

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
npm test               # 单元测试（43 个）
npm run build          # 构建 Web
npm start              # 生产模式，API 同时托管 apps/web/dist
npm run user:password  # 设置 seed 账号密码，例如 npm run user:password -- 'new-pass'
./start.sh --install-browser  # 可选：安装 QA/Security/DevOps 的浏览器工具
npm run db:reset       # 清空本地数据库（下次启动重新 seed）
```

## 3. 怎么用（推荐路径）

1. 打开 **Acme Notes**，在聊天室说：
   > 我想做一个支持 Markdown、标签和全文搜索的笔记应用，先帮我理清需求和验收标准。
2. PM 会追问最多一轮，然后产出 **PRD** 和 **验收标准**。
3. 需求产物由团队内部接受；门禁满足后 AI/Lead 在内部推进到 `design`，不需要你做技术验收。
4. `@Architect 基于 PRD 出技术方案、接口契约和威胁模型`；Security 同步产出安全设计。
5. `@Lead 把方案拆成任务，前后端并行，QA 在接口稳定后介入`。Lead 会创建带负责人和验收标准的任务。
6. 在「开发任务」里对任意任务点 **开始工作**。系统会：
   - 从 `repoPath` 创建隔离 worktree 和 `devteam/...` 分支；
   - 启动 OpenCode 编码会话（带工具、限权）；
   - 运行项目测试；
   - 归档 **Diff** 和 **测试报告**；QA 规格核对通过后自动完成内部评审并合并。
7. 点任务上的 **查看变更** 可以审查 Diff，但合并由团队内部评审自动完成。
8. 测试阶段由 QA 跑测试与规格核对，Security 做安全测试/渗透；失败可回 `coding`。
9. 部署阶段由 DevOps 启动预览、发布和健康检查；上线后进入持续 `operations`，新需求可回到 `requirements`。

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
  → 直到无人发言 / 检测到重复回合 / 用户停止
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

进入 `coding` 后，如果项目设置里开启「自动启动任务」，系统会自动挑选依赖已满足的 `ready` 任务；
每完成一个任务，会自动发起一次 QA/Lead 群聊回馈，再继续下一个。

```text
POST /tasks/:id/work
  → git worktree add -b devteam/<task>-<suffix>
  → POST /api/session（location = worktree，带 deny 规则）
  → POST /api/session/:id/prompt
  → 轮询 session outcome
  → GET session messages 取最终总结
  → 在 worktree 执行测试（命令白名单）
  → git add -A && git diff --cached <workspace.baseCommit>
  → 归档 diff / test_report 产物 + test_runs + 任务证据
```

## 5. 数据与状态

- **权威存储**：PGlite（PostgreSQL 语义）保存项目、聊天、任务、产物、决策、审批、运行、事件、审计。
- **事件游标**：`events.seq`（BIGSERIAL）是唯一游标。OpenCode 的事件流是 live-only，不能作为恢复游标。
- **任务状态**：`proposed → ready → in_progress → review/testing → done`，非法跃迁返回 409。
- **阶段门禁**：
  - 阶段由 AI 判断、服务端校验门禁后内部推进；允许前进、回退和迭代循环，非法跳阶段返回 409
  - requirements：PRD、验收标准、安全要求已接受
  - design：技术方案、计划、任务、威胁模型已接受
  - coding：所有编码任务完成 + SCA/SAST/代码审计完成
  - testing：测试报告、规格核对、安全测试完成
  - deployment：发布安全检查通过
  - operations：持续服务态，无退出终点
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
| E01 工程底座 | ✅ | Monorepo、类型检查、43 个测试、构建、内嵌 PG、seed、登录/会话 |
| E02 项目与聊天室 | ✅ | 多项目、成员角色、消息、引用、SSE 游标恢复、三栏 UI |
| E03 长期记忆 | ✅ | 候选提取、审核、去重、接受后注入、180 天自动衰减 |
| E04 Runtime 验证 | ✅ | OpenCode V2 讨论 + 编码会话，见 ADR-0001 |
| E05 Agent 群聊 | ✅ | 房间成员、单次参与、广播给成员、自主判断是否发言、自然收敛、去重防循环、交接、停止、状态可见 |
| E06 GitHub / 工作区 | ◐ | 本地 worktree、Diff、测试、内部评审自动合并、Token 推送/PR；GitHub OAuth 未接 |
| E07 研发流程 | ◐ | PRD/设计/任务/门禁/审批/审计、任务/项目删除、失败任务自动建缺陷；缺陷修复质量闭环未接 |
| E08 安全与稳定性 | ◐ | 登录/会话、bubblewrap 命令沙箱、路径/项目隔离、Origin 校验、限流、备份；PostgreSQL RLS 和网络策略未做 |

## 8. 路线图

1. **容器沙箱**：测试/终端命令已可放进短生命周期 Docker 容器，预览也已支持容器 TTL；下一步是把编码 Agent 主进程也放入 rootless 容器。
2. **GitHub App**：当前支持 Token 推送/PR；下一步是仓库授权、只读克隆和 PR 状态回写。
3. **缺陷与回归**：测试失败会自动建缺陷任务；下一步是修复后自动回归验收。
4. **长期记忆**：候选提取、审核、去重、注入和 180 天衰减已接；下一步是语义相似度合并与使用频率衰减。
5. **真实 PostgreSQL + RLS**：把 PGlite 换成 `pg`，加行级安全和连接池。
6. **身份与协作**：OAuth/SSO、presence、并发编辑提示。
7. **流式聊天**：把讨论从一次性网关调用换成流式输出，降低首字延迟。

## 9. 相关文档

- [产品介绍](docs/product/fucking-code.md)
- [服务器部署与 OpenCode 登录迁移](docs/deploy/server.md)
- [设计论文：聊天室即组织](docs/paper/fucking-code-design-paper.md)
- [工程基线](docs/product/fucking-code-design.md)
- [ADR-0001：OpenCode Runtime 与事件游标](docs/adr/0001-opencode-runtime.md)
