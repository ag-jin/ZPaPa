import assert from "node:assert/strict";
import test from "node:test";
import { parseComment, toMentionRefs, type RosterIndex } from "../src/workitem/commentParser.js";

/* 协作域 X1.1：解析器矩阵（任务卡断言要点 1–6；词法 = @ + 名称，UI mention 先例）。 */

const roster: RosterIndex = {
  agentsByName: new Map([
    ["ann", "ta-1"],
    ["ann-lee", "ta-2"],
    ["队员", "ta-zh"],
  ]),
  ambiguousAgentNames: new Set(["重名"]),
  squadsByName: new Map([["网关组", "sq-1"]]),
  humanNames: new Set(["张三"]),
};

test("命令优先级：/note 前缀剥离且 mention 仍解析；/note 单词；未知命令响亮抛", () => {
  const noted = parseComment("/note @ann 检查一下", roster);
  assert.equal(noted.command, "note");
  assert.equal(noted.normalizedBody, "@ann 检查一下");
  assert.deepEqual(noted.mentions, [{ kind: "agent", name: "ann", agentId: "ta-1" }]);
  assert.equal(parseComment("/note", roster).command, "note");
  assert.equal(parseComment("/note\n第二行 @ann", roster).command, "note");
  // 未知命令：响亮（不静默降级——客户端不得各自猜）。
  assert.throws(() => parseComment("/foo bar", roster), /未知评论命令/);
  // 非行首的斜杠不是命令。
  assert.equal(parseComment("看 /foo 这个路径", roster).command, "none");
});

test("mention 词法：行首/空白边界；标点/行尾边界；邮箱不算；最长匹配优先", () => {
  const r = parseComment("@ann-lee 和 @ann 是两个人", roster);
  assert.deepEqual(
    r.mentions,
    [
      { kind: "agent", name: "ann-lee", agentId: "ta-2" },
      { kind: "agent", name: "ann", agentId: "ta-1" },
    ],
    "最长匹配：@ann-lee 不被 @ann 抢先",
  );
  assert.deepEqual(parseComment("结尾@ann", roster).mentions, [], "前方无空白不算 mention");
  assert.deepEqual(parseComment("@ann, 继续", roster).mentions, [
    { kind: "agent", name: "ann", agentId: "ta-1" },
  ]);
  assert.deepEqual(parseComment("邮箱 a@ann.com 不触发", roster).mentions, [], "邮箱 @ 不算");
  assert.deepEqual(parseComment("@ta-1 用的是名称不是 id", roster).mentions, [
    { kind: "unresolved", name: "ta-1", reason: "absent" },
  ]);
});

test("名册解析：命中/重名/缺席/小队/@all/人名——重名缺席不猜", () => {
  assert.deepEqual(parseComment("@all 广播", roster).mentions, [{ kind: "all" }]);
  assert.deepEqual(parseComment("@队员 干活", roster).mentions, [
    { kind: "agent", name: "队员", agentId: "ta-zh" },
  ]);
  assert.deepEqual(parseComment("@网关组 开工", roster).mentions, [
    { kind: "squad", name: "网关组", squadId: "sq-1" },
  ]);
  assert.deepEqual(parseComment("@张三 你看看", roster).mentions, [
    { kind: "human", name: "张三" },
  ]);
  assert.deepEqual(parseComment("@重名 是谁", roster).mentions, [
    { kind: "unresolved", name: "重名", reason: "ambiguous" },
  ]);
  assert.deepEqual(parseComment("@不存在 的", roster).mentions, [
    { kind: "unresolved", name: "不存在", reason: "absent" },
  ]);
});

test("去重与顺序：同 token 只出现一次；按出现顺序", () => {
  const r = parseComment("@ann @all @ann", roster);
  assert.deepEqual(r.mentions, [{ kind: "agent", name: "ann", agentId: "ta-1" }, { kind: "all" }]);
});

test("纯函数性：同输入两次调用结果逐字节相同；空名册安全", () => {
  const a = parseComment("@ann /note 混合", roster);
  const b = parseComment("@ann /note 混合", roster);
  assert.deepEqual(a, b);
  const empty = parseComment("@ann 无名册");
  assert.deepEqual(empty.mentions, [{ kind: "unresolved", name: "ann", reason: "absent" }]);
});

test("toMentionRefs：agent/squad/all 进快照；human/unresolved 不进（不猜身份）", () => {
  const parsed = parseComment("@ann @网关组 @all @张三 @不存在", roster);
  assert.deepEqual(toMentionRefs(parsed.mentions), [
    { type: "agent", id: "ta-1" },
    { type: "squad", id: "sq-1" },
    { type: "all", id: "all" },
  ]);
});

test("inline：由调用方携带，原样透传（锚点是结构化输入不是词法）", () => {
  const anchor = { path: "a.ts", startLine: 3, baseRevision: "abc" };
  const r = parseComment("看这里", roster, anchor);
  assert.deepEqual(r.inline, anchor);
  assert.equal(parseComment("无锚点", roster).inline, null);
});
