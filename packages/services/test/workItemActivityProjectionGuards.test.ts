import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("G3｜九枚 dedupKey 单源：每个纯函数在 workitem/** 恰一处定义，实现体内不拼第二份形状", () => {
  const keyFunctions = [
    "computeStatusChangedDedupKey",
    "computeAssigneeChangedDedupKey",
    "computeRunStartedDedupKey",
    "computeRunCompletedDedupKey",
    "computeRunFailedDedupKey",
    "computeRunCancelledDedupKey",
    "computeWorktreeCreatedDedupKey",
    "computeWorktreeMergedDedupKey",
    "computeWorktreeDiscardedDedupKey",
  ];
  const files = readdirSync(WORKITEM_DIR).filter((name) => name.endsWith(".ts"));
  for (const name of keyFunctions) {
    const defining = files.filter((file) =>
      readSource(`workitem/${file}`).includes(`export function ${name}(`),
    );
    assert.deepEqual(defining, ["workItemActivityProjector.ts"], `${name} 必须只有一处定义`);
  }

  // 去掉九个定义后，实现体不得再出现键字面量前缀（第二份形状）。
  let body = PROJECTOR_CODE;
  for (const name of keyFunctions) {
    body = body.replace(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}\\n`), "");
  }
  assert.ok(
    !/`(?:status|assignee|run):/.test(body),
    "dedupKey 形状只能来自九个纯函数：实现体内不得内联 `status:` / `assignee:` / `run:` 拼接",
  );
});

test("G4｜kind 面不扩：投影只产九枚 kind（comment_*/decision_created/wake_rule_fired 一律不得出现）", () => {
  // 只认**成行的** `kind: "<字面量>",`（append 的实参位）：系统主体的 `{ kind: "system" }` 在同行的
  // 单行字面量里，不该被算进「投影产出的 kind 面」。
  const kinds = [...PROJECTOR_CODE.matchAll(/^\s+kind: "([a-z_]+)"/gm)].map((match) => match[1]!);
  assert.deepEqual(
    [...new Set(kinds)].sort(),
    [
      "assignee_changed",
      "run_cancelled",
      "run_completed",
      "run_failed",
      "run_started",
      "status_changed",
      "worktree_created",
      "worktree_discarded",
      "worktree_merged",
    ],
    "投影的 kind 面 = 九枚（18 值闭集不动：不新造第 19 枚，也不越界写评论/决定族的事实）",
  );
});

test("G5｜接线钉死（结构面）：组合根恒构造投影器并交给工作项服务（防「忘了接线、只留 warn」）", () => {
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
});
