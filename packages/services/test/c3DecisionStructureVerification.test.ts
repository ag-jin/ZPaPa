import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CommentService } from "../src/workitem/commentService.js";
import { createWorkItemCollaborationService } from "../src/workitem/workItemCollaborationService.js";
import type { WorkItemDecisionRecord } from "../src/workitem/workItemDecisionRepo.js";
import type { WorkItemDecisionService } from "../src/workitem/workItemDecisionService.js";
import type { AuthorRef } from "../src/workitem/workItemCommentRepo.js";
import type { SquadRuntime } from "../src/workitem/squadContracts.js";
import type { SquadWorkspaceTarget } from "../src/workitem/squadRuntimeService.js";

/* C3 线独立复验（test-verifier）：C3.1 的**结构红线**与**门面转发**，外加「第五写入口不扰动评论四入口」。
 *
 * 这一份不看行为，只看两件事能不能被违反：
 * ① 决定链**结构上**拿不到 run / receipt / 义务 / 状态机（依赖集封顶——不是靠注释承诺）；
 * ② 门面只做「写到哪、谁写的」，父规则/闭集/幂等键单源在服务面，且评论四入口零改动。
 * 与实现者守卫的差别：这里同时扫**组合根**（node.ts 的构造块）与**门面 import 形态**，
 * 并用注入式 stub 抓门面实际转发的入参（不是读源码猜）。 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string) => readFileSync(resolve(SRC_ROOT, relative), "utf8");
/** 去注释（块 + 行）：错误文案里的词不算数，只有**代码**里的才算。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const DECISION_SOURCE = read("workitem/workItemDecisionService.ts");
const DECISION_CODE = stripComments(DECISION_SOURCE);
const FACADE_CODE = stripComments(read("workitem/workItemCollaborationService.ts"));
const COMPOSITION_ROOT = read("node.ts");
const INDEX_SOURCE = read("index.ts");

test("结构红线｜决定服务源码（去注释）零命中 run/receipt/义务/状态机/steering/SQL", () => {
  // 任何一个 token 出现，都意味着决定链拿到了不该拿的东西（或自己写了不该写的库）。
  for (const forbidden of [
    "runs",
    "receipts",
    "receiptRepo",
    "squadRunRepo",
    "squadDeferredDispatchRepo",
    "commentDispatchReceiptRepo",
    "deferred",
    "settleStatus",
    "settleCommentDispatchReceipt",
    "planDispatch",
    "openMemberRun",
    "recordLeaderRun",
    "discardBatch",
    "publishDispatchRequest",
    "assertDispatchEnabled",
    "workItemService",
    "transition",
    "updateStatus",
    "steer",
    "CommandInbox",
    "followupMode",
    "requestedDelivery",
    "admissionSeq",
    "interactionBehavior",
    "node:sqlite",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
  ]) {
    assert.equal(
      DECISION_CODE.includes(forbidden),
      false,
      `workItemDecisionService.ts 的代码里不得出现 ${forbidden}（决定不派发/不改状态/不碰 steering 必须是结构事实）`,
    );
  }
  // 允许的写入只有两个 repo 口（这正是「1 行决定 + 1 枚活动」的全部写入面）。
  assert.equal(
    DECISION_CODE.split(".add(").length - 1,
    2,
    "决定服务的写入面恰两处：decisions.add + activities.add",
  );
  assert.ok(DECISION_CODE.includes("deps.decisions.add("), "决定行走 repo 口");
  assert.ok(DECISION_CODE.includes("deps.activities.add("), "活动行走 repo 口");
});

test("结构红线｜deps 类型层封顶：WorkItemDecisionServiceDeps 恰 6 个属性（三 repo + 判据口 + 两注入口；加 runs/receipts 即编译错+本守卫红）", () => {
  const marker = "export type WorkItemDecisionServiceDeps = {";
  const start = DECISION_SOURCE.indexOf(marker);
  assert.ok(start > 0, "找不到依赖集类型声明");
  const block = DECISION_SOURCE.slice(start + marker.length);
  const end = block.indexOf("\n};");
  assert.ok(end > 0, "依赖集类型块没有正常收尾");
  const keys = [...block.slice(0, end).matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(keys)].sort(),
    // C4.1：本集新增 `accessPolicy`（§9 三轴的判据口 = 纯函数面，不是新 repo；决定写与四评论入口
    // 并列过同一判据面，即 C3 的交接义务）。除它以外**仍然恰三 repo + 两注入口**。
    ["accessPolicy", "activities", "decisions", "newId", "now", "workItems"],
    "依赖集封顶是结构红线（任务卡 §4.4-G7）：这里逐字列出唯一允许的属性集",
  );
  // 组合根的实际装配：只允许传三个 repo（now/newId 走默认）。
  const wiring = COMPOSITION_ROOT.slice(
    COMPOSITION_ROOT.indexOf("const createDecisionServiceFor ="),
  );
  const call = wiring.slice(wiring.indexOf("createWorkItemDecisionService({"));
  const callBlock = call.slice(0, call.indexOf("});"));
  for (const key of ["decisions:", "activities:", "workItems:"]) {
    assert.ok(callBlock.includes(key), `组合根必须注入 ${key}`);
  }
  for (const forbidden of ["runs:", "receipts:", "deferred:", "workItemService", "settle"]) {
    assert.equal(
      callBlock.includes(forbidden),
      false,
      `组合根不得给决定服务注入 ${forbidden}（封顶在装配点同样生效）`,
    );
  }
});

test("结构红线｜门面只以 import type 引用决定服务；根入口不值导出该模块（浏览器安全）", () => {
  const facade = read("workitem/workItemCollaborationService.ts");
  assert.ok(
    facade.includes('import type { WorkItemDecisionService } from "./workItemDecisionService.js";'),
    "门面必须用 import type 引用决定服务（其实现值导入 node:crypto，值导入会把 node 侧带进 renderer）",
  );
  assert.equal(
    /import\s*\{[^}]*\}\s*from\s*"\.\/workItemDecisionService\.js"/.test(
      stripComments(facade).replace(/import type[\s\S]*?from\s*"[^"]+"\s*;/g, ""),
    ),
    false,
    "门面不得值导入决定服务模块",
  );
  assert.equal(
    INDEX_SOURCE.includes('from "./workitem/workItemDecisionService.js"'),
    false,
    "根入口不得引用决定服务模块（值或类型都不需要：门面形状已覆盖）",
  );
  const exportTypeBlocks = [
    ...INDEX_SOURCE.matchAll(/export type \{([\s\S]*?)\} from "([^"]+)";/g),
  ];
  const owning = exportTypeBlocks.filter((match) =>
    match[1]!.includes("CreateWorkItemDecisionRequest"),
  );
  assert.equal(
    owning.length,
    1,
    "第五写入口的入参形状必须从根入口以 export type 出（UI 只命名形状，不构造身份）",
  );
  assert.equal(
    owning[0]![2],
    "./workitem/workItemCollaborationService.js",
    "形状来自门面模块（与评论四入口同族）",
  );
});

test("门面纪律｜经 requireDecisionService 恰调 createDecision；评论四方法原样（第五入口不得动它们）", () => {
  const decisionCalls = [...FACADE_CODE.matchAll(/requireDecisionService\(runtime\)\.(\w+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(decisionCalls)].sort(),
    ["createDecision"],
    "门面只有一个决定写口，且它只调服务面的 createDecision（不得自建/自写）",
  );
  const commentCalls = [...FACADE_CODE.matchAll(/requireCommentService\(runtime\)\.(\w+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...new Set(commentCalls)].sort(),
    ["addCommentReaction", "createComment", "setCommentResolved", "softDeleteComment"],
    "评论四入口的转发目标一字未变（C3 只加不改）",
  );
  assert.equal(
    [...FACADE_CODE.matchAll(/requireDecisionService\(runtime\)\./g)].length,
    1,
    "决定转发调用点恰一处",
  );
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "discardBatch",
    "settleCommentDispatchReceipt",
    "settleStatus",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    ".add(",
    "transition(",
    "updateStatus(",
  ]) {
    assert.equal(
      FACADE_CODE.includes(forbidden),
      false,
      `门面代码不得出现 ${forbidden}（写只转发给服务面，门面自己不碰库/状态机）`,
    );
  }
});

/* ---------- 门面转发：注入式 stub 抓真实入参 ---------- */

const RUNTIME_WS = { path: "/tmp/c3v-facade-runtime", identity: "c3v-facade-runtime" };
/** 诱饵目标：路径与身份都与 runtime 绑定值**不同** —— 用来证明调用方传的 target 不参与 key 计算。 */
const DECOY_TARGET = {
  workspacePath: "/tmp/c3v-decoy-caller-path",
  workspaceIdentity: "c3v-decoy-caller-identity",
} as unknown as SquadWorkspaceTarget;
const FACADE_HUMAN: AuthorRef = { kind: "human", id: "c3v-local-user" };
const RETURNED: WorkItemDecisionRecord = {
  id: "c3v-returned",
  workspaceKey: RUNTIME_WS.identity,
  workspacePath: RUNTIME_WS.path,
  workItemId: "wi-x",
  threadId: null,
  parentDecisionId: null,
  author: FACADE_HUMAN,
  sourceRunId: null,
  initiatedBy: FACADE_HUMAN,
  kind: "accepted",
  subject: "门面转发事项",
  selection: {},
  rationale: null,
  evidence: [],
  effectiveAt: 1,
  dedupKey: "decision:wi-x:门面转发事项:human:c3v-local-user:req-1",
  createdAt: 1,
  updatedAt: 1,
};

function facadeWithRecorders() {
  const decisionInputs: Record<string, unknown>[] = [];
  const comments: string[] = [];
  const decisionService = {
    createDecision(input: Record<string, unknown>) {
      decisionInputs.push(input);
      return RETURNED;
    },
  } as unknown as WorkItemDecisionService;
  const commentService = {
    createComment: () => {
      comments.push("createComment");
      return { comment: {}, dispatch: {} };
    },
    softDeleteComment: () => {
      comments.push("softDeleteComment");
      return {};
    },
    setCommentResolved: () => {
      comments.push("setCommentResolved");
      return {};
    },
    addCommentReaction: () => {
      comments.push("addCommentReaction");
      return {};
    },
  } as unknown as CommentService;
  const facade = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({
        boundWorkspace: RUNTIME_WS,
        workItemRepo: { getIncludingArchived: () => null },
      }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("本用例不该走读面");
    },
    localHumanActor: () => FACADE_HUMAN,
    createCommentService: () => commentService,
    createDecisionService: () => decisionService,
  });
  return { facade, decisionInputs, comments };
}

test("门面转发｜决定写：workspace 取 runtime 绑定值（target 不参与）、身份取注入值、形状原样透传且不二次包装", async () => {
  const { facade, decisionInputs, comments } = facadeWithRecorders();
  const result = await facade.createWorkItemDecision(DECOY_TARGET, {
    workItemId: "wi-x",
    kind: "superseded",
    subject: "门面转发事项",
    rationale: "理由",
    parentDecisionId: "c3v-parent",
    sourceRequestId: "req-1",
  });

  assert.equal(decisionInputs.length, 1, "恰一次转发");
  const received = decisionInputs[0]!;
  assert.equal(
    received.workspaceKey,
    RUNTIME_WS.identity,
    "workspaceKey 取 runtime 绑定值：调用方传的 target 不参与 key 计算（写错库的唯一入口被堵死）",
  );
  assert.equal(received.workspacePath, RUNTIME_WS.path, "workspacePath 同上");
  assert.notEqual(received.workspaceKey, "c3v-decoy-caller-identity", "诱饵 target 未被采用");
  assert.deepEqual(received.author, FACADE_HUMAN, "作者取组合根注入的本地人类身份（UI 零身份）");
  assert.deepEqual(received.initiatedBy, FACADE_HUMAN, "顶层人类归因同源");
  assert.equal(received.kind, "superseded", "kind 原样透传（闭集校验在服务面）");
  assert.equal(received.subject, "门面转发事项");
  assert.equal(received.rationale, "理由");
  assert.equal(received.parentDecisionId, "c3v-parent");
  assert.equal(received.sourceRequestId, "req-1", "幂等键原样透传（门面不得重造）");
  assert.equal(received.workItemId, "wi-x");
  assert.equal(result, RETURNED, "返回形状原样透传（不二次包装）");
  assert.deepEqual(comments, [], "第五写入口不得触碰评论服务");
});

test("门面转发｜缺省形状：未给 rationale/parentDecisionId 时不得凭空补字段；未注入工厂 ⇒ 响亮抛（不 no-op）", async () => {
  const { facade, decisionInputs } = facadeWithRecorders();
  await facade.createWorkItemDecision(DECOY_TARGET, {
    workItemId: "wi-x",
    kind: "proposal",
    subject: "只有必填",
    sourceRequestId: "req-2",
  });
  const received = decisionInputs[0]!;
  assert.deepEqual(
    Object.keys(received).sort(),
    [
      "author",
      "initiatedBy",
      "kind",
      "sourceRequestId",
      "subject",
      "workItemId",
      "workspaceKey",
      "workspacePath",
    ],
    "门面只补「写到哪、谁写的、谁的归因」，可选字段缺省就不传（不得凭空造 rationale/父引用）",
  );

  const bare = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ boundWorkspace: RUNTIME_WS, workItemRepo: {} }) as unknown as SquadRuntime,
    getRepos: () => {
      throw new Error("本用例不该走读面");
    },
    localHumanActor: () => FACADE_HUMAN,
  });
  await assert.rejects(
    () =>
      bare.createWorkItemDecision(DECOY_TARGET, {
        workItemId: "wi-x",
        kind: "proposal",
        subject: "没接通",
        sourceRequestId: "req-3",
      }),
    /未接通|createDecisionService/,
    "未注入决定服务 ⇒ 响亮抛（静默 no-op 会让用户以为决定已经记下来了）",
  );
  await assert.rejects(
    () =>
      bare.createWorkItemComment(DECOY_TARGET, {
        workItemId: "wi-x",
        body: "没接通",
        clientRequestId: "req-4",
      }),
    /未接通|createCommentService/,
    "评论四入口的缺失守卫原样（C3 未改动它）",
  );
});

test("回归｜评论四入口仍各自恰一次转发到评论服务，且决定写口不新增任何评论面调用", async () => {
  const { facade, comments, decisionInputs } = facadeWithRecorders();
  await facade.createWorkItemComment(DECOY_TARGET, {
    workItemId: "wi-x",
    body: "@某人",
    clientRequestId: "req-c1",
  });
  await facade.softDeleteWorkItemComment(DECOY_TARGET, { commentId: "c-1" });
  await facade.setWorkItemCommentResolved(DECOY_TARGET, { commentId: "c-1", resolved: true });
  await facade.addWorkItemCommentReaction(DECOY_TARGET, { commentId: "c-1", emoji: "👍" });
  assert.deepEqual(
    comments,
    ["createComment", "softDeleteComment", "setCommentResolved", "addCommentReaction"],
    "四个评论入口的转发目标与次序一字未变",
  );
  assert.deepEqual(decisionInputs, [], "评论入口不得触碰决定服务（两条链各自显式）");
});
