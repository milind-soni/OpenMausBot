# 项目看板 v1 后端契约（2026-11-15）

基线：OpenMausBot `a6cd67c7`（`0.1.158`）。分支：`feat/project-board-backend-20261115`。
看板项目与 `bot.projects`（左栏文件夹）是两套实体；看板任务只按 `botId + threadId` 关联已有对话，不复制标题、消息或权限。

## 数据

```ts
type BoardPhase = "discovery" | "design" | "build" | "test" | "release_ready" | "live_unverified" | "done";
type BoardTaskStatus = "todo" | "in_progress" | "review" | "done";
type BoardMilestoneStatus = "planned" | "in_progress" | "accepted" | "rejected";

interface BoardTask {
  threadId: string;            // 唯一键
  botId: string;               // 首次写入后不可改
  projectId?: string;
  subprojectId?: string;
  parentThreadId?: string;     // 另一个看板任务的 threadId
  phase: BoardPhase;
  status: BoardTaskStatus;
  owner?: string;
  acceptance?: string;
  blocked?: boolean;
  paused?: boolean;
  verdict?: { decision: "accepted" | "rejected"; evidence: string; at: string };
  createdAt: string;
  updatedAt: string;
}
```

`BoardProject { id, name, description?, createdAt, updatedAt }`，`BoardSubproject { id, projectId, name, ... }`，
`BoardMilestone { id, projectId, subprojectId?, title, status, verdict?, evidence?, dueAt?, ... }`，`dueAt` 是 epoch ms。
`accepted` 里程碑必须同时有非空 `verdict` 与非空 `evidence`，否则 `422 BOARD_NEEDS_EVIDENCE`。

## 端点

所有端点都是 owner/admin 面（v1）：`GET` 也需要 admin，`403 BOARD_FORBIDDEN` 给其他会话。
`capabilities.manage` 因此当前恒为 `true`；字段保留给后续只读成员面。

- `GET /api/board` → 顶层快照：
  `{ version, projects[], subprojects[], milestones[], tasks[], capabilities: { manage }, updatedAt }`
- `POST /api/board/projects` `{ name, description?, version? }` → `201 { board }`
- `PATCH /api/board/projects/:id` `{ name?, description?, version? }` → `200 { board }`
- `POST /api/board/subprojects` `{ projectId, name, version? }` → `201 { board }`
- `PATCH /api/board/subprojects/:id` `{ name?, version? }` → `200 { board }`
- `POST /api/board/milestones` `{ projectId, subprojectId?, title, dueAt?, version? }` → `201 { board }`
- `PATCH /api/board/milestones/:id` `{ title?, status?, verdict?, evidence?, dueAt?, version? }` → `200 { board }`
- `PUT /api/board/tasks/:threadId` `{ botId, projectId?, subprojectId?, parentThreadId?, phase?, status?, owner?, acceptance?, blocked?, paused?, version? }` → `200 { board }`
- `POST /api/board/tasks/:threadId/verdict` `{ decision: "accepted" | "rejected", evidence, version? }` → `200 { board, task }`
- `DELETE /api/board/tasks/:threadId?version=N` → `200 { board }`（仅取消归类，不删除对话）

写响应用 `{ board }` 整体替换前端副本；`GET` 是顶层快照。`version` 可选；带上则做乐观并发，
过期返回 `409 BOARD_VERSION_CONFLICT`。所有写操作都会递增 `version` 并广播一条 SSE。
`PUT` 省略字段 = 保留旧值，`null` = 清空。`phase: "done"` 需要已有 `accepted` verdict（同一次写入无法既设 done 又给 verdict）。

### 新对话归属

`POST /api/bots/:id/tasks` 增加可选 `board` 字段，与创建对话同一次请求完成归属：

```json
{ "title": "看板前端", "board": { "projectId": "p_...", "subprojectId": "sp_...", "phase": "build", "status": "in_progress", "owner": "Pixel" } }
```

`board` 内部字段与 `PUT /api/board/tasks/:threadId` 相同，但 `threadId`/`botId` 由服务端取。
归属失败会删除刚创建的对话并返回 `400/403/422`。不传 `board` 的旧客户端行为不变。

### 未归类

`GET /api/board` 只返回已归类任务。前端用已有的 `/api/bots` 快照里的对话列表减去 `board.tasks`
即得“待归类”；v1 不做批量写，只支持逐条 `PUT`（避免误归类）。

### 实时帧

SSE `GET /api/events` 新增：

```json
{ "kind": "board", "board": { "version": 7, "projects": [], "subprojects": [], "milestones": [], "tasks": [], "updatedAt": "..." } }
```

整板替换，不带 `capabilities`（每个调用者的权限不同）。页面打开/聚焦仍建议重取 `GET /api/board`。
当前广播只发给 admin 会话；成员面接入时再按可见对话过滤任务。

## 错误

```json
{ "error": "BOARD_INVALID", "message": "..." }
```

`400 BOARD_INVALID`、`403 BOARD_FORBIDDEN`、`409 BOARD_VERSION_CONFLICT`、`422 BOARD_NEEDS_EVIDENCE`。

## 本地验收

依赖安装后（`pnpm install --frozen-lockfile`），用隔离数据目录启动，不碰真实应用数据：

```sh
env -u OMB_DESKTOP_PARENT -u OMB_DESKTOP_LAUNCH_ID \
  OMB_DEV_TRUST_LOCAL_BROWSER=1 OMB_DATA_DIR=/tmp/omb-board-dev OMB_PORT=8899 \
  pnpm dev:server
```

如果从 OpenMausBot 自己的终端里启动，父进程会带 `OMB_DESKTOP_PARENT=1`；服务端会按桌面应用处理，
浏览器 `Origin` 的写请求被 403 拒绝（`this change must come from the desktop app or a paired device`）。
上面先清掉它，再显式允许本机浏览器；普通用户终端不需要这一步。

首次启动会生成一个 starter bot；`GET http://127.0.0.1:8899/api/bots` 取 `id` 与 `threadId`，
然后：

```sh
curl -s http://127.0.0.1:8899/api/board
curl -s -X POST http://127.0.0.1:8899/api/board/projects \
  -H 'content-type: application/json' -d '{"name":"创意板"}'
curl -s -X PUT http://127.0.0.1:8899/api/board/tasks/<threadId> \
  -H 'content-type: application/json' -d '{"botId":"<botId>","projectId":"<projectId>","phase":"build"}'
```

也可以用仓库的隔离 fixture（临时 home、假引擎、随机端口）：

```sh
node --experimental-strip-types scripts/control-omb.ts launch
```

它打印 URL/PID/data 目录；Ctrl-C 停止并清理，只动临时目录。

一键真实 HTTP/SSE 验收（自动启动并关闭隔离服务器）：

```sh
node --experimental-strip-types scripts/verify-board.ts
```

它验证空板、建项目、单条归属、创建时带 `board`、归属失败回滚、过期版本 409、未知对话 400、
accepted verdict、SSE 整板帧和重取后的持久快照。自动化测试：

```sh
pnpm exec vitest run server/board server/routes/board.test.ts
```

## v1 边界

- 不做批量归集、不做看板内新建对话、不做跨 bot 移动对话。
- 看板不返回对话标题/消息；前端按 `botId + threadId` join `/api/bots` 快照。
- 不接 Builder；不写库迁移（JSON 文件 `board.json`，原子写，损坏时降级为空板）。
- 未完成：真实 Electron 渲染、成员只读面、生产发布。
