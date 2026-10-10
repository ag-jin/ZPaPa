# 源头内联号标记 · 契约（markers.v1）

- 冻结于：T1 契约包 v2（2026-10-09）。本文件是"身份随文件走"的唯一语法约定；任何字段或语法改动走新任务 + 版本号变更。
- **v2.1 变更段（T21，2026-10-09）**：§2.4 增"未领号特性下带号卡"过渡态例外成文；§3 增 `> cancelled: <原因>` 与 `> agents: 角色1 | 角色2 | …` 两个语法族；§4 勘误拒收清单（`ID-1` 按归一算法应接受 → 1，v2 文本误列，已删）、`> blocked-by:` 只认整数句柄成文（内部 id 形态拒收）；§5 增 registry 空洞条目判据与"registry 全丢失时 spec 特性号不可恢复"已知限制。其余冻结不变，契约版本随之升为 v2.1。
- **v2.3 变更段（#53，2026-10-10）**：§2.5 增 `roadmap` 子旗标（计划稿 H1 层的占位稿标记：`<!-- zcode-board: roadmap -->` 独立注释，或与 `no=` 同注释 `<!-- zcode-board: no=N, roadmap -->`；只在计划稿 H1 层合法，`--check` 对非法位置非零退出）；§1 解析正则随子旗标扩展（`no=` 组捕获语义不变）。其余冻结不变，契约版本随之升为 v2.3（v2.2/#46 计划码为 registry 侧显示层，见 §6 末条）。
- **v2.3 补篇段（#66，2026-10-10，不改版本号）**：解析落点扩展，非语法族新增——§3.1 增 `> cancelled:` 的**特性级落点**成文（计划稿 H1 标记行之后、首个非引用行之前；与 `roadmap` 独立注释可连续共存）与**终态优先序**（特性自身取消标记 > 全取消子卡汇总 > roadmap 段位压制 > 其余推导）；§2.5 补"roadmap 压制对 cancelled 让位"例外；§7 补落点外反例。契约仍为 v2.3（分析见 #66：新落点复用既有 `> cancelled:` 语法族与词表，`no=` 捕获与既有落点语义不变）。
- **v2.4 变更段（#72，2026-10-10）**：**扫描面配置化（破坏性默认值变更）**——新增 §9「扫描面配置」：计划稿默认扫描面**收窄为 `.zcode/plans/` 一处**；`docs/plans/`、`docs/design-notes/` 移入 opt-in 目录池，由项目级 `.zcode/board/scan.json` 的 `includeDirs` 显式开启（池外引用拒绝 + 诊断）；`excludeGlobs` 按项目根相对路径排除文件；无配置 = 默认苗圃一处（不猜），配置解析失败 → 失败级诊断 + 按默认兜底。§6 另冻结 `--assign` **防 mass 改写闸**：单次发现 >10 个未领号计划文件 → 拒绝执行（列全清单 + 建议，`--force` 才放行且留痕）。默认值收窄属破坏性变更 → **包版本连带升为 0.4.0**（契约破坏性变更必须连带升包版本，SKILL.md §3.7）；`board.json` 字段不变，schema 仍 v2.3（本变更属编译面契约，不动产物形态）。
- 上游设计：`/Users/linguojin/Workspace/ZCode/.zcode/board/design.md` §3.2、§3.4、§4.2、§12（勘误 9b/9c/9d 同源）。
- 实现方：编译器（`compile-board.mjs` 三态：默认只读 / `--assign` 写号 / `--check` 审计）。本文件只冻结语法与解析规则，不规定实现内部结构。

## 0. 一句话不变量

**号是身份，标签是排版。** 一切引用位（`> blocked-by:` 源语法、卡片 `blockers[].blockedBy`、工作树名 `task-<no>`、run 事件 `cards[]`）只存、只接受**稳定号**（正整数）；层级标签（`ID-1.2`、`1.2`）只出现在显示位，**标签不是句柄**——写进引用位一律拒收。

## 1. 语法族：一个语法族，两个落点，一个解析器

| 落点 | 位置 | 形态 | 例 |
| --- | --- | --- | --- |
| 计划稿（文件级） | 文件头部 HTML 注释，全文件首个出现者有效，建议置于标题行下 | `<!-- zcode-board: no=N -->` | `<!-- zcode-board: no=6 -->` |
| 任务条目（行级） | 任务条目行**行尾**同一注释 | 同上 | `- [ ] 1. 预览发布通道 <!-- zcode-board: no=7 -->` |

- `N` 为稳定号：`[1-9][0-9]*`（正整数，无前导零、无符号、无 `ID-` 前缀）。
- 解析正则（两个落点共用；v2.3 起吸收可选的 `roadmap` 子旗标，`no=` 组捕获语义不变）：`/<!--\s*zcode-board:\s*no=([1-9][0-9]*)(?:\s*,\s*roadmap)?\s*-->/`。书写形态以单空格规范形态为准；解析对注释内空白容错。
- **HTML 注释**对 markdown 渲染不可见——身份戳不污染人读版面；`zcode-board:` 命名空间防与手写注释撞车。
- 适用文件：苗圃 `.zcode/plans/`、正式票计划 `docs/plans/`、旧项目 `docs/design-notes/` 的计划稿，以及 `specs/<f>/tasks.md` 的任务条目行。**v2.4/#72 起**：`docs/plans/`、`docs/design-notes/` 为 opt-in 扫描面（默认不扫，需 `.zcode/board/scan.json` 显式开启，见 §9）。
- **spec 特性号无内联标记**：spec 目录没有标记载体，特性号以 spec 根为键绑定在 registry 内（§3.2）。本语法族不侵入 spec 目录惯例，也不改动 spec-driven-workflow 的模板文件。
- **roadmap 子旗标（v2.3 新增，仅计划稿文件级；见 §2.5）**：`<!-- zcode-board: roadmap -->` 或与号标记同注释 `<!-- zcode-board: no=N, roadmap -->`，标记该计划稿为"占位稿"。

## 2. 解析规则（保守解析，逐条冻结）

1. **文件级**：取全文件首个匹配。出现第二个文件头标记 → 不生效（仅提示级 diagnostics）。
2. **行级**：只认"本身可解析为任务条目"的行上的**行尾**标记。任务条目保守语法与 §4.2 一致：
   - `specs/<f>/tasks.md`：markdown checkbox `- [ ] N. <标题>` / `- [x] N. <标题>`（含嵌套缩进）；
   - 计划稿：markdown checkbox（含嵌套），或加粗/标题形式的 `T<数字>` / `任务<数字>` 前缀条目。
3. 标记出现在非条目行 → **不附着任何卡**，diagnostics 提示"标记位置无效"。标记不跨行、不依赖缩进，对自由 markdown 容错。
4. **缺号完全容错**：无标记的条目不报错——按"未领号"上板（`no`/`label` 缺省，渲染"未领号"角标 + 提示运行 `--assign`）。解析永不因缺号失败。
   - **过渡态例外（v2.1 成文，T21）**：`--assign` 逐文件写号，可能短暂出现"特性未领号、其下部分卡已领号"的中间形态——该形态合法：卡保留 `no`（引用位可用稳定号寻址），`label` 缺省（树位派生等到特性领号后补齐）；编译器不因此失败、`--check` 不判违规。反向不成立：带 `label` 的任务卡必须且只能出现在已领号特性下（label 首段 = 所属特性稳定号，`--check` 硬断言）。
5. **title 净化**：条目行内序号前缀（tasks.md 的 `N.`、计划的 `T<数字>`/`任务<数字>`）从 title 剥离——`T` 前缀是作者标签不是身份；编号显示统一由 `no`/`label` 承担。

### 2.5 `roadmap` 子旗标（v2.3 新增，#53）

```markdown
# 后续期路线（UI 期 · 梦 · 产品 backlog）
<!-- zcode-board: no=14 -->
<!-- zcode-board: roadmap -->

来源：……本计划稿是"待设计区"的载体：本稿条目本身不执行。
```

| 语法 | 归一结果 | 说明 |
| --- | --- | --- |
| `<!-- zcode-board: roadmap -->`（独立注释） | 该计划稿特性 `roadmap: true` | 与号标记同注释等价：`<!-- zcode-board: no=N, roadmap -->`（推荐独立注释——号标记逐字节不变；同注释时 `no=N` 捕获语义不变） |
| 同上 | 该稿特性与**全部任务卡**段位派生为"待设计" | 占位稿"本稿条目本身不执行"：不受勾选/status/执行记录影响（`status` 照常派生，仅段位恒为待设计）。**例外（v2.3 补篇/#66）**：`status=cancelled` 的卡/特性为终态，不让位——段位照常"已取消"（终态优先序见 §3.1） |

- **只在计划稿 H1 层合法**：标记须位于 H1 标题行之下、首个二级及以下标题或任务条目之前，且不在条目行上。合法位置多条 → 首个有效者生效、其余忽略 + diagnostics；非法位置（H2 及以下章节内 / H1 之前 / 条目行上 / `tasks.md` 中 / 计划稿无 H1）→ **不生效**（不落 `roadmap` 字段）+ diagnostics 逐处点名，`--check` 非零退出（需人工移动或删除，`--assign` 不自动修）。
- `roadmap` 只是段位压制，不改身份：`no`/`label`/条目解析/引用位不受影响；`false` 不写字段（契约 v2.3 起 board.json 特性层可选 `roadmap: true`）。
- 与 `arranged-not-expanded` 缺口无关：有卡计划稿不挂该缺口（判据 = 零卡，见设计 §8.4）；零卡的 roadmap 稿照挂（宁误报不漏报）。

## 3. 引用族行语法：`> blocked:` / `> blocked-by:` / `> cancelled:` / `> agents:`

模板（本设计约定；真相源仍是计划文件本身）：

```markdown
- **T1 拆出支付回调服务（草案）**：先落接口。
  > blocked-by: 9 —— 等待 #9 的通道函数落地后再合并回调路径
- **T2 回调幂等键（草案）**：字段待定。
  > blocked: 上游 tag 规则未定，幂等键字段待确认
```

| 语法 | 归一结果 | 说明 |
| --- | --- | --- |
| `> blocked: <原因>` | `{kind: "external", summary: <原因>, evidence: [<计划路径>]}` | 外部受阻；不产生 `blockedBy` |
| `> blocked-by: <句柄>`（同行可选说明） | `{kind: "dependency", blockedBy: <整数>, summary: <同行可选说明或空串>, evidence: [<计划路径>]}` | 卡间依赖；v1 中 `blockedBy` 的唯一来源 |

- **归属**：引用族行必须位于任务条目下方**同缩进块**内；解析器把引用族行挂到其**上方最近的任务条目**。上方无任务条目 → 不挂卡，diagnostics 提示"语法位置无效"。
  - **特性级落点（仅 `> cancelled:`，v2.3 补篇/#66）**：`> cancelled:` 还可落在**计划稿特性级落点**——文件头号标记行（`<!-- zcode-board: no=N ... -->`）之后、首个非引用行之前（引用行与 zcode-board 注释行可连续共存，故与 `roadmap` 独立注释并存形态可解析）——解析为该计划稿**特性**取消。其它引用族行（`> blocked:`/`> blocked-by:`/`> agents:`）不引入特性级落点，照旧不挂卡 + diagnostics。
- **目标号不在板上 / registry 无此活条目** → **不造引用**：保留 `kind` 与 `summary` 原文、`blockedBy` 缺省（不写猜测值），diagnostics 记录待修（设计 §12）。引用有效性判据 = **目标号在本次编译的板上**（活条目集合；勘误 9d）；registry 有条目而板上无与完全未知号同样不造引用，但 diagnostics 用独立文案区分。
- tasks.md **不引入**本语法族（含 v2.1 的 `> cancelled:` / `> agents:`）：spec 侧阻塞的真相源是 `progress.json`（默认只升特性级 `blocked`，标题精确匹配时挂任务卡）；取消与指派语法族落点 = 计划稿类文档（`.zcode/plans/`、`docs/plans/`、`docs/design-notes/`；docs 两目录为 opt-in 扫描面，见 §9）。

### 3.1 `> cancelled: <原因>`（v2.1 新增，T21；v2.3 补篇/#66 增特性级落点与终态优先序）

```markdown
- [ ] T2 回调幂等键（草案）：字段待定。
  > cancelled: 上游方案变更，本卡作废（取消留痕）
```

特性级落点（v2.3 补篇/#66）——取消的是计划稿特性本身（与 `roadmap` 独立注释并存的典型形态；H1 标记行后、首个非引用行之前，中间可连排引用行与 zcode-board 注释行）：

```markdown
# 预览通道实现方案 · v3
<!-- zcode-board: no=8 -->
<!-- zcode-board: roadmap -->
> cancelled: 用户指令撤掉本方案（取消留痕；条目保留、号不复用）
```

| 语法 | 归一结果 | 说明 |
| --- | --- | --- |
| `> cancelled: <原因>`（任务条目下方同缩进块内） | 该条目 `status = "cancelled"`（终态） | 原因自由文本（可空）；**取消留痕、条目保留、号永不复用**——取消 ≠ 删除 |
| `> cancelled: <原因>`（计划稿特性级落点内、上方无任务条目） | 该计划稿**特性** `status = "cancelled"`（终态） | `statusRule` 写「计划稿已取消（> cancelled: <原因>；取消留痕、条目保留、号不复用）」；原因为空 → 写"未记原因"（与卡级同口径） |

- **取消优先于勾选**：条目同时带 `- [x]` 勾选与 `> cancelled:` 行时，`status` 取 `cancelled`（取消是后发的显式事实；不落 `completed`）；特性级同理——有勾选记录的稿带特性级取消行时，特性 `status` 取 `cancelled`。
- **终态优先序（v2.3 补篇/#66；取消是终态，优先级最高）**：特性自身 cancelled 标记 > 全取消子卡汇总（rollup）> `roadmap` 段位压制 > 其余推导。
  - 卡级：`roadmap` 稿中 `status=cancelled` 的卡段位照常"已取消"，不让位于压制（未取消卡仍"待设计"）。
  - 特性级：`roadmap` 稿的特性自身取消 → "已取消"；计划稿**全部子卡（含嵌套）cancelled 且子卡数 > 0** → 特性段位"已取消"（与"全部 completed → 已完成"对称；混合态不汇总、照旧推导；零卡不汇总）。
- **原因留痕**：原因原文进入该卡 `statusRule`（`plan 条目已取消（> cancelled: <原因>；取消留痕、号不复用）`）；原因为空时 `statusRule` 写"未记原因"，不造内容。
- **号不回收**：取消卡保留 `no`/`label`（其上板形态不变，仅 `status`/`stage` 变化）；`seq` 高水位不回退，`--assign` 不为取消卡改号、也不把其号发给别人。
- **段位**：`status=cancelled` → 段位"已取消"（七段位之一，优先级见 `board.schema.json` x-decisions；roadmap 例外见上"终态优先序"）。
- **未合并工作树**：已取消卡若存在未合并执行现场（run 证据的 `worktree` 非空）→ 保留 `unmerged-worktree` 缺口事实 + diagnostics **提醒走 git worktree 正规清理**（取消不清理现场，§6.1/§12）。
- 归属同 §3；同一条目多条取消行 → 首条有效者生效 + diagnostics（不静默改写）；特性级落点内多条特性级取消行同理（首条生效、后者忽略 + diagnostics）。

### 3.2 `> agents: <角色1> | <角色2> | …`（v2.1 新增，T21）

```markdown
- [ ] T3 导出 XLSX（草案）：格式不确定，先排查。
  > agents: debugger | test-verifier
```

| 语法 | 归一结果 | 说明 |
| --- | --- | --- |
| `> agents: 角色1 \| 角色2 \| …` | 该卡 `assignees[] = [角色1, 角色2, …]` | **顺序即管线序**，逐字保留；角色取自角色词表：`implementer` / `debugger` / `refactoring-optimizer` / `code-reviewer` / `test-verifier` / `integrator` |

- **默认管线免写**：无本行的卡 `assignees = ["implementer", "test-verifier", "code-reviewer", "integrator"]`（标准管线）——契约值，消费方据此渲染，无需作者重复书写。
- **整行不解析（含表外角色/空列表）**：任一角色不在词表内、或未给出任何角色 → 整行不解析，`assignees` 保持缺省标准管线 + diagnostics 点名（不猜、不静默、不部分接受）。重复角色按书写保留（不额外裁决）。
- 同一条目多条 `> agents:` 行 → **首条有效者生效** + diagnostics（与文件头标记"首个出现者有效"同旨）。
- 归属同 §3；上方无任务条目 → 不挂卡 + diagnostics。
- 与 `> blocked-by:` 的区别：后者进 `blockers[]`（引用位，需目标号在板上）；`assignees` 是字符串数组、非引用位，角色名不进"号"体系。

## 4. 作者句柄归一（blocked-by 的三种写法）

**只认整数句柄成文（v2.1 勘误 9c）**：`> blocked-by:` 的句柄只接受下列三种整数写法；**内部 id 形态（`plan:*` / `spec:*` / `itw:*`）与任何非整数形态一律不收**——写进引用位即拒收 + diagnostics。

作者在源文件里可以写三种等价写法；编译器归一为**整数稳定号**：

| 作者写法 | 归一结果 | 备注 |
| --- | --- | --- |
| `9` | `9` | 规范写法 |
| `#9` | `9` | `#` 前缀（issue 直觉） |
| `ID-9` | `9` | `ID-` 前缀（显示编号直觉，但与层级标签作区分） |

归一算法（冻结）：

1. 取引用行内容，去掉 `>` 与前后空白；
2. 若以 `#` 开头，去掉**一个** `#`；
3. 否则若以 `ID-` 开头，去掉 `ID-`；
4. 剩余部分必须整体匹配 `^[1-9][0-9]*$` → 该整数即稳定号；
5. 否则**拒收**：不解析为引用（`blockedBy` 缺省、`summary` 保留原文），diagnostics 明确提示"层级标签不是句柄，请改用稳定号"。

**拒收清单（举例）**：`1.2`、`ID-1.2`、`#1.2`、`1.2.3`、`task-9`、`no=9`、`0`、`09`、`-3`、`plan:foo`、`spec:bar`、`itw-baz` 一律不作为句柄。其中 `1.2` / `ID-1.2` 形态即**层级标签**——它随兄弟增删重排而漂移，写进任何长期记忆都会在重排后指错对象。**标签不是句柄。**

> **勘误（T21，勘误 9b）**：v2 版本文本曾把 `ID-1` 列入拒收清单，与本节冻结归一算法矛盾（算法去 `ID-` 前缀后整体匹配正整数，`ID-1` → 1 应被**接受**）。**以算法为准**——`ID-1` 归一为整数 1，不再拒收；本清单已删该例。实现 `normalizeHandle` 自 T6 起即按算法执行，本次为文档追认。

## 5. 裁决序与冲突路径

裁决序：**源头标记 > registry.json > 派生板 board.json**。

| 冲突 | 行为 |
| --- | --- |
| 标记号与 registry 不一致（号未被占用） | 采纳标记（标记为身份真相），补登记；`seq` 不低于该号 |
| 标记号与 registry 不一致（号已被另一活条目占用） | 号码冲突：不静默改写；diagnostics + 冲突卡降级为未领号；`--check` 非零退出 |
| 同文件/跨文件重复号标记 | 先扫者保留、后到者按未领号降级 + diagnostics；`--assign` 不自动改号 |
| 行级标记出现在非任务条目行 | 不附着任何卡 + diagnostics（位置无效） |
| 手工篡改标记里的 N | 同上裁决：未被占用即采纳（`seq` 前进）+ diagnostics 警示跳号；已占用即冲突。篡改永不被机器静默"纠正" |
| registry 空洞条目（源已删除/归档，`file`/`specRoot` 指向无对应活标记） | **合法**：号成空洞（只增不复用，`seq` 不回落）；**不算活跃指向**——`--check` 不因此失败，只在 notes 里记"号成空洞（合法）"。活跃指向判据 = 本次编译板上有对应活标记（勘误 9d 同源，T10 歧义 3 成文） |
| registry.json 损坏/丢失 | 按全部源头活标记重建（号随文件走）：每条活标记重建一条、`seq = max(活标记)`；diagnostics 记录重建。**已知限制（v2.1 成文）**：spec 特性号无内联标记载体（§1 末条），重建时不可恢复——该特性按未领号上板，`--assign` 按扫描序发**新号**（与历史号脱钩）；已删条目曾占的高水位记忆同步丢失（§12/§14 残余风险）。计划稿与 tasks.md 条目号随文件走，不受此限 |

## 6. 迁移、幂等与写入面

- **迁移不改号**：苗圃 → `docs/plans/`（旧项目 `docs/design-notes/`）的文件移动，文件头标记随文件走，registry 条目 `file` 指向更新、**号不变**；板无重复节点（docs 目标目录为 opt-in 扫描面，迁移前后需在 `.zcode/board/scan.json` 保持一致，见 §9）。
- **计划 → spec 延续**：同一事项建 spec 后，registry 条目 `kind` 改 `spec`、指向改 spec 根、号不变；原计划草案卡退役，其任务号成空洞不复用。
- **幂等**：再次 `--assign` / 编译不再改动任何号、任何文件（时间戳除外）。
- **计划码（planCode，v2.2/#46）**：计划类特性（kind=plan，含计划→spec 延续后的 spec 条目）在**首轮** `--assign` 分配 4 位显示码 `[A-Z][A-Z0-9]{3}`——手工 `--plan-code <计划稿相对路径>=<码>` 优先，缺省按文件名末段/标题首词派生、冲突顺延（确定性）；已有码幂等保留、不重分配；形态非法或与已占用码冲突 → diagnostics + 该计划走自动派生（不静默覆盖）。计划码**不参与全局序列号与引用位**，只增加显示层（`UI01-1.2`）。
- **写入面（副作用边界，设计 §12）**：默认编译对源文件**只读**；`--assign` 对源头的写入**仅限号标记**这一种语法（roadmap 子旗标由作者手写：`--assign` 不写入、不改写、不移动它），逐文件"临时文件 + 原子改名"写入，**除插入标记外不改动其余字节**（标记只增不改）。其余写目标 = `board.json`/`board.md`（编译器）+ `registry.json`（`--assign`）；`interviews.json` 仅 register 写、`runs.json` 仅 hook/应用写（文件级单写者，§1.3）。
- **防 mass 改写闸（v2.4/#72，仅 `--assign`）**：单次运行发现 **>10 个未领号计划文件**（文件头无号标记）→ **拒绝执行**：零写入、零发号，diagnostics 列全部清单 + 建议（"核查扫描面（scan.json includeDirs/excludeGlobs）/拆分登记"）；`--force` 才放行，放行亦留诊断痕迹（点名放行数量与建议）。恰 10 个照常放行（阈值判据 `>10`）。由来：远端项目 `docs/design-notes/` 296 份活历史档曾被默认扫描面吸入、逐份盖号改写。

## 7. 反例清单（作者与实现方都按此自检）

| 反例 | 判定 |
| --- | --- |
| `> blocked-by: ID-1.2` | 拒收（层级标签不是句柄）+ diagnostics |
| `> blocked-by: 1.2` | 拒收（同上） |
| `<!-- zcode-board:no=07 -->` | 非法（前导零）；不解析该标记 |
| 非条目行（正文段落/标题行）行尾标记 | 不附着任何卡 + diagnostics |
| `- [ ] 1. 事项 <!-- zcode-board: no=7 -->` 出现在两个文件 | 号码冲突路径（后到者降级未领号） |
| 手工把 `no=9` 改成 `no=5`（5 空闲） | 采纳（seq 前进）+ 跳号 diagnostics；不静默改回 |
| 计划从 `.zcode/plans/` 移到 `docs/plans/` | 号与标记不变，仅 registry 指向更新 |
| `> cancelled: 原因` 出现在 tasks.md 条目下 | 不解析（tasks.md 不引入该语法族）+ diagnostics（spec 侧取消走 progress.json / 源删除路径） |
| `> agents: implementer \| reviewer` | 整行不解析（表外角色）+ diagnostics；`assignees` 保持缺省标准管线 |
| `<!-- zcode-board: roadmap -->` 出现在 `tasks.md`、H2 及以下章节、条目行或 H1 之前 | 位置无效：不生效 + diagnostics；`--check` 非零退出（只在计划稿 H1 层合法，§2.5） |
| `> cancelled: 原因` 出现在计划稿但不在特性级落点（空行/正文/标题隔断，且上方无任务条目） | 不解析为特性级取消：不挂卡 + diagnostics（语法位置无效；落点＝H1 标记行后、首个非引用行之前，§3.1） |
| 已取消卡被当作"删除"处理（号改发他人） | 违反只增不复用：`no`/`label` 保留、`seq` 不回落；取消 ≠ 删除 |
| `docs/plans/`、`docs/design-notes/` 未 opt-in（无 `scan.json` includeDirs）却期望上板 | 默认扫描面仅 `.zcode/plans/`：不扫、不上板、`--assign` 不改写（文件零触碰）；opt-in 见 §9 |
| `scan.json` 的 `includeDirs` 写池外目录（如 `src/`、`docs/`） | 池外引用拒绝：该条不生效 + 失败级诊断（防把任意目录当计划源）；恰 `.zcode/plans/` 亦无需列出（恒扫描） |

## 8. 与其它契约文件的关系

- 号在板上的最终形态（`no`/`label` 派生——v2.2/#46 起计划任务 label = 计划内层级路径、`status` 词表含 `cancelled`、`stage`/`stageRule`、`assignees[]`、`blockers[]`、`planCode`、`currentAssignee`、`nextAssignee`（v2.3/#53：管线序首个无 done run 证据的角色；全 done → null）、`roadmap`（v2.3/#53，计划稿占位稿）、`section` 结构）见 `assets/board.schema.json` v2.3 与 `assets/samples/board.golden.json`。
- registry 条目字段见 `assets/templates/registry.template.json`（设计 §3.2）。
- 引用位的运行期形态（`cards[]`）见 `assets/templates/runs.template.json`（设计 §5.2）与 `assets/contracts/run-event.md` v2.1。

## 9. 扫描面配置（v2.4 新增，#72）

计划稿扫描面是契约的一部分（决定"哪些文件参与身份体系"）；v2.4 起配置化，唯一读取位 = 项目级文件
`.zcode/board/scan.json`（存在即解析；路径相对项目根）：

```json
{
  "includeDirs": ["docs/design-notes"],
  "excludeGlobs": ["**/archive/**", "docs/design-notes/wip-*.md"]
}
```

| 字段 | 语义 | 判据 |
| --- | --- | --- |
| （缺省） | 默认扫描面 = `.zcode/plans/` 一处 | 无 scan.json 或缺该字段 → 默认；`docs/plans/`、`docs/design-notes/` 不再默认扫描 |
| `includeDirs` | opt-in 目录池显式开启（池 = `docs/plans`、`docs/design-notes` 两项） | 元素为项目根相对目录（`./` 前缀与末尾 `/` 归一）；绝对路径、`..` 穿越、池外引用 → 该条拒绝 + 失败级诊断（防任意目录当计划源）；默认苗圃恒扫描、无需列出 |
| `excludeGlobs` | 按**项目根相对 posix 路径**排除扫描到的计划稿 | `**/` 前缀匹配零或多段路径、`**` 跨段、`*` 段内任意、`?` 单字符；其余字符字面匹配 |

- **扫描序（确定性，`--assign` 发号顺序复用）**：默认苗圃 `.zcode/plans/` → 池内冻结序（`docs/plans/` → `docs/design-notes/`），与 `includeDirs` 书写顺序无关（保障发号顺序一经启用不得更改）；目录内按文件名字典序。
- **配置错误 = 失败级，不猜**：坏 JSON / 顶层非对象 → 整份配置拒收，扫描面按默认 `.zcode/plans/` **兜底** + 失败级诊断（不部分采纳）；条目级非法（形态非法 / 池外引用 / 未知字段）→ 该条拒绝 + 逐条点名，其余合法条目照常生效。`--check` 将配置错误归入「扫描面配置」失败项（非零退出）；默认编译不阻断（按兜底扫描面出板）。
- **未 opt-in 的 docs 计划目录**：不扫、不上板、`--assign` 不改写（文件零触碰）；归档目录（`specs/archive/`、`.zcode/archive/`、`docs/archive/`）从不在扫描面。
- **归档映射不变（勘误 10 保留给 opt-in 用户）**：`docs/plans/`、`docs/design-notes/` 的归档映射 → `docs/archive/plans/`（§6），opt-in 与否都按 registry 指向直查与改写。
