import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateWakeRule } from "@zcode/shared";
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

/* 唤醒规则的**编辑与删除**（P2b 收口：规则能改配置、能删）用例。
   装配照 `squadWakeRules.test.ts` / `squadRosterManagement.test.ts` 的同一先例：真实 git 仓库 +
   `:memory:` sqlite + 真实 runtime + 真实服务面 —— 不给服务面塞桩，否则断言的是桩的行为。

   本轮的点亮判据（编辑后规则必须**真的**按新配置排期并被 `listReady` 扫到）与三条硬口径：
   · **revision +1**（§5.7 fencing：过期 revision 的调度推进自动作废，靠的就是每次实质编辑 bump）；
   · **kind 切换清旧字段**（every→cron 不得留下 interval_seconds，库列必须是 NULL）；
   · **死配置不落盘**（改成一个永不触发的配置 ⇒ 响亮抛且整行原样）。

   口径纪律：目标 workspace **显式构造**并用 `seenTargets` 证明 update / delete 把**调用方给的**
   目标原样交给 runtime（没有隐式默认 workspace）；门禁（update 过、delete 不过）逐条钉住。 */

const target = (identity: string): SquadWorkspaceTarget => ({
  path: `/tmp/${identity}`,
  identity,
});

/** 真实 runtime + 真实服务面；`wrapRuntime` 供「读到写之间的并发」用例注入确定性时序（else 不用）。 */
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

/** 编辑补丁：一条每 10 秒的连续规则（只含 patch 该有的字段 —— 不含 workItemId）。 */
const everyTenSeconds = {
  kind: "every" as const,
  mode: "continuous" as const,
  intervalSeconds: 10,
};

const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

/* 首格排期的断言容差：服务内部的 `now` 在测试抓的 `before` **之后**（构造 runtime 要 ~20ms 级），
   而落点 = 内部 now + 一个间隔 ⇒ 按 `before + interval` 严卡上界会差几十毫秒。只放宽上界，
   下界（严格未来）仍严卡。 */
const SCHEDULE_SLACK_MS = 5_000;

test("点亮判据：every/60s → every/10s ⇒ 新间隔落库、nextFireAt 重算、revision+1、listReady 命中", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);
  const before = runtime.wakeRuleRepo.get(created.id)!;
  const beforeUpdate = Date.now();

  const updated = await squadRuntimeService.updateWakeRule(WS, {
    id: created.id,
    patch: everyTenSeconds,
  });

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.kind, "every");
  assert.equal(after.mode, "continuous");
  assert.equal(after.intervalSeconds, 10, "新间隔必须落库");
  assert.equal(after.revision, before.revision + 1, "§5.7 fencing：实质编辑 revision +1");
  assert.equal(updated.nextFireAt, after.nextFireAt, "返回值与库中实体一致（读回口径）");

  const nextFireAt = after.nextFireAt;
  assert.ok(
    typeof nextFireAt === "number" &&
      nextFireAt > beforeUpdate &&
      nextFireAt - beforeUpdate <= 10_000 + SCHEDULE_SLACK_MS,
    `重算后的首格应落在编辑时刻之后、一个间隔（10s + 容差）之内（实际 ${String(nextFireAt)}）`,
  );
  assert.ok(
    nextFireAt < before.nextFireAt!,
    "必须按新间隔重算（旧的 60s 网格点已被替换，不是原样保留）",
  );
  // 调度器到点扫描的**同一 SQL 口径**：重排后的到点时刻必能命中它。
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(nextFireAt, 100).map((rule) => rule.id),
    [created.id],
    "编辑后仍被调度器到点扫描命中（点亮判据）",
  );
  // 到点**之前**不得被命中（落的是未来排期点，不是「编辑即到点」）。
  assert.deepEqual(runtime.wakeRuleRepo.listReady(nextFireAt - 1, 100), []);
});

test("kind 切换：every → cron ⇒ 旧 interval_seconds 被清（库列 NULL）、新表达式落库、产物过 validateWakeRule", async () => {
  const { squadRuntimeService, createRuntime, db } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  await squadRuntimeService.updateWakeRule(WS, {
    id: created.id,
    patch: { kind: "cron", mode: "continuous", cronExpression: "*/5 * * * *" },
  });

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.kind, "cron");
  assert.equal(after.cronExpression, "*/5 * * * *");
  assert.equal(
    after.intervalSeconds,
    undefined,
    "旧 kind 的排期字段必须被清掉（两种调度口径并存的脏形状会被 validateWakeRule 拒）",
  );
  // 读的是**库列**（不是内存里的假清）：旧列必须是 NULL。
  const raw = db
    .prepare("SELECT interval_seconds, cron_expression FROM wake_rules WHERE id = ?")
    .get(created.id) as { interval_seconds: unknown; cron_expression: unknown };
  assert.equal(raw.interval_seconds, null, "interval_seconds 列必须被写成 NULL");
  assert.equal(raw.cron_expression, "*/5 * * * *");
  // 产物（读回实体）过域模型校验（互斥第 7 条：旧字段若还在这里会红）。
  assert.deepEqual(validateWakeRule(after), { ok: true });

  const nextFireAt = after.nextFireAt;
  assert.ok(typeof nextFireAt === "number", "切换 kind 后必须重算排期点");
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(nextFireAt, 100).map((rule) => rule.id),
    [created.id],
    "cron 的新首格也被到点扫描命中",
  );
});

test("版本栅栏：读到写之间调度器推进了一格（revision+1）⇒ CAS 未命中，响亮抛且不改行", async () => {
  /* 确定性时序：用 runtime 包装器在**服务面读到现行之后**立即用读到的那一版推进一格
     （模拟调度器刚 fire 并推进）。此后服务面的 casUpdateConfig 用旧 revision 作前置 ⇒ 必未命中。
     这是「读到写之间被并发改动」的精确复刻 —— 真实竞态不可按需触发，包装器只改时序不改语义。 */
  let armAfterRead = false;
  const { squadRuntimeService, createRuntime } = await makeService({
    wrapRuntime: (runtime) => ({
      ...runtime,
      wakeRuleRepo: {
        ...runtime.wakeRuleRepo,
        get: (id: string) => {
          const rule = runtime.wakeRuleRepo.get(id);
          if (rule !== null && armAfterRead) {
            armAfterRead = false; // 只抢一次（一次并发推进）
            assert.equal(
              runtime.wakeRuleRepo.casAdvance(
                rule.id,
                rule.revision,
                rule.nextFireAt ?? null,
                rule.fireCount,
              ),
              true,
            );
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
    () => squadRuntimeService.updateWakeRule(WS, { id: created.id, patch: everyTenSeconds }),
    /CAS 未命中/,
    "读到 revision R、写盘前调度器推进到 R+1 ⇒ 编辑必须响亮抛（静默盖写会把那一格推进吞掉）",
  );

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.revision, before.revision + 1, "并发推进生效（revision +1）");
  assert.equal(after.intervalSeconds, 60, "编辑**没有**盖上去（旧配置仍在）");

  /* 重读后再试 —— 这也是「CAS 未命中 ⇒ 请重读后再试」的复位路径：这次必须成功，且**恰好 bump 一次**。
     M1 变异（`casUpdateConfig` 不 bump revision）命中本条：成功写盘却不推进 revision ⇒ 调度器
     读到的那一版与新配置同号，过期派发不会被作废。 */
  const retryBefore = runtime.wakeRuleRepo.get(created.id)!;
  await squadRuntimeService.updateWakeRule(WS, { id: created.id, patch: everyTenSeconds });
  const retried = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(
    retried.revision,
    retryBefore.revision + 1,
    "§5.7 fencing：编辑成功的那一次恰好 revision +1（否则过期派发不会被作废）",
  );
  assert.equal(retried.intervalSeconds, 10, "重读后再试生效（新配置落库）");
});

test("保留项：编辑不改 enabled / pausedReason / fireCount（暂停中编辑 ⇒ 排期保持空；恢复时重算）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  // 造「已触发 5 次」的形态（casAdvance 是调度推进的同一写入口），再走用户暂停。
  const initial = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(runtime.wakeRuleRepo.casAdvance(created.id, initial.revision, null, 5), true);
  await squadRuntimeService.pauseWakeRule(WS, { id: created.id });
  const paused = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(paused.enabled, false);
  assert.equal(paused.fireCount, 5);

  await squadRuntimeService.updateWakeRule(WS, {
    id: created.id,
    patch: { kind: "every", mode: "continuous", intervalSeconds: 30 },
  });

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.enabled, false, "编辑不改用户开关（开关归 pause / resume）");
  assert.equal(after.pausedReason, undefined, "用户暂停不产生闸原因，编辑也不许造一个出来");
  assert.equal(after.fireCount, 5, "触发计数原样保留（不重置、不清零）");
  assert.equal(after.intervalSeconds, 30, "配置确实改了（不是整段 no-op）");
  assert.equal(after.nextFireAt, undefined, "暂停中编辑不改排期（排期保持空）");
  assert.equal(after.revision, paused.revision + 1, "编辑是一次真实写盘（CAS 推进 revision）");
  assert.deepEqual(runtime.wakeRuleRepo.listReady(FAR_FUTURE, 100), [], "暂停中不会被扫到");

  // 恢复路径本就重算：resume 后落在**新**间隔的网格上（编辑没白改）。
  const beforeResume = Date.now();
  await squadRuntimeService.resumeWakeRule(WS, { id: created.id });
  const resumed = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(resumed.enabled, true);
  const nextFireAt = resumed.nextFireAt;
  assert.ok(
    typeof nextFireAt === "number" &&
      nextFireAt > beforeResume &&
      nextFireAt - beforeResume <= 30_000 + SCHEDULE_SLACK_MS,
    `恢复必须按新间隔（30s）重算（实际 ${String(nextFireAt)}）`,
  );
});

test("闸态保留：闸暂停（pausedReason + 排期空）中编辑 ⇒ 闸原因原样、排期仍空、开关仍开（不被悄悄重新武装）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);

  // 模拟「闸暂停」的落库形态（与调度器同一写入口：casAdvance 带 pausedReason、排期置空）。
  const initial = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(
    runtime.wakeRuleRepo.casAdvance(created.id, initial.revision, null, initial.fireCount, "rate"),
    true,
  );
  assert.equal(runtime.wakeRuleRepo.get(created.id)!.pausedReason, "rate");

  await squadRuntimeService.updateWakeRule(WS, {
    id: created.id,
    patch: { kind: "every", mode: "continuous", intervalSeconds: 30 },
  });

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.equal(after.pausedReason, "rate", "编辑不伪造也不清除闸原因（封闭枚举，写码 = 假数据）");
  assert.equal(after.enabled, true, "闸暂停不动用户开关");
  assert.equal(
    after.nextFireAt,
    undefined,
    "闸态 = pausedReason + 排期空：编辑不得把被闸停的规则悄悄重新排上（否则界面显示「防失控已停」而它其实会再触发）",
  );
  assert.deepEqual(
    runtime.wakeRuleRepo.listReady(FAR_FUTURE, 100),
    [],
    "编辑一次不能成为绕过闸的重新武装路径（复位走 resume）",
  );
});

test("死配置：把 at 改成过去时刻 ⇒ 响亮抛且整行未变（逐字段对照）", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, {
    workItemId: item.id,
    kind: "at",
    mode: "once",
    at: Date.now() + 3_600_000,
  });
  const runtime = await createRuntime(WS);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  await assert.rejects(
    () =>
      squadRuntimeService.updateWakeRule(WS, {
        id: created.id,
        patch: { kind: "at", mode: "once", at: Date.now() - 1_000 },
      }),
    /死配置/,
    "改成过去时刻 = 改后永不触发 ⇒ 与 create 同口径响亮抛",
  );

  const after = runtime.wakeRuleRepo.get(created.id)!;
  assert.deepEqual(after, before, "响亮抛时整行保持原样（逐字段对照：连 revision 都没动）");
});

test("校验不过 ⇒ 响亮抛（中文 problems 原样带出）且不写盘", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const runtime = await createRuntime(WS);
  const before = runtime.wakeRuleRepo.get(created.id)!;

  // 混装调度字段（两种调度口径并存 ⇒ 另一种永不生效）。
  await assert.rejects(
    () =>
      squadRuntimeService.updateWakeRule(WS, {
        id: created.id,
        patch: {
          kind: "every",
          mode: "continuous",
          intervalSeconds: 60,
          cronExpression: "* * * * *",
        },
      }),
    /不得携带调度字段「cronExpression」/,
    "problems 必须原样来自 validateWakeRule（组装层不另写判据）",
  );
  // kind × mode 互斥打架。
  await assert.rejects(
    () =>
      squadRuntimeService.updateWakeRule(WS, {
        id: created.id,
        patch: { kind: "every", mode: "once", intervalSeconds: 60 },
      }),
    /kind「every」只能配 mode「continuous」/,
  );
  // maxFires 越界（同一份域模型判据）。
  await assert.rejects(
    () =>
      squadRuntimeService.updateWakeRule(WS, {
        id: created.id,
        patch: { kind: "every", mode: "continuous", intervalSeconds: 60, maxFires: 1001 },
      }),
    /maxFires 必须在 1\.\.1000 之间/,
  );

  assert.deepEqual(runtime.wakeRuleRepo.get(created.id), before, "校验不过一行都不许写");
});

test("编辑：id 不存在 ⇒ 响亮抛（静默 no-op 会让界面以为保存成功了）", async () => {
  const { squadRuntimeService } = await makeService();
  await assert.rejects(
    () => squadRuntimeService.updateWakeRule(WS, { id: "不存在", patch: everyTenSeconds }),
    /不存在或读不回来/,
  );
});

test("删除：行消失（get 回 null、listAll 少一条）；不存在 ⇒ 响亮抛", async () => {
  const { squadRuntimeService, createRuntime } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const ruleA = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));
  const ruleB = await squadRuntimeService.createWakeRule(WS, {
    workItemId: item.id,
    kind: "every",
    mode: "continuous",
    intervalSeconds: 120,
  });
  const runtime = await createRuntime(WS);
  assert.equal(runtime.wakeRuleRepo.listAll().length, 2);

  await squadRuntimeService.deleteWakeRule(WS, { id: ruleA.id });

  assert.equal(runtime.wakeRuleRepo.get(ruleA.id), null, "行必须消失（get 回 null）");
  assert.deepEqual(
    runtime.wakeRuleRepo.listAll().map((rule) => rule.id),
    [ruleB.id],
    "listAll 少一条，且不影响别的规则",
  );
  await assert.rejects(
    () => squadRuntimeService.deleteWakeRule(WS, { id: ruleA.id }),
    /不存在或读不回来/,
    "重复删除 / 删除不存在的 id ⇒ 响亮抛（彻底删净后重删不是成功）",
  );
});

test("门禁：关掉开关 ⇒ updateWakeRule 被拒（稳定码）；deleteWakeRule 仍可用（不过门禁）", async () => {
  const { squadRuntimeService, createRuntime, setExperimentEnabled } = await makeService();
  const item = await makeWorkItem(squadRuntimeService);
  const created = await squadRuntimeService.createWakeRule(WS, everyMinute(item.id));

  setExperimentEnabled(false);

  await assert.rejects(
    () => squadRuntimeService.updateWakeRule(WS, { id: created.id, patch: everyTenSeconds }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "squad_dispatch_disabled");
      return true;
    },
    "编辑让未来派发变样 ⇒ 与 create / resume 同一处门禁、同一稳定码",
  );

  // 删除**不过门禁**：关掉实验开关后仍应能清掉配错的规则（删掉 = 未来派发减少）。
  await squadRuntimeService.deleteWakeRule(WS, { id: created.id });
  const runtime = await createRuntime(WS);
  assert.equal(
    runtime.wakeRuleRepo.get(created.id),
    null,
    "关着开关也能删（配错一条 cron 的出路）",
  );
});

test("目标纪律：update / delete 把调用方给的目标原样交给 runtime（没有隐式默认 workspace）", async () => {
  const { squadRuntimeService, seenTargets } = await makeService();
  const wsA = target("ws-a");
  const item = await makeWorkItem(squadRuntimeService, wsA, "A 的工作项");
  const created = await squadRuntimeService.createWakeRule(wsA, everyMinute(item.id));

  seenTargets.length = 0;
  const given: SquadWorkspaceTarget = { path: "/tmp/given-ws", identity: "ws-a" };
  await squadRuntimeService.updateWakeRule(given, {
    id: created.id,
    patch: everyTenSeconds,
  });
  await squadRuntimeService.deleteWakeRule(given, { id: created.id });
  assert.deepEqual(
    seenTargets,
    ["/tmp/given-ws|ws-a", "/tmp/given-ws|ws-a"],
    "两次调用都必须带着调用方显式给的目标（原样透传，不挑不猜）",
  );
});

/* 守卫（单一来源）：update 路径**复用**既有的组装 / 校验 / 首格排期 / CAS 文案，
   不另写第二份校验或排期（第二份判据会与域模型漂移，而漂移不报错）。
   变异：把 updateWakeRule 里对 assembleWakeRule / validateWakeRule / initialNextFireAt 的调用换成
   就地新写的实现（或复制一份）⇒ 本守卫必红。 */
test("守卫｜update 复用 assembleWakeRule / validateWakeRule / initialNextFireAt / casMissError", () => {
  const sourcePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../src/workitem/squadWakeRules.ts",
  );
  const source = readFileSync(sourcePath, "utf8");
  const updateAt = source.indexOf("async updateWakeRule(");
  const deleteAt = source.indexOf("async deleteWakeRule(");
  assert.ok(updateAt >= 0 && deleteAt > updateAt, "两个方法都在实现文件里");
  const updateBody = source.slice(updateAt, deleteAt);
  for (const call of [
    "assembleWakeRule(",
    "validateWakeRule(",
    "initialNextFireAt(",
    "noFutureScheduleReason(",
    "casMissError(",
    "casUpdateConfig(",
  ]) {
    assert.ok(
      updateBody.includes(call),
      `updateWakeRule 必须复用 ${call}（另写一份校验 / 排期 = 第二份判据）`,
    );
  }
  const deleteBody = source.slice(deleteAt);
  assert.ok(deleteBody.includes("remove("), "deleteWakeRule 必须经 repo 的 remove（不拼裸 SQL）");
  assert.ok(
    !deleteBody.includes("assertEnabled"),
    "deleteWakeRule 不过门禁（删掉 = 未来派发减少）",
  );
});
