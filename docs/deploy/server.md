# 服务器部署检查与步骤

这份文档对应 `./scripts/install-server.sh`、`./start.sh --server` 和 `./start.sh --doctor`。

## 1. 一台新服务器缺什么

默认 `start.sh` 只检查 Node.js、npm、git；它不会替你安装 OpenCode、登录订阅、安装 Chromium，也不会自动修正 OpenCode 端口。新服务器至少要准备：

| 依赖 | 用途 | 检查方式 |
| --- | --- | --- |
| Node.js 22.13+ | API + 内置 Agent | `node -v` |
| git | worktree / bundle / 托管镜像 | `git --version` |
| bubblewrap | `SANDBOX_MODE=bwrap` 的命令沙箱 | `bwrap --version` |
| OpenCode CLI | 模型网关（复用订阅时） | `opencode --version` |
| OpenCode 登录 | 模型调用 | `opencode auth list` |
| Chromium/Chrome | workbench 浏览器走查 | `./start.sh --install-browser` |
| Docker（可选） | `RUNNER_MODE=docker` | `docker info` |

端口和配置还需要：

- `HOST=0.0.0.0`（直接对外）或 `127.0.0.1`（Caddy/反向代理在同一台机器）；
- `AUTH_MODE=session` + 管理员密码（公网不要用 `dev`）；
- `PUBLIC_BASE_URL` / `WEB_ORIGIN`；
- HTTPS 时 `COOKIE_SECURE=true`；
- OpenCode 的实际服务地址（不要硬编码旧服务器的 49374）。

## 2. 一键安装

在仓库根目录执行：

```bash
./scripts/install-server.sh --url=https://dev.example.com
```

它会：

1. 安装 `curl git build-essential bubblewrap openssl`；
2. Node.js 低于 22.13 时用 NodeSource 安装 Node 22；
3. 安装 OpenCode CLI；
4. `npm ci`；
5. 创建/修正 `.env`：`HOST=0.0.0.0`、`AUTH_MODE=session`、`WEB_ORIGIN`、`PUBLIC_BASE_URL`、`COOKIE_SECURE`、随机 `SIGNUP_INVITE_CODE`；
6. 检查 OpenCode 登录；没有登录时进入 `opencode auth login`；
7. `opencode service start`，读取真实端口并写入 `OPENCODE_URL`；
8. 构建前端；
9. 初始化管理员账号并打印一次密码；
10. 安装 Chromium（可用 `--no-browser` 跳过）。

安装 systemd：

```bash
./scripts/install-server.sh --url=https://dev.example.com --systemd
```

会生成：

- `fucking-code.service`：应用本体；
- `opencode-start.service`：开机执行 `opencode service start`。

查看状态：

```bash
systemctl status fucking-code.service
systemctl status opencode-start.service
journalctl -u fucking-code.service -f
```

## 3. OpenCode 登录兼容

OpenCode 的订阅凭据存在 `~/.local/share/opencode`（数据库内），不是公开 API key。新服务器有三种方式。

### A. 网页验证（推荐，无头服务器）

安装完成后直接启动应用，用管理员账号登录，打开：

```text
管理后台 → OpenCode → 开始网页验证
```

页面会显示验证码和 `https://opencode.ai/console/device?...` 地址。用手机或电脑打开地址、输入验证码即可。服务器不需要浏览器，也不会卡在 CLI TUI。

登录成功后应用会自动重启 OpenCode 网关，返回聊天页即可使用。对应 API：

```text
POST /api/v1/admin/opencode/auth/start
GET  /api/v1/admin/opencode/auth
POST /api/v1/admin/opencode/auth/cancel
```

### B. 从旧服务器导出/导入

旧服务器：

```bash
./scripts/opencode-auth.sh export /tmp/opencode-auth.json
scp /tmp/opencode-auth.json user@new-host:/tmp/
```

新服务器：

```bash
./scripts/opencode-auth.sh import /tmp/opencode-auth.json
rm /tmp/opencode-auth.json
```

如果服务器有浏览器/终端，也可以直接 CLI 登录：

```bash
opencode auth login
opencode auth list
```

注意：导出文件是**明文凭据**，必须用 `scp/ssh` 传输、`chmod 600`，不要提交、不要放迁移包。安装脚本也支持：

```bash
./scripts/install-server.sh --opencode-auth=/tmp/opencode-auth.json
```

需要项目测试/部署/运维在 Docker 中隔离，加 `--docker`：

```bash
./scripts/install-server.sh --url=https://dev.example.com --docker --systemd
```

它会安装 Docker、把部署用户加入 `docker` 组、拉取 runner 镜像，并设置：

```env
RUNNER_MODE=docker
PREVIEW_MODE=docker
RUNNER_IMAGE=node:22-bookworm-slim
APP_INSTANCE_ID=fucking-code
```

没有 systemd 时，重新登录一次让 `docker` 组生效，再运行 `./start.sh --server`。

### C. 不用 OpenCode 订阅，改用 OpenAI-compatible API

```env
MODEL_GATEWAY=openai
MODEL_API_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=sk-...
```

这种方式不需要 `opencode` 登录，`AGENT_MODEL_PROVIDER/ID` 要改成对应端点支持的模型名。

> 无论哪种方式，应用都只把 OpenCode 当推理网关；默认代码任务和 workbench 不再创建 OpenCode session。

## 4. 手动启动

```bash
cp .env.example .env
# 编辑 .env：HOST、AUTH_MODE、PUBLIC_BASE_URL、WEB_ORIGIN、COOKIE_SECURE
npx tsx scripts/init-admin.ts
./start.sh --doctor
./start.sh --server --url=https://dev.example.com
```

`start.sh` 会自动：

- 从 `opencode service status` 更新 `OPENCODE_URL`；
- 检查 OpenCode 登录；
- 运行 `scripts/preflight.ts`；
- 缺少前端构建时执行 `npm run build`。

管理员账号：

```text
email: dev@local.test
password: init-admin 打印的随机密码
```

也可以用 `npx tsx scripts/init-admin.ts '你的密码'` 指定。

## 5. 环境变量要点

```env
HOST=0.0.0.0
PORT=8787
AUTH_MODE=session
PUBLIC_BASE_URL=https://dev.example.com
WEB_ORIGIN=https://dev.example.com
COOKIE_SECURE=true

SANDBOX_MODE=bwrap
# 没有 bubblewrap 时改成 process

MODEL_GATEWAY=opencode
# 留空让 start.sh 自动写真实地址
# OPENCODE_URL=http://127.0.0.1:49374

RUNNER_MODE=host
PREVIEW_MODE=host
# 需要容器隔离时改成 docker，并确认镜像已存在；安装脚本 --docker 会自动设置
APP_INSTANCE_ID=fucking-code

BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome

# 自动把合并后的主分支推送到项目 repoUrl
# GitHub:
GITHUB_TOKEN=
# GitLab/Gitee/其他 HTTPS 远程:
GIT_PUSH_TOKEN=
GIT_PUSH_USERNAME=oauth2
```

`OPENCODE_URL`、`OPENCODE_PASSWORD` 不要从旧服务器照抄。URL 由 `opencode service status` 决定；密码由 `~/.config/opencode/service.json` 生成。

## 6. 启动后验证

```bash
curl -fsS http://127.0.0.1:8787/api/v1/auth/config
```

应返回 `authMode: "session"` 和 `demoMode: false`。

登录后建议：

1. 新建一个临时项目；
2. 在聊天里发一条简单需求；
3. 观察运行活动里是否出现模型调用；
4. 创建一个 `mode=workbench` 任务，确认浏览器动作可用；
5. 代码页点「导出迁移包」，确认能下载。

## 7. 数据迁移

应用数据：

- `data/pg`：PGlite 数据库；
- `data/repos`：项目仓库；
- `data/git`：只读 clone 镜像；
- `data/worktrees`：工作区（可重建，不必迁）。

备份：

```bash
npm run backup
```

恢复：

```bash
npm run restore
```

整个目录迁移时停服务后复制：

```bash
systemctl stop fucking-code.service
rsync -a data/ new-host:/opt/fucking-code/data/
systemctl start fucking-code.service
```

迁移后重新执行 `./start.sh --doctor`。

## 8. 常见错误

### `OpenCode 登录 — 未登录`

```bash
opencode auth login
# 或
./scripts/opencode-auth.sh import /tmp/opencode-auth.json
```

### `OpenCode 服务 — 未运行`

```bash
opencode service start
opencode service status
```

如果端口不是旧值，`start.sh` 会写入新的 `OPENCODE_URL`。

### `OpenCode gateway failed (401)`

- `OPENCODE_URL` 指向了旧端口或另一个实例；
- 当前用户不是启动 OpenCode 的用户（`HOME` 不一致，读不到 `service.json`）；
- 重新登录后没有重启 OpenCode 服务。

### `bwrap: command not found`

```bash
sudo apt-get install -y bubblewrap
# 或 SANDBOX_MODE=process
```

### `no browser found`

```bash
./scripts/install-agent-browser.sh
# 或 BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

### 端口被占用

```bash
ss -ltnp | grep 8787
```

### Docker runner 不可用

```bash
docker info
docker pull node:22-bookworm-slim
# 或 RUNNER_MODE=host
```

## 9. Docker / Caddy

```bash
cp .env.example .env
# 设置 PUBLIC_BASE_URL、APP_DOMAIN、AUTH_MODE=session、COOKIE_SECURE=true
docker compose -f docker-compose.prod.yml up -d --build
```

默认镜像是 host runner；要做容器化 runner，需要自定义镜像安装 docker CLI/Chrome，并打开 compose 里的 socket 挂载和 `PROD_RUNNER_MODE=docker`。宿主机直接部署时用 `install-server.sh --docker` 更简单，它会安装 Docker、加入 docker 组、拉取镜像并设置 `RUNNER_MODE=docker` / `PREVIEW_MODE=docker`。

容器内 workbench 浏览器还要求镜像里有 Chrome/Chromium，并设置 `BROWSER_EXECUTABLE_PATH`；没有浏览器时验证报告会把 UI 项标为「未覆盖」。
