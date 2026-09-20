# dsh-md-memory 0.1.16 实测报告

## 后端实测

- 当前 vLLM `GET http://192.168.1.10:30000/v1/models` 返回 `qwen38-agent.max_model_len = 262144`。
- DSH `settings.yaml` 仍为 200016；这正是之前插件界面显示 200016 的原因。
- 新增 OpenAI/vLLM `/models` 探测，插件能在不改 DSH 静态配置的情况下读取 262144。

## 代码验证

- `npm test`：279/279 通过。
- 覆盖 `max_model_len`、`context_length`、`contextWindow` 和旧适配器字段。
- 探测失败时回退到 DSH `resolveModelInfo`，再失败才进入安全降级，不阻塞宿主启动。

## DSH Desktop

- 目标安装路径：`C:\Users\xiemo\.dsh\profiles\desktop\node_modules\dsh-md-memory`。
- 0.1.16 安装后需重启 DSH Desktop；上下文页刷新/保存会强制探测后端。
