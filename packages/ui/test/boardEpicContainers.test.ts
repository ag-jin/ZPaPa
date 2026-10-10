import assert from "node:assert/strict";
import test from "node:test";
import { groupBoardFeaturesByEpic } from "../src/board/boardEpicContainers.js";
import { parseBoardJson, type BoardViewModel } from "../src/board/boardViewModel.js";
import { EPIC_BOARD, EPIC_BOARD_FLAT } from "./boardEpicFixture.js";

/**
 * epic 三层容器（epic ⊃ phase ⊃ 稿）的视图模型与容器装配守卫（卡 #87 / A4-1）。
 *
 * 期望值的独立真源：markers.md §10（三层容器与登记行语法）、board-consumption-contract.md §0
 * 字段表（`epics[]` / `features[].epic`/`phase`）与 board.md 的 epic 章渲染口径（A3-2/#85：
 * 无归属稿与孤儿引用稿顶层平铺、不为孤儿造章；期次序升序）。
 */

function readyBoard(raw: unknown): BoardViewModel {
  const outcome = parseBoardJson(JSON.stringify(raw));
  assert.equal(outcome.kind, "ready", "夹具必须是 ready");
  if (outcome.kind !== "ready") throw new Error("夹具必须是 ready");
  return outcome.board;
}

test("视图模型：epics[] 登记行透出 code/title/status；零 epic 板 → 空数组（AD-8 零变化）", () => {
  assert.deepEqual(readyBoard(EPIC_BOARD).epics, [
    { code: "KANB", title: "看板系统", status: "active" },
    { code: "CNCL", title: "取消史诗", status: "cancelled" },
  ]);
  assert.deepEqual(
    readyBoard(EPIC_BOARD_FLAT).epics,
    [],
    "无 epics 键 = 零 epic 项目：不造登记行、不猜归属",
  );
});

test("视图模型：features[].epic/phase 归属对原值透出（登记 id / 稳定号 / 缺省）", () => {
  const board = readyBoard(EPIC_BOARD);
  const byId = new Map(board.features.map((feature) => [feature.id, feature]));
  const epic = (id: string) => byId.get(id)?.epic;
  const phase = (id: string) => byId.get(id)?.phase;

  assert.equal(epic("plan:plan-boardv2-a"), "epic:KANB", "登记 id 形态原样透出");
  assert.equal(phase("plan:plan-boardv2-a"), 1);
  assert.equal(epic("plan:plan-by-number"), "31", "稳定号形态原样保留（十进制文本）");
  assert.equal(phase("plan:plan-by-number"), 1);
  assert.equal(epic("spec:preview-channel"), null, "双缺省 = 无归属（合法形态，不是缺口）");
  assert.equal(phase("spec:preview-channel"), null);
});

test("三层容器装配：epic 章按登记序、期次升序（KANB1/KANB2 双字段合成名，AD-3/AD-4）", () => {
  const grouping = groupBoardFeaturesByEpic(readyBoard(EPIC_BOARD));
  assert.deepEqual(
    grouping.epics.map((group) => group.epic.code),
    ["KANB", "CNCL"],
    "epic 章序 = 登记序",
  );
  const kanb = grouping.epics[0];
  assert.ok(kanb, "KANB 章应存在");
  assert.deepEqual(
    kanb.phases.map((phaseGroup) => [
      phaseGroup.name,
      phaseGroup.phase,
      phaseGroup.features.map((f) => f.no),
    ]),
    [
      ["KANB1", 1, [31, 32]],
      ["KANB2", 2, [34]],
    ],
    "期次名 = epic 码 + 期次序；一期两稿同组（AD-2）；期内成员保持文档序",
  );
  assert.deepEqual(
    kanb.members.map((feature) => feature.no),
    [31, 32, 34],
    "成员稿清单（层计数来源）",
  );
  const cncl = grouping.epics[1];
  assert.ok(cncl, "CNCL 章应存在");
  assert.deepEqual(
    [cncl.epic.status, cncl.phases.map((phaseGroup) => phaseGroup.name)],
    ["cancelled", ["CNCL1"]],
    "终态登记行照常成章（成员稿照常入组：成员活跃不复活 epic 终态，也不吞成员）",
  );
  assert.deepEqual(
    cncl.members.map((feature) => feature.no),
    [41],
  );
});

test("三层容器装配：无归属/孤儿引用/稳定号引用稿顶层平铺（文档序），且不造「未归属」容器", () => {
  const grouping = groupBoardFeaturesByEpic(readyBoard(EPIC_BOARD));
  assert.deepEqual(
    grouping.ungrouped.map((feature) => feature.no),
    [1, 33, 35],
    "无归属（PREV）、稳定号引用（NUM1=31）、孤儿引用（ORPH=epic:NOPE）都顶层平铺",
  );
});

test("三层容器装配：零 epic 板 = 全量顶层平铺（AD-8 零变化）", () => {
  const grouping = groupBoardFeaturesByEpic(readyBoard(EPIC_BOARD_FLAT));
  assert.deepEqual(grouping.epics, [], "无 epics 键 → 不造容器");
  assert.deepEqual(
    grouping.ungrouped.map((feature) => feature.no),
    [1, 31, 32, 33, 34, 35, 41],
    "全部稿按文档序平铺（渲染序与既有扁平树一致）",
  );
});
