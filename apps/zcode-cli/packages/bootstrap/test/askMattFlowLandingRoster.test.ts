// 「ask-matt 落点注入件 10 件」白名单正文断言（卡 #228/F3；设计稿 §2.3 强覆盖清单 + §6 D8/D9 裁决）。
//
// 为什么这组用例承重：命令正文是提示词资产——上游 34 件技能的默认落点假设按件各不相同（GitHub
// issue、`.scratch/<feature>/` 草稿、仓库内自由选址……），本项目的真相源是看板（计划扫描面 +
// 任务目录 + 卡级 runs）。落点约定只能由**命令正文**注入，正文因此就是本卡的可执行契约：高风险件
// 缺件注入 = 模型按上游默认落点写盘 = 板上零来料（或写出扫描面外的幽灵产物）。
//
// 独立真源：设计稿 §2.3「强覆盖 = to-spec/to-tickets（既有正文）+ triage/wayfinder/prototype/
// research/implement-spec/diagnosing-bugs/improve-codebase-architecture/grill-with-docs」与卡文 #228
// 「既有 grill/to-spec/to-tickets + 新增 7 件」（合计 10 件，F1 三绿 P1 承接口径「F3 扩到 10 件」）；
// 既有三件的正文由 A5/A7/A8 落地断言各自钉死，本文件只补新增 7 件与 D9 交接文案。
// 撞洞登记：设计稿第 8 名（grill-with-docs）与卡文算术（3+7=10）冲突，按派发任务书「停件+一行回报」
// 停在本卡外（回报给编排者裁决；同源清单见 askMattFlowCommandParity.test.ts 的
// VERDICT_LANDING_OVERRIDE_SKILLS），不在本文件断言。

import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

/** 展开一个命令（真实 resolver，开态）；缺展开立即断言失败。 */
function expand(command: string): string {
  const expanded = resolveZCodeBuiltinPromptCommand(`/${command} 打磨这个想法`, {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, `/${command} 开态必须展开（落点约定只能由命令正文注入）`);
  return expanded;
}

/** 每件落点注入正文都必须含的公共段：通用边界段（D8 全件追加）+ 本件落点约定块头。 */
function assertLandingConventionShape(command: string, expanded: string): void {
  assert.match(
    expanded,
    /Landing convention/,
    `/${command} 正文必须含本件的落点约定块（卡文验收「白名单件正文含落点约定」）`,
  );
  assert.match(
    expanded,
    /Board boundary \(this project\):/,
    `/${command} 正文必须保留通用边界段（D8 全件追加）`,
  );
  assert.match(expanded, /打磨这个想法/, `/${command} 展开必须保留用户参数`);
}

test("/triage 展开：请求面落到看板（计划稿卡行），禁外部 tracker 与 .scratch 草稿", () => {
  const expanded = expand("triage");
  assertLandingConventionShape("triage", expanded);
  assert.ok(
    expanded.includes(".zcode/<task-id>/plans/"),
    "/triage 必须点名请求面 = 看板计划扫描面（`plans/` 计划稿），否则上游默认去 GitHub 开 issue",
  );
  assert.match(
    expanded,
    /external tracker/,
    "/triage 必须明令禁写外部 tracker（外部留言板上零来料，且与产品零板写者口径相悖）",
  );
});

test("/wayfinder 展开：地图与决策票 = 计划稿卡行 + blocked-by 稳定号，禁外部 tracker", () => {
  const expanded = expand("wayfinder");
  assertLandingConventionShape("wayfinder", expanded);
  assert.ok(
    expanded.includes(".zcode/<task-id>/plans/plan-<slug>.md"),
    "/wayfinder 的地图与决策票必须落计划稿卡行（上游默认 = tracker 上的 map/child issues）",
  );
  assert.match(
    expanded,
    /> blocked-by: <稳定号>/,
    "/wayfinder 的票间阻塞边必须走卡行依赖位（稳定号），否则地图依赖不落板",
  );
  assert.match(expanded, /external tracker/, "/wayfinder 必须明令禁写外部 tracker");
});

test("/prototype 展开：一次性产物离扫描面，判决与指针落任务设计区/看板卡", () => {
  const expanded = expand("prototype");
  assertLandingConventionShape("prototype", expanded);
  assert.ok(
    expanded.includes(".zcode/<task-id>/design/"),
    "/prototype 的判决与上下文指针必须落任务设计区（上游默认只留 throwaway 分支与实现 issue）",
  );
  assert.match(
    expanded,
    /scan surface/,
    "/prototype 必须点名一次性产物不得进计划扫描面（`plans/` 内非计划文件会发成幽灵草稿）",
  );
});

test("/research 展开：调研笔记落任务设计区，禁进 plans/ 与 .scratch", () => {
  const expanded = expand("research");
  assertLandingConventionShape("research", expanded);
  assert.ok(
    expanded.includes(".zcode/<task-id>/design/"),
    "/research 的笔记落点必须钉在任务设计区（上游默认「仓库内就近选址」，本仓 = design 区）",
  );
  assert.match(
    expanded,
    /plans\//,
    "/research 必须点名禁入计划扫描面 `plans/`（笔记会被编译器当计划稿发草稿卡）",
  );
});

test("/implement-spec 展开：spec 与票 = 计划稿卡行，产物记录进卡级 run（禁外部 tracker）", () => {
  const expanded = expand("implement-spec");
  assertLandingConventionShape("implement-spec", expanded);
  assert.ok(
    expanded.includes(".zcode/<task-id>/plans/plan-<slug>.md"),
    "/implement-spec 的 spec 与票必须映射到计划稿卡行（上游默认 GitHub issue + draft PR 单轨）",
  );
  assert.match(
    expanded,
    /board card/,
    "/implement-spec 必须点名卡级 run 是执行记录（PR 不是唯一产物面，见 D9 交接）",
  );
});

test("/diagnosing-bugs 展开：诊断进卡级 run，回归测试与探针清理按看板收口", () => {
  const expanded = expand("diagnosing-bugs");
  assertLandingConventionShape("diagnosing-bugs", expanded);
  assert.match(
    expanded,
    /board card/,
    "/diagnosing-bugs 必须点名诊断/回归测试记录进看板卡 run（上游默认只留 commit message）",
  );
  assert.ok(
    expanded.includes(".zcode/<task-id>/design/"),
    "/diagnosing-bugs 需要留存的诊断材料落任务设计区（上游默认无落点约定）",
  );
});

test("/improve-codebase-architecture 展开：报告留 OS 临时区，候选进看板流程（plans/ 计划稿）", () => {
  const expanded = expand("improve-codebase-architecture");
  assertLandingConventionShape("improve-codebase-architecture", expanded);
  assert.match(
    expanded,
    /temp/i,
    "报告必须留在 OS 临时区（上游明示不入 repo，本件要保持该边界并与看板扫描面隔离）",
  );
  assert.ok(
    expanded.includes(".zcode/<task-id>/plans/"),
    "深化候选要成为看板想法 = 走 /grill → /to-spec → /to-tickets 落计划稿（禁外部 tracker）",
  );
});

// D9 裁决（设计稿 §6 D9：轻量旁路 + 交接文案）：ask-matt 实现段与看板段（派发→四绿→integrator）
// 的交接物 = 卡行 + 上板。两条实现入口（/matt-implement 与 /implement-spec）必须成文
// 「实现完成≠合并完成 / 产物交看板卡收口 / 绿数以看板为准」，否则绕过 integrator 唯一出口会让
// `--check` 对账反复点名 → 豁免滥用 → 机械性瓦解（C 红队最易掩盖三条之三）。
function assertHandoffBoundary(command: string, expanded: string): void {
  assert.match(
    expanded,
    /not merge complete/i,
    `/${command} 必须成文「实现完成≠合并完成」（D9 交接文案第一句）`,
  );
  assert.match(
    expanded,
    /board card/i,
    `/${command} 必须成文「产物交看板卡收口」（D9 交接文案第二句）`,
  );
  assert.match(
    expanded,
    /integrator/,
    `/${command} 必须点名收口出口 = integrator（看板四绿管线的唯一合并者）`,
  );
  assert.match(
    expanded,
    /green counts come from the board/i,
    `/${command} 必须成文「绿数统计以看板为准」（D9 方法层 vs 统计层消歧）`,
  );
}

test("/matt-implement 展开：D9 交接文案在场（实现完成≠合并完成+产物交卡+绿数以看板为准）", () => {
  const expanded = expand("matt-implement");
  assert.match(expanded, /Required skills: `implement`\./, "换名件仍必须装载原名技能（D5）");
  assertHandoffBoundary("matt-implement", expanded);
});

test("/implement-spec 展开：D9 交接文案在场（并行实现管线产物同样须经看板收口）", () => {
  const expanded = expand("implement-spec");
  assert.match(expanded, /Required skills: `implement-spec`\./, "命令必须装载 implement-spec 技能");
  assertHandoffBoundary("implement-spec", expanded);
});
