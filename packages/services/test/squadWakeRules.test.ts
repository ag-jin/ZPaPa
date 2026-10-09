import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import { createSquadOrchestrator } from "../src/workitem/squadOrchestrator.js";
import { archiveSquadAndTransfer, createSquadRuntime } from "../src/workitem/squadRuntime.js";
import {
  createSquadRuntimeService,
  type ISquadRuntimeService,
  type SquadWorkspaceTarget,
} from "../src/workitem/squadRuntimeService.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* 唤醒规则的**服务/数据半**（P2b 第二半）用例：规则能被建出来、被暂停/恢复、被调度真的命中。
   装配照 `squadRosterManagement.test.ts` 的同一先例：真实 git 仓库 + `:memory:` sqlite +
   真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为而不是实现。

   本轮的**点亮判据**（本轮前 `wakeRuleRepo.insert` 零生产调用方、`wake_rules` 表永远为空）：
   建出的规则必须**真的落成未来排期点**（`next_fire_at`），且 `listReady`（调度器到点扫描的同一
   SQL 口径：`enabled=1 AND next_fire_at <= now`）在到点时刻能读到它 —— 这是「规则建了但永不
   触发」那条静默死配置的**反向证据**。所有断言都读**实体状态**（repo 读回 / 直接读库），
   返回值是调用方给的那份数据的回声，读库才有独立信息。

   口径纪律：目标 workspace **显式构造**并用 `seenTargets` 证明服务把**调用方给的**目标原样
   交给 runtime（没有隐式默认 workspace）；门禁口径（create/resume 过、pause/list 不过）
   逐条在本文件末尾的用例里钉住。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

/** 真实 runtime + 真实服务面（照 squadRosterManagement.test.ts 的装配法），另暴露读库口。
    `wrapRuntime` 供「读到写之间的并发」用例注入确定性时序（照 `squadWakeRulesEdit.test.ts` 的同一
    先例：真实竞态不可按需触发，包装器只改时序不改语义）。 */
async function makeService(options?: { wrapRuntime?: (runtime: SquadRuntime) => SquadRuntime }) {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const state = { enabled: true };
  /** 记录服务面收到的目标 —— 证明服务面把**调用方给的**目标原样交给 runtime。 */
  const seenTargets: string[] = [];
  const createRuntime = async (t: SquadWorkspaceTarget): Promise<SquadRuntime> => {
    seenTargets.push(`${t.path}|${t.identity}`);
    const runtime = await createSquadRuntime({
      db,
      workspacePath: repoRoot,
      workspaceIdentity: t.identity,
      readExperimentEnabled: () => state.enabled,
    });
    return options?.wrapRuntime ? options.wrapRuntime(runtime) : runtime;
  };
  const squadRuntimeService: ISquadRuntimeService = createSquadRuntimeService({
    createRuntime,
    readExperimentEnabled: async () => state.enabled,
    archiveSquadAndTransfer: async (t, id) => archiveSquadAndTransfer(await createRuntime(t), id),
    createOrchestrator: createSquadOrchestrator,
  });
  return {
    repoRoot,
    db,
    squadRuntimeService,
    createRuntime,
    seenTargets,
    setExperimentEnabled: (value: boolean) => {
      state.enabled = value;
    },
  };
}

const WS = target("ws");

/** 建一条挂载用工作项（规则必须挂在**本 workspace 的**在用工作项上）。 */
async function makeWorkItem(
  service: ISquadRuntimeService,
  ws: SquadWorkspaceTarget = WS,
  title = "网关改造",
) {
  return service.createWorkItem(ws, { title, assignee: { type: "user", id: "u1" } });
}

/** 常用入参：一条每分钟的连续规则（首格应落在未来一个间隔内）。 */
const everyMinute = (workItemId: string) => ({
  workItemId,
  kind: "every" as const,
  mode: "continuous" as const,
  intervalSeconds: 60,
});

/** 一个永远够大的「现在」：用于断言「不再被到点扫描命中」（排期点已清空，任何 now 都扫不到）。 */
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

/* 首格排期的断言容差：服务内部的 `now` 在测试抓的 `before` **之后**（构造 runtime 要 ~20ms 级），
   而落点 = 内部 now + 一个间隔 ⇒ 严格按 `before + interval` 卡边界会差几毫秒到几十毫秒。
   容差只放宽上界（「落点不晚于一个间隔 + 容差」），下界（严格未来）仍然严卡。 */
const SCHEDULE_SLACK_MS = 5_000;

test("点亮判据：建出的 every 规则落成未来排期，listReady 在到点时刻能读到它", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const before = Date.now();

  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));

  const runtime = await createRuntime(WS);
  const row = runtime.wakeRuleRepo.get(created.id);
  assert.ok(row, "写盘后必须能读回（返回值即写盘后的实体，读回口径）");
  assert.equal(row.kind, "every");
  assert.equal(row.mode, "continuous");
  assert.equal(row.intervalSeconds, 60);
  assert.equal(row.fireCount, 0);
  assert.equal(row.revision, 0);
  assert.equal(row.enabled, true);
  assert.equal(created.nextFireAt, row.nextFireAt, "返回值与库中实体一致");
  assert.equal(row.pausedReason, undefined);

  const nextFireAt = row.nextFireAt;
  assert.ok(
    typeof nextFireAt === "number",
    "必须落成排期点：没有 next_fire_at 的规则永远不会被调度器扫到（本轮要消灭的静默死配置）",
  );
  assert.ok(
    nextFireAt > before && nextFireAt - before <= 60_000 + SCHEDULE_SLACK_MS,
    `nextFireAt=${nextFireAt} 应落在创建时刻之后、一个间隔（60s + 容差）之内`,
  );
  // 调度器到点扫描的**同一 SQL 口径**：到点那一刻必能命中它。
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(nextFireAt, 100).map((rule) => rule.id),
    [created.id],
    "到点时刻 listReady 必须读到它（否则「规则半边」仍是空的）",
  );
  // 到点**之前**不得被命中：证明落的是**未来**排期点，不是「创建即到点」。
  assert.deepEqual(runtime.wakeRuleRepo.listReady(nextFireAt - 1, 100), []);
});

test("死配置：at 已过去 / cron 无未来命中 ⇒ create 响亮抛，且库里没有行", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);

  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "at",
        mode: "once",
        at: Date.now() - 1_000,
      }),
    /死配置/,
    "过去时刻的 at：建成即过点 ⇒ 必须响亮抛（静默落盘 = 永不触发的死配置）",
  );
  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "cron",
        mode: "continuous",
        // 2 月 30 日不存在 ⇒ 永无命中（实测 croner nextRun 返回 null）。
        cronExpression: "0 0 30 2 *",
      }),
    /死配置/,
  );

  const runtime = await createRuntime(WS);
  assert.deepEqual(
    runtime.wakeRuleRepo.listByWorkItem(item.id),
    [],
    "响亮抛的规则一行都不许落盘（「不落盘」是断言的一部分，不是靠人相信）",
  );
});

/* timezone（G4）：字段**保留**在 API 里但调度侧不消费（降级为文档标注），唯一被闭合的是
   **合法性** —— 显式传入非法 IANA 名必须当场响亮拒（`validateWakeRule` 第 9 条），
   而不是安静落盘、留到将来接线时才炸。两个方向都要钉：非法被拒、**合法不被误伤**
   （过度拦截会把能用的规则也拦在门外，与「拒非法」是两条独立断言）。 */
test("时区：显式传入非法 IANA 名 ⇒ create 响亮拒且不落盘；合法名 ⇒ 正常建出", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);

  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "every",
        mode: "continuous",
        intervalSeconds: 60,
        timezone: "Mars/Phobos",
      }),
    /timezone/,
    "非法时区名必须当场点名 timezone 拒掉（域层 IANA 校验），不得安静落盘",
  );

  const created = await squadRuntimeService.createWakeRule(WS, {
    workItemId: item.id,
    kind: "every",
    mode: "continuous",
    intervalSeconds: 60,
    timezone: "Asia/Shanghai",
  });
  const runtime = await createRuntime(WS);
  assert.equal(runtime.wakeRuleRepo.get(created.id)?.timezone, "Asia/Shanghai");
  assert.deepEqual(
    runtime.wakeRuleRepo.listByWorkItem(item.id).map((r) => r.timezone),
    ["Asia/Shanghai"],
    "非法名那一行未落盘、合法名那一行在：被拒的是值，不是整个字段",
  );
});

/* 到期点（G3）：**首格排期**也受到期点约束。`at` 的名义时刻不经 `nextFireAtAfter`
   （一次性规则在那里按 `mode === "once"` 提前返回 null），所以它的到期判定必须单独落在
   `initialNextFireAt` 的 at 分支上 —— 漏掉它，「at 晚于到期点」的规则会带着一个永不生效的
   到期点落盘（用户设的过期时刻形同虚设）。 */
test("到期点｜at 与到期点的三种相对位置：早于 ⇒ 建出；恰等于 / 晚于 ⇒ 死配置响亮抛", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const at = Date.now() + 600_000;

  const created = await squadRuntimeService.createWakeRule(WS, {
    workItemId: item.id,
    kind: "at",
    mode: "once",
    at,
    // 到期点比 at 晚 1ms：触发时刻严格早于到期点 ⇒ 合法（边界另一侧，防止实现写成 `>`）。
    expiresAt: at + 1,
  });
  assert.equal(created.nextFireAt, at, "到期点晚于 at ⇒ 首格就是 at 本身");

  // 恰等于 / 晚于到期点：到期点在未来，卡掉它的是**排期**那一侧（首格即越界）⇒ 死配置文案。
  for (const expiresAt of [at, at - 1]) {
    await assert.rejects(
      () =>
        squadRuntimeService.createWakeRule(WS, {
          workItemId: item.id,
          kind: "at",
          mode: "once",
          at,
          expiresAt,
        }),
      /死配置/,
      `expiresAt=${expiresAt}：首格不早于到期点 ⇒ 建成即永不触发，必须响亮抛`,
    );
  }
  // 到期点本身已在过去：由服务面的到期点前置守卫判出（比「排期算不出下一格」更贴题的文案）。
  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "at",
        mode: "once",
        at,
        expiresAt: Date.now() - 1_000,
      }),
    /过期/,
    "到期点已在过去 ⇒ 响亮拒，且点名是「过期」而不是排期问题",
  );

  const runtime = await createRuntime(WS);
  assert.deepEqual(
    runtime.wakeRuleRepo.listByWorkItem(item.id).map((rule) => rule.id),
    [created.id],
    "被拒的三条一行都不许落盘（只有对照组那条在库里）",
  );
});

/* 成因文案必须与事实一致（R1）：`at <= now < expiresAt` 时两件事**同时**在场 —— 到点时刻已过去
   （真因，`initialNextFireAt` 的 `at <= now ⇒ null`）与到期点仍在未来（没卡掉任何东西）。
   旧文案只看「有没有 expiresAt」就断言「到点时刻不早于到期时刻」，指着**没出问题**的那一边：
   用户照它去改到期点，改到天边也建不出来。回落文案（同分支末行）才是这一格的成因。 */
test("到期点｜at 已过去但到期点在未来 ⇒ 成因说「到点时刻已经过去」，不得说成被到期点卡的", async () => {
  const { squadRuntimeService } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);

  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "at",
        mode: "once",
        at: Date.now() - 1_000,
        // 到期点在**未来**：首格不是被它卡掉的（卡的判据 `at >= expiresAt` 不成立）。
        expiresAt: Date.now() + 600_000,
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /到点时刻已经过去/, "真因是到点时刻已过 —— 文案必须说这一条");
      assert.doesNotMatch(
        message,
        /不早于到期时刻/,
        "到期点在将来、没卡掉首格：说成「不早于到期时刻」会把用户引到改到期点上（改不好）",
      );
      return true;
    },
  );
});

test("到期点｜expiresAt 已过 ⇒ 创建响亮拒且点名「过期」（不是笼统的「没有未来排期点」）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);

  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "every",
        mode: "continuous",
        intervalSeconds: 60,
        expiresAt: Date.now() - 1_000,
      }),
    /过期/,
    "期限已过的规则建成即永不触发：文案必须点名到期时刻（笼统文案会让人以为是排期算错了）",
  );

  const runtime = await createRuntime(WS);
  assert.deepEqual(runtime.wakeRuleRepo.listByWorkItem(item.id), [], "不落盘");
});

test("到期点｜resume 时规则已过期 ⇒ 响亮抛且不写盘（不复活一条过期规则）", async () => {
  const { squadRuntimeService, createRuntime, db } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);
  // 造「真实经历过的过期」：合法建出后绕过 repo 把到期点改到过去并暂停（模拟时间流逝 + 暂停态）。
  db.prepare(
    "UPDATE wake_rules SET expires_at = ?, next_fire_at = NULL, enabled = 0 WHERE id = ?",
  ).run(Date.now() - 1_000, created.id);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  await assert.rejects(
    () => squadRuntimeService.resumeWakeRule(WS, { id: created.id }),
    /过期/,
    "恢复一条已经过期的规则 = 死动作（用户会以为它又开始跑了），必须响亮抛",
  );
  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.nextFireAt, undefined, "响亮抛时不得写盘");
  assert.equal(after.revision, before.revision);
  assert.equal(after.enabled, false, "开关原样（恢复没有发生）");
});

test("validateWakeRule 不过 ⇒ 响亮抛（中文 problems 原样带出），库里没有行", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);

  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "every",
        mode: "continuous",
      }),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /无法创建唤醒规则：/);
      assert.match(
        message,
        /kind「every」必须带「intervalSeconds」/,
        "validateWakeRule 的中文 problems 必须原样在错误文案里（照 assertValid 的既有做法）",
      );
      return true;
    },
  );
  await assert.rejects(
    () => squadRuntimeService.createWakeRule(WS, { workItemId: item.id, kind: "at", mode: "once" }),
    /kind「at」必须带「at」/,
  );
  // 互斥打架也走同一条路（problems 来自域模型，组装层不另写判据）。
  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "every",
        mode: "once",
        intervalSeconds: 60,
      }),
    /kind「every」只能配 mode「continuous」/,
  );
  // 混装调度字段同样是互斥问题（两种调度口径并存 ⇒ 另一种永不生效）。
  await assert.rejects(
    () =>
      squadRuntimeService.createWakeRule(WS, {
        workItemId: item.id,
        kind: "every",
        mode: "continuous",
        intervalSeconds: 60,
        cronExpression: "* * * * *",
      }),
    /不得携带调度字段「cronExpression」/,
  );

  const runtime = await createRuntime(WS);
  assert.deepEqual(runtime.wakeRuleRepo.listByWorkItem(item.id), []);
});

test("宿主纪律：工作项不存在 / 不属于目标 workspace ⇒ 响亮抛（挂不上的规则永不触发）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const itemA = await makeWorkItem(squadRuntimeService, target("ws-a"), "A 的工作项");

  await assert.rejects(
    () => squadRuntimeService.createWakeRule(WS, everyMinute("不存在的项")),
    /不存在或已归档/,
  );
  await assert.rejects(
    () => squadRuntimeService.createWakeRule(WS, everyMinute(itemA.id)),
    /不属于本次调用的目标 workspace/,
    "挂到别处会从本 workspace 的列表里消失（wake_rules 没有 workspace 列）",
  );
  const runtime = await createRuntime(target("ws-a"));
  assert.deepEqual(runtime.wakeRuleRepo.listByWorkItem(itemA.id), []);
});

test("pause：排期点清空、listReady 不再命中、幂等可重放（pausedReason 不伪造，登记口径）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });

  const paused = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(paused.nextFireAt, undefined, "排期点必须清空（listReady 的候选条件）");
  assert.equal(paused.revision, before.revision + 1, "暂停是一次真实写盘（CAS 推进 revision）");
  assert.equal(paused.intervalSeconds, 60, "暂停不清除配置");
  // 登记口径（有意偏离 brief 字面）：pausedReason 的读回是**封闭枚举**（只有 max_fires/rate/loop
  // 三个防失控闸的码），没有「用户手动暂停」一码 ⇒ 写任何既有的码都是伪造闸原因。
  // 故这里**不写**，语义靠 nextFireAt 为空完整表达；下一轮若要区分手动/闸暂停需给 shared 加码。
  assert.equal(paused.pausedReason, undefined, "不得伪造闸原因（枚举封闭，写闸的码 = 假数据）");
  assert.deepEqual(runtime.wakeRuleRepo.listReady(FAR_FUTURE, 100), [], "不再被到点扫描命中");

  // 幂等：对「已不再到点」的规则再暂停一次 ⇒ 不写盘、不 bump revision（目标状态已达成）。
  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });
  assert.equal(
    runtime.wakeRuleRepo.get(created.id)!.revision,
    paused.revision,
    "重复暂停必须幂等（不写盘、不 bump revision）",
  );
});

test("启停：用户暂停关主开关（与闸暂停可分辨）、恢复开回来 + 重排", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });
  const paused = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(paused.enabled, false, "用户暂停 = 关主开关（listReady 的 enabled = 1 条件）");
  assert.equal(paused.pausedReason, undefined, "用户暂停不写闸原因（两件事可分辨）");
  assert.deepEqual(runtime.wakeRuleRepo.listReady(FAR_FUTURE, 100), []);

  await squadRuntimeService.resumeWakeRule(WS, { id: created.id });
  const resumed = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(resumed.enabled, true, "恢复 = 开回主开关");
  const nextFireAt = resumed.nextFireAt;
  assert.ok(typeof nextFireAt === "number", "恢复必须重算排期");
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(nextFireAt, 100).map((rule) => rule.id),
    [created.id],
    "恢复后重新被到点扫描命中",
  );
});

test("resume：清 pausedReason + 重算为未来排期 + 重新被 listReady 命中", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  // 模拟「闸暂停」的落库形态（与调度器同一写入口：casAdvance 带 pausedReason、nextFireAt 置空）。
  const initial = runtime.wakeRuleRepo.get(created.id)!;
  assert.deepEqual(
    runtime.wakeRuleRepo.casAdvance(created.id, initial.revision, null, initial.fireCount, "rate"),
    { outcome: "advanced" },
  );
  assert.equal(runtime.wakeRuleRepo.get(created.id)!.pausedReason, "rate");
  assert.deepEqual(runtime.wakeRuleRepo.listReady(FAR_FUTURE, 100), []);

  const before = Date.now();
  await squadRuntimeService.resumeWakeRule(WS, { id: created.id });

  const resumed = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(resumed.pausedReason, undefined, "恢复必须清 pausedReason（闸原因的复位路径）");
  assert.equal(resumed.enabled, true, "恢复 = 开主开关（用户启停）");
  const nextFireAt = resumed.nextFireAt;
  assert.ok(
    typeof nextFireAt === "number" &&
      nextFireAt > before &&
      nextFireAt - before <= 60_000 + SCHEDULE_SLACK_MS,
    `重算出的排期点应落在恢复时刻之后一个间隔内（实际 ${String(nextFireAt)}）`,
  );
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(nextFireAt, 100).map((rule) => rule.id),
    [created.id],
    "恢复后重新被到点扫描命中",
  );

  // 幂等：已在排期 ⇒ 不重算、不写盘（重算会静默挪动在跑规则的网格）。
  const settled = runtime.wakeRuleRepo.get(created.id)!;
  await squadRuntimeService.resumeWakeRule(WS, { id: created.id });
  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.revision, settled.revision, "重复恢复必须幂等（不写盘）");
  assert.equal(after.nextFireAt, nextFireAt, "重复恢复不得挪动网格");
});

test("resume 的死动作：重算后无未来排期点 ⇒ 响亮抛且不写盘", async () => {
  const { squadRuntimeService, createRuntime, db } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, {
    workItemId: item.id,
    kind: "cron",
    mode: "continuous",
    cronExpression: "* * * * *",
  });
  const runtime = await createRuntime(WS);
  // 绕过 repo 把表达式改成「永不命中」的形态（模拟坏数据 / 跨版本残留），并清掉排期（= 暂停态）。
  db.prepare(
    "UPDATE wake_rules SET cron_expression = '0 0 30 2 *', next_fire_at = NULL WHERE id = ?",
  ).run(created.id);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  await assert.rejects(
    () => squadRuntimeService.resumeWakeRule(WS, { id: created.id }),
    /没有未来排期点/,
    "恢复一条永不触发的规则 = 死动作，必须响亮抛",
  );
  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.nextFireAt, undefined, "响亮抛时不得写盘（该行保持原样）");
  assert.equal(after.revision, before.revision);
});

test("pause / resume / list：id 不存在 ⇒ 响亮抛（静默 no-op 会让界面以为动作生效了）", async () => {
  const { squadRuntimeService } = await makeService();
  await assert.rejects(() => squadRuntimeService.pauseWakeRule(WS, { id: "不存在" }), /不存在/);
  await assert.rejects(() => squadRuntimeService.resumeWakeRule(WS, { id: "不存在" }), /不存在/);
});

/* CAS 未命中的**判因分格**（G2）：服务面读到现行、写盘前被并发改动，有两种成因，
   而用户能做的复位动作不同 —— 必须给不同的话，否则「规则已被删」被说成「revision 被并发改动」，
   用户会一直重读重试一条已经不存在的规则。判因由 repo 回读给出（`WakeAdvanceOutcome`）。 */
test("pause 的 CAS 未命中：行被并发删除 ⇒ 文案说「已被并发删除」，不冒充版本冲突", async () => {
  let armAfterRead = false;
  const { squadRuntimeService, createRuntime } = await makeService({
    wrapRuntime: (runtime) => ({
      ...runtime,
      wakeRuleRepo: {
        ...runtime.wakeRuleRepo,
        get: (id: string) => {
          const rule = runtime.wakeRuleRepo.get(id);
          if (rule !== null && armAfterRead) {
            armAfterRead = false; // 只抢一次（一次并发删除）
            assert.equal(runtime.wakeRuleRepo.remove(rule.id), true);
          }
          return rule;
        },
      },
    }),
  });
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  armAfterRead = true;
  await assert.rejects(
    () => squadRuntimeService.pauseWakeRule(WS, { id: created.id }),
    /已被并发删除/,
    "行已不在 ⇒ 判因是 missing：文案必须指向「规则已被删除」，而不是把它记成一次版本冲突",
  );
  assert.equal(runtime.wakeRuleRepo.get(created.id), null, "行确实已不存在");
});

test("pause 的 CAS 未命中：行还在但 revision 变了 ⇒ 文案说「已被并发改动」并带两侧版本", async () => {
  let armAfterRead = false;
  const { squadRuntimeService, createRuntime } = await makeService({
    wrapRuntime: (runtime) => ({
      ...runtime,
      wakeRuleRepo: {
        ...runtime.wakeRuleRepo,
        get: (id: string) => {
          const rule = runtime.wakeRuleRepo.get(id);
          if (rule !== null && armAfterRead) {
            armAfterRead = false; // 只抢一次（一次并发推进，模拟调度器刚 fire）
            const advanced = runtime.wakeRuleRepo.casAdvance(
              rule.id,
              rule.revision,
              rule.nextFireAt ?? null,
              rule.fireCount,
            );
            assert.equal(advanced.outcome, "advanced");
          }
          return rule;
        },
      },
    }),
  });
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  armAfterRead = true;
  await assert.rejects(
    () => squadRuntimeService.pauseWakeRule(WS, { id: created.id }),
    /CAS 未命中/,
    "行还在、版本已变 ⇒ 判因是 fenced：这是并发冲突，文案与「已被删除」分格",
  );
  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.revision, before.revision + 1, "并发推进生效；暂停没有盖上去");
  assert.equal(after.enabled, true, "暂停未写盘（旧行原样）");
});

test("门禁：关掉开关 ⇒ create / resume 被拒（稳定码），pause / list 仍可用", async () => {
  const { squadRuntimeService, setExperimentEnabled } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });

  setExperimentEnabled(false);

  // create 被拒：稳定码（跨 RPC 传到上层后按码分流），不能只有文案。
  await assert.rejects(
    () => squadRuntimeService.createWakeRule(WS, everyMinute(item.id)),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "squad_dispatch_disabled");
      return true;
    },
    "创建规则 = 未来派发的准备 ⇒ 关掉开关后必须被拒",
  );
  // resume 被拒：恢复 = 让未来的派发重新可能 ⇒ 与 create 同一处判据。
  await assert.rejects(
    () => squadRuntimeService.resumeWakeRule(WS, { id: created.id }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "squad_dispatch_disabled");
      return true;
    },
  );
  // pause / list 仍可用：停下与查看不是新派发（§5.7.6 只停新派发）。
  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });
  const listed = await squadRuntimeService.listWakeRules(WS);
  assert.deepEqual(
    listed.map((rule) => rule.id),
    [created.id],
    "关掉开关后仍应能查看有哪些规则（收尾/复盘所需的视野）",
  );
});

test("listWakeRules：只回本 workspace 的规则；目标原样透传；已归档工作项的规则不列出", async () => {
  const { squadRuntimeService, createRuntime, db, seenTargets } = await makeService();
  const wsA = target("ws-a");
  const wsB = target("ws-b");
  const itemA = await makeWorkItem(squadRuntimeService, wsA, "A 的工作项");
  const itemB = await makeWorkItem(squadRuntimeService, wsB, "B 的工作项");
  const ruleA = await squadRuntimeService.createWakeRule(wsA, everyMinute(itemA.id));
  const ruleB = await squadRuntimeService.createWakeRule(wsB, everyMinute(itemB.id));

  assert.deepEqual(
    (await squadRuntimeService.listWakeRules(wsA)).map((rule) => rule.id),
    [ruleA.id],
    "A 只看见 A 的规则（wake_rules 没有 workspace 列，归属经工作项反查）",
  );
  assert.deepEqual(
    (await squadRuntimeService.listWakeRules(wsB)).map((rule) => rule.id),
    [ruleB.id],
  );

  // 目标纪律：四个方法把调用方给的**同一个**目标原样交给 runtime（没有隐式默认 workspace）。
  seenTargets.length = 0;
  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "ws-a" };
  const ruleGiven = await squadRuntimeService.createWakeRule(given, everyMinute(itemA.id));
  await squadRuntimeService.listWakeRules(given);
  await squadRuntimeService.pauseWakeRule(given, { id: ruleGiven.id });
  await squadRuntimeService.resumeWakeRule(given, { id: ruleGiven.id });
  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|ws-a", "/tmp/given-ws|ws-a", "/tmp/given-ws|ws-a", "/tmp/given-ws|ws-a"],
    "四次调用都必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );

  // 已归档工作项的规则**不列出**（登记口径）：listByWorkspace 的口径是「归档行视同不存在」，
  // 而 wake_rules 没有 workspace 列可反查 ⇒ 这类规则无法归属到任何 workspace，列不出来。
  // 它们同时**不可派发**（host 对归档工作项解析不到 workspace ⇒ 触发时响亮失败），不是静默死配置。
  db.prepare("UPDATE work_items SET archived_at = ? WHERE id = ?").run(Date.now(), itemA.id);
  assert.deepEqual(
    (await squadRuntimeService.listWakeRules(wsA)).map((rule) => rule.id),
    [],
    "工作项归档后，它的规则从本 workspace 的列表里消失（数据仍在库里，见下）",
  );
  const runtime = await createRuntime(wsA);
  const allIds = runtime.wakeRuleRepo.listAll().map((rule) => rule.id);
  assert.ok(
    allIds.includes(ruleA.id) && allIds.includes(ruleGiven.id) && allIds.includes(ruleB.id),
    "规则本身是数据：工作项归档不删除规则行（listAll 仍读得到）",
  );
  assert.deepEqual(
    (await squadRuntimeService.listWakeRules(wsB)).map((rule) => rule.id),
    [ruleB.id],
    "一个 workspace 的工作项归档不影响另一个 workspace 的列表",
  );
});
