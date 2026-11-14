# 项目看板 v1 后端契约（2026-11-15 集成版）

集成基线：Pixel 的 `807e5eb3`（其上是 `2ae37364` 后端 + 前端）。本分支
`feat/project-board-integration-20261115` 保留 `/api/board` 契约，在同一模块补入项目/子项目/任务/里程碑的
可追责字段、成员只读过滤、有限授权写入、审计、迁移和真实分派关联。

看板项目与 `bot.projects`（左栏文件夹）是两套实体；看板任务只按 `botId + threadId` 关联已有对话，
不复制标题、消息或权限。

## 数据

```ts
type BoardPhase = "discovery" | "design" | "build" | "test" | "release_ready" | "live_unverified" | "done";
type BoardTaskStatus = "todo" | "in_progress" | "review" | "done";
type BoardMilestoneStatus = "planned" | "in_progress" | "accepted" | "rejected";
type BoardProjectStatus = "active" | "paused" | "completed" | "archived";
type BoardVisibility = "everyone" | "admins" | { people: string[] };

interface BoardProject {
  id; name; description?;
  owner?; ownerEmail?; goal?; acceptance?; status?; visibility?;
  createdAt; updatedAt;
}

interface BoardSubproject {
  id; projectId; name;
  phase?; phaseEvidence?; owner?; ownerEmail?; deliverable?; acceptance?; status?;
  createdAt; updatedAt;
}

interface BoardMilestone {
  id; projectId; subprojectId?; title; status;
  verdict?; evidence?; acceptedBy?; acceptance?; owner?; ownerEmail?; dueAt?;
  createdAt; updatedAt;
}

interface BoardTask {
  threadId; botId;
  projectId?; subprojectId?; parentThreadId?;
  phase; phaseEvidence?; status;
  owner?; ownerEmail?; acceptance?;
  blocked?; blockedReason?; paused?; pausedReason?;
  verdict?: { decision: "accepted" | "rejected"; evidence; at; by? };
  createdAt; updatedAt;
}
```

- `ownerEmail` 是服务端判定“谁能改”的身份；`owner` 是展示名。二者不互相替代。
- `blocked`/`paused` 保留原布尔字段，新增原因字段；旧前端仍能显示状态。
- 任务 `status=done` 必须已有 `accepted` verdict；verdict 只改 `status`，**不改 `phase`**。
  产品阶段 `phase=done` 必须由服务端显式编辑并带 `phaseEvidence`，不能由验收自动生成。
- 子项目每次 `phase` 变更都必须带非空 `phaseEvidence`；`live_unverified`/`done` 还必须是线上回执
  或业务验收引用（`https://`、`receipt:`、`回执:` 或 `验收:` 开头）。变更 actor/time 入审计。
- verdict 的 `by`、里程碑 `acceptedBy` 由服务端写入，请求体不能指定。
- `accepted` 里程碑必须同时有非空 `verdict` 与 `evidence`；`acceptedBy` 由服务端写入。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/board` | 顶层快照，按调用者过滤；含 `capabilities`、`permissions`、`counts`。 |
| GET | `/api/board/audit?limit=100` | 仅 owner/admin；返回最近审计。 |
| POST | `/api/board/projects` | 仅 owner/admin；`name/owner/goal/acceptance` 必填，可带 `description/ownerEmail/status/visibility/version`。 |
| PATCH | `/api/board/projects/:id` | 项目 ownerEmail 或 owner/admin。 |
| POST | `/api/board/subprojects` | `projectId/name/owner/deliverable/acceptance` 必填；可带 `phase/phaseEvidence/ownerEmail/status/version`。项目 ownerEmail 或 owner/admin。 |
| PATCH | `/api/board/subprojects/:id` | 同上字段；项目 ownerEmail 或 owner/admin。 |
| POST | `/api/board/milestones` | `projectId`、`title`；可带 `subprojectId/dueAt/acceptance/owner/ownerEmail/version`。 |
| PATCH | `/api/board/milestones/:id` | `title/status/verdict/evidence/dueAt/acceptance/owner/ownerEmail/version`；项目 ownerEmail 或 owner/admin。 |
| PUT | `/api/board/tasks/:threadId` | `botId` 必填；可带 `projectId/subprojectId/parentThreadId/phase/phaseEvidence/status/owner/ownerEmail/acceptance/blocked/blockedReason/paused/pausedReason/version`。 |
| POST | `/api/board/tasks/:threadId/verdict` | `{ decision, evidence, version? }`；任务 ownerEmail 或项目 ownerEmail 或 owner/admin。 |
| DELETE | `/api/board/tasks/:threadId?version=N` | 只取消归类，不删除对话。 |

写响应统一 `{ board }`（verdict 另带 `task`）。`version` 可选；带上则做乐观并发，过期返回
`409 BOARD_VERSION_CONFLICT`。所有写操作递增 `version` 并广播整板 SSE；当前 SSE 只发 admin 会话，
成员页面在聚焦/写入后重取。

### 成员只读与有限写入

- GET 不需要 admin：先按项目 `visibility`（缺失按 `admins` 失败关闭），再按调用者已有的
  `VisibleSet.thread` / `VisibleSet.bot` 过滤任务。看板行不会扩大对原对话的访问。
- `capabilities.manage` 仅表示“可建项目、可改任意对象”。`permissions.projects/tasks/milestones`
  给出当前账号对每个对象的写权限；任务 owner 可改自己的任务并提交 verdict，项目 ownerEmail
  可改项目/子项目/里程碑/任务，其他成员只读。
- 看不到的项目/对话统一 `403 BOARD_FORBIDDEN`，不返回对象内容。
- `counts` 由服务端在过滤后计算：`topLevel` 只算没有可见父任务的节点，子任务单列，避免主子任务重复计数。

### 新对话归属

`POST /api/bots/:id/tasks` 仍支持可选 `board` 对象，和创建对话同一请求完成归属；失败会删除刚创建的
对话。字段与 `PUT /api/board/tasks/:threadId` 相同。成员可用，但服务端会把 `ownerEmail` 固定为本人，
不能把任务写给其他地址。

### 真实分派关联

`coordinate_bots` 或 `start_thread` 新建工作对话后，若源对话已经是看板任务，服务端自动写入
`parentThreadId = 源 threadId`，并继承项目/子项目/阶段（源阶段为 done 时子任务落到 release_ready）。
看板持久化失败只记日志，不把已经成功的工作交接改成失败。手动看板新建不是唯一入口。

### 错误

```json
{ "error": "BOARD_INVALID", "message": "..." }
```

`400 BOARD_INVALID`、`403 BOARD_FORBIDDEN`、`409 BOARD_VERSION_CONFLICT`、`422 BOARD_NEEDS_EVIDENCE`、
`503 BOARD_UNAVAILABLE`（文件更新版本或损坏，文件保持原样）。

## 迁移、备份与回滚

- 文件仍是 `board.json`，原子写、`0600`。格式 `version: 2`；旧 `version: 1` 在内存中补默认值：
  项目 `visibility = "admins"`、`status = "active"`，子项目 `phase = "discovery"`，其余新字段留空。
- 第一次写回时，先把原文件复制为 `board.json.v1.bak`（不覆盖已有备份），再写 v2。只读不会改文件。
- 旧项目默认 `admins`，避免升级时把原 admin-only 数据暴露给成员；新建项目默认 `everyone`
  （工作区成员可见），可用 `visibility` 收紧到 `admins` 或 `people`。
- 回滚：停服，恢复 `board.json.v1.bak`（或删除 `board.json` 得到空板），回退提交；对话、bot、
  messages 和数据库均未迁移，无需数据回滚。
- 更新版本/损坏文件返回 `503`，绝不写回或降级为空板。

## 测试与验收

```sh
pnpm exec vitest run server/board server/routes/board.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts -t "sends cross-bot work onward"
```

覆盖：项目/子项目/任务/里程碑可追责字段、必填字段服务端强制、blockedReason、verdict by、task verdict
不改 phase、phase done 证据、子项目阶段证据/线上回执、审计；双账号项目可见性与
原对话双重过滤、counts 不重复、项目 owner/任务 owner 的有限写入、隐藏对象拒绝；v1→v2 备份/迁移/
回滚、未来版本 503 且文件不变；真实 `coordinate_bots` 两层分派的 `parentThreadId`；创建对话时
`board` 归属失败回滚；SSE 整板帧。

## 边界

- 不做批量历史归集、不自动猜阶段/完成事实。
- 前端目前只按 `capabilities.manage` 展示按钮，成员即使有 `permissions` 也先看到只读；后续 UI
  再接 per-object 权限。
- SSE 仍只发 admin；成员靠重取。
- 未做生产发布/迁移；未在安装包内验证。
