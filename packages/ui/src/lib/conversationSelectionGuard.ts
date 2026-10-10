import { CONVERSATION_SELECTION_MAX_TEXT_LENGTH } from "@/lib/conversationSelectionReference.js";

type ConversationSelectionGuardResult = "eligible" | "ineligible" | "single-limit";

/**
 * 选区端点的**控件/容器排除表**：「添加到当前任务 / 在辅助对话中提问」浮条的共享判据。
 *
 * `[data-no-selection-action]` 是**只读表面的容器豁免约定**（卡 #64，用户原话：
 * "项目看板选择文字后与查看文件的页面一致，显示添加到会话的功能"）：面板在根容器声明该属性
 * 即声明「本容器内的文本不参与"选中文字→添加到会话"」，选区**起点或终点**落在容器内都豁免
 *（跨容器拖选时起点在看板内、终点在容器外，同样不算可引用选区）。
 *
 * 为什么豁免放在**判定侧**而不是各面板内部：浮条是文件预览与对话流共用的一份实现
 *（`SelectionActionMenu`）。面板只声明身份（`data-no-selection-action`），不复制、不打补丁
 * 判定逻辑；共享判据一处收口，新增只读面板时复用的是同一条约定。
 */
const CONVERSATION_SELECTION_EXCLUDED_SELECTOR = [
  "button",
  "input",
  "textarea",
  "[role='button']",
  "[role='dialog']",
  "[data-v4-composer-dock]",
  "[data-conversation-selection-tooltip]",
  "[data-no-selection-action]",
].join(",");

export function hasExcludedConversationSelectionEndpoint(
  startElement: Element | null | undefined,
  endElement: Element | null | undefined,
): boolean {
  return Boolean(
    startElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR) ||
    endElement?.closest(CONVERSATION_SELECTION_EXCLUDED_SELECTOR),
  );
}

export function guardConversationSelectionCandidate(input: {
  enabled: boolean;
  sameRow: boolean;
  insideTimeline: boolean;
  excluded: boolean;
  sameSelectableRegion: boolean;
  supportedContent: boolean;
  text: string;
  hasLayout: boolean;
}): ConversationSelectionGuardResult {
  if (
    !input.enabled ||
    !input.sameRow ||
    !input.insideTimeline ||
    input.excluded ||
    !input.sameSelectableRegion ||
    !input.supportedContent ||
    !input.text ||
    !input.hasLayout
  ) {
    return "ineligible";
  }
  return input.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH ? "single-limit" : "eligible";
}
