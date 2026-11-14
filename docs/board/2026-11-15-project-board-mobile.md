# 项目看板手机 Web 入口收口（2026-11-15）

- 基线：`b35a5d1c661f39d210833431c0a373d01d8a0ec5`
- 分支：`feat/project-board-frontend-v3-20261115`
- 目标：手机 Web（浏览器 UI 的 Home Screen web app）能进入看板、看树、从任务回到对话、看到归属，成员权限生效。

## 问题与修复

手机底部工具菜单由 `src/components/SidebarPhoneBar.tsx` 提供，此前只有：自动化、团队地图、文件、已发布的应用、应用。**「项目看板」只在桌面侧栏 `SidebarFooterNav` 中出现，手机菜单漏了这一项**，所以手机宽度下没有正式入口；这不是 Electron 缩窗问题。

最小修复：在 `SidebarPhoneBar` 的 tools 菜单中加入「项目看板」，位置与桌面一致（自动化之后、团队地图之前），点击 dispatch `showProjectBoard`。新增 `SidebarPhoneBar.test.ts` 固定菜单项顺序，防止再次漏掉。

## 手机 Web 验收（真实 Chrome，非 Electron）

- 浏览器：Chrome for Testing（真实 Chromium），390×844 CSS viewport，`mobile:true`、DPR 1；不是 Electron 窗口缩到 390。
- 数据：隔离 server `127.0.0.1:8920`（`/tmp/omb-board-dev-pixel-v2-20261115`）+ Vite `127.0.0.1:5199`，HEAD 源码。
- 入口：底部工具按钮（`aria-label="工具"`）→ 菜单出现「项目看板」→ 打开看板；桌面侧栏同一入口仍存在。
- 树：390 宽显示 1 个项目 / 1 个子项目 / 2 个任务，项目→子项目→任务层级完整；`innerWidth=390`、`scrollWidth=390`，无横向溢出。
- 任务回跳：点任务的「打开对话」回到该会话，输入框出现，归属 chip 显示「创意板 · 看板 v1」。
- 权限：
  - 全只读快照（`capabilities.manage=false`、`permissions` 全 false）：看板 `data-board-manage=false`，项目编辑 0、批量入口 0；任务详情 `data-task-detail-editable=false`、无保存；390 下仍无横向溢出。
  - 任务级有限权限（项目 false、`4bd41bd7…` 的 task true）：项目编辑 0，任务详情 `editable=true`、保存出现，负责人可见；证明按 `permissions` 而非只看 admin。
- 截图：`board-mobile-evidence/00-tools-menu-390.png`（菜单含项目看板）、`01-board-390.png`、`01b-board-full-390.png`、`02-task-detail-390.png`（负责人/阶段）、`03-chat-chip-390.png`（归属 chip）、`04-readonly-390.png`、`05-readonly-task-390.png`、`06-taskonly-390.png`。

## 原生手机 App 边界

- 本仓库 `docs/phone-relay-server.md` 明确：原生 phone apps 在**另一个仓库**；本仓库只有浏览器 UI、配对/relay 服务端与测试参考实现 `companion/src/e2e/phone.ts`。
- 本机未发现可访问的原生手机仓库或已安装手机 App；没有 iOS/Android 工程、设备、签名证书、TestFlight/Play 账号或真机，因此**原生 App 未验收**。
- 原生实机验收至少需要：对应手机仓库源码权限 + iOS/Android 构建环境 + 真机/模拟器 + Apple Developer/签名或 Android keystore + 测试账号与可达的 HTTPS/relay 服务。
- 本材料只证明「手机 Web（浏览器 UI）」，不证明原生 App、Safari iOS、Android WebView 或真实手机。

## 未验证

- 物理 iPhone/Android、Safari/WKWebView、真实手机触控/软键盘、屏幕旋转、读屏。
- 真实第二账号成员在手机上的会话（权限用真实快照 + 改 `permissions` 响应验证；服务端有 30 个测试）。
- 正式签名安装包、原生 App、生产发布。
