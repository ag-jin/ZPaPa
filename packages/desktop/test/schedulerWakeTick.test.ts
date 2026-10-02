// eslint-disable-next-line typescript-eslint/triple-slash-reference -- 见下方说明（全仓只有这一处声明，不另写一份）
/// <reference path="../../services/src/runtime-tools/node-forge.d.ts" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  WAKE_DISPATCH_PENDING_TTL_MS,
  WAKE_TICK_LIMIT,
  createWakeTick,
} from "../src/scheduler/wakeTick.js";

/* 上面那条 reference 只在**类型**层面把 services 里那份 node-forge 环境声明拉进本测试工程：
   `node-forge` 没有自带类型、也没装 @types/node-forge，声明全仓只有
   `services/src/runtime-tools/node-forge.d.ts` 一处（services 工程 include 了它，而 desktop 的测试工程
   只 include `test/`，不引用就不生效）。本用例经 `wakeTick.ts` → `@zcode/services/node` 走通 services
   的源码图，那份声明必须在场，否则类型检查会在**别人的文件**上（runtime-tools/appCaCert.ts）报 TS7016。
   **不在这里另写一份声明**：第二份声明正是「改一处漏一处」的形态。 */

/* 唤醒 tick 的判定矩阵（spec §5.5 / §5.7.1）。本文件只测**纯逻辑**（不碰 sqlite / Electron）：
   到点规则怎么被判、怎么被推进、什么形态的请求被发出去——这些才是「重启后重算会不会算出
   不同 key」「闸停了有没有落盘」这两类**静默失败**的落点。 */

const rule = (over: Record<string, unknown> = {}) =>
  ({
    id: "w1",
    workItemId: "wi_1",
    kind: "event",
    mode: "once",
    fireCount: 0,
    revision: 3,
    enabled: true,
    nextFireAt: 1000,
    ...over,
  }) as never;

// event 族的 eventKey 惯例：e:id:squad:<workItemId>:<revision>:<fireCount>（见 wakeTick.buildWakeEventKey）。
const EVENT_KEY = "e:id:squad:wi_1:3:0";

test("到点且决定 fire ⇒ 发出派发请求，eventKey 带四元组里的两维", async () => {
  const posts: unknown[] = [];
  const advanced: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    advance: (r) => advanced.push(r),
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 1);
  const req = posts[0] as Record<string, unknown>;
  assert.equal(req.ruleId, "w1");
  assert.equal(req.workItemId, "wi_1");
  assert.equal(req.revision, 3);
  // 幂等键 `(workItemId, ruleId, revision, eventKey)`（spec §3.9）：eventKey 由**唯一构造器**给出，
  // 不得在此就地拼串——就地拼串会让重复投递的同一事实算出两个 key，去重静默失效。
  assert.match(String(req.eventKey), /^e:/);
  assert.equal(advanced.length, 1);
});

// §5.5：闸先于去重。触发被暂停时**不得**发派发请求，且必须把 pausedReason 落到规则上
// （不落盘，用户界面上就看不出「它停下来了」）。
test("被闸拦下 ⇒ 不发请求，但把 pausedReason 落到规则上", async () => {
  const posts: unknown[] = [];
  const advanced: Array<{ pausedReason?: string }> = [];
  const tick = createWakeTick({
    listReady: () => [rule({ fireCount: 9999, maxFires: 3 })],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 0);
  assert.equal(advanced[0]?.pausedReason, "max_fires");
});

// 同一事实重投两次只 fire 一次：第二次的 `(ruleId, revision, eventKey)` 已在去重集合里 ⇒ merged。
test("同一 eventKey 重投第二次被 merged 掉", async () => {
  const posts: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  await tick.run(2000);
  assert.equal(posts.length, 1);
});

/* ── 以下为本任务补齐的矩阵格（brief Step 5 的穷举面） ── */

test("listReady 返回空 ⇒ 不发请求、不推进（不是失败，也不该写任何状态）", async () => {
  const posts: unknown[] = [];
  const advanced: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [],
    advance: (r) => advanced.push(r),
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 0);
  assert.equal(advanced.length, 0);
});

test("limit 交给 repo（WAKE_TICK_LIMIT 是唯一出处，tick 不做二次截断）", async () => {
  const calls: Array<[number, number]> = [];
  const tick = createWakeTick({
    listReady: (now, limit) => {
      calls.push([now, limit]);
      return [];
    },
    advance: () => {},
    postRequest: () => {},
  });
  await tick.run(4242);
  assert.deepEqual(calls, [[4242, WAKE_TICK_LIMIT]]);
});

// fire 分支必须真正推进规则：once 走 nextFireAt=null（不再到点），否则下一轮同一格会再次命中。
test("fire 推进 fireCount 并把 once 的 nextFireAt 置空", async () => {
  const advanced: Array<Record<string, unknown>> = [];
  const tick = createWakeTick({
    listReady: () => [rule({ fireCount: 4 })],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: () => {},
  });
  await tick.run(2000);
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0]?.fireCount, 5);
  assert.equal(advanced[0]?.nextFireAt, null);
});

// §5.5 rate 闸：一小时内 run 次数 ≥ 12 ⇒ 暂停。本阶段不新增一小时窗口**表**，
// 用进程内的滚动窗口计数顶替（P2c 换持久窗口）；窗口滑过即自解，与 decideWake 的次序理由一致。
test("rate 闸：窗口内第 13 次判 pause(rate)，并把 pausedReason 落盘", async () => {
  const posts: unknown[] = [];
  const advanced: Array<{ pausedReason?: string }> = [];
  let fireCount = 0;
  const tick = createWakeTick({
    // 每次到点的都是「同一条规则的下一次」：fireCount 变化 ⇒ eventKey 变化，不会被去重吞掉。
    listReady: () => [rule({ fireCount: fireCount++, maxFires: 100 })],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: (r) => posts.push(r),
  });
  for (let index = 0; index < 13; index += 1) await tick.run(2000);
  assert.equal(posts.length, 12, "前 12 次放行");
  assert.equal(advanced[12]?.pausedReason, "rate", "第 13 次被 rate 闸拦下并落盘原因");
});

// §5.5 skip 是**瞬时结论**：不 post、不 advance，下一轮同一事实仍会被算成 skip。
test("skip 决策 ⇒ 不发请求也不推进（经注入的 decide 替身验证该分支）", async () => {
  const posts: unknown[] = [];
  const advanced: unknown[] = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    advance: (r) => advanced.push(r),
    postRequest: (r) => posts.push(r),
    decide: () => ({ action: "skip", reason: "acknowledged" }),
  });
  await tick.run(2000);
  assert.equal(posts.length, 0);
  assert.equal(advanced.length, 0);
});

/* ── eventKey 的排期族锚点（spec §5.7.1 (B)；本任务定义并写死） ──
   名义时刻必须来自**规则自带的持久化排期字段**，不得用调度器发现它的墙钟时刻：
   否则重启后重算 nextFireAt 会算出不同的 key，去重静默失效。 */

test("event 族：同一事实（同 ruleId/revision/fireCount）两次算出同一个 key", async () => {
  const posts: string[] = [];
  const makeTick = () =>
    createWakeTick({
      listReady: () => [rule()],
      advance: () => {},
      postRequest: (r) => posts.push(r.eventKey),
    });
  // 同一个 tick 的第二次会被去重拦住，所以用两个**独立**的 tick 比较构造结果：
  // 发现时刻（2000 / 3000）不同不应改变 key，否则跨重启的去重就静默失效了。
  await makeTick().run(2000);
  await makeTick().run(3000);
  assert.deepEqual(posts, [EVENT_KEY, EVENT_KEY], "同一事实必须算出同一个 key");
});

test("at 族：名义时刻是规则自带的 at（与发现时刻无关），key 为 t:<at>", async () => {
  const posts: Array<{ eventKey: string }> = [];
  const tick = createWakeTick({
    listReady: () => [rule({ kind: "at", mode: "once", at: 777_000, nextFireAt: 777_000 })],
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(999_999_999);
  assert.equal(posts[0]?.eventKey, "t:777000", "发现时刻不同也必须是同一个 t:<名义时刻>");
});

test("every 族：名义时刻是持久化的 nextFireAt（网格锚点），推进只做整数倍步进", async () => {
  const posts: Array<{ eventKey: string }> = [];
  const advanced: Array<Record<string, unknown>> = [];
  const tick = createWakeTick({
    // nextFireAt=1000、间隔 60s；now 已远超一格 ⇒ 推进到严格晚于 now 的**同一网格点**。
    listReady: () => [
      rule({ kind: "every", mode: "continuous", intervalSeconds: 60, nextFireAt: 1000 }),
    ],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: (r) => posts.push(r),
  });
  await tick.run(200_000);
  assert.equal(posts[0]?.eventKey, "t:1000");
  // 网格保持：1000 + k*60000 且 > now ⇒ k=4 ⇒ 241000（不是「now 对齐」的某一刻）。
  assert.equal(advanced[0]?.nextFireAt, 241_000);
});

// §5.7.1(B) 末段 / §6.6 第 3 项：重启后重算必须落在**同一网格点**上（换锚点 ⇒ 同一格算出不同 key ⇒ 去重静默失效）。
// 这里模拟一次「重启」：新 tick 只读到持久化的 nextFireAt，算出的名义时刻必须是**持久化值**而不是被 now 重新对齐的值。
test("every 族：重启后重读持久化的排期点，名义时刻不变（不按 now 重新对齐）", async () => {
  const advanced: Array<{ nextFireAt?: number | null }> = [];
  const beforeRestart = createWakeTick({
    listReady: () => [
      rule({ kind: "every", mode: "continuous", intervalSeconds: 60, nextFireAt: 1000 }),
    ],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: () => {},
  });
  await beforeRestart.run(200_000);
  assert.equal(advanced[0]?.nextFireAt, 241_000);

  const posts: Array<{ eventKey: string }> = [];
  const afterRestart = createWakeTick({
    listReady: () => [
      rule({ kind: "every", mode: "continuous", intervalSeconds: 60, nextFireAt: 241_000 }),
    ],
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await afterRestart.run(241_500);
  // 若这里按 now=241500 重新对齐，会算出 301000 —— 同一格就换了 key。
  assert.equal(posts[0]?.eventKey, "t:241000");
});

test("cron 族：名义时刻是持久化的 nextFireAt，推进取表达式在该时刻之后的下一次命中", async () => {
  const posts: Array<{ eventKey: string }> = [];
  const advanced: Array<Record<string, unknown>> = [];
  const tick = createWakeTick({
    listReady: () => [
      rule({
        kind: "cron",
        mode: "continuous",
        cronExpression: "* * * * *",
        nextFireAt: 60_000,
      }),
    ],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: (r) => posts.push(r),
  });
  await tick.run(200_000);
  assert.equal(posts[0]?.eventKey, "t:60000");
  assert.equal(advanced[0]?.nextFireAt, 240_000, "下一次命中是 now 之后最近的整分");
});

// 派发目标（workspace）由规则所属工作项给出：wake_rules 表没有 workspace 列。
// 生产接线必须提供 resolver；解析不到工作项 ⇒ 响亮失败（不静默发一条地址空的派发）。
test("提供 workspace resolver 时，请求带上工作项的 workspace 绑定", async () => {
  const posts: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  const tick = createWakeTick({
    listReady: () => [rule()],
    resolveWorkspace: () => ({ workspacePath: "/ws/a", workspaceIdentity: "id-a" }),
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts[0]?.workspacePath, "/ws/a");
  assert.equal(posts[0]?.workspaceIdentity, "id-a");
});

test("resolver 解析不到规则所属工作项 ⇒ 抛（响亮失败，不发地址空的派发）", async () => {
  const tick = createWakeTick({
    listReady: () => [rule()],
    resolveWorkspace: () => null,
    advance: () => {},
    postRequest: () => {},
  });
  await assert.rejects(() => tick.run(2000), /工作项/);
});

// 排期族缺名义时刻（nextFireAt/at 都没有）⇒ 抛：拼不出 key 就别派发，
// 否则同一格每次都会算出不同 key（正是 §5.7.1 要防的「去重静默失效」）。
test("排期族缺名义时刻 ⇒ 抛", async () => {
  const tick = createWakeTick({
    listReady: () => [
      rule({ kind: "every", mode: "continuous", intervalSeconds: 60, nextFireAt: undefined }),
    ],
    advance: () => {},
    postRequest: () => {},
  });
  await assert.rejects(() => tick.run(2000), /名义时刻/);
});

// now 恰好落在网格点上（1000 + 3*60000 = 181000）⇒ 必须推进到**下一格** 241000。
// 用 `ceil((now-nominal)/step)` 会算出 steps=3 ⇒ 返回 now 自己，与「严格晚于 now」矛盾：
// 那一格要多留一拍才发现到点，且下一格的 eventKey 会指回刚刚 fire 过的名义时刻。
test("every 族：now 恰落在网格点上 ⇒ 推进到下一格（严格晚于 now）", async () => {
  const advanced: Array<Record<string, unknown>> = [];
  const tick = createWakeTick({
    listReady: () => [
      rule({ kind: "every", mode: "continuous", intervalSeconds: 60, nextFireAt: 1000 }),
    ],
    advance: (r) => {
      advanced.push(r);
    },
    postRequest: () => {},
  });
  await tick.run(181_000);
  assert.equal(advanced[0]?.nextFireAt, 241_000, "推进结果必须严格晚于 now，且仍在同一网格上");
});

/* ── 已请求未结算的**重投**（Important-A）──

   `fire()` 是 advance-before-post（先 CAS 推进再发请求），所以请求一发出，那一格就再也推不出来
   （`list_ready` 不会回头给）。若瞬时结果（本机没有 host / 转发失败 / 库未就绪）只打日志就丢弃，
   这次唤醒**静默消失** —— 而邻居的 cron / off-peak 都有退避重投。下面钉住这张重投表的行为：
   重投的是**同一条**请求（同一个 eventKey ⇒ §3.9 幂等键不变），并区分「瞬时/等待」（重投）
   与「确定性失败」（放弃不空转）。 */

test("瞬时失败 ⇒ 退避到期后重投**同一条**请求（同一 eventKey），且不每轮都发", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: ReturnType<typeof rule>[] = [rule()];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 1);
  // 规则已被 CAS 推进：本轮之后它不再出现在 listReady 里（那一格再也推不出来）。
  ready.length = 0;

  const outcome = tick.settle(
    {
      ruleId: "w1",
      eventKey: EVENT_KEY,
      ok: false,
      failureKind: "transient",
      error: "no local host available",
    },
    2000,
  );
  assert.deepEqual(outcome, {
    kind: "retry",
    attempts: 1,
    retryInMs: 30_000,
    failureKind: "transient",
    error: "no local host available",
  });

  // 退避未到 ⇒ 不重投。
  await tick.run(31_999);
  assert.equal(posts.length, 1, "退避期内不得重投");

  // 退避到期 ⇒ 重投同一条请求。
  await tick.run(32_000);
  assert.equal(posts.length, 2, "退避到期必须重投（否则这次唤醒被静默吞掉）");
  assert.deepEqual(posts[1], posts[0], "重投的必须是同一条请求：同一个 eventKey，幂等键不变");

  // 发出去之后要等下一次回执再排期，不能每轮 tick 都发一遍。
  await tick.run(32_001);
  assert.equal(posts.length, 2);
});

test("等待型（deferred：绑定会话忙）也重投，且标成 deferred", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: ReturnType<typeof rule>[] = [rule()];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  ready.length = 0;
  const outcome = tick.settle(
    { ruleId: "w1", eventKey: EVENT_KEY, ok: false, failureKind: "deferred" },
    2000,
  );
  assert.equal(outcome.kind, "retry");
  assert.ok(outcome.kind === "retry" && outcome.failureKind === "deferred");
  await tick.run(32_000);
  assert.equal(posts.length, 2);
});

// 确定性失败（门禁关闭 / 运行时未注册 / 开树失败）：重试不会自愈 ⇒ 撤下记录，不按 transient 空转。
test("确定性失败（permanent）⇒ 放弃重投，撤下记录", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: ReturnType<typeof rule>[] = [rule()];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  ready.length = 0;
  const outcome = tick.settle(
    { ruleId: "w1", eventKey: EVENT_KEY, ok: false, failureKind: "permanent", error: "门禁关闭" },
    2000,
  );
  assert.deepEqual(outcome, { kind: "abandoned", error: "门禁关闭" });
  await tick.run(999_999);
  assert.equal(posts.length, 1, "permanent 不该重投");
});

test("成功回执 ⇒ 结算并撤下重投记录", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: ReturnType<typeof rule>[] = [rule()];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  ready.length = 0;
  assert.deepEqual(tick.settle({ ruleId: "w1", eventKey: EVENT_KEY, ok: true }, 2000), {
    kind: "settled",
  });
  await tick.run(999_999);
  assert.equal(posts.length, 1);
});

// 迟到的回执（重启后 / 从未发出）不当成失败，更不能拿它去重投一条来路不明的请求。
test("找不到对应记录的迟到回执 ⇒ unknown（只留痕，不重投）", () => {
  const posts: Array<Record<string, unknown>> = [];
  const tick = createWakeTick({
    listReady: () => [],
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  assert.deepEqual(
    tick.settle(
      { ruleId: "w1", eventKey: "e:id:squad:wi_x:1:0", ok: false, failureKind: "transient" },
      2000,
    ),
    { kind: "unknown" },
  );
  assert.equal(posts.length, 0);
});

/* ── 重投表的**上界**与「已发出但回执不来」的归宿（Minor-1）──

   复审发现的两格：
   ① 持续「本机没有 host」时，一条 every/cron 规则**每个网格点**都新增一条永不删除的记录
      （无 TTL、无尝试上限、无淘汰）⇒ 内存随派发次数**无界**增长；
   ② 请求已发出但回执始终不来（host/main 中途退出）的条目 `retryAt` 恒 null ⇒ **既不被重投、
      也不被清理** ⇒ 那次唤醒静默消失，只在表里留一条永久占位。

   裁定：让表**有界**，并让「永不撤下」不再可能 —— 到期**响亮放弃并留痕**（不静默占位）。
   下面两条钉住这两格，用**假时钟**（显式传 now），不靠真实等待。 */

test("持续无 host（每格瞬时失败）⇒ 重投记录有 TTL 淘汰，表不会无界增长", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: Array<ReturnType<typeof rule>> = [];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  const interval = 60_000;
  const fired: Array<{ ruleId: string; eventKey: string }> = [];
  const evictedKeys: string[] = [];
  // 跑 3 个 TTL：若没有淘汰，表会线性增长到 3*TTL/interval 条（远大于一个 TTL 窗口）。
  for (let grid = 1; grid * interval <= WAKE_DISPATCH_PENDING_TTL_MS * 3; grid += 1) {
    const now = grid * interval;
    ready.length = 0;
    // 每格一条**新的**规则（id 也随之变化 ⇒ 各规则各自 1 次触发，都不撞 rate 闸）。
    ready.push(
      rule({
        id: `w${grid}`,
        kind: "every",
        mode: "continuous",
        intervalSeconds: 60,
        nextFireAt: now,
        // fireCount=0 且不设 maxFires：不撞默认 max_fires(20) 闸；eventKey 取 nextFireAt，与它无关。
        fireCount: 0,
      }),
    );
    const evicted = await tick.run(now);
    for (const item of evicted) evictedKeys.push(item.eventKey);
    // 本轮的到点请求落在 posts 末尾（evict/repostDue 先跑、规则后跑）⇒ 对它的瞬时失败回执。
    const latest = posts[posts.length - 1] as { ruleId: string; eventKey: string };
    assert.equal(latest.eventKey, `t:${now}`, "本轮新发出的就是这条（重投在前、到点在后的顺序）");
    const outcome = tick.settle(
      {
        ruleId: latest.ruleId,
        eventKey: latest.eventKey,
        ok: false,
        failureKind: "transient",
        error: "no local host available",
      },
      now,
    );
    assert.equal(outcome.kind, "retry", "无 host 是瞬时失败：必须重投（否则这次唤醒被静默吞掉）");
    fired.push({ ruleId: latest.ruleId, eventKey: latest.eventKey });
  }
  assert.ok(evictedKeys.length > 0, "超过 TTL 的记录必须被淘汰，否则内存随派发次数无界增长");
  // 反查表的有界性：活条目只可能来自**最近一个 TTL 窗口**（TTL/interval 条 + 边界余量）。
  const finalNow = WAKE_DISPATCH_PENDING_TTL_MS * 3;
  let live = 0;
  for (const entry of fired) {
    const out = tick.settle(
      { ruleId: entry.ruleId, eventKey: entry.eventKey, ok: false, failureKind: "transient" },
      finalNow,
    );
    if (out.kind !== "unknown") live += 1;
  }
  const bound = Math.ceil(WAKE_DISPATCH_PENDING_TTL_MS / interval) + 2;
  assert.ok(live <= bound, `活条目 ${live} 条应被 TTL 限在 ${bound} 条以内（表有界）`);
});

test("请求已发出但回执始终不来 ⇒ 到 TTL 被淘汰并交入口留痕（不再静默占位）", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: Array<ReturnType<typeof rule>> = [rule()];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  const firedAt = 1000;
  await tick.run(firedAt);
  assert.equal(posts.length, 1);
  // 规则已被 CAS 推进：同一格不再出现在 listReady 里（那一格再也推不出来）。
  ready.length = 0;

  // 回执从未到达（retryAt 恒 null）：TTL 内既不得重投（重投可能双跑），也不得提前清理。
  const beforeTtl = await tick.run(firedAt + WAKE_DISPATCH_PENDING_TTL_MS - 1);
  assert.equal(beforeTtl.length, 0, "TTL 未到不得淘汰");
  assert.equal(posts.length, 1, "无回执不得重投（请求可能仍在途，重投会双跑）");

  // 到 TTL ⇒ 淘汰，并把「从未收到任何回执」这一事实交给调度器入口留痕（logger.error）。
  const evicted = await tick.run(firedAt + WAKE_DISPATCH_PENDING_TTL_MS);
  assert.equal(evicted.length, 1, "到 TTL 必须被淘汰（不得再无限期挂着）");
  assert.equal(evicted[0]?.eventKey, EVENT_KEY);
  assert.equal(evicted[0]?.ruleId, "w1", "留痕要够定位：ruleId 与 eventKey 都在");
  assert.equal(evicted[0]?.pendingForMs, WAKE_DISPATCH_PENDING_TTL_MS);
  assert.equal(
    evicted[0]?.attempts,
    0,
    "attempts=0 ⇒ 从未收到任何回执 —— 正是「host/main 中途退出」的形态",
  );
  // 实体状态断言：表里已经没有它（迟到的回执只能得到 unknown）。
  assert.deepEqual(
    tick.settle(
      { ruleId: "w1", eventKey: EVENT_KEY, ok: true },
      firedAt + WAKE_DISPATCH_PENDING_TTL_MS,
    ),
    { kind: "unknown" },
    "淘汰后该条目必须已从重投表移除",
  );
  assert.equal(posts.length, 1, "淘汰 ≠ 重投");
});

// 重投表按 `(ruleId, eventKey)` 分账：eventKey 里**没有** ruleId，同一工作项上的两条规则
// 可以算出同一个 key —— 只按 eventKey 匹配的话，一条回执会把另一条规则的重投记录一并撤掉。
test("同一工作项上两条规则算出同一个 eventKey 时，重投记录互不干扰", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const ready: ReturnType<typeof rule>[] = [rule({ id: "w1" }), rule({ id: "w2" })];
  const tick = createWakeTick({
    listReady: () => ready,
    advance: () => {},
    postRequest: (r) => posts.push(r),
  });
  await tick.run(2000);
  assert.equal(posts.length, 2);
  assert.equal(new Set(posts.map((post) => post.eventKey)).size, 1, "同一事实 ⇒ 同一个 key");
  ready.length = 0;

  // w1 结算成功；w2 瞬时失败。
  tick.settle({ ruleId: "w1", eventKey: EVENT_KEY, ok: true }, 2000);
  tick.settle({ ruleId: "w2", eventKey: EVENT_KEY, ok: false, failureKind: "transient" }, 2000);
  await tick.run(32_000);
  assert.equal(posts.length, 3, "w2 的重投不能被 w1 的成功回执撤掉");
  assert.equal(posts[2]?.ruleId, "w2");
});
