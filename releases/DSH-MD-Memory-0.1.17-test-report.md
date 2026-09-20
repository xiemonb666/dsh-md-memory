# dsh-md-memory 0.1.17 实测报告

## 修复

- 修复 vLLM `/v1/models` 仅返回 `max_model_len` 时，插件把未知输出上限当成 `0` 的问题。
- `maxTokens=0` 现在按“未声明输出上限”处理，回退到路由的 `65536`，不会再因小输入报 `context budget leaves no output token`。
- 后端动态上下文仍读取 `max_model_len=262144`。

## 验证

- npm test：280/280 通过。
- DSH Desktop：2.0.10，插件安装版本 0.1.17。
- 当前路由：`vllm/qwen38-agent`。
- 后端返回：`max_model_len=262144`。
- 输入 741、目标上下文 262144、安全余量 2048、配置输出 65536：安全输出值 65536。
- DSH Desktop 已重启。
