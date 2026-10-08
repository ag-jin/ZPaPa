import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

/**
 * 冷恢复后「仍在跑的后台 agent」必须在面板模型里成行——这是 hydration 修复的可见落点。
 *
 * 数据面两条事实各自可以单方面缺席：subagent 行由 v4 投影的 row 状态反推（冷恢复合成），
 * 后台 work 来自 BackgroundTask* 事件（内存权威，重启后可能整段消失）。模型层必须：
 * - 两侧都在：同一 childSessionId 精确联接 → 行带 controlWorkId/cancellable（Stop 入口）；
 * - 只有 work（冷/热投影交接的短窗口）：用唯一身份的 work 补行，控制不许消失；
 * - work 已终态：不补行（否则就是「跑完了还显示执行中」那张死卡片）。
 */

const CHILD_SESSION_ID = "sess_subagent_agent_11111111-2222-4333-8444-555555555555";
const WORK_ID = "agent_11111111-2222-4333-8444-555555555555";

const runningSubagentRow = {
  childSessionId: CHILD_SESSION_ID,
  agentId: WORK_ID,
  subagentType: "implementer",
  title: "长跑后台 agent",
  status: "running" as const,
  startedAt: 1_700_000_000_000,
};

const runningSubagentWork = {
  workId: WORK_ID,
  kind: "subagent" as const,
  title: "长跑后台 agent",
  status: "running" as const,
  startedAt: 1_700_000_000_000,
  cancellable: true,
  anchorRowId: null,
  childSessionId: CHILD_SESSION_ID,
};

test("冷恢复：running subagent 行 + running backgroundWork ⇒ 面板成行并带 Stop 控制", () => {
  const model = buildConversationStatusPanelModel({
    backgroundWorks: [runningSubagentWork],
    runningSubagents: [runningSubagentRow],
  });

  assert.equal(model.runningSubagentWorks.length, 1, "仍在跑的 agent 必须有面板行");
  const [row] = model.runningSubagentWorks;
  assert.equal(row?.childSessionId, CHILD_SESSION_ID);
  assert.equal(row?.controlWorkId, WORK_ID, "work 与行按 childSessionId 精确联接");
  assert.equal(row?.cancellable, true, "Stop 入口由仍 running 的 work 提供");
  assert.equal(model.runningBashWorks.length, 0, "subagent work 不得混进 Terminals 分区");
});

test("冷/热交接短窗口：投影暂无行时用唯一身份的 running work 补行（控制不许消失）", () => {
  const model = buildConversationStatusPanelModel({
    backgroundWorks: [runningSubagentWork],
    runningSubagents: [],
  });

  assert.equal(model.runningSubagentWorks.length, 1, "唯一身份的 running work 应补出面板行");
  assert.equal(model.runningSubagentWorks[0]?.controlWorkId, WORK_ID);
  assert.equal(model.runningSubagentWorks[0]?.status, "running");
});

test("已终态的 work 不补行：跑完了不能还显示执行中", () => {
  const model = buildConversationStatusPanelModel({
    backgroundWorks: [{ ...runningSubagentWork, status: "resultPending" as const }],
    runningSubagents: [],
  });

  assert.equal(model.runningSubagentWorks.length, 0, "终态 work 补行就是那张点了没反应的死卡片");
  assert.equal(model.hasContent, false);
});
