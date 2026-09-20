# dsh-md-memory 0.1.15

DSH Desktop 上下文记忆与压缩增强插件。

## 本版更新

- 模型硬上下文与路由最大输出改为从 DSH 后端 `resolveModelInfo` 动态读取。
- 正常请求按 15 秒短缓存刷新；上下文设置页刷新和保存时强制重新读取后端能力。
- 后端暂时不可用时沿用最近一次有效能力值，并在 UI 标出旧值状态。
- 保留 0.1.14 的预算预检、VAC-GC/原生压缩重试、安全输出降额和 `max-tokens` 自动续写。

## 安装

```powershell
npm install --legacy-peer-deps .\dsh-md-memory-0.1.15.tgz
```

安装后重启 DSH Desktop。上下文页的“预算与压缩设置”卡片会显示后端当前返回的硬上下文上限和最近更新时间。

## 校验

请使用 `SHA256SUMS-0.1.15.txt` 校验发行文件。

## 许可证

MIT License
