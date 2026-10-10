---
name: zcode-board
description: 项目看板（.zcode/board）操作手册与纪律全量。触发词：项目看板 / 登记访谈 / 重编译看板 / 查看项目进度；另覆盖发号 --assign、审计 --check、run_event 落账、hook 安装与信任评审、工作树建清、归档与收尾对账。
---

# zcode-board — 项目看板操作手册

- 技能版本：`zcode-board/0.5.0`（与编译产物 `board.json.generatedBy`、`assets/manifest.json` 同源；映射：包 0.5.0 = 契约 v2.5 + schema v2.4；bump 规则见 §3.7。0.4.0 → 0.5.0 = 次版本级：A1 批 epic 层规格（markers §10：三层容器/`epics` 登记行/终态优先序/取消归档第四种改写/归属措辞与补录路径）+ §11 位置分层（裁决稿/设计稿禁入 plans/、`.zcode/design/` 设计区）并入契约 v2.5、schema 附加键 `epics`/`features[].epic`/`features[].phase` 转正 v2.4；叠加包侧能力：第五不变量 (e) 与卡号绑定 (f) 对账点名、源变更检测（Bash 通道 + 归档分流）、worktree 归一化（#151）、Stop 兜底重编译与 register 触发（#103）、L0 注入升级（缺口清单/在做该接/截断保留位 #130-132）、run-event 报告口径成文（#152））。
- `<skill>` = `~/.zcode/skills/zcode-board`（本文件所在目录，路径以实际安装位置为准）；`<项目根>` = 被看板管理的项目目录。
- 无第三方依赖：全部脚本仅用 Node 内置模块（`node:fs` / `node:path` / `node:url` / `node:crypto` / `node:child_process`），直接 `node` 运行，无需安装任何依赖。
- 分层：发现 = 技能清单一行 description；启动读板 = SessionStart hook 机械注入；操作细节 = 本文件按需加载；产品化内置注入 = P2（后续）。

## 1. 约束块（动笔与派发前必读）

### 1.1 位置与分层（最高频违例区）

- **AGENTS.md 只放团队表**：看板/实验功能内容零残留（关闭实验功能时项目无痕）。
- **本期工作区不维护 `doc/`、`docs/`**：一切开发流程资产在 `.zcode/`（计划稿/板/证据/hook 配置），技能资产在 `~/.zcode/skills/zcode-board/`。
- **提示词四层**：发现 = 技能清单一行描述；启动读板 = SessionStart hook；操作手册 = SKILL.md；产品化 = P2。任何新约束先问"该住在哪一层"再落笔。
- **位置分层（E1 V5；契约 §11）**：**裁决稿/设计稿/纲领稿禁入 `plans/`**——`.zcode/plans/`（计划稿苗圃）只放计划稿（命名约定 `plan-*.md`，会话稿 `plan-sess_<uuid>.md`）；裁决稿（裁决包/一次拍板清单）、设计稿、纲领稿（整体纲要）落 **`.zcode/design/`**（设计区，约定层：不在计划扫描面、不上板、不发号；`scan.json` 引用该目录按池外引用拒绝）。机械防线：`--check` 对苗圃内命中族词者（文件名首段/首个标题行任意层级首字段，判据冻结表见 `assets/contracts/markers.md` §11）逐条**对账点名**（非失败级；移位不改名、移位后自清）。

### 1.2 写入者分域（文件级单写者）

| 文件 | 唯一写入者 | 唯一入口 |
| --- | --- | --- |
| `.zcode/board/runs.json` | 机械转抄脚本 | `hooks/record-run.mjs`（前台 PostToolUse / 后台编排者代触发；`appendRun`） |
| `.zcode/board/interviews.json` | 登记脚本 | `register-interview.mjs`（append / resolve） |
| `.zcode/board/registry.json` | 发号模式 | `compile-board.mjs --assign` |
| `.zcode/board/board.json`、`board.md` | 编译器 | `compile-board.mjs`（任一模态） |
| `.zcode/board/last-reconcile.md` | Stop 对账 hook | `hooks/reconcile-stop.mjs`（对账产物：四类点名 + 第 5 节「勾选=已合并点名」+ 第 6 节「板滚未提交」（#117）+ 兜底重编译；非真相源、不进扫描面；下次 SessionStart 注入 + 人可直读） |
| `.zcode/board/exemptions.json` | 编排者（单写者） | 手写登记（速修/管理卡豁免，条目 `{no, reason, at}`——at 带时区 ISO 8601 **秒级、不接受毫秒**）；`--check` 只读校验（结构非法失败级）；唯一用途 = 抑制第五不变量 (e) 点名（不假造 run 记录） |
| `.zcode/board/evidence/<runId>/report.md` | record-run 代存归档（#123） | `hooks/record-run.mjs`（落账同源；不手抄第二份） |
| `.zcode/board/baseline-reds.json` | 编排者/验证者（单写者） | `assets/tools/baseline-redlist.mjs --init`（骨架生成；attribution 手填归因、清册红排期挂卡）；`--check` 只读比对（#124） |

- 子智能体对板文件**只读**；报告带 `run_event` 块；merge 事实经 integrator 报告落账。
- 真相源（tasks.md / progress.json / 计划稿）按既有纪律由各自作者修改，看板只在其后重编译。

### 1.3 身份与引用

- 引用一律稳定号（`9` / `#9` / `ID-9` 等价归一）；层级标签（`1.2` / `ID-1.2`）只是排版，拒入引用位；**号永不复用**、registry 高水位只增。

### 1.4 保护清单（动笔前核对）

- `design.md` / `tasks.md`：编排者维护，子智能体只读。
- 契约包（`assets/{board.schema.json,templates/,contracts/}`）：冻结，任何改动走新任务 + 版本号。
- 两份真实 plan 样例：只读，夹具用副本。
- `.zcode/config.json` 与 `probes/`：编排者管理。
- 归档移动只改文件位置：号不变、条目保留（registry 指向改写属条目允许的三种改写之一：迁移 / 延续 / 归档；归档后的实测形态见 §3.5）。

### 1.5 派发形态

- 后台方式派发；一卡一交付；特性拆卡首卡 = **tracer 卡**（走通最薄能跑主干，其余卡 `blocked-by` 它；小改动豁免须在计划稿声明理由）。
- 产出证据（红绿 / 命令输出）落 `.zcode/board/evidence/<任务>/`。
- **卡文模板与拼装器（#119/B6-1；E1 V6）**：卡文按 `assets/templates/card/card.template.md` 起草——「交付面全量枚举 + 用户原话引用」两必填段 + 验收句以「用户看到/点到什么」措辞；正/反例对照 `card.example-pass.md`（完整形态）/ `card.example-fail.md`（缺段形态）。派发 prompt 由 `assets/tools/build-dispatch-prompt.mjs` 机械拼装（卡文原文 + 约束块 `assets/templates/card/constraint-block.md` 全文随文 + 绝对证据路径 + 角色与绿数 + 只读边界）；缺必填段默认拒发（见 §3.10）。

## 2. 读板（会话启动第一件事）

1. 读 `<项目根>/.zcode/board/board.json`（不存在则读 `board.md`）。board 是编译器产物，任何判断以真相源为准。
2. 检查 `attentionSummary` 与节点 `attention`，四缺口码与固定文案：

| 缺口码 | 文案 | 含义 |
| --- | --- | --- |
| `interviewed-not-arranged` | 已访谈，尚未落卡 | 登记条目无产物或 `resolvedBy` 未指向板上节点 |
| `arranged-not-expanded` | 已安排，尚未拆解任务 | 特性上板但无任务卡 |
| `interrupted-resume` | 执行中断，可续（停在 #N） | 卡有断点 run（`stoppedAt` + `nextStep`） |
| `unmerged-worktree` | 待合并（执行现场未回流） | 卡 `worktree` 字段命中**且**目录经 fs 互证真实存在，但无 integrator done 收尾；字段命中而目录不存在 → 仅提示级 diagnostics，不计缺口（#42） |

注入清单口径（#130，SessionStart `board-context` 注入缺口短清单）：固序＝「落卡 → 拆卡 → 续跑 → 合并」（短标签：已访谈未安排 / 已安排未展开 / 执行中断可续 / 待合并），同码内按板内顺序（编译器顺序，hook 不重排，含深度 3 嵌套卡）；每条一行 `<短标签> <卡标识> <标题> [（现场 <worktree>）] → <处置行>`（处置行＝上表对应动作）；缺口多于 8 个列前 8 + 计数行；零缺口显式报「无」。

### 2.1 SessionStart 注入（board-context，L0；#130-132）

- 输出单个 JSON（additionalContext）、日志 stderr、显式 exit 0；预算 ≤20KB 字节且 ≤24k 字符（32KB 收集上限留余量），超限自截断。
- **在做/该接 top-N（#131 N=5；#135 改同源消费）**：**成员、顺序、计数一律投影 board.json 四段派生（§2.2；AD-11③ 唯一所有者=编译器，hook 禁自算、禁二份口径）**——在做＝`active[]` 逐条投影（显示行 = currentAssignee ?? activeRun.role + 自 at + 段位）；该接＝`frontier[]` 逐条投影（rank 序即板序；nextAssignee——null=管线走完不硬指）+ 上一手 run 摘要（显示细节，查板面字段）。计数头随投影（「在做 N · 该接 M；同源 board.json active[]/frontier[] 派生，列前 K」）。行首卡标识与缺口行同形态（label≠号 → `ID-<label> #N`，std-3）。旧板缺四段 → 输出指名重编译行（`frontier[]/active[]` 未写出——不另算、不回退 C1 期 runs 证据派生，#135 定性：删 fallback）。
- **陈旧告警行（#131）**：sources[] 逐文件 mtime > board.updatedAt + 1s 容差 → 点名路径并给出重编译命令（与 reconcile-stop 同口径；只覆盖已登记源——删除/新增/Bash 写入归 §6.4 Bash 通道）。板新鲜不输出；hook 只告警不重编译。
- **预算级截断与保留位（#132）**：保留位（档 1/2 降级逐字保留）＝板摘要头、陈旧告警行、缺口计数头与清单头、缺口清单各行（含 → 处置）、在做/该接计数头、上次对账行、处置行；降级顺序＝自尾部起档 1 省细节行（在做/该接与断点条目）→ 档 2 省次要摘要行（断点段头、计数行）→ 档 3 兜底（关键行**单行或累计**超闸——按行贪心整行取舍，装不下的关键行整行跳过并留 stderr 诊断，绝不取中段）。任何截断写 stderr 档位诊断；stdout 恒为单个合法 JSON。

3. 节点 `stage` 为七段位：`待设计 / 待办 / 执行中 / 审核中 / 阻塞 / 已完成 / 已取消`（带 `stageRule` 溯源）。
4. 存在任一缺口时：**先向用户确认是否处理，再开始新工作**。
5. 板可能陈旧（`updatedAt` 落后于源 mtime）：先重编译（§3.1），再看板。

### 2.2 board.json 四段索引（派生事实面；C2-1/#133 落段）

- 根级**恒写四段**（空段=[]，消费面无需存在性判空；`lib/derive.mjs` `deriveBoardIndex` 唯一所有者=编译器，AD-11③）：
  - `frontier[]`＝可执行前沿——stage=待办 且无未解除阻塞项（依赖全终态/无依赖），按板序 `rank=1..n`；条目 `{rank,no,title,stage,nextAssignee,resolvedDeps[]}`（`resolvedDeps`=已解除依赖号数组；命名避开引用位保留字 `blockedBy`——`--check` 引用位深扫把该键视为单号引用位，数组形态判非法）；
  - `active[]`＝在途活跃——stage∈{执行中,审核中}（板级五槽「运行/待收口」同源于本段，以 stage 判别）；条目 `{no,title,stage,currentAssignee,activeRun,nextAssignee}`；
  - `blocked[]`＝受阻归因——非终态卡的未解除阻塞项逐项一行（一卡多项出多行；`external` 恒未解除、`dependency` 仅目标终态解除、缺号/离板保守计入）；条目 `{no,title,stage,blockerKind,targetId,summary}`；
  - `recent[]`＝最近活动——runs 按 `at` 新→旧（同刻按追加序）取前 10（N=10 成文），每 (run×卡) 一行、仅板上有号卡计入；条目 `{no,title,at,role,result,stoppedAt,next}`——**不带 runId**（单一事件单一家，勘误 4；事件身份由 (no,at,role) 承载，runs 全史在 runs.json）。
- 选取域＝任务卡级节点（有稳定号，含嵌套子卡；特性/容器不进段——容器进度由组头 rollup 承载）。段间对偶：待办卡 ∈ frontier ⟺ 不在 blocked。
- 消费面（hook 注入/UI）**只读投影、禁自算、禁二份口径**（§2.1 在做/该接即 active[]/frontier[] 投影；五槽映射：运行/待收口 ← active[]（stage 判别）、阻塞 ← blocked[]（按板序+卡内原文序逐行投影））。旧板缺四段＝未重编译，指名重编译、不猜。
- 完整口径冻结于 `assets/board.schema.json` x-decisions 四段条目与契约 §13.6；`--check` 派生不变量断言 (i1)-(i4) 见 §3.1 校验项。
- **board.md 渲染（A3-1/A3-2/#84-85）**：`board.md` 含 **epic 章**——三层容器渲染（epic 章 `# <码> · <标题>`（含登记行终态标注）→ 期次组（组合成编号只作容器层名/组头，卡编号不混号）→ 成员稿块；特性后、诊断前）；顶层稿与 epic 章成员稿共用一份渲染块；无 epic 稿顶层平铺（不渲染"未归属"提示，#79）。渲染编号与 `board.json` 派生逐字段一致由 `--check` 不变量 (c) 对照（含 epic 章/期次组/合成编号扩面，A3-3/#86）。

## 3. 命令表（逐字可执行；`<skill>` 与 `<项目根>` 替换为实际路径）

### 3.1 编译器（同一 CLI：默认只读 / `--assign` 发号 / `--check` 审计 / `--version` / `--manifest`）

```bash
node <skill>/assets/compile-board.mjs <项目根>            # 默认：只读编译，写 board.json + board.md
node <skill>/assets/compile-board.mjs <项目根> --assign   # 发号：写源头号标记 + registry.json + 自动重编译
node <skill>/assets/compile-board.mjs <项目根> --assign --force  # 强制放行 >10 未领号计划文件的批量发号（留诊断痕迹；先核查扫描面）
node <skill>/assets/compile-board.mjs <项目根> --assign --epic <码>              # epic 归属补录（§10.7/§3.9）：目标稿自动占下一 phase 序号
node <skill>/assets/compile-board.mjs <项目根> --assign --epic <码> --epic-file <相对路径>  # 显式目标清单（可重复）：既有稿批量补录
node <skill>/assets/compile-board.mjs <项目根> --assign --epic <码> --epic-title <标题>    # 登记行缺失时由机具创建（SPEC-1 裁定 a；已存在则忽略+幂等提示）
node <skill>/assets/compile-board.mjs <项目根> --check    # 审计（只读）：三方一致 + 结构校验，不一致非零退出
node <skill>/assets/compile-board.mjs --version           # 版本：一行 包版本 / 契约版本 / schema 版本（只读）
node <skill>/assets/compile-board.mjs --manifest          # 清单：重新生成 assets/manifest.json（三版本 + 关键文件 sha256）
node <skill>/assets/compile-board.mjs --help              # 用法与参数
```

- 三态缩写与退出码：默认与 `--assign` 成功 0；`--check` 通过 0、有失败项 1、用法错误 2。
- `--version`：单行读取三版本（`assets/lib/version.mjs` 包版本常量 → `markers.md` 变更段头 → `board.schema.json` 的 `x-schemaVersion`），无需 `<项目根>`、只读，退出码 0；版本映射与 bump 规则见 §3.7。
- `--manifest`：重新生成 `assets/manifest.json`（内容寻址：三版本字段 + 关键文件 sha256），不读取 `<项目根>`、不写板；P2 分发用清单比对已装版本（文件变更后必须重新生成——`run-scenarios.mjs` 场景 67c 断言仓库内清单与重新生成一致）。
- 扫描面（#72/契约 v2.4，配置见 §3.8）：`.zcode/board/{interviews,registry,runs}.json`、`specs/<f>/{progress.json,tasks.md}`、计划稿**默认只扫 `.zcode/plans/`**（`docs/plans/`、`docs/design-notes/` 需 `.zcode/board/scan.json` opt-in）；不解析 `.zcode/workflows/`；不执行 git；默认对源零写入。
- `--assign` 的写入面**仅限**号标记与 registry；按确定性扫描顺序发号（specs 字典序 → 计划目录冻结序 → 文件内文档序），二次运行幂等。
- `--assign` 防 mass 改写闸（#72）：单次发现 **>10 个未领号计划文件** → 拒绝执行（退出码 1，零写入；诊断列全清单 + 建议"核查扫描面/拆分登记"）；`--force` 才放行并留诊断痕迹。恰 10 个照常放行。
- `--assign --epic <码>`（A2-1/#81；契约 §10.3/§10.7.2 补录通道）：**登记行前置**——registry 须已有该 epic 登记行（`epics` 段 `{code,title,status}`；登记与补录分离）。**`--epic-title <标题>` 创建通道（A2 回炉/SPEC-1 裁定 a）**：登记行**缺失**且给非空标题时由机具创建 `{code,title,status:"active"}`（唯一写者：仅缺失时创建、绝不覆盖既有行；epics 段结构损坏 fail-closed 拒执行；已有行时 title 忽略+幂等提示；缺 title 仍拒绝并指引 §3.9）。终态（cancelled/archived）不接纳新成员（零写入，退出码 1）。目标稿写入 `epic:"epic:<码>"`+`phase` 原子对（**只加归属对**：号/计划码/`assignedAt`/源标记零变动）。**自动占下一 phase**：基准=活跃成员期次 max+1；候选与已消耗期次冲突 → **顺延**（期号永不复用，AD-9①）；**同批一次运行=同一新期次**（一期多稿合法；补齐既有期次按批次顺序——先跑批先占期）；幂等（重跑零变化）。目标选取：缺省=未领号计划稿；既有稿走 `--epic-file`（可重复，逐项须扫描面内计划稿）——不广谱改写（防 mass 改写闸同纪律）。用法错误（码非 4 位冻结形态/重复给出/缺 `--assign`/`--epic-file` 缺 `--epic`/与 `--check` 混用）退出码 2。
- `--check` 不自动修复：修复 = 重编译（或 `--assign`）+ 人工修源；扫描面配置错误（坏 scan.json / 池外引用）→ 失败项「扫描面配置」非零退出。

`--check` 校验项（第 1–4 条失败级、非零退出；第 4/e、4/f 两项对账点名级、不阻断退出码；板正常时零噪声）：

1. 源完整性：解析失败 / 结构不合法 / 不受支持版本 → 失败。
2. 活条目清单 ↔ registry：活号唯一、活标记必有条目、`kind`/指向一致；空洞条目合法；归档条目按指向路径直查（详见 §3.5）。
3. `board.json` ↔ 重编译期望逐字段比对（篡改/板陈旧 → 差异报告）+ 结构校验（schema 子集 + T7 公共不变量）。
4. **事实互证不变量（#56，`lib/fact-invariants.mjs` 纯函数；磁盘板与重编译基线各跑一遍）**——板自己回答"这数对不对"：
   - (a) 特性子卡全部 `completed` → 特性 `stage=已完成`（计划稿特性段位随子卡汇总，契约 v2.3；roadmap 占位稿段位被压制，不在本判据域）；
   - (b) 已有任务卡（`tasks.length>0`）的特性不得挂 `arranged-not-expanded`（判据为零卡；roadmap 稿同理——压制段位≠可挂"未拆解"）；
   - (c) `board.md` 渲染编号形态 ↔ `board.json` 的 `planCode`/`label` 派生一致（嵌套任务行含递归深度 ≥2；D1 类渲染回归由此咬住；T5356r TQ-1 扩面：`## 待处理`/`## 待合并` 节的编号链同入对照面）；
   - (d) 段位计数：`board.json` 如携带 `stageSummary`（七段位计数对象）→ 与全板节点 `stage` 逐项复算相等；不携带则不判。
   - (e) **勾选=已合并证据【对账点名级，非失败、不阻断退出码】（#97）**：`completed` 任务卡须有该卡 `integrator done` 的 run 证据（证据 = runs.json 中 `role=integrator` 且 `result=done` 且 `cards` 含该号；`partial/failed/interrupted` 不算；特性汇总态与未领号卡不判）。缺证据 → 独立「对账点名 N 项」节逐条点名；补录 = 补跑 integrator 落账或登记豁免（`.zcode/board/exemptions.json`，编排者单写者；坏登记归失败项「豁免登记」——结构非法（非对象 / `version≠1` / `exemptions` 非数组）整份拒收、条目级非法该条不生效 + 点名、**同号重复仅指合法条目间**；不假造 run 记录）。
   - (f) **卡号绑定【对账点名级，非失败】（#152；E4-09/V31）**：板面 `worktree`（#151 归一后的现场实际路径，板根相对）末段 `task-<no>` 须等于该卡稳定号（工作树命名即反查，设计 §6.1）；错配逐条点名（与 (e) 同节输出）。判定域：仅板面 `worktree` 非空且带稳定号的卡——**现场不在/已清的历史错配不进判定，由 #42 提示级承载**（判定域残余显式承认）；多卡块单一声明**逐卡判定**（推荐一卡一块）；现场合并/正规清理后字段随派生清空（自清）。
   - **(i) 派生四段不变量【失败级】**（C2-2/#134；`lib/fact-invariants.mjs` `checkDerivedIndexInvariants`，由 `checkFactInvariants` 并入失败级出口——磁盘板与重编译基线各判一遍）：
     - (i1) `frontier[]` 复算一致：＝段位待办 且无未解除阻塞项（依赖全终态/无依赖），按板序 `rank=1..n`；缺行/多出行/字段（title/stage/nextAssignee/resolvedDeps）错位/顺序错位逐条点名；
     - (i2) `recent[]` 排序与截断：条目 `at` 须带时区 ISO 且非升序（新→旧；同刻保持 run 追加序——同刻次序无板面承载体，不判），条数 ≤ N=10，每行须落在板上活号卡（离板引用不进活动面）且 `title` 与该卡同值；
     - (i3) `blocked[]` 归因完整：非终态卡的每个未解除阻塞项**恰一行**（一卡多项出多行；`external` 恒未解除，`dependency` 仅当目标卡段位 ∈ 终态才解除，缺号/离板保守计入），按板序、卡内按 blockers 原文序逐行对照；
     - (i4) 段间对偶：待办卡 ∈ frontier ⟺ 不在 blocked——两面同时命中（既称可执行又称受阻）或两面皆无（既不可执行又无归因：派生漏归因）均必咬。
     判定域 = 有稳定号的任务卡（含嵌套；特性/容器不进段）；**携带即判**（段键缺省不判——缺键由「board 不一致」与 schema 面承载，旧板/手写夹具零噪声）；判据常量独立复写，经 S-1 守卫与 `derive.STAGE.TODO`/`TERMINAL_STAGES`/`RECENT_LIMIT`/`ISO_RE` 及 schema `blocked[].blockerKind` 枚举逐项对照（改名即红）。场景 134 留档（手工改板反例矩阵 + 绿侧零噪声 + 截断探针）。
   校验失败项逐条点名（失败级；归口 `--check`，非板内 diagnostics）：路径（`features[i].tasks[j]…`）+ 节点编号（`#N`/计划码）+ 两值对照。

### 3.2 访谈登记（interviews.json 唯一写路径）

```bash
node <skill>/assets/register-interview.mjs <项目根> append --topic "<主题>" --summary "<结论一句话>" --outcome <none|plan|spec|tasks>
node <skill>/assets/register-interview.mjs <项目根> append --topic "<主题>" --summary "<结论一句话>" --outcome plan --session-id <会话 id> --decisions "<结论要点>" --artifacts <相对路径>
node <skill>/assets/register-interview.mjs <项目根> resolve --id itw-<日期>-<短后缀> --resolved-by <特性节点 id>
node <skill>/assets/register-interview.mjs --help
```

- `append`：生成不可变 id（`itw-<YYYYMMDD>-<短后缀>`）与 `at`；`--topic` / `--summary` / `--outcome` 必填；未知信息留空不猜；`--session-id` / `--decisions` / `--artifacts` 可选且 `--decisions`、`--artifacts` 可重复。
- `resolve`：按 id 回填 `resolvedBy` 并置 `status=resolved`（登记事件的唯一允许改写）；id 未命中报错且不写。
- **注册后触发重编译（#103）**：`append`/`resolve` 成功后自动重编译——新访谈即上板（免手动编译）；板未建立或编译器缺失时跳过；编译失败只写 stderr 诊断、主流程照常成功（登记与退出码契约不变）。
- 特性节点 id 形态：计划稿 `plan:<stem>`（如 `plan:sess_<uuid>`）、spec `spec:<f>`、访谈 `interview:itw-…`。
- 退出码：0 成功；1 运行错误（id 未命中 / 源损坏 / IO）；2 用法错误。

### 3.3 run 落账（runs.json 唯一写路径，代触发形态）

```bash
pbpaste | node <skill>/assets/hooks/record-run.mjs --cwd <项目根> --session-id <会话 id>
```

- 前台派发：PostToolUse(`Agent|Task`) hook 自动触发（stdin = 完整 payload），无需手动。
- 后台派发：编排者收到报告后以上述命令代触发（stdin = 报告原文，含 `run_event` 块）；可选 `--tool-name <名>`。
- 一执行一落账：落账同步、随后自动重编译；无块 / 解析失败 / 落账失败只写 stderr diagnostics，进程退出码恒 0。
- **报告同源代存归档（#123/V13）**：落账成功后，record-run 把本次解析出的报告原文（与 `run_event` 抽取同一次解析的输出）逐字代存到 `.zcode/board/evidence/<runId>/report.md`——`runs.json` 记录 schema 不变，"报告正本"走归档文件；**不要再手抄第二份**。
- **代存去重与点名（必咬）**：`evidence/` 一层下已有逐字一致的 `report.md`（代存归档或手写副本）→ 不重复写入 + stderr 点名既有路径（疑似重复落账：双触发/手写第二份）；同 runId 首写为准（不覆盖首份）。去重只作用归档面：`runs.json` 照常追加（落账行为零变化）。
- **代存失败语义**：归档失败只写 stderr diagnostics，不影响落账结果与退出码（hook 失败永不阻塞主流程）。
- **证据头规范（#123/V21）**：证据文件头两行 = `运行命令（可复现）：cd <项目根绝对路径> && <完整命令>` + `运行环境：node <版本> · <平台/架构> · <时点>`（模板 `assets/templates/card/evidence.template.md`；不可复跑证据补 `<!-- 不可复跑：<原因> -->` 声明）——复跑人按头原样复跑（V21 验证清单固定项）。

### 3.4 工作树（建与清只走正规路径；详见 `assets/worktree-discipline.md`）

```bash
cd <项目根>
git worktree list                                        # 先查现场（复用优先）
git worktree add .zcode/worktrees/task-<no> -b task-<no> # 建树：一张卡一个工作树，名字=稳定号
git check-ignore .zcode/worktrees/task-<no>              # 断言：命中（现场不进版本库）
git worktree remove .zcode/worktrees/task-<no>           # 合并后清理
git worktree prune
git branch -d task-<no>                                  # -d 而非 -D；未合并会被拒绝（退回，不 -D）
```

- 只开一层（工作树内不再 `add`）；不手工 `rm` / `cp` / `clone` 造现场；`remove` 被拒时先查 `git status` 与残留登记，不直接 `--force`。
- **脚本化单点（#122/B6-4；E1 V31）**：建树/复用/树名下发走 `assets/tools/create-worktree.mjs`（上述冻结步骤脚本化，只增不改）：`node <skill>/assets/tools/create-worktree.mjs --no <卡号> --root <项目根>`（或 `--source <计划稿> --card <标签|稳定号>`；`--expect-name` 校验交接材料声明的树名逐字等于 `task-<卡号>`）。执行序与 §3 同构（先查现场 → add → check-ignore（脚本内前置断言）→ 后核）；幂等复用（同名树已登记且分支相符 → 「结果=复用」零动作）；stdout 五条机读线 `结果=/树名=/分支=/现场=/路径=`；树名与卡号不符四类形态必咬（错名/错支现场/号不一致零建树/非法号形态；详版 `assets/worktree-discipline.md` §3.1）。
- 发号只在主检出运行，执行现场（worktree 内）不发号。
- **判据互证（#42）**：`unmerged-worktree` 缺口要求卡 `worktree` 字段命中**且**目录经 fs 互证真实存在；字段命中而目录不存在 → 只落提示级 diagnostics（"runs 声明工作树但目录不存在"），不计缺口、不进待合并聚合。互证面 = 板根与一层子项目根下的 `.zcode/worktrees/`（跨项目现场常驻子项目根，如 `ZPaPa/.zcode/worktrees/task-32`；声明侧可写相对各自项目根的 `.zcode/worktrees/task-<no>`）。**#71 起声明接受两形态**：`.zcode/worktrees/task-<no>` 或 `<子目录>/.zcode/worktrees/task-<no>`（末段号解析；其余形态拒收 + diagnostics）；降级诊断同因合并——同一 run 的同一声明落到多张卡时合并为一条并点名 run，单卡维持原「卡 #N + 路径」文案形态。

### 3.5 归档（移动文件，节点离板；号与条目保留）

```bash
cd <项目根>
mkdir -p .zcode/archive                                   # 归档目录不在扫描面；首次归档时建立
git mv .zcode/plans/<稿>.md .zcode/archive/<稿>.md        # 本工作区全 .zcode 退驻形态；通用映射见下
node <skill>/assets/compile-board.mjs <项目根>            # 重编译：归档稿从板上消失
node <skill>/assets/compile-board.mjs <项目根> --check    # 审计：归档条目按指向直查（存在且含标记 → 通过并 note"已归档"）
```

- 通用映射：`docs/plans/ → docs/archive/plans/`、`docs/design-notes/ → docs/archive/plans/`、`specs/<f>/ → specs/archive/<f>/`；本工作区只用 `.zcode/plans/ → .zcode/archive/`（全 `.zcode` 闭环）。
- 归档 = 只移动位置；文件与 git 历史完整保留；号永不回滚（registry 条目保留、`seq` 不回落、归档不释放号）。
- 归档后实测：板节点（含全部子卡）消失；`sources[]` 不含归档路径；`specs/archive/` 按名排除、不当 spec 根。
- 移动后运行 `--assign`：为归档条目改写指向（`file`/`specRoot` → 归档路径），**号不变、`assignedAt` 保留**——与苗圃迁移、计划→spec 延续同构的第三种指向改写（勘误 10）；重编译后自动落板。
- `--check` 按指向路径直查：归档件存在且含该号标记 → 通过并 note"已归档"；指向不存在且归档候选已验证（移动后未改写指向）→ 失败级诊断（写明运行 `--assign` 可机械修复）；指向真失效且无候选 → 提示级独立诊断（号不复用、条目保留，勘误 10）。
- 已归档号被 `blocked-by` 引用 → 走勘误 9d 文案 A（不造引用 `blockedBy` 缺省 + diagnostics"目标可能已归档"）。
- 归档前先处理指向该节点的引用：访谈 `resolvedBy` 指向消失节点会退回 interview-only、卡号引用会出 diagnostics（均按 §12 降级提示，不静默）。
- 时机：特性 `completed` 且超 7 天冷却期；Stop 对账第四类"待归档"只点名，移动由编排者执行。
- **移动后 Bash hook 即时分流（#102）**：`git mv`/`mv` 删除源的目标命中勘误 10 归档映射候选 → `watch-sources` 判**合法转移**（不判违规）并输出「合法转移提示」，指向 `--assign` 指向改写（与 `--check` 归档直查**同一指引句**：运行 --assign 改写指向（号不变、assignedAt 保留，勘误 10）；hook 只提示、不写板、不自动重编译）。真删除 / 移出项目根 / 非归档目标 / **归档根下非映射子路径**（精确映射判据，防 --assign 无法机械修复的改写）→ 维持板陈旧告警（两文案分流，误判由 run-t13 W14 咬住）。
- 新条目继续领 `seq+1`（归档不释放号，号永不复用）。

### 3.6 hook 安装与信任评审

在 `<项目根>/.zcode/config.json` 写入五项声明（**必须有 `hooks` 包装层**，缺包装层被静默跳过、不提示评审；项目级配置仅当会话工作目录能看到该文件时才被发现）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        { "hooks": [ { "type": "command", "command": "node", "args": ["<skill>/assets/hooks/board-context.mjs"], "timeoutMs": 10000, "statusMessage": "注入看板缺口与断点" } ] }
      ],
      "Stop": [
        { "hooks": [ { "type": "command", "command": "node", "args": ["<skill>/assets/hooks/reconcile-stop.mjs"], "async": true, "statusMessage": "收尾对账" } ] }
      ],
      "PreToolUse": [
        { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node", "args": ["<skill>/assets/hooks/gate-merge.mjs"], "timeoutMs": 10000, "statusMessage": "合并门禁" } ] }
      ],
      "PostToolUse": [
        { "matcher": "Agent|Task", "hooks": [ { "type": "command", "command": "node", "args": ["<skill>/assets/hooks/record-run.mjs"], "timeoutMs": 30000, "statusMessage": "执行记录落账（前台派发；后台派发由编排者代触发同一脚本）" } ] },
        { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "node", "args": ["<skill>/assets/hooks/watch-sources.mjs"], "async": true, "statusMessage": "看板重编译" } ] }
      ]
    }
  }
}
```

步骤：

1. 写入声明后，在**应用内完成信任评审**（sha256 摘要；未完成前一律 pending、不执行）。
2. 非 UI 通道（依据 `evidence/A5-posttooluse-payload.md` 记录）：`zcode hooks trust status|review|grant|revoke`，例 `zcode hooks trust grant --workspace <path-or-identity> --all-current --bundle-digest <sha256>`。
3. 任何配置编辑（声明文本 / 顺序 / 超时 / 输出上限）都会使既有信任记录失效——改后重新评审。
4. hook 语义：落账同步、重编译与对账 async；失败永不阻塞主流程（唯一有意阻断 = `gate-merge` 拦截无三绿证据的 base 合并；`guard-board` 双断言阻断 = 板数据文件禁写 + 证据存在性，#113/B5-1——声明文案与安装清单见 `evidence/T113/hook-declaration.user-level.md`，**user 级声明生效性待晨间部署检查点与用户一起核装**）；注入型脚本中仅 board-context 输出单 JSON（日志走 stderr、显式 exit 0）；reconcile-stop 按 R3 裁决 stdout 恒空（写 `.zcode/board/last-reconcile.md`：四类点名 + 第 5 节「勾选=已合并点名」+ 第 6 节「板滚未提交」（#117：板数据文件（board.json/board.md/registry/interviews/runs/exemptions）有未提交变更即点名，提示级；提交建议=板滚并入收口 commit；非 git 项目跳过零噪声）+ 兜底重编译（#103，检查先/重编译后）；不强推续跑）。启用 Bash 告警通道需把 PostToolUse(Write|Edit) 声明的 matcher 扩为 `Write|Edit|Bash` 并重做信任评审（§6.4）。
5. **本工作区现状**：探针已于 T16 通过后移除，config 为终态（五正式声明）；T19 前一次性做信任评审（先评审等于评两次）。

### 3.7 版本策略（包版本 / 契约版本 / schema 版本）

三版本各有**唯一事实源**，`--version` 与 `--manifest` 只读取、不手写第二份：

| 版本 | 事实源 | 读取方（派生位） |
| --- | --- | --- |
| 包版本 | `assets/lib/version.mjs` 的 `SKILL_VERSION` 常量 | `board.json.generatedBy`（形态 `zcode-board/<包版本>`）、`assets/manifest.json`、SKILL.md 头部版本行（手写位，由测试断言守卫同值） |
| 契约版本 | `assets/contracts/markers.md` 最新变更段头（`vX.Y 变更段` / `vX.Y 补篇段`） | `--version`、`assets/manifest.json` |
| schema 版本 | `assets/board.schema.json` 根级 `x-schemaVersion` | `--version`、`assets/manifest.json` |

映射（当前）：**包 0.5.0 = 契约 v2.5 + schema v2.4**（0.2 为编译器历史版本号；包版本自 0.3.0 起按语义化维护；0.5.0 = 次版本级——A1 批 epic 层规格（§10）+ 位置分层（§11）并入契约 v2.5、schema 附加键转正 v2.4；v2.4 已被 #72 扫描面配置占用故顺延；叠加第五不变量/卡号绑定/源变更检测/worktree 归一化/L0 注入升级等包侧能力，旧产物仍可读）。

bump 规则：

- 修订 = bug 修复与文档勘误：不动契约/schema 版本，只升包版本末位（如 0.3.1）。
- 次 = 能力新增且契约向后兼容：可连带升契约/schema 次版本，旧产物仍可被新版本读取（如 0.4.0）。
- 主 = 破坏性契约变更（语法族删除/收窄、字段语义反转、接受集不兼容收窄等）：契约破坏性变更必须连带升包版本主位（如 1.0.0）。
- 任一轮升级后：重跑 `--version` 与 `--manifest` 刷新 `assets/manifest.json`，并跑三处同源断言（`assets/test/run-scenarios.mjs` 场景 67a–67c：SKILL.md 头部 ↔ 常量 ↔ `generatedBy` ↔ manifest）。

### 3.8 扫描面配置（`.zcode/board/scan.json`，契约 v2.4 / #72）

计划稿扫描面的唯一配置位（存在即解析；路径相对项目根）：

```json
{
  "includeDirs": ["docs/design-notes"],
  "excludeGlobs": ["**/archive/**", "docs/design-notes/wip-*.md"]
}
```

- **默认**：只扫 `.zcode/plans/` 一处（无 scan.json = 默认面，不猜）。`docs/plans/`、`docs/design-notes/` 默认**不扫、不上板、`--assign` 不改写**——远端项目 296 份活历史档被批量盖号改写事故的机械防线。
- `includeDirs`：只能引用 **opt-in 池**（`docs/plans`、`docs/design-notes` 两项）；池外引用 / 绝对路径 / `..` 穿越 → 该条拒绝 + 失败级诊断（防把任意目录当计划源）；扫描序固定 = 默认苗圃 → 池内冻结序（与书写顺序无关，保发号确定性）。
- `excludeGlobs`：按项目根相对 posix 路径排除（`**/` 前缀匹配零或多段、`**` 跨段、`*` 段内任意、`?` 单字符）；被排除文件不扫不在板（文件零触碰）。
- 配置错误：坏 JSON / 顶层非对象 → 整份配置拒收 + 按默认面兜底 + 失败级诊断（不猜、不部分生效）；条目级非法 → 该条拒绝 + 点名。`--check` 将配置错误归「扫描面配置」失败项（非零退出）。
- 归档映射（§3.5）**保留给 opt-in 用户**：`docs/plans/ → docs/archive/plans/`、`docs/design-notes/ → docs/archive/plans/`。
- **非计划稿位置（契约 §11）**：裁决稿/设计稿/纲领稿落 `.zcode/design/`——**不属扫描面**（默认面与 opt-in 池均不含；`includeDirs` 引用按池外拒绝）；`--check` 对苗圃内该类稿逐条对账点名（非失败级、不阻断退出码），移位后自清。
- 契约条文：`assets/contracts/markers.md` v2.5 §9（扫描面配置）、§6（防 mass 改写闸）、§11（位置分层）。

### 3.9 存量补录操作节（epic 归属补录；规则权威面 = markers.md §10.7）

1. **登记 epic**（若尚无）：registry `epics` 登记行 `{code, title, status}`——code 4 位冻结形态、唯一、永不复用（§10.2/§10.5）。
2. **批量补录**：`node <skill>/assets/compile-board.mjs <项目根> --assign --epic <code> [--epic-file <相对路径>…] [--epic-title <标题>]`——目标稿占期次序号（自动占下一 phase；**同批一次运行 = 同一新期次**（一期多稿合法）；补齐既有期次按批次顺序执行——先跑批先占期，历史期次在前）；目标 = 缺省未领号计划稿，既有稿按显式清单（`--epic-file` 可重复，逐项须扫描面内计划稿）；幂等（重跑零变化、期号不重发；冲突顺延 = 候选期号已被消耗时顺延到下一个未消耗号）；写入面 = registry 条目 `epic`/`phase` 原子对（只加归属对——号/计划码/`assignedAt`/源标记零变动）；登记行缺失时可随 `--epic-title` 由机具创建（见 §3.1），终态/形态非法拒绝执行（零写入）。
3. **复核**：重编译 + `--check`——归属断言包（A2-2）逐项通过；**无 epic 稿不受牵连**（照常顶层、零噪声）。
4. **纪律**：补录只加归属对（号/计划码/`assignedAt`/源标记零变动）；不手工直改 registry、不走 `--assign --epic` 之外口径；不强行回填（单稿可不归属、PREV 型保持顶层；同产品多期次**应当**归同一 epic，散放/错放由 plan-reviewer「归类正确」项交审查门）。

### 3.10 卡模板与派发 prompt 拼装（#119/#120/#121/#124；E1 V6/V7/V9/V27）

```bash
node <skill>/assets/tools/build-dispatch-prompt.mjs --source <计划稿> --card <标签|稳定号> \
     --evidence <绝对证据路径> [--role <角色>] [--type <卡类型>] [--level <验证等级>] \
     [--constraints <约束块文件>] [--unverified <未验证面清单文件>] [--out <文件>] [--allow-partial]
```

- 拼装输入 = 卡条目（`--source` 只读抽取；标签与稳定号等价命中）+ 约束块（缺省 `assets/templates/card/constraint-block.md`，constraint-block/2，随派发全文内嵌）；输出 = 派发 prompt 骨架（①卡文原文 ②约束块 ③绝对证据路径 ④角色与绿数 ⑤只读边界 ⑥可选未验证面注入）。
- **两必填段门槛（#120/B6-2；E1 V7）**：卡文缺「交付面全量枚举 / 用户原话引用」任一段 → 默认**拒发**（stderr 点名缺哪段、stdout 空、`--out` 不写出，**退出码 3**）；`--allow-partial` 为显式放行调试口（仍点名；非派发路径；放行产物与正常骨架不可区分，仅限调试/对照）。
- **卡类型与需齐绿清单（#121/B6-3；E1 V9）**：启发式判定 ui → hook → 断言 → 纯 md 文档 → 默认代码卡（判定依据随拼装日志显式输出，不猜死）；`--type ui|assertion|hook|doc|code` 覆盖，`--level 正式|跟进|微卡` 标注绿数层级；UI 卡 = 三绿 + 第四绿（ui-designer）+ 浏览器断言（**不随 level 消减**）。注意：清单的「UI 卡」判据是卡文启发式，**合并期 UI 面判定以 gate-merge 的 diff 判据（`packages/ui/` 前缀）为准**（两处判据轴不同，B6 评审 STD-7）。
- **未验证面注入（#124/B6-6；E1 V27）**：`--unverified <清单文件>`（一行一项）逐条注入骨架「## 6. 未验证面」段；文件缺失退出码 2；清单为空（0 项）退出码 3 拒发（不静默省略注入）。
- 退出码：0 = 已拼装（放行）；2 = 用法/输入错误（卡未找到、证据路径非绝对、`--type/--level` 取值非法、`--unverified` 文件缺失等）；3 = 卡文缺必填段拒发（`--allow-partial` 可显式放行缺段）或未验证面清单为空拒发。拒发与用法错误互不混淆——缺段/空清单 = 拒发（补全后重试）；取值非法/文件缺失 = 用法错误。

### 3.11 基线红清册（#124/B6-6；E1 V26）

```bash
node <skill>/assets/tools/baseline-redlist.mjs --init --root <项目根> --from <套件输出>     # 生成骨架清册（--from 可重复；缺省读 stdin；reds[]={id,label,firstSeen,attribution}）
node <skill>/assets/tools/baseline-redlist.mjs --check --root <项目根> --from <套件输出>    # 三态比对：既有不误报 / 新红必咬（exit 4）/ 已消解移出点名
```

- 用途：任何「零新增失败」结论必须基于改动前基线跑或清册——既有基线红（如 67c manifest 陈旧的长期归因红）登记成册后，`--check` 只对**新增红**报错，既有红重现标注「既有」（回显归因）、已消解移出点名。管线形态：`node assets/test/run-scenarios.mjs 2>&1 | node <skill>/assets/tools/baseline-redlist.mjs --check --root <项目根>`。
- 退出码：0=无新增；2=用法/输入错误（清册缺失/坏 JSON/形态非法/版本不符/输入无套件标记——fail-closed 不猜「无新增」）；3=`--init` 遇既有清册未 `--force`（拒覆盖，保护人工归因）；4=检出新增红。
- 维护：新增红修复或归因后 `--init --force`（仍红条目保留 `firstSeen`/`attribution`；已消解移出并点名）；归因与排期由编排者/验证者维护；清册红长期挂账 → 挂卡治理。`--unverified` 注入联动见 §3.10。

## 4. 标记语法（markers.v1 语法族；版本增补：v2.1 `cancelled`/`agents`；v2.3 `roadmap` 子旗标（#53）、v2.3 补篇特性级 `> cancelled:` 落点（#66）；权威全文 `assets/contracts/markers.md`，当前契约 v2.5）

两个落点、共用解析正则 `/<!--\s*zcode-board:\s*no=([1-9][0-9]*)(?:\s*,\s*roadmap)?\s*-->/`（v2.3 起吸收可选 `roadmap` 子旗标；`no=` 组捕获语义不变，书写形态以单空格规范形态为准）：

| 落点 | 位置 | 例 |
| --- | --- | --- |
| 计划稿（文件级） | 文件头注释，全文件首个有效 | `<!-- zcode-board: no=6 -->` |
| 任务条目（行级） | 条目行行尾 | `- [ ] 1. 标题 <!-- zcode-board: no=7 -->` |

- `N` 为正整数稳定号；缺号完全容错（按"未领号"上板 + 提示运行 `--assign`）；**不得手写或改动标记**。
- spec 特性号无内联标记：以 spec 根为键绑定在 registry 内。

`roadmap` 子旗标（v2.3/#53，仅计划稿文件级；权威 markers.md §2.5）：

- 形态：`<!-- zcode-board: roadmap -->` 独立注释，或与号标记同注释 `<!-- zcode-board: no=N, roadmap -->`（推荐独立注释——号标记逐字节不变；同注释时 `no=` 捕获语义不变）。
- 语义：该计划稿特性 `roadmap: true`；特性与**全部任务卡**段位恒为「待设计」（`status` 照常派生、仅段位压制）。**例外（v2.3 补篇/#66）**：`status=cancelled` 的卡/特性为终态、不让位——段位照常「已取消」（终态优先序 = 特性自身 cancelled > 全取消子卡 rollup > roadmap 压制 > 其余推导，markers §3.1；epic 壳层同序 §10.5）。
- 合法位置：计划稿 H1 标题行之下、首个二级及以下标题或任务条目之前，且不在条目行上；合法位置多条 → 首个有效者生效、其余忽略 + diagnostics。
- 非法位置（H2 及以下章节内 / H1 之前 / 条目行上 / `tasks.md` 中 / 计划稿无 H1）→ 不生效 + diagnostics 逐处点名，`--check` **非零退出**（需人工移动或删除，`--assign` 不自动修）。
- 与缺口无关：有卡计划稿不挂 `arranged-not-expanded`（判据=零卡）；零卡 roadmap 稿照挂（宁误报不漏报）。

引用行（写在任务条目下方同缩进块内，归属**上方最近条目**）：

| 语法 | 语义 |
| --- | --- |
| `> blocked: <原因>` | 外部受阻；不产生 `blockedBy` |
| `> blocked-by: <句柄>` | 卡间依赖；句柄三种等价写法 `9` / `#9` / `ID-9` 归一为整数 |
| `> cancelled: <原因>`（卡级：任务条目下方同缩进块内） | 取消留痕：条目保留、卡 `status=cancelled`（终态）、号永不复用；取消优先于勾选（v2.1 增补，随契约 v2.1 生效） |
| `> cancelled: <原因>`（特性级落点：计划稿 H1 标记行后、首个非引用行之前；v2.3 补篇/#66） | 该计划稿**特性** `status=cancelled`（终态）+ 全取消子卡 rollup；`statusRule` 记原因原文（空→「未记原因」）；**终态优先序** = 特性自身 cancelled > 全取消 rollup > `roadmap` 段位压制 > 其余推导（其它引用族行不引入特性级落点，落点外 → 不解析 + diagnostics；epic 壳层同序与整体取消留痕见 markers §10.5/§10.6） |
| `> agents: <角色1> | <角色2> | …` | 卡片指派：非标准管线才写，顺序即管线序；缺省 = implementer → test-verifier → code-reviewer → integrator（v2.1 增补，同一生效条件） |

- 目标号不在**本次编译的板上**（活条目集合）→ 不造引用：保留 `kind`/`summary`，`blockedBy` 缺省 + diagnostics。
- 层级标签不是句柄：`> blocked-by: 1.2` / `ID-1.2` 一律拒收（标签随重排漂移）。
- 反例：`no=07`（前导零）、非条目行上的标记、同号两处标记——均不静默改写，走诊断/冲突路径。

## 5. run_event 报告块（契约摘要；权威全文 `assets/contracts/run-event.md`）

报告中的 JSON 代码块，顶层键 `run_event`（对象或数组；**一个块 = 一条 run 记录**）：

```json
"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8, "evidence": ["specs/preview-channel/updater.ts"], "nextStep": "补 updater 单测后重新验证" }
```

- 必填：`role`（implementer / debugger / refactoring-optimizer / code-reviewer / test-verifier / integrator / **ui-designer**——B2-1/#99 第四绿扩词：写侧 `lib/runs.mjs` RUN_ROLES 与读侧 `lib/derive.mjs` 双侧同词表，防"入板断言/渲染角色"分裂）、`result`（`done` / `partial` / `failed`；`interrupted` 由机械补记）。
- 可选：`cards[]`（整数稳定号）、`stoppedAt`、`evidence[]`、`nextStep`（≤200 字符）、`worktree` / `branch`（**仅显式声明时转抄**；缺省一律 `null` + diagnostics「未声明工作树」——v2.1 勘误 #42，不按卡号推导；真开了工作树就显式写 `.zcode/worktrees/task-<no>` / `task-<no>`）。
- 机械字段 `runId` / `sessionId` / `at` **不得自报**（由 hook 补齐，报告携带一律忽略）；未知键忽略。
- 容错：无块 / 块解析失败 → 跳过落账 + diagnostics，不阻塞；字段缺省 → 容错落账、不造值。
- integrator 的 `merge_report.v1` 同样携带 `run_event`（`role: "integrator"`）；`done` 仅当卡全部门禁通过、已合并、工作树已正规清理。

## 6. 看板纪律（全量）

1. **会话启动读板**：先读 `board.json`/`board.md`；有缺口先向用户确认处理顺序，再开始新工作（§2）。
2. **访谈即登记**：访谈结束（无论是否走 spec-driven-workflow）立即 `register-interview.mjs append`（主题、结论一句话、产物路径）；只谈未写的 `outcome` 填 `none`；产物落盘后用 `resolve` 回填 `resolvedBy`。
3. **发号时机**：计划稿**首次落盘后**立即 `--assign`（发计划号）；**拆卡后**（向 plan / tasks.md 写入任务条目）再 `--assign`（发任务号）；spec 特性号 registry 内绑定。发号只在主检出、由编排者单写者执行；人不得手写号。
4. **重编译时机**：任务勾选、阶段推进、阻塞变化之后，以及收到上下文压缩信号时；`watch-sources` hook 会在真相源 `Write|Edit` 后自动重编译；随时可手动重编译（幂等，一条命令）。**检测面两通道（#101/#102，语义不同）**：Write|Edit 通道 = 自动重编译（静默修复）；Bash 通道（PostToolUse(Bash)，轻量启发：`source-change-detect.mjs`）= 识别三类不经 Write/Edit 的源变更（删除源 / 新增移入源 / Bash 写入），命中**只告警不重编译**（stderr 点名类别与路径 + 重编译命令；命令非零退出不告警；派生路径与只读命令零动作防自激；非 shell 解释器——xargs/find -delete/bash -c/变量展开不解析，漏面由 Stop 兜底补齐）；归档移动命中的映射候选判「合法转移提示」（§3.5）。**Stop 兜底一律重编译（#103）**：对账写盘后兜底重编译（检查先/重编译后——对账如实记录修复前态）；幂等（连续 Stop 掩码根 updatedAt 后零 diff）；失败不阻塞（stderr 留痕）。
5. **执行派发**：按卡开工作树（§3.4）；一卡一交付；子智能体只读板、不写任何板文件，报告必须带 `run_event` 块；后台派发由编排者代触发 `record-run.mjs` 落账；特性首卡 = tracer（除非计划稿声明豁免）。**规格纪律（2026-10-10）**：用户反馈的关键句原文引用进卡（访谈 id + 原话），验收句以"用户看到/点到什么"措辞——转译比原话窄是 plan-reviewer 的 finding。**验证等级三层**：
   - **正式卡**（新功能/架构/UI）→ 完整三绿（implementer → test-verifier 独立 → code-reviewer 两维）+ **UI 面卡第四绿**（ui-designer 视觉/信息层级复核，diff 触及用户可见面时强制，无证据不得进待合并）
   - **跟进卡**（评审发现/bug）→ 第一绿 + 回归全绿 + 批量验证（可合并多卡但需注明覆盖面）
   - **微卡**（一行改动/文案）→ 第一绿 + 回归全绿（不需独立二三绿）
   - **UI 卡浏览器断言（2026-10-10）**：改动面含布局/交互的卡，test-verifier 必须跑浏览器断言（溢出探针 scrollWidth>clientWidth、点击路由派发后断言 DOM）；SSR 结构断言不构成行为证据。
   - **卡文模板与拼装器（#119/B6-1；E1 V6）**：卡文按两必填段模板起草（`assets/templates/card/card.template.md`：交付面全量枚举 + 用户原话引用 + 验收句「用户看到/点到什么」；正/反例见 `card.example-pass.md` / `card.example-fail.md`）；派发 prompt 一律经 `build-dispatch-prompt.mjs` 机械拼装（约束块随派发全文内嵌，杜绝手打遗漏）；缺必填段默认拒发（`--allow-partial` 仅调试/对照用）。
   - **按卡类型需齐绿清单（#121/B6-3；E1 V9）**：派发约束块（`assets/templates/card/constraint-block.md`，constraint-block/2）含「按卡类型需齐绿清单」节——拼装器按卡文启发式判型（ui → hook → 断言 → 纯 md 文档 → 默认代码卡；判定依据显式输出，`--type` 可覆盖），清单随派发 prompt「角色与绿数」节留痕可核对；UI 卡 = 三绿 + 第四绿（ui-designer）+ 浏览器断言，**不随验证等级（`--level` 跟进/微卡）消减**（与 B2-2 合并门禁的第四绿条目同句；合并期 UI 面判定以 gate-merge 的 diff 判据为准）。
   - **未验证面注入（2026-10-10 裁决④ / E1 V27）**：派发 prompt 由 `build-dispatch-prompt.mjs` 拼装时，用 `--unverified <清单文件>` 将验证报告登记的未验证面（一行一项）注入骨架；清单为空拒发。未验证面不得只留在报告里沉底；SessionStart 注入扩展与否另行裁决（本条只做派发注入）。
6. **三绿门禁与 integrator 唯一出口**：三绿 = code-reviewer `approved` + test-verifier `pass` + 卡分支 rebase 无冲突；**UI 面卡加第四绿**（ui-designer `approved`，integrator 机械校验 diff 是否触及用户可见面）；合并唯一出口是 integrator（判断与执行分离，integrator 不自行评审/重测）；merge commit 精确写 `Merge task-<no> [#<no>]`；该格式有机械防线（E4-17/B5-6）：gate-merge 对目标为 base 的卡片合并按 `-m`/`--message` 事前校验冻结格式（不符即拦并给出格式要求；校验顺序=命令形态先于绿证据；无 `-m` 的交互/默认信息形态放行并提示事后核对），`verify-cleanup.mjs` 对 HEAD merge commit 事后核对（呈卡合并迹象——信息含 `task-<no>` / `[#<no>]`——而不符冻结格式 → 格式残留点名，处置 `git commit --amend -m "Merge task-<no> [#<no>]"` 或 reset 重做；非 merge/非卡合并形态不适用零噪声）；合并后 `git worktree remove` + `prune` + `git branch -d`，再报 `merge_report.v1`（含 run_event）。**第四绿机械判据（B2-2/#100）**：卡分支 diff 触及路径前缀 `packages/ui/` 即 UI 面（段级锚定，嵌套根同样命中；`--no-renames` 防改名绕过）→ 要求该卡 `ui-designer` 且 `result=done` 的 run 记录 + evidence 至少一条在位，缺则拦截（exit 2）；base 合并与 gh pr merge 双路径同判。desktop renderer / web 扩面待用户裁定（B2 评审 SPEC-1）。**卡分支删除拦截（B5-4/#116）**：`git branch -D` 命中 `task-<no>` 卡分支形态即拦（exit 2，四形态防绕过）；非卡分支放行。
7. **勾选 = 已合并**：tasks.md 勾选发生在合并之后（checkbox 只反映已合并部分）；勾选后重编译 → 卡 `completed`、`unmerged-worktree` 缺口清除。勾选=已合并的证据面 = 该卡 `integrator done` 的 run 记录（runs.json）；缺证据卡在 Stop 对账第 5 节点名（补录证据或登记豁免，见第 9 条与 §3.1 (e)）。
8. **归档纪律**：见 §3.5（特性 completed + 7 天冷却；只移动文件；号不回滚；hook 只点名、移动归编排者）。
9. **收尾对账**：会话结束前必须回答"本轮有什么该进板而没进的？"；Stop hook 机械对账六节——四类点名（未登记（访谈无登记 / 后台 run 未代触发落账）、未合并、板陈旧、待归档）+ 第 5 节「勾选=已合并点名」（completed 任务卡缺该卡 integrator done 的 run 证据；判据与 `--check` 同源 `lib/fact-invariants.mjs`，对账级不阻断）+ 第 6 节「板滚未提交」（#117；E1 V35：板数据文件有未提交变更（git status，含未跟踪/已暂存）即点名，提示级不阻断；提交建议=板滚并入收口 commit——板真相源不跨会话裸奔；非 git 项目/仓不可用跳过，结论行维持四类口径）——正文写 `last-reconcile.md`（下次 SessionStart 注入 + 人可直读），处理或说明后再收尾。合并收尾另跑一条机械核对：`node <skill>/assets/tools/verify-cleanup.mjs --cards <刚合并卡号,…> --root <项目根>`——worktree/branch 差集残留或 HEAD merge 格式残留均逐条点名（exit 1；#116/#118）。**豁免登记口径**：速修/管理卡（勾选=已合并但无 integrator done 证据）由编排者单写者登记进 `.zcode/board/exemptions.json`——登记后不再点名；登记不合法不静默（条目级该条不生效、结构非法整份拒收，逐条提示）；runs.json 缺失 ≡ 空证据、损坏 → 第 5 节跳过并提示。
10. **速修不建卡**：改错字、调颜色、补注释等琐碎修复直接 git commit，不走看板建卡（卡的维护成本大于修复成本）；收尾对账时归入"本轮速修 N 处"一句话登记或写进当日在做的计划稿备注行。判断标准：需要跟踪状态（未修完/需回归/他人要看到）→ 建卡；改完就完（无后续动作）→ 不建卡，git log 即审计。
11. **超长拆分（预防为主）**：**拆卡拆的是粒度，不是范围**——先枚举用户意图的全量交付面（含配套件：提示词/hook/技能/文档/分发），完整范围 → 按文件域与可验证中间产物拆成可并行的卡 → 同批收口；禁止以"卡太大/避免超长"为由收窄范围——砍范围必须用户明示裁决（2026-10-10 P2 教训：UI 开关发了、注入三位一体被砍，用户在新项目裸奔踩坑）。**拆卡时**预估 >30 分钟的卡必须再拆（按可验证中间产物切），>60 分钟的卡**禁止整卡派发**——执行时间越长，agent 中断（上下文耗尽/API 超时/系统崩溃）概率越高，中断即浪费全部已执行时间。拆法示例：编译器改造+UI 四视图+契约同步+验证 = 4 张卡而非 1 张。**执行中**发现卡太大 → 立即拆——record-run 落 `result=partial`（stoppedAt=当前卡号、nextStep="剩余拆出"），计划稿追加跟进卡，原卡以已交付部分勾选 → 下游自动解锁。依赖健康度：某卡被 >3 张卡 blocked-by → 考虑先拆出"定义接口"卡让依赖方并行。
12. **并发派发**：无阻碍且**文件域互斥**的待办卡应同时派发（run_in_background: true），不一张张挤牙膏。两个约束同时生效：文件域决定哪些卡**能**并行（task-planner 并行组），**并发上限决定最多同时跑几个子智能体**（资源约束）。实际并发 = min(并行组大小, 用户上限)。上限设定：首次会话询问用户（"并发上限设多少？"），存入记忆；后续会话沿用不重复问；用户可随时说"改并发到 N"覆盖。同文件的多张卡必须 blocked-by 串联。冲突兜底：各自工作树隔离 + integrator 冲突检测退回。完成通知驱动下一批，不需要人推。
13. **不得空转消缺口**：看板只记录事实；不得为消除缺口标记而空转产物或虚构状态。
14. **基线红纪律（E1 V26）**：「零新增失败」结论必须基于改动前基线跑或基线红清册（`assets/tools/baseline-redlist.mjs`；清册 `.zcode/board/baseline-reds.json` 由编排者/验证者维护、逐条归因并排期治理）。`--check` 点名的新增红不得当作既有；既有红重现标注「既有」（含归因）。清册红不得成为永久豁免通道——长期挂账必须挂卡治理。
15. **突变/篡改验证一律副本域（#126/B6-8）**：`run-mutations.mjs` 默认整轮冻结快照入 mktemp 副本域（源域与真实板全程只读；一轮全部突变共用同一份快照——并行写窗口的半写态只报漂移、不污染结论）；误用活板域/源域/TMPDIR 落活板域 fail-closed 拒跑；`--guard-board <板根>` 对板面文件做窗口前后逐文件 sha256 断言（变化 exit 3——并发改板先归因再重跑，工具不自动豁免）。手动做改—跑—还原式探针同此纪律：真实 plan 样例与真实板只读，变异只发生在临时副本。

## 7. assets 目录清单

| 路径 | 内容 |
| --- | --- |
| `assets/compile-board.mjs` | 编译器（默认只读 / `--assign` 发号（`--force` 放行防 mass 改写闸；`--epic <码>` [+ `--epic-file` / `--epic-title`] epic 归属补录——登记行前置、自动占下一 phase 序号，#81）/ `--check` 审计（含 (e)/(f) 对账点名 + (i1)-(i4) 派生四段不变量失败级）/ `--version` / `--manifest`；`generatedBy` 读 `lib/version.mjs` 常量（当前 zcode-board/0.5.0）） |
| `assets/register-interview.mjs` | 访谈登记 append / resolve（interviews.json 唯一写路径；注册后触发重编译 #103） |
| `assets/lib/` | `board-io.mjs`（原子读写与归一）、`derive.mjs`（派生/段位/缺口/worktree 归一化 #151 + 四段索引 `deriveBoardIndex` #133 + epic 派生 `deriveEpics` #84）、`marker-write.mjs`（标记写回）、`runs.mjs`（appendRun；RUN_ROLES 词表含 ui-designer #99）、`schema-check.mjs`（schema 子集校验 + 豁免登记校验 #97）、`fact-invariants.mjs`（事实互证 (a)-(d) 失败级 + (e) 对账点名级 + (f) 卡号绑定 + (h) epic 归属 + (i1)-(i4) 派生四段不变量，#56/#97/#152/#82/#134）、`version.mjs`（版本单一事实源，#67）、`scan-config.mjs`（扫描面配置解析，#72） |
| `assets/hooks/` | `board-context.mjs`（SessionStart，L0 注入：缺口清单/在做该接（四段同源消费 #135）/陈旧告警/截断保留位 #130-132）、`record-run.mjs`（PostToolUse 落账 + 报告同源代存归档 #123）、`watch-sources.mjs`（PostToolUse 重编译 + Bash 通道源变更告警与归档分流 #101/#102）、`source-change-detect.mjs`（Bash 命令→源变更宣称纯函数 #101）、`reconcile-stop.mjs`（Stop 对账六节 + 兜底重编译 #98/#103/#117）、`gate-merge.mjs`（PreToolUse 门禁：三绿+第四绿 UI 面（diff 触及 `packages/ui/` 段级锚定 #100）+merge 格式校验 #118+卡分支 `-D` 拦截 #116）、`guard-board.mjs`（PreToolUse 双断言守卫：板数据文件禁写 + 证据存在性 #113；**user 级声明待晨间部署检查点**） |
| `assets/tools/build-dispatch-prompt.mjs` | 派发 prompt 骨架拼装（#119；必填段拒发 #120 / 卡类型需齐绿清单 #121 / 未验证面注入 #124；见 §3.10） |
| `assets/tools/create-worktree.mjs` | 编排者建树单点 + 树名下发（#122；§3.4 冻结步骤脚本化，树名与卡号不符必咬；见 §3.4） |
| `assets/tools/baseline-redlist.mjs` | 基线红清册生成/比对（#124；`--init` 骨架 / `--check` 既有不误报 + 新红必咬；见 §3.11） |
| `assets/tools/verify-cleanup.mjs` | 收尾机械核对（#116/#118）：合并后 worktree/branch 差集（分支/现场/登记/目录，残留点名）+ HEAD merge 格式事后核对（E4-17） |
| `assets/tools/validate-sample.mjs` | golden 样例自验工具（28 变异全拒） |
| `assets/templates/` | `interviews` / `registry`（含 epics 段）/ `runs` 三份起始模板（version 1、空数组、字段齐全） |
| `assets/templates/card/` | 卡模板族（#119/#121/#123）：`card.template.md`（两必填段 + 验收句式）、`constraint-block.md`（派发约束块 v2，随派发全文内嵌）、`evidence.template.md`（V21 证据头）、示例卡正/反例 `card.example-{pass,fail}.md` |
| `assets/contracts/` | `markers.md`（标记语法，v2.5）、`run-event.md`（报告块）、`dreamer-inputs.md`（第五期输入格式） |
| `assets/samples/` | `board.golden.json`（golden 板样例，覆盖四种 attention 码与全部字段 + epic 三类扩样 #86） |
| `assets/board.schema.json` | board.json 的 schema（`--check` 与应用侧共同校验依据；根级 `x-contractVersion` / `x-schemaVersion` 为契约/schema 版本读取位，#67；附加键 `epics`/`epic`/`phase`（#76-79）与四段 `frontier`/`active`/`blocked`/`recent`（#133）的 x-decisions 冻结口径） |
| `assets/manifest.json` | 技能包清单（#67）：包/契约/schema 版本 + 关键文件 sha256（内容寻址）；`compile-board.mjs --manifest` 重新生成（P2 分发比对直接用） |
| `assets/worktree-discipline.md` | 工作树纪律详版（建/清/违规修复全步骤；§3.1 建树单点脚本 #122） |
| `assets/test/` | 夹具与场景断言脚本（红绿证据来源；回归清单：run-scenarios / run-t13-hooks / run-mutations（副本域+--guard-board #126）/ run-t119-card-template / run-t122-worktree / run-t124-baseline / run-t126-mutations / validate-sample） |
