import assert from "node:assert/strict";
import test from "node:test";
import { createWebElementPickerSessionDriver } from "../src/lib/webElementPickerSession.js";
import type { WebElementContextPayload } from "../src/lib/webElementContext.js";
import type { WebElementAncestorStep } from "../src/lib/webElementPickerScript.js";

/* 拾取会话循环（设计 §5.1 / §6 / §11.3）在 UI 面的用例：以 fake `executeJs` 驱动状态机，
   断言调用序列、阶段切换、payload 派发与错误收敛。

   提交语义（用户实测反馈后收敛）：一次确认 = `confirmSelection(comment)` 一次性派发
   「元素 + 评语」，没有 comment 轮、也没有补派发；空评语就是不带 comment 的同一份派发。

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

/** 会话期间出现过的阶段序列（去掉终结的 null）。 */
function phasesOf(sessions: Array<unknown>) {
  return sessions
    .map((session) => (session as { phase?: string } | null)?.phase)
    .filter((phase): phase is string => typeof phase === "string");
}

test("会话循环：hover → adjust(滑轨) → 加入对话（带评语，单次派发）→ 再 pick 直到取消", async () => {
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
    "先发 beginAdjust 再让浮条渲染加入对话按钮（顺序不变量）",
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

  resetDispatched();
  driver.confirmSelection("  表头文案要改\n成「季度」  ");
  await flush();
  assert.equal(dispatched.length, 1, "「加入对话」= 元素 + 评语一次提交，只派发一次");
  assert.equal(dispatched[0]?.type, ADD_EVENT);
  assert.equal(dispatched[0]?.detail.tagName, "th");
  assert.equal(dispatched[0]?.detail.workspacePath, "/workspace/project");
  assert.equal(
    dispatched[0]?.detail.comment,
    "表头文案要改 成「季度」",
    "评语在写入点规范化后随同一次派发",
  );
  assert.deepEqual(
    fake.methods(),
    ["beginAdjust", "showAncestor", "confirm", "pick"],
    "确认后直接回到 hover 再 pick 下一个（没有中间评语轮）",
  );
  assert.equal(phasesOf(sessions).includes("comment"), false, "会话状态机里不再有 comment 阶段");

  await started;
  assert.equal(latestSession(sessions), null, "页内取消（Esc）后会话归 idle");
  const afterConfirm = sessions[sessions.length - 2] as {
    phase?: string;
    pickedCount?: number;
  };
  assert.equal(afterConfirm?.phase, "hover", "加入对话后回到 hover 提示态继续选下一个");
  assert.equal(afterConfirm?.pickedCount, 1, "已选元素计数用于浮条提示");
});

test("会话循环：评语为空/全空白/未传 → 同一次派发不带 comment", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  const comments: Array<string | undefined> = [undefined, "   ", "\n\t "];
  let round = 0;
  let resolveAdjust: ((value: unknown) => void) | null = null;
  fake.setResponder((script) => {
    const method = commandMethodOf(script);
    if (method === null || method === "pick") {
      return round < comments.length
        ? { status: "clicked", chain: CHAIN, chainTruncated: false }
        : { status: "cancelled" };
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
    return null;
  });

  const driver = createDriver(fake, sessions);
  const started = driver.start();
  await flush();
  for (const comment of comments) {
    round += 1;
    resetDispatched();
    if (comment === undefined) {
      driver.confirmSelection();
    } else {
      driver.confirmSelection(comment);
    }
    await flush();
    assert.equal(dispatched.length, 1, `第 ${round} 轮仍是单次派发`);
    assert.equal(
      "comment" in (dispatched[0]?.detail ?? {}),
      false,
      `空白评语（${JSON.stringify(comment)}）不得写入 comment 字段`,
    );
  }

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
  resetDispatched();

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
  assert.deepEqual(dispatched, [], "重选不派发任何元素");

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
  resetDispatched();
  driverAgain.confirmSelection("评语");
  await flush();

  await assert.doesNotReject(started, "循环内失败不得冒泡成错误横幅");
  assert.equal(latestSession(sessionsAgain), null, "循环内失败静默收敛回 idle");
  assert.equal(dispatched.length, 1, "本轮「加入对话」已派发（失败的是它之后的 pick）");
  assert.equal(dispatched[0]?.detail.comment, "评语", "已提交的元素保留评语，不回滚");
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

test("会话循环：已选计数按元素身份去重（同一元素重选不累加）", async () => {
  const fake = createFakeExecuteJs();
  const sessions: Array<unknown> = [];
  const otherElement: Omit<WebElementContextPayload, "workspacePath"> = {
    ...ELEMENT_PAYLOAD,
    selector: "tr > th:nth-of-type(3)",
    accessibleName: "同比",
  };
  const selections = [ELEMENT_PAYLOAD, ELEMENT_PAYLOAD, otherElement];
  let confirmed = 0;
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
      resolveAdjust?.({ status: "selected", element: selections[confirmed++] ?? ELEMENT_PAYLOAD });
      return null;
    }
    if (method === "pick") {
      return confirmed < selections.length
        ? { status: "clicked", chain: CHAIN, chainTruncated: false }
        : { status: "cancelled" };
    }
    return null;
  });

  const driver = createDriver(fake, sessions);
  const started = driver.start();
  await flush();
  for (let index = 0; index < selections.length; index += 1) {
    driver.confirmSelection();
    await flush();
  }

  await started;
  assert.equal(confirmed, 3, "三次确认都走完（末次 pick 才收敛为取消）");
  const hoverCounts = sessions
    .filter(
      (session): session is { phase: string; pickedCount: number } =>
        (session as { phase?: string } | null)?.phase === "hover",
    )
    .map((session) => session.pickedCount);
  assert.deepEqual(
    hoverCounts,
    [0, 1, 1, 2],
    "同一元素（同 selector 身份）重选后浮条计数不涨，异元素才 +1",
  );
});

test("会话循环：多余动作不改状态（幂等守卫）", async () => {
  const fake = createFakeExecuteJs(() => null);
  const sessions: Array<unknown> = [];
  const driver = createDriver(fake, sessions);

  driver.setLevel(3);
  driver.confirmSelection("x");
  driver.requestRepick();
  await flush();

  assert.deepEqual(fake.methods(), [], "未开始会话时任何动作都不应下发脚本");
  assert.deepEqual(sessions, [], "未开始会话时不产生状态变更");
});
