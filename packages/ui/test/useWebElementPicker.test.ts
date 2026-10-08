import assert from "node:assert/strict";
import test from "node:test";
import { createWebElementPickerSessionDriver } from "../src/lib/webElementPickerSession.js";
import type { WebElementContextPayload } from "../src/lib/webElementContext.js";
import type { WebElementAncestorStep } from "../src/lib/webElementPickerScript.js";

/* 拾取会话循环（设计 §5.1 / §6 / §11.3）在 UI 面的用例：以 fake `executeJs` 驱动状态机，
   断言调用序列、阶段切换、payload 派发与错误收敛。

   断言口径说明：payload 走**默认出口**（`window` CustomEvent，与真实链路一致），
   在模块作用域替换一个只记录事件的 window 替身；页面侧的 executeJavaScript 结果由
   responder 按「命令方法名」编程化 resolve，因此不依赖真实 webview。 */

const dispatched: Array<{ type: string; detail: WebElementContextPayload }> = [];
(globalThis as { window?: unknown }).window = {
  dispatchEvent: (event: Event) => {
    const detail = (event as CustomEvent<WebElementContextPayload>).detail;
    dispatched.push({ type: event.type, detail });
    return true;
  },
} as unknown as Window;

const ADD_EVENT = "zcode:web-element-context-add-to-chat";
/** 元素负载由页内脚本采集；测试给一份最小可用形状。 */
const ELEMENT_PAYLOAD: Omit<WebElementContextPayload, "workspacePath"> = {
  pageUrl: "https://example.com/table",
  pageTitle: "Example",
  tagName: "th",
  selector: "tr > th:nth-of-type(2)",
  accessibleName: "季度",
  capturedAt: 1_700_000_000_000,
};

const CHAIN: WebElementAncestorStep[] = [
  { level: 0, tagName: "th", label: "th" },
  { level: 1, tagName: "tr", label: "tr" },
  { level: 2, tagName: "table", label: "table#grid" },
];

const COMMAND_PATTERN = /return picker\.([A-Za-z]+)\(/u;

/** 命令小脚本 → 方法名；整脚本注入返回 null。 */
function commandMethodOf(script: string): string | null {
  if (!script.includes("const picker = window.__zcodeWebElementPicker")) {
    return null;
  }
  return COMMAND_PATTERN.exec(script)?.[1] ?? null;
}

interface FakeExecuteJs {
  executeJs: (script: string) => Promise<unknown>;
  scripts: string[];
  methods: () => string[];
  setResponder: (responder: (script: string) => unknown) => void;
}

function createFakeExecuteJs(responder: (script: string) => unknown = () => null): FakeExecuteJs {
  const scripts: string[] = [];
  let current = responder;
  return {
    scripts,
    methods: () => scripts.map(commandMethodOf).filter((method): method is string => !!method),
    setResponder: (next) => {
      current = next;
    },
    executeJs: async (script: string) => {
      scripts.push(script);
      return current(script);
    },
  };
}

/** 清空已派发事件，测试之间互不串扰。 */
function resetDispatched() {
  dispatched.length = 0;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createDriver(fake: FakeExecuteJs, sessions: Array<unknown>) {
  return createWebElementPickerSessionDriver({
    getContext: () => ({
      executeJs: fake.executeJs,
      workspacePath: "/workspace/project",
      labels: undefined,
    }),
    onSessionChange: (session) => sessions.push(session),
  });
}

/** 最后一条 session 状态（null 表示会话已结束，未 start 过时为 undefined）。 */
function latestSession(sessions: Array<unknown>) {
  return sessions.length === 0 ? undefined : sessions[sessions.length - 1];
}

test("会话循环：hover → adjust(滑轨) → comment → 再 pick 直到取消", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  let resolveAdjust: ((value: unknown) => void) | null = null;
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      // 整脚本注入：页内实例创建后自动 pick()，首次点击即返回点击结果。
      return { status: "clicked", chain: CHAIN, chainTruncated: false };
    }
    if (method === "beginAdjust") {
      return new Promise((resolve) => {
        resolveAdjust = resolve;
      });
    }
    if (method === "confirm") {
      resolveAdjust?.({ status: "selected", element: ELEMENT_PAYLOAD });
      return null;
    }
    if (method === "showAncestor") {
      return { level: 2, label: "table#grid" };
    }
    if (method === "pick") {
      return { status: "cancelled" };
    }
    return null;
  });

  const driver = createDriver(fake, sessions);
  const started = driver.start();
  assert.equal(
    (latestSession(sessions) as { phase?: string } | null)?.phase,
    "hover",
    "startPicking 后浮条立刻进入 hover 提示态",
  );

  await flush();
  const adjustSession = latestSession(sessions) as {
    phase: string;
    level: number;
    pickedCount: number;
  };
  assert.equal(adjustSession.phase, "adjust");
  assert.equal(adjustSession.level, 0, "进入层级调整时停在档位 0（被点元素）");
  assert.deepEqual(
    fake.methods(),
    ["beginAdjust"],
    "先发 beginAdjust 再让浮条渲染确认按钮（顺序不变量）",
  );

  driver.setLevel(2);
  await flush();
  assert.deepEqual(
    fake.methods(),
    ["beginAdjust", "showAncestor"],
    "滑轨档位通过 showAncestor 小脚本驱动页内绿框",
  );
  const showAncestorScript = fake.scripts.find(
    (script) => commandMethodOf(script) === "showAncestor",
  );
  assert.ok(
    showAncestorScript?.includes("showAncestor(2)"),
    `最新档位必须随脚本下发，实际为：${showAncestorScript ?? "(缺)"}`,
  );

  driver.confirmSelection();
  await flush();
  assert.equal((latestSession(sessions) as { phase?: string }).phase, "comment");
  assert.equal(dispatched.length, 1, "确认后先派发一次无评语元素，chip 立即可见");
  assert.equal(dispatched[0]?.type, ADD_EVENT);
  assert.equal(dispatched[0]?.detail.tagName, "th");
  assert.equal(dispatched[0]?.detail.workspacePath, "/workspace/project");
  assert.equal(dispatched[0]?.detail.comment, undefined);

  driver.skipComment();
  await flush();
  assert.equal(
    fake.methods()[fake.methods().length - 1],
    "pick",
    "跳过评语后自动进入下一个元素的 hover 阶段",
  );

  await started;
  assert.equal(latestSession(sessions), null, "页内取消（Esc）后会话归 idle");
  const afterSkip = sessions[sessions.length - 2] as { phase?: string; pickedCount?: number };
  assert.equal(afterSkip?.phase, "hover", "跳过评语后回到 hover 提示态继续选下一个");
  assert.equal(afterSkip?.pickedCount, 1, "已选元素计数用于浮条提示");
});

test("会话循环：保存评语以同一身份补派发，不重新回页面取数", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  let resolveAdjust: ((value: unknown) => void) | null = null;
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      return { status: "clicked", chain: CHAIN, chainTruncated: false };
    }
    if (method === "beginAdjust") {
      return new Promise((resolve) => {
        resolveAdjust = resolve;
      });
    }
    if (method === "confirm") {
      resolveAdjust?.({ status: "selected", element: ELEMENT_PAYLOAD });
      return null;
    }
    if (method === "pick") {
      return { status: "cancelled" };
    }
    return null;
  });

  const driver = createDriver(fake, sessions);
  const started = driver.start();
  await flush();
  driver.confirmSelection();
  await flush();

  resetDispatched();
  driver.saveComment("  表头文案要改\n成「季度」  ");
  await flush();

  assert.equal(dispatched.length, 1, "保存评语补派发一次同身份元素");
  assert.equal(dispatched[0]?.detail.comment, "表头文案要改 成「季度」", "评语在写入点规范化");
  assert.equal(dispatched[0]?.detail.selector, ELEMENT_PAYLOAD.selector, "身份字段原样保留");
  assert.equal(
    fake.methods().includes("showAncestor"),
    false,
    "补评语不回页面取数，只重走 add 事件",
  );

  driver.skipComment();
  await started;
  assert.equal(latestSession(sessions), null);
});

test("会话循环：重选（repick）回到 hover 并重新 pick", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  let resolveAdjust: ((value: unknown) => void) | null = null;
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      return { status: "clicked", chain: CHAIN, chainTruncated: true };
    }
    if (method === "beginAdjust") {
      return new Promise((resolve) => {
        resolveAdjust = resolve;
      });
    }
    if (method === "requestRepick") {
      resolveAdjust?.({ status: "repick" });
      return null;
    }
    if (method === "pick") {
      return { status: "cancelled" };
    }
    return null;
  });

  const driver = createDriver(fake, sessions);
  const started = driver.start();
  await flush();
  assert.equal((latestSession(sessions) as { chainTruncated?: boolean }).chainTruncated, true);

  driver.requestRepick();
  await flush();

  const afterRepick = sessions[sessions.length - 2] as { phase: string; chain: unknown[] };
  assert.equal(afterRepick?.phase, "hover", "重选回到 hover 提示态");
  assert.deepEqual(afterRepick?.chain, [], "重选后清空旧祖先链");
  assert.equal(
    fake.methods().filter((method) => method === "pick").length,
    1,
    "repick 后重新 pick 下一个元素",
  );

  await started;
  assert.equal(latestSession(sessions), null);
});

test("会话循环：runId 防串——旧会话的在途结果不覆盖新会话", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  const injectionResolvers: Array<(value: unknown) => void> = [];
  let resolveAdjust: ((value: unknown) => void) | null = null;
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      return new Promise((resolve) => {
        injectionResolvers.push(resolve);
      });
    }
    if (method === "beginAdjust") {
      // 停在 adjust 阶段，便于观察新会话是否被推进到这里。
      return new Promise((resolve) => {
        resolveAdjust = resolve;
      });
    }
    if (method === "cancel") {
      // 页内 cancel 会清空全部 pending：模拟它把挂起的 beginAdjust 收敛为取消。
      resolveAdjust?.({ status: "cancelled" });
      return null;
    }
    return null;
  });

  const driver = createDriver(fake, sessions);
  const firstRun = driver.start();
  await flush();
  const secondRun = driver.start();
  await flush();
  assert.equal(injectionResolvers.length, 2, "第二次 start 重新注入整脚本");

  // 旧会话的点击结果此刻才落定：必须被丢弃。
  injectionResolvers[0]?.({ status: "clicked", chain: CHAIN, chainTruncated: false });
  await flush();
  assert.equal(
    (latestSession(sessions) as { phase?: string }).phase,
    "hover",
    "旧会话的点击结果不得把新会话推进到 adjust",
  );
  assert.equal(fake.methods().includes("beginAdjust"), false);

  // 新会话正常推进。
  injectionResolvers[1]?.({ status: "clicked", chain: CHAIN, chainTruncated: false });
  await flush();
  assert.equal((latestSession(sessions) as { phase?: string }).phase, "adjust");
  await firstRun;

  await driver.cancel();
  assert.equal(latestSession(sessions), null);
  assert.equal(fake.methods().includes("cancel"), true, "取消走句柄 cancel 小脚本");
  await secondRun;
});

test("会话循环：阶段失败按取消静默收敛，首段注入失败才冒泡", async () => {
  const sessions: Array<unknown> = [];
  const failing = createFakeExecuteJs(() => {
    throw new Error("guest navigated away");
  });
  const driver = createDriver(failing, sessions);

  await assert.rejects(
    driver.start(),
    /guest navigated away/u,
    "首段注入失败必须冒泡（renderer 用它上错误横幅）",
  );
  assert.equal(latestSession(sessions), null);

  const midLoop = createFakeExecuteJs();
  const sessionsAgain: Array<unknown> = [];
  let resolveAdjust: ((value: unknown) => void) | null = null;
  midLoop.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      return { status: "clicked", chain: CHAIN, chainTruncated: false };
    }
    if (method === "beginAdjust") {
      return new Promise((resolve) => {
        resolveAdjust = resolve;
      });
    }
    if (method === "confirm") {
      resolveAdjust?.({ status: "selected", element: ELEMENT_PAYLOAD });
      return null;
    }
    if (method === "pick") {
      throw new Error("guest destroyed");
    }
    return null;
  });

  const driverAgain = createDriver(midLoop, sessionsAgain);
  const started = driverAgain.start();
  await flush();
  driverAgain.confirmSelection();
  await flush();
  driverAgain.skipComment();

  await assert.doesNotReject(started, "循环内失败不得冒泡成错误横幅");
  assert.equal(latestSession(sessionsAgain), null, "循环内失败静默收敛回 idle");
});

test("会话循环：同一帧内的滑轨拖动合并成一次 showAncestor", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null) {
      return { status: "clicked", chain: CHAIN, chainTruncated: false };
    }
    if (method === "beginAdjust") {
      return new Promise(() => {});
    }
    return null;
  });

  const globalWithFrames = globalThis as { requestAnimationFrame?: unknown };
  const originalRaf = globalWithFrames.requestAnimationFrame;
  const frames: Array<() => void> = [];
  globalWithFrames.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(() => callback(0));
    return frames.length;
  };

  try {
    const driver = createDriver(fake, sessions);
    void driver.start();
    await flush();

    driver.setLevel(1);
    driver.setLevel(2);
    driver.setLevel(3);
    assert.equal(frames.length, 1, "一帧内多次拖动只排一次页内调用");
    assert.equal(
      fake.methods().includes("showAncestor"),
      false,
      "帧未到之前不下发（节流窗口内只保留最后一次档位）",
    );

    frames.shift()?.();
    await flush();
    const showAncestorScripts = fake.scripts.filter(
      (script) => commandMethodOf(script) === "showAncestor",
    );
    assert.equal(showAncestorScripts.length, 1, "同一帧的中间档位被合并掉");
    assert.ok(
      showAncestorScripts[0]?.includes("showAncestor(2)"),
      `只下发最后一档并按链长夹住越界档位，实际为：${showAncestorScripts[0] ?? "(缺)"}`,
    );
    assert.equal(
      (latestSession(sessions) as { level?: number }).level,
      2,
      "浮条档位本地先跟手更新（同样夹在链内）",
    );
  } finally {
    globalWithFrames.requestAnimationFrame = originalRaf;
  }
});

test("会话循环：多余动作不改状态（幂等守卫）", async () => {
  const fake = createFakeExecuteJs(() => null);
  const sessions: Array<unknown> = [];
  const driver = createDriver(fake, sessions);

  driver.setLevel(3);
  driver.confirmSelection();
  driver.requestRepick();
  driver.saveComment("x");
  driver.skipComment();
  await flush();

  assert.deepEqual(fake.methods(), [], "未开始会话时任何动作都不应下发脚本");
  assert.deepEqual(sessions, [], "未开始会话时不产生状态变更");
});
