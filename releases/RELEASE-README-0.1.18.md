# dsh-md-memory 0.1.18

此版本修复长会话压缩摘要与项目记忆同步反复触及生成上限的问题。MML 预设将摘要输出上限和记忆同步输出上限设为 32768 tokens。普通对话输出预算仍单独配置。

安装：

```powershell
npm install --legacy-peer-deps .\dsh-md-memory-0.1.18.tgz
```

安装后重启 DSH Desktop，并在新会话中选择 `standard-mml` 或 `minimal-mml`。

发行文件包括 npm 包、源码 zip、完整 release zip、SHA256 清单和实机验证记录。
