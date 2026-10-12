// 恢复面提取（spec 2026-10-08-subagent-orphan-reconcile §1.7，2026-10-12 裁决 2 = 2B）。
//
// 契约：child transcript 尾部 = 被打断的 in-flight 子代理被杀前产出的唯一持久面。
// 提取规则必须唯一（丢失唤醒摘要、TaskOutput 回退、人/模型读 child 会话三处共用）：
// 最后一条非流恢复作废的 assistant 消息 → 非 ignored 的 text 块按序拼接 → 超上界保留尾部。

import assert from "node:assert/strict";
import test from "node:test";
import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  type MessageWithParts,
} from "@zcode/contracts";
import {
  extractSubagentTranscriptTail,
  SUBAGENT_RECOVERY_TAIL_MAX_CHARS,
} from "../src/subagent/recovery-surface.js";

function assistant(input: {
  id: string;
  texts: readonly { text: string; ignored?: boolean }[];
  errorName?: string;
}): MessageWithParts {
  return {
    info: {
      id: input.id,
      role: "assistant",
      parentID: "msg_child_user",
      ...(input.errorName ? { error: { name: input.errorName } } : {}),
    },
    parts: input.texts.map((entry, index) => ({
      id: `${input.id}_part_${index}`,
      type: "text",
      text: entry.text,
      ...(entry.ignored ? { ignored: true } : {}),
    })),
  } as unknown as MessageWithParts;
}

test("恢复面：取最后一条 assistant 的非 ignored 文本块（多块按序拼接）", () => {
  const tail = extractSubagentTranscriptTail([
    assistant({ id: "msg_a1", texts: [{ text: "第一段产出" }] }),
    {
      info: { id: "msg_user", role: "user", parentID: "msg_child_user" },
      parts: [{ id: "p_user", type: "text", text: "用户输入不算产出" }],
    } as unknown as MessageWithParts,
    assistant({
      id: "msg_a2",
      texts: [{ text: "第二次产出（前半）" }, { text: "被忽略的草稿", ignored: true }, { text: "第二次产出（后半）" }],
    }),
  ]);

  assert.equal(tail.text, "第二次产出（前半）\n\n第二次产出（后半）");
  assert.equal(tail.truncated, false);
});

test("恢复面：流恢复作废的半截 assistant 不参与提取（回退到更早的真实产出）", () => {
  const tail = extractSubagentTranscriptTail([
    assistant({ id: "msg_a1", texts: [{ text: "旧的完整产出" }] }),
    assistant({
      id: "msg_partial",
      texts: [{ text: "半截流式输出" }],
      errorName: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
    }),
  ]);

  assert.equal(tail.text, "旧的完整产出");
});

test("恢复面：超上界截断保留尾部并标注省略", () => {
  const long = "x".repeat(SUBAGENT_RECOVERY_TAIL_MAX_CHARS + 500);
  const tail = extractSubagentTranscriptTail([assistant({ id: "msg_a1", texts: [{ text: long }] })]);

  assert.equal(tail.truncated, true);
  assert.match(tail.text ?? "", /^\[\d+ chars of earlier subagent output omitted\]/);
  assert.equal((tail.text ?? "").endsWith("x".repeat(100)), true, "最新产出必须在末尾保留");
});

test("恢复面：没有 assistant 文本 ⇒ 空态（不报错、不伪造）", () => {
  const empty = extractSubagentTranscriptTail([]);
  assert.deepEqual(empty, { truncated: false });

  const noText = extractSubagentTranscriptTail([
    {
      info: { id: "msg_user", role: "user", parentID: "msg_child_user" },
      parts: [{ id: "p_user", type: "text", text: "只有用户输入" }],
    } as unknown as MessageWithParts,
  ]);
  assert.deepEqual(noText, { truncated: false });
});
