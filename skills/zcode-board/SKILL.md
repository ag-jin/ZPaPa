---
name: zcode-board
description: 项目看板（.zcode/board）操作手册与纪律全量。触发词：项目看板 / 登记访谈 / 重编译看板 / 查看项目进度；另覆盖发号 --assign、审计 --check、run_event 落账、hook 安装与信任评审、工作树建清、归档与收尾对账。
---

# zcode-board — 项目看板操作手册

- 技能版本：`zcode-board/0.4.0`（与编译产物 `board.json.generatedBy`、`assets/manifest.json` 同源；映射：包 0.4.0 = 契约 v2.4 + schema v2.3；bump 规则见 §3.7。0.3.1 → 0.4.0 = 次版本级：#72 扫描面配置化——默认扫描面收窄为 `.zcode/plans/`，`docs/plans/`、`docs/design-notes/` 移入 opt-in 池（`.zcode/board/scan.json`），`--assign` 增防 mass 改写闸 >10 + `--force`）。
- `<skill>` = `~/.zcode/skills/zcode-board`（本文件所在目录，路径以实际安装位置为准）；`<项目根>` = 被看板管理的项目目录。
- 无第三方依赖：全部脚本仅用 Node 内置模块（`node:fs` / `node:path` / `node:url` / `node:crypto` / `node:child_process`），直接 `node` 运行，无需安装任何依赖。
- 分层：发现 = 技能清单一行 description；启动读板 = SessionStart hook 机械注入；操作细节 = 本文件按需加载；产品化内置注入 = P2（后续）。

## 1. 约束块（动笔与派发前必读）

### 1.1 位置与分层（最高频违例区）

- **AGENTS.md 只放团队表**：看板/实验功能内容零残留（关闭实验功能时项目无痕）。
- **本期工作区不维护 `doc/`、`docs/`**：一切开发流程资产在 `.zcode/`（计划稿/板/证据/hook 配置），技能资产在 `~/.zcode/skills/zcode-board/`。
- **提示词四层**：发现 = 技能清单一行描述；启动读板 = SessionStart hook；操作手册 = SKILL.md；产品化 = P2。任何新约束先问"该住在哪一层"再落笔。

### 1.2 写入者分域（文件级单写者）

| 文件 | 唯一写入者 | 唯一入口 |
| --- | --- | --- |
| `.zcode/board/runs.json` | 机械转抄脚本 | `hooks/record-run.mjs`（前台 PostToolUse / 后台编排者代触发；`appendRun`） |
| `.zcode/board/interviews.json` | 登记脚本 | `register-interview.mjs`（append / resolve） |
| `.zcode/board/registry.json` | 发号模式 | `compile-board.mjs --assign` |
| `.zcode/board/board.json`、`board.md` | 编译器 | `compile-board.mjs`（任一模态） |

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

## 2. 读板（会话启动第一件事）

1. 读 `<项目根>/.zcode/board/board.json`（不存在则读 `board.md`）。board 是编译器产物，任何判断以真相源为准。
2. 检查 `attentionSummary` 与节点 `attention`，四缺口码与固定文案：

| 缺口码 | 文案 | 含义 |
| --- | --- | --- |
| `interviewed-not-arranged` | 已访谈，尚未落卡 | 登记条目无产物或 `resolvedBy` 未指向板上节点 |
| `arranged-not-expanded` | 已安排，尚未拆解任务 | 特性上板但无任务卡 |
| `interrupted-resume` | 执行中断，可续（停在 #N） | 卡有断点 run（`stoppedAt` + `nextStep`） |
| `unmerged-worktree` | 待合并（执行现场未回流） | 卡 `worktree` 字段命中**且**目录经 fs 互证真实存在，但无 integrator done 收尾；字段命中而目录不存在 → 仅提示级 diagnostics，不计缺口（#42） |

3. 节点 `stage` 为七段位：`待设计 / 待办 / 执行中 / 审核中 / 阻塞 / 已完成 / 已取消`（带 `stageRule` 溯源）。
4. 存在任一缺口时：**先向用户确认是否处理，再开始新工作**。
5. 板可能陈旧（`updatedAt` 落后于源 mtime）：先重编译（§3.1），再看板。

## 3. 命令表（逐字可执行；`<skill>` 与 `<项目根>` 替换为实际路径）

### 3.1 编译器（同一 CLI：默认只读 / `--assign` 发号 / `--check` 审计 / `--version` / `--manifest`）

```bash
node <skill>/assets/compile-board.mjs <项目根>            # 默认：只读编译，写 board.json + board.md
node <skill>/assets/compile-board.mjs <项目根> --assign   # 发号：写源头号标记 + registry.json + 自动重编译
node <skill>/assets/compile-board.mjs <项目根> --assign --force  # 强制放行 >10 未领号计划文件的批量发号（留诊断痕迹；先核查扫描面）
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
- `--check` 不自动修复：修复 = 重编译（或 `--assign`）+ 人工修源；扫描面配置错误（坏 scan.json / 池外引用）→ 失败项「扫描面配置」非零退出。

`--check` 校验项（失败级，非零退出；板正常时零噪声）：

1. 源完整性：解析失败 / 结构不合法 / 不受支持版本 → 失败。
2. 活条目清单 ↔ registry：活号唯一、活标记必有条目、`kind`/指向一致；空洞条目合法；归档条目按指向路径直查（详见 §3.5）。
3. `board.json` ↔ 重编译期望逐字段比对（篡改/板陈旧 → 差异报告）+ 结构校验（schema 子集 + T7 公共不变量）。
4. **事实互证不变量（#56，`lib/fact-invariants.mjs` 纯函数；磁盘板与重编译基线各跑一遍）**——板自己回答"这数对不对"：
   - (a) 特性子卡全部 `completed` → 特性 `stage=已完成`（计划稿特性段位随子卡汇总，契约 v2.3；roadmap 占位稿段位被压制，不在本判据域）；
   - (b) 已有任务卡（`tasks.length>0`）的特性不得挂 `arranged-not-expanded`（判据为零卡；roadmap 稿同理——压制段位≠可挂"未拆解"）；
   - (c) `board.md` 渲染编号形态 ↔ `board.json` 的 `planCode`/`label` 派生一致（嵌套任务行含递归深度 ≥2；D1 类渲染回归由此咬住；T5356r TQ-1 扩面：`## 待处理`/`## 待合并` 节的编号链同入对照面）；
   - (d) 段位计数：`board.json` 如携带 `stageSummary`（七段位计数对象）→ 与全板节点 `stage` 逐项复算相等；不携带则不判。
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
- 特性节点 id 形态：计划稿 `plan:<stem>`（如 `plan:sess_<uuid>`）、spec `spec:<f>`、访谈 `interview:itw-…`。
- 退出码：0 成功；1 运行错误（id 未命中 / 源损坏 / IO）；2 用法错误。

### 3.3 run 落账（runs.json 唯一写路径，代触发形态）

```bash
pbpaste | node <skill>/assets/hooks/record-run.mjs --cwd <项目根> --session-id <会话 id>
```

- 前台派发：PostToolUse(`Agent|Task`) hook 自动触发（stdin = 完整 payload），无需手动。
- 后台派发：编排者收到报告后以上述命令代触发（stdin = 报告原文，含 `run_event` 块）；可选 `--tool-name <名>`。
- 一执行一落账：落账同步、随后自动重编译；无块 / 解析失败 / 落账失败只写 stderr diagnostics，进程退出码恒 0。

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
4. hook 语义：落账同步、重编译与对账 async；失败永不阻塞主流程（唯一有意阻断 = `gate-merge` 拦截无三绿证据的 base 合并）；注入型脚本中仅 board-context 输出单 JSON（日志走 stderr、显式 exit 0）；reconcile-stop 按 R3 裁决 stdout 恒空（写 `.zcode/board/last-reconcile.md`，不强推续跑）。
5. **本工作区现状**：探针已于 T16 通过后移除，config 为终态（五正式声明）；T19 前一次性做信任评审（先评审等于评两次）。

### 3.7 版本策略（包版本 / 契约版本 / schema 版本）

三版本各有**唯一事实源**，`--version` 与 `--manifest` 只读取、不手写第二份：

| 版本 | 事实源 | 读取方（派生位） |
| --- | --- | --- |
| 包版本 | `assets/lib/version.mjs` 的 `SKILL_VERSION` 常量 | `board.json.generatedBy`（形态 `zcode-board/<包版本>`）、`assets/manifest.json`、SKILL.md 头部版本行（手写位，由测试断言守卫同值） |
| 契约版本 | `assets/contracts/markers.md` 最新变更段头（`vX.Y 变更段` / `vX.Y 补篇段`） | `--version`、`assets/manifest.json` |
| schema 版本 | `assets/board.schema.json` 根级 `x-schemaVersion` | `--version`、`assets/manifest.json` |

映射（当前）：**包 0.4.0 = 契约 v2.4 + schema v2.3**（0.2 为编译器历史版本号；包版本自 0.3.0 起按语义化维护；0.4.0 = #72 扫描面配置化——默认值破坏性变更连带升契约 v2.4，board.json 字段不变故 schema 不动）。

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
- 契约条文：`assets/contracts/markers.md` v2.4 §9（扫描面配置）与 §6（防 mass 改写闸）。

## 4. 标记语法（markers.v1；`cancelled`/`agents` 为 v2.1 增补）

两个落点、共用解析正则 `/<!--\s*zcode-board:\s*no=([1-9][0-9]*)\s*-->/`：

| 落点 | 位置 | 例 |
| --- | --- | --- |
| 计划稿（文件级） | 文件头注释，全文件首个有效 | `<!-- zcode-board: no=6 -->` |
| 任务条目（行级） | 条目行行尾 | `- [ ] 1. 标题 <!-- zcode-board: no=7 -->` |

- `N` 为正整数稳定号；缺号完全容错（按"未领号"上板 + 提示运行 `--assign`）；**不得手写或改动标记**。
- spec 特性号无内联标记：以 spec 根为键绑定在 registry 内。

引用行（写在任务条目下方同缩进块内，归属**上方最近条目**）：

| 语法 | 语义 |
| --- | --- |
| `> blocked: <原因>` | 外部受阻；不产生 `blockedBy` |
| `> blocked-by: <句柄>` | 卡间依赖；句柄三种等价写法 `9` / `#9` / `ID-9` 归一为整数 |
| `> cancelled: <原因>` | 取消留痕：条目保留、卡 `status=cancelled`、号永不复用（v2.1 增补，随契约 v2.1 生效）；**#66 扩展：特性级落点 = 计划稿 H1 标记行后、首个非引用行前，特性取消 + 全取消 rollup；cancelled 是终态，优先于 roadmap 段位压制** |
| `> agents: <角色1> | <角色2> | …` | 卡片指派：非标准管线才写，顺序即管线序；缺省 = implementer → test-verifier → code-reviewer → integrator（v2.1 增补，同一生效条件） |

- 目标号不在**本次编译的板上**（活条目集合）→ 不造引用：保留 `kind`/`summary`，`blockedBy` 缺省 + diagnostics。
- 层级标签不是句柄：`> blocked-by: 1.2` / `ID-1.2` 一律拒收（标签随重排漂移）。
- 反例：`no=07`（前导零）、非条目行上的标记、同号两处标记——均不静默改写，走诊断/冲突路径。

## 5. run_event 报告块（契约摘要；权威全文 `assets/contracts/run-event.md`）

报告中的 JSON 代码块，顶层键 `run_event`（对象或数组；**一个块 = 一条 run 记录**）：

```json
"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8, "evidence": ["specs/preview-channel/updater.ts"], "nextStep": "补 updater 单测后重新验证" }
```

- 必填：`role`（implementer / debugger / refactoring-optimizer / code-reviewer / test-verifier / integrator）、`result`（`done` / `partial` / `failed`；`interrupted` 由机械补记）。
- 可选：`cards[]`（整数稳定号）、`stoppedAt`、`evidence[]`、`nextStep`（≤200 字符）、`worktree` / `branch`（**仅显式声明时转抄**；缺省一律 `null` + diagnostics「未声明工作树」——v2.1 勘误 #42，不按卡号推导；真开了工作树就显式写 `.zcode/worktrees/task-<no>` / `task-<no>`）。
- 机械字段 `runId` / `sessionId` / `at` **不得自报**（由 hook 补齐，报告携带一律忽略）；未知键忽略。
- 容错：无块 / 块解析失败 → 跳过落账 + diagnostics，不阻塞；字段缺省 → 容错落账、不造值。
- integrator 的 `merge_report.v1` 同样携带 `run_event`（`role: "integrator"`）；`done` 仅当卡全部门禁通过、已合并、工作树已正规清理。

## 6. 看板纪律（全量）

1. **会话启动读板**：先读 `board.json`/`board.md`；有缺口先向用户确认处理顺序，再开始新工作（§2）。
2. **访谈即登记**：访谈结束（无论是否走 spec-driven-workflow）立即 `register-interview.mjs append`（主题、结论一句话、产物路径）；只谈未写的 `outcome` 填 `none`；产物落盘后用 `resolve` 回填 `resolvedBy`。
3. **发号时机**：计划稿**首次落盘后**立即 `--assign`（发计划号）；**拆卡后**（向 plan / tasks.md 写入任务条目）再 `--assign`（发任务号）；spec 特性号 registry 内绑定。发号只在主检出、由编排者单写者执行；人不得手写号。
4. **重编译时机**：任务勾选、阶段推进、阻塞变化之后，以及收到上下文压缩信号时；`watch-sources` hook 会在真相源 `Write|Edit` 后自动重编译；随时可手动重编译（幂等，一条命令）。
5. **执行派发**：按卡开工作树（§3.4）；一卡一交付；子智能体只读板、不写任何板文件，报告必须带 `run_event` 块；后台派发由编排者代触发 `record-run.mjs` 落账；特性首卡 = tracer（除非计划稿声明豁免）。**规格纪律（2026-10-10）**：用户反馈的关键句原文引用进卡（访谈 id + 原话），验收句以"用户看到/点到什么"措辞——转译比原话窄是 plan-reviewer 的 finding。**验证等级三层**：
   - **正式卡**（新功能/架构/UI）→ 完整三绿（implementer → test-verifier 独立 → code-reviewer 两维）+ **UI 面卡第四绿**（ui-designer 视觉/信息层级复核，diff 触及用户可见面时强制，无证据不得进待合并）
   - **跟进卡**（评审发现/bug）→ 第一绿 + 回归全绿 + 批量验证（可合并多卡但需注明覆盖面）
   - **微卡**（一行改动/文案）→ 第一绿 + 回归全绿（不需独立二三绿）
   - **UI 卡浏览器断言（2026-10-10）**：改动面含布局/交互的卡，test-verifier 必须跑浏览器断言（溢出探针 scrollWidth>clientWidth、点击路由派发后断言 DOM）；SSR 结构断言不构成行为证据。
6. **三绿门禁与 integrator 唯一出口**：三绿 = code-reviewer `approved` + test-verifier `pass` + 卡分支 rebase 无冲突；**UI 面卡加第四绿**（ui-designer `approved`，integrator 机械校验 diff 是否触及用户可见面）；合并唯一出口是 integrator（判断与执行分离，integrator 不自行评审/重测）；merge commit 精确写 `Merge task-<no> [#<no>]`；合并后 `git worktree remove` + `prune` + `git branch -d`，再报 `merge_report.v1`（含 run_event）。
7. **勾选 = 已合并**：tasks.md 勾选发生在合并之后（checkbox 只反映已合并部分）；勾选后重编译 → 卡 `completed`、`unmerged-worktree` 缺口清除。
8. **归档纪律**：见 §3.5（特性 completed + 7 天冷却；只移动文件；号不回滚；hook 只点名、移动归编排者）。
9. **收尾对账**：会话结束前必须回答"本轮有什么该进板而没进的？"；Stop hook 机械点名四类——未登记（访谈无登记 / 后台 run 未代触发落账）、未合并、板陈旧、待归档——正文写 `last-reconcile.md`（下次 SessionStart 注入 + 人可直读），点名非阻断，处理或说明后再收尾。
10. **速修不建卡**：改错字、调颜色、补注释等琐碎修复直接 git commit，不走看板建卡（卡的维护成本大于修复成本）；收尾对账时归入"本轮速修 N 处"一句话登记或写进当日在做的计划稿备注行。判断标准：需要跟踪状态（未修完/需回归/他人要看到）→ 建卡；改完就完（无后续动作）→ 不建卡，git log 即审计。
11. **超长拆分（预防为主）**：**拆卡拆的是粒度，不是范围**——先枚举用户意图的全量交付面（含配套件：提示词/hook/技能/文档/分发），完整范围 → 按文件域与可验证中间产物拆成可并行的卡 → 同批收口；禁止以"卡太大/避免超长"为由收窄范围——砍范围必须用户明示裁决（2026-10-10 P2 教训：UI 开关发了、注入三位一体被砍，用户在新项目裸奔踩坑）。**拆卡时**预估 >30 分钟的卡必须再拆（按可验证中间产物切），>60 分钟的卡**禁止整卡派发**——执行时间越长，agent 中断（上下文耗尽/API 超时/系统崩溃）概率越高，中断即浪费全部已执行时间。拆法示例：编译器改造+UI 四视图+契约同步+验证 = 4 张卡而非 1 张。**执行中**发现卡太大 → 立即拆——record-run 落 `result=partial`（stoppedAt=当前卡号、nextStep="剩余拆出"），计划稿追加跟进卡，原卡以已交付部分勾选 → 下游自动解锁。依赖健康度：某卡被 >3 张卡 blocked-by → 考虑先拆出"定义接口"卡让依赖方并行。
12. **并发派发**：无阻碍且**文件域互斥**的待办卡应同时派发（run_in_background: true），不一张张挤牙膏。两个约束同时生效：文件域决定哪些卡**能**并行（task-planner 并行组），**并发上限决定最多同时跑几个子智能体**（资源约束）。实际并发 = min(并行组大小, 用户上限)。上限设定：首次会话询问用户（"并发上限设多少？"），存入记忆；后续会话沿用不重复问；用户可随时说"改并发到 N"覆盖。同文件的多张卡必须 blocked-by 串联。冲突兜底：各自工作树隔离 + integrator 冲突检测退回。完成通知驱动下一批，不需要人推。
13. **不得空转消缺口**：看板只记录事实；不得为消除缺口标记而空转产物或虚构状态。

## 7. assets 目录清单

| 路径 | 内容 |
| --- | --- |
| `assets/compile-board.mjs` | 编译器（默认只读 / `--assign` 发号（`--force` 放行防 mass 改写闸）/ `--check` 审计 / `--version` / `--manifest`；`generatedBy` 读 `lib/version.mjs` 常量（当前 zcode-board/0.4.0）） |
| `assets/register-interview.mjs` | 访谈登记 append / resolve（interviews.json 唯一写路径） |
| `assets/lib/` | `board-io.mjs`（原子读写与归一）、`derive.mjs`（派生/段位/缺口）、`marker-write.mjs`（标记写回）、`runs.mjs`（appendRun）、`schema-check.mjs`（schema 子集校验）、`fact-invariants.mjs`（`--check` 事实互证四条不变量，#56）、`version.mjs`（版本单一事实源，#67）、`scan-config.mjs`（扫描面配置解析，#72） |
| `assets/hooks/` | `board-context.mjs`（SessionStart）、`record-run.mjs`（PostToolUse 落账）、`watch-sources.mjs`（PostToolUse 重编译）、`reconcile-stop.mjs`（Stop 对账）、`gate-merge.mjs`（PreToolUse 门禁） |
| `assets/templates/` | `interviews` / `registry` / `runs` 三份起始模板（version 1、空数组、字段齐全） |
| `assets/contracts/` | `markers.md`（标记语法）、`run-event.md`（报告块）、`dreamer-inputs.md`（第五期输入格式） |
| `assets/samples/` | `board.golden.json`（golden 板样例，覆盖四种 attention 码与全部字段） |
| `assets/board.schema.json` | board.json 的 schema（`--check` 与应用侧共同校验依据；根级 `x-contractVersion` / `x-schemaVersion` 为契约/schema 版本读取位，#67） |
| `assets/manifest.json` | 技能包清单（#67）：包/契约/schema 版本 + 关键文件 sha256（内容寻址）；`compile-board.mjs --manifest` 重新生成（P2 分发比对直接用） |
| `assets/worktree-discipline.md` | 工作树纪律详版（建/清/违规修复全步骤） |
| `assets/test/` | 夹具与场景断言脚本（红绿证据来源） |
| `assets/tools/validate-sample.mjs` | golden 样例自验工具 |
