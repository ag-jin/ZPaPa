import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAncestorLabel,
  buildWebElementPickerCommandScript,
  buildWebElementPickerScript,
  computeAncestorChain,
  type WebElementAncestorNodeLike,
  type WebElementAncestorStep,
} from "../src/lib/webElementPickerScript.js";

/* 注入脚本层（设计 §4.2 / §5.2 / §11.2）在 UI 面的用例：
   1. 祖先链与层级标签是纯函数，单独直测（伪节点树，不需要 DOM）；
   2. 组装产物必须是自包含 JS（helper 前置声明 + 主函数调用），句柄小脚本防御式。
   页内阶段状态机（hovering/adjusting 与句柄动作）靠组装的执行契约 + T6 E2E 覆盖。 */

interface FakeNode extends WebElementAncestorNodeLike {
  tagName: string;
  id?: string;
  classList?: string[];
  parentElement: FakeNode | null;
}

function makeNode(
  tagName: string,
  options: { id?: string; classNames?: string[]; parent?: FakeNode | null } = {},
): FakeNode {
  return {
    tagName,
    ...(options.id ? { id: options.id } : {}),
    ...(options.classNames ? { classList: options.classNames } : {}),
    parentElement: options.parent ?? null,
  };
}

test("祖先链：从被点元素上溯，body/html 不进入链", () => {
  const html = makeNode("html");
  const body = makeNode("body", { parent: html });
  const section = makeNode("section", { parent: body });
  const table = makeNode("table", { parent: section });
  const tbody = makeNode("tbody", { parent: table });
  const tr = makeNode("tr", { parent: tbody });
  const th = makeNode("th", { parent: tr });

  const { chain, truncated } = computeAncestorChain(th);

  assert.deepEqual(
    chain.map((step) => [step.level, step.tagName]),
    [
      [0, "th"],
      [1, "tr"],
      [2, "tbody"],
      [3, "table"],
      [4, "section"],
    ],
    "档位 0 = 被点元素，向上到 body 之前封顶",
  );
  assert.equal(truncated, false, "链在 body 处自然结束，不算截断");
});

test("祖先链：超过 24 档按上限截断并标记 truncated", () => {
  // 由 body 向下逐层包 div：最后一个才是最深/被点的元素。
  const body = makeNode("body", { parent: makeNode("html") });
  let deepest = body;
  for (let index = 0; index < 30; index += 1) {
    deepest = makeNode("div", { parent: deepest });
  }

  const { chain, truncated } = computeAncestorChain(deepest);

  assert.equal(chain.length, 24, "深度上限 24（防御病态深 DOM）");
  assert.equal(chain[0]?.tagName, "div");
  assert.equal(chain[23]?.tagName, "div");
  assert.equal(truncated, true, "上限之外仍有祖先 ⇒ 面包屑尾部要显示截断指示");
});

test("祖先链：恰好 24 档且其上就是 body 时不算截断", () => {
  const body = makeNode("body", { parent: makeNode("html") });
  let deepest = body;
  for (let index = 0; index < 24; index += 1) {
    deepest = makeNode("div", { parent: deepest });
  }

  const { chain, truncated } = computeAncestorChain(deepest);

  assert.equal(chain.length, 24);
  assert.equal(truncated, false, "排掉 body 之后链已完整，不能误报截断");
});

test("祖先链：单节点链与被点元素即 body 的退化情形", () => {
  const standalone = makeNode("article");
  assert.deepEqual(
    computeAncestorChain(standalone).chain.map((step) => step.tagName),
    ["article"],
  );
  assert.equal(computeAncestorChain(standalone).truncated, false);

  const body = makeNode("body", { parent: makeNode("html") });
  assert.deepEqual(
    computeAncestorChain(body).chain.map((step) => step.tagName),
    ["body"],
    "被点元素即 body 时链长 1，行为退化为仅确认/重选",
  );

  assert.deepEqual(computeAncestorChain(null), { chain: [], truncated: false });
});

test("祖先链：每档带 id / 类名短标签，最多取前两个类名", () => {
  const body = makeNode("body");
  const section = makeNode("section", { id: "page", parent: body });
  const div = makeNode("div", {
    classNames: ["card", "wide", "ignored"],
    parent: section,
  });

  const { chain } = computeAncestorChain(div);

  assert.deepEqual(chain[0], {
    level: 0,
    tagName: "div",
    classNames: ["card", "wide"],
    label: "div.card",
  });
  assert.deepEqual(chain[1], {
    level: 1,
    tagName: "section",
    id: "page",
    label: "section#page",
  });
  assert.equal(chain.length, 2, "body 不进链，链在 section 处终止");
});

test("层级标签：至多两段（父 子），根档位单段", () => {
  const chain: WebElementAncestorStep[] = [
    { level: 0, tagName: "th", label: "th" },
    { level: 1, tagName: "tr", label: "tr" },
    { level: 2, tagName: "table", label: "table#grid" },
  ];

  assert.equal(buildAncestorLabel(chain, 0), "tr th", "页内展示形如 `tr th` 的选择器");
  assert.equal(buildAncestorLabel(chain, 1), "table#grid tr");
  assert.equal(buildAncestorLabel(chain, 2), "table#grid", "根档位只显示自身");
  assert.equal(buildAncestorLabel(chain, 9), "", "越界档位不得抛错");
  assert.equal(buildAncestorLabel([], 0), "");
  assert.equal(
    buildAncestorLabel([{ level: 0, tagName: "div", label: "div" }], 0),
    "div",
    "链长 1 时单段",
  );
});

test("组装：helper 前置声明 + 主函数裸引用，产物是自包含 JS", () => {
  const script = buildWebElementPickerScript();
  const occurrencesOf = (needle: string) => script.split(needle).length - 1;

  assert.ok(script.startsWith("(function () {"), "外层 IIFE 承载 helper 前置声明");
  assert.ok(
    script.includes("const __zcodeWepComputeAncestorChain = function computeAncestorChain("),
    "祖先链 helper 必须以源码文本前置声明（跨文件 helper 在页面上下文里解析不到）",
  );
  assert.ok(
    script.includes("const __zcodeWepBuildAncestorLabel = function buildAncestorLabel("),
    "层级标签 helper 必须以源码文本前置声明",
  );
  assert.ok(
    occurrencesOf("__zcodeWepComputeAncestorChain") >= 2 &&
      occurrencesOf("__zcodeWepBuildAncestorLabel") >= 2,
    "两个 helper 除前置声明外都必须有裸引用调用点（否则前缀声明是死代码，祖先链恒空）",
  );
  assert.ok(script.endsWith(")()"), "主函数调用必须收尾在 IIFE 内");
  assert.doesNotThrow(() => {
    // 只编译不执行：注入脚本在 renderer 侧拼字符串，语法错误只有到页面里才会炸。
    new Function(script);
  });
});

test("命令脚本：句柄缺失时安全返回 null，句柄存在时按方法名转发参数", () => {
  const script = buildWebElementPickerCommandScript("showAncestor", 3);
  // 组装产物是表达式，包一层 return 才能拿到 IIFE 的求值结果。
  const evaluate = new Function("window", `return ${script};`) as (target: unknown) => unknown;

  assert.equal(
    evaluate({}),
    null,
    "页面已导航/实例已销毁时必须返回 null，不能抛错让 renderer 卡住",
  );

  const received: unknown[] = [];
  const result = evaluate({
    __zcodeWebElementPicker: {
      showAncestor: (level: number) => {
        received.push(level);
        return { level, label: "tr th" };
      },
    },
  });

  assert.deepEqual(received, [3]);
  assert.deepEqual(result, { level: 3, label: "tr th" });

  assert.equal(
    evaluate({ __zcodeWebElementPicker: { pick: "not-a-function" } }),
    null,
    "方法存在但不是函数时也走防御分支",
  );
});
