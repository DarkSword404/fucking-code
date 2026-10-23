# Fucking Code

## 完整项目设计与工程实施文档

-   文档版本：v1.0
-   状态：研发基线 / 可拆分为开发任务
-   产品形态：首版 B/S，架构按 C/S 分层
-   核心定位：面向 Vibe Coding 的多 Agent 软件研发团队工作台
-   主要用户：个人开发者、小型研发团队、使用 AI 编程工具的产品与工程人员

------------------------------------------------------------------------

# 0. 文档使用说明

本文档是产品、架构、前后端、Agent、测试、DevOps
和安全团队的共同工程基线。它不是单纯的产品介绍，也不是要求一次性实现所有功能的瀑布式合同。

实施原则：

1.  **先验证关键技术风险，再并行建设业务能力。**
2.  **先模块化单体，再根据真实负载拆服务。**
3.  **服务端是项目状态、Agent 执行、代码工作区和长期记忆的权威来源。**
4.  **所有项目数据必须具备项目范围隔离；不能依赖提示词保证权限。**
5.  **Agent 的讨论、任务、产物、代码变更、测试证据必须形成可追溯闭环。**
6.  **OpenCode 是优先验证的编码 Runtime 和 UI
    基线，不是本系统的业务数据库或工作流引擎。**
7.  **布局和交互优先沿用 OpenCode
    的界面语言；复用前必须核查具体目录、依赖和许可证。**
8.  **涉及主分支合并、生产发布、删除数据、访问凭证和网络操作时，采用最小权限与显式审批。**

建议将本文拆成 `docs/` 中的架构、产品、API、数据模型、Agent
协议、安全、测试和部署文档；各文档以本文的实体、状态和权限定义为基准。遇到冲突时，以经过评审并版本化的
ADR（架构决策记录）为准。

# 1. 产品概述

## 1.1 产品定位

Fucking Code 是一款在现有 Vibe Coding / 编程 Agent
之上构建的多 Agent
协作研发工作台。它让产品经理、架构师、前端开发、后端开发、QA、安全和
DevOps
等角色在同一个项目空间中协同工作，覆盖需求澄清、方案评审、任务拆解、代码开发、集成测试、缺陷修复、回归验证和交付。

它不是单纯的代码生成器，也不是只由一个主 Agent 在后台调用多个子 Agent
的任务编排器。其核心体验是：**用户与多个专业 Agent
在共享聊天室中共同工作，同时由流程引擎把讨论转化为可执行任务和可验收交付物。**

## 1.2 目标与非目标

### 目标

-   多个 Agent
    可以在同一个项目聊天室直接交流、回复、引用、提出异议、评审和交接。
-   将聊天中的决定转化为需求、技术决策、接口契约、任务、验收标准和可追踪产物。
-   支持新项目，也支持导入 GitHub 现有仓库后进行增量开发。
-   服务端执行 Agent、代码读写、构建和测试；Windows
    浏览器端不要求安装开发工具链。
-   每个项目有独立聊天室、独立记忆、独立任务、独立工作区和独立事件流。
-   用户可以并行推进多个项目，项目状态、Agent 会话、文件和记忆不得串线。
-   对代码修改、工具调用、审批、测试结果和 PR 建立审计轨迹。
-   通过适配器解耦协作平台与编码 Runtime，未来可增加 CLI/Desktop
    客户端或替换 Runtime。

### 非目标（P0 不做）

-   不训练基础模型，不自建通用大模型推理框架。
-   不在首版实现复杂微服务、跨区域分布式调度。
-   不允许 Agent 默认直接合并主分支或部署生产。
-   不把模型内部思维链作为业务数据持久化；只记录可审计的结论、证据、工具调用和运行元数据。
-   不要求首版同时支持 GitHub、GitLab、Gitee；先抽象 Provider，P0 优先
    GitHub。
-   不保证所有 Agent
    对话都自动成为长期记忆；记忆需经过提取、校验和状态管理。
-   不将右侧浏览器面板等同于可任意访问互联网的浏览器；运行网络访问必须受执行环境策略约束。

## 1.3 核心价值

1.  **团队协作**：多个角色共用一个聊天室，不再只有主 Agent
    汇总子任务结果。
2.  **流程闭环**：需求、决策、任务、代码、测试和交付相互关联。
3.  **项目连续性**：长期记忆有来源、有状态、有版本，跨会话可恢复。
4.  **增量开发**：理解既有仓库、在基准 Commit 上隔离修改、生成可审查
    Diff 和 PR。
5.  **可控执行**：服务端权限检查、受限工作区、审批、日志、取消和恢复。
6.  **工作台效率**：保留 OpenCode
    风格，项目导航和工具面板可收缩，中央工作区优先。

# 2. 用户与核心使用场景

## 2.1 用户角色

-   项目负责人 / 开发者：提出需求、确认方案、查看进度、审核代码与交付。
-   产品经理 Agent：澄清需求、维护 PRD、验收标准和范围。
-   架构师 Agent：识别系统边界、提出技术方案、评审关键设计。
-   前端 Agent：实现 UI、状态流和前端测试。
-   后端 Agent：实现 API、数据模型、业务逻辑和服务端测试。
-   QA Agent：设计测试、执行验证、建缺陷并推动回归。
-   安全审查
    Agent（后续或高风险任务启用）：审查权限、输入处理、秘密泄露和依赖风险。
-   DevOps Agent（后续）：构建、部署配置、可观测性与发布准备。

Agent 角色是能力与权限配置，不是硬编码在代码中的固定流程节点。

## 2.2 典型场景

### 场景 A：从零开发

用户提出需求 → PM 澄清 → 生成 PRD 与验收标准 → 架构师提出方案 →
用户确认关键决策 → Lead 拆任务 DAG → 前后端并行开发 → 集成构建 → QA 测试
→ 缺陷修复与回归 → 用户验收 → 创建 PR / 交付。

### 场景 B：现有 GitHub 项目增量开发

用户授权仓库 → 服务端只读克隆并分析 → 生成项目理解报告 → 用户描述变更 →
Agent 关联既有代码和规范 → 以指定 Commit 为基准创建分支 / Worktree →
实现与测试 → 审查 Diff → 创建 PR。

### 场景 C：多个项目并行

用户在项目 A 运行前端和 QA Agent，同时在项目 B 进行需求讨论。项目 A
的记忆、事件、文件、Runtime 会话和工具授权不能出现在项目 B 的上下文或 UI
中。

### 场景 D：用户在 Agent 执行中介入

用户发现需求偏差，修改验收标准或暂停任务。系统记录变更版本，标记依赖旧需求的任务为
`needs_replan` 或 `stale`，不允许旧任务无提示地继续提交代码。

# 3. 产品信息架构与前端交互

## 3.1 总体布局

桌面端采用三栏工作台：

-   **左侧：项目与导航面板**，可收缩、展开、拖动宽度。
-   **中央：主工作区**，承载团队聊天室、需求/设计文档、Diff、任务看板、测试报告等。
-   **右侧：上下文与开发工具面板**，可收缩、展开、拖动宽度，支持文件目录、文件内容、浏览器、预览、任务详情和变更详情。
-   **顶部/底部状态区域**：项目上下文、Agent
    运行状态、待审批事项、执行控制、可按需展开的终端/日志。

设计原则：延续 OpenCode
的紧凑、深色优先、高信息密度、键盘友好和会话式体验；中央区域优先；辅助面板不应永久挤占主区域。

## 3.2 左侧面板

左侧逻辑上分为：

1.  项目切换器：项目列表、新建项目、导入仓库。
2.  当前项目导航：团队聊天室、需求与设计、开发任务、代码变更、测试报告、项目记忆、项目设置。

行为要求：

-   收缩后保留图标与展开入口；悬停显示标签和快捷键提示。
-   支持拖动调整宽度，并设置最小/最大宽度。
-   切换项目时切换项目上下文，但不能把项目 A
    的文件、任务或消息短暂残留在项目 B 页面。
-   项目级 UI 偏好可独立保存；个人级偏好如主题和全局快捷键可按用户保存。
-   项目切换不等于 Runtime
    会话切换；服务端需明确当前项目和当前运行任务。

## 3.3 中央主工作区

首版视图：

-   团队聊天室
-   需求与设计产物
-   任务看板 / DAG
-   代码 Diff / 变更审查
-   测试报告与缺陷
-   项目理解报告

中央视图之间切换时应保留合理的导航状态，并显示当前项目与相关任务。重要产物支持打开、编辑、版本比较、确认、退回和查看来源。

### 团队聊天室

消息类型至少包括：

`discussion`, `question`, `proposal`, `review_request`, `decision`,
`task_handoff`, `artifact`, `blocker`, `system_event`

每条消息显示发送角色、时间、消息类型、关联任务/产物、引用来源和运行状态（如适用）。支持：

-   用户直接发言、@角色、回复、引用消息。
-   Agent 直接向其他 Agent 发言，不必所有通信都经过用户或主 Agent。
-   将消息转成决策、任务、缺陷或产物。
-   对关键结论标记待确认、已接受、已拒绝或已被新决策替代。
-   显示 Agent 正在执行、等待输入、等待审批、已完成、失败或取消。
-   用户可暂停、取消或调整当前流程。

聊天内容不是权威状态的唯一来源。关键决策、审批、任务状态必须写入结构化数据。

## 3.4 右侧工具面板

右侧面板统一承载：

-   文件目录
-   文件内容
-   浏览器
-   预览
-   任务详情
-   变更详情
-   Agent 运行详情（可选）

行为要求：

-   整体可收缩、展开、拖动宽度。
-   文件树与文件内容可按宽度采用单栏或分栏。
-   打开文件时可自动展开右侧面板并定位文件；如果文件在中央 Diff
    视图中打开，则需明确当前打开位置。
-   打开浏览器时切换工具标签，不丢失原有文件树/文件标签状态。
-   浏览器预览通过受控开发环境和端口代理访问，不默认获得宿主机或任意内网访问权限。
-   收缩面板后保留后台 Agent 状态、待审批和错误通知的可见入口。
-   不同项目的文件标签、浏览器会话和预览 URL 必须隔离。

## 3.5 布局模式

-   **专注模式**：收缩左右面板，最大化聊天室或代码视图。
-   **标准模式**：左侧导航 + 中央主工作区 + 右侧工具面板。
-   **开发模式**：中央偏向代码/Diff，右侧展示浏览器、预览或文件内容。

首版可通过预设布局实现，不必开发复杂的自由布局引擎。

## 3.6 布局状态

建议数据键：`user_id + project_id + layout_version`。存储：

-   左侧是否收缩、宽度
-   右侧是否收缩、宽度
-   当前中央视图
-   右侧当前工具标签
-   文件标签和选中项（需校验文件属于当前项目工作区）
-   当前布局模式

布局偏好可存于服务端用户偏好或客户端本地设置，但任何业务权限不能依赖布局状态。项目切换时，必须清空旧项目的临时文件、任务和浏览器状态后再装载新项目状态。

## 3.7 响应式与无障碍

-   桌面端为首要体验；窄屏下侧栏变为覆盖式抽屉。
-   键盘操作：切换面板、切换工作视图、搜索文件、聚焦输入框、停止当前运行等。
-   可聚焦控件需有清晰焦点状态；图标按钮有可访问名称。
-   面板尺寸变化不能遮挡重要错误、审批和运行状态。

## 3.8 OpenCode UI 复用策略

-   以固定版本的 OpenCode 作为 UI 参考和优先复用基线。
-   重点评估 `packages/app`, `packages/ui`, `packages/session-ui`
    等实际目录与依赖。
-   复用主题、组件、弹窗、Markdown、Diff、图标、键盘交互和布局语言。
-   新增 Fucking Code 的聊天室、Agent 状态、任务
    DAG、决策、记忆、审批和测试报告。
-   避免把整个应用深度复制后长期维护一份无法跟进上游的分支。
-   记录复用文件、修改文件、上游版本、许可证和本地补丁。
-   发布前逐项核查代码目录、第三方依赖和资产的许可证与版权声明；不能仅根据仓库根许可证推断所有依赖均可任意使用。
-   具体复用方式（依赖包、子模块、fork 或组件迁移）在技术验证后通过 ADR
    决定。

# 4. 总体架构

## 4.1 架构原则

-   首版 B/S，架构从第一天按 C/S 分层。
-   Web、未来 CLI/Desktop 都是 API
    客户端；调度、记忆、权限和工作区管理集中在服务端。
-   模块化单体 + 后台 Worker，不从微服务开始。
-   PostgreSQL 为权威业务存储；SSE 负责推送，不代替持久化事件。
-   Runtime Adapter 隔离 OpenCode 等编码 Runtime 的具体协议。
-   所有跨项目数据访问都必须经过服务端授权。
-   执行环境与 API 服务隔离；Agent 不能直接获得服务端宿主机权限。

## 4.2 逻辑架构

``` mermaid
flowchart TB
  U[Web Client / Future CLI / Desktop] --> API[API Gateway + Auth]
  API --> PS[Project Service]
  API --> CHAT[Team Chat Service]
  API --> MEM[Project Memory Service]
  API --> WF[Workflow and Task Service]
  API --> REPO[Repository Service]
  API --> AUDIT[Audit and Approval Service]
  PS --> PG[(PostgreSQL)]
  CHAT --> PG
  MEM --> PG
  WF --> PG
  REPO --> PG
  AUDIT --> PG
  API --> EVT[Persisted Event Publisher]
  EVT --> SSE[SSE Event Stream]
  WF --> Q[Durable Job Queue]
  Q --> W[Background Worker]
  W --> SCH[Agent Scheduler]
  SCH --> ADAPTER[Runtime Adapter]
  ADAPTER --> RT[OpenCode Server / Other Runtime]
  W --> WS[Workspace Manager]
  WS --> WT[Git Worktree]
  WT --> SANDBOX[Isolated Build/Test Sandbox]
  SANDBOX --> ART[Artifacts / Test Reports]
  ART --> PG
```

## 4.3 服务模块职责

### API / Auth

-   身份认证、会话、授权和速率限制。
-   解析当前用户和租户上下文。
-   所有读写 API 执行项目级授权。
-   生成可审计的操作主体与请求 ID。

### Project Service

-   创建/更新项目、项目成员、项目状态和配置。
-   管理项目与聊天室、仓库、工作区的关系。
-   项目切换所需的安全上下文。

### Team Chat Service

-   消息写入、回复、引用、消息类型和附件元数据。
-   生成持久化事件并提供游标恢复。
-   不负责决定所有 Agent 应如何执行；路由交由 Scheduler/Workflow。

### Project Memory Service

-   候选记忆提取、审核、版本管理、冲突处理、检索和注入记录。
-   严格按租户、项目和状态过滤后再进行语义检索。
-   记忆来源可追溯至消息、产物、任务或测试证据。

### Workflow & Task Service

-   管理工作流、任务 DAG、依赖、审批、重试、取消、缺陷和回归。
-   维护状态机并防止非法状态跃迁。
-   对需求变更进行影响分析，标记旧任务失效或需要重新规划。

### Agent Scheduler

-   按角色、任务、权限、模型策略和预算选择 Agent。
-   按需路由消息，防止所有 Agent 对每条消息都回复。
-   控制并发、轮次、超时、Token/成本预算、退出条件和重试。
-   持久化运行状态，支持 Worker 重启后恢复。

### Repository Service

-   GitHub 授权、仓库元数据、克隆、分支、Worktree、Commit、Diff 和 PR。
-   记录基准 Commit SHA。
-   使用 RepositoryProvider 接口，未来可扩展 GitLab/Gitee。
-   不把仓库中的指令、Issue 或代码注释当成系统级可信指令。

### Runtime Adapter

-   统一启动运行、发送输入、接收事件、停止运行、查询状态。
-   转换具体 Runtime 的会话、工具事件和错误格式。
-   不持有业务工作流的最终状态。

### Workspace / Sandbox Manager

-   分配项目工作区、Git Worktree 和受限容器。
-   限制 CPU、内存、磁盘、执行时间、网络和挂载目录。
-   捕获命令、退出码、日志、修改文件和测试结果。
-   不向任务默认注入宿主机秘密或任意 SSH 凭证。

## 4.4 技术选型基线

这是建议候选，不是不可变合同。先做兼容性和部署验证，随后以 ADR 固化。

  ----------------------------------------------------------------------------------------------
  层                      候选方案                       选择理由 / 注意事项
  ----------------------- ------------------------------ ---------------------------------------
  前端                    SolidJS + TypeScript           与 OpenCode UI
                                                         技术方向接近，利于复用组件

  样式                    Tailwind CSS /                 保持视觉一致，核对上游版本与构建方式
                          复用上游样式体系               

  API                     TypeScript +                   轻量 API；验证 Bun/Node 兼容性后决定
                          Hono（或团队熟悉的等价框架）   

  运行时                  Node.js 或                     不允许开发/CI/生产使用不一致的运行时
                          Bun，首版固定一个受支持版本    

  数据库                  PostgreSQL                     事务、关系数据、JSONB、审计和任务状态

  ORM / Schema            Drizzle 或同等工具             类型化 Schema 与迁移

  实时事件                SSE                            首版足够支持单向实时事件和游标恢复

  队列                    PostgreSQL 持久化 Job          避免首版过度依赖组件；确保重试与幂等
                          表起步；需要时再加 Redis       

  Runtime                 OpenCode Server + 官方         编码执行适配候选
                          SDK/API（先验证）              

  代码隔离                Git Worktree +                 Worktree 不等于安全沙箱
                          容器/受控执行环境              

  部署                    Docker Compose 起步            本地开发和单机部署一致

  文件/报告               本地持久卷起步，后续对象存储   统一 Artifact 接口
  ----------------------------------------------------------------------------------------------

## 4.5 部署拓扑

首版单机部署可包含：

-   `web`：静态资源或 Web 前端服务
-   `api`：业务 API
-   `worker`：任务与 Agent 调度
-   `postgres`：业务数据库
-   `opencode`：Runtime Server，可单独进程/容器运行
-   `sandbox`：按任务创建的隔离执行环境
-   可选 `redis`：队列、锁或短期缓存

生产部署必须使用持久卷保存
PostgreSQL、必要的工作区和产物；数据库备份与恢复需可验证。不要把唯一数据放在容器临时文件系统。

# 5. 项目、聊天室和数据隔离

## 5.1 核心规则

-   一个用户可拥有多个项目。
-   一个项目默认创建一个主聊天室；数据模型允许未来增加需求讨论室、故障室、实验室。
-   一个项目有独立长期记忆、任务、工作区、Agent 运行和事件流。
-   首版可限制一个主仓库，但模型应允许未来多仓库。
-   所有业务实体必须有 `tenant_id`（或组织隔离等价物）和/或 `project_id`
    范围。
-   API、数据库查询、检索、SSE、上下文组装和文件代理都必须执行项目权限检查。

## 5.2 隔离不变量

1.  项目 A 的 Agent 不能读取项目 B
    的消息、记忆、文件、任务、运行日志或浏览器状态。
2.  语义检索必须先过滤
    `tenant_id`、`project_id`、记忆状态和可见性，再做相似度排序。
3.  Runtime 会话不能仅凭客户端传来的 `runtime_session_id`
    访问；必须通过服务端 AgentRun 记录验证项目归属。
4.  SSE 订阅建立时授权一次，并在每个重连/游标恢复请求中再次授权。
5.  Worktree 路径由服务端分配，不允许客户端自由提交任意文件系统路径。
6.  文件打开、下载、Diff、报告访问均需验证其关联的项目和工作区。
7.  项目切换时前端清除不属于新项目的临时数据，后端不能依赖前端清理来保证安全。

## 5.3 长期记忆分类

-   `project_fact`：技术栈、代码规范、已确认接口、目录约定。
-   `decision`：决策内容、备选方案、原因、决策人和时间。
-   `experience`：测试经验、故障原因、修复经验。
-   `session_summary`：阶段性讨论摘要、未解决问题和后续行动。
-   可选
    `repository_map`：项目结构、入口、关键模块、测试命令等分析产物。

原始聊天和执行日志应保留，但不能全部自动提升为长期记忆。

## 5.4 记忆写入流程

1.  从消息、决策、任务、PR、测试结果中提取候选。
2.  校验来源、置信度、重复、冲突和敏感信息。
3.  依据类型决定自动接受或等待用户/负责人确认。
4.  记忆状态为 `proposed`、`accepted`、`rejected`、`superseded`。
5.  修改重要事实时创建新版本，不直接覆盖历史；记录替代关系。
6.  每次 Agent Run 记录注入的 memory IDs 和版本。
7.  记忆可被查看、纠正、撤销和审计。

## 5.5 上下文组装顺序

每次 Agent 执行前，按优先级组装：

1.  系统规则、角色权限与执行限制（由服务端控制）。
2.  当前任务、验收标准、依赖状态和截止/预算限制。
3.  项目已确认事实和当前有效决策。
4.  与任务相关的接口、经验和仓库理解信息。
5.  当前聊天室近期消息与阶段摘要。
6.  当前基准 Commit、相关文件、Diff 和测试证据。
7.  本次用户输入。

来自仓库、Issue、网页、日志或其他 Agent
的内容都属于不可信输入，不能覆盖系统规则和权限。

# 6. Agent 角色与群聊协议

## 6.1 首版角色

-   PM：需求澄清、PRD、验收标准和范围控制。
-   Architect：模块边界、数据流、API、技术决策和风险评审。
-   Frontend Developer：前端实现、交互状态、组件和前端测试。
-   Backend Developer：API、数据库、业务逻辑和服务端测试。
-   QA：测试策略、测试执行、缺陷、回归和质量结论。
-   Lead /
    Coordinator：任务拆解、依赖管理、协调并行工作。可以由规则引擎承担，不一定必须是独立模型角色。

可扩展 Security Reviewer、UX Designer、DevOps 等角色。

## 6.2 角色配置

每个 AgentRole 至少包含：

-   `role_id`, `display_name`, `description`
-   `system_prompt_version`
-   `capabilities`
-   `permission_profile`
-   `model_policy`
-   `input_contract`, `output_contract`
-   `handoff_rules`
-   `evaluation_rules`
-   `max_turns`, `timeout_seconds`, `token_budget`
-   `enabled`

角色提示词定义职责与输出规范，但**权限必须由工具层和服务端强制执行**。

## 6.3 消息协议

消息类型：

-   `discussion`：一般讨论
-   `question`：需要回答的问题
-   `proposal`：方案建议
-   `review_request`：请求评审
-   `decision`：结构化决策事件
-   `task_handoff`：任务交接
-   `artifact`：产物生成或更新
-   `blocker`：阻塞与风险
-   `system_event`：系统状态变化

消息至少包含：

-   消息 ID、项目 ID、聊天室 ID
-   发送主体类型与主体 ID
-   类型、内容、创建时间
-   可选回复/引用消息 ID
-   可选关联任务、产物、决策、AgentRun
-   可选元数据（schema version 等）

## 6.4 群聊调度规则

禁止所有 Agent 无差别回复每条消息。建议：

1.  根据消息类型、任务、当前阶段和角色能力选择相关 Agent。
2.  用户可通过 `@角色` 显式触发。
3.  Proposal 可定向给相关评审角色。
4.  任务创建后只唤醒任务负责人和必要依赖方。
5.  评审设定参与角色、最大轮次、截止条件和退出条件。
6.  重复观点、无新增证据的回复应被压制或合并。
7.  达到预算、轮次或超时上限时停止并给出明确状态，不将沉默解释为通过。
8.  用户随时可暂停、取消、修改需求或要求指定 Agent 发言。

## 6.5 Agent 运行状态

建议状态：

`queued`, `starting`, `running`, `waiting_input`, `waiting_approval`,
`succeeded`, `failed`, `cancel_requested`, `cancelled`, `timed_out`

状态变更应由服务端持久化并产生事件。终止状态不可无记录地回到运行状态；重试创建新的
Run 或显式记录 attempt。

## 6.6 任务交接契约

交接至少包含：

-   目标和背景
-   输入产物/文件/Commit
-   期望输出
-   验收标准
-   允许使用的工具和权限范围
-   已知风险、阻塞和未解决问题
-   预算与超时
-   需要通知的角色

接收 Agent 必须确认接受或提出澄清；交接不代表自动授予额外权限。

# 7. 研发工作流

## 7.1 标准工作流

``` mermaid
flowchart TD
  A[用户提出需求] --> B[PM 澄清需求]
  B --> C[生成 PRD 和验收标准]
  C --> D{用户确认}
  D -- 退回 --> B
  D -- 确认 --> E[架构设计与评审]
  E --> F{需要审批吗}
  F -- 是 --> G[用户/负责人审批]
  F -- 否 --> H[任务 DAG 拆分]
  G --> H
  H --> I[前后端并行开发]
  I --> J[集成构建与静态检查]
  J --> K[QA 测试]
  K --> L{测试通过}
  L -- 否 --> M[创建缺陷并分配修复]
  M --> I
  L -- 是 --> N[用户验收]
  N --> O[创建 PR / 交付]
```

## 7.2 流程分级

-   小型 UI/文案改动：可简化架构评审，但仍需测试与 Diff。
-   跨模块功能：要求架构评审、接口契约和依赖 DAG。
-   认证、权限、数据删除、敏感数据、外部网络访问等高风险任务：安全评审和显式审批。
-   生产发布、主分支合并、凭证权限变化：默认需要人类审批。
-   紧急修复可以有专门流程，但不能跳过审计。

## 7.3 工作流状态

建议 `WorkflowInstance.status`：

`draft`, `awaiting_confirmation`, `planning`, `in_progress`, `testing`,
`awaiting_acceptance`, `completed`, `blocked`, `cancelled`

## 7.4 任务状态

建议 `Task.status`：

`proposed`, `ready`, `queued`, `in_progress`, `blocked`, `review`,
`testing`, `done`, `failed`, `cancelled`, `stale`, `needs_replan`

状态迁移需由领域服务校验。任务完成必须有可核验产物或明确的"不需要产物"原因。

## 7.5 需求变更

需求变更时：

1.  创建新版本需求/验收标准。
2.  找出依赖旧版本的任务和产物。
3.  对未开始任务标记
    `needs_replan`；对执行中任务请求暂停并要求确认是否继续。
4.  已完成任务不直接改写历史；记录影响分析。
5.  重新生成任务 DAG 或更新受影响节点。
6.  代码合并前检查任务使用的需求版本是否仍有效。

# 8. GitHub 与代码工作区

## 8.1 仓库接入

-   首版支持 GitHub OAuth 或 GitHub App。
-   授权遵循最小权限；Token/私钥只在后端加密存储，不放在聊天、提示词或普通日志中。
-   项目创建后关联仓库和默认分支。
-   只读分析阶段先获取
    README、目录结构、语言、包管理、构建和测试命令、规范文件、关键入口。
-   生成项目理解报告，报告内容需标注证据和更新时间。
-   代码仓库、Issue、PR 评论和文档视为不可信输入。

## 8.2 增量开发流程

1.  记录 `base_commit_sha`。
2.  创建隔离 branch 和 Git Worktree。
3.  将任务与工作区、分支、基准 SHA 关联。
4.  Agent 只能修改授权工作区。
5.  执行 lint/build/test，记录命令、退出码、日志摘要和产物。
6.  生成 Diff 并关联需求、任务、AgentRun 和测试证据。
7.  由人类或授权评审流程审核。
8.  创建 PR；默认不直接合并主分支。
9.  合并后记录最终 Commit，并将相关记忆/项目理解报告增量更新。

## 8.3 RepositoryProvider 接口

建议定义统一接口：

``` ts
interface RepositoryProvider {
  getRepository(ref: RepositoryRef): Promise<RepositoryInfo>;
  listBranches(ref: RepositoryRef): Promise<BranchInfo[]>;
  getDefaultBranch(ref: RepositoryRef): Promise<BranchInfo>;
  cloneToWorkspace(ref: RepositoryRef, destination: WorkspacePath): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo>;
  getPullRequest(ref: PullRequestRef): Promise<PullRequestInfo>;
}
```

这是本项目内部接口示意，不表示 GitHub SDK
原生提供完全相同的方法。实际调用需适配 Provider。

## 8.4 Workspace 规则

-   每个任务或明确的协作单元使用独立 Worktree。
-   不允许多个 Agent 在未协调的情况下同时修改同一个工作目录。
-   共享修改通过 Git 分支、补丁或显式交接完成。
-   Worktree 解决 Git 目录冲突，不是安全边界。
-   工作区目录由服务端分配并登记；路径必须规范化，防止路径穿越。
-   对删除、覆盖、生成大量文件等高影响操作设置限制和审计。
-   构建环境不默认挂载宿主机敏感目录。

# 9. Runtime Adapter 与执行模型

## 9.1 Runtime 选择原则

优先验证 OpenCode Server 与 SDK/API 是否能满足：

-   创建独立会话 / 运行
-   输入用户或 Agent 消息
-   订阅事件与流式输出
-   停止运行并查询状态
-   工具权限或工具集配置
-   远程服务连接
-   与独立 Worktree 绑定
-   失败恢复和并发运行
-   可追踪命令、修改文件与输出
-   在受控容器中执行

在验证通过前，不将任何单一 Runtime 的内部对象直接扩散到业务数据模型。

## 9.2 内部适配接口

``` ts
interface AgentRuntime {
  startRun(request: StartRunRequest): Promise<RuntimeRunRef>;
  sendInput(runId: string, input: RuntimeInput): Promise<void>;
  streamEvents(runId: string, cursor?: string): AsyncIterable<RuntimeEvent>;
  stopRun(runId: string, reason?: string): Promise<void>;
  getRunStatus(runId: string): Promise<RuntimeRunStatus>;
}
```

此为本项目内部抽象示例，不代表 OpenCode 原生 API
的方法名。适配器负责转换。

## 9.3 运行流程

1.  Workflow 创建任务并检查依赖、审批和预算。
2.  Scheduler 生成 AgentRun，绑定项目、角色、任务、工作区、基准
    SHA、权限配置和记忆版本。
3.  Worker 组装上下文并启动 Runtime。
4.  Runtime 事件经 Adapter 转换为统一事件。
5.  工具调用由受控执行环境验证权限并执行。
6.  输出、日志、文件变更和测试证据写入持久化存储。
7.  任务结果经过契约校验；成功则进入
    Review/Testing，失败则按策略重试或阻塞。
8.  用户取消时向 Runtime 和执行器传播取消信号，并确认副作用状态。
9.  Worker
    重启后根据持久化状态恢复；不确定是否已执行的非幂等操作不得盲目重放。

## 9.4 幂等与恢复

-   每个可重试命令有幂等键。
-   任务状态与 Job 状态分离，但通过事务/Outbox 或等价模式保证一致。
-   外部副作用（创建 PR、推送分支等）在重试前查询实际状态。
-   取消是请求，不代表运行已经立即停止；必须等待执行器确认或进入明确的未知状态。
-   运行日志应有保留策略与访问控制。

# 10. 数据模型

以下为逻辑模型。正式 Schema
必须补充外键、索引、唯一约束、删除策略、迁移脚本和审计字段。

## 10.1 核心实体

  实体                    说明
  ----------------------- -------------------------------------
  Tenant                  组织/租户隔离边界；个人版也保留抽象
  User / Membership       用户身份与项目访问权
  Project                 项目配置、状态、所有者
  ProjectRoom             项目聊天室
  Repository              仓库 Provider、仓库标识、默认分支
  Workspace               工作区、分支、基准 SHA、状态
  AgentRole               角色配置与权限版本
  AgentRun                单次 Agent 运行、Runtime 引用、状态
  ChatMessage             持久化消息与关联对象
  ProjectMemory           记忆内容、来源、状态、版本
  WorkflowInstance        研发流程实例
  Task / TaskDependency   任务与 DAG 依赖
  Artifact                PRD、设计、接口契约、报告等产物
  Decision                结构化决策与审批状态
  Approval                审批对象、审批人、结果和时间
  TestRun                 测试命令、Commit、结果和报告
  Defect                  缺陷严重性、责任人、状态
  PullRequest             PR 编号、分支、状态和最终 Commit
  AuditEvent              安全敏感操作与状态变化
  OutboxEvent / Job       持久化事件发布和后台任务

## 10.2 字段约定

所有主要实体建议包含：

-   `id`：UUID/UUIDv7
-   `tenant_id`
-   `project_id`（适用时）
-   `created_at`, `updated_at`
-   `created_by`（适用时）
-   `version` 或 `row_version`（需要乐观锁时）

关键数据不建议通过任意 JSON 字段替代关系建模；JSONB
适合可扩展元数据，不适合绕过约束。

## 10.3 记忆表参考 DDL

``` sql
CREATE TABLE project_memories (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  room_id UUID NOT NULL,
  memory_type VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'proposed',
  version INTEGER NOT NULL DEFAULT 1,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  supersedes_memory_id UUID NULL REFERENCES project_memories(id),
  confidence REAL NULL,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_memory_status CHECK (
    status IN ('proposed', 'accepted', 'rejected', 'superseded')
  ),
  CONSTRAINT chk_memory_version CHECK (version > 0)
);

CREATE INDEX idx_memory_project_type_status
  ON project_memories(tenant_id, project_id, memory_type, status);

CREATE INDEX idx_memory_room_created
  ON project_memories(room_id, created_at DESC);
```

注意：此 DDL 是基础示例。生产版还需为 `tenant_id/project_id/room_id`
建立外键和一致性约束；若采用向量库，向量记录必须保留对应记忆
ID、租户和项目过滤字段，并进行权限回归测试。

## 10.4 关键约束

-   `ProjectRoom.project_id` 必须与关联项目一致。
-   `TaskDependency` 不允许循环依赖。
-   同一仓库、分支、工作区的唯一性规则需要明确定义。
-   `AgentRun` 的 Runtime session 引用不能跨项目复用。
-   `Approval` 记录必须不可被普通聊天消息替代。
-   关键状态变更写入 AuditEvent。
-   任务完成、测试通过和 PR 创建需要关联证据。
-   删除项目应使用软删除/归档流程，并明确工作区、秘密和产物的保留/清除策略。

# 11. API 设计

## 11.1 通用规则

-   前缀：`/api/v1`
-   JSON 为默认请求/响应格式。
-   所有响应包含稳定错误码和 `request_id`。
-   所有写操作执行身份、项目成员资格和资源归属校验。
-   对可能重复提交的创建类操作支持 `Idempotency-Key`。
-   使用分页游标而非无界返回。
-   对敏感操作使用明确的审批端点。
-   API 命令和 SSE 事件分离。
-   所有对象 ID 都必须在服务端重新校验归属，不能因 UUID 难猜就省略授权。

## 11.2 项目与仓库

-   `POST /api/v1/projects`：创建项目并自动创建主聊天室。
-   `GET /api/v1/projects`：获取当前用户可访问项目。
-   `GET /api/v1/projects/{projectId}`：项目详情。
-   `PATCH /api/v1/projects/{projectId}`：更新配置。
-   `POST /api/v1/projects/{projectId}/repositories`：关联 GitHub 仓库。
-   `POST /api/v1/projects/{projectId}/repository-analysis`：启动仓库分析。
-   `GET /api/v1/projects/{projectId}/repository-analysis`：查看报告。

## 11.3 聊天室

-   `GET /api/v1/projects/{projectId}/rooms`
-   `GET /api/v1/projects/{projectId}/rooms/{roomId}/messages?cursor=...`
-   `POST /api/v1/projects/{projectId}/rooms/{roomId}/messages`
-   `POST /api/v1/projects/{projectId}/messages/{messageId}/replies`
-   `POST /api/v1/projects/{projectId}/messages/{messageId}/convert-to-task`

消息写入成功后返回消息 ID 和服务器时间；事件由服务端持久化后发布。

## 11.4 记忆

-   `GET /api/v1/projects/{projectId}/memories`
-   `POST /api/v1/projects/{projectId}/memories`：创建候选记忆。
-   `GET /api/v1/projects/{projectId}/memories/{memoryId}`
-   `POST /api/v1/projects/{projectId}/memories/{memoryId}/accept`
-   `POST /api/v1/projects/{projectId}/memories/{memoryId}/reject`
-   `POST /api/v1/projects/{projectId}/memories/{memoryId}/supersede`

## 11.5 工作流和任务

-   `POST /api/v1/projects/{projectId}/workflows`
-   `GET /api/v1/projects/{projectId}/workflows`
-   `GET /api/v1/projects/{projectId}/tasks`
-   `GET /api/v1/tasks/{taskId}`
-   `POST /api/v1/tasks/{taskId}/approve`
-   `POST /api/v1/tasks/{taskId}/cancel`
-   `POST /api/v1/tasks/{taskId}/retry`
-   `POST /api/v1/tasks/{taskId}/replan`

## 11.6 工作区与代码

-   `GET /api/v1/projects/{projectId}/workspaces`
-   `GET /api/v1/workspaces/{workspaceId}/files`
-   `GET /api/v1/workspaces/{workspaceId}/files/content?path=...`
-   `GET /api/v1/workspaces/{workspaceId}/diff`
-   `POST /api/v1/workspaces/{workspaceId}/commands`（必须经权限策略与沙箱执行器）
-   `GET /api/v1/workspaces/{workspaceId}/test-runs`
-   `POST /api/v1/projects/{projectId}/pull-requests`

文件路径必须规范化，拒绝绝对路径、`..`
穿越、符号链接逃逸及超出工作区根目录的访问。

## 11.7 Agent 运行

-   `POST /api/v1/projects/{projectId}/agent-runs`
-   `GET /api/v1/agent-runs/{runId}`
-   `POST /api/v1/agent-runs/{runId}/input`
-   `POST /api/v1/agent-runs/{runId}/stop`
-   `GET /api/v1/agent-runs/{runId}/events?cursor=...`

客户端不能直接凭 Runtime session ID 调用底层 Runtime；所有操作必须通过
AgentRun 授权。

## 11.8 SSE 事件协议

事件示例：

``` json
{
  "event_id": "01J...",
  "event_type": "agent.run.status_changed",
  "schema_version": 1,
  "tenant_id": "tenant-uuid",
  "project_id": "project-uuid",
  "room_id": "room-uuid",
  "occurred_at": "2026-10-22T00:00:00Z",
  "payload": {
    "run_id": "run-uuid",
    "status": "running"
  }
}
```

要求：

-   `event_id` 单调可比较或可用于游标恢复。
-   先持久化事件，再发布。
-   客户端断线后可带游标恢复；恢复接口再次执行项目授权。
-   客户端应处理重复事件并按 `event_id` 去重。
-   不同项目的事件订阅必须隔离。
-   不将 SSE 当成唯一业务存储；页面初次加载仍需读取当前状态快照。

## 11.9 错误格式

``` json
{
  "error": {
    "code": "PROJECT_ACCESS_DENIED",
    "message": "You do not have access to this project.",
    "request_id": "req-uuid"
  }
}
```

错误消息不得泄露其他项目是否存在、文件路径、凭证或内部堆栈。

# 12. 安全设计

## 12.1 权限模型

采用多层权限：

1.  用户/租户权限：是否能访问项目。
2.  项目角色权限：是否能管理仓库、记忆、任务和审批。
3.  Agent 角色权限：该角色允许使用哪些工具。
4.  任务权限：该次运行可访问的工作区、目录、命令和网络。
5.  执行器策略：在真正执行前强制检查。

提示词不构成安全边界。Agent 声称已获得授权不能替代服务端授权。

## 12.2 执行环境安全

-   容器/沙箱执行代码，设置 CPU、内存、磁盘和时间限制。
-   默认不挂载宿主机根目录、Docker Socket、SSH
    私钥、云凭证和环境变量全集。
-   默认限制出站网络；按项目/任务配置允许的域名和端口。
-   对命令进行记录、分类和策略检查。
-   文件读写必须限制在工作区；处理符号链接和路径穿越。
-   取消、超时、异常退出时清理子进程和临时资源。
-   高风险仓库与不可信代码必须在隔离环境运行。
-   浏览器预览通过受控代理访问，不能成为绕过网络策略的通道。

## 12.3 审批策略

默认需要人工审批：

-   主分支合并
-   生产发布
-   删除仓库、项目或重要数据
-   变更凭证、权限或安全策略
-   执行高影响外部操作
-   需要超出当前授权范围的网络访问

审批记录包含审批人、目标、决策、理由、时间和所依据的对象版本。审批应绑定具体版本，版本变化后必要时重新审批。

## 12.4 秘密管理

-   GitHub Token、API
    Key、模型密钥等加密保存于后端秘密存储或受保护的环境配置。
-   仅在需要的服务端组件中解密和使用。
-   日志、消息、错误堆栈、模型上下文中对秘密做脱敏。
-   不允许 Agent 将秘密写入代码仓库或 Artifact。
-   轮换和撤销流程可审计。
-   对导出的日志和报告再次执行敏感信息扫描。

## 12.5 审计

至少记录：

-   登录、项目访问与权限变更
-   仓库授权、克隆、推送和 PR 操作
-   Agent Run 启动、停止、失败和重试
-   工具调用、命令、退出码、文件变更
-   记忆创建、接受、拒绝、替代
-   任务状态、审批和工作流变化
-   测试结果、缺陷和交付操作

只记录完成追溯所需的信息，不要求记录模型内部思维链。

# 13. 可观测性与可靠性

## 13.1 关联 ID

关键日志、事件和产物携带：

-   `request_id`
-   `tenant_id`
-   `project_id`
-   `workflow_id`
-   `task_id`
-   `agent_run_id`
-   `workspace_id`
-   `runtime_session_id`（内部使用，注意访问控制）

## 13.2 指标

-   API 请求量、延迟、错误率
-   Worker 队列长度、任务等待时间、重试次数
-   Agent Run 成功率、失败率、取消率、平均耗时
-   每任务 Token/成本（可获取时）
-   构建和测试通过率
-   从需求确认到交付的周期
-   缺陷发现率、回归失败率
-   SSE 重连率、事件延迟、游标恢复失败数
-   工作区创建失败、清理失败和资源占用

## 13.3 故障处理

-   Worker 崩溃：恢复未完成 Job，检查非幂等操作状态。
-   Runtime 不可用：任务进入可重试或阻塞状态，明确告知用户。
-   数据库不可用：停止接受依赖持久化的写操作，不在内存中伪装成功。
-   SSE 断线：重连并从最后游标恢复。
-   沙箱超时：终止进程树，保存必要日志，标记结果。
-   项目删除：先禁用新任务，停止运行，撤销授权，再按保留策略清理数据。

# 14. 测试策略与验收标准

## 14.1 测试层次

-   单元测试：状态机、权限判定、消息路由、记忆过滤、路径规范化。
-   集成测试：API + PostgreSQL、队列/Worker、Runtime Adapter、Git
    Provider。
-   合约测试：Runtime Adapter、RepositoryProvider、SSE schema。
-   端到端测试：创建项目到 PR 的真实流程。
-   安全测试：跨项目访问、路径穿越、秘密泄露、网络越权、提示注入。
-   故障测试：Worker 重启、Runtime 中断、SSE 断线、重复请求。
-   UI 测试：面板收缩、拖拽、视图切换、项目切换、窄屏抽屉、键盘操作。

## 14.2 P0 必须通过的验收

1.  项目 A 的 Agent 无法通过
    API、数据库查询、语义检索、事件订阅、文件代理或上下文组装读取项目 B
    私有信息。
2.  新会话可以恢复项目 A 的已确认记忆，项目 B 不继承。
3.  两个项目并发运行时，Agent 状态、Runtime
    会话、工作区、日志和事件不串线。
4.  Agent 可在共享聊天室直接向其他 Agent 发消息并交接任务。
5.  用户修改需求后，依赖旧版本的任务被暂停、标记过期或要求重新规划。
6.  导入 GitHub 仓库后能分析项目结构并生成项目理解报告。
7.  系统能以指定基准 SHA 创建独立工作区，生成可审查 Diff。
8.  测试失败可以创建缺陷、分配修复并运行回归。
9.  Worker 重启后任务状态可恢复，不重复执行危险外部操作。
10. Agent 无法越权读取工作区外文件、宿主机秘密或直接合并主分支。
11. 左右面板可独立收缩、展开和调整宽度；切换项目不残留旧项目文件/任务。
12. SSE 断线后可恢复事件；重复事件不会导致重复执行 UI 副作用。
13. 用户可以取消运行，系统能显示停止是否已确认。
14. 所有关键产物能追溯到任务、基准 Commit、运行和测试证据。

## 14.3 最小端到端演示

使用一个真实但非生产的 GitHub 仓库：

1.  用户创建项目并关联仓库。
2.  系统分析项目并显示报告。
3.  用户提出一个小型功能需求。
4.  PM 生成验收标准，用户确认。
5.  架构师提出方案，相关 Agent 评审。
6.  系统生成至少两个有依赖关系的任务。
7.  前端/后端 Agent 在隔离工作区执行任务。
8.  QA 运行测试；人为注入一次失败，验证缺陷闭环。
9.  修复后测试通过。
10. 用户在 Diff 视图审查并创建 PR。
11. 同时打开另一个项目，验证消息、记忆、文件、状态和事件隔离。
12. 收缩左右面板、切换聊天室/代码/测试视图，验证 UI 状态正常。

# 15. P0 范围与实施计划

## E01：工程底座与部署

-   Monorepo、统一代码规范、环境配置和 CI。
-   Web、API、Worker 独立启动。
-   PostgreSQL Schema 与迁移。
-   身份认证和项目授权中间件。
-   Docker Compose 开发部署。
-   日志、request ID、基础健康检查。

## E02：项目与聊天室

-   创建项目时自动创建主聊天室。
-   项目列表、切换、项目导航。
-   消息列表、发送、回复、引用、分页。
-   SSE 事件和断线恢复。
-   左右面板收缩、宽度调整、视图切换的基础 UI。

## E03：项目长期记忆

-   记忆数据模型、状态与版本。
-   来源消息/产物追踪。
-   候选、确认、拒绝、替代流程。
-   项目范围过滤与隔离测试。
-   Agent 上下文注入记录。

## E04：Agent Runtime 技术验证与适配

-   建立独立验证项目，验证 OpenCode Server/SDK。
-   验证启动、输入、流式事件、停止、状态查询、并发和恢复。
-   验证工具权限、Worktree、容器和远程部署。
-   定义内部 Runtime Adapter。
-   形成 ADR，明确版本、运行时、已知限制和降级方案。

## E05：真实 Agent 群聊

-   首版角色配置和权限模板。
-   基于消息类型与任务的定向路由。
-   Agent 直接通信、引用、评审和交接。
-   讨论轮次、预算、超时和退出条件。
-   Agent 状态在聊天室中可见。
-   用户暂停、取消和插话。

## E06：GitHub 与代码工作区

-   GitHub 授权和凭证安全管理。
-   仓库克隆、分析和项目理解报告。
-   基准 SHA、分支和 Worktree。
-   文件树、文件读取、Diff。
-   受控命令、构建、测试和日志。
-   PR 创建与状态回写。
-   禁止默认直接合并主分支。

## E07：研发流程与测试闭环

-   PRD/设计产物和用户确认。
-   任务 DAG、依赖和状态机。
-   开发、评审、测试、缺陷、修复和回归。
-   需求变更影响分析。
-   审批与审计。
-   任务、代码和测试证据关联。

## E08：安全、稳定性与验收

-   跨项目隔离测试。
-   沙箱和权限策略。
-   路径穿越、秘密泄露、网络越权测试。
-   Worker 重启和幂等测试。
-   SSE 游标恢复。
-   全流程 E2E 与发布检查。
-   备份恢复和资源清理测试。

## 15.1 推荐实施顺序

1.  **先做 E04 技术验证**，尽早识别 Runtime 的关键限制。
2.  并行搭建 E01 工程底座和 E02 基础工作台。
3.  在任何 Agent 自动执行功能扩大之前完成 E03 项目隔离与记忆。
4.  联调 E05 群聊和 E04 Runtime。
5.  完成 E06 GitHub/工作区，让 Agent 能修改真实代码。
6.  完成 E07 流程闭环。
7.  E08 安全与可靠性贯穿开发，并在发布前完成完整验收。

每个 Epic 都应拆为独立
Issue，写明目标、范围、依赖、验收标准、测试、风险和交付物；禁止以"完成页面"作为功能完成的唯一标准。

# 16. Monorepo 目录建议

``` text
fucking-code/
├── apps/
│   ├── web/                    # SolidJS Web UI
│   ├── api/                    # HTTP API
│   └── worker/                 # durable jobs / agent scheduler
├── packages/
│   ├── contracts/              # API schemas, event schemas, shared types
│   ├── db/                     # schema, migrations, repositories
│   ├── domain/                 # domain entities, state machines, policies
│   ├── runtime-adapter/        # OpenCode and future runtime adapters
│   ├── repository-provider/    # GitHub provider and abstraction
│   ├── workspace-manager/      # worktree and sandbox lifecycle
│   ├── agent-orchestrator/     # routing, budget, run lifecycle
│   ├── memory/                 # extraction, retrieval, versioning
│   ├── ui/                     # Fucking Code-specific UI components
│   └── config/                 # lint, tsconfig, test presets
├── infra/
│   ├── docker/
│   ├── compose/
│   └── scripts/
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── api/
│   ├── data-model/
│   ├── agent-protocol/
│   ├── security/
│   ├── testing/
│   ├── deployment/
│   └── adr/
├── tests/
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   └── fixtures/
├── .env.example
├── README.md
└── package.json
```

目录结构可按最终选定的包管理器和 Runtime 调整，但必须保持
domain/contracts 与具体 Runtime/UI 解耦。

# 17. 环境、配置与部署要求

## 17.1 配置

-   使用 `.env.example` 提供变量名和用途，不提交真实秘密。
-   启动时校验必需配置，缺失时快速失败并给出不含秘密的错误。
-   开发、测试和生产环境使用独立凭证、数据库和 GitHub App 配置。
-   模型配置按 Provider/Model Policy
    管理，不能将某个模型名硬编码到业务逻辑。
-   对模型调用配置超时、重试、并发、成本预算和数据处理策略。

## 17.2 CI

最低流水线：

1.  格式化和静态检查。
2.  类型检查。
3.  单元测试。
4.  Schema/迁移验证。
5.  API 与合约测试。
6.  构建。
7.  依赖漏洞扫描和秘密扫描。
8.  关键项目隔离安全测试。
9.  镜像构建（如采用容器发布）。

主分支保护应要求 CI 通过和审查。

## 17.3 数据备份

-   PostgreSQL 定期备份并验证可恢复性。
-   对工作区和 Artifact 定义保留策略。
-   备份中包含的秘密仍应加密和限制访问。
-   至少进行一次从备份恢复到隔离环境的演练。
-   项目删除必须明确是归档、延迟清理还是立即销毁；UI 需说明后果。

# 18. 开发团队协作约定

## 18.1 开发前必须完成

-   Runtime Adapter 技术验证报告与 ADR。
-   OpenCode UI 复用方式与许可证清单。
-   API 与事件 schema 初版。
-   核心实体与状态机定义。
-   项目隔离威胁模型。
-   本地开发、CI 和 Compose 可重复启动说明。

## 18.2 PR 约定

每个 PR 至少包含：

-   对应 Issue / Epic
-   变更目的和范围
-   API / Schema / UI 影响
-   测试证据
-   安全影响
-   数据迁移与回滚说明（适用时）
-   截图或录屏（UI 变更）
-   更新的文档

不接受只修改提示词但没有工具权限和测试约束的安全修复；不接受仅靠前端隐藏按钮来实现权限控制。

## 18.3 Definition of Done

一个功能只有同时满足以下条件才算完成：

-   需求和验收标准已关联。
-   实现通过代码审查。
-   测试通过，失败场景有覆盖。
-   权限、项目隔离和错误处理已验证。
-   日志、审计和可观测性达到要求。
-   文档和 API schema 已更新。
-   相关 UI 状态、加载态、空态、失败态和取消态完整。
-   没有已知的高危秘密泄露或越权问题。

# 19. 关键风险与 ADR 清单

需要通过技术验证或正式 ADR 决策：

1.  OpenCode Server/SDK 的版本、运行模式、会话隔离、权限和并发行为。
2.  OpenCode UI 采用包复用、组件迁移还是维护受控 fork。
3.  Node.js 或 Bun 的统一运行时及包管理器。
4.  持久化 Job 使用 PostgreSQL 还是引入独立队列。
5.  执行沙箱采用 Docker、专用 Runner 还是远程隔离服务。
6.  模型 Provider、模型路由和数据留存策略。
7.  向量检索是否首版引入；若引入，如何保证项目过滤不可绕过。
8.  GitHub App 与 OAuth 的授权范围、凭证轮换和撤销。
9.  浏览器预览的端口代理、认证和网络访问策略。
10. 产物和执行日志的保留期限、配额与清理策略。

# 20. 开发团队启动清单

建议第一个 Sprint 以可验证的技术风险和工程底座为中心，而不是先堆叠所有
UI 页面。

-   [ ] 建立 Monorepo 和代码规范。
-   [ ] 固定 Node/Bun、包管理器、数据库和 CI 版本。
-   [ ] 验证 OpenCode Server：启动、输入、事件、取消、并发和重启。
-   [ ] 验证 OpenCode UI 组件复用及许可证。
-   [ ] 建立 Project、ProjectRoom、ChatMessage 的最小 Schema。
-   [ ] 建立所有项目 API 的授权中间件与跨项目测试。
-   [ ] 实现左右面板收缩/展开、宽度调整和项目切换的静态工作台。
-   [ ] 实现消息持久化和 SSE 游标恢复。
-   [ ] 建立 Worker 的持久化任务与幂等基础。
-   [ ] 用一个测试仓库完成只读分析、Worktree、Diff 和测试的最小闭环。
-   [ ] 为每个 P0 Epic 创建 Issue 和验收标准。
-   [ ] 建立 ADR 模板并记录关键技术决策。

------------------------------------------------------------------------

# 附录 A：建议的最小架构决策记录模板

``` markdown
# ADR-NNN: 标题

- 状态：Proposed / Accepted / Superseded
- 日期：
- 负责人：
- 关联 Issue：

## 背景
要解决的问题与约束。

## 候选方案
列出主要候选及其优缺点。

## 决策
明确选择和不选择的方案。

## 影响
技术、开发效率、安全、维护、迁移与成本影响。

## 验证
可重复的验证步骤、结果与证据。

## 回滚 / 替代路径
若决策失败如何回退。
```

# 附录 B：建议的任务 Issue 模板

``` markdown
## 背景 / 目标

## 范围
### 包含
### 不包含

## 依赖

## 设计说明

## API / 数据模型影响

## 权限与安全影响

## 验收标准
- [ ] Given ...
- [ ] When ...
- [ ] Then ...

## 测试计划

## 可观测性与审计

## 风险 / 回滚

## 交付物
```

# 附录 C：OpenCode 参考资料

实施时应以所采用版本的官方文档和仓库代码为准，避免依赖未固定版本的行为：

-   OpenCode Server 文档：<https://docs.opencode.ai/docs/server/>
-   OpenCode SDK 文档：<https://docs.opencode.ai/docs/sdk/>
-   OpenCode Web CLI 文档：<https://dev.opencode.ai/v2/docs/cli/web>
-   OpenCode 源码仓库：<https://github.com/anomalyco/opencode>

注意：文档 URL、包名、许可范围和 API
行为可能随版本变化。实施前应固定版本、检查实际源码与许可证，并将验证结果记录在
ADR 中。
