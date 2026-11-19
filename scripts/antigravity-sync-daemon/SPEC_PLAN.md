# SPEC_PLAN.md - Antigravity Sync Daemon & Backup Gateway

## 1. 目标
1. **备份网关接入（备用通道）**：
   在 OpenMausBot config.json 中配置实例 ntigravity-local-gateway 指向 http://127.0.0.1:8045/v1，key: <dynamic_key_from_gui_config>，保留原生 ACP 为主要渠道，该网关仅作为备用。
2. **后台自动化同步守门服务（核心修复）**：
   开发轻量高效 Node.js 守护进程 ntigravity-sync-daemon.mjs：
   - 监听 ~/.antigravity_tools/accounts.json 变动（fs.watch + 3s 去抖防抖）。
   - 解析当前目标账号与可用账号池，筛选具有 Google icode 作用域的健康 PRO 账号。
   - 当检测到当前账号配额归零、被禁用或工具箱手动切号时，自动触发向 OpenMausBot 所有 Antigravity 实例（或目标 Bot 所在实例）同步最新有效 token。
   - 解决进程占用写盘冲突：针对目标 profile 目录的 token 进行原子写入，必要时对空闲 runtime 做微毫秒级安全让渡。
   - 注册 Windows 后台自动启动任务（Startup / VBS 后台无窗口驻留），系统开机即自启，静默守护。

## 2. 四阶 DAG 规划
- Stage 1: 软件架构师 -> 架构契约与自愈规约锁定 (SPEC_CONTRACT.md)
- Stage 2: 全栈开发 -> 网关实例配置 + 守护进程实现 (daemon + autostart + CLI)
- Stage 3: 测试质保员 -> 端到端事件触发、切号验证与 Exit Code 0 测试套件
- Stage 4: 代码评审员 -> 安全审查、凭证加密与规范验收 APPROVE
