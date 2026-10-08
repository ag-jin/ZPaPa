import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* 拾取浮条（用户实测反馈后的形态）的**结构守卫**：ui 包没有渲染设施（既有做法，
   见 squadTimelineRender.test.ts 说明），所以浮条这个交互面拆成三半验证：
   ① 会话状态机与派发语义在 useWebElementPicker.test.ts（fake executeJs 驱动）；
   ② 层级/评语/按钮的**在场与接线**在源码守卫（本文件）；
   ③ 文案在 browserElementReviewI18n.test.ts（两语键集相等 + 逐条文案）。
   每条守卫都写明变异方式（改哪一处会让它红）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

const BAR = "browser-use/WebElementPickerBar.tsx";
/** 组件体（去掉 import 段）：出现次数类断言必须按这里数，否则 import 的常量名也会被数进去。 */
const readBarBody = () => {
  const source = readSource(BAR);
  const bodyStart = source.indexOf("export function WebElementPickerBar");
  assert.ok(bodyStart > 0, "浮条组件必须具名导出（守卫按它裁组件体）");
  return source.slice(bodyStart);
};

test("守卫｜调整阶段：一行紧凑层级指示（当前档位短标签 + 层位），不再有多行祖先链", () => {
  const bar = readSource(BAR);

  assert.ok(
    bar.includes("TID_BROWSER_ELEMENT_PICKER_LEVEL_BREADCRUMB"),
    "层级指示仍挂既有 testid（E2E 按它读当前层级）",
  );
  assert.ok(
    bar.includes("session.chain[level]?.label"),
    "指示里的元素标签必须取**当前档位**（chain[level].label，如 input#email）；变异：改回遍历整条链即红",
  );
  assert.ok(
    bar.includes('id: "browser.elementPicker.bar.levelIndicator"'),
    "层位（第 n / total 层）走新键 levelIndicator；变异：写死数字或复用 chainTruncated 即红",
  );
  assert.equal(
    bar.includes("ChevronRightIcon"),
    false,
    "多行祖先链的「A › B › C」箭头外观必须消失；变异：把链式分隔符加回来即红",
  );
  assert.equal(
    /breadcrumb/.test(bar),
    false,
    "祖先链列表的派生数据（breadcrumb 数组）不该留在浮条里；变异：恢复列表渲染即红",
  );
});

test("守卫｜评语框常驻调整阶段且紧跟滑轨，唯一确认 = 「加入对话」一次提交", () => {
  const bar = readSource(BAR);
  const body = readBarBody();

  assert.equal(
    bar.includes('phase === "comment"'),
    false,
    "会话状态机已合并 comment 阶段，浮条不得再分支到该阶段；变异：恢复第二阶段即红",
  );
  const adjustStart = body.indexOf('session.phase === "adjust" ? (');
  const sliderAt = body.indexOf("TID_BROWSER_ELEMENT_PICKER_LEVEL_SLIDER", adjustStart);
  const commentAt = body.indexOf("TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT", adjustStart);
  const addAt = body.indexOf("TID_BROWSER_ELEMENT_PICKER_COMMENT_ADD_BUTTON", adjustStart);
  assert.ok(adjustStart >= 0 && sliderAt > adjustStart, "滑轨挂在调整阶段");
  assert.ok(
    commentAt > sliderAt,
    "评语框必须在滑轨**正下方**（同一调整阶段内、源码顺序在滑轨之后）；变异：把 Textarea 挪回第二阶段即红",
  );
  assert.ok(addAt > commentAt, "「加入对话」按钮在评语框下方（提交的是框里的草稿）");
  assert.ok(
    bar.includes("onClick={() => onAddComment(comment)}"),
    "唯一确认 = 把当前层级元素与草稿评语一次提交；变异：拆成两个按钮或只提交元素即红",
  );
  assert.equal(
    bar.includes("TID_BROWSER_ELEMENT_PICKER_COMMENT_SKIP_BUTTON"),
    false,
    "「跳过」按钮已删除（空评语就是直接点「加入对话」）；变异：加回跳过即红",
  );
  assert.equal(
    bar.includes("TID_BROWSER_ELEMENT_PICKER_CONFIRM_BUTTON"),
    false,
    "独立的「确认」按钮已删除（唯一确认是「加入对话」）；变异：加回确认即红",
  );
});

test("守卫｜Esc 分层：输入框内只清草稿（IME 放行），调整阶段重选，hover 退出会话", () => {
  const bar = readSource(BAR);
  const keyHandler = bar.slice(
    bar.indexOf("const handleKeyDown"),
    bar.indexOf("const chainLength"),
  );
  assert.ok(keyHandler.length > 0, "Esc 处理必须在浮条内（页内处理页内事件，浮条处理浮条事件）");
  assert.ok(
    keyHandler.includes("isImeComposingKeyEvent"),
    "IME 组合态下 Esc 是取消候选词，必须放行；变异：删掉组合态判据即红",
  );
  assert.ok(
    keyHandler.includes("TID_BROWSER_ELEMENT_PICKER_COMMENT_INPUT"),
    "Esc 分支必须按「事件是否来自评语框」分层；变异：只看阶段不看到源即红",
  );

  const inputBranch = keyHandler.slice(0, keyHandler.indexOf("onRepick"));
  assert.ok(
    inputBranch.includes('setComment("")'),
    "评语框内 Esc = 仅清草稿；变异：删掉清空调用即红",
  );
  assert.equal(
    /on(?:Cancel|Repick|AddComment)\(/u.test(inputBranch),
    false,
    "评语框内 Esc 不得退出会话、重选或提交；变异：改成 onRepick/onCancel 即红",
  );

  const rest = keyHandler.slice(keyHandler.indexOf("onRepick"));
  assert.ok(
    rest.includes("onRepick()") && rest.includes("onCancel()"),
    "调整阶段 Esc = 重选、hover 阶段 Esc = 取消（退出会话）；变异：两者对调即红",
  );
});

test("守卫｜「取消」按钮在两态都在场，且所有按钮都显式 type=button", () => {
  const body = readBarBody();
  const cancelUses = body.match(/TID_BROWSER_ELEMENT_PICKER_CANCEL_BUTTON/gu) ?? [];
  assert.equal(
    cancelUses.length,
    2,
    "hover 与调整阶段各有一个「取消」（终止会话、保留已加入的元素）；变异：删掉任一即红",
  );
  assert.equal(
    (body.match(/onClick=\{onCancel\}/gu) ?? []).length,
    2,
    "两个取消按钮都接同一个 onCancel；变异：接成 onRepick/onAddComment 即红",
  );
  assert.equal(
    (body.match(/<Button/gu) ?? []).length,
    (body.match(/type="button"/gu) ?? []).length,
    "每个 Button 都必须显式 type=button（浮条可能被渲染在表单上下文里）",
  );
});

test("守卫｜评语草稿按「本轮链」清空：换元素或离开调整阶段都不带着上一条评语", () => {
  const bar = readSource(BAR);
  assert.ok(
    /useEffect\(\(\) => \{[^}]*setComment\(""\)/su.test(bar),
    "草稿重置必须在 effect 里（不是渲染期 setState）；变异：删掉重置即红",
  );
  assert.ok(
    bar.includes('session.phase === "adjust" ? session.chain : null'),
    "重置令牌取「当前轮的链」：档位变化不换令牌（草稿保留）、换元素或退出调整阶段就换；变异：只按 phase 判定会在同一阶段内把草稿清掉，按 pickedCount 判定会让同元素重选串味",
  );
});

test("守卫｜接线：浮条只做受控转发，不再有 saveComment/skipComment 两条动作通路", () => {
  const bar = readSource(BAR);
  assert.equal(
    bar.includes("saveComment") || bar.includes("skipComment"),
    false,
    "两段式评语动作已删除（会话里只有一次提交）；变异：加回任一条即红",
  );
  assert.ok(bar.includes("onAddComment"), "评语随「加入对话」一次提交");
  assert.ok(bar.includes("onSetLevel") && bar.includes("onRepick") && bar.includes("onCancel"));
});

test("守卫｜hook：confirmSelection 携带评语，saveComment/skipComment 从对外接口消失", () => {
  const hook = readSource("hooks/useWebElementPicker.ts");
  assert.equal(
    hook.includes("saveComment") || hook.includes("skipComment"),
    false,
    "对外接口收缩后只剩一次提交；变异：把任一动作加回 hook 即红",
  );
  assert.ok(
    hook.includes("driver.confirmSelection(comment)"),
    "confirmSelection 把草稿评语透传给会话循环（唯一提交入口）；变异：丢掉参数即红",
  );
  assert.equal(
    hook.includes('phase === "comment"'),
    false,
    "窗口级 Esc 兜底不再有评语阶段分支；变异：恢复即红",
  );
  assert.ok(
    hook.includes('phase === "adjust"'),
    "调整阶段的窗口 Esc 兜底 = 重选（焦点在浮条外时也一致）",
  );
});

test("守卫｜UnifiedBrowserView：浮条出入参同步，取消 = cancelPicking（保留已加入的元素）", () => {
  const view = readSource("browser-use/UnifiedBrowserView.tsx");
  assert.ok(
    view.includes("onAddComment={confirmWebElementSelection}"),
    "唯一确认接会话循环的 confirmSelection；变异：接回旧的 onConfirm/onSaveComment 即红",
  );
  assert.ok(
    view.includes("onCancel={handleWebElementPickerCancel}") &&
      view.includes("void cancelWebElementPicking();"),
    "「取消」终止会话但不动已加入的 chip；变异：接成清空上下文即红",
  );
  assert.equal(
    /saveWebElementComment|skipWebElementComment|handleWebElementPickerDone/u.test(view),
    false,
    "两段式评语与「完成」措辞都已随交互合并删除；变异：留一个引用即红",
  );
});
