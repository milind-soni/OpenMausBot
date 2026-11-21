# Companion 协议（Android 客户端实现的部分）

这份文档记录 App 实际依赖的接口与语义，来源是上游仓库的 `server/index.ts`、`shared/wire.ts`、`companion/src/routes.ts` 以及 `docs/ios-companion.md`。改客户端或接真 harness 时按这里对齐。

所有请求都是 JSON；除配对和健康检查外，都带 `Authorization: Bearer <deviceToken>`。

## 配对

```
POST /api/pair
{ "credential": "<配对码或链接里的 token>", "deviceName": "Xiaomi 15 Pro" }
→ 200 { token, device: { id, name, ... }, serverName, endpoints? }
```

桌面端生成的链接：

```
openmausbot://pair?address=192.168.1.8&port=8787&token=omb_pair_<43 位 base64url>
  &code=123456&name=Mac%20Studio&hosts=…&endpoints=…&secretKey=…
```

`endpoints` 可能是逗号分隔的 `host:port` 列表，也可能是 base64url 编码的 JSON。App 会按顺序尝试，一个都不通就报错，不会静默改用别的地址。

健康检查：`GET /api/health`（配对前用来判断地址是否可达）。

## 读

| 路由 | 用途 |
| --- | --- |
| `GET /api/bots?messages=50` | bot 列表 + 最近消息 + 分组 |
| `GET /api/config` | 服务端名称、能力开关 |
| `GET /api/instances` | 可用模型（`modelSelection` 的来源） |
| `GET /api/threads/{threadId}/messages?limit=50&before={id}` | 历史分页，返回 `{messages, hasMore}` |
| `GET /api/attachments/{path}` | 附件与图片 |

`WireBot` 字段：`id, name, title, description, color, threadId, mainThreadId, tasks[], unread, pinned, hidden, busy, activity, modelSelection, notifications`。

## 写

| 路由 | body | 说明 |
| --- | --- | --- |
| `POST /api/bots/{botId}/messages` | `{threadId, text, clientId?, attachments?}` | 202，回执不代表回复完成 |
| `POST /api/threads/{threadId}/respond` | `{requestId, behavior}` | **审批/回答卡片只能用这个路由** |
| `POST /api/bots/{botId}/read` | `{threadId}` | 清未读 |
| `POST /api/bots/{botId}/interrupt` | `{threadId}` | 停止当前回合 |
| `POST /api/bots/{botId}/always-allow` | `{threadId, requestId}` | 只对服务端已下发的 key 生效 |
| `POST /api/bots/{botId}/model` | `{threadId, modelSelection}` | 切换模型 |
| `PATCH /api/bots/{botId}` | 任意可改字段 | 改名、pin、隐藏、通知 |
| `POST /api/attachments` | multipart | 图片上传，返回引用路径 |
| `POST /api/groups/{groupId}/messages` | `{text}` | 房间群发 |
| `POST /api/bots/{botId}/tasks` | 任务字段 | 派发任务 |

### 卡片的 `behavior`

- `allow` / `deny`：普通审批。
- `answer`：问题卡片，需同时带 `message`（用户选的选项或自由输入）。

> 早期实现曾把回答发到 `/api/bots/{id}/respond` 并用 `behavior/answer/option` 字段，服务端不会识别。以上表为准。

## SSE

```
GET /api/events
Last-Event-ID: <上次收到的 id>
```

每帧 `id: <递增>\ndata: <json>\n\n`，超过 20 秒没有事件时服务端发注释行保活。JSON 的 `kind`：

| kind | 含义 |
| --- | --- |
| `hello` | 连接建立，`resumed` 表示是否续上了游标 |
| `bot` | 单个 bot 快照（状态、未读、任务） |
| `bots.order` | 列表顺序变化 |
| `group` / `group.deleted` | 分组增删改 |
| `message` | 新消息（含流式占位消息） |
| `message.patch` | 流式增量，按 message id 合并 |
| `thread` | 会话元信息变化 |
| `notify` | 需要弹通知的事件 |
| `config` | 服务端配置变化 |

客户端行为：断线后按 1–15 秒抖动退避重连，带 `Last-Event-ID`；收到 `message` 时按 `clientId` 去重，把本地乐观发送的 `pending` 气泡替换成服务端版本。游标按电脑分别持久化。

## 兼容性注意

- 字段都是宽容解析：未知字段忽略，缺失字段给默认值（`data/Models.kt`），避免上游小改动直接把界面打崩。
- `activity` 与 `busy` 可能不同时出现，界面以 `busy` 优先。
- 消息的 `kind` 目前见到 `text`、`options`（审批/问题卡片）、`tool`、`image`、`file`；未知 kind 按纯文本兜底。
