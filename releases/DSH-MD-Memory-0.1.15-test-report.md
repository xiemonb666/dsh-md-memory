# dsh-md-memory 0.1.15 实测报告

## 代码验证

- `npm test`：279/279 通过。
- 新增后端模型能力归一化测试：支持当前 `context.contextWindow` / `defaultMaxTokens` 结构，以及旧适配器的 `maxContextTokens` / `maxOutputTokens` 结构。
- 预算保护仍覆盖 `contextWindow=200016`、输入 `134481`、输出 `65536` 的 400 回归场景。

## 动态上下文能力

- 请求链路从 DSH `llm.resolveModelInfo(provider, model)` 读取后端能力。
- 正常请求使用 15 秒 TTL，避免每个 agent step 重复访问后端元数据。
- 设置页 `settings/get` 刷新和 `settings/set` 保存都强制刷新，目标上下文和最大输出始终按最新硬上限校验。
- 后端读取失败时保留最近一次有效值，首次读取失败则安全降级为无模型能力，不阻塞宿主启动。

## DSH Desktop

- 已将 `dsh-md-memory-0.1.15.tgz` 安装到 `C:\Users\xiemo\.dsh\profiles\desktop\node_modules\dsh-md-memory`。
- 安装后版本读取为 `0.1.15`，DSH Desktop 已重启。
- 完整 UI 自动化复测受当前环境 Trusted RPC 未配置限制；代码层 RPC、渲染和宿主兼容测试均通过。
