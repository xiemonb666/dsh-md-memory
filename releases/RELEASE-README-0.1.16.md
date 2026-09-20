# dsh-md-memory 0.1.16

DSH Desktop 上下文记忆与压缩增强插件。

## 本版更新

- 读取 DSH 后端 `/models` 的实时模型能力，识别 vLLM 的 `max_model_len: 262144`。
- 后端容量变化时不要求先修改 DSH `settings.yaml`；设置页刷新/保存立即重新探测。
- 保留 `resolveModelInfo`、15 秒 TTL、预算安全降额和后端故障回退路径。

## 安装

```powershell
npm install --legacy-peer-deps .\dsh-md-memory-0.1.16.tgz
```

安装后重启 DSH Desktop。上下文页“预算与压缩设置”卡片会显示后端探测到的硬上下文上限。

## 许可证

MIT License
