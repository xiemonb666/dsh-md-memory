# dsh-md-memory（Markdown Memory Ledger，MML）

当前发行版：**0.1.18**。

0.1.18 将 MML 预设的摘要输出与记忆同步输出上限分别调至 32768 tokens，避免长会话在 8192 / 16384 tokens 处被截断；普通对话输出预算仍由路由设置单独控制。

DeepSeek Harness（DSH）插件：以 **纯 Markdown 文件** 作为项目长期记忆台账，挂接在压缩（compaction）引擎上。

## 设计

- **原始上下文 = 短期记忆**；**`<项目根>/.dsh-memory/*.md` = 项目长期记忆**；**压缩摘要只做桥接**，不承载长期信息。
- 压缩前把"待压缩前缀"交给 LLM 守护进程（sync）提炼进台账；压缩摘要本身保持与 `dsh-compaction-basic` **逐字节一致**（不改变你调好的压缩策略）。
- 每个 agent 的 system prompt 按**自适应懒注入**（P1-④）按需注入台账视图：待处理的用户消息先经**规则优先的 C0–C5 分类器**（无 LLM 分类器）分级，只注入该级的 **token 预算**（C0 0 / C1 0 / C2 ≤768 / C3 ≤2048 / C4 ≤4096 / C5 ≤8192）——C0/C1 **零常驻注入**，C2 只给 STATE，C3 加相关条目，C4 加路由 + 相关 ACTIVE 决策/TECH，C5 才是全量视图。旧的 ≈6K 字符常驻转储已废除（"一边往 context 里灌水，一边努力排水"）；台账经 `memory_search` / `memory_read` 与"项目记忆"UI 始终可达。条目级注入**整条进出**（绝不在条目中间截断，模型不会看到半个决策）；唯一可截断的是 STATE-CURRENT（按行边界 + 截断标记）。意图不明（看不到用户消息）时回退 C4——宁可多注入规划级，不可丢上下文。
- 提供 `memory_search` / `memory_read` 两个工具，模型可自主检索/读取台账。

## 台账文件

| 文件 | 用途 | 条目格式 |
|---|---|---|
| `INDEX.md` | 引擎托管的路由索引（自动重建，勿手改） | 表格 |
| `PROJECT.md` | 项目需求/背景 | `## [REQ-001] …` |
| `STATE.md` | 当前状态快照（唯一） | `## [STATE-CURRENT]` |
| `DECISIONS.md` | 架构/方案决策 | `## [DEC-001] …` |
| `TECH.md` | 技术事实/环境约束 | `## [TECH-001] …` |
| `HISTORY.md` | 追加式流水（永不重写） | 每行一条 |
| `CONFLICTS.md` | 冲突显式登记（绝不静默覆盖） | `## [CONFLICT-001] …` |

每条带 `- confidence: 0–1` 与 `- status: ACTIVE|SUPERSEDED|CONFLICT|STALE`。

## 安全机制

- **完整性校验**：sync 前后比对台账，检测"静默删除条目 / 状态被改成 CONFLICT / 重复 ID / STATE-CURRENT 丢失"；静默删除会自动还原并记入 CONFLICTS.md，其余显式上报，**绝不静默覆盖**。
- **原子写**：tmp 文件 + rename。
- **gitignore**：默认在 `.dsh-memory/` 内写自包含 `.gitignore`（内容 `*`），台账不进版本库；`gitTracked: true` 可关闭。
- 台账目录取 `session.header.cwd`（会话工作目录，即项目根）。
- **溯源（provenance，P0.5 完整形态）**：Guardian 指令要求新条目/事实实质变化的条目附**两条** bullet——`- source_ref: E#`（该条目所支持的那条对话消息的**临时证据句柄**）+ `- source: <逐字引用>`（≤160 字符，不得改写，必须出现在被引用消息内）。回合同步时宿主把 delta 消息编号为 `[E1]…[En]` 打印进提示词；**E# 不是日志 seq，不持久化**——私有的 `E# → {seq, text}` 映射只活在这一次调用里，LLM 全程不见 seq 号。宿主侧验证（确定性代码）：`source_ref` 存在 → 引号必须 ⊆ 该句柄消息文本（规范化后）→ **恰好绑定那一个 seq**（同一句引用出现在 N 条消息里也不再有"N 个全绑"的任意性）；引号不属于被引用消息 → `quote-mismatch` **拒绝**（幻觉信号，绝不静默回退）；句柄不存在 → `unknown-ref`；无 `source_ref`（压缩同步/旧数据）→ 退回整日志唯一子串匹配，**多匹配 = `ambiguous` 不绑定**、零匹配 = `not-found`。绑定结果与 `unresolved` 失败表（`{<条目id>: {reason, at}}`，200 行上限）一起合并进侧车 `.dsh-memory/.provenance.json`（`{sessions: {<sid>: {<seq>: [条目id]}}}` + `unresolved`，100 会话上限、当前会话永不被挤出）。VAC-GC 保护门据此把"ACTIVE 条目的原始证据消息"升为 **P0 永不动**——即使该消息本身不含任何 `[DEC-xxx]` ID（§85 的 ID 文本门看不到它）。条目变 SUPERSEDED 后自动解除锁定（只钉 ACTIVE）。
- **溯源降级态（provenance fail-safe，P0.5）**：台账提交与溯源提交**不是同一个安全事务**（顺序：台账文件 → HISTORY → `saveState(rev+1)` 提交点 → 侧车尽力写）。规则：**侧车失败绝不回滚台账**（记忆可用性优先），而是显式降级——任何"ACTIVE 但零已解析绑定"的条目（侧车缺失/损坏/写失败/`unresolved` 行）进入**保守保护通道**：与其词汇相关（共享 ≥2 个证据词元，或 1 个 ≥8 字符的显著词元）的单元按 **P1 持有**（永不 fresh-prune、段选择降权），**绝不允许**"ACTIVE + 缺溯源 → 正常权重评分"。坏侧车的代价只能是"多留一些"，不能是"可能误删"。修复是自动的：下次同步时宿主用**条目自身存的 `- source:` 引号**对 append-only 日志重搜（日志只增不改，旧证据仍在）——唯一匹配即重绑、清除 `unresolved` 行（本轮被拒的条目**不当轮**静默回退，拒绝保持到下一轮显式修复）。
- **并发提交门（revision）**：`.state.json` 顶层 `revision` 是全台账单调计数。sync 在 LLM 调用**之前**读取 `revBefore`，提交前重读：若期间有其他会话/进程提交过（revision 变了）→ 抛 `LEDGER_REVISION_CONFLICT`，`sync()` **恰好重试一次**（重新读文件/状态/基线），再冲突则显式上抛（绝不无限循环、绝不覆盖他人提交）。只改轮次计数器的保存不携带 revision 参数、**不会**冲掉它。
- **并发保证（明示等级，P0.5）**：
  - **单宿主进程**（DSH Desktop 部署形态）= **强保证**：引擎的 per-dir 锁串行化全部三条 sync 路径（轮次/压缩前/手动）。
  - **多宿主进程共享一个项目目录** = **尽力而为**（best effort，不是真 CAS）：revision 检查是乐观锁，"写完台账文件、还没 bump revision"之间存在崩溃窗口，另一进程可能读到旧 revision 并覆盖提交。这是**设计接受的**，因为 sync 是**幂等**的——Guardian 每次从对话重发**全量**文件内容、seq 游标 per-session、revision 是提交标记：崩溃的半成品提交只是"崩溃前状态继续有效"，败者的下一次同步会重新派生出相同文件并收敛（无重复条目、无状态分裂）。
  - 未来若真有两个宿主写同一工作区：`.dsh-memory/.lock`（OS 独占锁）或"版本化快照 + 原子指针"；今天不加复杂事务。
- **操作契约（operation-based Guardian，P1-②）**：Guardian **不再重发全量文件**，只输出**操作**——`ADD` / `UPDATE_STATE` / `AMEND` / `SUPERSEDE` / `CONFLICT` / `RESOLVE_CONFLICT` / `NOOP`。LLM 理解"状态变化"，宿主拥有"状态本身"：**条目 ID 由宿主铸造**（`PREFIX-NNN` 三位补零，按台账内现存最大号 +1），LLM 只能**引用**现有 ID、不能造号。关键区分：给已有决策**补理由** = `AMEND`（保持 ID/标题/状态，只换事实与证据）；**改变决策本身**（如 FP8→BF16）= `SUPERSEDE`（旧条 `status: SUPERSEDED` + `- replacement: <新ID>`，新条 ACTIVE 追加）——这条区分是防"版本爆炸"的核心。应用是**按文件整段重渲染、未触碰文件字节不变**（NOOP 批次 → `changed: []`；失败组 → 目标文件字节级不变）。
- **证据门（evidence-gated operations）**：`ADD` / `AMEND` / `CONFLICT` / `RESOLVE_CONFLICT` 必须带 `source_ref`（E# 句柄）+ `source_quote`（逐字引用）；`SUPERSEDE` 的**新条目**必须带自己的证据（被取代的旧条不需要——它已存在）。`UPDATE_STATE` 证据可选，但提供了就必须验证。验证失败 = **该操作被拒**（`REJECT` 记入 HISTORY 审计行 + 拒绝理由），**整次同步不失败**——"4 条有效 + 1 条幻觉" → 4 条提交、1 条拒绝。拒绝理由集：`BAD_OPERATION` / `NO_EVIDENCE` / `BAD_REF` / `UNKNOWN_REF` / `QUOTE_MISMATCH` / `EVIDENCE_NOT_FOUND` / `AMBIGUOUS_EVIDENCE` / `MUTATION_WITHOUT_EVIDENCE` / `TARGET_NOT_FOUND` / `TARGET_NOT_ACTIVE` / `GROUP_REJECTED`。
- **事务组（`transactionGroup`）**：相关操作共享组名 → **原子**——组内一条无效，全组拒绝（每条记 `GROUP_REJECTED` + 组内根因）；组外独立操作照常提交。全部被拒的批次**仍然提交**（游标前移、revision bump、HISTORY 记拒绝）——拒绝是宿主的决定，原始证据留在 append-only 日志里，下轮可用好证据重新提取。
- **Mutation Guard（P1-③）**：`AMEND` / `SUPERSEDE` / `ADD` / `CONFLICT` 的**新文本相对旧文本新增的"精确原子"**（数字、带单位数值、版本号、路径、模型名、哈希、URL、端口、错误码、命令）必须**逐字出现在所引证据中**，否则 `MUTATION_WITHOUT_EVIDENCE` 拒绝——"52.31 → 62.31 而证据里没有 62.31" 被宿主直接拦下，终结"数值慢慢漂"。原子提取是确定性的（模式表 + 去重），同一轮内旧值替换为新值且新值有证据时放行。
- **并发与操作**：commit 级重试（LLM **永不二次调用**）在**更新基线**上重新规划**同一批**操作——操作是指令禁止重加已存在条目 + 宿主对已关闭目标的 `TARGET_NOT_ACTIVE` 拒绝保证**幂等**；重试窗口再次冲突则显式上抛（游标保持，下一轮全量重派生）。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_search` | `query`（必填）、`file?`、`limit?` | 按关键词（AND）跨台账文件检索，返回 `file:line` + 上下文行 |
| `memory_read` | `file`（必填）、`entry?` | 读整文件或单条（按 `[PREFIX-NNN]` ID） |

## 同步时机

1. **每 N 轮对话**（`syncEveryNTurns`，默认 20）——后台执行，失败只 warn 不打断对话；
2. **压缩前**（`syncBeforeCompaction`，默认开）——把即将被压缩的上下文提炼进台账（120s 去重窗口，避免与轮次同步撞车）；
3. **手动**——GUI 的"立即同步"按钮。

## 压缩引擎（VAC-GC 价值感知压缩）

本插件同时替换官方 `dsh-compaction-basic` 压缩引擎（MML 预设 `standard-mml` / `minimal-mml` 里 compaction 组的第一行指向 `dsh-md-memory/engine`），在"校准压力阈值 + 摘要压缩"之外实现文档《Value-Aware Context Compression》(VAC-GC) 的决策层：

- **每轮对话结束**（turn/end）对当前 session 表面跑一次**只读**的 VAC-GC 规划：单元切分 → 保护门（P0/P0_TRANSIENT/P1 永不碰）→ 价值评分/分层（HOT/WARM/COLD/TRASH）→ 压力分区（Z0–Z4）→ 决策（不动 / fresh-prune / compact）。规划结果缓存用于层间迟滞，并记一行日志。
- **`vacgcMode`**（引擎配置键，MML 预设默认 `prune`）：
  - `shadow`（V1.0 默认）——**只记录、不改表面**：日志是"价值感知引擎本会怎么做"的 A/B 对照数据，线上行为完全由校准压缩承担。
  - `prune`（**Phase 2**，预设默认）——在 shadow 规划之上**实际执行 TRASH 层 fresh-prune**：
    - 每轮结束时，当决策为 `fresh-prune`（Z1 分区）才落地；
    - 触发预压缩（超过校准阈值）时，**先**跑官方 toolResultPruner、**再**等 VAC-GC 规划落地、最后才做摘要压缩的区间选择（规划看到的是官方剪枝后的表面）。
  - 硬门（文档 §125）：只碰 **TRASH 层、已关闭的 tool 单元**；P0/P0_TRANSIENT/P1、未关闭的尾对**永不**动。
  - **recent floor 是语义化的**：floor 内**可重建的 TRASH 工具输出**（reconstructibility X ≥ `floorBypassX`，默认 0.80——raw 指针保留、内容可重建）仍可做 **reduce-only** 微剪（"最近 ≠ 有价值"——18K tokens 的工具垃圾不该因为"新"而免疫）；**整单元删除与非工具内容仍受绝对 floor 保护**（`floorBypassX: 0` 恢复旧行为）。**该参数已冻结**（reduce-only 设计经用户确认）：在拿到真实运行时数据（影子日志的 X 分布 + 误剪/漏剪事件）之前，**不调** 0.75/0.85 之类的阈值——先有数据，再谈调参。
  - **溯源钉（provenance lane，P0 保护门最前）**：单元的 `seqs` 与 `.provenance.json` 中 ACTIVE 条目的源 seqs 相交 → **P0 永不动**（原始证据保护，见"安全机制"）。
  - **溯源未解析的保守持有（P0.5）**：ACTIVE 条目的证据**尚无已解析绑定**（侧车缺失/损坏/写失败/ambiguous 等降级态）时，与该条目词汇相关的单元（共享 ≥2 证据词元或 1 个 ≥8 字符显著词元）按 **P1 持有**——降级态绝不产生"普通 NORMAL 评分"；绑定修复后自动退出该通道、进入上面的 P0 精确源通道。
- **落地语义**（`lib/vacgc/apply.js`，镜像官方 pruner 的事务形状）：表面层只有 `append` / `replace`（无 remove），且 `tool/result` 替换必须只改内容——
  - `reduce`：把该结果节点文本换成对应工具的 reducer 输出（§48–§52：保留命令/退出码/错误/告警/尾行 + `raw: <指纹> (N 行, reconstructible)` 原始指针），**只在确实变小时**才替换（churn 门）；
  - `drop`（重复单元）：把节点文本换成 `[pruned: duplicate tool result — raw: <指纹> (reconstructible)]` 存根。**工具调用本身在 assistant 消息里、表面层删不掉**，所以存根替换保留调用/结果配对（§128 原子对不被拆散），重复结果的 token 体量离开模型表面。
  - 每次落地 = 一条 `compaction/prune` 影子计价事件 + 一条带 `sourceEventSeqs` 溯源的 `tool/result` 替换；**任何一步被 session 拒绝 → 已落地的保持持久、本次降级为 shadow**（§130 fail-safe：剪枝失败绝不阻塞对话）。
- **VAC-GC Phase 3（MML 预设已启用）**：Z2–Z5 的选中加权平衡区段先由 `executor.js` 做 P0 100% / P1 ≥99% 精确事实覆盖验证，再复用 DSH 原生 compaction 事务提交；验证、配对边界或表面稳定性失败时自动回退官方路径。`prune` 模式跨 DSH 版本保持语义执行开启（`shadow` 仍为只读）。
- **手动 `/compact` 小跨度保护**（Phase 2a，`lib/vacgc/manual-compact.js`）：手动 `/compact` 先做只读的校准预检——当选定的可压缩跨度 **< 1024 校准 token** 时直接返回 `null`（UI 温和提示 "No compactable history yet."），**不调用摘要模型**。原因：小跨度下冗长模型产出的摘要必然 ≥ 原文，基座引擎的"必须变小"硬门只能拒绝并抛出 "could not produce a useful summary" 的吓人报错（会话未变、只是白跑一次 LLM）。跨度 ≥ 1024 时原样走基座 `compactNow`；预检自身出错则降级走基座选择，绝不阻塞手动压缩。

## 客户端界面

- 会话页新增 **"项目记忆"** 标签（`conversation.view`）：文件列表（大小/时间）、活动冲突、全文检索、单文件查看、立即同步。
- 会话页新增 **"上下文"** 标签（VAC-GC 权重视图）：压力分区 / Tier 分布 / 单元表（分数 + 保护原因 + "为什么压缩"明细）/ 上下文历史 sparkline，以及 **"计划 vs 执行"** 块——显示官方前缀摘要、Phase 3 加权语义压缩与 TRASH 微剪的实际次数/最近时间；语义摘要失败时自动回退并保留原生压缩。
- 上下文标签同时显示 **溯源缺口**（`memory/provenance` RPC，P0.5）：存在"ACTIVE 但无已解析证据绑定"的条目时，渲染一行警示（条数 + 前几个条目 ID + "相关候选按 P1 保守保护，下次同步可自动修复"）——降级态在 UI 上可见，不再是隐式状态。
- 助手消息操作区新增 **"记忆"** 按钮，一键打开标签。
- **上下文**标签新增“预算与压缩设置”卡片：显示当前 provider/model 与模型硬上限，按路由编辑有效上下文目标、最大输出、安全余量、压缩阈值、保留预算、压缩/溢出重试以及 `max-tokens` 自动续写。设置写入 DSH profile 的 `dsh-md-memory` 命名空间，带 revision 乐观锁；原生压缩字段保存后对新会话生效，预检和续写开关立即生效。
- 模型硬上下文与路由最大输出由 DSH 后端 `resolveModelInfo` 动态读取：设置页刷新/保存时强制更新，正常请求按 15 秒短缓存刷新；后端暂时不可用时保留最近一次有效能力值并在界面标注旧值状态。
- 对 OpenAI/vLLM 后端额外读取 `/models` 的 `max_model_len`、`context_length` 等实时字段；因此只修改后端容量而没有同步 `settings.yaml` 时，插件仍能获取新的硬上限。

### 请求预算保护

插件在每个 agent step 发送前估算当前输入与待发送消息，按以下公式计算本轮安全输出上限：

```text
safeMaxOutput = min(configuredMaxOutput,
  targetContextTokens - projectedInputTokens - safetyMarginTokens)
```

输入超过有效目标时先运行配置次数的 VAC-GC/原生压缩；仍无空间则把请求的 `maxTokens` 降到安全值，避免把必定失败的参数写入新的 `request/header`。标准 `CONTEXT_WINDOW_EXCEEDED` 和旧适配器的 maximum context length 文本均支持有限次压缩重试，压缩无法释放空间时停止并给出可读错误。摘要和会话标题请求保留自己的用途预算。

路由设置通过 DSH 原生 settings 服务保存，不直接改写 `settings.yaml`。设置按 `provider/model` 隔离，`targetContextTokens` 不得超过模型硬上限，`maxOutputTokens` 不得超过路由声明值，保留预算必须低于阈值。没有 settings 或扩展事件的旧 DSH 会保留原有压缩路径，并在界面标出不可用能力。

## 安装

> 宿主 HMR 已禁用：**改动只在宿主重启后生效**。

插件是标准 npm 包，**只使用宿主原生机制注册，零宿主文件修改**：

- 包清单声明 `dsh.bundle.patch → cordis.patch.yml`（根行挂接）——与宿主内置 `dsh-base` / `dsh-web-app` 等 bundle 完全相同的原生契约（`dsh-app-boot` 的 profile/bundle/patch 层组合）；
- 引擎按会话经 agent preset 行 `dsh-md-memory/engine` 挂载，宿主两锚点模块解析 + Node `exports` 子路径解析；
- Web 界面经 `dsh.client` 清单 + 宿主注入的客户端运行时（`dsh-client-*` 由宿主提供，不是本包依赖）。

### 标准安装（其他 DSH，推荐）

profile = `~/.dsh/profiles/<name>/`（本机为 `desktop`）：

1. **装进 profile 的 node_modules**：

   ```powershell
   cd "$env:USERPROFILE\.dsh\profiles\desktop"
   npm install <tarball 或 registry 源>
   ```

   - 正式源：`npm install dsh-md-memory@latest`（npm/git/私有 registry 均可）；
   - 本地交付：在本仓库 `npm pack` 生成当前版本 tarball 后 `npm install .\dsh-md-memory-0.1.18.tgz`。
   - npm 会自动把 `"dsh-md-memory": "<源>"` 写入 profile 的 `package.json` → `dependencies`。

2. **注册 bundle**：profile `package.json` 的 `dsh.profile.bundles` **末尾**追加 `"dsh-md-memory"`（bundle 顺序即补丁叠加顺序，最后写入者胜）。

3. **启用预设**：插件启动时自动幂等地供应两个 agent 预设 `standard-mml` / `minimal-mml`（其压缩行指向 `dsh-md-memory/engine`）。在会话设置把 agent preset 切到其一，即启用引擎 + 台账 + UI 标签；**不切换则引擎不挂载**（"项目记忆"标签仍可浏览台账）。

4. **重启 DSH 宿主**。

### 卸载

1. profile `package.json`：删除 `dependencies` 里的 `dsh-md-memory` 与 `dsh.profile.bundles` 里的 `"dsh-md-memory"`，重跑 `npm install`；
2. （可选）删除自动供应的预设 `~/.dsh/.agent-presets/standard-mml`、`minimal-mml`，并把使用过它们的会话切回默认预设；
3. 重启宿主。项目内的 `.dsh-memory/` 台账不受影响（纯 Markdown，可自行保留/删除）。

### 本地开发安装（源码 junction）

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-md-memory" -Target "C:\Users\xiemo\md-memory"
```

外加 profile `package.json` → `dependencies` 加 `"dsh-md-memory": "file:../../../md-memory"` + bundles 条目 + 重启。源码单点维护，改完重启即生效（pnpm 管理的 profile 需在 profile 目录补跑 `pnpm install` 对齐 lockfile）。

### 源码解析说明

插件对宿主包的依赖全部声明为 `peerDependencies`（零真实 npm 依赖）。**装进 profile 时**裸导入走宿主标准模块层：`$DSH_HOME/profiles/node_modules`（宿主维护、指向安装树）+ 打包可执行文件的 ESM 代理——外部插件复用的是**安装侧的模块实例**（`dsh-app-boot` 两锚点解析），不存在状态分叉的重复副本。**仅本地开发安装**（junction 指向源码目录）时，裸导入从源码目录向上解析，因此项目内带一份指向宿主共享树的 `node_modules` junction（`@deepseek-ai/{schemastery,dsh-compaction,dsh-compaction-basic,dsh-llm,dsh-session,dsh-tools}`）——开发环境**请勿删除 `md-memory/node_modules/`**。

## 版本兼容与升级

- **不变式：不修改任何宿主文件**（2026-09-12 起；仓库 `revert/` 目录是更早历史宿主补丁的 pristine 副本与回退脚本，仅作审计留档，开发专用，不打进 npm 包）。
- 插件↔宿主耦合面（全部经标准接口）：
  - 5 个宿主包的裸导入（`peerDependencies`：`schemastery`、`dsh-compaction`、`dsh-compaction-basic`、`dsh-llm`、`dsh-tools`）；
  - 压缩基类 `BasicCompactionEngine`（继承 + 调用其 `compactNow` / `compactIfNeeded`）；
  - 会话 ctx 服务（`on` / `llm` / `tokenMeter` 必需；`sessions` / `tools` / `agents` 软依赖）与 `session/event` 事件；
  - bundle 补丁层（`dsh-app-boot`）与 preset 行解析（`dsh-agent-presets`）加载契约。
- **DSH 升级不影响 profile**：`~/.dsh/profiles/`（含插件安装）与 `~/.dsh/.agent-presets/` 都在用户数据目录，升级/重装 DSH 应用不触碰；宿主下次启动自动重扫 profile bundle 与补丁层，插件自动重新挂载。
- **挂载时版本校验**：引擎每次会话挂载先对照 `HOST_CONTRACT`（`lib/index.js`，探测在 `super()` 之前）校验宿主契约；未来宿主若重命名/移除上述任何面，会在会话挂载时**立即失败并给出可操作日志** `md-memory: host contract mismatch — …`（恢复指引：把 preset 压缩行改回官方引擎），而不是回合中途的诡异报错。
- 恢复路径：preset 的 `compaction-basic` 行 `name` 改回 `dsh-compaction-basic` 并重启 → 会话回到官方压缩；台账文件、UI 标签、`memory_*` 工具不受影响（它们不依赖压缩基类）。
- 基础压缩配置（thresholdRatio/retainRatio/maxTokens/modelPolicies）原样透传，压缩行为与官方引擎逐版本一致。
- 0.1.4 的预设生成器同时识别旧版 persona `text` 和新版 `prefix`，并复制当前宿主的压缩组及其配置，仅把官方压缩引擎行替换为本插件；不再预置特定 vLLM 模型的策略。需要调节阈值时，在 MML 预设中按当前模型添加 `modelPolicies`。
- 0.1.5 修正 DSH Desktop 2.0.9 下压缩回调经代理调用时的实例绑定、Web 面板搜索结果解析，以及同进程多预设实例对同一项目目录的同步锁共享。
- 0.1.6 在预设挂载时注册动态提示词变量，避免极简模式首轮的 `unknown prompt variable`；多会话实例共享上下文计划与执行统计，确保各会话面板读取自己的数据。
- 0.1.7 的客户端从 DSH 活动会话列表解析当前会话 ID，切换会话时重新请求各自的台账和上下文数据。
- 0.1.8 在宿主重启后的冷会话上通过 `sessionQuery` 精确回放目标会话，禁止指定会话 ID 缺失时退回其他活动会话，修复面板短暂显示“未初始化”及跨会话数据串读。
- 启动时保留当前 DSH 默认预设；在新会话中手动选择“标准模式 + 项目记忆”或“极简模式 + 项目记忆”。
- 压缩前同步在短时间内已有同步记录时还会核对 durable log 游标；有新消息就重新同步，避免只按 120 秒窗口跳过新上下文。

## 配置

在 profile `cordis.patch.yml` 的 `compaction-basic` 节点下（未写则用默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dirName` | `.dsh-memory` | 台账目录名（相对项目根） |
| `syncEveryNTurns` | `20` | 每 N 轮对话后台同步一次（`0` 关闭轮次同步） |
| `syncBeforeCompaction` | `true` | 压缩前同步 |
| `gitTracked` | `false` | `false` = 台账目录写自包含 `.gitignore` |
| `injectAlways` | `true` | 每 agent 常驻注入台账路由摘要 |
| `syncProvider` / `syncModel` | 空 | 空 = 跟随会话当前路由；填了则 sync 单独走该模型 |
| `syncMaxTokens` | `16384` | sync 调用输出预算 |
| `vacgcMode` | `shadow`（MML 预设默认 `prune`） | `shadow` = 只记录 A/B 日志；`prune` = Phase 2，TRASH fresh-prune 实际落地（见上节）。其他值一律降级为 `shadow` |
| `vacgcSemantic` | `false`（`prune`/MML 预设强制 `true`） | Phase 3 加权语义区段 + 精确事实覆盖验证；失败安全回退官方压缩 |

基础压缩配置（thresholdRatio/retainRatio/maxTokens/modelPolicies 等）**原样透传**，本插件不改动压缩策略。其余 `vacgc*` 调参键（压力分区/分层迟滞/回收预算等）见 `lib/vacgc/index.js` 的 `VACGC_DEFAULTS`，默认值即可用。

## 验证

宿主日志（`%APPDATA%\DSH Desktop\logs\dsh-*.log`）：

- 启动：`md-memory: enabled (dir=.dsh-memory, syncEveryNTurns=20)`
- 轮次同步：`md-memory: turn sync wrote N file(s)` / `turn sync skipped (…)`
- 压缩前同步失败只 warn：`md-memory: pre-compaction sync failed (…)`——**不影响压缩本身**。
- VAC-GC 规划（每轮结束，shadow 与 prune 都会记）：`md-memory: vacgc shadow|prune <sid> turn-end zone=Z0..Z4 … tiers=[HOT:n WARM:n COLD:n TRASH:n] selected=… action=none|fresh-prune|compact (…ms)`
- VAC-GC Phase 2 落地（仅 `vacgcMode: prune` 且确有 TRASH 可剪时）：`md-memory: vacgc prune <sid> turn-end|pre-compact landed=N charsSaved=M`
- VAC-GC Phase 3 实机提交：`md-memory: VAC-GC semantic committed <sid> SEG-<start>-<end> status=applied attempts=N events=M`
- Phase 2 落地失败只 warn 并降级为 shadow：`md-memory: vacgc prune apply failed for <sid> (…); shadow-only until next trigger`——**绝不阻塞对话**。
- 手动 `/compact` 小跨度跳过（Phase 2a）：`md-memory: manual compact skipped: compactable span N tokens < 1024 minimum`——UI 显示 "No compactable history yet."，**未调用摘要模型**。

## 文件

- `lib/index.js` — 宿主插件（引擎 + LedgerManager + 工具 + RPC + VAC-GC 接线 + 自适应懒注入 C0–C5 分类/渲染）
- `lib/ledger-ops.js` — 操作契约的**纯模块**（P1-②/③，无宿主/文件系统依赖）：`planOperations`（归一化 → 证据验证 → Mutation Guard → 组原子性 → ID 铸造）+ `applyOperations`（按触碰文件重渲染）+ 证据解析 / 原子提取 / 条目渲染解析
- `lib/vacgc/` — VAC-GC 规划/执行模块：`index.js` 规划器、`executor.js` Phase 3 事实覆盖编排、`prune.js` 每工具 reducer + fresh-prune 计划、`apply.js` 表面落地、`manual-compact.js` 手动压缩小跨度保护、`units.js` 单元切分、`protection.js`/`scorer.js`/`pressure.js`/`segment-builder.js` 等
- `lib/client.js` — Web 客户端（纯 JS，无构建，React + jsx-runtime）
- `test/vacgc/` — 207 个 hermetic 测试，含 `apply.test.js`（Phase 2 落地）、`manual-compact.test.js`（Phase 2a 手动压缩保护）、`purity.test.js`（固化"规划层零 LLM/网络/外部依赖"边界）、`ledger.test.js`（含 `.provenance.json` 溯源消费端 + P0.5 降级态）、`protection.test.js`（含 P0.5 保守持有通道）、`client-ui.test.js`（含溯源缺口行 + `memory/provenance` 拉取）、`properties.test.js`（P1 性质 6/7：未解析 ACTIVE 事实的 P1 下界 + 绑定证据的 P0 稳定性/释放）
- `test/ledger/p0.test.js` — 9 个台账 P0 测试（操作契约下的 `sync`：一次 LLM 调用、commit 级恰好一次重试（含"两次提交都冲突"显式上抛且 LLM 不被二次调用）、`.provenance.json` 合并/100 会话上限、`revision` 并发提交门、`deltaEvents` 持久日志投影）
- `test/ledger/p05.test.js` — 11 个**故障注入**测试（P0.5）：`[E#]` 句柄编号/截断、ref+引号精确单绑（同引号三处出现仍只绑被引用者）、`quote-mismatch`/`unknown-ref`/`ambiguous` 拒绝矩阵（含"引号在日志里但拒绑"证明无静默回退）、错柄注入→操作被证据门拒（无部分条目）→**下一轮**改引正确句柄干净落地、**侧车写失败**注入→台账存活+revision 照常 bump+VAC-GC 保守 P1 持有→修复轮（NOOP）重绑并升 P0、**LEDGER 后 HISTORY 前崩溃**/**HISTORY 后 revision 前崩溃**两个写入序窗口的自愈合（Guardian 见到存活条目 → NOOP，无重复条目、游标/revision 收敛）、**损坏侧车重启**→索引照常加载+保守保护+下一轮修复
- `test/ledger/ops.test.js` — 16 个操作契约测试（P1-②/③）：schema 归一化（大小写/类型别名）、证据矩阵（干净/未知句柄/引号错位不静默回退/坏引号/唯一引号绑/歧义/太短）、"4 有效 + 1 幻觉"（4 提交 + 1 拒绝 + HISTORY 审计行 + 侧车只绑 4 条）、**事务组原子性**（组内一条失败 → 全组 `GROUP_REJECTED`、组外独立操作照常提交、目标文件字节不变）、**AMEND vs SUPERSEDE**（FP8→BF16 例子：换决策 = 铸新 ID + 旧条 SUPERSEDED + replacement 指针；补理由 = 原 ID 原地改）、`TARGET_NOT_FOUND`/`TARGET_NOT_ACTIVE`、原子提取器、Mutation Gate 直测（52.31→62.31 拒）、CONFLICT→RESOLVE 生命周期、UPDATE_STATE 重写、ID 批量铸造、渲染往返稳定性、**sync 级**（真实宿主：写入的文件集 + HISTORY `ops …; rejected UNKNOWN_REF: ADD` + 侧车 seq→ID 绑定）
- `test/ledger/ops-fuzz.test.js` — **属性/模糊测试**（用户风格：属性优先于用例数）：两个种子 × 150 随机轮次（≈1200 次随机操作迁移，随机初始台账 + 随机操作流：ADD/AMEND/SUPERSEDE/CONFLICT/RESOLVE/UPDATE_STATE/NOOP/坏操作 × 干净/漂移/错柄/未知/歧义/无证据 × 事务组），每轮断言用户性质 1–4——**无操作能静默删除条目**、**新增精确原子必须有逐字证据支持**（独立重算 `extractExactAtoms`）、**独立失败操作不牵连有效操作**、**失败组的目标字节级不变**——外加全覆盖（每个操作恰好一次 applied∪rejected）、ID 铸造不变量（唯一/格式/不撞基线）、条目计数核算、**同种子字节级确定性**
- `test/vacgc/properties.test.js` — **VAC-GC 性质测试**：性质 6（3000 随机用例：ACTIVE 未解析事实的词汇相关单元**永不**低于 P1——保守持有是健全下界不是启发式；无词汇关联则不持有，无 blanket 过保护）、性质 7（绑定的 ACTIVE 决策证据在**重复压缩轮次**中恒 P0 且分类幂等；条目关闭（SUPERSEDED/STALE）才释放——不多放、不少放；+ 200 随机绑定混合的 P0 当且仅当 精确判定）
- `test/ledger/lazy.test.js` — 9 个自适应懒注入测试（P1-④）：C0–C5 级联（含用户 FP8→BF16 例子 = C4）、**性质 5：C0/C1 恰好零常驻注入**、各级 token 预算、内容分级（C2=STATE 只有 / C3=+相关条目 / C4=+路由 / C5=全量且 SUPERSEDED 永不重入）、**条目整条进出**（无半决策）、巨型 STATE 按行边界截断、宿主级 `promptContext(dir, mml, session)`（最新用户消息定级、工具轮保持原意图、无会话 → C4 回退、`injectAlways: false` 全关）
- `test/engine/host-contract.test.js` — 6 个宿主契约探测测试（版本兼容护栏）
- `cordis.patch.yml` — 根行挂接：`id: md-memory-root` → `name: dsh-md-memory`（让 host 的 boot-manifest 扫描看见 `dsh.client` 半；引擎本身按 session 由 MML 预设的 `dsh-md-memory/engine` 子路径行加载）
- 全量：`npm test`（= `node --test "test/**/*.test.js"`，**261 通过**）

### 交付边界（npm pack 内容 = `files[]`）

`files: ["lib", "cordis.patch.yml", "README.md"]` —— `npm pack` 只含运行时产物。以下均为开发专用、不打进包：`revert/`（历史宿主补丁回退留档）、`debug/`（asar 读取工具）、`tools/`（预设供应/影子计价修复脚本）、`test/`、`.dsh-memory/`（本项目自己的台账）、`node_modules/`（开发 junction）。

## 后续路线（P1，用户确认的顺序）

V1 骨架（台账 + Guardian 同步 + VAC-GC 影子/微剪 + 双标签 UI）已完成；下一阶段的架构价值按此顺序推进：

1. **溯源 fail-safe + 临时证据句柄**（**已完成，P0.5**）——`[E#]` 句柄 + 宿主验证 + 降级态保守保护 + 自动修复。
2. **操作化的 Guardian**（**已完成，P1-②**）——`lib/ledger-ops.js` 纯模块：7 操作 + 证据门 + 事务组 + 宿主铸 ID + commit 级单次重试（LLM 不二次调用）。AMEND（补理由，保 ID）vs SUPERSEDE（换决策，铸新 ID + 旧条关闭）的区分固化在指令与测试里。
3. **Mutation Guard**（**已完成，P1-③**）——精确原子（数字/单位/版本/路径/模型名/哈希/URL/端口/错误码/命令）新增即须逐字证据，`MUTATION_WITHOUT_EVIDENCE` 按操作拒绝（不炸整次同步）。
4. **自适应懒注入**（**已完成，P1-④**）——规则优先 C0–C5 分类 + token 预算（0/0/768/2048/4096/8192）+ 条目整条进出 + STATE 行边界截断；≈6K 常驻转储已废除。性质 5（C0 零注入）/6/7 以属性测试固化。
5. **检索升级**——AND → 精确优先 + 加权 OR 回退 + raw 指纹 → `session://<sid>/seq/<seq>` 原始指针。（下一项）
6. **VAC-GC 语义 Phase 3**——Z2–Z5 调用选中的**加权平衡区段**（替代官方最旧前缀），先做精确事实覆盖验证，复用原生事务并安全回退。（已完成）
7. **台账归档/分片**——80 行以上文件的归档策略（最后做）。

P2 备选（更远期）：自适应权重/嵌入（已推迟）。
