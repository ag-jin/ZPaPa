import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_LABEL_MAX_COUNT,
  WORK_ITEM_LABEL_MAX_LENGTH,
  WORK_ITEM_STATUS_KEYS,
  parseWorkItemLabels,
  workItemLabelsErrorMessage,
} from "../src/work-item.js";

/* 标签归一化（#11 v1）**独立穷举复验**（test-verifier，2026-10-07）。

   与 `workItemLabels.test.ts` 的分工：那份是实现轮的用例；本份是**独立夹具**，
   期望值全部来自拆解报告的 v1 标签契约（`2026-10-07-metadata-lanes-pagination-breakdown.md`
   §3.4）而不是实现：
   · 切分符 = `,` 与换行 → `trim` → 丢空串 → 去重（首现为准、大小写敏感、不折叠）；
   · 上限：条数 ≤ 10、单条长度 ≤ 32（按 **trim 之后**的值判定）；超限**响亮**，不得静默截断；
   · 计数发生在**去重之后**；两种超限同时命中时结论确定（同一输入永远同一结论）。

   独立性说明：本文件不复用实现里的任何中间量（不调用内部工具、不按实现的分支顺序推导期望），
   期望值逐条手写在断言里；边界（0/1/恰好上限/超限一位）两侧都写。 */

type OkKind = "ok" | "too_many" | "too_long";

const kindOf = (raw: readonly string[]): OkKind => parseWorkItemLabels(raw).kind;
const labelsOf = (raw: readonly string[]): string[] => {
  const result = parseWorkItemLabels(raw);
  assert.equal(result.kind, "ok", `期望 ok，实际 ${result.kind}（输入 ${JSON.stringify(raw)}）`);
  return result.kind === "ok" ? result.labels : [];
};

// ---------- ① 分隔符 ----------

test("穷举｜分隔符：逗号与 \\n 是分隔符；\\r\\n（CRLF）与 \\r\\n 混排也切对", () => {
  assert.deepEqual(labelsOf(["a,b"]), ["a", "b"]);
  assert.deepEqual(labelsOf(["a\nb"]), ["a", "b"]);
  assert.deepEqual(labelsOf(["a,b\nc"]), ["a", "b", "c"]);
  // CRLF：`\r` 不是分隔符，但它是**空白** ⇒ trim 阶段被吃掉（结果与 LF 相同）。
  assert.deepEqual(labelsOf(["a\r\nb"]), ["a", "b"]);
  assert.deepEqual(labelsOf(["a\r\n\r\nb"]), ["a", "b"], "空行不产生空标签");
});

test("穷举｜分隔符：连续 / 首尾分隔符不产生空标签", () => {
  assert.deepEqual(labelsOf([",a,,b,"]), ["a", "b"]);
  assert.deepEqual(labelsOf(["\na\n\nb\n"]), ["a", "b"]);
  assert.deepEqual(labelsOf([",\n,\n"]), []);
  assert.deepEqual(labelsOf([","]), []);
});

test("穷举｜边界（非契约）：全角逗号「，」/ 顿号 / 制表符 / 分号**不是**分隔符", () => {
  // 契约只写 `,` 与换行。这里把「实际行为」钉住，避免日后有人以为它们在解析里被处理：
  // 全角逗号是中文输入法下的常见输入 —— 它现在会变成**标签内容的一部分**（见复验报告的观察项）。
  assert.deepEqual(labelsOf(["前端，紧急"]), ["前端，紧急"]);
  assert.deepEqual(labelsOf(["前端、紧急"]), ["前端、紧急"]);
  assert.deepEqual(labelsOf(["a\tb"]), ["a\tb"], "制表符在中间：不是分隔符（只在两端被 trim 掉）");
  assert.deepEqual(labelsOf(["a;b"]), ["a;b"]);
});

test("穷举｜分隔符（非契约）：单独的 \\r（旧 Mac 行尾）不是分隔符", () => {
  // 只按 `\n` 切：单独 `\r` 留在标签内容里。钉住现状（把「只有 \\n 是换行」这件事说清）。
  assert.deepEqual(labelsOf(["a\rb"]), ["a\rb"]);
});

// ---------- ② trim / 空串 ----------

test("穷举｜trim：两端空白（空格 / 制表符 / 换行 / 全角空格 / NBSP）剥掉，内部原样保留", () => {
  assert.deepEqual(labelsOf(["  a  "]), ["a"]);
  assert.deepEqual(labelsOf(["\ta\t"]), ["a"]);
  assert.deepEqual(labelsOf(["\n a \n"]), ["a"]);
  assert.deepEqual(labelsOf(["　a　"]), ["a"], "全角空格（U+3000）在 trim 的空白集里");
  assert.deepEqual(labelsOf(["\u00a0a\u00a0"]), ["a"], "NBSP（U+00A0）也在空白集里");
  assert.deepEqual(labelsOf(["前端 团队"]), ["前端 团队"], "内部空格是标签内容，不得吞掉");
  assert.deepEqual(labelsOf(["a  b  c"]), ["a  b  c"], "连续内部空格同样保留");
});

test("穷举｜空串：空输入 / 全是空白 / 只有分隔符 ⇒ ok 且 labels 为空数组", () => {
  assert.deepEqual(parseWorkItemLabels([]), { kind: "ok", labels: [] });
  assert.deepEqual(parseWorkItemLabels([""]), { kind: "ok", labels: [] });
  assert.deepEqual(parseWorkItemLabels(["", "", ""]), { kind: "ok", labels: [] });
  assert.deepEqual(parseWorkItemLabels(["   ", "\t", "\n", "　"]), { kind: "ok", labels: [] });
});

// ---------- ③ 去重与序 ----------

test("穷举｜去重保序：首次出现为准，输出次序 = 书写次序（不排序、不折叠大小写）", () => {
  assert.deepEqual(labelsOf(["b,a,c,b,a"]), ["b", "a", "c"]);
  assert.deepEqual(labelsOf(["c", "a", "b"]), ["c", "a", "b"], "多段输入按段与段内顺序拼接");
  assert.deepEqual(
    labelsOf(["Bug,bug,BUG, bug "]),
    ["Bug", "bug", "BUG"],
    "大小写敏感：三个都留（trim 后的 bug 与 Bug/BUG 不同）",
  );
  assert.deepEqual(labelsOf([" 同名 ", "同名", "同名"]), ["同名"], "trim 之后同值才算重复");
  assert.deepEqual(labelsOf(["x,y", "z,x"]), ["x", "y", "z"], "跨段去重（重的那份不占位）");
});

test("穷举｜计数时机：去重发生在计数**之后**的额度判定之前 —— 重复输入不占额度", () => {
  // 20 段原文去重后只有 10 个 ⇒ 恰好到顶，必须收下（若按原始条数计数会误报 too_many）。
  const doubled = Array.from({ length: 10 }, (_, index) => `t${index},t${index}`);
  assert.deepEqual(
    labelsOf(doubled),
    Array.from({ length: 10 }, (_, index) => `t${index}`),
  );

  // 11 个不同值 + 若干重复 ⇒ 仍去重后 11 个 ⇒ 响亮报 too_many（重复不救场）。
  const eleven = [...Array.from({ length: 11 }, (_, index) => `t${index}`), "t0", "t1"];
  const tooMany = parseWorkItemLabels(eleven);
  assert.equal(tooMany.kind, "too_many");
  assert.equal(tooMany.kind === "too_many" ? tooMany.count : -1, 11, "count = 去重后的条数（11）");
});

// ---------- ④ 上限两侧（条数 / 长度）× 组合 ----------

test("穷举｜条数上限两侧：0 / 1 / 9 / 恰好 10 收下，11 响亮 too_many（值域原样）", () => {
  assert.equal(WORK_ITEM_LABEL_MAX_COUNT, 10, "契约常量：条数上限 10");
  for (const count of [0, 1, 9, 10]) {
    const labels = Array.from({ length: count }, (_, index) => `t${index}`);
    assert.equal(kindOf(labels), "ok", `${count} 条必须收下`);
    if (count > 0) assert.equal(labelsOf(labels).length, count);
  }
  const result = parseWorkItemLabels(Array.from({ length: 11 }, (_, index) => `t${index}`));
  assert.equal(result.kind, "too_many");
  assert.deepEqual(
    result,
    { kind: "too_many", max: 10, count: 11 },
    "结论要带足信息：给了几条、上限几条（界面据此说出「11 / 10」）",
  );
});

test("穷举｜单条长度上限两侧：31 / 恰好 32 收下，33 响亮 too_long 且回传的是那条标签", () => {
  assert.equal(WORK_ITEM_LABEL_MAX_LENGTH, 32, "契约常量：单条长度上限 32");
  assert.equal(kindOf(["x".repeat(31)]), "ok");
  assert.equal(kindOf(["x".repeat(32)]), "ok", "恰好 32 是**收下**的一侧");
  const result = parseWorkItemLabels(["ok", "x".repeat(33)]);
  assert.equal(result.kind, "too_long");
  assert.deepEqual(
    result,
    { kind: "too_long", max: 32, value: "x".repeat(33) },
    "回传**那条**超长标签的原文（界面据此点名，而不是只说「有东西超了」）",
  );
});

test("穷举｜长度按 trim **之后**的值判定：32 字符外带空白 ⇒ 收下；33 字符 ⇒ too_long", () => {
  assert.equal(kindOf([`  ${"y".repeat(32)}  `]), "ok", "空白不算长度（trim 是解析的一部分）");
  const result = parseWorkItemLabels([`\t${"y".repeat(33)}\n`]);
  assert.equal(result.kind, "too_long");
  assert.equal(
    result.kind === "too_long" ? result.value : "",
    "y".repeat(33),
    "回传的 value 是 trim 之后的值（用户能对着找）",
  );
});

test("穷举｜长度按 UTF-16 码元计（契约说「字符」）：CJK 一字一码元、emoji 一图两码元", () => {
  // 中文（主用例）：32 个汉字收下、33 个超限。
  assert.equal(kindOf(["汉".repeat(32)]), "ok");
  assert.equal(kindOf(["汉".repeat(33)]), "too_long");
  // emoji：一个 emoji 占两个码元 ⇒ 16 个 = 32 码元收下、17 个 = 34 码元超限。
  // 这是**计量口径的边界事实**（不是缺陷判定）：报告里作为观察项登记。
  assert.equal(kindOf(["🚀".repeat(16)]), "ok");
  assert.equal(kindOf(["🚀".repeat(17)]), "too_long");
});

test("穷举｜两种超限同时命中：结论确定且 too_many 优先（同一份输入永远同一结论）", () => {
  const elevenWithLong = [...Array.from({ length: 10 }, (_, index) => `t${index}`), "z".repeat(40)];
  const first = parseWorkItemLabels(elevenWithLong);
  assert.deepEqual(first, { kind: "too_many", max: 10, count: 11 }, "条数与长度同时超 ⇒ 报条数");
  assert.deepEqual(
    parseWorkItemLabels([...elevenWithLong]),
    first,
    "同一份输入重复调用结论逐字相同（不留状态、不随机）",
  );

  // 条数没超、长度超 ⇒ 报长度（顺序相反的一格）。
  const tenWithLong = [...Array.from({ length: 9 }, (_, index) => `t${index}`), "z".repeat(40)];
  const second = parseWorkItemLabels(tenWithLong);
  assert.equal(second.kind, "too_long");
  assert.equal(second.kind === "too_long" ? second.value : "", "z".repeat(40));
});

test("穷举｜去重把「超长 + 重复」也去重掉：重复的超长标签只算一条（结论仍是 too_long）", () => {
  const long = "z".repeat(33);
  assert.equal(parseWorkItemLabels([long, ` ${long} `]).kind, "too_long");
  assert.deepEqual(
    parseWorkItemLabels([long, ` ${long} `]),
    { kind: "too_long", max: 32, value: long },
    "去重后只剩一条超长标签",
  );
});

// ---------- ⑤ 纯函数纪律 ----------

test("穷举｜纯函数：不改写入参、结果与调用历史无关、两次调用逐字相等", () => {
  const input = [" a , b ", "a", ""];
  const snapshot = [...input];
  const first = parseWorkItemLabels(input);
  assert.deepEqual(input, snapshot, "入参数组不得被就地改写");
  const second = parseWorkItemLabels(input);
  assert.deepEqual(second, first, "无内部状态：两次调用逐字相等");
  assert.notEqual(
    second.kind === "ok" ? second.labels : null,
    first.kind === "ok" ? first.labels : null,
    "每次返回新数组（调用方改结果不得影响下一次）",
  );
  if (first.kind === "ok") {
    first.labels.push("污染");
    assert.deepEqual(
      parseWorkItemLabels(input),
      { kind: "ok", labels: ["a", "b"] },
      "改写上一次的结果不影响后续调用",
    );
  }
});

test("穷举｜入参形状：readonly 数组可传、一段整给与多段分别给是同一判据", () => {
  const asOneChunk = labelsOf(["a, b\nc"]);
  const asChunks = labelsOf(["a, b", "c"]);
  const asLines = labelsOf(["a", "b", "c"]);
  assert.deepEqual(asOneChunk, ["a", "b", "c"]);
  assert.deepEqual(asChunks, asOneChunk, "切分发生在**所有**段上：分段给与整段给同结论");
  assert.deepEqual(asLines, asOneChunk, "表单按行给与整段给同结论（一个判据）");
});

// ---------- ⑥ 错误文案（共享单源） ----------

test("穷举｜错误文案：两种超限各说清「哪条上限 / 差多少」，且互不相同、稳定可复现", () => {
  const tooMany = workItemLabelsErrorMessage({ kind: "too_many", max: 10, count: 12 });
  const tooLong = workItemLabelsErrorMessage({ kind: "too_long", max: 32, value: "z".repeat(33) });
  assert.ok(tooMany.includes("10"), "条数文案要带上上限");
  assert.ok(tooMany.includes("12"), "条数文案要带上实际条数");
  assert.ok(tooLong.includes("32"), "长度文案要带上上限");
  assert.ok(tooLong.includes("z".repeat(33)), "长度文案要点名那条标签");
  assert.notEqual(tooMany, tooLong, "两种超限不得共用一句话（用户要能分辨该改哪里）");
  assert.equal(
    tooMany,
    workItemLabelsErrorMessage({ kind: "too_many", max: 10, count: 12 }),
    "文案稳定",
  );
});

// ---------- ⑦ 与既有状态键零耦合 ----------

test("零耦合｜状态键词表未被改动：仍是那 6 个键、同一顺序（标签特性不碰状态词汇表）", () => {
  assert.deepEqual(
    [...WORK_ITEM_STATUS_KEYS],
    ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"],
  );
});

test("零耦合｜标签是开放字符串：状态键名可以当标签用，归一化不校验、不折算、不改写", () => {
  const statusLike = [...WORK_ITEM_STATUS_KEYS, "done", "TODO"];
  const result = parseWorkItemLabels(statusLike);
  assert.equal(result.kind, "ok");
  assert.deepEqual(
    result.kind === "ok" ? result.labels : [],
    ["todo", "in_progress", "in_review", "blocked", "done", "cancelled", "TODO"],
    "状态键名与 todo/TODO 都只是普通标签文本（去重按字面、大小写敏感）—— 标签不是状态的第二套词汇",
  );
});
