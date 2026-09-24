# dsh-md-memory 0.1.18 实测记录

## 修复

- 将 MML 预设中 DSH 原生摘要生成上限从默认 8192 提升到 32768 tokens。
- 将 Guardian 项目记忆同步输出上限从 16384 提升到 32768 tokens。
- 新预设生成器也写入这两个值；当前用户编辑过的 standard-mml / minimal-mml 已保留原配置并手动加上两项。

## 验证

- DSH Desktop 2.0.10 已安装 0.1.18 并重启。
- 重启日志确认 standard-mml 引擎挂载，`/dsh-md-memory` RPC 注册。
- 活跃预设配置确认 `maxTokens: 32768`、`syncMaxTokens: 32768`。
- `npm test`：281/281 通过。
- 日志里的旧截断记录来自 0.1.18 安装前；新配置开始用于重启后挂载的会话。
