/**
 * 卡片引用派发（卡 #186；用户原话 itw-20261011-e811③「直接引用卡片让会话去安排」）：
 * 板上任意卡片的「派发此卡」入口 → 把**卡引用**写进会话输入框草稿（用户可编辑后手动发送）。
 *
 * ## 边界（架构红线，逐条可核对）
 * - **只读契约**：本模块只读板面已渲染的节点身份（稳定号 + 标题），不读板文件、不写任何文件；
 *   唯一副作用是会话草稿写通道（`insert`，store 动作注入）。
 * - **不自动执行、不绕过编排者裁决**：只产生草稿态文本（`ComposerTextInsertRequest`），
 *   发送仍是用户动作；本模块不调命令派发、不碰会话运行时。
 * - **单通道**：复用既有「文本进输入框」写路径 `requestComposerTextInsert`（预填/示例提示/插件
 *   选择共用同一条），不自造第二条输入通道（无 DOM 事件、无第二 store 键）。
 *
 * ## 载荷（用户中途裁定：纯卡引用直发，无建议指令模板）
 * `#<稳定号> <标题>`：与板引用纪律同源——引用一律稳定号；层级标签（`1.2`）只是排版、拒入引用位，
 * 因此未领号的卡**不派发**（`null` → 入口禁发），不拿 `ID-<label>` 冒充引用。
 *
 * ## 目标判定（多会话）
 * 请求带 `scope: "focused"`：由消费侧单点 `selectComposerTextInsertRequest` 落到**当前聚焦
 * 输入框**——聚焦面是会话语义时即「当前焦点会话」；无焦点会话（聚焦面为 workspace 新任务草稿）时
 * 落草稿输入框（会话列表置顶的新任务入口）。派发方不猜会话 id，也不做第二份焦点判定。
 */
import type {
  ComposerTextInsertRequestMode,
  ComposerTextInsertScope,
  RequestComposerTextInsert,
} from "@/store/zcodeSessionStoreTypes.js";

/** 派发载荷的合并方式（保留用户已输入内容：引用追加在末尾）。 */
export const BOARD_CARD_DISPATCH_INSERT_MODE: ComposerTextInsertRequestMode = "append-if-missing";
/** 派发载荷的消费面（当前聚焦输入框 = 当前焦点会话 / 无会话时的草稿输入框）。 */
export const BOARD_CARD_DISPATCH_INSERT_SCOPE: ComposerTextInsertScope = "focused";

/** 派发所需的卡片身份（视图侧只交意图：稳定号 + 标题，不是整个节点）。 */
export interface BoardCardDispatchCard {
  no: number | null;
  title: string;
}

export interface BoardCardDispatchCall {
  card: BoardCardDispatchCard;
}

export type BoardCardDispatchOutcome = "dispatched" | "no-stable-number";

/**
 * 卡引用文本（单点）：`#<稳定号> <标题>`；标题首尾空白归一，标题为空只留 `#<号>`。
 * 未领稳定号 → `null`（无引用可注入，入口禁发——不猜号、不用层级标签）。
 */
export function buildBoardCardReferenceText(card: BoardCardDispatchCard): string | null {
  if (card.no === null) return null;
  const title = card.title.trim();
  return title ? `#${card.no} ${title}` : `#${card.no}`;
}

/**
 * 派发（唯一写路径）：把卡引用写进会话草稿请求。返回 `no-stable-number` 时通道零调用。
 * `insert` 由调用方注入（生产注入 store 动作），便于在无 store 环境核对参数逐字。
 */
export function dispatchBoardCardReference(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  card: BoardCardDispatchCard;
  insert: RequestComposerTextInsert;
}): BoardCardDispatchOutcome {
  const text = buildBoardCardReferenceText(input.card);
  if (text === null) return "no-stable-number";
  input.insert(
    input.workspacePath,
    text,
    input.workspaceIdentity,
    undefined,
    BOARD_CARD_DISPATCH_INSERT_MODE,
    BOARD_CARD_DISPATCH_INSERT_SCOPE,
  );
  return "dispatched";
}
