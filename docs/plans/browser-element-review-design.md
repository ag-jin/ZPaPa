# 内置浏览器「元素层级滑轨 + 多元素附评语批量提交」设计

- 分支：`feat/browser-element-review`（基于主线 `512e30e`）
- 状态：待评审（architecture-planner 产出，供 task-planner 拆解）
- 日期：2026-10-08
- 范围：正式版功能（非 dev 实验），中英文案齐全

---

## 1. 目标与非目标

### 目标

1. **祖先层级滑轨**：点击选中元素后进入「层级调整阶段」，用一条横向滑轨在祖先链上移动选择（点击的元素 = 第 0 档，向上到 body 之前封顶）；绿框与页内 `tr th` 风格选择器标签实时跟随；确认后按当前层级采集完整元素负载。
2. **多元素附评语批量提交**：一次拾取会话内连续选多个元素；每个元素可在拾取时就地（浮条内、所选元素相关流程中）输入一段评语/问题，也可跳过；composer 附件列表内事后仍可修改评语；发送时所有「元素 + 评语」随同一条消息序列化进 prompt 尾块，agent 逐条处理。
3. 顺手修复三个既有缺陷（见 §4.6）：popover 三键未接线、hook 注释失实、按 uuid 去重导致的双份累积。

### 非目标

- 不在 guest 页面内自绘滑轨/确认按钮等交互控件（页内只保留纯展示 overlay + 标签）。
- 不新增 guest→renderer 实时推送通道（不动 `packages/shared/src/channels.ts` 与 desktop preload）。
- 不穿越 iframe / shadow DOM 边界上溯祖先（与现有 selector 构建的 `parentElement` 遍历保持一致）。
- 不做视觉重设计：页内信息卡、overlay 样式维持现状（仅新增 adjust 阶段的绿色锁定态）。
- 不支持评语富文本（纯文本单行语义，见 §7）。
- 不覆盖移动端 Web（浏览器面板本身桌面限定，`browser.desktopOnly` 既有文案）。

---

## 2. 证据基础（已核实 file:line）

以下均在当前分支核实，路径省略前缀 `/Users/linguojin/Workspace/ZCode/ZPaPa/.worktrees/browser-element-review/`：

| 事实 | 位置 |
| --- | --- |
| 注入机制：`buildWebElementPickerScript` 以 `(${webElementPickerScript.toString()})(${JSON.stringify(options)})` 组装，options（含 labels）已参数化 | `packages/ui/src/lib/webElementPickerScript.ts:645-655` |
| 注入脚本开头自动取消旧实例（`existing?.cancel?.()`），实例句柄 `window.__zcodeWebElementPicker = { cancel }` | 同上 `:41-43`、`:630-636` |
| cancel 走独立小脚本调句柄方法（renderer 反向驱动先例） | 同上 `:657-664` |
| 现生命周期：mousemove 悬停 → click `preventDefault` 后 resolve `{status:"selected", element}`，Esc resolve cancelled，`settled` 守卫一次性，cleanup 移除监听与 overlay | 同上 `:596-642`、`:373-381` |
| overlay/标签 `pointerEvents:none` 纯展示，z-index 2147483647 | 同上 `:329-367` |
| `collectElement` 采集字段（无 id、无 comment） | 同上 `:576-594` |
| hook：runId 防串、`executeJs` 传输无关出口（现成测试接缝）、window Esc 兜底监听、`labels` 参数存在但调用方未传 | `packages/ui/src/hooks/useWebElementPicker.ts:15-24`、`:88-137`、`:147-167` |
| `executeJs` 实现 = `<webview>.executeJavaScript(script, true)`；hook 调用处未传 labels（缺陷①） | `packages/ui/src/browser-use/UnifiedBrowserView.tsx:405-416` |
| 工具栏按钮与 `handleTogglePicker` | `packages/ui/src/EmbeddedBrowserPaneParts.tsx:129-140`；`UnifiedBrowserView.tsx:957-968` |
| 视图根容器为 flex 列（工具栏 → 可选视口工具栏 → `BrowserViewportSurface`），浮条可挂根容器 | `UnifiedBrowserView.tsx:1046-1106` |
| 负载类型、markdown 构建（固定字段行）、`readField` 按 `^Label:` 行读取、`## Element` 分割解析 | `packages/ui/src/lib/webElementContext.ts:24-42`、`:150-209`、`:211-223`、`:296-340` |
| composer 侧按 uuid id 去重（每次拾取新 uuid ⇒ 实际不去重） | `packages/ui/src/v4/composer/useWebElementContexts.ts:100-106` |
| chip = 单个 `ContextAttachmentPill` + hover 卡内元素列表（仅单项删除/全部移除） | `packages/ui/src/v4/composer/WebElementContextAttachmentChip.tsx:20-87` |
| 发送序列化固定顺序、解析严格反序（web 尾块夹在 code 与 pptx 之间） | `packages/ui/src/v4/composer/composerPromptContexts.ts:43-80` |
| chip 挂载与序列化调用 | `packages/ui/src/v4/ConversationComposer.tsx:1309-1314`、`:1960-1990`（注意实际路径在 `src/v4/` 下） |
| PPTX 评语范式：`\0` 连接身份键纯函数去重替换、固定英文 directive 常量、JSON 尾块 | `packages/ui/src/lib/pptxElementReference.ts:186-207`、`:4-6`、`:209-223` |
| PPTX 操作条范式：Popover + Textarea、Esc 区分弃评语/退出、IME 组合态保护 | `packages/ui/src/components/ui/pptx-selection-action-bar.tsx:58-133` |
| test-ids 浏览器段 | `packages/shared/src/test-ids.ts:118-131` |
| i18n 两段键位（两侧键集已对齐） | `packages/ui/src/i18n/locales/zh-CN.ts:855-860`、`:1363-1373`；`en-US.ts:936-941`、`:1473-1485` |

分类说明：以上均为**确认事实**（本轮定点验证或 code-explorer 报告且经本轮抽查吻合）。本文标注「假设」处除外。

---

## 3. 总体架构：模块与接缝

按 deep module 视角划分三个模块（每个模块小接口、大实现）：

```
┌───────────────────────────────────────────────────────────────────────┐
│ 模块 A「网页元素拾取会话」（改造重点）                                  │
│  接口：startPicking / cancelPicking / togglePicking / isPicking        │
│        + session 状态（phase/chain/level/lastSelected/pickedCount）    │
│        + setLevel / confirmSelection / requestRepick                   │
│        + saveComment / skipComment                                     │
│  实现：useWebElementPicker 会话循环状态机                               │
│        + webElementPickerScript 页内阶段状态机与句柄 API                │
│        + WebElementPickerBar 浮条（纯展示 + 事件转发）                  │
│  接缝：executeJs 注入出口（既有，测试从此进入）                          │
├───────────────────────────────────────────────────────────────────────┤
│ 模块 B「网页元素上下文契约」（webElementContext.ts，既有，小扩展）       │
│  接口：Payload 类型（+comment）、add/mergeWebElementContextAttachment   │
│        buildPromptWithWebElementContexts / parsePromptWebElementContexts│
│  接缝：纯函数（node:test 直接覆盖）                                     │
├───────────────────────────────────────────────────────────────────────┤
│ 模块 C「composer 附件消费」（既有，小扩展）                             │
│  接口：useWebElementContexts（contexts/remove/clear + updateContext）   │
│        WebElementContextAttachmentChip（+逐项评语展示与编辑）           │
│  接缝：window CustomEvent（既有 add/remove 事件，语义升级为身份合并）   │
└───────────────────────────────────────────────────────────────────────┘
```

- **深度与杠杆**：模块 A 把「页内状态机 + 祖先链 + 节流驱动 + 错误收敛」全部藏在 `executeJs` 之后，UnifiedBrowserView 只需多渲染一个浮条并转发动作；模块 B 的身份合并让「重拾取 = 更新」「评事后补」两个需求共用一条语义路径，调用方零分支。
- **删除测试**：`WebElementPickerBar` 若删除，其布局/焦点/IME 逻辑会全部散回 `UnifiedBrowserView`（一个千行组件），它不是 pass-through，保留成立；`mergeWebElementContextAttachment` 若删除，去重合并规则会在 `useWebElementContexts` 与未来其他监听方重复出现，保留成立。
- **适配器**：`executeJs` 是既有适配器接缝（UnifiedBrowserView 提供 webview 实现，测试提供 fake），本设计不新增适配器、不新增通道。

---

## 4. 裁定点结论

### 4.1 滑轨 UI 位置：renderer 侧 React 浮条（采纳原倾向，并具体化挂载点）

**结论**：新组件 `WebElementPickerBar`，渲染在 `UnifiedBrowserView` 根容器内（根容器加 `relative`），绝对定位悬浮于 webview 视口底部、水平居中。滑轨 `onChange` → hook `setLevel(n)`（rAF 节流）→ `executeJavaScript` 小脚本调页内句柄 `showAncestor(n)` 重定位 overlay + 更新页内 `tr th` 风格标签。

**理由**：样式/主题/i18n/data-testid 全部走 renderer 体系，可直接被 CDP E2E 驱动；不受 guest 页面 CSS、滚动、缩放干扰；不需要把页内 overlay 改成可交互（维持 `pointerEvents:none` 的纯展示模型）；renderer 反向驱动有现成先例（`buildCancelWebElementPickerScript` 即句柄小脚本）。

**否决备选**：
- *页内自绘滑轨*：需要可交互 overlay（破坏现纯展示模型）、页内控件无法挂 data-testid/i18n、受页面 CSS 与站点脚本干扰，测试只能靠坐标。
- *guest→renderer 实时推送*：需要动 `channels.ts` + preload（越出「只改 packages/ui + test-ids 例外」边界），且 §4.2 的阶段化 promise 拓扑让 renderer 根本不需要推送。
- *工具栏区嵌滑轨*：距视觉焦点（被选元素）过远，工具栏已是紧凑表单布局。

### 4.2 拾取会话状态机：阶段化 promise 拓扑（推翻「原 Promise 保持 pending」倾向）

**结论**：一次拾取会话 = **一次整脚本注入**（脚本创建实例并返回首个 `pick()` 的 promise）+ 后续全部通过**句柄小脚本**驱动；每次阶段转换 = 一次 `executeJavaScript` 的 resolve，renderer 以 resolve 结果驱动浮条 UI 与下一阶段。页内实例句柄从 `{cancel}` 扩展为：

```ts
interface ZcodeWebElementPickerHandle {
  pick(): Promise<
    | { status: "clicked"; chain: WebElementAncestorStep[] }   // 进入层级调整
    | { status: "cancelled" }                                  // hover 阶段 Esc
  >;
  beginAdjust(): Promise<
    | { status: "selected"; element: CollectElementPayload }   // 确认（Enter 或 confirm()）
    | { status: "repick" }                                     // adjust 阶段 Esc / 重选
    | { status: "cancelled" }
  >;
  showAncestor(level: number): { level: number; label: string } | null;  // 幂等，同步返回，但只是可选诊断返回：面包屑以 renderer 本地夹取为准，不消费它
  confirm(): void;      // 等价 Enter
  requestRepick(): void; // 等价 adjust 阶段 Esc（触发 beginAdjust resolve repick）
  cancel(): void;       // 任意阶段：pending promise 一律 resolve cancelled 并 cleanup（沿用现契约）
}
```

**推翻「保持 pending」的理由**：React 浮条必须感知页内事件引发的阶段切换（hover→adjusting、Enter 确认）。单 pending promise 下 renderer 对页内事件全盲，只剩两条路：guest→renderer 推送（被边界排除，见 §4.1）或浮条常驻但状态未知（不可用）。阶段化 resolve 让**每次 renderer 需要知情的时刻恰好是一条 promise 的落定点**，零新通道。

**祖先链规则**：
- click 时预计算：`chain[0]` = 被点元素，沿 `parentElement` 上溯，**排除 `body`/`html`/`document`**，深度上限 24（防御病态深 DOM；截断时面包屑尾部显示省略指示）。
- 滑轨档位与链一一对应：档位 i = `chain[i]`，共 `chain.length` 档；链长 1 时滑轨单档禁用。
- 被点元素即 body/html 时链长 1，行为退化为「仅确认/重选」。
- 页内标签文本 = `buildAncestorLabel(chain, level)`：取所选元素及其父（若在链内）的 tag 组成至多两段（如 `tr th`）；有 id 时显示 `tag#id`。完整面包屑（`html > body > … > th`，当前档高亮）渲染在 React 浮条里，数据来自 `pick()` resolve 的 `chain`。
- adjust 阶段 overlay 换绿色边框区分 hover 蓝框（锁定态语义），页内标签内容切换为层级标签。
- adjust 期间页面滚动/缩放导致元素移位：页内挂 `scroll`（capture, passive）+ `resize` 监听重定位 overlay（冻结 hover 监听后仅剩这两个）。
- confirm 时以**当前层级元素**执行 `collectElement`（新鲜 `capturedAt`）。

### 4.3 多选循环编排放哪：hook 循环（采纳原倾向）

**结论**：`useWebElementPicker` 内部循环：会话 = 注入一次；每个元素 = `pick()` → `beginAdjust()` 两段 await；`selected` → dispatch add 事件 → 自动进入 comment 阶段（浮条展开评语框）→ 保存/跳过 → 再次 `pick()`，直至用户退出。

**理由**：对 UnifiedBrowserView 的外部契约不变（仍 `startPicking`/`cancelPicking`/`togglePicking`）；页内无需新增任何确认按钮（浮条承担全部确认/重选/完成交互）；每选一个 chip 即时累积，反馈明确；`executeJs` 接缝让循环状态机可用 fake 注入直接单测。

**否决备选**：脚本内部循环（一次 `executeJavaScript` 选完 N 个才返回）——需要在页内画确认/完成按钮（§4.1 已否决页内交互控件）、单次调用悬挂数分钟（导航/超时风险集中、renderer 无进度感知）、i18n 需注入页面。

**退出会话的触发**：hover 阶段 Esc（pick resolve cancelled）；浮条「完成」按钮；工具栏按钮再点（`togglePicking`）；hook 卸载（既有 effect）；`executeJavaScript` reject（导航/实例丢失，见 §12 风险）。统一收敛为 `cancelPicking()` 语义（发 cancel 小脚本 + runId 失效 + 状态归 idle）。

### 4.4 评语录入与修改：主入口 = 拾取浮条就地评语区（按用户澄清），次入口 = composer chip 内联编辑

**结论（主入口）**：确认（Enter/确认按钮）后，`beginAdjust()` resolve `selected` → hook dispatch 元素（此时无评语）→ 会话进入 comment 阶段：浮条在滑轨区正下方展开 Textarea（pptx 范式：`compositionStart/End` + `isImeComposingKeyEvent` 组合态保护；Esc 在此 = 仅弃草稿回 hover，不退出会话），按钮 = 「加入对话（带评语）」/「跳过」。保存评语 = renderer 以 `{...lastSelected, comment}` 再次 dispatch 同一 add 事件，走 §8 身份合并原位更新（不回页面取数）。跳过 = 直接回 hover 继续选下一个。

**结论（次入口）**：`WebElementContextAttachmentChip` hover 卡列表项内：已有评语的项显示截断评语文本；每项新增「编辑评语」按钮，点开内联 Textarea（默认折叠），保存走 `useWebElementContexts` 新增的 `updateContext(id, { comment })`。历史消息行（`ConversationRowView` 复用同一 chip）自动获得评语只读展示，零改动。

**理由**：需求明文要求「事后可修改」，chip 编辑不可省；主入口并入浮条而非锚定在元素正下方的独立 Popover，是因为后者需要 guest 视口坐标→renderer 坐标换算（受 guest zoom、外层 transform 影响，`UnifiedBrowserView.tsx:467-469` 已证明 zoom 补偿是真实存在的坑），而浮条已承载确认动作，确认→输入→继续的动线集中在一个控件内；用户澄清中「滑轨浮条正下方」同为认可位置。两处编辑共用同一保存语义（身份合并 / `updateContext`），无平行实现。

### 4.5 负载与序列化契约：markdown 扩展 `Comment:` 行 + 条件 directive（不改 JSON）

**结论**：
1. `WebElementContextPayload` 增加可选 `comment?: string`；`isWebElementContextPayload` 增加 optional string 校验。
2. `buildWebElementContextMarkdown`：在 `Tag:` 行之后 `appendOptionalLine(lines, "Comment", comment)`。**评语在保存前规范化**：trim、全部空白（含换行）折叠为单空格、截断至 2000 字符（`WEB_ELEMENT_COMMENT_MAX_CHARS = 2000`）——保证单行，不可能伪造 `## Element N` 行首或 fenced 边界。
3. 块头：当且仅当存在非空 comment 时，在 `# Web page elements:` 之后插入固定英文 directive 常量（对齐 PPTX 的固定常量风格）：
   `Each element below may carry a "Comment" line. Treat every non-empty comment as the user's instruction for that element, process all of them, and never apply one element's comment to another.`
   （directive 是 build-only：解析时它位于首个 `## Element` 之前，会被既有的 split+filter(null) 自然丢弃，无需解析逻辑。）
4. `parseElementItem`：新增 `comment: readField(headerPart, "Comment") || undefined`，其中 `headerPart = rawItem.split("\n```")[0]`——只在首个 fenced 块之前读取，避免页面正文中恰好出现行首 `Comment:` 的文本被误当评语（对旧格式天然兼容：无该行 → undefined）。
5. `composerPromptContexts.ts` 的四类尾块固定顺序与反序解析**零改动**（web 块内部扩展不影响块级顺序）。

**理由**：现有尾块已是逐字段 markdown（人类可读、模型友好），加一行是增量；旧会话历史消息（无 comment、无 directive）解析路径不变；**旧版本代码解析新消息**也只表现为忽略 Comment 行，不破坏。否决改 JSON 尾块：需要像 PPTX 那样维护新旧双 pattern（`PPTX_ELEMENT_LEGACY_BLOCK_PATTERN` 先例），并把既有 markdown 字段全部迁移，diff 与回归面远大于收益。

### 4.6 顺手修（并入本设计，作为独立小任务）

1. `UnifiedBrowserView.tsx:405-416` 给 hook 传 `labels`（读 `browser.elementPicker.popover.background/color/font` 三键），页内信息卡随语言。
2. `useWebElementPicker.ts:16-19` 注释更正：传输走 `executeJavaScript` 注入而非 main IPC。
3. 去重改按元素身份（§8）后，`SelectionSideChatPane` 与主 pane 双监听同 workspace 的双份累积缺陷被顺带化解（两份 payload 身份相同 → 合并为一条）。

### 4.7 测试策略：见 §11（纯函数单测为主 + fake-executeJs 状态机单测 + CDP E2E）

---

## 5. 交互流程与状态机

### 5.1 renderer 侧（useWebElementPicker 会话状态机）

```
                 startPicking()                pick()→{clicked,chain}         confirm/Enter→{selected}
  ┌────┐  ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
  │idle│→│active·hover           │→│active·adjust          │→│active·comment         │
  └────┘  │浮条:提示+已选N+完成    │  │浮条:面包屑+滑轨+      │  │浮条:Textarea+加入/跳过 │
   ↑      │页内:蓝框悬停+信息卡    │  │重选/确认+完成         │  │(元素已dispatch,chip可见)│
   │      └──────────┬────────────┘  │页内:绿框+`tr th`标签  │  └───────────┬───────────┘
   │                 │pick()→cancelled│(滑轨实时联动)          │            │saveComment→再dispatch
   │      ┌──────────┴────────────┐└───────────┬────────────┘  │  ┌────────┴──────────┐
   │      │active·adjust→repick   │←─requestRepick/Esc(adjust)─┘  │skipComment        │
   │      │=回active·hover        │   beginAdjust()→{repick}        │(两者都回 hover,   │
   │      └───────────────────────┘                                │ 自动再 pick())    │
   └──────── 任意阶段: 完成按钮 / 工具栏再点 / 卸载 / executeJs reject → cancelPicking() ────────┘
```

- Esc 语义分层：comment 输入框内 Esc = 弃草稿（IME 组合态直接放行）；adjust 阶段页内 Esc / 浮条「重选」= `repick`（回 hover，不退出会话）；hover 阶段页内 Esc = 退出会话。hook 既有 window 级 Esc 兜底监听需**排除源自浮条内部的事件**（`event.target` 位于浮条容器内则跳过，由浮条自行处理）。
- 「完成」退出会话但保留已 dispatch 的元素（chip 留在 composer）。

### 5.2 页内（注入脚本阶段状态机）

```
注入(一次/会话) ─→ created ─pick()─→ hovering ─click(拦截)─→ adjusting ─confirm()/Enter─→ (resolve selected) ─┐
                      ↑                │ mousemove→蓝框        │ 冻结 hover 监听            ↑pick() 重挂      │ 会话继续:renderer
                      │                │ Esc→resolve cancelled │ 预计算祖先链(≤24,排除body/html)                  │ 再调 pick()
                      │                └───────────────────────│ showAncestor(n): 幂等重定位绿框+标签            │
                      │                                        │ Esc/requestRepick→resolve repick ────────────────┘
                      └─cancel(): 任意阶段 resolve pending 为 cancelled + cleanup(移除监听/overlay/句柄)
```

- `settled` 一次性守卫改为**每 promise 一份**（pick/beginAdjust 各自守卫），`cancel()` 负责清空全部 pending。
- 与现行为的兼容：注入即 auto-`pick()`，工具栏「取消」仍走 cancel 小脚本（既有 `buildCancelWebElementPickerScript` 无需改协议，仅句柄方法增多）。

---

## 6. 数据流：滑轨驱动的 executeJavaScript 调用序列

以「选 2 个元素、第一个带评语」为例（★ = 新增调用）：

```
renderer(hook)                         guest 页面(window.__zcodeWebElementPicker)
─────────────                          ─────────────────────────────────────────
startPicking()
 ├─ executeJavaScript(整脚本)  ───────→  创建实例; auto pick(); 挂 mousemove/click/keydown
 │                                        (hover: 蓝框+信息卡)
 │  ←────────── resolve {clicked, chain:[th,tr,tbody,table,div,…]}   (click 被拦截, hover 监听卸下)
 ├─ setState(phase=adjust)               冻结绿框; 页内标签=buildAncestorLabel(chain,0)
 │
 ├─ ★executeJavaScript(showAncestor(3)) →→  重定位绿框到 chain[3]; 标签=`div table`
 │    (滑轨 onChange, rAF 节流; 返回 {level,label} 仅是可选的页内诊断返回，面包屑以本地夹取为准)
 │
 ├─ ★executeJavaScript(beginAdjust()) ─→  进入 adjusting; 挂 Enter/Esc 等待确认
 ├─ ★executeJavaScript(confirm())   ───→  collectElement(chain[level]) → resolve {selected, element}
 │  ←────────── resolve {selected, element}
 ├─ dispatch add事件(无评语) ──→ composer chip 出现该元素
 ├─ setState(phase=comment)
 ├─ saveComment("表头文案要改") 
 │   └─ dispatch add事件({...payload, comment}) ──→ chip 内该条原位更新评语(身份合并)
 ├─ ★executeJavaScript(pick()) ───────→  重挂 hover 监听; 下一元素…
 │  ←────────── resolve {clicked, chain} / {cancelled}
 …
用户点「完成」→ cancelPicking() → ★cancel 小脚本(既有形态) → 页内 cleanup → idle
```

要点：
1. **顺序不变量**：`beginAdjust()` 必须在 `confirm()`/`requestRepick()` 之前发起（确认动作才有 promise 可 resolve）；`showAncestor` 只在 adjusting 期间有效，其它阶段返回 `null`（防御式小脚本：句柄不存在/阶段不符一律返回 null，不 reject）。
2. **每个时刻至多一条 pending 的页内 promise**（pick 与 beginAdjust 不重叠），`executeJavaScript` 的返回值语义 = 当前阶段的结果。
3. **错误收敛**：任一 `executeJavaScript` reject（导航、guest 销毁、实例丢失）→ 捕获后按 `cancelled` 收敛（debug 日志、会话归 idle），不上错误横幅；仅**首次注入失败**保留现有 `elementPickerFailed` 横幅行为。
4. 评语保存**不回页面**：renderer 持有 `lastSelected` 负载，补 comment 后重走 add 事件。

---

## 7. 负载与序列化契约（含旧格式兼容）

### 7.1 类型

```ts
// webElementContext.ts
export const WEB_ELEMENT_COMMENT_MAX_CHARS = 2000;

export interface WebElementContextPayload {
  // …既有字段不变…
  comment?: string;              // 新增：已规范化(trim/单行/≤2000)
}

// webElementPickerScript.ts（注入脚本 resolve 的链元数据，仅 renderer 消费）
export interface WebElementAncestorStep {
  level: number;      // 0 = 被点元素
  tagName: string;    // 小写
  id?: string;
  classNames?: string[];  // 前 2 个，面包屑消歧用
  label: string;      // buildAncestorLabel 用的短标签（tag / tag#id / tag.c1）
}
```

### 7.2 序列化样例

新格式（有评语时）：

```markdown
# Web page elements:

Each element below may carry a "Comment" line. Treat every non-empty comment as the user's instruction for that element, process all of them, and never apply one element's comment to another.

## Element 1

URL: https://example.com/table
Title: Example
Tag: th
Comment: 表头文案要改为「季度」，并与左列对齐
Role: columnheader
Selector: tr > th:nth-of-type(2)
…（其余字段与现状完全一致）
```

- 旧格式（历史消息）= 同上但无 directive 行、无 Comment 行 → 新解析器 `readField(headerPart,"Comment")` 得空 → `comment: undefined`。
- 旧版本代码读新格式：忽略未知行，元素仍可完整解析（降级仅丢评语）。

### 7.3 兼容性矩阵

| 生成方 → 解析方 | 旧代码 | 新代码 |
| --- | --- | --- |
| 旧格式消息（存量历史） | 现状 | 兼容（comment=undefined） |
| 新格式消息 | 兼容（忽略 Comment/directive） | 完整 |

---

## 8. 去重语义（composer 侧）

- **身份键**（新纯函数，对齐 `addPptxElementReference` 的 `\0` 连接风格）：

```ts
export function getWebElementContextDedupeKey(payload: {
  pageUrl: string; selector?: string; xpath?: string; tagName: string;
}): string {
  return [payload.pageUrl, payload.selector ?? payload.xpath ?? `#${payload.tagName}`].join("\0");
}
```

  selector 含 `:nth-of-type` 消歧，同页同位置元素碰撞概率低；selector 缺失时逐级退化到 xpath、tagName。

- **合并规则**（新纯函数 `mergeWebElementContextAttachment(items, attachment)`，替代 `useWebElementContexts.handleAdd` 内联的按 uuid 匹配）：
  - 身份未命中 → 追加（id 沿用 `toComposerAttachment` 生成的 uuid）。
  - 身份命中 → **替换元素数据但保留旧 id**（id 稳定保证 removeContext 不失效），comment 取**传入非空 ? 传入 : 保留旧值**。
- 由此：同一元素重拾取 = 更新采集数据；拾取后补/改评语 = 身份命中原位更新；双 pane 同 workspace 双监听 = 两个相同身份的 payload 合并为一条（缺陷③化解）。
- 评语上限/规范化在**写入点**（浮条保存、chip 编辑保存）统一执行，纯函数不重复校验。

---

## 9. 组件与文件级改动清单

| # | 文件（packages/ui 除注明外） | 改动 |
| --- | --- | --- |
| 1 | `src/lib/webElementPickerScript.ts` | 核心改造：阶段状态机（hovering/adjusting）；句柄 API（pick/beginAdjust/showAncestor/confirm/requestRepick/cancel）；click 时预计算祖先链（`computeAncestorChain`，排除 body/html、上限 24）；adjust 绿框样式 + scroll/resize 重定位；页内标签渲染 `buildAncestorLabel`；`buildWebElementPickerScript` 组装改为「helper 源码位置实参注入」（§11.2；P0 修复：按名字前置声明在压缩产物里会 ReferenceError）；新增 `buildWebElementPickerCommandScript(method, …args)` 句柄小脚本工厂（防御式，取消脚本沿用）；导出 `WebElementAncestorStep` 类型 |
| 2 | `src/hooks/useWebElementPicker.ts` | 会话循环状态机（idle/hover/adjust/comment）；`session` 状态与动作（setLevel[rAF 节流]/confirmSelection/requestRepick/saveComment/skipComment）；循环内错误按 cancelled 收敛（仅首次注入失败上横幅）；window Esc 兜底排除浮条内事件；修正 L16-19 注释（顺手修②） |
| 3 | `src/browser-use/WebElementPickerBar.tsx` **（新）** | 浮条：hover 提示/面包屑+滑轨+重选/确认+完成；comment 展开 Textarea（IME 组合态保护、Esc 弃草稿、跳过/加入）；全部 data-testid；受控组件，无自有业务状态（草稿除外） |
| 4 | `src/browser-use/UnifiedBrowserView.tsx` | 根容器加 `relative`；挂载 `WebElementPickerBar`（isPicking 时）；透传 labels（顺手修①）；`handleTogglePicker` 不变 |
| 5 | `src/lib/webElementContext.ts` | `comment` 字段 + 校验 + 规范化常量；`Comment:` 行与条件 directive 构建；`headerPart` 硬化解析；`getWebElementContextDedupeKey` + `mergeWebElementContextAttachment` 纯函数 |
| 6 | `src/v4/composer/useWebElementContexts.ts` | handleAdd 改走 `mergeWebElementContextAttachment`；新增 `updateContext(id, {comment})` |
| 7 | `src/v4/composer/WebElementContextAttachmentChip.tsx` | 列表项评语展示（截断）；「编辑评语」按钮 + 内联 Textarea（折叠态）；Esc=取消编辑；回调 `onEditComment?: (id, comment) => void` |
| 8 | `src/v4/ConversationComposer.tsx` | chip 传 `onEditComment`（接 `updateContext`）；序列化路径零改动（1309-1314 已透传 contexts） |
| 9 | `packages/shared/src/test-ids.ts` | 新增 §10.2 的浏览器拾取段与 chip 评语段 testid |
| 10 | `src/i18n/locales/zh-CN.ts` / `en-US.ts` | §10.1 新键，两 locale 成对；`browser.elementPicker.*` 段与 `chat.webElements.*` 段就近插入 |
| 11 | `packages/ui/test/webElementContext.test.ts` **（新）** | §11.1 契约测试 |
| 12 | `packages/ui/test/webElementPickerScript.test.ts` **（新）** | §11.2 纯函数 + 组装测试 |
| 13 | `packages/ui/test/useWebElementPicker.test.ts` **（新）** | §11.3 状态机测试 |

不改动：`EmbeddedBrowserPaneParts.tsx`（按钮行为已兼容）、`composerPromptContexts.ts`（块级顺序不变）、`ConversationRowView.tsx`（复用 chip 自动获得评语展示）、`packages/shared/src/channels.ts` 与 desktop preload（明确不动）。

---

## 10. i18n 与 test-ids 清单

### 10.1 i18n 新键（zh-CN / en-US 成对）

`browser.elementPicker.*` 段（插在 `popover.font` 之后）：

| 键 | zh-CN | en-US |
| --- | --- | --- |
| `browser.elementPicker.bar.hint` | 点击页面中的元素 | Click an element in the page |
| `browser.elementPicker.bar.adjustHint` | 拖动滑轨调整层级 | Drag the slider to adjust level |
| `browser.elementPicker.bar.sliderLabel` | 祖先层级 | Ancestor level |
| `browser.elementPicker.bar.repick` | 重选 | Repick |
| `browser.elementPicker.bar.confirm` | 确认 | Confirm |
| `browser.elementPicker.bar.done` | 完成 | Done |
| `browser.elementPicker.bar.selectedCount` | 已选 {count} 个元素 | {count} elements selected |
| `browser.elementPicker.bar.chainTruncated` | 祖先链已截断 | Ancestor chain truncated |
| `browser.elementPicker.comment.placeholder` | 输入对该元素的评语或问题（可选） | Add a comment or question for this element (optional) |
| `browser.elementPicker.comment.add` | 加入对话 | Add to chat |
| `browser.elementPicker.comment.skip` | 跳过 | Skip |

`chat.webElements.*` 段（插在 `remove` 之后）：

| 键 | zh-CN | en-US |
| --- | --- | --- |
| `chat.webElements.comment` | 评语 | Comment |
| `chat.webElements.editComment` | 编辑评语 | Edit comment |
| `chat.webElements.saveComment` | 保存 | Save |
| `chat.webElements.cancelComment` | 取消 | Cancel |

（键名以实现时为准，中英成对与段落前缀子树键集相等由既有 i18n 测试约束；批量插入若用脚本，锚必须 assert 且 locale 键行首锚定。）

### 10.2 test-ids（packages/shared/src/test-ids.ts 浏览器段与 composer 段）

| 常量 | 值 |
| --- | --- |
| `TID_BROWSER_ELEMENT_PICKER_BAR` | `browser-element-picker-bar` |
| `TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER` | `browser-element-picker-level-slider` |
| `TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB` | `browser-element-picker-level-breadcrumb` |
| `TID_BROWSER_ELEMENT_PICKER_CONFIRM_BUTTON` | `browser-element-picker-confirm-button` |
| `TID_BROWSER_ELEMENT_PICKER_REPICK_BUTTON` | `browser-element-picker-repick-button` |
| `TID_BROWSER_ELEMENT_PICKER_DONE_BUTTON` | `browser-element-picker-done-button` |
| `TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT` | `browser-element-picker-comment-input` |
| `TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON` | `browser-element-picker-comment-add-button` |
| `TID_BROWSER_ELEMENT_PICKER_COMMENT_SKIP_BUTTON` | `browser-element-picker-comment-skip-button` |
| `TID_WEB_ELEMENT_CHIP_COMMENT_EDIT` | `web-element-chip-comment-edit`（动态后缀 `-${id}`，沿用 zoom-option 动态后缀惯例） |
| `TID_WEB_ELEMENT_CHIP_COMMENT_INPUT` | `web-element-chip-comment-input` |

---

## 11. 测试计划

运行方式（仓库既定）：`pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/<file>.test.ts`。

### 11.1 契约层（webElementContext.test.ts）

- build/parse 往返：无评语（旧格式输出）、有评语、多元素（`## Element N` 序号与顺序）、评语含 `## Element`/反引号/`Comment:` 字样（规范化后单行，不破坏分割与 fenced 读取）、评语超长截断、含换行折叠。
- directive 注入条件：全空评语不出现、任一非空即出现；directive 不被解析成元素。
- 旧格式消息解析：无 Comment/directive → `comment: undefined`，其余字段不变。
- `headerPart` 硬化：fenced Text 内含行首 `Comment: xxx` 不误读。
- 序列化在四类尾块中的位置不变（复用/参照 composerPromptContexts 混排一轮，验证反序解析仍成立）。
- `mergeWebElementContextAttachment`：身份命中替换保 id、comment 空保留旧值、未命中追加；`getWebElementContextDedupeKey` 的 selector/xpath/tagName 退化链。

### 11.2 注入脚本层（webElementPickerScript.test.ts）

- **纯函数直测**（祖先链从脚本文件抽为模块级导出、运行时零依赖的纯函数，见下）：`computeAncestorChain`（伪节点树：排除 body/html、深度 24 截断、单节点链、被点元素即 body）；`buildAncestorLabel`（`tr th`、`tag#id`、根档位单段、链长 1）。
- **自包含组装**：`buildWebElementPickerScript()` 产物断言——helper 源码落在实参位置（结构冒烟）；`buildWebElementPickerCommandScript("showAncestor", 3)` 产物断言（防御式：无句柄时安全返回 null）。
- 抽取方式：helper（`computeAncestorChain`/`buildAncestorLabel` 等）定义为**同文件模块级纯函数**（仅依赖入参结构，不 import 运行时值）；组装从 `(${fn.toString()})(${opts})` 改为 **helper 走位置实参注入**：

```ts
return [
  "(function(){",
  `return (${webElementPickerScriptImpl.toString()})(${JSON.stringify(resolvedOptions)}, ${computeAncestorChainImpl.toString()}, ${buildAncestorLabelImpl.toString()});`,
  "})()",
].join("\n");
```

  主函数以**形参**引用 helper，函数体不引用任何模块作用域绑定。修正记录（P0）：原「helper 源码按名字前置声明 + 主函数体内裸引用」在压缩构建下断裂——打包器重命名模块绑定后 `toString()` 拿到的是改名后的函数体（如 `Pe(W)`），而注入体里只有字面量名字，页面执行 `ReferenceError`，发布产物拾取整体失效；位置实参在模板里求值，压缩器无从改名。注入函数仍是单函数自包含，`max-lines` 例外注释保留并更新说明。
- **生产打包形态回归**：用 esbuild 压缩模块源码 → `node:vm` 取出 builder → 压缩产物 → 以最小 `window`/`document`/`Element` 桩执行，驱动 mousemove+click 与 `showAncestor`，断言无 `ReferenceError` 且链、层级标签正确（源码形态全绿、压缩形态曾红）。harness 压缩模块源码，而不是直接跑 tsx 产出的函数文本：tsx 打开 esbuild `keepNames`，会给函数体注入模块作用域的 `__name` helper（渲染进程的 Vite/rolldown 链路不开该开关），那属于测试运行器形态、不是发布形态。
- 不做的事：不为测试把脚本拆成多文件模块（破坏注入自包含）；不引 headless DOM 依赖；不放宽对自由标识符的检查（`node:vm` 里只有页内真实存在的全局）。

### 11.3 hook 状态机（useWebElementPicker.test.ts）

- fake `executeJs`：记录调用序列、按脚本内容（方法名/参数）匹配并编程化 resolve，驱动：
  hover→clicked→showAncestor 序列（含 rAF 节流合并）→confirm→selected→dispatch（断言 CustomEvent detail，含无评语首派与带评语补派）→自动 pick()→cancelled 收敛；
  repick 回环；cancelPicking 的 cancel 小脚本；runId 防串（中途 start 新会话，旧 resolve 被忽略）；executeJs reject → 会话静默收敛。
- 直接 `node:test` 里渲染 hook 或抽状态机为可独立驱动的纯 reducer + 薄 hook 壳（实现取舍留给 implementer，接口不变）。

### 11.4 E2E（CDP，`.agents/tools/cdp/cdp.mjs`，data-testid 驱动；交互改动按 AGENTS.md 必须）

1. 工具栏启动拾取 → 浮条出现（hover 提示）→ 点击页面元素 → 浮条切滑轨态、页内绿框（断言浮条面包屑文本）。
2. 滑轨拖至第 2 档 → 面包屑/确认 → 评语框出现 → 输入中文评语（含 IME 路径冒烟）→ 加入对话。
3. 连选第二个元素并跳过评语 → 完成 → composer 出现含 2 条的 chip、第一条显示评语。
4. chip 内修改第一条评语 → 发送 → 消息尾块含 Comment 行与 directive；历史行回显评语。
5. 回归：Esc 各阶段语义（adjust Esc 回 hover、hover Esc 退出）；同一元素重选 → chip 仍为一条且评语按合并规则更新；旧会话（升级前消息）正常渲染。

---

## 12. 风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `toString()` 组装受构建器压缩/改名影响（P0 已实测复现：压缩后主函数体引用被改名，发布产物 ReferenceError） | 中 | helper 走位置实参注入（模板内求值，压缩器无从改名）；§11.2 压缩形态 vm 回归测试（esbuild 压缩模块 + 产物整段压缩后执行）；E2E 场景 1 兜底 |
| 会话中页面导航/刷新导致 pending promise reject 或实例丢失 | 中 | §6 要点 3：统一按 cancelled 收敛 + debug 日志；runId 防串沿用 |
| 深DOM/浮层站点（自定义元素嵌套）链超 24 或滑轨档位过多 | 低 | 上限 24 + 截断指示；档位=链长的天然映射，不额外压缩 |
| selector 身份键碰撞（同页结构完全相同的兄弟且无 nth-of-type 消歧） | 低 | `getSelector` 已带 nth-of-type；碰撞后果=合并为一条，可重选找回；文档化 |
| 浮条遮挡视口底部内容 | 低 | 绝对定位不引发布局偏移；仅拾取会话期间显示 |
| 人类 tab 与 agent browser-use tab 双表面行为变化 | 可接受 | 行为一致（既定边界结论），E2E 主表面覆盖即可 |
| 评语进入 markdown 尾块的 prompt 注入面 | 低 | 单行折叠 + 2000 上限；与现有 text/htmlExcerpt 同级暴露，无新增执行路径 |
| 旧版本读新消息丢评语 | 接受 | 降级行为，见 §7.3 矩阵 |

**回滚粒度**：任务 T1/T2（契约与消费层）是向后兼容增量，可独立合入而不启用新交互；T3-T5 是行为切换点（拾取流程变化），revert 该组即完全回到现行为；无数据迁移（comment 仅存在于消息文本与内存态）。

---

## 13. 实施任务拆分（供 task-planner 转任务图）

```
T1 契约层（webElementContext.ts + 测试）──────────┐
                                                ├─→ T4 hook 会话循环 + 测试 ─→ T5 浮条 UI + UnifiedBrowserView 接线
T2 注入脚本（webElementPickerScript.ts + 测试）──┘        （含 labels 顺手修、注释更正、i18n/testids）
                                                              └─→ T6 E2E（CDP）
T3 composer 消费层（useWebElementContexts + chip + ConversationComposer + chat.webElements.* 键 + 测试）
        依赖 T1；与 T2 完全并行；先于或并行于 T4-T5 均可（chip 评语编辑不依赖拾取新流程）
```

- **依赖**：T1→{T3, T4}；T2→T4；T4→T5；T5→T6；T3 可与 {T2, T4, T5} 并行（自身仅依赖 T1）。
- **可并行组**：G1={T1}；G2={T2, T3}；G3={T4}；G4={T5+i18n/testids}；G5={T6}。
- 每任务测试先行（AGENTS.md）；T5 完成后须跑 `pnpm typecheck`、`pnpm lint`、i18n 键成对测试。

---

## 14. 假设与遗留问题

- **假设**：`<webview>.executeJavaScript` 对返回 Promise 的代码会等待其落定（现注入脚本即以 Promise 为返回值运行，行为已被现功能证实）。
- **假设**：滑轨拖动的 rAF 节流足以覆盖 executeJavaScript 往返开销（每档一次轻量调用；若实测卡顿，备选为浮条本地先更新 UI、脚本返回值校准——不改变契约）。
- **假设**：`ConversationRowView` 复用的 chip 在无回调时呈只读态，评语仅展示（依据：现 chip 的 onRemove/onRemoveAll 均可选）。
- **遗留（不阻塞）**：跨 iframe/shadow DOM 的祖先上溯、页内信息卡视觉重设计、评语富文本——均为非目标，留待后续需求。
