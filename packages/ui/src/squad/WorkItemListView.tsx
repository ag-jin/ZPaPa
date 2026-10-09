import type { WorkItem } from "@zcode/shared";
import { WorkItemRowList, type WorkItemRowEnvironment } from "./WorkItemRows.js";
import { flattenWorkItemBoard } from "./workItemsViewModel.js";

/* **list 视图**（阶段二 · T-P2-R2）：**高密度树形行**的单列列表 —— 批次子树按深度缩进，
   批根行保留时间线 / 放弃整批入口。

   三个「不做」是本视图的正式契约（拆解 §3 的裁定，不是待办）：
   · **不做批次分组**：整份列表只有**一个**行容器，批次子树只靠 `depth` 缩进表达。把每棵树
     包成容器/分组 = 把「根」从行序投影升格为容器结构（拆解 §3.1 三条否决理由：第三份根投影、
     批根入口改宿主、聚焦链路破坏）。
   · **不做折叠**：所有行都挂载（拆解 §3.2 v1）—— 折叠会让收件箱聚焦的目标行可能不在
     `rowElementsRef` 里，滚动 + 高亮静默失效；要折叠必须先同轮交付「聚焦目标在折叠子树内
     ⇒ 自动展开祖先链」的判据 + 守卫 + 演示（登记为后续）。
   · **不做虚拟化**：同上，按需挂载与聚焦注册天然冲突（登记为后续，与 table 的分页一并裁）。

   行本身不在这里：行 JSX / 行 DOM 引用 / 聚焦注册 / 批根入口 / 缩进全部在 `WorkItemRows`
   （跨三视图的**唯一**实现，见 T-P2-R1 的接口冻结）。本文件只决定「行从哪来、外面套什么壳」——
   行序与深度仍来自**同一份** `flattenWorkItemBoard`（整个 surface 唯一的一次 DFS 消费点之一，
   这里不复制、不重排、不重算父子）。

   锚点归属（T-P2-R2 的显式化）：`work-items-list-view` 由**本视图自己的容器**持有，不再借
   `WorkItemRowList` 的 `<ul>` —— 面锚点不该耦合到共用模块的内部结构（那个 `<ul>` 是三个视图
   共用的，未来若加壳/换实现，锚点会跟着漂移且不报错）。看板的不分组分支仍保持
   `<ul data-testid="work-items-list">` 的既有 DOM（逐字节基线在 `workItemsSurfaceBaseline.ts`）。 */

export function WorkItemListView({
  items,
  environment,
}: {
  /** 已投影的可见项（宿主给的：过滤/搜索/排序都已完成）。 */
  items: WorkItem[];
  environment: WorkItemRowEnvironment;
}) {
  return (
    /* `data-view` 是**面的**标记（不是行的）：list 与看板默认路径的容器 class 相同，
       样式与 e2e 需要能区分「当前是哪张视图」，而 class 列表不是稳定标识。 */
    <div className="flex flex-col" data-testid="work-items-list-view" data-view="list">
      <WorkItemRowList rows={flattenWorkItemBoard(items)} environment={environment} />
    </div>
  );
}
