# 工作树纪律（zcode-board）

- 适用：本技能管理下的项目工作区 —— 工作树收纳于 `<project-root>/.zcode/worktrees/`
- 依据：`.zcode/board/design.md` §6（收纳五条件、按卡分配、主检出盲区、发号并发）、§7（门禁与 integrator）
  （设计稿正式归宿为项目内 `.zcode/board/design.md` 四轮定稿原稿；`docs/` 根目录保留给项目开发地图，不放本设计稿）
- 来源任务：T2（dogfood 环境确认 + 忽略分层 + 工作树纪律）；配套落地记录见
  `.zcode/board/evidence/T2-git-environment.md`
- 一句话：**一张卡一个工作树，名字就是卡号；建与清只走 `git worktree`，手工删目录算违规。**

---

## 1. 命名与位置

| 项 | 约定 | 理由（设计 §6.1） |
| --- | --- | --- |
| 路径 | `<project-root>/.zcode/worktrees/task-<no>` | 项目内收纳，消灭克隆平铺与 gitdir 悬空 |
| 名称 | `task-<no>`，`<no>` = 卡的**稳定号**（正整数） | 名字即映射，无第二份登记表；门禁/清理/缺口码全按名寻址 |
| 反查 | 由 `<no>` 得目录名、分支名、run 事件 `worktree`/`branch` 字段 | 卡 → 现场单向可推导 |

- `<no>` **不是**层级标签（`label` / `ID-1.2` 形态）：标签是排版，随重排漂移；稳定号发号即定、永不复用。
- `.zcode/worktrees/` 被项目根 `.gitignore` 忽略（执行现场不进版本库）；`git check-ignore .zcode/worktrees/task-<no>` 必须命中。
- **只开一层**：工作树内不再建工作树（防递归收纳）。发现嵌套 `.zcode/worktrees/` → 以 diagnostics 点名，按第 6 节正规清理。
- **声明形态（#71 修订级成文）**：run 事件的 `worktree` 字段接受两形态——① 相对**板根**的冻结短形态 `.zcode/worktrees/task-<no>`；② 相对**板根**的嵌套项目根相对路径 `<子目录>/.zcode/worktrees/task-<no>`（板根与一层子项目根并存时的常态，如 `ZPaPa/.zcode/worktrees/task-64`）。末段固定 `task-<no>`（号解析取末段）；其余形态（绝对路径、多级嵌套、隐藏目录段、非 task-<no> 末段）拒收 + diagnostics。fs 互证面 = 板根与一层子项目根下的 `.zcode/worktrees/`：缺口的触发仍按「字段命中且目录经 fs 互证真实存在」（两形态经精确/后缀匹配命中，设计 §6.1 条件 5 / 消费契约 §4.5）。

## 2. 前置条件

1. 根仓库已存在**至少一次提交**。`git worktree add` 需要有效 HEAD，空仓库（unborn HEAD）会失败——
   沙盒实测（git 2.39.2）：

   ```
   $ git worktree add .zcode/worktrees/task-1 -b task-1   # 空仓库（无提交）
   Preparing worktree (new branch 'task-1')
   fatal: not a valid object name: 'HEAD'          exit 255
   ```
   本工作区的首次提交见 `evidence/T2-git-environment.md`（`init: 工作区基线（看板系统实施前）`）。
2. 先查现场，再决定建或复用：`git worktree list`。

## 3. 建树（编排者，**只在主检出执行**）

```bash
cd <project-root>
git worktree list                                   # 先查：该卡是否已有现场（复用优先）
git worktree add .zcode/worktrees/task-<no> -b task-<no>
git worktree list                                   # 后核：新条目已出现
```

- 沙盒实测（git 2.39.2）成功形态：

  ```
  $ git commit -q --allow-empty -m 'base' && git worktree add .zcode/worktrees/task-1 -b task-1
  Preparing worktree (new branch 'task-1')
  HEAD is now at 6be76ef base

  $ git worktree list
  /private/tmp/t2-wt-probe                          6be76ef [main]
  /private/tmp/t2-wt-probe/.zcode/worktrees/task-1  6be76ef [task-1]
  ```
- **复用规则**：目录已存在且 `git worktree list` 有条目 → 直接进出，不再 `add`（重复 add 会失败）。
- base 分支 = 主检出当前分支的 HEAD；同卡后续 rebase 与合并以其为目标。
- **禁止**：在任一工作树内执行 `git worktree add`（递归收纳）；在本工作区内手工 `cp`/`git clone` 造现场。
- 发号（`--assign`）同理只在主检出运行——执行现场不发号（设计 §6.4，单写者无锁）。

### 3.1 建树单点脚本（B6-4/#122，E1 V31；2026-10-11 增）

编排者建树走 `assets/tools/create-worktree.mjs`（本节 §3 冻结步骤的脚本化，只增不改；人不再手抄步骤）：

```bash
node <skill>/assets/tools/create-worktree.mjs --no <卡号> [--root <项目根>]
node <skill>/assets/tools/create-worktree.mjs --source <计划稿> --card <标签|稳定号> [--root <项目根>]
node <skill>/assets/tools/create-worktree.mjs --no <卡号> --expect-name task-<卡号>   # 交接材料声明的树名须逐字相符
```

- **执行序**（与 §3 同构）：① 先查现场 `git worktree list`（复用优先）→ ② `git worktree add .zcode/worktrees/task-<no> -b task-<no>` → ③ `git check-ignore` 断言命中 → ④ 后核 `git worktree list`（路径 + 分支在册）。
  脚本内 check-ignore 以**前置断言**执行（忽略未命中即拒建，不让半成品现场先落地；判据与 §3 方向一致，仅时序前移）。`--no` 与 `--source/--card` 抽取号双给须一致（错号零容忍）。
- **幂等复用**：同名树已登记且分支 = `task-<no>` → 零动作返回「结果=复用」，不重复 `add`（重复 add 必失败）。
- **树名下发（stdout 五条机读线；派发 prompt/交接材料原样引用，与 B6-3 需齐绿清单可拼「现场=…」行）**：

  ```
  结果=新建|复用
  树名=task-<no>
  分支=task-<no>
  现场=.zcode/worktrees/task-<no>
  路径=<绝对路径>
  ```

  诊断（步骤/拒因）只走 stderr，前缀 `create-worktree: `；stdout 恰 4 条相对下发线 + 1 条绝对路径线，无多余噪声。
- **树名与卡号不符必咬（四类，均零建树/零分支）**：① `--expect-name` 声明名 ≠ `task-<卡号>`（拒建，exit 3）；② 现场路径已登记但挂着别的分支（拒建，exit 3）；③ `--no` 与 `--source/--card` 抽取号不一致（拒建，exit 3）；④ 非法号形态（0 / 标签 / `#100` / 小数——用法错误，exit 2）。
  前置拒绝（同为零建树）：未领号、忽略未命中、工作树内执行（只开一层）、root 非仓库顶层、空仓库（unborn HEAD）、分支遗留（无现场登记）。
- 退出码：0 = 完成（新建/复用）；2 = 用法/输入错误；3 = 前置/环境断言拒绝（不建树）。

## 4. 多角色按序进出同一工作树（设计 §6.2）

工作树按**卡**分配，不按角色分配；同卡角色串行，顺序即门禁顺序：

```
卡 #<no> → implementer → test-verifier → code-reviewer →（三绿）→ integrator
```

| 角色 | 板权限 | 报告要求 |
| --- | --- | --- |
| implementer / debugger / refactoring-optimizer | 只读板 | 报告带 `run_event` 块（role/result/cards/stoppedAt/evidence/nextStep） |
| test-verifier / code-reviewer | 只读板 | 同上；`result` 即门禁 verdict 证据事实 |
| integrator | 只读板，物理无写工具 | `merge_report.v1`（内含 `run_event`，role=integrator） |

- 子智能体**不写任何板文件**；落账由 PostToolUse hook 解析报告后机械完成（设计 §5.3）。
- `run_event` 的 `worktree`/`branch` **仅显式声明时转抄**；缺省一律 `null` + diagnostics「未声明工作树」（设计 §5.3 的"按卡号推导"自 #42/v2.1 勘误起作废——推导会为管理型 run 造出幽灵执行现场，误触 `unmerged-worktree`）。
- 板的 `unmerged-worktree` 缺口要求「`worktree` 字段命中**且**目录经 fs 互证真实存在」（#42）；声明了现场而目录不在 → 只落提示级 diagnostics，不计缺口。互证面 = 板根与一层子项目根下的 `.zcode/worktrees/`（跨项目现场常驻子项目根）。
- 并发 = 不同卡的不同工作树互不干扰；一卡一现场，证据（diff/分支）集中。
- 工作树内的子智能体如需读板，读工作树内的 `board.json` 副本即可（板入 git 的直接收益）；执行上下文以主检出注入的派发输入为准。

## 5. 清理（integrator，**合并之后**）

```bash
cd <project-root>
git worktree remove .zcode/worktrees/task-<no>
git worktree prune
git branch -d task-<no>          # 已合并分支；-d 而非 -D，未合并会被拒绝
```

- 顺序不可换：先 `merge`（commit message 精确 `Merge task-<no> [#<no>]`）→ 再 remove/prune → 再报 `merge_report.v1`。
- 沙盒实测（git 2.39.2）干净退出：

  ```
  $ git worktree remove .zcode/worktrees/task-1 && git worktree prune && git branch -d task-1
  Deleted branch task-1 (was 6be76ef)          exit 0
  ```
- `git worktree remove` 拒绝执行（工作树脏/有未跟踪文件）时：先 `git -C .zcode/worktrees/task-<no> status` 查明，
  **不得直接 `--force`**；确需丢弃现场必须在 run 事件/证据中写明理由。修不了就退回编排者，不自行补救。
- remove 之后 `.zcode/worktrees/` 保留为空目录属正常（git 不跟踪空目录）。
- tasks.md 勾选发生在合并之后（checkbox 只反映已合并部分，设计 §6.3）；勾选后重编译 → 卡 `completed`、`unmerged-worktree` 缺口清除。

## 6. 违规形态与正规修复（对应设计场景 26）

| 现象 | 判据 | 正规修复 |
| --- | --- | --- |
| 目录被手工 `rm`（残留登记） | `git worktree list` 条目带 `prunable` 标记 | `git worktree prune` |
| 目录在而 git 不知（悬空 gitdir） | 编译器 diagnostics 点名 / `git worktree list` 无条目 | `git worktree prune`；必要时重走第 3 节建树 |
| 手工删目录后未 prune 又建同卡树 | `add` 报路径已存在或分支已存在 | 先 `prune` 清登记，再按第 3 节重建 |
| 嵌套 `.zcode/worktrees/` | 工作树内再次 `add` | 禁止；diagnostics 点名，只留一层，多余树走第 5 节清理 |
| 已 prune 却再 `remove` | `fatal: '.zcode/worktrees/task-<no>' is not a working tree`（exit 128） | 无需 remove；直接 `prune` + `git branch -d` |

沙盒实测（git 2.39.2）残留与清理：

```
$ rm -rf .zcode/worktrees/task-2
$ git worktree list
/private/tmp/t2-wt-probe                          6be76ef [main]
/private/tmp/t2-wt-probe/.zcode/worktrees/task-2  6be76ef [task-2] prunable

$ git worktree prune && git branch -d task-2
Deleted branch task-2 (was 6be76ef)          exit 0
```

## 7. 与忽略分层、板状态的关系

- 忽略分层（检查点 4）：`.zcode/worktrees/` 忽略、`.zcode/board/` 与 `.zcode/config.json` 放行；
  逐条验收命令与真实输出见 `evidence/T2-git-environment.md`。
- 工作树目录被忽略**不影响** git 的 worktree 登记（登记在 `.git/worktrees/`，属仓库元数据）。
- 板侧可见性：主检出看不到工作树内进行中的改动（设计 §6.3），"执行到哪里"只来自 run 事件
  （`lastRun`/`activeRun`/`unmerged-worktree`）；不要把工作树内进度抄进板文件。

## 8. 核对清单

派发前（编排者）：

- [ ] `git worktree list` 已查；该卡无既有现场或复用既有条目
- [ ] 树名 = `task-<no>`，`<no>` 为稳定号（非标签）
- [ ] `git check-ignore .zcode/worktrees/task-<no>` 命中
- [ ] 未在工作树内发号、未在工作树内建树

清理后（integrator）：

- [ ] `git worktree remove` + `git worktree prune` 已执行，登记无残留（`git worktree list` 无该条目）
- [ ] `git branch -d task-<no>` 成功（未合并会被拒绝 → 退回，不 `-D`）
- [ ] merge commit = `Merge task-<no> [#<no>]`；`merge_report.v1` 已报回
- [ ] 目录已消失；若有残留走第 6 节正规路径，不手工 `rm`
