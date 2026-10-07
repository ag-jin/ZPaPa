import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COLLABORATION_ACCESS_DENY_REASONS,
  LOCAL_HUMAN_SUBJECT,
  SINGLE_USER_ACCESS_POLICY,
  canCommentWorkItem,
  canInvokeTarget,
  canViewWorkItem,
  collaborationAccessDeniedMessage,
  normalizeAccessSubject,
  resolveAccessSubject,
  type AccessSubject,
  type WorkItemAccessContext,
} from "../src/workitem/collaborationAccessPolicy.js";
import type { AuthorRef } from "../src/workitem/workItemCommentRepo.js";

/* 协作域 C4.1：协作访问判据模块（spec §9 三轴 + A2A 顶层人类归因 + Q7 主体规范化单源）。

   期望值全部是规格 / 任务卡的字面量（独立真源），不是「用实现再算一遍」：
   · 三轴名字与「不存在单个 canAccess / 第四轴」来自 §9（`394-410`）与任务卡 Q2 裁定；
   · 三个拒绝原因来自既有 receipt detail 词汇（§12.1-12 的 `dispatch_disabled` /
     `work_item_archived` / `agent_not_in_roster`）；
   · 矩阵逐格展开（不抽样）：恒真轴的价值恰在「每格都断言」——抽样会让「某格被悄悄改掉」漏网。 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const WORKITEM_DIR = resolve(SRC_ROOT, "workitem");
const POLICY_FILE = resolve(WORKITEM_DIR, "collaborationAccessPolicy.ts");
const POLICY_SRC = readFileSync(POLICY_FILE, "utf8");

/** 去注释再扫（文件头注释会引用 `.add(` / `node:` 这类词作为「不得出现」的说明）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const POLICY_CODE = stripComments(POLICY_SRC);

const HUMAN: AccessSubject = { kind: "human", id: "local-user" };
const AGENT: AccessSubject = { kind: "agent", id: "ta-ann" };
/** 三种工作项上下文：读不到 / 在读 / 已归档（归档项照可读可写，§12.1-12）。 */
const LIVE: WorkItemAccessContext = { workItemId: "wi-1", archivedAt: null };
const ARCHIVED: WorkItemAccessContext = { workItemId: "wi-1", archivedAt: 123 };
const CONTEXTS: WorkItemAccessContext[] = [null, LIVE, ARCHIVED];
const COMMENT_ACTIONS = ["create", "delete", "resolve", "react", "decide"] as const;

// ---------------------------------------------------------------------------
// 三轴具名（§9：不得继续用单个 canAccess 代替）
// ---------------------------------------------------------------------------

test("三轴具名（§9）：策略面恰好 canView/canComment/canInvoke 三个方法，没有单个 canAccess 或第四轴", () => {
  assert.deepEqual(
    Object.keys(SINGLE_USER_ACCESS_POLICY).sort(),
    ["canCommentWorkItem", "canInvokeTarget", "canViewWorkItem"],
    "接口必须预留三轴（§9）；Q2 裁定：决定写走 canComment，不发明第四轴 canDecide",
  );
  // 轴函数必须是模块导出的**同一份**（门面与两个写服务值导入它 ⇒ 不存在各写一份的第二判据）。
  assert.equal(SINGLE_USER_ACCESS_POLICY.canViewWorkItem, canViewWorkItem);
  assert.equal(SINGLE_USER_ACCESS_POLICY.canCommentWorkItem, canCommentWorkItem);
  assert.equal(SINGLE_USER_ACCESS_POLICY.canInvokeTarget, canInvokeTarget);
});

test("canView/canComment 逐格恒真（单人产品策略）：2 主体 × 3 工作项上下文 × 5 action 全 30 格 allowed", () => {
  let commentCells = 0;
  for (const subject of [HUMAN, AGENT]) {
    for (const context of CONTEXTS) {
      assert.deepEqual(
        canViewWorkItem(subject, context),
        { allowed: true },
        `canView 恒真格：subject=${subject.kind} context=${JSON.stringify(context)}`,
      );
      for (const action of COMMENT_ACTIONS) {
        assert.deepEqual(
          canCommentWorkItem(subject, context, action),
          { allowed: true },
          `canComment 恒真格：action=${action} context=${JSON.stringify(context)}`,
        );
        commentCells += 1;
      }
    }
  }
  assert.equal(commentCells, 30, "矩阵必须逐格覆盖（2 主体 × 3 上下文 × 5 action），不是抽样");
});

test("canInvokeTarget 四格 + squad 格：归档项 / 名册缺席 / 门禁关 各有唯一原因，正常目标放行", () => {
  const inRoster = { kind: "agent", id: "ta-ann", inRoster: true } as const;
  assert.deepEqual(
    canInvokeTarget(HUMAN, ARCHIVED, inRoster, { dispatchEnabled: true }),
    { allowed: false, reason: "work_item_archived" },
    "工作项归档 ⇒ 不派发（§12.1-12）",
  );
  assert.deepEqual(
    canInvokeTarget(
      HUMAN,
      LIVE,
      { kind: "agent", id: "ta-gone", inRoster: false },
      {
        dispatchEnabled: true,
      },
    ),
    { allowed: false, reason: "agent_not_in_roster" },
    "名册缺席 ⇒ 目标不可调起（§4.5 级联只解析名册内目标）",
  );
  assert.deepEqual(
    canInvokeTarget(HUMAN, LIVE, inRoster, { dispatchEnabled: false }),
    { allowed: false, reason: "dispatch_disabled" },
    "实验门禁关闭 ⇒ 新派发被拒（§12.1-12：可审计不可派发）",
  );
  assert.deepEqual(canInvokeTarget(HUMAN, LIVE, inRoster, { dispatchEnabled: true }), {
    allowed: true,
  });
  assert.deepEqual(
    canInvokeTarget(
      HUMAN,
      LIVE,
      { kind: "squad", id: "sq-1", inRoster: true },
      {
        dispatchEnabled: true,
      },
    ),
    { allowed: true },
    "squad 目标与 agent 目标同一判据（目标是「被 @ 的那支小队的队长」，由调用面解析）",
  );
  assert.deepEqual(
    canInvokeTarget(
      AGENT,
      null,
      { kind: "squad", id: "sq-1", inRoster: false },
      {
        dispatchEnabled: true,
      },
    ),
    { allowed: false, reason: "agent_not_in_roster" },
    "null 上下文（读不到工作项）不构成「归档」",
  );
});

test("canInvokeTarget 优先级与既有实现逐格同序，且不扩成「目标已归档/已停用」（§2.1c 明文不改分工）", () => {
  const offRoster = { kind: "agent", id: "ta-gone", inRoster: false } as const;
  // 与 commentService 的既有裁决同序（`restriction ?? 名册`）：归档压过门禁，门禁压过名册。
  assert.deepEqual(
    canInvokeTarget(HUMAN, ARCHIVED, offRoster, { dispatchEnabled: false }),
    { allowed: false, reason: "work_item_archived" },
    "归档优先于门禁（既有实现：门禁只写 `restriction ??=`）",
  );
  assert.deepEqual(
    canInvokeTarget(HUMAN, LIVE, offRoster, { dispatchEnabled: false }),
    { allowed: false, reason: "dispatch_disabled" },
    "门禁优先于名册（既有实现：restriction 非空即不再查名册）",
  );
  // 「目标已归档 / 已停用」是**执行面** planDispatch 的 skip 族事实（leaderDispatch.ts 明文「不合并」）：
  // 即使调用面把这两个状态带进来，v1 判据也不为它们发明原因（闭集只有三条）。
  assert.deepEqual(
    canInvokeTarget(
      HUMAN,
      LIVE,
      { kind: "agent", id: "ta-ann", inRoster: true, archived: true, enabled: false },
      { dispatchEnabled: true },
    ),
    { allowed: true },
    "v1 不为「目标已归档/已停用」扩第四格：那会动到 dispatch_skipped 的事实链（N5 明令不改）",
  );
});

// ---------------------------------------------------------------------------
// 原因闭集（单源，不产生第二套词汇）
// ---------------------------------------------------------------------------

test("原因闭集：三值字面量与既有 receipt detail 逐字相同（单源，不产生第二套词汇）", () => {
  assert.deepEqual(
    [...COLLABORATION_ACCESS_DENY_REASONS],
    ["work_item_archived", "agent_not_in_roster", "dispatch_disabled"],
    "三值就是既有 receipt detail 的词汇（commentService.test.ts「受限可审计」逐格断言、b52 门禁格）",
  );
  /* C4.2 接线后方向反转：commentService **不得**再内联这三个字面量，它必须从本模块取原因类型 ——
     词汇单源在本模块，写者只做引用（结构守卫 I1 同一断言，见 collaborationInvokePolicy.test.ts）。
     「既有词汇未变」由行为面保证：既有 receipt 逐格用例（commentService / commentTriggerMatrix /
     b52）里手写的三个字面量原样断言，漂移必红。 */
  const commentServiceCode = stripComments(
    readFileSync(resolve(WORKITEM_DIR, "commentService.ts"), "utf8"),
  );
  assert.ok(
    commentServiceCode.includes("CollaborationAccessDenyReason"),
    "commentService 的原因类型必须引用本模块（否则它又有了自己的一份词表）",
  );
  for (const reason of COLLABORATION_ACCESS_DENY_REASONS) {
    assert.ok(
      !commentServiceCode.includes(`"${reason}"`),
      `C4.2 起 commentService 不得内联 ${reason}：原因词汇单源在本模块，内联即第二套词汇`,
    );
  }
  assert.equal(new Set(COLLABORATION_ACCESS_DENY_REASONS).size, 3, "闭集三值两两互异");
});

test("拒绝文案单源：三原因各一条、两两互异、都含原因 token 与主体 id（不给空文案）", () => {
  const messages = COLLABORATION_ACCESS_DENY_REASONS.map((reason) =>
    collaborationAccessDeniedMessage(reason, HUMAN),
  );
  assert.equal(new Set(messages).size, 3, "三条原因不得共用同一句文案");
  COLLABORATION_ACCESS_DENY_REASONS.forEach((reason, index) => {
    const message = messages[index]!;
    assert.ok(message.trim().length > 0, `${reason} 的文案不得为空`);
    assert.ok(message.includes(reason), `${reason} 的文案必须点名原因 token`);
    assert.ok(
      message.includes(HUMAN.id),
      `${reason} 的文案必须点名主体 id（拒绝要能回答「谁被拒了」）`,
    );
  });
});

// ---------------------------------------------------------------------------
// A2A 归因（§9 第 3 条）与主体规范化（Q7）
// ---------------------------------------------------------------------------

test("A2A 主体：四格恒取 initiatedBy —— agent 代人类执行时主体仍是顶层人类，actor 顶不掉", () => {
  const human: AuthorRef = { kind: "human", id: "hu-1" };
  const agent: AuthorRef = { kind: "agent", id: "ta-a" };
  assert.deepEqual(resolveAccessSubject({ actor: human, initiatedBy: human }), human);
  assert.deepEqual(
    resolveAccessSubject({ actor: agent, initiatedBy: human }),
    human,
    "A2A 正格：agent 作者 + 人类归因 ⇒ 主体是那个人类（按人类能不能 invoke 判，§9 第 3 条）",
  );
  assert.deepEqual(resolveAccessSubject({ actor: agent, initiatedBy: agent }), agent);
  assert.deepEqual(
    resolveAccessSubject({ actor: human, initiatedBy: agent }),
    agent,
    "反向格：actor 是人也压不过 initiatedBy（主体只有一个来源）",
  );
});

test("主体规范化单源（Q7）：assignee 侧占位 id 归一到审计侧 canonical；幂等且不跨命名空间", () => {
  assert.deepEqual(LOCAL_HUMAN_SUBJECT, { kind: "human", id: "local-user" });
  const assigneeSide: AccessSubject = { kind: "human", id: "user" };
  assert.deepEqual(
    normalizeAccessSubject(assigneeSide),
    LOCAL_HUMAN_SUBJECT,
    "`{type:'user', id:'user'}` 的审计表示就是本地人类：审计侧为 canonical",
  );
  assert.deepEqual(
    normalizeAccessSubject(LOCAL_HUMAN_SUBJECT),
    LOCAL_HUMAN_SUBJECT,
    "canonical 是不动点",
  );
  assert.deepEqual(
    normalizeAccessSubject(normalizeAccessSubject(assigneeSide)),
    LOCAL_HUMAN_SUBJECT,
    "规范化幂等（重复过闸不换主体）",
  );
  const agentNamedUser: AccessSubject = { kind: "agent", id: "user" };
  assert.deepEqual(
    normalizeAccessSubject(agentNamedUser),
    agentNamedUser,
    "命名空间独立：agent 的 id 恰好叫 user 不得被当成本地人类",
  );
  const otherHuman: AccessSubject = { kind: "human", id: "hu-other" };
  assert.deepEqual(normalizeAccessSubject(otherHuman), otherHuman);
  assert.deepEqual(
    resolveAccessSubject({ actor: otherHuman, initiatedBy: assigneeSide }),
    LOCAL_HUMAN_SUBJECT,
    "主体解析即规范化：同一个人在两条 id 命名体系下得到一个主体（单源应用点）",
  );
});

test("规范化单源不与组合根漂移：node.ts 的 LOCAL_HUMAN_ACTOR 与 canonical 主体同 kind 同 id", () => {
  const nodeSource = readFileSync(resolve(SRC_ROOT, "node.ts"), "utf8");
  const match =
    /const LOCAL_HUMAN_ACTOR(?::\s*\w+)?\s*=\s*\{\s*kind:\s*"([^"]+)",\s*id:\s*"([^"]+)"/.exec(
      nodeSource,
    );
  assert.ok(match, "组合根必须仍有 LOCAL_HUMAN_ACTOR（全仓唯一的本地人类身份定义点）");
  assert.equal(match[1], LOCAL_HUMAN_SUBJECT.kind, "kind 漂移即「同一人两个主体」");
  assert.equal(
    match[2],
    LOCAL_HUMAN_SUBJECT.id,
    "id 漂移即双判据：规范化的 canonical 必须与注入身份同值",
  );
});

// ---------------------------------------------------------------------------
// 判据模块的结构守卫（去掉注释后按 token 扫描）
// ---------------------------------------------------------------------------

/** 取某个 `export function <name>(` 的函数体（自己的花括号配对；签名行后第一个 `{` 起算）。 */
function functionBodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 export function ${name}(`);
  const signatureEnd = source.indexOf("\n", start);
  const bodyStart = source.lastIndexOf("{", signatureEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`${name} 的函数体没有配对闭合`);
}

test("结构守卫 G1：resolveAccessSubject 的实现体只读 initiatedBy —— 函数体内零 actor token", () => {
  const body = stripComments(functionBodyOf(POLICY_SRC, "resolveAccessSubject"));
  assert.ok(body.includes("initiatedBy"), `函数体必须真的读 initiatedBy（防空转）：${body}`);
  assert.ok(
    !/\bactor\b/.test(body),
    `A2A 红线：函数体不得出现 actor 标识符（主体只能来自 initiatedBy）——实际：${body}`,
  );
});

test("结构守卫：判据模块不读 author（顶层人类归因的主体不可能被评论作者顶替）", () => {
  assert.ok(
    !/\bauthor\b/.test(POLICY_CODE),
    "判据模块（去注释）不得出现 author 标识符：主体只从 initiatedBy 派生",
  );
});

test("结构守卫（§9 第 4 条）：判据模块结构上不认识 system —— 不存在「system ⇒ 放行」的捷径", () => {
  /* §9 第 4 条（system 不得以 system 身份绕过 canInvoke）在 v1 的形态：`AccessSubject` 与审计身份同形
     （system 作者今天照样可写评论，见 commentTriggerMatrix 的「system 作者：评论可写（可审计）」，
     把它从取值域里摘掉就会在缺省策略下新增一条拒绝路径 ⇒ 既有行为逐格不变这条验收会破）。
     于是这条约束落成**结构事实**：判据模块里没有任何 `system` 分支 —— system 只能作为普通主体值流过
     同一条判据，连「按 kind 特判」的代码位置都不存在。 */
  assert.ok(
    !/system/.test(POLICY_CODE),
    "判据模块（去注释）不得出现 system：一旦出现，就意味着 system 有自己的分支/捷径（§9 第 4 条）",
  );
});

test("结构守卫 G4/G6：判据模块零写口、零生命周期、零 steering、零 node 侧 IO", () => {
  for (const forbidden of [
    ".add(",
    ".insert(",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
    "node:",
    "transition",
    "updateStatus",
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "CommandInbox",
    "steer",
    "requestedDelivery",
  ]) {
    assert.ok(
      !POLICY_CODE.includes(forbidden),
      `collaborationAccessPolicy.ts（去注释）不得出现 ${forbidden}：判据模块是纯函数面，` +
        "写事实与生命周期入口都在写者/执行者一侧",
    );
  }
});
