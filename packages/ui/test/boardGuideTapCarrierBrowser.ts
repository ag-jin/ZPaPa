/**
 * 超长角色名**触屏全文载体**评估的浏览器断言（卡 #142 / C3-7 随行登记项，转自 #141 F3-141）
 * ——独立脚本，文件名不含 `.test.`（`node --test` 常规套件不收它）。
 *
 * 评估问题（#141 三绿 §6-1 / 四绿 F3-141）：行内处置指引的超长角色名走 `truncate + 原生 title`
 * （#141 收口），但移动 Chrome/Safari 长按不出原生 title——触屏上全名的 hover 无关载体是否在场？
 * E7 §8.2 原文要求「不依赖 title= hover 获取完整路径/徽章文案/角色名；提供点击展开、复制或弹窗」。
 *
 * 结论口径（本脚本取证）：
 *   - 生产形态（值来自编译器：`nextAssignee` = 管线首个无 done 记录角色，且校验器强制
 *     `nextAssignee ∈ assignees`、角色 ∈ 七角色词表）：点队列行 → 既有卡片弹窗的「执行摘要」
 *     管线渲染该角色节点 = **点击展开/弹窗载体在场**，且词表最长角色 `refactoring-optimizer`
 *     在弹窗内完整不截断 → 触屏全文可得，E7 要求满足。
 *   - 词表外合成名（`exhaustive-reverse-auditor`，仅在夹具/未过校验器的板出现）：弹窗不回显
 *     → 该形态无 hover 无关载体（边界如实登记；生产不可达：词表 + 管线成员双校验闸）。
 *
 * 命令（在 `packages/ui` 下）：
 *   node --import tsx test/boardGuideTapCarrierBrowser.ts
 */
import assert from "node:assert/strict";
import { guideTapCarrierDriverSource } from "./boardGuideTapCarrierBrowserDrivers.js";
import { GUIDE_BOARD } from "./boardGuideFixture.js";
import {
  buildPageHtml,
  bundleBoardPaneClient,
  compileBoardPaneCss,
  resolveElectronBinary,
  runBoardPaneInElectron,
} from "./boardKanbanBrowserLayoutHarness.js";

/**
 * 生产形态用例 = 七角色词表（B2-1/#99：`validate-sample.mjs` ROLES 与 `derive.mjs` RUN_ROLES
 * 同源）里**最长**的角色名；词表外用例 = #141 夹具合成名（刻意构造「超长 + 非管线」边界）。
 */
const PRODUCTION_ROLE = "refactoring-optimizer";
const FOREIGN_ROLE = "exhaustive-reverse-auditor";

interface CarrierRoleNode {
  role: string | null;
  text: string | null;
  truncated: boolean | null;
  title: string | null;
  next: string | null;
  marker: boolean;
}

interface CarrierTap {
  rowId: string | null;
  rowNext: { text: string | null; truncated: boolean | null; title: string | null };
  dialogRole: string | null;
  dialogText: string;
  pipelineRoles: CarrierRoleNode[];
  pipelineNext: string | null;
}

interface CarrierTier {
  width: number;
  production: CarrierTap;
  foreign: CarrierTap;
}

interface CarrierResult {
  ua: string;
  tiers: CarrierTier[];
}

/**
 * 载体场景板：在 `GUIDE_BOARD` 上落两个用例（其余形态与 #141 夹具同源，不另造形态）：
 *   - 卡 #221（含已解除依赖片）：`assignees` 管线插入词表最长角色并指向它 → 生产形态；
 *   - 卡 #220：接手位 = 词表外合成名（管线仍为默认四角色）→ 词表外形态；并补一片已解除依赖，
 *     与 #141 的截断形态（带依赖片的窄行）一致——两行窄面宽度条件相同，只变角色名来源。
 */
function buildCarrierBoardJson(): string {
  const raw = structuredClone(GUIDE_BOARD);
  const features = raw.features as Array<Record<string, unknown>>;
  const planB = features.find((feature) => feature.id === "plan:plan-guide-b");
  assert.ok(planB, "夹具里应有计划 B");
  const tasks = planB.tasks as Array<Record<string, unknown>>;
  const card221 = tasks.find((task) => task.no === 221);
  const card220 = tasks.find((task) => task.no === 220);
  assert.ok(card221 && card220, "夹具里应有卡 #220/#221");
  card221.assignees = [
    "implementer",
    PRODUCTION_ROLE,
    "test-verifier",
    "code-reviewer",
    "integrator",
  ];
  card221.nextAssignee = PRODUCTION_ROLE;
  card220.nextAssignee = FOREIGN_ROLE;
  const frontier = raw.frontier as Array<Record<string, unknown>>;
  const entry221 = frontier.find((entry) => entry.no === 221);
  const entry220 = frontier.find((entry) => entry.no === 220);
  assert.ok(entry221 && entry220, "夹具里应有 frontier #220/#221");
  entry221.nextAssignee = PRODUCTION_ROLE;
  entry220.nextAssignee = FOREIGN_ROLE;
  entry220.resolvedDeps = [210];
  return JSON.stringify(raw);
}

function tierOf(result: CarrierResult, width: number): CarrierTier {
  const tier = result.tiers.find((entry) => entry.width === width);
  assert.ok(tier, `应量取 ${width} 档`);
  return tier;
}

async function main(): Promise<void> {
  const bundle = await bundleBoardPaneClient();
  const boardJson = buildCarrierBoardJson();
  const css = await compileBoardPaneCss({ boards: [boardJson], viewModes: ["guide"] });
  console.log(
    `bundle bytes=${bundle.length} css bytes=${css.length} electron=${resolveElectronBinary()}`,
  );
  const result = (await runBoardPaneInElectron({
    pageHtml: buildPageHtml({ css, boardJson, bundle }),
    driver: guideTapCarrierDriverSource(),
    label: "guide-tap-carrier",
  })) as CarrierResult | null;
  console.log(`GUIDE_TAP_CARRIER_MEASUREMENTS=${JSON.stringify(result, null, 1)}`);
  assert.ok(result, "载体场景应回传量取结果");

  for (const width of [320, 375] as const) {
    const tier = tierOf(result, width);
    /* 1. 生产形态：触摸点行 → 既有弹窗在场且承载被点卡片。 */
    assert.equal(tier.production.dialogRole, "dialog", `${width} 档生产形态：点击行 → 弹窗在场`);
    assert.ok(
      tier.production.dialogText.includes("微条用法"),
      `${width} 档生产形态：弹窗承载被点卡片（#221 微条用法）`,
    );
    /* 2. 载体在场：弹窗管线含该角色节点，且**完整不截断**（触屏可读全名，不依赖 hover title）。 */
    const node = tier.production.pipelineRoles.find((entry) => entry.role === PRODUCTION_ROLE);
    assert.ok(node, `${width} 档生产形态：弹窗管线在场 ${PRODUCTION_ROLE}（点击展开载体）`);
    assert.ok(
      (node.text ?? "").includes(PRODUCTION_ROLE),
      `${width} 档生产形态：节点可视文本含全名（实测「${node.text}」）`,
    );
    assert.equal(node.truncated, false, `${width} 档生产形态：弹窗内全名不截断（真排版量取）`);
    assert.equal(node.marker, true, `${width} 档生产形态：该节点带「下一个」接手位标记`);
    assert.equal(
      tier.production.pipelineNext,
      PRODUCTION_ROLE,
      `${width} 档生产形态：接手位标记同源（下一手 = 该角色）`,
    );
    /* 3. 320 档（最窄下限）：行内可见文案确实截断——载体不是多余件：带依赖片的窄行放不下全名，
       全名由点击展开的弹窗承载（E7 §8.2「提供点击展开…或弹窗」）；375 档形态如实登记。 */
    if (width === 320) {
      assert.equal(
        tier.production.rowNext.truncated,
        true,
        `${width} 档生产形态：行内可见文案截断（带依赖片的窄行放不下全名；防线咬住不溢出）`,
      );
      assert.equal(
        tier.foreign.rowNext.truncated,
        true,
        `${width} 档词表外形态：行内可见文案截断（#141 同一防线）`,
      );
    }
    assert.ok(
      (tier.production.rowNext.title ?? "").includes(PRODUCTION_ROLE),
      `${width} 档生产形态：行内 title 仍是全文（桌面 hover 侧不丢信息）`,
    );

    /* 4. 词表外形态（边界登记）：弹窗管线无该角色 → hover 无关载体缺失；
       该形态不可由编译器产出（词表 + nextAssignee ∈ assignees 双校验），属夹具边界。 */
    assert.equal(tier.foreign.dialogRole, "dialog", `${width} 档词表外形态：点击行 → 弹窗在场`);
    assert.equal(
      tier.foreign.pipelineRoles.some((entry) => entry.role === FOREIGN_ROLE),
      false,
      `${width} 档词表外形态：弹窗管线不回显词表外名（载体缺失边界，如实登记）`,
    );
  }

  console.log(
    "GUIDE_TAP_CARRIER_BROWSER_ASSERTIONS_OK 生产形态（refactoring-optimizer）：320/375 触摸点行 → " +
      "弹窗管线完整回显全名（点击展开载体在场，E7 §8.2 满足）；词表外合成名（exhaustive-reverse-auditor）：" +
      "弹窗不回显（载体缺失边界登记，编译器词表+管线成员双校验下生产不可达）",
  );
}

await main();
