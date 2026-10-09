# 小队活动时间线（规格 §11.2）：渲染方案（**提案，2026-10-03 controller 已收口**）

> **状态（2026-10-03）：第 37 轮已按本文档实施完成**（渲染 + 挂载 + 动效门控；`d44c5d2`）。
> 两半基础由第 36 轮落地：
> · 数据面：`ISquadRuntimeService.listSquadRuns(target, { parentWorkItemId? })`（不传 = 本 workspace 全量历史，含 merged / discarded）；
> · 布局模型：`packages/ui/src/squad/squadTimelineModel.ts`（lane / station / arc / domain，纯函数，已被 16 条用例逐格钉住）。
> 视觉语言（§11.2）：**lane = 队员 / station = 一次运行 / 弧线 = 交接**；**不复用** workflow 时间线组件。
> 下面标 **【已收口（2026-10-03）】** 的两处是 controller 的裁定（挂载点 = 批根行内联展开；
> 不做展开态记忆）；未标注的是本提案的推荐口径，实施按它走。

## 一、挂载点：**选中某批后展开**（推荐），不做「全批平铺」

推荐：在「工作项」页（`WorkItemsPage`，现有 `WorkItemsBoard` + `SquadRunsReview` 两个区块）的**批根行内联展开** ——
点某条批根的「时间线」展开钮 ⇒ 该行下方按 `listSquadRuns(target, { parentWorkItemId })` 拉本批历史并渲染；再点收起（不保留数据）。

理由（对着 §11.4 与数据形状说）：

1. **lane 数的上界就是小队规模**（≤ 8）。平铺所有批会把几支小队的 lane 混进一张图，lane 数失去上界 ——
   §11.4「≤ 8 lane 流畅」这条承诺是按「一支小队一批」说的；选中展开恰好让图与承诺同口径。
2. **「批的 run 数可能很多」**：全量口径下站点数 = 全项目历史 run 数（无上界）；按批收敛到
   该批的 run 数（≈ 子项数 × 重跑次数），这是唯一能给出**数据上界**的划分（见 §三 虚拟化）。
3. 与现有区块**互补不重复**：`SquadRunsReview` 只列**活跃** run（快照 = `listActive` 口径，用来收尾），
   时间线画的就是**历史**（含终态）—— 两块是同一批数据的两个口径，谁都不替代谁。
4. 内联展开与「批根」判据**同源**：批根已由 `isSquadBatchRoot` 认出（放弃整批入口在用同一份判据），
   展开钮只在批根行上出现，不新增第二份「什么是批」。

**【已收口（2026-10-03）】** 展开钮落在**批根行内联**：`isSquadBatchRoot` 认下的行给「时间线」钮，
展开内容渲染在**该行下方**（`WorkItemsBoard` 的 `<li>` 里挂 `SquadTimelineSection`，组件自己按
`parentWorkItemId` 拉本批历史）；**不做展开态记忆** —— 一次只展开一批（页面单点
`expandedTimelineWorkItemId`），再点收起即卸载、数据丢弃。实施落点见
`packages/ui/src/squad/{WorkItemsBoard,WorkItemsPage,SquadTimelineSection}.tsx`。

## 二、几何与动效

- **坐标系**：x = 时间域（把 `model.domain` 线性映射到画布宽；**开口站的右端由渲染层取 `max(domain.endAt, now)` 再映射**
  —— 模型不带 now 是刻意的，见模型文件顶注）；y = lane 固定行高（每 lane 一行，行内 station 画成圆角条）。
- **站点**：圆角条 = `[startAt, endAt ?? now]`；`open === true` 的站点右端**开口**（渐隐端帽），
  `status` 经既有 `squadRunStatusMessageId` 翻词做标注；`isLeaderTask` 的站点用队长标记（与 run 目录同款徽标）。
- **弧线**：二次贝塞尔（控制点取两站 x 中点、y 取两 lane 中线）从队长站画到队员站；
  起点 / 终点取站点条的边缘锚点。只画 `model.arcs` 给的边，**不在组件里重新推断**。
- **动效策略**：入场 = 数据到齐后整体淡入（150–200ms，不做逐站级联 —— 时间线是复盘视图，不是表演）；
  推进 = 仅有开口站时，右端按秒级 tick 伸展（或 rAF 但节流到 1s）。**必须尊重 `prefers-reduced-motion`**：
  命中时禁用过渡与 tick 推进（站点直接按静态宽度画、开口端直接画到 now）。
  **实现口径（第 37 轮实测）**：淡入走 CSS transition（可被 CSS media query 抑制）；
  **开口站的 ticker 必须由 JS 门控** —— `setInterval` 不是样式，CSS media query 管不到它，
  故用 `window.matchMedia("(prefers-reduced-motion: reduce)")` 判断后**不启动** ticker
  （`matchMedia` 不可用的环境按"不启动"处理）。两处互为补充，缺 ticker 那一半 = 动效纪律落空。
- **缩放 / 平移**：v1 不做。铺满容器宽 + 自适应即可；引入 zoom 时再谈交互与坐标变换。

## 三、悬挂项：虚拟化（v1 **先不做**）

- **数据上界**（按批展开的推荐下）：lane ≤ 小队规模（≤ 8）；station 数 = 该批 run 数
  = 队长 run 数（同工作项至多一条活跃队长行）+ 队员 run 数（≈ 子项数 × 重跑次数）。
  **一屏数百个 SVG 节点的量级**，直接渲染 DOM 即可。
- **什么时候必须做**（触发条件，任一命中）：① 单批 station 实测 > 300（首帧或滚动卡顿）；
  ② 产品口径改成「跨批 / 全项目一张图」（lane 与 station 双双失去上界）；③ 引入长时窗缩放。
- **届时怎么做**：lane 固定行高 ⇒ 按行虚拟化（`@tanstack/react-virtual` 已在 ui 依赖里）＋
  按时间窗口裁剪 station；弧线需要跨裁剪边界保留锚点信息 —— 这一步的成本主要在这里，故 v1 不做。

## 四、视觉纪律 / 「推断」怎么呈现

- **身份色只用九色板**（lane 标签点 / 站点描边取 `lane.color`，即 `SUBAGENT_COLORS` 一侧）；
  **状态只用语义状态色 token**（§11.3：状态不由头像配色表达、不用原生色值）—— 站点的状态走
  文字 / 小徽标 + 语义 token，不污染身份色。
- **弧线必须以「推断」呈现**（模型里 `kind: "leader_dispatch_inferred"` 的唯一原因）：
  推荐 = **虚线 + 较低不透明度 + 图例注明「虚线 = 推断的派发关系」**，且悬停提示写明
  「台账没有派发边，这是按时间与批次推断的」。真边（台账加列 / 事件）落地前不得画成实线。
- **i18n**：时间线新增文案（空态、图例、推断提示、开口站）进 `zh-CN` / `en-US`，布局不依赖截断（§11.4）。
- **升级路径（登记项）**：弧线的真边 = 给 `squad_runs` 加一列（派发时由唯一写者写入）**或**另存派发事件；
  两者都要迁移 / 新写者，不在本轮加法范围内 —— 届时 `kind` 从 `leader_dispatch_inferred` 扩出真值类型，
  编译期会把全部消费点（含渲染层）拖出来对齐。

## 五、落地边界（第 37 轮**已做**渲染/挂载/动效门控；本节列的是延续的「明确不做」）

虚拟化 / 缩放平移（触发条件见 §三）、台账加「派发边」列或迁移（见 §四「升级路径」）、
host 侧 `desktop`、唤醒规则入口、推送。
