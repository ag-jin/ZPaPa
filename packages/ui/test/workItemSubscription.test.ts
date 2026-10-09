import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OPT_OUT_SCOPES, SUBSCRIBER_REASONS, type WorkItemSubscriberRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkItemSubscriptionControl } from "../src/squad/WorkItemSubscriptionControl.js";
import { writeDisabledReason } from "../src/squad/workItemCollaborationViewModel.js";
import {
  OPT_OUT_SCOPE_MESSAGE_IDS,
  SUBSCRIBER_REASON_MESSAGE_IDS,
  SUBSCRIPTION_STATUS_MESSAGE_IDS,
  UNSUBSCRIBE_CONFIRM_IDLE,
  confirmUnsubscribeScope,
  requestUnsubscribeConfirm,
  subscriptionRequestFor,
  unsubscribeScopeChoices,
  workItemSubscriptionView,
} from "../src/squad/workItemSubscriptionViewModel.js";

/* SUB.3a（订阅线 UI）：详情页订阅控件与收件箱行退订的**判据面**。
 *
 * 与实现者的其它 ui 用例分工一致：本文件钉「怎么判」——文案映射穷尽（reason 6 / scope 2）、
 * 控件状态三态、两档退订的确认与请求形状、收件箱行入口判据；组件只照这些结论画。
 *
 * 期望值的独立真源：三个闭集来自 `@zcode/services` 根入口的值导出（SUB.1 冻结的
 * `SUBSCRIBER_REASONS` / `OPT_OUT_SCOPES`），字面量手抄自 spec §7.1 六 reason 表与
 * `optOutScope: issue|subtree` —— 不是照实现回算。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");
/** 去掉注释再扫：注释里提到坏写法是**说明**，不是坏写法本身（照 workItemInlineEditRow 的既有做法）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 造一条订阅行（只给判据关心的字段；列名与 repo 记录同形）。 */
function subscriberRow(
  overrides: Partial<WorkItemSubscriberRecord> = {},
): WorkItemSubscriberRecord {
  return {
    id: "sub-1",
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-1",
    subjectType: "human",
    subjectId: "local-user",
    reason: "creator",
    optOutScope: "issue",
    tombstonedAt: null,
    createdAt: 1_760_000_000_000,
    ...overrides,
  };
}

const VIEWER = { kind: "human", id: "local-user" };

// ---------- ① 文案映射穷尽（reason 6 / scope 2）与两语成对 ----------

test("文案映射｜reason 键集 == SUBSCRIBER_REASONS（六格穷尽），且每格两语非空、六句互异", () => {
  assert.deepEqual(
    Object.keys(SUBSCRIBER_REASON_MESSAGE_IDS).sort(),
    [...SUBSCRIBER_REASONS].sort(),
    "reason 文案表必须与服务面闭集同集（少一格 ⇒ 界面少一句话仍照常显示）",
  );
  for (const reason of SUBSCRIBER_REASONS) {
    const messageId = SUBSCRIBER_REASON_MESSAGE_IDS[reason];
    assert.ok((zhCN[messageId] ?? "").length > 0, `zh 缺 ${messageId}`);
    assert.ok((enUS[messageId] ?? "").length > 0, `en 缺 ${messageId}`);
  }
  for (const locale of [
    { name: "zh-CN", messages: zhCN },
    { name: "en-US", messages: enUS },
  ]) {
    const texts = SUBSCRIBER_REASONS.map(
      (reason) => locale.messages[SUBSCRIBER_REASON_MESSAGE_IDS[reason]] ?? "",
    );
    assert.equal(
      new Set(texts).size,
      SUBSCRIBER_REASONS.length,
      `${locale.name}：六 reason 必须各说各话（两格共用一句 = 界面说错「我为什么在这里」）`,
    );
  }
});

test("文案映射｜scope 键集 == OPT_OUT_SCOPES（两档穷尽），且两格两语非空、互异", () => {
  assert.deepEqual(
    Object.keys(OPT_OUT_SCOPE_MESSAGE_IDS).sort(),
    [...OPT_OUT_SCOPES].sort(),
    "scope 文案表必须与服务面闭集同集（少一格 ⇒ 「含子项」被说成「只此条」）",
  );
  for (const scope of OPT_OUT_SCOPES) {
    const messageId = OPT_OUT_SCOPE_MESSAGE_IDS[scope];
    assert.ok((zhCN[messageId] ?? "").length > 0, `zh 缺 ${messageId}`);
    assert.ok((enUS[messageId] ?? "").length > 0, `en 缺 ${messageId}`);
  }
  assert.notEqual(
    zhCN[OPT_OUT_SCOPE_MESSAGE_IDS.issue],
    zhCN[OPT_OUT_SCOPE_MESSAGE_IDS.subtree],
    "两档必须各说各话（同一句 = 用户分不清退订到哪一层）",
  );
});

test("文案｜状态三句 + 动作 + 说明与墓碑提示：手写表 == 映射值集，两语齐、占位符成对", () => {
  /* 手写表 = 映射**自身的**九个成员（两个 disabled.* 键不在这里：它们由 `writeDisabledReason`
     按面名拼出，两语核对归「不可写判据」那条）。 */
  const handWritten = [
    "squad.workItemDetail.subscription.title",
    "squad.workItemDetail.subscription.status.none",
    "squad.workItemDetail.subscription.status.subscribed",
    "squad.workItemDetail.subscription.status.unsubscribed",
    "squad.workItemDetail.subscription.subscribe",
    "squad.workItemDetail.subscription.unsubscribe",
    "squad.workItemDetail.subscription.unsubscribeTitle",
    "squad.workItemDetail.subscription.unsubscribeHint",
    "squad.workItemDetail.subscription.tombstoneHint",
  ];
  assert.deepEqual(
    Object.values(SUBSCRIPTION_STATUS_MESSAGE_IDS).sort(),
    [...handWritten].sort(),
    "映射值集必须与手写表同集（少一句 = 界面少一句说明而仍照常显示）",
  );
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  for (const key of handWritten) {
    assert.ok((zhCN[key] ?? "").length > 0, `zh 缺 ${key}`);
    assert.ok((enUS[key] ?? "").length > 0, `en 缺 ${key}`);
    assert.equal(
      placeholders(zhCN[key] ?? ""),
      placeholders(enUS[key] ?? ""),
      `${key} 占位符不成对`,
    );
  }
  // 状态文案必须带占位符（否则「关注中（创建者）」退化成一句不带原因的「关注中」）。
  assert.ok(
    (zhCN["squad.workItemDetail.subscription.status.subscribed"] ?? "").includes("{reason}"),
    "关注中必须自报 reason",
  );
  assert.ok(
    (zhCN["squad.workItemDetail.subscription.status.unsubscribed"] ?? "").includes("{scope}"),
    "已退订必须自报范围（退订到哪一层是用户要知道的）",
  );
});

// ---------- ② 控件状态三态矩阵 ----------

test("状态判据｜无我的行 ⇒ 未订阅；别人的行不算我的（不同主体 / 不同 id）", () => {
  assert.deepEqual(
    workItemSubscriptionView({ subscribers: [], viewerActor: VIEWER }),
    { status: "none" },
    "一条订阅行都没有 ⇒ 未订阅",
  );
  assert.deepEqual(
    workItemSubscriptionView({
      subscribers: [
        subscriberRow({ subjectType: "agent", subjectId: "ag-1", reason: "assignee" }),
        subscriberRow({ subjectId: "someone-else", reason: "commenter" }),
      ],
      viewerActor: VIEWER,
    }),
    { status: "none" },
    "只有别人的行 ⇒ 仍是未订阅（把别人的行当我的是「退订退错人」的种子）",
  );
  assert.deepEqual(
    workItemSubscriptionView({
      subscribers: [subscriberRow({ subjectType: "agent", subjectId: "local-user" })],
      viewerActor: VIEWER,
    }),
    { status: "none" },
    "同 id 不同主体不算我（human:local-user ≠ agent:local-user）",
  );
});

test("状态判据｜活动行 ⇒ 关注中，且六 reason 逐格带上各自文案", () => {
  for (const reason of SUBSCRIBER_REASONS) {
    const view = workItemSubscriptionView({
      subscribers: [subscriberRow({ reason })],
      viewerActor: VIEWER,
    });
    assert.deepEqual(
      view,
      {
        status: "subscribed",
        reason,
        reasonMessageId: SUBSCRIBER_REASON_MESSAGE_IDS[reason],
      },
      `活动行的 reason=${reason} 必须原样带给界面（最近事实胜，UI 不重判）`,
    );
  }
});

test("状态判据｜墓碑行 ⇒ 已退订，且范围两档逐格带上各自文案（不再显示自动 reason）", () => {
  for (const scope of OPT_OUT_SCOPES) {
    const view = workItemSubscriptionView({
      subscribers: [subscriberRow({ reason: "manual", optOutScope: scope, tombstonedAt: 123 })],
      viewerActor: VIEWER,
    });
    assert.deepEqual(
      view,
      {
        status: "unsubscribed",
        scope,
        scopeMessageId: OPT_OUT_SCOPE_MESSAGE_IDS[scope],
      },
      `墓碑行的范围 ${scope} 必须原样带给界面`,
    );
  }
  // 活动行的 optOutScope 恒 issue（列上有值但无语义）⇒ 不得被读成「已退订」。
  assert.equal(
    workItemSubscriptionView({
      subscribers: [subscriberRow({ optOutScope: "subtree", tombstonedAt: null })],
      viewerActor: VIEWER,
    }).status,
    "subscribed",
    "判据是 tombstonedAt，不是 optOutScope（活动行恒 issue，读错列会把关注中显示成已退订）",
  );
});

// ---------- ③ 两档退订的确认与请求形状（判据单源） ----------

test("两档确认｜未确认（空闲态）⇒ 可执行范围 null；确认过 ⇒ 恰是那一档，且状态收回空闲", () => {
  assert.deepEqual(UNSUBSCRIBE_CONFIRM_IDLE, { pendingScope: null }, "空闲态是待确认 null");
  assert.equal(
    confirmUnsubscribeScope(UNSUBSCRIBE_CONFIRM_IDLE).scope,
    null,
    "没确认过 ⇒ 一级都不执行（返回 null，不猜一个默认档）",
  );
  for (const scope of OPT_OUT_SCOPES) {
    const decided = confirmUnsubscribeScope(requestUnsubscribeConfirm(scope));
    assert.equal(decided.scope, scope, `确认 ${scope} ⇒ 可执行的就是它`);
    assert.deepEqual(
      decided.next,
      UNSUBSCRIBE_CONFIRM_IDLE,
      "执行前先收回待确认态（重复点确认不会执行第二次）",
    );
  }
});

test("两档选项｜choices 恰是两档、issue 在前，各带自己的文案键（UI 不各判一遍有哪些档）", () => {
  const choices = unsubscribeScopeChoices();
  assert.deepEqual(
    choices.map((choice) => choice.scope),
    ["issue", "subtree"],
    "档位与顺序来自单源（只此条 → 此条及子项：范围由小到大）",
  );
  assert.deepEqual(
    choices.map((choice) => choice.messageId),
    [OPT_OUT_SCOPE_MESSAGE_IDS.issue, OPT_OUT_SCOPE_MESSAGE_IDS.subtree],
    "按钮文案取同一份映射（各写一句 = 两处文案迟早分叉）",
  );
});

test("请求形状｜订阅不带范围、退订必带范围（判别联合由这一处产出）", () => {
  assert.deepEqual(
    subscriptionRequestFor("wi-1", { kind: "subscribe" }),
    { workItemId: "wi-1", subscribed: true },
    "订阅：没有范围这个概念（带上一个会让服务面收到没意义的选择）",
  );
  for (const scope of OPT_OUT_SCOPES) {
    assert.deepEqual(
      subscriptionRequestFor("wi-1", { kind: "unsubscribe", scope }),
      { workItemId: "wi-1", subscribed: false, scope },
      "退订：范围原样进请求（类型上不可能「退订但忘了范围」）",
    );
  }
});

test("判据单源｜`subscribed: false` 字面量在 ui/src 全域恰一处（第二处 = 第二份退订判据）", () => {
  const offenders: string[] = [];
  let occurrences = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts")) {
        const source = stripComments(readFileSync(full, "utf8"));
        const count = (source.match(/subscribed:\s*false/g) ?? []).length;
        if (count > 0) offenders.push(full.slice(SRC_DIR.length + 1));
        occurrences += count;
      }
    }
  };
  walk(SRC_DIR);
  assert.equal(
    occurrences,
    1,
    `退订请求只允许在 view model 里拼（实际出现在：${offenders.join(", ") || "无"}）`,
  );
});

/* 不可写判据**复用** `writeDisabledReason`（SUB.3a 只加面名）：这条断言钉住两件事 ——
   ① 优先级（归档 > 读取失败 > 可写）在新面上与其余四个面**同序**；② 两个键在 locales 里两语可读
   （键名由模板拼出，写错不报错、只会显示裸键）。 */
test("不可写判据｜subscription 面复用 writeDisabledReason：归档 > 读取失败 > 可写，两语可读", () => {
  assert.equal(
    writeDisabledReason("subscription", { archivedAt: 1 }, "boom"),
    "squad.workItemDetail.subscription.disabled.archived",
    "归档优先（哪怕同时读取失败）",
  );
  assert.equal(
    writeDisabledReason("subscription", {}, "boom"),
    "squad.workItemDetail.subscription.disabled.readFailed",
    "读取失败 ⇒ 第二个理由",
  );
  assert.equal(writeDisabledReason("subscription", {}, null), null, "都可写 ⇒ 无理由（null）");
  for (const key of [
    "squad.workItemDetail.subscription.disabled.archived",
    "squad.workItemDetail.subscription.disabled.readFailed",
  ]) {
    assert.ok((zhCN[key] ?? "").length > 0, `zh 缺 ${key}`);
    assert.ok((enUS[key] ?? "").length > 0, `en 缺 ${key}`);
  }
});

// ---------- ④ 控件（真渲染：三态 × 禁用）与详情页接线 ----------

function renderControl(
  subscribers: WorkItemSubscriberRecord[],
  overrides: {
    viewerActor?: { kind: string; id: string };
    disabledReasonMessageId?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemSubscriptionControl, {
        subscribers,
        viewerActor: overrides.viewerActor ?? VIEWER,
        disabledReasonMessageId: overrides.disabledReasonMessageId ?? null,
        onSetSubscription: async () => {},
      }),
    }),
  );
}

/** 取某个 testid 的按钮标签原文（用于判 disabled 属性，不看别处的 disabled 字面量）。 */
function buttonTag(markup: string, testId: string): string | null {
  return new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(markup)?.[0] ?? null;
}

test("真渲染｜三态各自的文案与动作：未订阅给「订阅」、关注中给「退订」、已退订给「订阅」+ 墓碑说明", () => {
  const none = renderControl([]);
  assert.ok(none.includes("未订阅"), "未订阅态自报状态");
  assert.ok(buttonTag(none, "work-item-subscription-subscribe") !== null, "未订阅 ⇒ 给「订阅」");
  assert.equal(buttonTag(none, "work-item-subscription-unsubscribe"), null, "未订阅时不给「退订」");

  const subscribed = renderControl([subscriberRow({ reason: "creator" })]);
  assert.ok(
    subscribed.includes("关注中（创建者）"),
    "关注中必须把 reason 原文填进占位符（「我为什么在这里」是控件的立身之本）",
  );
  assert.ok(
    buttonTag(subscribed, "work-item-subscription-unsubscribe") !== null,
    "关注中 ⇒ 给「退订」",
  );
  assert.equal(
    buttonTag(subscribed, "work-item-subscription-subscribe"),
    null,
    "关注中不给「订阅」（同义动作重复给 = 让人以为还能改回去）",
  );

  const unsubscribed = renderControl([
    subscriberRow({ reason: "manual", optOutScope: "subtree", tombstonedAt: 123 }),
  ]);
  assert.ok(unsubscribed.includes("已退订（此条及子项）"), "已退订必须自报**范围**");
  assert.ok(unsubscribed.includes("自动规则不会再把你加回来"), "墓碑行说清「不会自动复活」");
  assert.ok(
    buttonTag(unsubscribed, "work-item-subscription-subscribe") !== null,
    "已退订 ⇒ 给「订阅」（复活）",
  );
  assert.equal(
    buttonTag(unsubscribed, "work-item-subscription-unsubscribe"),
    null,
    "已退订不给「退订」",
  );
});

test("真渲染｜别人的行不算我的：只有别人的订阅行时仍渲染「未订阅」", () => {
  const markup = renderControl([
    subscriberRow({ subjectType: "agent", subjectId: "ag-1", reason: "assignee" }),
  ]);
  assert.ok(markup.includes("未订阅"), "读面给的是全部主体，界面只认我那一行（退错人是最坏的错）");
  assert.ok(buttonTag(markup, "work-item-subscription-subscribe") !== null, "仍给「订阅」");
});

test("真渲染｜禁用原因（归档 / 读取失败）⇒ 动作按钮带 disabled 且原因可见", () => {
  for (const reason of [
    "squad.workItemDetail.subscription.disabled.archived",
    "squad.workItemDetail.subscription.disabled.readFailed",
  ]) {
    const markup = renderControl([subscriberRow({ reason: "manual" })], {
      disabledReasonMessageId: reason,
    });
    assert.ok(markup.includes(zhCN[reason]!), `禁用原因必须可见：${reason}`);
    const button = buttonTag(markup, "work-item-subscription-unsubscribe");
    assert.ok(button !== null && button.includes("disabled"), `${reason} ⇒ 动作按钮真的禁用`);
  }
});

/* 在途态是组件**自己的**呈现态（初值 false，静态渲染看不到它）⇒ 用结构断言钉住两件事：
   ① 在途包裹在页面的那次调用外层（`finally` 解锁，不靠 setTimeout/乐观猜测）；
   ② 两个动作都走同一个 `submit`（只有一处设 pending —— 第二处就是「一个动作两条禁用路径」）。 */
test("守卫｜在途态：由组件自己持有（submit 包裹页面调用，finally 解锁），两个动作同走一处", () => {
  const control = stripComments(readSource("squad/WorkItemSubscriptionControl.tsx"));
  assert.match(
    control,
    /const submit = \(intent: SubscriptionIntent\): void => \{\s*setPending\(true\);\s*void onSetSubscription\(intent\)\.finally\(\(\) => setPending\(false\)\);/,
    "在途态包在页面调用外层并 finally 解锁（禁用在飞的那一下，写完即解锁）",
  );
  assert.equal(
    (control.match(/setPending\(true\)/g) ?? []).length,
    1,
    "只有一处置在途（第二处 = 一个动作两条禁用路径）",
  );
  assert.equal(
    (control.match(/submit\(\{ kind: /g) ?? []).length,
    2,
    "两个动作（订阅 / 两档退订）都经同一个 submit",
  );
  assert.ok(
    control.includes("const disabled = disabledReasonMessageId !== null || pending;"),
    "禁用 = 不可写原因 或 在途（两个条件一处合判）",
  );
});

/* 结构守卫（写面纪律，逐条可变异）：
   ① 详情页**只**通过 `runCollaborationAction` 写订阅（页面是唯一执行点，子组件只拿回调）；
   ② 控件组件**不碰服务**（无 useServices / 无服务方法名）—— 拿到回调才画；
   ③ 写路径**无乐观更新**（不在本地伪造一条订阅行）；
   ④ 状态与两档选项都来自受测纯函数，页面不自己拼 reason/scope 文案。 */
test("守卫｜详情页：订阅写只经唯一执行器 + 控件恰挂载一次 + 状态判据吃读模型两格", () => {
  const page = stripComments(readSource("squad/WorkItemDetailPage.tsx"));
  assert.equal(
    (page.match(/setWorkItemSubscription\(/g) ?? []).length,
    1,
    "订阅写入口在详情页恰一处（第二处 = 第二条写路径）",
  );
  const writeIndex = page.indexOf("setWorkItemSubscription(");
  const executorIndex = page.lastIndexOf("runCollaborationAction(", writeIndex);
  assert.ok(
    executorIndex >= 0 && writeIndex - executorIndex < 400,
    "订阅写必须经 runCollaborationAction（唯一执行器：写完只刷新协作读模型）",
  );
  assert.equal((page.match(/<WorkItemSubscriptionControl/g) ?? []).length, 1, "订阅控件恰挂载一次");
  assert.ok(
    page.includes("subscribers={read.subscribers}") &&
      page.includes("viewerActor={read.viewerActor}"),
    "状态判据吃读模型的两格（订阅行 + 观察者身份）——不新开取数、不自造身份",
  );
  assert.ok(
    page.includes("subscriptionRequestFor(id, intent)"),
    "请求形状经单源函数产出（页面不自己拼判别联合）",
  );
  assert.ok(
    page.includes('writeDisabledReason("subscription", workItem, state.refreshFailure)'),
    "禁用原因复用 writeDisabledReason（归档 > 读取失败 > 可写，同一条判据只换面名）",
  );
  assert.ok(
    page.includes("disabledReasonMessageId={subscriptionReason}"),
    "控件拿到的正是那条判据的产物（不是另写一句「可写」的猜法）",
  );
  for (const forbidden of ["setOptimistic", "optimisticSubscription", "subscribed: true"]) {
    assert.ok(!page.includes(forbidden), `页面不得出现 ${forbidden}（无乐观更新、不伪造请求）`);
  }
  const control = stripComments(readSource("squad/WorkItemSubscriptionControl.tsx"));
  for (const forbidden of [
    "useServices(",
    "setWorkItemSubscription",
    "resolveWorkItemCollaborationService",
  ]) {
    assert.ok(!control.includes(forbidden), `控件不得出现 ${forbidden}（只拿回调，不自己调服务）`);
  }
  for (const needle of [
    "workItemSubscriptionView(",
    "unsubscribeScopeChoices()",
    "confirmUnsubscribeScope(",
    "requestUnsubscribeConfirm(",
  ]) {
    assert.ok(control.includes(needle), `控件必须消费纯函数 ${needle}（不在组件里重判档位与状态）`);
  }
});
