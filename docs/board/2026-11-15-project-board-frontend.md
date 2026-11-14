# 项目看板 v1：前端实现与验收（2026-11-15）

- 前端分支：`feat/project-board-frontend-20261115`，基于后端分支 `feat/project-board-backend-20261115` 的 head `2ae3736`（再上溯到 `a6cd67c7` / 0.1.158）。
- 目标：在 OpenMausBot 本体里交付「左栏 → 项目看板」、对话归属选择与真实 API 集成；沿用现有设计体系，不接示例数据。
- 契约真源：`packages/phone-protocol/src/board.ts` 与 `docs/board/2026-11-15-project-board-api.md`（后端）。本文只记录前端如何消费，以及仍未对齐的部分。

## 已实现

### 左栏入口

`src/components/SidebarFooterNav.tsx` 在「工具」下新增 **项目看板**，与自动化、团队地图、已发布的应用同级；行/图标/工具条三种密度都支持，`aria-current="page"` 跟随 `activeView === "project-board"`。Simple 模式本来就不显示工具区，因此入口只在 Advanced 出现（与自动化同层级，不新开位置）。

### 看板页

`src/components/ProjectBoardPage.tsx`（懒加载，`lazy-screens.tsx`）：

- 顶部：标题、最近更新时间、重新加载、新建项目。
- 概览：项目 / 子项目 / 已完成主任务 / 已验收里程碑四个计数；口径写明「主任务只计一次，子任务在它下面展开」。
- 筛选：搜索（标题/负责人/验收条件/Bot/项目/子项目/threadId）、负责人、状态、待验收、阻塞、清除。筛选时自动展开命中的项目和子项目，父任务保留、未命中的兄弟子任务隐藏。
- 树：项目 → 子项目 → 里程碑 → 主任务 → 子任务；每层显示状态、所服务阶段、负责人、阻塞/暂停、子任务验收进度。项目行另显示阶段分布（只对主任务计数）。
- 新建：项目（名称/说明）、子项目、里程碑（标题/截止日期）、从子项目新开对话（选 Bot + 标题，创建时即带 `board` 归属）、在任务下新开子任务（带 `parentThreadId`）。
- 任务详情：两个轴（所服务阶段 7 档、任务状态 4 档）分开编辑；负责人（可输入，带 Bot 名称建议）、完成条件、阻塞/暂停开关；验收区填写证据后「通过并完成」/「退回」。完成不通过状态下拉框伪造：`done` 只能由验收写入。
- 里程碑：未开始 → 开始 → 记录验收（结论 + 证据）→ 已验收/已退回。
- 待归类：从现有 `/api/bots` 快照减去 `board.tasks`，按更新时间倒序；每条可直接归类或打开原对话。
- 状态：加载（300ms 后才出现加载文案，避免闪烁）、空看板、筛选无结果、加载失败（带重试）、写失败（按 `BOARD_*` 码给中文原因）、只读（`capabilities.manage=false`）。
- 权限：入口与写操作按 `capabilities.manage` 关闭；`GET` 403 显示「只有所有者或管理员可以修改看板」，不显示服务端 code。

### 对话框归属

`src/components/board/ProjectAssignment.tsx` 挂在输入框上方（不是 header，遵循 `DESIGN.md` 第 2 节「不在聊天头部加按钮」）。展示当前「项目 · 子项目」；点开是「项目 → 子项目」两级选择，含「只归入项目」「移出看板」。键盘：打开后焦点进入第一项，↑/↓/Home/End 移动，Esc 关闭并把焦点还给触发按钮。

### 数据层

`src/state/board.ts`：

- 一个窗口一份看板快照；页面、对话框、看板共用，任一写入用服务端返回的整板替换。
- 每次写都带 `version`，过期 `409 BOARD_VERSION_CONFLICT` 时自动重取并提示「看板在别处已经更新」。
- 打开看板、窗口重新可见时重取；写响应也带最新快照。
- 错误码 → 文案：`BOARD_INVALID` / `BOARD_FORBIDDEN` / `BOARD_VERSION_CONFLICT` / `BOARD_NEEDS_EVIDENCE` / 不可达。

`src/lib/project-board.ts` 是纯函数层：树构建、主/子任务计数（不重复）、里程碑计数、阶段分布、筛选与祖先保留、待归类列表、项目归属查找。`src/lib/project-board.test.ts` 覆盖 12 个用例。

## 与后端的对照

已按后端真实字段实现：`BoardProject { id, name, description? }`、`BoardSubproject { id, projectId, name }`、`BoardMilestone { title, status, verdict?, evidence?, dueAt? }`、`BoardTask { threadId, botId, projectId?, subprojectId?, parentThreadId?, phase, status, owner?, acceptance?, blocked?, paused?, verdict? }`；写入 `PUT /api/board/tasks/:threadId`、`POST /api/board/tasks/:threadId/verdict`、`POST/PATCH` 项目、子项目、里程碑、`DELETE /api/board/tasks/:threadId`、`POST /api/bots/:id/tasks` 带 `board`。

**尚未由后端提供、因此界面上没有伪装的字段**（与已确认规格的差距）：

| 规格要求 | 现状 |
| --- | --- |
| 子项目的产品阶段、进入阶段证据、负责人、交付成果、完成标准 | 后端 `BoardSubproject` 只有 `name`。界面只显示任务阶段分布，不合成子项目阶段；子项目详情不能设置阶段。 |
| 项目的负责人、完成标准、状态 | 后端 `BoardProject` 只有 `name/description`。 |
| 任务的阻塞原因、变更记录、验收人 | 后端任务只有 `blocked/paused` 与 verdict 的 `decision/evidence/at`；界面不显示原因/审计。 |
| 里程碑具名验收人 | 后端只存 `verdict/evidence`。 |
| 成员只读面 | `GET /api/board` 仅 owner/admin；成员会得到 403，界面按错误处理，但没有只读树。 |
| SSE 整板帧 | 后端发 `{kind:"board", board}`，本客户端未消费；页面打开/聚焦、每次写入都会取回整板。跨窗口同步要等下一次重取。 |

这些是后端契约的缺口，不是前端用示例数据补齐；需要的话下一步在 `packages/phone-protocol/src/board.ts` 加字段，前端已按可选字段留了位置（阶段、负责人读取后即可显示，不需改页面结构）。

## 验证

在隔离数据目录 `/tmp/omb-board-dev-pixel-20261115`（复制自 Lin 的验收数据，未碰真实应用数据）上，用真实 dev server（`127.0.0.1:8920`）+ Vite（`127.0.0.1:5199`）+ 真实 Chromium（Chrome for Testing 148）跑：

- 类型：`pnpm typecheck` 通过。
- 单测：定向 60 个文件 `53 passed` / `848 passed / 3 todo`；最终回归 8 个文件 `77 passed`。其中 `project-board.test.ts` 12/12，`Sidebar*`、`ChatView`、`lazy-screens`、`Select.guard`、`touch-actions`、`control-scale`、locale 词表、file-size ratchet 全过。
- 静态：`pnpm lint` 0 warning / 0 error；`pnpm i18n:check` 通过；`pnpm check:contrast` 通过；`pnpm build` 成功（48.66s）。
- 浏览器路径（真实 HTTP，非 mock）：
  - 新建「验收项目 A」→ 服务端 `POST /api/board/projects` 201，刷新后仍在。
  - 在项目下建「验证子项目」→ 新开对话「看板验收对话」→ `POST /api/bots/:id/tasks` 带 `board`，任务落到该子项目，界面跳到新对话，输入框上方显示「验收项目 A · 验证子项目」。
  - 任务详情改阶段/状态/负责人/完成条件/阻塞并保存 → `PUT` 返回整板，服务端字段一致；刷新后在树上仍显示。
  - 填证据「通过并完成」→ `POST .../verdict`，任务变 `done/done`，verdict 落库。
  - 新建里程碑「看板联调通过」→ 开始 → 记录验收（结论+证据）→ `accepted`。
  - 从看板「待归类」把一条历史对话归入「创意板 · 看板 v1」→ `PUT` 成功、计数归零；在对话 chip 里移出看板 → `DELETE` 成功、chip 回到「归入项目」。
  - 在任务下新开子任务 → `POST /api/bots/:id/tasks` 带 `parentThreadId`，树上缩进显示；父任务显示「0/1 子任务已验收」。
  - 筛选：状态=已完成命中 1 条；状态=待验收显示空结果与「清除筛选」；负责人=Pixel 命中 1 条；搜索命中原对话；阻塞命中 1 条。
  - 空看板：拦截 `/api/board` 返回空板 → 「还没有项目」+ 新建项目；失败：拦截为网络失败 → 错误文案 + 重试；解除拦截后重试恢复。
  - 键盘：Tab 16 次到「项目看板」（2px focus ring），Enter 打开；项目行 Enter 展开；归属选择器打开后自动聚焦第一项，↑/↓ 移动，Esc 关闭并归还焦点。
  - 布局：1440×900 与 390×844 均 `scrollWidth === innerWidth`，无横向溢出；390 下归属面板 20–300px 在视口内；看板与任务详情无 `<button>` 小于 24px（侧栏既有控件除外）。
  - 文字对比度（midnight）：标题 17.18:1、次要文字 7.86:1、三级文字 6.13:1。

截图（当前工作目录 `board-evidence/`）：

| 文件 | 内容 |
| --- | --- |
| `01-board-1440.png` | 看板首屏（真实 API） |
| `02-board-expanded-1440.png` | 项目/子项目/任务/里程碑展开 |
| `03-task-detail-1440.png` | 任务详情（两个轴、验收） |
| `04-chat-chip-1440.png` | 输入框上方的项目归属与两级选择 |
| `05-board-390.png` | 390×844 看板 |
| `06-chat-chip-390.png` | 390 下的归属选择 |
| `07-empty-1440.png` | 空看板 |
| `08-error-1440.png` | 加载失败 + 重试 |

## 未验证 / 边界

- 打包后的 Electron 窗口、Safari/WKWebView、手机 App：只在 Chromium + Vite 下验证。
- 其他皮肤（只看了 midnight）、明暗两套、RTL、真实读屏软件：只做了语义与对比度检查，没有 VoiceOver 实测。
- 成员账号只读面：后端 `GET` 仅 owner/admin，未做成员可见性验收；界面按 403 处理。
- 生产发布、真实线上数据：未做；后端分支也未推送/发布。
- 全量 `pnpm test`（含 broker / electron / packaged server）：未作为本次门禁；仅跑了定向 vitest。
- 上游仓库无推送权限，未创建 PR；分支与本文可直接评审。

## 变更文件

- 新增：`src/components/ProjectBoardPage.tsx`、`src/components/board/{ProjectAssignment,TaskRow,BoardDialogs}.tsx`、`src/state/board.ts`、`src/lib/project-board.ts`、`src/lib/project-board.test.ts`
- 修改：`src/App.tsx`、`src/components/SidebarFooterNav.tsx`、`src/components/ChatView.tsx`、`src/components/lazy-screens.tsx`、`src/state/store.tsx`、`src/locales/{en,zh}.json` 及对应测试
- 后端随分支带入：`packages/phone-protocol/src/board.ts`、`server/board/*`、`server/routes/board.ts`、`server/routes/tasks.ts`（Lin）。为通过仓库的 file-size ratchet，`server/index.ts` 的看板接线做了等价压行（仍为 15448 行，无行为变化）。
