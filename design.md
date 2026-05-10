# Docker 可迁移架构设计

## 结论

不要把目标定义成“创建一个 Docker 可迁移的 mac app，让 mac app 在任意平台直接运行”。

原因很简单：

- `.app` 是 macOS 应用包格式，不能在 Linux/Windows 原生运行。
- Docker 容器适合运行服务、CLI、数据库、同步节点，不适合直接运行原生桌面 GUI。
- Electron 可以跨平台打包，但仍然需要分别产出 macOS、Linux、Windows 安装包。

推荐目标应该改成：

> 将 `llm-cost-monitor` 拆成“跨平台桌面壳 + Docker 可迁移核心服务”。桌面 app 负责托盘 UI、系统权限、读取本机日志路径；Docker 服务负责数据处理、同步 API、聚合查询、团队多节点共享。这样同一套核心能力可以在任意平台运行，桌面体验仍然保持原生。

## 设计目标

1. macOS 用户仍然获得正常的 `.app` / `.dmg` 体验。
2. Linux/Windows 用户获得对应平台安装包。
3. 核心服务可以用 Docker Compose 在任意机器上启动。
4. 同一个账号在多台电脑登录时，数据可以累积和同步。
5. 本地 LLM 只统计 token，不计算费用。
6. 离线时本机仍能工作；联网后自动同步。
7. 团队版可以部署到私有服务器，不强依赖官方云。

## 推荐架构

```text
┌──────────────────────────────┐
│ Desktop App                  │
│ macOS .app / Linux / Windows │
│                              │
│ - Tray UI                    │
│ - 本机日志读取               │
│ - 本机 SQLite                │
│ - Sync outbox                │
└──────────────┬───────────────┘
               │ HTTPS / localhost
               ▼
┌──────────────────────────────┐
│ Docker Core Service           │
│                              │
│ - Sync API                   │
│ - Usage aggregation          │
│ - Team dashboard API         │
│ - Pricing snapshot service   │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Postgres / Redis / Worker     │
│                              │
│ - usage_events               │
│ - rollup tables              │
│ - background jobs            │
└──────────────────────────────┘
```

## 组件拆分

### 1. Desktop App

继续使用 Electron。

职责：

- 读取本机 Claude / Codex / Gemini / Kimi / DeepSeek / local LLM 日志。
- 写入本机 SQLite。
- 展示托盘窗口。
- 维护本机 sync outbox。
- 将规范化后的 `UsageEvent` 批量上传到 Core Service。

不负责：

- 团队级全量聚合。
- 多用户权限。
- 长期云端存储。

### 2. Core Service

运行在 Docker 内。

职责：

- 账号和团队 API。
- 多节点 batch upsert。
- 事件去重。
- 高性能聚合查询。
- Rollup materialization。
- Web dashboard API。

技术建议：

- Node.js + Fastify / Hono。
- Postgres 作为主存储。
- Redis / Valkey 可选，用于队列和缓存。
- Worker 进程异步刷新 rollup。

### 3. Database

Postgres。

原因：

- 事件流 append-only 很适合 Postgres。
- `INSERT ... ON CONFLICT` 可以自然支持幂等同步。
- 索引和分区足够支撑早期团队规模。
- 未来可以接 ClickHouse，但不应该一开始就引入。

### 4. Web Dashboard

可以是 Core Service 自带的 web 页面，也可以后续独立。

职责：

- 团队视图。
- 成员视图。
- 项目视图。
- provider / model 成本视图。
- 节点在线状态。

桌面 app 可以嵌入或打开 dashboard。

## Docker 交付形态

### 单机个人版

用户只安装 desktop app。

```text
Desktop App -> local SQLite
```

不需要 Docker。

### 高级个人版 / 多设备版

用户在任意一台机器或 NAS 上运行 Docker Compose。

```text
MacBook Desktop ─┐
Linux Desktop ───┼──> Docker Core Service -> Postgres
Windows Desktop ─┘
```

### 团队私有部署

团队自己部署 Docker Compose 或 Kubernetes。

```text
Team desktops -> Company-hosted Core Service -> Company Postgres
```

## Docker Compose 设计

```yaml
services:
  api:
    image: ghcr.io/yimin12/llm-cost-monitor-api:latest
    ports:
      - "17891:17891"
    environment:
      DATABASE_URL: postgres://llm:llm@postgres:5432/llm_cost_monitor
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}
    depends_on:
      - postgres
      - redis

  worker:
    image: ghcr.io/yimin12/llm-cost-monitor-api:latest
    command: ["node", "dist/worker.js"]
    environment:
      DATABASE_URL: postgres://llm:llm@postgres:5432/llm_cost_monitor
      REDIS_URL: redis://redis:6379
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: llm_cost_monitor
      POSTGRES_USER: llm
      POSTGRES_PASSWORD: llm
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: valkey/valkey:8
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

## 多节点同步模型

### 身份

```text
userId: 同一个登录账号
teamId: 所属团队，个人用户也可以是 one-person team
nodeId: 每台电脑一个稳定 ID
```

同一个用户两台电脑：

```text
userId = user_123
nodeId = node_macbook
nodeId = node_linux_box
```

两台机器同时运行时，服务端按 `userId` 聚合，按 `nodeId` 去重。

### 事件 ID

本地事件已有：

```text
localEventId = UsageEvent.id
```

同步事件：

```text
syncEventId = sha256(teamId | userId | nodeId | localEventId)
```

这样可以保证：

- 同一节点重复上传不会重复计费。
- 不同节点上传不同事件会累积。
- 同一账号多节点不会互相覆盖。

## Sync Outbox

本地 SQLite 增加：

```sql
CREATE TABLE sync_outbox (
  sync_event_id TEXT PRIMARY KEY,
  local_event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

流程：

1. Parser 写入本地 `events`。
2. Sync builder 将未同步 events 转成 sync payload。
3. 写入 `sync_outbox`。
4. 后台任务批量上传。
5. 服务端 ack 后标记为 accepted。
6. 网络失败则指数退避重试。

## 服务端表设计

```sql
CREATE TABLE usage_events (
  sync_event_id TEXT PRIMARY KEY,
  local_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,

  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,

  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  day DATE NOT NULL,

  project TEXT,
  project_hash TEXT,

  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_read_tokens BIGINT NOT NULL,
  cache_creation_5m_tokens BIGINT NOT NULL,
  cache_creation_1h_tokens BIGINT NOT NULL,
  reasoning_tokens BIGINT,

  computed_cost_micro_usd BIGINT NOT NULL,
  pricing_snapshot_version TEXT NOT NULL,

  privacy_level TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

关键索引：

```sql
CREATE INDEX usage_events_team_day_idx
  ON usage_events (team_id, day DESC);

CREATE INDEX usage_events_team_user_day_idx
  ON usage_events (team_id, user_id, day DESC);

CREATE INDEX usage_events_team_node_day_idx
  ON usage_events (team_id, node_id, day DESC);

CREATE INDEX usage_events_team_provider_day_idx
  ON usage_events (team_id, provider, day DESC);
```

## 高性能写入

桌面端批量上传：

- 每批 500 到 2000 条事件。
- gzip 压缩。
- 单节点同一时间只跑一个上传任务。
- 失败后指数退避。

API：

```http
POST /v1/teams/:teamId/events:batchUpsert
Content-Encoding: gzip
Authorization: Bearer <token>
```

服务端：

- 一次校验 team membership。
- 一次校验 node 状态。
- 批量 insert。
- `ON CONFLICT(sync_event_id)` 去重。
- 只返回 summary counts，不逐条返回成功状态。

## 高性能读取

不要每次 dashboard 都扫 raw events。

增加 rollup 表：

```sql
CREATE TABLE team_daily_usage (
  team_id TEXT NOT NULL,
  day DATE NOT NULL,
  user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  project_hash TEXT,

  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cache_tokens BIGINT NOT NULL,
  reasoning_tokens BIGINT NOT NULL,
  cost_micro_usd BIGINT NOT NULL,
  event_count BIGINT NOT NULL,

  PRIMARY KEY (team_id, day, user_id, node_id, provider, model, project_hash)
);
```

Dashboard 查询全部走 rollup。

常用 API：

```http
GET /v1/me/usage/summary
GET /v1/me/usage/by-node
GET /v1/teams/:teamId/usage/summary
GET /v1/teams/:teamId/usage/by-user
GET /v1/teams/:teamId/usage/by-provider
GET /v1/teams/:teamId/usage/by-model
GET /v1/teams/:teamId/usage/by-project
```

## 同账号两台电脑的行为

例子：

```text
MacBook:
  Claude Code: $1.20, 50k tokens
  Gemini:      $0.10, 10k tokens

Linux:
  Codex:       $0.40, 20k tokens
  Ollama:      $0.00, 12k tokens
```

服务端账号总计：

```text
cost = $1.70
tokens = 92k
nodes = 2
```

UI 应该提供三个 scope：

- This device：只看当前机器。
- My account：看同账号所有机器。
- Team：看团队所有成员和机器。

## 隐私设计

默认 `redacted`。

模式：

- `full`: 上传 project name。
- `redacted`: 上传 project hash，不上传项目原名。
- `aggregateOnly`: 只上传 daily aggregate。

永远不上传：

- prompt。
- response。
- tool arguments。
- 原始 JSONL 文件。
- 本机绝对路径。
- API key。
- OAuth refresh token。

## 安全设计

认证：

- OAuth 登录。
- access token 短有效期。
- refresh token 存 OS Keychain / safeStorage。

节点注册：

- 首次登录生成 `nodeId`。
- 服务端记录 node。
- 可选生成 Ed25519 key pair。
- 后续版本可对 batch body 签名。

权限：

- 每个 API 都校验 team membership。
- 被移除成员不能上传。
- 被 revoke 的 node 不能上传。

## 迁移步骤

### Slice 1: 保持现有桌面 app

- 不改变现有 local-only 行为。
- 增加 `nodeId`。
- 增加 sync 设置页，但默认关闭。

### Slice 2: 抽出 sync DTO

- 定义 `SyncedUsageEvent`。
- 实现 `syncEventId`。
- 实现 redaction。
- 实现 local provider 零成本同步。

### Slice 3: 本地 outbox

- 增加 `sync_outbox`。
- 本地 events 变更后写入 outbox。
- 实现 retry/backoff。

### Slice 4: Docker Core Service MVP

- API service。
- Postgres migrations。
- `events:batchUpsert`。
- 基础 auth。

### Slice 5: Rollup

- 增加 daily rollup。
- batch upsert 后同步刷新 rollup。
- dashboard API 从 rollup 读取。

### Slice 6: 多 scope UI

- This device。
- My account。
- Team。

### Slice 7: 私有部署

- 发布 Docker image。
- 提供 `docker-compose.yml`。
- 支持 `LLM_COST_MONITOR_SYNC_URL` 指向自托管服务。

### Slice 8: 高级扩展

- WebSocket / SSE 实时刷新。
- Worker 异步 rollup。
- ClickHouse / TimescaleDB 分析存储。
- Admin retention policy。

## 测试计划

单元测试：

- `syncEventId` 稳定。
- 不同 `nodeId` 不会 dedup。
- 同一 `syncEventId` 重复上传不会重复计费。
- local provider cost 永远是 0。
- redacted 模式不包含 raw project。

集成测试：

- 同一用户两台节点上传后账号总数等于两台之和。
- 两个节点同时上传不会丢数据。
- 网络失败后 outbox 可以重试。
- 服务端 duplicate batch 幂等。
- revoke node 后上传失败。

性能测试：

- 单节点 10k events。
- 100 节点同时上传。
- 1k event batch p95 < 500ms。
- dashboard summary p95 < 150ms。

## 最终建议

不要把 Docker 当成桌面 app 的跨平台打包方案。

正确方案是：

```text
Electron desktop app per platform
+ Docker portable core service
+ Postgres-backed team sync
+ local-first SQLite cache
+ deterministic event dedup
+ rollup tables for performance
```

这样既保留 macOS 原生托盘体验，也能让核心数据同步和团队分析能力在任意平台、任意服务器上迁移运行。
