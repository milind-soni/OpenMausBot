# 项目看板 v3：可见范围与批量历史归集（2026-11-15）

- 基线：Lin `12f53e6e87b955d9aec6724c09910cae71df4bbc`（其下为 Pixel `abe906bf` / `451ae9fb`、后端 `2ae37364`）。
- 前端分支：`feat/project-board-frontend-v3-20261115`。
- 目标：项目可见范围可显式设置并正确展示；历史对话多选后先预览、再显式确认，整批原子归集；冲突/权限失败保留选择、刷新、绝不部分写入；100 条上限清楚。

## 本次改动

### 项目可见范围

- 新建项目与编辑项目都加入「可见范围」：仅管理员、全体成员、指定邮箱/域名。新建默认仅管理员（与服务端默认一致），编辑显示当前值。
- 保存走真实 `visibility` 字段：`"admins"`、`"everyone"` 或 `{ people: [...] }`；服务端校验邮箱/@域名，前端只做空名单禁用。
- 项目卡显示当前范围（`data-project-visibility`），展开后显示成员可见性说明：管理员专属、全体成员可见、指定邮箱可见；并说明项目中的对话仍按各自可见性过滤。
- 只有对该项目有编辑权（`permissions.projects[id]` 或 admin）时才有编辑入口；只读角色看得到范围说明，看不到编辑/批量按钮。

### 批量历史归集

- 待归类区新增「批量归集」：逐条复选框（例程运行本来就不在列表）、目标项目、目标子项目（可只归项目）、全选、已选计数与「每次最多 100 条」提示；超过 100 时不再允许勾选更多，并显示分批提示。
- 「预览」调用 `POST /api/board/tasks/batch/preview`，逐条显示 `ready / already_assigned / missing / hidden / routine / conflict`，附原因与汇总计数；预览不写盘，也不会按标题/机器人名猜分类。
- 只有汇总里没有阻塞项（全部 ready/already_assigned）时才允许「确认归集 N 条」；确认带预览读到的 `version` 和同一批 `threads`，走 `POST /api/board/tasks/batch`。
- 服务端 409（版本冲突或 `BOARD_BATCH_CONFLICT`）、403：保留已选、刷新整板、显示「未写入任何一条；选择已保留」；版本冲突同时清掉旧预览，要求重新预览。界面不重试、不缩小批次、不静默部分写入。
- 成功后在原位显示「已归集 N 条；M 条原本就在目标」，清空选择，整板由写响应替换。

## 真实 API 回执（`board-v3-evidence/api/`）

- `01-preview.json`：2 条 `ready`，`version=30`，未写盘。
- `02-concurrent-assign.json`：预览后把其中一条单条归入子项目，板版本 31。
- `03-batch-stale.json`：用旧 `version=30` 确认 → **409 `BOARD_VERSION_CONFLICT`**；回执后板里只有并发单条写入的那条，另一条仍未归类（整批零写入）。
- `04-unclassify-a.json`：恢复该条为待归类。
- `05-preview-routine.json`：例程会话返回 `routine`（`routine runs are not work conversations`），普通会话 `ready`。
- `06-preview-ready.json` + `07-batch-success.json`：2 条 `ready` → 确认 `assigned: 2`，两条都在目标子项目。
- `08-limit.json`：101 条 → **400** `threads must contain 1 to 100 conversations`。
- `09-batch-conflict.json`：目标项目下已属另一子项目的任务作为一条 + 一条 ready → **409 `BOARD_BATCH_CONFLICT`**（`conflict=1`），ready 的那条仍未写入，板版本保持 48。

## 真实浏览器验收

数据目录 `/tmp/omb-board-dev-pixel-v2-20261115`（隔离 fixture，新增 3 条历史对话 + 1 条例程会话），真实 server `127.0.0.1:8920` + Vite `127.0.0.1:5199` + 真实 Chromium：

- 可见范围：新建默认 `admins`；编辑改为 `everyone` 保存后 API 为 `"everyone"`、卡片显示「全体成员」；再改为指定邮箱 `pixel@example.com, lin@example.com`，API 返回 `{people:[...]}`，卡片显示两个邮箱与「只有这些邮箱和域名能看到」。
- 只读：拦截 `/api/board` 返回真实快照但 `capabilities.manage=false`、所有 `permissions=false` → 编辑按钮 0 个、批量入口不出现，范围与说明仍显示。
- 批量成功：选 2 条 → 预览 `ready 2`、总 2、版本 35 → 确认 → 「已归集 2 条」，待归类从 4 变 2。
- 批量冲突：再选剩余 2 条预览，确认前用单条 API 归入其中一条 → 确认返回 409，界面显示「未写入任何一条；选择已保留」，已选仍为 2/100，另一条仍未归类（`data-batch-nowrite`）；预览被清掉并要求重试。
- 布局：1440×900 与 390×844、midnight 与 daylight 均无横向溢出；看板与批量面板无 <24×24 控件；最小对比度 midnight 6.13、daylight 5.24；390 下项目编辑/可见范围对话框宽 358px（左右 16px），批量面板无裁剪。

截图在 `board-v3-evidence/`：`10-board-1440-midnight.png`、`11-project-visibility-1440-midnight.png`、`12-batch-preview-1440-midnight.png`、`13-batch-preview-390-midnight.png`、`14-board-1440-daylight.png`、`15-batch-preview-1440-daylight.png`、`16-batch-preview-390-daylight.png`、`17-board-390-midnight.png`、`18-visibility-dialog-390-midnight.png`、`19-board-390-daylight.png`、`20-batch-390-preview.png`；成功/冲突/只读另有 `01`–`09`。

## 工程门禁

- `pnpm typecheck`、`pnpm lint`（0 warning / 0 error）、`pnpm i18n:check`、`pnpm check:contrast`、`pnpm build` 通过。
- 定向前端测试 51 文件 **588 passed**（`project-board.test.ts` 16/16，新增可见范围枚举测试）。
- 后端 `server/board` + `server/routes/board.test.ts` **30 passed**（含批量预览/原子写入/冲突）。
- 仓库 file-size ratchet：`server/board/store.ts` 1052 行，已按规则登记并注明原因；`server/index.ts` 保持 15448 行（同时修掉 Lin 新接线里的一个无意义 spread 警告）。

## 未验证 / 边界

- 批量确认的成员权限用真实服务端快照 + 只改 `permissions` 的响应在真实浏览器验证；没有第二个真人账号端到端。服务端访问/写入拒绝有测试覆盖。
- 100 条上限的 UI 提示与选择封顶已实现，但 fixture 只有 4 条未归类，未用 101 条真实会话做 UI 压力；API 侧已用 101 条验证 400。
- 仅 Chromium + Vite；打包 Electron、Safari/WKWebView、手机 App、其他皮肤、RTL、读屏软件未验证。
- 未推送、未发布，未改 Lin 工作区。

## 变更文件

- 新增 `src/components/board/UnclassifiedPanel.tsx`（普通/批量两种待归类视图）。
- `src/components/board/BoardDialogs.tsx`：可见范围字段（新建 + 编辑）。
- `src/components/ProjectBoardPage.tsx`：项目范围展示与说明，接入批量面板。
- `src/state/board.ts`：`visibility` 写入、批量预览/确认/错误类型。
- `src/lib/project-board.ts` + `.test.ts`：可见范围 helper 与测试。
- `src/locales/{en,zh}.json`：可见范围与批量文案。
- `server/index.ts`：修掉 `threadInfo` 的无意义 spread（行为不变）。
- `scripts/testing/file-size-ratchet.test.ts`：登记 `server/board/store.ts: 1052`。
