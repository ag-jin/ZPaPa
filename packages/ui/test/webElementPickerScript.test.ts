import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
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
   2. 组装产物必须是自包含 JS（helper 走位置实参注入），句柄小脚本防御式；
   3. 生产打包形态（模块经压缩改名）下产物仍能在页内执行，见下方 vm 用例。
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

/* 生产打包形态（模块经压缩改名）。注入脚本是 renderer 侧拼出来的字符串，破坏发生在打包之后：
   打包器会重命名模块作用域绑定，`toString()` 拿到的是改名后的函数体；组装若靠「名字」声明 helper，
   主函数体内引用的就是被改名的标识符，页面执行即 ReferenceError——只在压缩过的产物里坏，源码测试全绿。
   这里用仓库自带 esbuild 复现该形态：压缩模块源码 → vm 里取出 builder → 压缩产物 → node:vm 执行。 */

const PICKER_STATE_KEY = "__zcodeWebElementPicker";

/** 页内元素桩：祖先链 helper 只读 tagName/id/classList/parentElement，浮窗只读几何与样式。 */
class PickerElementStub {
  tagName: string;
  style: Record<string, string> = {};
  textContent = "";
  id = "";
  classList: string[] = [];
  parentElement: PickerElementStub | null = null;
  offsetWidth = 0;
  offsetHeight = 0;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  getBoundingClientRect() {
    return { bottom: 40, height: 32, left: 4, right: 124, top: 8, width: 120, x: 4, y: 8 };
  }

  append() {}

  replaceChildren() {}

  contains() {
    return false;
  }

  setAttribute() {}

  removeAttribute() {}

  remove() {}

  closest() {
    return null;
  }
}

/** 最小 window/document 桩，并暴露按类型触发已注册监听的手段（页内状态靠事件驱动）。 */
function createPickerPage() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const record = (type: string, listener: unknown) => {
    if (typeof listener !== "function") {
      return;
    }
    const handlers = listeners.get(type) ?? [];
    handlers.push(listener as (event: unknown) => void);
    listeners.set(type, handlers);
  };
  const documentStub = {
    documentElement: new PickerElementStub("html"),
    title: "Example",
    addEventListener: record,
    removeEventListener: () => {},
    createElement: (tagName: string) => new PickerElementStub(tagName),
    getElementById: () => null,
  };
  const windowStub: Record<string, unknown> = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: record,
    removeEventListener: () => {},
    getComputedStyle: () => ({
      backgroundColor: "rgb(255, 255, 255)",
      color: "rgb(17, 24, 39)",
      display: "block",
      fontFamily: "Inter",
      fontSize: "14px",
      fontWeight: "400",
    }),
  };

  return {
    sandbox: {
      Element: PickerElementStub,
      document: documentStub,
      window: windowStub,
    } as Record<string, unknown>,
    element(
      tagName: string,
      options: { classNames?: string[]; id?: string; parent?: PickerElementStub } = {},
    ) {
      const element = new PickerElementStub(tagName);
      if (options.id) {
        element.id = options.id;
      }
      if (options.classNames) {
        element.classList = options.classNames;
      }
      if (options.parent) {
        element.parentElement = options.parent;
      }
      return element;
    },
    fire(type: string, event: unknown) {
      const handlers = listeners.get(type) ?? [];
      assert.ok(handlers.length > 0, `页内脚本必须已注册 ${type} 监听`);
      for (const handler of handlers) {
        handler(event);
      }
    },
    handle() {
      return windowStub[PICKER_STATE_KEY] as
        | { cancel: () => void; showAncestor: (level: number) => unknown }
        | undefined;
    },
  };
}

/** 取「生产压缩形态」的模块导出：真实 renderer 打包会重命名模块作用域绑定，这里同样压缩后再取 builder。 */
function loadMinifiedPickerModule(options: { keepNames?: boolean } = {}) {
  const source = readFileSync(
    new URL("../src/lib/webElementPickerScript.ts", import.meta.url),
    "utf8",
  );
  const { code } = transformSync(source, {
    format: "cjs",
    loader: "ts",
    minify: true,
    // 注入函数体经 `toString()` 变成源码文本，压缩器贴的模块作用域 helper（__name）会一起被带进页面。
    keepNames: options.keepNames === true,
  });
  const moduleStub = { exports: {} as Record<string, unknown> };
  runInContext(code, createContext({ exports: moduleStub.exports, module: moduleStub }));
  return moduleStub.exports as {
    buildWebElementPickerScript: (options?: Record<string, unknown>) => string;
  };
}

/** 压缩形态产物在最小 window/document/Element 桩上驱动一次拾取：注入 → mousemove + click。 */
async function injectAndPick(options: {
  keepNames?: boolean;
  scriptOptions?: Record<string, unknown>;
}) {
  const { buildWebElementPickerScript: buildMinifiedScript } = loadMinifiedPickerModule(options);
  const page = createPickerPage();
  const html = page.element("html");
  const body = page.element("body", { parent: html });
  const table = page.element("table", { id: "grid", parent: body });
  const row = page.element("tr", { parent: table });
  const cell = page.element("th", { classNames: ["cell"], parent: row });

  const script = transformSync(buildMinifiedScript(options.scriptOptions ?? {}), {
    minify: true,
  }).code;
  const pickPromise = runInNewContext(script, page.sandbox);
  assert.equal(
    typeof (pickPromise as { then?: unknown } | undefined)?.then,
    "function",
    "注入脚本求值结果必须是 pick() 的 promise（renderer 依赖它等待落定）",
  );

  const handle = page.handle();
  assert.ok(handle, "句柄必须挂在页内状态键上");
  assert.deepEqual(
    Object.keys(handle).sort(),
    ["beginAdjust", "cancel", "confirm", "pick", "requestRepick", "showAncestor"],
    "句柄方法集是 renderer 与页内之间的契约",
  );

  page.fire("mousemove", { target: cell });
  page.fire("click", {
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
    stopPropagation: () => {},
  });

  // 跨 realm 对象原型不同，deepStrictEqual 会误报，断言前先规整成宿主侧普通对象。
  return {
    page,
    handle,
    picked: JSON.parse(JSON.stringify(await pickPromise)) as Record<string, unknown>,
    showAncestor: (level: number) => JSON.parse(JSON.stringify(handle.showAncestor(level))),
  };
}

test("组装：模块压缩改名后产物仍自包含可执行，页内拾取与层级标签可用", async () => {
  const { handle, picked, showAncestor } = await injectAndPick({});

  assert.deepEqual(picked, {
    status: "clicked",
    chain: [
      { level: 0, tagName: "th", classNames: ["cell"], label: "th.cell" },
      { level: 1, tagName: "tr", label: "tr" },
      { level: 2, tagName: "table", id: "grid", label: "table#grid" },
    ],
    chainTruncated: false,
  });
  assert.deepEqual(showAncestor(0), { level: 0, label: "tr th.cell" });
  assert.deepEqual(showAncestor(2), { level: 2, label: "table#grid" });

  handle.cancel();
});

test("组装：模块压缩开启 keepNames 后产物仍自包含可执行（内层函数不得被压缩器改名）", async () => {
  const { handle, picked, showAncestor } = await injectAndPick({ keepNames: true });

  assert.deepEqual(picked, {
    status: "clicked",
    chain: [
      { level: 0, tagName: "th", classNames: ["cell"], label: "th.cell" },
      { level: 1, tagName: "tr", label: "tr" },
      { level: 2, tagName: "table", id: "grid", label: "table#grid" },
    ],
    chainTruncated: false,
  });
  assert.deepEqual(showAncestor(2), { level: 2, label: "table#grid" });

  handle.cancel();
});

test("组装：挂载键是唯一常量，废弃的 stateKey 选项不会让句柄命令失联", async () => {
  const legacyOptions = { stateKey: "__legacyWebElementPicker" };
  const { page, picked } = await injectAndPick({ scriptOptions: legacyOptions });
  assert.equal(picked.status, "clicked", "拾取仍应落到唯一挂载键上的实例");

  const result = runInNewContext(
    buildWebElementPickerCommandScript("showAncestor", 0),
    page.sandbox,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { level: 0, label: "tr th.cell" },
    "命令小脚本必须命中主脚本挂上的实例（键漂移会让所有句柄命令静默 no-op）",
  );
});

test("组装：helper 以位置实参注入，产物是自包含 JS", () => {
  const script = buildWebElementPickerScript();
  const occurrencesOf = (needle: string) => script.split(needle).length - 1;

  assert.ok(script.startsWith("(function () {"), "外层 IIFE 承载注入体");
  assert.ok(
    script.includes(", function computeAncestorChain(") &&
      script.includes(", function buildAncestorLabel("),
    "helper 源码必须落在实参位置：按名字前置声明会被压缩器改名（发布产物里 ReferenceError）",
  );
  assert.equal(
    occurrencesOf("const __zcodeWepComputeAncestorChain") +
      occurrencesOf("const __zcodeWepBuildAncestorLabel"),
    0,
    "不再按名字声明 helper，压缩器无从与主函数体内引用失配",
  );
  assert.ok(
    occurrencesOf("__zcodeWepComputeAncestorChain") >= 2 &&
      occurrencesOf("__zcodeWepBuildAncestorLabel") >= 2,
    "两个 helper 形参必须在主函数签名与函数体内都出现（否则祖先链为空、标签缺失）",
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

  // 命令脚本是纯字符串构造（不注入 helper 源码），压缩形态下同样自包含可执行。
  const minified = transformSync(buildWebElementPickerCommandScript("showAncestor", 3), {
    minify: true,
  }).code;
  assert.equal(
    runInNewContext(minified, {
      window: { __zcodeWebElementPicker: { showAncestor: (level: number) => `level:${level}` } },
    }),
    "level:3",
  );
});
