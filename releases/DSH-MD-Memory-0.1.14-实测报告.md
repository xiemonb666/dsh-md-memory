# DSH MD Memory 0.1.14 实测报告

## 结论

0.1.14 已重新打包，并安装到本机 DSH Desktop 2.0.10 的 desktop profile。插件重启后正常加载，启动日志确认 root bundle、压缩引擎和包含 `settings/get`、`settings/set`、`settings/reset`、`settings/status` 的 RPC 路由均已注册。自动化测试 278/278 通过。

本版重点解决输入上下文与输出上限相加超过模型容量时的必定失败请求：以硬上限 200016、输入 134481、配置输出 65536、安全余量 2048 为例，安全输出预算为 `63487`，插件不会再按 65536 发出该请求；若压缩释放不足，则按配置重试，最终给出降额或可读错误并停止循环。

## 本版实现

- 新增 `dsh-md-memory` 原生 settings 命名空间，按 `provider/model` 保存路由设置，使用 DSH settings provider 的 revision/原子更新。
- 上下文页新增预算与压缩设置卡片：硬上限和路由最大输出只读；目标上下文、最大输出、安全余量、阈值、保留预算、压缩/溢出重试、自动续写均可编辑。
- 上下文单元表的标题、列名和每行值均加入原生鼠标悬停提示；“上下文单元 65”表示当前计划识别出的 65 个连续事件组，提示会解释 Unit、Tokens、Tier、分数和原因及对应值。
- 项目记忆页的 INDEX、PROJECT、STATE、DECISIONS、TECH、HISTORY、CONFLICTS 文件项及搜索结果也加入中文悬停说明，用户无需打开文件即可知道各文件负责什么。
- `agent/pre-step` 计算投影输入；当“输入 + 配置输出 + 安全余量”已经超出目标时，会先按配置次数压缩，再对剩余输出安全降额。`agent/request` 将本轮 `maxTokens` 与安全预算保持一致；`agent/request-error` 支持标准 `CONTEXT_WINDOW_EXCEEDED` 和不带统一错误码的旧适配器文本错误。
- 自动续写只响应 `reason.kind === "max-tokens"`，按路由设置限制 0–10 次，同一回合去重；正常完成、错误、取消和真实用户新输入会清零。
- 兼容旧宿主缺少 `data.turn` 的情况：续写去重同时使用 `turn/end` 的事件序号，避免同一事件重复投递时重复排队，也避免不同回合都被误判成同一回合。
- 溢出恢复计数按同一 `session/turn/step` 请求键保留；重试重新进入 `agent/pre-step` 时不会清零，缺少预算记录的旧适配器也会创建受限回退记录，不会无限重试。
- `agent/pre-step` 对旧宿主缺少 `AbortSignal` 的事件也安全降级，不会因直接读取未定义 signal 阻断请求。
- 原生压缩、会话标题和摘要请求保留独立用途预算；旧宿主能力不足时保留原有压缩并通过 RPC 能力状态报告。
- 项目目标判断已加强：识别“项目目标/需求/范围/必须实现”等明确表达，也识别“优化项目、修复 BUG、检查项目进展”等项目工作语句；目标消息立即触发一次记忆同步，状态询问优先读 STATE；Guardian 在有可验证原文时优先写入 `REQ`，不再只写 `STATE`；C3/C4/C5 记忆注入会读取 ACTIVE 项目需求。
- 历史同步记录把模型的自然语言说明标记为 `model-note`，与真正通过证据门禁提交的 `ops` 分开，避免“模型说已添加 REQ”被误认为已经落盘。设置保存失败时，界面会显示后端返回的具体字段（例如目标上下文或保留预算），而不是只有笼统错误。
- 实机日志审计发现 DSH session 的正式替换字段是 `surfaceOp.startSeq/endSeq`，早期夹具使用的 `start/end` 会让 Phase 2 剪枝被宿主拒绝。现已改为正式字段，并让落地测试夹具严格执行同一 schema，避免 VAC-GC 只规划不落地。

## 自动化测试

- `npm test`：278/278 通过，0 失败。
- 覆盖设置 schema 范围、硬上限、目标上下文与输出关系、阈值与保留预算关系、默认续写、预算安全公式、无空间错误和旧错误文本识别。
- 使用 DSH 2.0.9 的真实 `@deepseek-ai/dsh-session` 跑了 Phase 2 `landNodePrunes`：真实会话接受 `startSeq/endSeq` 替换，surface 从原始结果节点切换到替换节点，返回 `charsSaved=285`。
- `node --check lib/index.js lib/root.js lib/client.js lib/settings.js`：通过。
- `npm pack`：生成 `dsh-md-memory-0.1.14.tgz`，包内包含 `lib/settings.js`、预算保护和上下文设置界面。

## DSH Desktop 2.0.10 安装验证

安装依赖为：`file:C:/Users/xiemo/Documents/Codex/2026-09-14/bug-dsh-desktop-dsh/outputs/dsh-md-memory-0.1.14.tgz`。

安装目录为：`C:\Users\xiemo\.dsh\profiles\desktop\node_modules\dsh-md-memory`，读取到版本 `0.1.14`。停止并重新启动 DSH Desktop 后，最新 host 日志出现：

- `md-memory-root: bundle entry active (preset provisioning complete)`
- `md-memory: enabled (... vacgc=prune)`
- `md-memory: RPC route /dsh-md-memory registered (status, read, search, sync, settings.*, ...)`

这确认最终发行包已被宿主加载。当前自动化环境能直接验证安装、重启、版本、宿主日志和插件测试；DSH 原生窗口未向当前 CUA 会话暴露，因此无法在本次运行中代替用户点击 UI 保存/刷新设置，也不把该项写成已完成的 UI 操作验收。

## ArchaeoMatch 记忆链路

已检查 `C:\Users\xiemo\ArchaeoMatch\.dsh-memory`：revision 为 8，`INDEX.md` 显示 STATE 1、DECISIONS 2、TECH 4、HISTORY 7、CONFLICTS 0，最近同步为 2026-09-19T11:19:09.227Z，`.provenance.json` 的 unresolved 为空。DSH 日志还记录了该项目的请求预算从 65536 安全降到 60852，并执行了 context-overflow 的 VAC-GC 压缩；一次语义校验取消后安全回退到宿主原生压缩，未出现记忆账本冲突或未解析 provenance。

此前 `PROJECT.md` 只有模板并非文件损坏：同步历史中的 `note: Added REQ` 只是模型说明，实际 `ops` 没有 `ADD REQ`，所以没有通过证据门禁落盘。修复后，像“项目目标：完成 SfS++ 陶片匹配基线”会被分类为 C4；“这个项目的目标是什么？”会被分类为 C3，并在已有 REQ 时注入 PROJECT 内容。插件仍要求精确可验证的用户原文，不会凭空生成项目需求。

## 与原版压缩的关系

插件仍调用 DSH 原生摘要与持久化事务，摘要模型质量由宿主模型决定。相对原版新增了请求前预算保护、输入投影、按权重的 VAC-GC 选择、P0/P1/工具配对保护、压缩重试、旧错误兼容、Markdown 账本和可观测设置状态。因此提升主要体现在减少必定失败的 400、压缩调度和事实保留安全性；不能仅凭单次样本宣称摘要倍率一定高于原版。

## 发行文件

- `dsh-md-memory-0.1.14.tgz`
- `dsh-md-memory-0.1.14-source.zip`
- `RELEASE-README-0.1.14.md`
- `DSH-MD-Memory-0.1.14-实测报告.md`
- `SHA256SUMS-0.1.14.txt`
