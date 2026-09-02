# Release Room · 发布验收室

这是一个独立、非生产、无真实数据的 UI 试点工程，用于验证 Codex 与钉钉协作闭环。

## 基线能力

- 发布检查项及就绪度统计
- 状态筛选与文本搜索
- 新增检查项
- 切换就绪状态
- 阻塞项决策提示
- 桌面与移动端响应式布局
- 可访问性标签与减少动态效果支持

## 本地运行

```bash
npm ci
npm run dev
```

访问 `http://localhost:3000/`。

## 验证

```bash
# 无第三方运行时依赖，供隔离 Agent 使用
node --test tests/source-contract.test.mjs

# Codex 基线完整验证
npm test
npm run lint
```

## 试点边界

- 只使用静态演示数据，不连接外部 API。
- 不存放任何账号、令牌、Webhook 或生产信息。
- 钉钉 Agent 默认只允许修改 `app/**` 和 `tests/**`。
- 依赖变更、联网、部署和修改控制服务不属于普通需求范围。
- 每次候选结果必须通过离线源契约测试。
- 机器可读的接入参数保存在 `PILOT_MANIFEST.json`，切换脚本必须以该文件为唯一配置来源。

下一条建议的钉钉任务见 [NEXT_DINGTALK_TASK.md](./NEXT_DINGTALK_TASK.md)。
