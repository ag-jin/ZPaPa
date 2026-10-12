// turn.started telemetry fact 的 backgroundSource 通路（2026-10-13 评审 S-2 回归）。
//
// 为什么这组用例承重：`subagent_lost` 加值时 schema 与 producer 各写一份白名单，只改 schema 会让
// 新值成为死代码（fact 永远不带该字段）——评审 S-2 正是这么发现的。本用例钉住「schema 认的取值
// 与 producer 放行的取值同源」：三类既有来源仍透传，重启收敛的丢失唤醒轮也透传，未知值仍然丢。

import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@zcode/contracts";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

const SESSION_ID = "sess_telemetry_bg_source";

let sequence = 0;
function turnStartedEvent(backgroundSource?: string) {
  sequence += 1;
  return {
    id: `evt_bg_source_${sequence}`,
    sessionId: SESSION_ID,
    turnId: `turn_bg_source_${sequence}`,
    sequenceNumber: sequence,
    timestamp: new Date(1_700_000_000_000),
    type: SessionEventType.TurnStarted,
    payload: {
      turnNumber: sequence,
      input: "",
      inputVisibility: "model-only",
      inputSource: "background_task",
      ...(backgroundSource ? { backgroundSource } : {}),
    },
  } as never;
}

function backgroundSourceOf(fact: unknown): unknown {
  return (fact as { backgroundSource?: unknown } | null)?.backgroundSource;
}

test("producer 与 schema 同源：三类既有来源 + 丢失唤醒来源都透传，未知值丢弃", () => {
  const normalizer = new ConversationTelemetryFactNormalizer();

  for (const source of ["bash", "subagent", "workflow", "subagent_lost"] as const) {
    const fact = normalizer.normalize(SESSION_ID, turnStartedEvent(source));
    assert.equal(
      backgroundSourceOf(fact),
      source,
      `producer 白名单必须放行 ${source}（schema 已认它；漏放行会让该值成为死代码）`,
    );
  }

  const unknown = normalizer.normalize(SESSION_ID, turnStartedEvent("not_a_source"));
  assert.equal(backgroundSourceOf(unknown), undefined, "闭集外的值必须丢弃（不新造来源）");
});
