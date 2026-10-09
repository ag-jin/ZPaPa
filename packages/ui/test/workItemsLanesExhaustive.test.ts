import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORK_ITEM_STATUS_CATEGORY,
  type Squad,
  type TeamAgent,
  type WorkItem,
  type WorkItemStatusCategory,
  type WorkItemStatusKey,
} from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { RUN_SETTLE_REASON_MESSAGE_IDS } from "../src/squad/squadRunHistoryViewModel.js";
import {
  WORK_ITEM_NO_PROJECT_LANE_KEY,
  projectIdFromLaneKey,
  workItemProjectLaneDisplay,
  workItemProjectLaneKey,
} from "../src/squad/workItemProjectViewModel.js";
import {
  WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS,
  flattenWorkItemBoard,
  groupWorkItemBoard,
  workItemLabelChips,
  type WorkItemBoardLane,
  type WorkItemLaneDimension,
} from "../src/squad/workItemsViewModel.js";

/* 看板泳道（#15）与标签投影（#11）**独立穷举复验**（test-verifier，2026-10-07）。

   期望值来自拆解报告 §5.2（维度与泳道集合）/ §5.1（只切根、子树随根）/ §3.1-3.2（标签呈现与
   「不造第二套标签系统」），不是从实现反推：
   · `none` = 现状（单条、与 `flattenWorkItemBoard` 逐格等价）；
   · `statusCategory` = **固定 4 条**（unstarted → started → done → closed），由**根**的
     `WORK_ITEM_STATUS_CATEGORY` 决定，空泳道保留；
   · `assignee` = `user` 固定第一条 + 其余**首现顺序**，不产生空泳道；
   · 子树**整体随根落位**（批语义：批根与子项必须同泳道、且在泳道内连续）；
   · 标签是纯描述：不得改变泳道划分、不得成为分组键。 */

// ---------- 夹具 ----------

const KEY_TO_CATEGORY: Record<WorkItemStatusKey, WorkItemStatusCategory> = {
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

const wi = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  workspaceIdentity: "id",
  workspacePath: "/w/a",
  title: `标题 ${id}`,
  body: "",
  status: "todo",
  assignee: { type: "user", id: "user" },
  labels: [],
  properties: {},
  position: 0,
  ...over,
});

const EMPTY_ROSTER = { teamAgents: [] as TeamAgent[], squads: [] as Squad[] };

const lanes = (
  items: WorkItem[],
  dimension: WorkItemLaneDimension,
  roster = EMPTY_ROSTER,
): WorkItemBoardLane[] => groupWorkItemBoard({ items, dimension, roster });

/** 泳道 → [[id, depth], …]（断言只看被判据决定的东西：分组、行序、深度）。 */
const shape = (result: WorkItemBoardLane[]): Array<[string, Array<[string, number]>]> =>
  result.map((lane) => [lane.key, lane.rows.map((row) => [row.item.id, row.depth])]);

/** 行集合护栏（坏数据用例的通用不变式）：每行的 **id** 恰好出现一次。
    口径说明：投影按 id 防御重复（`visited`），所以**重复 id 的第二个实例不产生第二行** ——
    这与 `flattenWorkItemBoard` 同一份 DFS，因此比较基准是「去重后的 id 集合」。 */
const assertEachRowExactlyOnce = (result: WorkItemBoardLane[], items: WorkItem[]): void => {
  const ids = result.flatMap((lane) => lane.rows.map((row) => row.item.id));
  const uniqueIds = [...new Set(items.map((item) => item.id))];
  assert.deepEqual(
    [...ids].sort(),
    [...uniqueIds].sort(),
    "行集合必须与输入的 id 集合一致（不丢行、不重复）",
  );
  assert.equal(new Set(ids).size, ids.length, "同一行不得出现在两条泳道里");
  assert.equal(
    result.reduce((sum, lane) => sum + lane.count, 0),
    ids.length,
    "count 之和 = 行数",
  );
  for (const lane of result) assert.equal(lane.count, lane.rows.length, "count 必须等于该泳道行数");
};

// ---------- ① none：与 flattenWorkItemBoard 逐格等价（含手写期望） ----------

test("穷举｜none：行序 = 前序 DFS（手写期望），且与 flattenWorkItemBoard 逐格相同", () => {
  const items = [
    wi("p1"),
    wi("c1", { parentId: "p1" }),
    wi("g1", { parentId: "c1" }),
    wi("p2"),
    wi("orphan", { parentId: "gone" }),
  ];
  assert.deepEqual(
    shape(lanes(items, "none")),
    [
      [
        "none",
        [
          ["p1", 0],
          ["c1", 1],
          ["g1", 2],
          ["p2", 0],
          ["orphan", 0],
        ],
      ],
    ],
    "孤儿（父项不在集合里）当根，兄弟保持给定顺序",
  );
  assert.deepEqual(
    lanes(items, "none")[0]!.rows,
    flattenWorkItemBoard(items),
    "none 必须与既有投影逐格等价（同一份根判据与 DFS）",
  );
});

test("穷举｜none：空输入 ⇒ 空数组（不造泳道骨架；空态由看板的空态分支负责）", () => {
  for (const dimension of ["none", "statusCategory", "assignee"] as WorkItemLaneDimension[]) {
    assert.deepEqual(lanes([], dimension), [], `${dimension} 的空输入必须是 []`);
  }
});

test("穷举｜none：五层深链（含最大深度）深度逐层 +1、不重排", () => {
  const items = [
    wi("d0"),
    wi("d1", { parentId: "d0" }),
    wi("d2", { parentId: "d1" }),
    wi("d3", { parentId: "d2" }),
    wi("d4", { parentId: "d3" }),
  ];
  assert.deepEqual(shape(lanes(items, "none"))[0]![1], [
    ["d0", 0],
    ["d1", 1],
    ["d2", 2],
    ["d3", 3],
    ["d4", 4],
  ]);
});

// ---------- ② statusCategory：4 条固定骨架 × 6 键 ----------

test("穷举｜statusCategory：6 个状态键**逐个**落进手写表的 category（4 条骨架恒在，空泳道为 0）", () => {
  for (const [status, category] of Object.entries(KEY_TO_CATEGORY) as Array<
    [WorkItemStatusKey, WorkItemStatusCategory]
  >) {
    const result = lanes([wi(`wi-${status}`, { status })], "statusCategory");
    assert.deepEqual(
      result.map((lane) => lane.key),
      ["unstarted", "started", "done", "closed"],
      "泳道集合与顺序是固定骨架（不随数据增减）",
    );
    const hit = result.find((lane) => lane.key === category)!;
    assert.deepEqual(
      hit.rows.map((row) => row.item.id),
      [`wi-${status}`],
      `${status} 必须落在 ${category}`,
    );
    assert.equal(
      result.filter((lane) => lane.rows.length > 0).length,
      1,
      `${status} 只应出现在一条泳道里（不得同时落两条）`,
    );
    for (const lane of result) {
      if (lane.key !== category)
        assert.equal(lane.count, 0, `空泳道 ${lane.key} 必须显示 0 而不是消失`);
    }
  }
  // 交叉核对：手写表必须与共享层词表一致（两份都错才算通过 —— 单独任一份改错都会红）。
  assert.deepEqual({ ...WORK_ITEM_STATUS_CATEGORY }, KEY_TO_CATEGORY);
});

test("穷举｜statusCategory：4 条泳道的空数据骨架（只有一条 done ⇒ 另外三条仍在且为 0）", () => {
  assert.deepEqual(shape(lanes([wi("only", { status: "done" })], "statusCategory")), [
    ["unstarted", []],
    ["started", []],
    ["done", [["only", 0]]],
    ["closed", []],
  ]);
});

// ---------- ③ 只切根：子树随根（批语义） ----------

test("穷举｜只切根：根 todo + 子 in_progress + 孙 done ⇒ 整棵子树在 unstarted 泳道、深度不变、批内连续", () => {
  const items = [
    wi("root", { status: "todo" }),
    wi("child", { parentId: "root", status: "in_progress" }),
    wi("grand", { parentId: "child", status: "done" }),
    wi("other", { status: "in_progress" }),
  ];
  const result = lanes(items, "statusCategory");
  assert.deepEqual(
    shape(result),
    [
      [
        "unstarted",
        [
          ["root", 0],
          ["child", 1],
          ["grand", 2],
        ],
      ],
      ["started", [["other", 0]]],
      ["done", []],
      ["closed", []],
    ],
    "子项/孙项跟着**根**走：子项状态是 started/done 也不自成泳道",
  );
  // 批内连续性（比分属更强的性质）：子树的行在泳道内必须相邻。
  const unstarted = result[0]!.rows.map((row) => row.item.id);
  assert.deepEqual(
    unstarted,
    ["root", "child", "grand"],
    "批的行在泳道内连续（时间线挂载点两侧不插别的批）",
  );
});

test("穷举｜只切根：两个批交错给出（对方的子项插在中间）也不串泳道、不串批", () => {
  const items = [
    wi("A", { status: "todo" }),
    wi("B", { status: "done" }),
    wi("a1", { parentId: "A", status: "blocked" }),
    wi("b1", { parentId: "B", status: "cancelled" }),
    wi("a2", { parentId: "a1", status: "todo" }),
  ];
  const result = lanes(items, "statusCategory");
  assert.deepEqual(shape(result), [
    [
      "unstarted",
      [
        ["A", 0],
        ["a1", 1],
        ["a2", 2],
      ],
    ],
    ["started", []],
    [
      "done",
      [
        ["B", 0],
        ["b1", 1],
      ],
    ],
    ["closed", []],
  ]);
});

test("穷举｜只切根：同一泳道多个根按输入顺序（不重排、不按标题/状态排序）", () => {
  const items = [
    wi("b", { status: "in_progress" }),
    wi("a", { status: "blocked" }),
    wi("c", { status: "in_review" }),
  ];
  assert.deepEqual(
    shape(lanes(items, "statusCategory"))[1]!,
    [
      "started",
      [
        ["b", 0],
        ["a", 0],
        ["c", 0],
      ],
    ],
    "泳道内次序 = 输入次序（repo 已按 position → created_at → id 排好）",
  );
});

// ---------- ④ assignee：user 首条 + 首现序 ----------

test("穷举｜assignee：user 固定第一条（哪怕它在输入里最后出现），其余按首现序、无空泳道", () => {
  const items = [
    wi("a", { assignee: { type: "agent", id: "ta-2" } }),
    wi("b", { assignee: { type: "squad", id: "sq-1" } }),
    wi("c", { assignee: { type: "agent", id: "ta-1" } }),
    wi("d", { assignee: { type: "user", id: "user" } }),
    wi("e", { assignee: { type: "agent", id: "ta-2" } }),
  ];
  assert.deepEqual(
    shape(lanes(items, "assignee")),
    [
      ["user", [["d", 0]]],
      [
        "agent:ta-2",
        [
          ["a", 0],
          ["e", 0],
        ],
      ],
      ["squad:sq-1", [["b", 0]]],
      ["agent:ta-1", [["c", 0]]],
    ],
    "user 第一条 + 其余按首现（agent:ta-2 先于 squad:sq-1 先于 agent:ta-1）",
  );
});

test("穷举｜assignee：agent 与 squad 是不同泳道（同 id 不合并），未知 id 也不与 user 合并", () => {
  const items = [
    wi("a", { assignee: { type: "agent", id: "same-id" } }),
    wi("b", { assignee: { type: "squad", id: "same-id" } }),
    wi("c", { assignee: { type: "agent", id: "gone" } }),
  ];
  assert.deepEqual(
    shape(lanes(items, "assignee")).map(([key]) => key),
    ["agent:same-id", "squad:same-id", "agent:gone"],
    "泳道键 = 具体对象（type:id）：同名不同类不合并，未知对象自成一条（不并进 user）",
  );
});

test("穷举｜assignee：子树随根（子项指派给别人也不自成泳道），批内连续", () => {
  const items = [
    wi("root", { assignee: { type: "user", id: "user" } }),
    wi("c1", { parentId: "root", assignee: { type: "agent", id: "ta-9" } }),
    wi("c2", { parentId: "c1", assignee: { type: "squad", id: "sq-9" } }),
  ];
  const result = lanes(items, "assignee");
  assert.deepEqual(
    shape(result),
    [
      [
        "user",
        [
          ["root", 0],
          ["c1", 1],
          ["c2", 2],
        ],
      ],
    ],
    "泳道集合只看根",
  );
  assertEachRowExactlyOnce(result, items);
});

test("穷举｜assignee：没有 user 根 ⇒ 骨架从首现对象开始（不凭空造一条「我」泳道）", () => {
  const items = [wi("a", { assignee: { type: "agent", id: "ta-1" } })];
  assert.deepEqual(
    shape(lanes(items, "assignee")).map(([key]) => key),
    ["agent:ta-1"],
  );
});

// ---------- ⑤ 坏数据格 ----------

test("穷举｜坏数据：环（互指）/ 自指 / 重复 id / 父项缺失 —— 每条泳道划分都不丢行、不死循环", () => {
  const cycle = [wi("a", { parentId: "b" }), wi("b", { parentId: "a" })];
  assertEachRowExactlyOnce(lanes(cycle, "statusCategory"), cycle);
  assertEachRowExactlyOnce(lanes(cycle, "assignee"), cycle);

  const selfParent = [wi("self", { parentId: "self" })];
  assert.deepEqual(
    shape(lanes(selfParent, "statusCategory")),
    [
      ["unstarted", [["self", 0]]],
      ["started", []],
      ["done", []],
      ["closed", []],
    ],
    "自指：落在自己名下且不死循环",
  );

  const duplicatedId = [
    wi("dup", { status: "todo" }),
    wi("dup", { status: "done", parentId: "p1" }),
    wi("p1"),
  ];
  assertEachRowExactlyOnce(lanes(duplicatedId, "statusCategory"), duplicatedId);
  // 重复 id 的**第二个实例不再是独立行**（按 id 防御，与 flattenWorkItemBoard 同一份 DFS）：
  // 这里把「投影与既有压平在坏数据下仍逐格一致」钉住，而不是把重复行当成合法输出。
  assert.deepEqual(
    lanes(duplicatedId, "statusCategory").flatMap((lane) => lane.rows),
    flattenWorkItemBoard(duplicatedId),
    "坏数据（重复 id / 父项缺失）下分组行序仍与 flatten 逐格一致",
  );

  const mixed = [
    wi("A", { status: "todo" }),
    wi("A1", { parentId: "A", status: "cancelled" }),
    wi("LOST", { parentId: "A1", status: "blocked" }),
    wi("ORPHAN", { parentId: "missing", status: "done" }),
    wi("solo", { status: "in_review" }),
  ];
  assert.deepEqual(shape(lanes(mixed, "statusCategory")), [
    [
      "unstarted",
      [
        ["A", 0],
        ["A1", 1],
        ["LOST", 2],
      ],
    ],
    ["started", [["solo", 0]]],
    ["done", [["ORPHAN", 0]]],
    ["closed", []],
  ]);
});

test("穷举｜坏数据 × assignee：孤儿与自指也按**根**（它自己）落位", () => {
  const items = [
    wi("orphan", { parentId: "gone", assignee: { type: "agent", id: "ta-1" } }),
    wi("self", { parentId: "self", assignee: { type: "squad", id: "sq-1" } }),
  ];
  assert.deepEqual(
    shape(lanes(items, "assignee")).map(([key]) => key),
    ["agent:ta-1", "squad:sq-1"],
  );
  assertEachRowExactlyOnce(lanes(items, "assignee"), items);
});

// ---------- ⑥ 确定性 ----------

test("穷举｜确定性：两次调用逐字一致；同泳道内换序不改泳道顺序（只改行内次序）", () => {
  const items = [
    wi("x", { assignee: { type: "agent", id: "ta-2" } }),
    wi("y", { assignee: { type: "user", id: "user" } }),
    wi("z", { assignee: { type: "agent", id: "ta-1" } }),
  ];
  assert.deepEqual(lanes(items, "assignee"), lanes(items, "assignee"), "同一输入两次调用逐字相同");
  assert.deepEqual(lanes(items, "statusCategory"), lanes(items, "statusCategory"));
  const swapped = [items[0]!, items[2]!, items[1]!];
  assert.deepEqual(
    lanes(swapped, "assignee").map((lane) => lane.key),
    lanes(items, "assignee").map((lane) => lane.key),
    "同泳道内换序不改泳道次序（次序由首现决定，不由行内位置决定）",
  );
});

// ---------- ⑦ 标签与泳道零耦合（不造第二套标签系统） ----------

test("零耦合｜标签不是分组键：标签全换 ⇒ 三种维度的泳道逐字不变", () => {
  const base = [
    wi("a", { status: "todo" }),
    wi("b", { status: "done", parentId: "a" }),
    wi("c", { status: "blocked", assignee: { type: "agent", id: "ta-1" } }),
  ];
  const labelled = [
    { ...base[0]!, labels: ["P0", "前端"] },
    { ...base[1]!, labels: ["P0"] },
    { ...base[2]!, labels: ["后端", "紧急", "待讨论", "第五个", "第六个"] },
  ];
  for (const dimension of ["none", "statusCategory", "assignee"] as WorkItemLaneDimension[]) {
    assert.deepEqual(
      shape(lanes(labelled, dimension)),
      shape(lanes(base, dimension)),
      `${dimension} 维度的泳道划分（键 / 行序 / 深度）不得受标签影响`,
    );
  }
  assert.deepEqual(
    lanes(labelled, "statusCategory").map((lane) => lane.count),
    lanes(base, "statusCategory").map((lane) => lane.count),
    "泳道计数也不得受标签影响",
  );
});

test("零耦合｜对抗夹具：标签内容恰好等于泳道键（unstarted / user / agent:ta-1）也不影响分组", () => {
  const items = [
    wi("a", { status: "todo", labels: ["started", "user", "agent:ta-1"] }),
    wi("b", { status: "todo", labels: ["unstarted", "closed", "user"] }),
  ];
  assert.deepEqual(
    shape(lanes(items, "statusCategory")),
    [
      [
        "unstarted",
        [
          ["a", 0],
          ["b", 0],
        ],
      ],
      ["started", []],
      ["done", []],
      ["closed", []],
    ],
    "标签文本撞上泳道键：泳道仍只由根的状态 category 决定",
  );
  assert.deepEqual(
    shape(lanes(items, "assignee")),
    [
      [
        "user",
        [
          ["a", 0],
          ["b", 0],
        ],
      ],
    ],
    "标签里的 agent:ta-1 不得变出一条 agent 泳道",
  );
});

test("零耦合｜4 category 文案映射穷尽且与 6 键词表不重合（两套词汇并存、用途不同）", () => {
  assert.deepEqual(Object.keys(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS).sort(), [
    "closed",
    "done",
    "started",
    "unstarted",
  ]);
  for (const key of Object.keys(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS)) {
    assert.equal(
      (WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS as Record<string, string>)[key],
      `squad.workItems.lane.statusCategory.${key}`,
      "category 文案键必须一一对应（穷尽：加 category 会在编译期失败）",
    );
  }
  // 两套词汇并存：category 文案键与 6 键状态文案键不得共用（用途不同，不得合并成一套）。
  const categoryIds = new Set(Object.values(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS));
  for (const status of Object.keys(KEY_TO_CATEGORY)) {
    assert.ok(
      !categoryIds.has(`squad.workItems.status.${status}`),
      "category 文案与状态文案是两套词汇（不得互相顶替）",
    );
  }
});

// ---------- ⑩ project：每项目一列 + 「无项目」列恒保留（R-P2 项目绑定 · UI 轮） ----------

/* 形态真源：multica `board-view.tsx:184-198`（`grouping === "project"` 分支）+ `:95-134`
   （`projectColumn` / `withNoProjectColumn`）—— **无项目列就是一条普通列且恒保留**
   （multica 里它是拖拽落点；本仓 v1 拖拽只在状态分组开放，但「恒保留」这条形态不变）。
   项目列的**次序**取项目清单本身的次序（repo 已按 `created_at ASC, id ASC` 给好），本层不重排
   —— 按名字/locale 排序会让列序随改名漂移（与 assignee 维度同一理由）。 */
const PROJECTS = [
  { id: "p-alpha", name: "阿尔法", shortCode: "ALP" },
  { id: "p-beta", name: "贝塔", shortCode: "BET" },
];

test("穷举｜project：无项目列恒第一（为 0 也在），其后每项目一列（空列同样保留）", () => {
  const result = groupWorkItemBoard({
    items: [wi("only", { projectId: "p-beta" })],
    dimension: "project",
    roster: EMPTY_ROSTER,
    projects: PROJECTS,
  });
  assert.deepEqual(
    result.map((lane) => [lane.key, lane.count]),
    [
      ["project:none", 0],
      ["project:p-alpha", 0],
      ["project:p-beta", 1],
    ],
    "骨架不随数据跳动：无项目列恒第一、空项目列保留（与 statusCategory 同一条口径）",
  );
});

test("穷举｜project：只切根 —— 子项的项目与根不同也随根落位；无项目行落 `project:none`", () => {
  const items = [
    wi("root", { projectId: "p-beta" }),
    wi("child", { parentId: "root" }), // 子项无项目：仍随根
    wi("free", {}), // 无项目根
  ];
  const result = groupWorkItemBoard({
    items,
    dimension: "project",
    roster: EMPTY_ROSTER,
    projects: PROJECTS,
  });
  assert.deepEqual(
    result.map((lane) => [lane.key, lane.rows.map((row) => [row.item.id, row.depth])]),
    [
      ["project:none", [["free", 0]]],
      ["project:p-alpha", []],
      [
        "project:p-beta",
        [
          ["root", 0],
          ["child", 1],
        ],
      ],
    ],
    "分组键取**根**的项目（子树整体随根；与状态/指派维度同一份 DFS 判据）",
  );
  assertEachRowExactlyOnce(result, items);
});

test("穷举｜project：清单里没有的挂接（跨版本残留/坏数据）自成一条，不丢行", () => {
  const items = [wi("stale", { projectId: "p-gone" }), wi("known", { projectId: "p-alpha" })];
  const result = groupWorkItemBoard({
    items,
    dimension: "project",
    roster: EMPTY_ROSTER,
    projects: PROJECTS,
  });
  assert.deepEqual(
    result.map((lane) => [lane.key, lane.count]),
    [
      ["project:none", 0],
      ["project:p-alpha", 1],
      ["project:p-beta", 0],
      ["project:p-gone", 1],
    ],
  );
  assertEachRowExactlyOnce(result, items);
});

test("穷举｜project：缺项目清单 ⇒ 无项目列 + 挂接行各成一条（读不到清单也不静默丢行）", () => {
  const items = [wi("a", { projectId: "p-1" }), wi("b")];
  const result = groupWorkItemBoard({ items, dimension: "project", roster: EMPTY_ROSTER });
  assert.deepEqual(
    result.map((lane) => [lane.key, lane.count]),
    [
      ["project:none", 1],
      ["project:p-1", 1],
    ],
  );
});

test("穷举｜project：空输入 ⇒ 空数组（不造空骨架；空态由看板的空态分支负责）", () => {
  assert.deepEqual(
    groupWorkItemBoard({
      items: [],
      dimension: "project",
      roster: EMPTY_ROSTER,
      projects: PROJECTS,
    }),
    [],
  );
});

test("穷举｜project：确定性（两次调用逐项相同）", () => {
  const items = [wi("a", { projectId: "p-beta" }), wi("b"), wi("c", { projectId: "p-alpha" })];
  const build = () =>
    groupWorkItemBoard({ items, dimension: "project", roster: EMPTY_ROSTER, projects: PROJECTS });
  assert.deepEqual(build(), build());
});

/* 列头的**显示投影**（纯函数，组件只投影它）：无项目列 / 命中项目（名字）/ 清单里没有的挂接
   （回落 id —— 不显示成「无项目」：那会把「挂在某个已看不见的项目上」读成「没挂项目」，
   与 `workItemQuickCreateParentDisplay` 的 missing 同一条纪律）。 */
test("穷举｜project 列头投影：none / 项目名 / 未知挂接回落 id 三态分开，不用同一个说法", () => {
  assert.deepEqual(
    workItemProjectLaneDisplay({ laneKey: WORK_ITEM_NO_PROJECT_LANE_KEY, projects: PROJECTS }),
    {
      kind: "none",
    },
  );
  assert.deepEqual(workItemProjectLaneDisplay({ laneKey: "project:p-beta", projects: PROJECTS }), {
    kind: "project",
    name: "贝塔",
    shortCode: "BET",
  });
  assert.deepEqual(workItemProjectLaneDisplay({ laneKey: "project:p-gone", projects: PROJECTS }), {
    kind: "missing",
    id: "p-gone",
  });
  // 列键是稳定身份（= 行的挂接值），无项目列有专用常量键（不与任何项目 id 撞：id 是 uuid）。
  assert.equal(workItemProjectLaneKey(undefined), WORK_ITEM_NO_PROJECT_LANE_KEY);
  assert.equal(workItemProjectLaneKey("p-1"), "project:p-1");
  assert.equal(projectIdFromLaneKey("project:p-1"), "p-1");
  assert.equal(projectIdFromLaneKey(WORK_ITEM_NO_PROJECT_LANE_KEY), null);
});

// ---------- ⑪ 标签 chip 投影（看板行截断，独立夹具） ----------

test("穷举｜chip 投影：0 / 1 / 2 / 恰好 3 / 4 / 10 条，默认上限 3，且不改写入参", () => {
  assert.deepEqual(workItemLabelChips([]), { shown: [], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a"]), { shown: ["a"], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a", "b"]), { shown: ["a", "b"], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a", "b", "c"]), { shown: ["a", "b", "c"], hiddenCount: 0 });
  assert.deepEqual(workItemLabelChips(["a", "b", "c", "d"]), {
    shown: ["a", "b", "c"],
    hiddenCount: 1,
  });
  const ten = Array.from({ length: 10 }, (_, index) => `t${index}`);
  assert.deepEqual(workItemLabelChips(ten), { shown: ten.slice(0, 3), hiddenCount: 7 });
  const snapshot = [...ten];
  workItemLabelChips(ten);
  assert.deepEqual(ten, snapshot, "投影不得就地改写调用方的数组");
});

test("穷举｜chip 投影：上限可注入（0 / 1 / 2 / 3 / 10 与超上限值都只说明「显示几个」）", () => {
  const five = ["a", "b", "c", "d", "e"];
  assert.deepEqual(workItemLabelChips(five, 0), { shown: [], hiddenCount: 5 });
  assert.deepEqual(workItemLabelChips(five, 1), { shown: ["a"], hiddenCount: 4 });
  assert.deepEqual(workItemLabelChips(five, 2), { shown: ["a", "b"], hiddenCount: 3 });
  assert.deepEqual(workItemLabelChips(five, 5), { shown: five, hiddenCount: 0 });
  assert.deepEqual(
    workItemLabelChips(five, 9),
    { shown: five, hiddenCount: 0 },
    "上限大于条数 ⇒ 全显示、无「+N」",
  );
});

// ---------- ⑨ i18n 成对（独立于实现轮的硬编码清单：从**映射表与源码**反推应存在的键） ----------

test("i18n｜映射表产出的每个文案键两语齐备、占位符一致（category / 结算原因 / 泳道维度）", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  const checked: string[] = [];

  const check = (id: string, why: string): void => {
    const zh = zhCN[id];
    const en = enUS[id];
    assert.ok(zh, `${why}：中文缺 ${id}`);
    assert.ok(en, `${why}：英文缺 ${id}`);
    assert.equal(placeholders(zh), placeholders(en), `${why}：${id} 的占位符两语必须一致`);
    checked.push(id);
  };

  for (const id of Object.values(WORK_ITEM_STATUS_CATEGORY_MESSAGE_IDS))
    check(id, "泳道名（category 穷尽映射）");
  for (const id of Object.values(RUN_SETTLE_REASON_MESSAGE_IDS)) check(id, "结算原因（码值映射）");

  // 维度选择器的三个选项与标签相关键：从**源码**里出现的完整字符串字面量反推（不是抄一份清单）。
  const squadDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/squad");
  for (const file of [
    "WorkItemsPageActions.tsx",
    "WorkItemsBoard.tsx",
    /* T-P2-R6b：维度文案映射搬到**词汇层**（`workItemsViewModel.ts`）⇒ 扫描名单跟着扩
       （判据不动：这些文件里出现的键必须两语齐备；名单只扩，不缩）。 */
    "workItemsViewModel.ts",
    "WorkItemDetailPage.tsx",
    // T-P1-R2 起概览区在独立模块里（键字面量随之一并搬走 ⇒ 扫描名单只扩，判据不动）。
    "WorkItemDetailOverview.tsx",
    "SquadCreateDialogs.tsx",
  ]) {
    const source = readFileSync(resolve(squadDir, file), "utf8");
    for (const match of source.matchAll(
      /"((?:squad\.)(?:workItems|workItemDetail)\.[A-Za-z0-9_.]+)"/g,
    )) {
      check(match[1]!, `${file} 用到的文案`);
    }
  }

  // 本轮新增的三组词汇都必须真的被检查到（防止正则失效导致「空跑绿」）。
  for (const required of [
    "squad.workItems.lane.dimension.none",
    "squad.workItems.lane.dimension.statusCategory",
    "squad.workItems.lane.dimension.assignee",
    "squad.workItems.labelsTooMany",
    "squad.workItems.labelsTooLong",
    "squad.workItemDetail.overview.labelsEmpty",
  ]) {
    assert.ok(checked.includes(required), `i18n 断言必须真的覆盖到 ${required}（否则本条是空跑）`);
  }
});
