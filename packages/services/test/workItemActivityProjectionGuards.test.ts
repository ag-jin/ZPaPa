import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WORK_ITEM_ACTIVITY_KINDS } from "../src/workitem/workItemActivityRepo.js";
import { computeDeliverableRegisteredDedupKey } from "../src/workitem/workItemActivityProjector.js";

/* C3b.1：投影模块的**结构负向守卫**（设计 §4.4 / §7；形态照 C3.1 的 `workItemDecisionGuards`）。

   本卡的核心承诺不是「投影不派发」这句注释，而是**依赖集封顶** —— 投影模块只拿
   activities + now + logWarn，结构上碰不到派发面 / 状态机 / 台账 repo。类型能挡住构造，
   但挡不住有人改了类型再注入，故这里在源码层再兜一道（扫描的 token 是**语义 token**，
   去注释后比对：fmt 往返不误红）。 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORKITEM_DIR = resolve(SRC_ROOT, "workitem");
const readSource = (file: string) => readFileSync(resolve(SRC_ROOT, file), "utf8");
/** 去注释再扫（文件头注释里会引用这些词作为「不得出现」的说明）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PROJECTOR_SRC = readSource("workitem/workItemActivityProjector.ts");
const PROJECTOR_CODE = stripComments(PROJECTOR_SRC);

test("G1｜投影模块零派发 / 零状态机 / 零台账 repo / 零 SQL：拿不到也调不动", () => {
  for (const forbidden of [
    // 派发面
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "publishDispatchRequest",
    "assertDispatchEnabled",
    "settleCommentDispatchReceipt",
    "emitWorkItemEvent",
    // 状态机（状态的唯一写者是 WorkItemService.transition，§5.2）
    "transition",
    "updateStatus",
    "workItemService",
    // 台账读写面（投影不读不写 squad_runs）
    "createSquadRunRepo",
    "SquadRunRepo",
    "runSettlementHub",
    // 存储直写（唯一存储写口是 activities repo 的既有契约）
    "db.prepare",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
  ]) {
    assert.ok(
      !PROJECTOR_CODE.includes(forbidden),
      `workItemActivityProjector.ts 不得出现 ${forbidden}（投影是事实落地后的下行记录，` +
        "不给协作链一丝驱动力：结构上就没有这些依赖）",
    );
  }
});

test("G2｜依赖集封顶：注入面恰是 activities / now / logWarn（加 runs/stateMachine 即编译错 + 本守卫红）", () => {
  const marker = "export function createWorkItemActivityProjector(deps: {";
  const block = PROJECTOR_SRC.slice(PROJECTOR_SRC.indexOf(marker) + marker.length);
  const end = block.indexOf("\n}): WorkItemActivityProjector {");
  assert.ok(end > 0, "找不到 createWorkItemActivityProjector 的 deps 类型块");
  const names = [...block.slice(0, end).matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(names)].sort(),
    ["activities", "logWarn", "now"],
    "依赖集封顶是结构红线：加任何一个新注入位（尤其 runs / workItemService）都要先答「它凭什么在这儿」",
  );
});

test("G3｜十一枚 dedupKey 单源：每个纯函数在 workitem/** 恰一处定义，实现体内不拼第二份形状", () => {
  const keyFunctions = [
    "computeStatusChangedDedupKey",
    "computeAssigneeChangedDedupKey",
    "computeRunStartedDedupKey",
    "computeRunCompletedDedupKey",
    "computeRunFailedDedupKey",
    "computeRunCancelledDedupKey",
    "computeRunRejectedDedupKey",
    "computeWorktreeCreatedDedupKey",
    "computeWorktreeMergedDedupKey",
    "computeWorktreeDiscardedDedupKey",
    /* 第 20 枚的**回声键**（D1a 只落键函数，投影接线归 D1b）：形状单源与十枚同一条纪律。 */
    "computeDeliverableRegisteredDedupKey",
  ];
  const files = readdirSync(WORKITEM_DIR).filter((name) => name.endsWith(".ts"));
  for (const name of keyFunctions) {
    const defining = files.filter((file) =>
      readSource(`workitem/${file}`).includes(`export function ${name}(`),
    );
    assert.deepEqual(defining, ["workItemActivityProjector.ts"], `${name} 必须只有一处定义`);
  }

  // 去掉这些定义后，实现体不得再出现键字面量前缀（第二份形状）。
  let body = PROJECTOR_CODE;
  for (const name of keyFunctions) {
    body = body.replace(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}\\n`), "");
  }
  assert.ok(
    !/`(?:status|assignee|run|deliverable):/.test(body),
    "dedupKey 形状只能来自上述纯函数：实现体内不得内联 `status:` / `assignee:` / `run:` / `deliverable:` 拼接",
  );
});

test("G4｜kind 面按裁定扩至十一枚：投影只产十一枚 kind（comment_*/decision_created/wake_rule_fired 一律不得出现）", () => {
  // 只认**成行的** `kind: "<字面量>",`（append 的实参位）：系统主体的 `{ kind: "system" }` 在同行的
  // 单行字面量里，不该被算进「投影产出的 kind 面」。
  const kinds = [...PROJECTOR_CODE.matchAll(/^\s+kind: "([a-z_]+)"/gm)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(kinds)].sort(),
    [
      "assignee_changed",
      "deliverable_registered",
      "run_cancelled",
      "run_completed",
      "run_failed",
      "run_rejected",
      "run_started",
      "status_changed",
      "worktree_created",
      "worktree_discarded",
      "worktree_merged",
    ],
    "投影的 kind 面 = 十一枚（20 值闭集：第 19 枚 run_rejected 是 2026-10-08 用户裁定的加法，" +
      "第 20 枚 deliverable_registered 由 #7 D1b 接上投影臂 —— 登记一条交付物即时间线一枚，" +
      "actor 按交付物行取，人工登记与自动捕获在时间线上分得开）；" +
      "仍不越界写评论/决定族的事实",
  );
  // 反向：投影产出的每枚 kind 都必须在服务面闭集内（扩了这里而忘了闭集 ⇒ 写入时响亮抛）。
  for (const kind of new Set(kinds)) {
    assert.ok(
      (WORK_ITEM_ACTIVITY_KINDS as readonly string[]).includes(kind),
      `投影产出的 ${kind} 必须在 WORK_ITEM_ACTIVITY_KINDS 闭集内`,
    );
  }
});

test("G5｜接线钉死（结构面）：组合根恒构造投影器并交给工作项服务与 run lifecycle（防「忘了接线、只留 warn」）", () => {
  const runtimeCode = stripComments(readSource("workitem/squadRuntime.ts"));
  assert.ok(
    runtimeCode.includes("createWorkItemActivityProjector("),
    "createSquadRuntime 必须构造投影器（漏接的表现是时间线永远只有评论，而一路不报错）",
  );
  const start = runtimeCode.indexOf("const workItemService = createWorkItemService({");
  assert.ok(start > 0, "组合根必须以 createWorkItemService 装配工作项服务");
  // 只取**这一段**实参块（到其收尾行 `  });` 为止）：不这么切会让下方 returned object 里的
  // `activityProjector,` 满足正则，从而把「空接线」放行（变异 6 实测踩过）。
  const depsBlock = runtimeCode.slice(start, runtimeCode.indexOf("\n  });", start));
  assert.match(
    depsBlock,
    /^\s+activityProjector,$/m,
    "投影器必须以**简写属性原样**交给 createWorkItemService（`activityProjector: undefined` 这类空接线不算接通）",
  );
  // C3b.2：同一个投影器还要交给 run lifecycle（run / worktree 七枚的唯一投影入口）。
  const lifecycleStart = runtimeCode.indexOf("const lifecycle = createRunLifecycle({");
  assert.ok(lifecycleStart > 0, "组合根必须以 createRunLifecycle 装配生命周期");
  const lifecycleDeps = runtimeCode.slice(
    lifecycleStart,
    runtimeCode.indexOf("\n        });", lifecycleStart),
  );
  assert.match(
    lifecycleDeps,
    /^\s+activityProjector,$/m,
    "投影器必须以简写属性原样交给 createRunLifecycle（漏接的表现是 run 族时间线永远空白）",
  );
});

/* ---------- C3b.2：run / worktree 族的结构守卫 ---------- */

const LIFECYCLE_SRC = readSource("workitem/squadRunLifecycle.ts");
const LIFECYCLE_CODE = stripComments(LIFECYCLE_SRC);

test("G6｜run 族接线钉死（结构面）：投影调用恰经注入面 deps.activityProjector，构造点唯一在组合根", () => {
  assert.ok(
    LIFECYCLE_CODE.includes("deps.activityProjector"),
    "squadRunLifecycle 必须从注入面取投影器（第二处构造会让键形状 / payload 判据分叉）",
  );
  assert.ok(
    !LIFECYCLE_CODE.includes("createWorkItemActivityProjector("),
    "lifecycle 不得自建投影器：唯一构造点在组合根（漏接的表现是 run 族时间线永远空白）",
  );
  // 两个落点：noteRunOpened 的 runStarted（开跑族）与 settleStatus 的 runSettled（终态族）。
  assert.equal(
    [...LIFECYCLE_CODE.matchAll(/deps\.activityProjector\?\.runStarted\(/g)].length,
    1,
    "runStarted 只准经 noteRunOpened 一个落点",
  );
  assert.equal(
    [...LIFECYCLE_CODE.matchAll(/deps\.activityProjector\?\.runSettled\(/g)].length,
    1,
    "runSettled 只准落在 settleStatus 唯一收口（分散挂会漏掉编排器 / UI 审查路径）",
  );
  /* 开跑族的**五个出口**（四个 member `opened` + 队长 `recorded:true` 出口）都经 noteRunOpened：
     5 处调用 + 1 处定义。少一处 = 某个出口静默不投影（时间线缺一枚且不报错）；
     多一处 = 新出口必须显式回答「它算不算开跑」（排队 / 等待 / 重投都不算）。 */
  assert.equal(
    [...LIFECYCLE_CODE.matchAll(/noteRunOpened\(/g)].length,
    6,
    "noteRunOpened 恰五处调用 + 一处定义",
  );
});

test("G7｜reason 映射单源：lifecycle 不内联 user_cancel / 看门狗族字面量，只经 runSettleIntentForFailureReason", () => {
  for (const literal of [
    '"user_cancel"',
    '"watchdog_dead_session"',
    '"watchdog_ttl"',
    '"watchdog_idle_stop_grace_expired"',
  ]) {
    assert.ok(
      !LIFECYCLE_CODE.includes(literal),
      `squadRunLifecycle 不得内联 ${literal}：码值单源在 squadRunRepo、映射单源在投影模块，` +
        "内联比较会让「哪些原因算看门狗结算」分叉而不报错",
    );
  }
  assert.ok(
    LIFECYCLE_CODE.includes("runSettleIntentForFailureReason("),
    "失败出口必须经 runSettleIntentForFailureReason 声明意图（内联比较即第二份判据）",
  );
  const files = readdirSync(WORKITEM_DIR).filter((name) => name.endsWith(".ts"));
  const defining = files.filter((file) =>
    readSource(`workitem/${file}`).includes("export function runSettleIntentForFailureReason("),
  );
  assert.deepEqual(defining, ["workItemActivityProjector.ts"], "映射函数只准有一处定义");
});

test("G8｜第 20 枚回声键：computeDeliverableRegisteredDedupKey 由交付物 id 派生（形状冻结）", () => {
  // 键由**交付物 id** 派生（设计 §3.4）：一次登记一条回声，重投同键由唯一索引咬住。
  assert.equal(
    computeDeliverableRegisteredDedupKey("deliverable-run-1-diff"),
    "deliverable:deliverable-run-1-diff:registered",
  );
  assert.equal(
    computeDeliverableRegisteredDedupKey("deliverable-wi-1-batch-diff"),
    "deliverable:deliverable-wi-1-batch-diff:registered",
  );
  // 纯函数：同输入两次调用逐字节相同（无时钟、无 IO）——回声键不得带 `<ms>`：
  // 一条交付物只登记一次，「同一事实两枚回声」不是合法状态。
  assert.equal(
    computeDeliverableRegisteredDedupKey("d-1"),
    computeDeliverableRegisteredDedupKey("d-1"),
  );
});
