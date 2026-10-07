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
  normalizeAccessSubject,
  resolveAccessSubject,
  type AccessSubject,
  type CommentAccessAction,
  type WorkItemAccessContext,
} from "../src/workitem/collaborationAccessPolicy.js";

/* 协作域 C4 独立复验（test-verifier）：判据面穷举。
 *
 * 独立性声明：
 * · 本文件的夹具身份值（iv-* 前缀）与实现者用例**不同**：主体、工作项、目标全部另取；
 * · 期望值全是手写字面量（规格 §9 / §12.1-12 与 C4 任务卡），不是「拿实现再算一遍」；
 * · Q7 的占位 id 不在本文件里硬编码「user」再与实现比：直接从 UI 常量源码读出真值再喂给规范化；
 * · 结构守卫用本文件自己的去注释/函数体提取实现独立复算（不 import 实现者的测试助手）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_SRC = readFileSync(
  resolve(HERE, "../src/workitem/collaborationAccessPolicy.ts"),
  "utf8",
);
const NODE_SRC = readFileSync(resolve(HERE, "../src/node.ts"), "utf8");
const UI_SQUAD_ENTRY_SRC = readFileSync(
  resolve(HERE, "../../ui/src/squad/squadEntryViewModel.ts"),
  "utf8",
);

/** 本文件自己的去注释实现（块注释 + 行注释），用于结构扫描。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const POLICY_CODE = stripComments(POLICY_SRC);

const IV_HUMAN: AccessSubject = { kind: "human", id: "iv-human" };
const IV_AGENT: AccessSubject = { kind: "agent", id: "iv-agent" };
const IV_SYSTEM: AccessSubject = { kind: "system", id: "iv-system" };
const IV_SUBJECTS = [IV_HUMAN, IV_AGENT] as const;
const IV_CONTEXTS: WorkItemAccessContext[] = [
  null,
  { workItemId: "iv-wi", archivedAt: null },
  { workItemId: "iv-wi", archivedAt: 7_777 },
];
const IV_ACTIONS: CommentAccessAction[] = ["create", "delete", "resolve", "react", "decide"];
const contextKey = (context: WorkItemAccessContext) =>
  context === null ? "no-item" : context.archivedAt === null ? "live" : "archived";

test("IV-1 三轴具名（独立真源：spec §9 三轴名 + Q2 不发明第四轴）：策略面恰三个方法且是模块导出本体", () => {
  assert.deepEqual(Object.keys(SINGLE_USER_ACCESS_POLICY).sort(), [
    "canCommentWorkItem",
    "canInvokeTarget",
    "canViewWorkItem",
  ]);
  // 「没有单个 canAccess」：任何键名都不含 canAccess / canDecide / canWrite 这类收束名。
  for (const key of Object.keys(SINGLE_USER_ACCESS_POLICY)) {
    assert.ok(!/canAccess|canDecide|canWrite|canModify/.test(key), `键 ${key} 不是 §9 的三轴名`);
  }
  assert.equal(SINGLE_USER_ACCESS_POLICY.canViewWorkItem, canViewWorkItem);
  assert.equal(SINGLE_USER_ACCESS_POLICY.canCommentWorkItem, canCommentWorkItem);
  assert.equal(SINGLE_USER_ACCESS_POLICY.canInvokeTarget, canInvokeTarget);
});

test("IV-2 恒真矩阵：2 主体 × 3 上下文 × 5 action = 30 格逐格等于 {allowed:true}（canView 同 2×3 格）", () => {
  const commentObserved: Record<string, string> = {};
  const viewObserved: Record<string, string> = {};
  for (const subject of IV_SUBJECTS) {
    for (const context of IV_CONTEXTS) {
      viewObserved[`${subject.kind}|${contextKey(context)}`] = JSON.stringify(
        canViewWorkItem(subject, context),
      );
      for (const action of IV_ACTIONS) {
        commentObserved[`${subject.kind}|${contextKey(context)}|${action}`] = JSON.stringify(
          canCommentWorkItem(subject, context, action),
        );
      }
    }
  }
  const expectedView = Object.fromEntries(
    Object.keys(viewObserved).map((key) => [key, '{"allowed":true}']),
  );
  const expectedComment = Object.fromEntries(
    Object.keys(commentObserved).map((key) => [key, '{"allowed":true}']),
  );
  assert.equal(Object.keys(commentObserved).length, 30, "矩阵必须恰 30 格（2×3×5，不是抽样）");
  assert.deepEqual(viewObserved, expectedView, "canView 六格恒真且形态恰为 {allowed:true}");
  assert.deepEqual(
    commentObserved,
    expectedComment,
    "canComment 三十格恒真且形态恰为 {allowed:true}",
  );
});

test("IV-2b system 主体只作为普通值流过同一判据（§9 第 4 条：不存在 system 专用分支）", () => {
  for (const context of IV_CONTEXTS) {
    assert.deepEqual(canViewWorkItem(IV_SYSTEM, context), { allowed: true });
    for (const action of IV_ACTIONS) {
      assert.deepEqual(
        canCommentWorkItem(IV_SYSTEM, context, action),
        { allowed: true },
        `system 主体的 canComment(${action}) 与 human/agent 逐格同结论`,
      );
    }
  }
  // canInvoke 的结论只由 归档/门禁/名册 给出：system 主体不会自作主张换结论。
  const target = { kind: "agent", id: "iv-target", inRoster: true } as const;
  for (const subject of [IV_HUMAN, IV_AGENT, IV_SYSTEM]) {
    assert.deepEqual(canInvokeTarget(subject, IV_CONTEXTS[2]!, target, { dispatchEnabled: true }), {
      allowed: false,
      reason: "work_item_archived",
    });
    assert.deepEqual(canInvokeTarget(subject, IV_CONTEXTS[1]!, target, { dispatchEnabled: true }), {
      allowed: true,
    });
    assert.deepEqual(
      canInvokeTarget(subject, IV_CONTEXTS[1]!, target, { dispatchEnabled: false }),
      { allowed: false, reason: "dispatch_disabled" },
    );
    assert.deepEqual(
      canInvokeTarget(
        subject,
        IV_CONTEXTS[1]!,
        { kind: "agent", id: "iv-off", inRoster: false },
        { dispatchEnabled: true },
      ),
      { allowed: false, reason: "agent_not_in_roster" },
    );
  }
});

test("IV-3 canInvoke 四格 + 边界（null 上下文 / squad 目标 / 目标 archived·enabled 标志不参与判据）", () => {
  const inRoster = { kind: "agent", id: "iv-target", inRoster: true } as const;
  const offRoster = { kind: "agent", id: "iv-off", inRoster: false } as const;
  const live = IV_CONTEXTS[1]!;
  const archived = IV_CONTEXTS[2]!;

  assert.deepEqual(canInvokeTarget(IV_HUMAN, archived, inRoster, { dispatchEnabled: true }), {
    allowed: false,
    reason: "work_item_archived",
  });
  assert.deepEqual(canInvokeTarget(IV_HUMAN, live, offRoster, { dispatchEnabled: true }), {
    allowed: false,
    reason: "agent_not_in_roster",
  });
  assert.deepEqual(canInvokeTarget(IV_HUMAN, live, inRoster, { dispatchEnabled: false }), {
    allowed: false,
    reason: "dispatch_disabled",
  });
  assert.deepEqual(canInvokeTarget(IV_HUMAN, live, inRoster, { dispatchEnabled: true }), {
    allowed: true,
  });

  // 边界：工作项读不到（null）= 不是归档；squad 目标与 agent 目标同一判据。
  assert.deepEqual(canInvokeTarget(IV_HUMAN, null, inRoster, { dispatchEnabled: true }), {
    allowed: true,
  });
  assert.deepEqual(canInvokeTarget(IV_HUMAN, null, offRoster, { dispatchEnabled: true }), {
    allowed: false,
    reason: "agent_not_in_roster",
  });
  assert.deepEqual(
    canInvokeTarget(
      IV_HUMAN,
      live,
      { kind: "squad", id: "iv-sq", inRoster: true },
      {
        dispatchEnabled: true,
      },
    ),
    { allowed: true },
  );
  assert.deepEqual(
    canInvokeTarget(
      IV_HUMAN,
      live,
      { kind: "squad", id: "iv-sq", inRoster: false },
      {
        dispatchEnabled: true,
      },
    ),
    { allowed: false, reason: "agent_not_in_roster" },
  );
  // v1 明确不扩「目标已归档 / 已停用」格（§2.1c：那是执行面 skip 族事实）：两个标志带进来也不改结论。
  assert.deepEqual(
    canInvokeTarget(
      IV_HUMAN,
      live,
      { kind: "agent", id: "iv-target", inRoster: true, archived: true, enabled: false },
      { dispatchEnabled: true },
    ),
    { allowed: true },
    "请求面判据不为「目标已归档/已停用」发明第四条原因",
  );
});

test("IV-4 优先序四格竞争（独立夹具）：归档 > 门禁 > 名册，唯一原因由第一个命中给出", () => {
  const inRoster = { kind: "agent", id: "iv-target", inRoster: true } as const;
  const offRoster = { kind: "agent", id: "iv-off", inRoster: false } as const;
  const live = IV_CONTEXTS[1]!;
  const archived = IV_CONTEXTS[2]!;
  // 四格竞争：三条原因互为竞争者，第四格全清放行。
  assert.deepEqual(
    canInvokeTarget(IV_HUMAN, archived, offRoster, { dispatchEnabled: false }),
    { allowed: false, reason: "work_item_archived" },
    "归档 ∧ 门禁关 ∧ 名册外 ⇒ 归档",
  );
  assert.deepEqual(
    canInvokeTarget(IV_HUMAN, live, offRoster, { dispatchEnabled: false }),
    { allowed: false, reason: "dispatch_disabled" },
    "未归档 ∧ 门禁关 ∧ 名册外 ⇒ 门禁",
  );
  assert.deepEqual(
    canInvokeTarget(IV_HUMAN, live, offRoster, { dispatchEnabled: true }),
    { allowed: false, reason: "agent_not_in_roster" },
    "未归档 ∧ 门禁开 ∧ 名册外 ⇒ 名册",
  );
  assert.deepEqual(
    canInvokeTarget(IV_HUMAN, live, inRoster, { dispatchEnabled: true }),
    { allowed: true },
    "全清 ⇒ 放行",
  );
  // 交叉补格：归档压过门禁（即使门禁开、目标在名册）；归档压过名册（即使门禁开）。
  assert.deepEqual(canInvokeTarget(IV_HUMAN, archived, inRoster, { dispatchEnabled: false }), {
    allowed: false,
    reason: "work_item_archived",
  });
  assert.deepEqual(canInvokeTarget(IV_HUMAN, archived, offRoster, { dispatchEnabled: true }), {
    allowed: false,
    reason: "work_item_archived",
  });
});

test("IV-5 原因闭集：恰三值（独立字面量，集合相等而非数组顺序）", () => {
  assert.deepEqual([...COLLABORATION_ACCESS_DENY_REASONS].sort(), [
    "agent_not_in_roster",
    "dispatch_disabled",
    "work_item_archived",
  ]);
  assert.equal(new Set(COLLABORATION_ACCESS_DENY_REASONS).size, 3, "三值两两互异（无第四个词）");
});

test("IV-6 Q7 规范化：占位归一（真值从 UI 常量读）/ 不动点 / 幂等 / 命名空间隔离 / node.ts 无漂移", () => {
  // 占位 id 的独立真源：UI 侧的人类 assignee 占位常量（不是本文件硬编码的「user」）。
  const uiConstant = /export const WORK_ITEM_USER_ASSIGNEE_ID = "([^"]+)"/.exec(UI_SQUAD_ENTRY_SRC);
  assert.ok(uiConstant, "UI 侧必须仍有 WORK_ITEM_USER_ASSIGNEE_ID 常量（占位 id 的在地真值）");
  const placeholderId = uiConstant[1]!;
  assert.equal(placeholderId, "user", "UI 占位 id 的字面值（独立读出）");

  const assigneeSide: AccessSubject = { kind: "human", id: placeholderId };
  assert.deepEqual(
    normalizeAccessSubject(assigneeSide),
    { kind: "human", id: "local-user" },
    "assignee 侧占位 ⇒ 审计侧 canonical",
  );
  assert.deepEqual(
    normalizeAccessSubject(LOCAL_HUMAN_SUBJECT),
    LOCAL_HUMAN_SUBJECT,
    "canonical 是不动点",
  );
  assert.deepEqual(
    normalizeAccessSubject(normalizeAccessSubject(assigneeSide)),
    normalizeAccessSubject(assigneeSide),
    "幂等",
  );
  assert.deepEqual(
    normalizeAccessSubject({ kind: "agent", id: placeholderId }),
    { kind: "agent", id: placeholderId },
    "命名空间隔离：agent 的 id 恰好等于占位值 ≠ 本地人类",
  );
  assert.deepEqual(
    normalizeAccessSubject({ kind: "system", id: placeholderId }),
    { kind: "system", id: placeholderId },
    "system 命名空间同样不归一（§9 第 4 条：system 无捷径也无特殊待遇）",
  );
  assert.deepEqual(
    normalizeAccessSubject({ kind: "human", id: ` ${placeholderId}` }),
    { kind: "human", id: ` ${placeholderId}` },
    "边界：规则是精确 id 匹配，不做 trim/大小写折叠（不猜身份）",
  );

  // 主体解析 = 取 initiatedBy 再过一次唯一规范化：占位在 initiatedBy 上也会被归一。
  assert.deepEqual(
    resolveAccessSubject({ actor: { kind: "human", id: "iv-other" }, initiatedBy: assigneeSide }),
    LOCAL_HUMAN_SUBJECT,
    "同一个人两条 id 体系 ⇒ 判据主体同值（单源应用点）",
  );

  // node.ts 漂移守卫（组合根注入的身份常量必须与 canonical 逐字同 kind 同 id）。
  const nodeActor =
    /const LOCAL_HUMAN_ACTOR[^=]*=\s*\{\s*kind:\s*"([^"]+)",\s*id:\s*"([^"]+)"/.exec(NODE_SRC);
  assert.ok(nodeActor, "组合根必须仍有 LOCAL_HUMAN_ACTOR（本地人类身份的唯一注入点）");
  assert.equal(nodeActor[1], LOCAL_HUMAN_SUBJECT.kind, "kind 漂移 ⇒ 同一人两个主体");
  assert.equal(nodeActor[2], LOCAL_HUMAN_SUBJECT.id, "id 漂移 ⇒ 双判据（规范化与注入身份不同值）");
});

/** 本文件自己的函数体提取（第一个 `{` 起做花括号配对）。 */
function bodyOf(source: string, functionName: string): string {
  const start = source.indexOf(`export function ${functionName}(`);
  assert.ok(start >= 0, `找不到 export function ${functionName}`);
  const bodyStart = source.indexOf("{", start); // 签名内无花括号 ⇒ 第一个 `{` 即实现体起点
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error(`${functionName} 花括号不配对`);
}

test("IV-7 结构负控面独立复算：判据模块零 system / 零 author / 零 IO / 零写口 / 零生命周期", () => {
  for (const forbidden of [
    "system",
    "author",
    "node:",
    "node:crypto",
    ".add(",
    ".insert(",
    "INSERT INTO",
    "UPDATE ",
    "DELETE FROM",
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
      `判据模块去注释后不得出现 ${forbidden}（独立复算）`,
    );
  }
  // 三轴函数恰 3 个具名实现 + 主体解析 1 个 + 规范化 1 个（没有大而全的判据入口）。
  assert.equal((POLICY_CODE.match(/export function can/g) ?? []).length, 3);
  assert.ok(POLICY_CODE.includes("export function resolveAccessSubject("));
  assert.ok(POLICY_CODE.includes("export function normalizeAccessSubject("));
  // G1：resolveAccessSubject 实现体只读 initiatedBy。
  const body = stripComments(bodyOf(POLICY_SRC, "resolveAccessSubject"));
  assert.ok(body.includes("initiatedBy"), "函数体必须真的读 initiatedBy");
  assert.ok(!/\bactor\b/.test(body), `函数体不得出现 actor token：${body}`);
  // 模块不得 import 任何运行时 node 内建（浏览器安全面）。
  assert.ok(
    !/from\s+"node:/.test(POLICY_CODE),
    "判据模块零 node: 值导入（门面值导入它 ⇒ renderer 整包可用）",
  );
});
