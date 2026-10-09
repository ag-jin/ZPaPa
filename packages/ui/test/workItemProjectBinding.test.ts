import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_SHORT_CODE_MAX_LENGTH, PROJECT_SHORT_CODE_MIN_LENGTH } from "@zcode/shared";
import {
  WORK_ITEM_NO_PROJECT_LANE_KEY,
  parseWorkItemProjectDraft,
  projectIdFromLaneKey,
  projectLaneKey,
  workItemProjectChipText,
  workItemProjectDraftErrorMessageId,
  workItemProjectEmptyDraft,
  workItemProjectFilterOptions,
  workItemProjectLaneDisplay,
  workItemProjectLaneKey,
  workItemProjectPrefillForParent,
  workItemProjectShortCodeLooksValid,
  workItemProjectText,
} from "../src/squad/workItemProjectViewModel.js";

/* 工作项↔项目绑定在 **UI 面的纯判据**（R-P2 项目绑定 · UI 轮）的用例 —— 四处消费面
   （看板项目列 / 卡片与列表 chip / 项目过滤 / 创建流的项目拾取器与内联新建）**共用同一份**
   判据，这里逐格钉住。

   期望值的独立真源：取证报告 `reports/2026-10-09-multica-issue-project-binding.md` 的 A1/A2/A3/A4
   四条（无项目是显式合法状态 / 不记忆上次项目 / chip 门控与列形态 / 多选 + 无项目开关）
   + shared 的短码闭集契约（`packages/shared/src/project.ts`，2-8 位大写字母数字）。
   这里**不重算实现**：短码形状的合法/非法值取自 shared 的常量与文档口径。 */

const PROJECTS = [
  { id: "p-alpha", name: "阿尔法", shortCode: "ALP" },
  { id: "p-beta", name: "贝塔", shortCode: "BET" },
];

// ---------- ① 显示文本：命中给名字、查不到回落 id、无项目给 null ----------

test("项目显示文本：命中 ⇒ 项目名；清单里查不到 ⇒ 回落 id（绝不回落成「无项目」）", () => {
  assert.equal(workItemProjectText({ projectId: "p-alpha", projects: PROJECTS }), "阿尔法");
  assert.equal(
    workItemProjectText({ projectId: "p-gone", projects: PROJECTS }),
    "p-gone",
    "挂在一个清单里看不见的项目上 ⇒ 显示 id（显示成「无项目」是在说一件不成立的事）",
  );
  assert.equal(workItemProjectText({ projectId: "p-alpha", projects: [] }), "p-alpha");
});

test("chip 文本：无项目 ⇒ null（整块不渲染）；有项目 ⇒ 名字/id", () => {
  assert.equal(workItemProjectChipText({ projects: PROJECTS }), null);
  assert.equal(workItemProjectChipText({ projectId: "p-beta", projects: PROJECTS }), "贝塔");
  assert.equal(workItemProjectChipText({ projectId: "p-x", projects: PROJECTS }), "p-x");
  assert.equal(
    workItemProjectChipText({ projectId: "p-x", projects: [] }),
    "p-x",
    "清单为空与清单缺席在**文本层**同形（是否渲染由调用方按清单可读性决定）",
  );
});

// ---------- ② 列键：无项目列有专用常量键，项目列键 = `project:<id>` ----------

test("列键编解码：无项目 ⇒ 专用常量键；项目 ⇒ `project:<id>`；解码可逆", () => {
  assert.equal(workItemProjectLaneKey(undefined), WORK_ITEM_NO_PROJECT_LANE_KEY);
  assert.equal(workItemProjectLaneKey("p-1"), "project:p-1");
  assert.equal(projectLaneKey("p-1"), "project:p-1");
  assert.equal(projectIdFromLaneKey("project:p-1"), "p-1");
  assert.equal(
    projectIdFromLaneKey(WORK_ITEM_NO_PROJECT_LANE_KEY),
    null,
    "无项目列没有项目 id（`null` 与「某个 id」是两种不同的事实）",
  );
});

test("项目列头投影：无项目 / 项目名 + 短码 / 未知挂接回落 id —— 三态分开", () => {
  assert.deepEqual(
    workItemProjectLaneDisplay({ laneKey: WORK_ITEM_NO_PROJECT_LANE_KEY, projects: PROJECTS }),
    { kind: "none" },
  );
  assert.deepEqual(workItemProjectLaneDisplay({ laneKey: "project:p-alpha", projects: PROJECTS }), {
    kind: "project",
    name: "阿尔法",
    shortCode: "ALP",
  });
  assert.deepEqual(workItemProjectLaneDisplay({ laneKey: "project:p-gone", projects: PROJECTS }), {
    kind: "missing",
    id: "p-gone",
  });
});

// ---------- ③ 过滤菜单的选项清单（多选 + 「无项目」恒第一） ----------

test("项目过滤选项：无项目恒第一 + 每项目一项（次序 = 清单次序）；清单缺席 ⇒ 只有无项目", () => {
  assert.deepEqual(workItemProjectFilterOptions(PROJECTS), [
    { kind: "none" },
    { kind: "project", id: "p-alpha", name: "阿尔法", shortCode: "ALP" },
    { kind: "project", id: "p-beta", name: "贝塔", shortCode: "BET" },
  ]);
  assert.deepEqual(
    workItemProjectFilterOptions(null),
    [{ kind: "none" }],
    "清单还没读到 ⇒ 只给「无项目」这一档（不假装清单是空的，也不造选项）",
  );
  assert.deepEqual(workItemProjectFilterOptions([]), [{ kind: "none" }]);
});

// ---------- ④ 创建流的项目预填（子项继承父项项目；**不记忆上次选择**） ----------

test("项目预填：父项有项目 ⇒ 预填它的；父项无项目/未选/不在候选里 ⇒ 无项目（不记忆上次）", () => {
  const candidates = [{ id: "parent-a", projectId: "p-alpha" }, { id: "parent-free" }];
  assert.equal(
    workItemProjectPrefillForParent({ parentId: "parent-a", candidates }),
    "p-alpha",
    "选了父项且父项有项目 ⇒ 预填父项的项目（子项继承）",
  );
  assert.equal(
    workItemProjectPrefillForParent({ parentId: "parent-free", candidates }),
    undefined,
    "父项没有项目 ⇒ 无项目",
  );
  assert.equal(workItemProjectPrefillForParent({ candidates }), undefined, "没选父项 ⇒ 无项目");
  assert.equal(
    workItemProjectPrefillForParent({ parentId: "parent-gone", candidates }),
    undefined,
    "父项不在候选里（已归档）⇒ 无项目（不猜）",
  );
  // 判据是**纯**的：同一输入两次调用同结论，且不读任何跨次状态（「上次选的项目」不存在）。
  assert.equal(
    workItemProjectPrefillForParent({ parentId: "parent-a", candidates }),
    workItemProjectPrefillForParent({ parentId: "parent-a", candidates }),
  );
});

// ---------- ⑤ 内联新建项目的预检（名称必填 + 短码走 shared 闭集） ----------

test("内联新建预检：名称 trim 后非空 + 短码走 shared 闭集（2-8 位大写字母数字，不静默规整）", () => {
  assert.deepEqual(workItemProjectEmptyDraft(), { name: "", shortCode: "" });
  assert.deepEqual(parseWorkItemProjectDraft({ name: "  平台 ", shortCode: "PLT" }), {
    kind: "ok",
    name: "平台",
    shortCode: "PLT",
  });
  assert.deepEqual(
    parseWorkItemProjectDraft({ name: "   ", shortCode: "PLT" }),
    { kind: "invalid", field: "name" },
    "名称只有空白 ⇒ 指名名称（不是一句话「输入不合法」）",
  );
  assert.deepEqual(
    parseWorkItemProjectDraft({ name: "平台", shortCode: "plt" }),
    { kind: "invalid", field: "shortCode", value: "plt" },
    "小写不是合法短码（判定在 shared，本层不静默大写化）",
  );
  assert.deepEqual(parseWorkItemProjectDraft({ name: "平台", shortCode: "" }), {
    kind: "invalid",
    field: "shortCode",
    value: "",
  });
  for (const bad of ["A", "ABCDEFGHI", "AB-1", " AB"]) {
    assert.equal(
      parseWorkItemProjectDraft({ name: "平台", shortCode: bad }).kind,
      "invalid",
      `「${bad}」必须被拒（形状判据单源在 shared）`,
    );
  }
  // 名称的坏判据排在短码之前（次序固定 ⇒ 三处同时坏时给同一句结论，行为可复现）。
  assert.deepEqual(parseWorkItemProjectDraft({ name: "", shortCode: "x" }), {
    kind: "invalid",
    field: "name",
  });
  // 坏在哪一项 ⇒ 哪一枚文案（穷尽映射，两语在 locale 里）。
  assert.equal(
    workItemProjectDraftErrorMessageId({ kind: "invalid", field: "name" }),
    "squad.workItems.project.nameRequired",
  );
  assert.equal(
    workItemProjectDraftErrorMessageId({ kind: "invalid", field: "shortCode", value: "x" }),
    "squad.workItems.project.shortCodeInvalid",
  );
  // 短码即时提示：空串不提示（一打开表单就一片红是噪音）；边界长度按 shared 常量。
  assert.equal(workItemProjectShortCodeLooksValid(""), true);
  assert.equal(workItemProjectShortCodeLooksValid("A".repeat(PROJECT_SHORT_CODE_MIN_LENGTH)), true);
  assert.equal(workItemProjectShortCodeLooksValid("A".repeat(PROJECT_SHORT_CODE_MAX_LENGTH)), true);
  assert.equal(
    workItemProjectShortCodeLooksValid("A".repeat(PROJECT_SHORT_CODE_MAX_LENGTH + 1)),
    false,
  );
  assert.equal(workItemProjectShortCodeLooksValid("plt"), false);
});
