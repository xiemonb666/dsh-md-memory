# dsh-md-memory 0.1.14

0.1.14 增加“预算与压缩设置”面板，并把路由设置保存到 DSH profile 的原生 `dsh-md-memory` settings 命名空间。插件在请求前按模型硬上限、输入投影和安全余量计算安全输出预算，支持压缩重试、旧适配器上下文错误恢复和可配置的 `max-tokens` 自动续写。

## 安装

退出 DSH Desktop 后，在 PowerShell 中执行：

```powershell
Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "<解压目录>\dsh-md-memory-0.1.14.tgz" --config.auto-install-peers=false --config.strict-peer-dependencies=false --ignore-scripts
```

重新启动 DSH Desktop，并新建会话。打开“上下文”页即可看到“预算与压缩设置”。设置按 `provider/model` 隔离；安全预检、自动续写开关和续写次数立即生效，模型路由和原生压缩字段保存后对新会话生效。

## 发行内容

- `dsh-md-memory-0.1.14.tgz`：可安装 npm 包。
- `dsh-md-memory-0.1.14-source.zip`：源码与测试。
- `DSH-MD-Memory-0.1.14-实测报告.md`：实现、自动化测试与 DSH Desktop 启动验证。
- `SHA256SUMS-0.1.14.txt`：发行文件校验值。

## 预算规则

有效输出上限为：

```text
min(configuredMaxOutput, targetContextTokens - projectedInputTokens - safetyMarginTokens)
```

模型硬上限由 DSH 路由提供，插件不会虚增；输入过大时先按配置执行 VAC-GC/原生压缩，无法释放空间时降低本轮输出上限或返回明确的预算错误，避免必定失败的 400 请求。

## 兼容性

DSH Desktop 2.0.10 使用完整预算保护、压缩重试、设置持久化和自动续写。旧宿主若缺少 settings 或 agent 扩展点，会保留原有压缩路径并在能力状态中显示不可用项。
