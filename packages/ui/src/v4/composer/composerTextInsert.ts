/**
 * 会话草稿**文本注入通道**（外部文本 → 输入框）的判定与落地单点（卡 #186 收口）。
 *
 * ## 通道契约（成文于此，测试与调用方按此核对）
 * - 写路径（唯一）：`zcodeSessionStore.requestComposerTextInsert`（预填/示例提示/插件选择/
 *   板卡引用派发共用同一条）；本模块不新增第二个输入通道，也不写板、不碰会话运行时。
 * - 消费面（多会话目标判定，`selectComposerTextInsertRequest` 单点）：
 *   - 只认**聚焦** input（非聚焦 composer 不消费）；
 *   - `scope: "focused"`（板卡引用派发）→ 当前聚焦输入框：聚焦面是会话即「当前焦点会话」，
 *     聚焦面是草稿（无会话）即「workspace 会话列表置顶的新任务入口」；
 *   - `scope` 缺省（既有调用面：新任务预填/示例提示/插件选择）→ 草稿输入框专用，行为不变。
 * - 载荷落地（`applyExternalTextInsertRequestToComposer`）：`replace` / `prepend-if-missing`（既有）
 *   与 `append-if-missing`（卡 #186：纯文本追加，保留用户已输入内容）三种合并方式；
 *   引用的去重判据在 `hasComposerTextReference` 一处。
 */
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { ComposerTextInsertRequest } from "@/store/zcodeSessionStoreTypes.js";

/**
 * 消费面判定（单点）：请求 → 本输入框是否消费。
 * 非 `null` 即「本 composer 是目标」，返回的请求交给落地函数应用；应用后由调用方按
 * `requestId` 清理（既有 `clearComposerTextInsertRequest` 语义，不在此另设清理路径）。
 */
export function selectComposerTextInsertRequest(input: {
  request: ComposerTextInsertRequest | null | undefined;
  /** 本输入框是否处于聚焦面（宿主的 focused 门禁：聚焦 pane + 前台启用态）。 */
  focused: boolean;
  /** 本输入框绑定的会话 id（`null` = workspace 新任务草稿输入框）。 */
  sessionId: string | null;
}): ComposerTextInsertRequest | null {
  const { request, focused, sessionId } = input;
  if (!request || !focused) return null;
  if (request.scope === "focused") return request;
  return sessionId === null ? request : null;
}

/**
 * 引用去重判定：当前草稿里是否已有同一引用（逐字——用户把引用改写过即视为新引用，允许再追加；
 * 空草稿不命中）。重复派发同一张卡因此不会在输入框里堆出第二份。
 */
export function hasComposerTextReference(current: string, reference: string): boolean {
  if (!reference) return false;
  return current.includes(reference);
}

/** 落地所需的输入编辑器 API（`LexicalChatInputHandle` 的结构切片；测试用替身同型）。 */
export type ComposerTextInsertInputApi = Pick<
  LexicalChatInputHandle,
  | "getMarkdown"
  | "appendText"
  | "prependMentionIfMissing"
  | "setMention"
  | "setText"
  | "setTextWithPluginMentions"
>;

/**
 * 请求落地（唯一应用点，从 ConversationComposer 抽出以便单测与浏览器断言共用同一份实现）：
 * 返回「已应用的 requestId」——调用方（SessionPane/ConversationComposer）据此清理 store 请求。
 * 同一 requestId 重复调用不再落第二次（`appliedRequestId` 记忆）。
 */
export function applyExternalTextInsertRequestToComposer({
  appliedRequestId,
  inputApi,
  request,
  requestFocus,
  scheduleDraftPersist,
  updateText,
}: {
  appliedRequestId: number | null;
  inputApi: ComposerTextInsertInputApi | null;
  request: ComposerTextInsertRequest | null | undefined;
  requestFocus: () => void;
  scheduleDraftPersist: () => void;
  updateText: (text: string) => void;
}): number | null {
  if (!request || request.requestId === appliedRequestId) {
    return appliedRequestId;
  }
  if (!inputApi) {
    return appliedRequestId;
  }
  // 板卡引用派发（#186）：纯文本追加——保留用户已输入内容，且不重复堆同一引用。
  // 已在输入里的请求照样消费（否则请求滞留在 store，用户切面后引用会再冒一次）。
  if (request.mode === "append-if-missing") {
    const current = inputApi.getMarkdown();
    if (!hasComposerTextReference(current, request.text)) {
      inputApi.appendText(request.text);
      updateText(inputApi.getMarkdown());
      scheduleDraftPersist();
    }
    requestFocus();
    return request.requestId;
  }
  if (request.mode === "prepend-if-missing" && request.mention) {
    if (!inputApi.prependMentionIfMissing(request.mention)) {
      return request.requestId;
    }
    // Bug 原因：安装完成后若回放点击时保存的旧 prompt，会覆盖用户安装期间的编辑。
    // 节点级前置保留编辑器当前的 mention 与段落结构，再从编辑器读取 canonical 草稿。
    updateText(inputApi.getMarkdown());
    scheduleDraftPersist();
    requestFocus();
    return request.requestId;
  }
  if (request.mention && request.text.startsWith(request.mention.markdown)) {
    // 根因：商店试用以前只传 canonical 文本，Lexical 无法知道开头链接是结构化 Plugin mention。
    // request 同时携带 display-only 节点数据；发送与草稿事实源仍使用 request.text 原文。
    inputApi.setMention(request.mention, request.text.slice(request.mention.markdown.length));
  } else if (request.text.includes("](plugin://")) {
    // 推荐任务可在正文中组合多个插件；按原位置构造成真实提及节点。
    inputApi.setTextWithPluginMentions(request.text);
  } else {
    inputApi.setText(request.text);
  }
  updateText(request.text);
  scheduleDraftPersist();
  requestFocus();
  return request.requestId;
}
