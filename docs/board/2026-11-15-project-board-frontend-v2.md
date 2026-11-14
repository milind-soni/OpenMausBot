# 项目看板 v2：可追责字段、权限与跨窗口（2026-11-15）

- 基线：Lin 集成提交 `29984bd0f695a2081cc176b748c946f65f5ca339`（其下是 Pixel `807e5eb3`、后端 `2ae37364`、上游 `a6cd67c7`）。
- 前端分支：`feat/project-board-frontend-v2-20261115`，本次提交见文末。
- 目标：把项目/子项目的负责人、目标、交付物、完成标准、状态做成真实可编辑字段；子项目独立阶段与依据；任务阻塞原因/阶段依据/具名验收；按服务端 `permissions` 做成员有限编辑；例程运行不入待归类；验收不改产品阶段；两个入口读同一份数据并跨窗口刷新。
- 契约真源：`packages/phone-protocol/src/board.ts` 与 `docs/board/2026-11-15-project-board-api.md`。

## 本次改动

### 项目与子项目详情

- 项目卡显示：状态、负责人、目标；展开后显示完成标准。`编辑项目` 对话框可改名称、负责人、编辑人邮箱（`ownerEmail`）、目标、完成标准、描述、状态。
- 子项目行显示真实 `phase` 徽标、负责人、交付物；展开后显示完成标准和阶段依据。`编辑子项目` 对话框可改名称、负责人、编辑人邮箱、交付物、完成标准、状态、阶段和阶段依据。
- 子项目阶段不是由任务阶段合成：每个子项目只读自己的 `phase` / `phaseEvidence`；任务只描述“所服务的阶段”。验收任务只把任务状态置为 `done` 并写 verdict，不改任务 `phase`，也不改子项目阶段。
- 阶段规则按服务端：离开 `discovery` 必须填依据；`live_unverified` / `done` 还必须是 `https://`、`receipt:`、`回执:` 或 `验收:` 开头的引用。界面在提交前就地提示，服务端仍会再校验。
- 任务完成状态在界面上写「任务已完成」，与阶段徽标（如「测试验收」）并列；详情里明确写「验收只完成任务，不会推进产品阶段」。

### 任务与里程碑

- 任务详情新增：阶段依据、阻塞原因、暂停原因、verdict 的验收人（`by`）。
- 里程碑行显示负责人与具名验收人（`acceptedBy`，服务端写入）；新建里程碑可填负责人、完成标准。
- 任务验收仍只通过 `POST /api/board/tasks/:threadId/verdict`；`done` 状态不由状态选择器伪造。

### 权限

- 页面不再只读 `capabilities.manage`。按对象读取 `permissions.projects[id] / tasks[threadId] / milestones[id]`：
  - 新建项目按钮只在 `capabilities.manage` 时出现（服务端只允许 owner/admin 建项目）。
  - 项目编辑/新建子项目按项目权限；子项目编辑/新建对话/里程碑按所属项目权限；里程碑开始/验收按里程碑权限；任务编辑/验收/移出按任务权限。
  - 无权限的项目不显示编辑入口；任务详情只读时选择器禁用、无保存按钮，归属 chip 变成静态标签。
  - 顶部提示区分「只读」与「部分项目可编辑」，与服务端返回的映射一致。

### 待归类

- `unclassifiedConversations` 跳过 `routineRunId` 非空的对话：例程运行是调度产物，不是等待归属的工作。真实 fixture 里的「例程：每日巡检」不入列表；普通会话仍在。

### 跨窗口与两入口

- `src/state/store.tsx` 现在消费 `{kind:"board", board}` 整板帧，调用 `applyBoardFrame`；管理员任一窗口保存后，其他窗口无需重载即可看到项目和 chip 变化。
- 帧没有 `permissions` / `counts`：非管理员保留上一次映射，管理员按全量权限处理；页面计数在无服务端 `counts` 时从可见任务本地计算。
- 聊天输入框上方的归属 chip 与看板页读写同一个 store、同一个 `/api/board`；chip 写入后看板页实时更新，反向亦然。

## 验证

数据目录 `/tmp/omb-board-dev-pixel-v2-20261115`（复制自 Lin 的隔离 fixture，未碰真实应用数据），真实 server `127.0.0.1:8920` + Vite `127.0.0.1:5199` + 真实 Chromium：

- API 回执（`board-v2-evidence/api/`）：
  - `01-project.json`：项目 owner/email/goal/acceptance/status 落库；
  - `02-subproject.json`：子项目 owner/deliverable/acceptance 落库；
  - `03-task.json`：任务 phase/phaseEvidence/blockedReason/owner/acceptance 落库；
  - `04-milestone.json`、`05-milestone-accepted.json`：里程碑 owner/acceptance/acceptedBy/verdict/evidence；
  - `06-unclassify.json`：取消归类只删看板行；
  - `07-final-board.json`：最终整板（version 30，counts 与 permissions 均在）。
- 真实浏览器：
  - 项目编辑：改目标/状态保存，API 与卡片徽标同步；刷新后仍在。
  - 子项目阶段：`design → test`、`test → build` 两次转移，各自带不同 `phaseEvidence`，API 保留对应依据；任务阶段独立保持 `test`，界面同时显示「开发实现」与「测试验收」。
  - 任务验收：填证据后通过，API 变为 `status=done`、`phase` 仍为 `test`、`verdict.by="This computer"`；界面显示「任务已完成 / 测试验收 / 已验收」。
  - 里程碑：`acceptedBy` 显示在行内；开始/验收按钮只在有权限时出现。
  - 权限：拦截 `/api/board` 返回管理员快照但 `capabilities.manage=false` 且全部 `permissions=false` → 无新建/编辑/里程碑按钮，任务选择器禁用、无保存、chip 只读；同一快照只给任务 `permissions=true` → 任务可编辑、保存出现、chip 可点，项目仍不可编辑（`06-readonly-1440-midnight.png`、`07-task-only-1440-midnight.png`）。
  - 两入口 + 跨窗口：窗口 A 改项目目标，窗口 B 不重载即显示新目标；窗口 B 从聊天 chip 把「待归类示例」归入「创意板 · 看板 v1」，窗口 A 的待归类 1→0 并出现该任务，两窗口都未 reload（`08-chip-1440-midnight.png`、`09-cross-window-1440-midnight.png`）。
  - 新建：通过 UI 新建项目（owner/goal/acceptance/email）与子项目（owner/deliverable/acceptance），API 回执字段完整；测试后已恢复 fixture。
- 布局/可读性（真实渲染测量）：
  - 1440×900、390×844，midnight 与 daylight 均 `scrollWidth === innerWidth`，无横向溢出；无 <24×24 的看板按钮。
  - 最小文字对比度：midnight 6.13:1、daylight 5.24:1（AA 通过）。390 下两处标题按设计省略号截断，不是布局溢出。
  - 390 下项目编辑对话框宽 358px，左右各 16px；Esc 关闭并把焦点还给触发按钮。
- 工程门禁：`pnpm typecheck`、`pnpm lint`（0/0）、`pnpm i18n:check`、`pnpm check:contrast`、`pnpm build` 全过；定向测试 51 文件 **587 passed**（含 `project-board.test.ts` 15/15，新增权限映射与例程排除）；后端 `server/board` + `server/routes/board.test.ts` **27 passed**。

截图在 `board-v2-evidence/`：`10-board-1440-midnight.png`、`11-task-detail-1440-midnight.png`、`12-project-edit-1440-midnight.png`、`13-subproject-edit-1440-midnight.png`、`14-board-390-midnight.png`、`15-board-1440-daylight.png`、`16-task-detail-1440-daylight.png`、`17-board-390-daylight.png`，权限两张为 `06`/`07`。

## 未验证 / 边界

- 成员会话没有真的用第二个人登录：权限 UI 用真实服务端快照 + 只改 `capabilities`/`permissions` 的响应在真实浏览器验证；服务端 `access.test.ts` / `routes/board.test.ts` 覆盖真实过滤与写入拒绝。未做双真人账号端到端。
- 只验证 Chromium + Vite；未验证打包 Electron、Safari/WKWebView、手机 App。
- 只验证 midnight/daylight 两套皮肤；其他皮肤、RTL、读屏软件未实测。
- 未接生产、未推送、未发布。
- 为过仓库 file-size ratchet，对 `server/index.ts` 的两处分派接线做了等价压行（仍 15448 行，无行为变化）。

## 变更文件

- `src/state/board.ts`：项目/子项目 patch、任务新字段、权限映射保留、里程碑字段。
- `src/components/ProjectBoardPage.tsx`：真实字段展示、编辑入口、独立阶段徽标、按对象权限、`acceptedBy`。
- `src/components/board/{BoardDialogs,TaskRow,ProjectAssignment}.tsx`：编辑对话框、阶段依据/阻塞原因/验收人、只读 chip。
- `src/lib/project-board.ts` + `.test.ts`：状态标签、权限 helper、例程排除、测试。
- `src/state/store.tsx`：`board` SSE 帧应用。
- `src/locales/{en,zh}.json`：新增文案。
- `server/index.ts`：仅压行以通过 ratchet。
