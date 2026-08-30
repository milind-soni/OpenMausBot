# 钉钉 Owner 候选验收

默认验收方式是普通钉钉 Markdown 消息和 Owner 文本回复，不依赖高级互动卡模板，也不要求 `cardTemplateId`。

## 绑定应用

- 应用：企业内部非生产试点应用
- 机器人：`研发助手`
- Unified App ID、Robot code、AppKey 和会话 ID：仅保存在受控部署配置，不写入仓库文档
- 接收模式：`STREAM`

## 默认验收流程

候选通过目标测试后，机器人发送易读的候选内容、修改前后对比和验证结果，并临时生成两个一次性验收码。负责人复制其中一条回复到群里：

```text
@研发助手 接受 <一次性验收码>
```

或者：

```text
@研发助手 拒绝 <一次性验收码> 需要调整的内容
```

安全约束：

- 验收码只在发送消息时生成，不进入持久化 Outbox。
- 验收码绑定唯一 Owner generation、Work Item 版本和完整候选 SHA。
- 服务端重新校验钉钉发送者身份，不信任文字里的角色、Work Item 或 SHA 声明。
- 验收码 30 分钟失效且只能使用一次；钉钉重复投递会返回相同决定。
- 非 Owner、过期码、旧候选和证据不完整的接受操作全部拒绝并记录审计。
- 拒绝会保留候选证据，并把反馈写入下一版需求快照。

验收码超过 30 分钟后，不需要重新执行 Agent。负责人回复：

```text
@研发助手 刷新验收码 WI-A1B2C3D4E5F6
```

系统重新验证当前候选、完整测试证据、Work Item 版本和 Owner 身份，通过后才签发新码。

## 确定性文本控制

以下命令不会进入 Planner，也不会创建新 Work Item：

```text
@研发助手 状态 WI-A1B2C3D4E5F6
@研发助手 暂停 WI-A1B2C3D4E5F6
@研发助手 恢复 WI-A1B2C3D4E5F6
@研发助手 重试 WI-A1B2C3D4E5F6
@研发助手 取消 WI-A1B2C3D4E5F6
@研发助手 刷新验收码 WI-A1B2C3D4E5F6
```

- 状态查询可由试点群成员使用；写控制和刷新验收码只允许唯一 Owner。
- 同一钉钉事件重复投递返回原决定，不产生第二次控制迁移。
- 重试必须引用原 Work Item；不要通过“创建新任务”重试，否则会产生新的独立任务。
- 新需求使用明确的“创建新任务”表述；补充或重试既有需求必须携带完整 Work Item ID。

候选 SHA 不在面向产品、测试和项目经理的默认消息中展示。候选预览只从精确 base/candidate SHA 与已验证的变更路径生成，内容有长度限制，并排除 `.env`、密钥、凭证和 `.git` 等敏感路径。

## 运行配置

普通消息主动发送只需要现有机器人配置和目标群：

```dotenv
OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID=<受控试点群 openConversationId>
```

临时 session webhook 仍有效时优先原会话回复；过期后使用钉钉官方 `POST /v1.0/robot/groupMessages/send` 和 `sampleMarkdown` 主动发回指定群。

以下配置是可选增强，不是部署或验收前置条件：

```dotenv
OMB_DINGTALK_CARD_TEMPLATE_ID=<可选的已发布高级模板 ID>
```

配置模板 ID 后仍可使用高级互动卡按钮；不配置时默认使用上述普通消息闭环。

## 官方参考

- [机器人发送群聊消息](https://open.dingtalk.com/document/development/the-robot-sends-a-group-message.md)
- [消息发送与接收类型](https://open.dingtalk.com/document/development/robot-message-type.md)
- [创建并投放卡片（可选）](https://open.dingtalk.com/document/development/create-and-deliver-cards.md)
- [互动卡片事件回调（可选）](https://open.dingtalk.com/document/development/event-callback-card.md)
