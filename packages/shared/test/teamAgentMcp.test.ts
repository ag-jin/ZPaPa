import assert from "node:assert/strict";
import test from "node:test";
import type { NativeMcpServerRecord } from "../src/mcp.js";
import {
  mergeTeamAgentMcpServers,
  teamAgentMcpServersSchema,
  toZCodeAgentMcpServers,
} from "../src/team-agent-mcp.js";

/* per-agent MCP 配置（multica 欠账 #2）的**纯函数 seam**：名字/形状规则、三层合并次序、协议 DTO 转换。
   全部零 IO —— 文件读取在 host 的挂载点上，这里只做「形状对、谁覆盖谁、传什么」。 */

// 字段形状是 `Record<server 名, McpServerConfig>`（不是整段 `{"mcpServers": …}` 文档）：
// 单 runtime 下外层信封零信息，canonical 形状只有这个 map（`.zcode/config.json` 的 mcp.servers 同形）。
// 值校验刻意**浅**：只看得出「会挂成哪个传输」的两个字段，不去检视 env/headers 里的内容
//（校验不得回显凭据 —— 错误信息里出现 token 段就是设计 §3.5 禁止的那种回显）。
test("mcpServers schema：command 形态与 url 形态都接受，空名 / 非对象 / 空对象 / 两者皆缺都拒绝", () => {
  const accepted = teamAgentMcpServersSchema.safeParse({
    "code-search": { command: "npx", args: ["-y", "code-search-mcp"] },
    "docs-http": {
      type: "sse",
      url: "https://example.test/sse",
      headers: { Authorization: "Bearer token" },
    },
  });
  assert.equal(accepted.success, true, "command 形态与 url 形态都必须被接受");

  const rejected: Array<[string, unknown]> = [
    ["空名", { "": { command: "npx" } }],
    ["值非对象", { bad: "npx" }],
    ["空对象（既无 command 也无 url）", { bad: {} }],
    ["有别的键但没有 command/url", { bad: { args: ["-y"] } }],
  ];
  for (const [label, value] of rejected) {
    assert.equal(teamAgentMcpServersSchema.safeParse(value).success, false, `${label} 必须被拒绝`);
  }
});

/** 目录读取器给的原样记录（`IMcpSyncService.loadMcpFromUserDirectory` 的返回元素）。 */
function record(
  scope: "user" | "workspace",
  name: string,
  config: NativeMcpServerRecord["config"],
  enabled = true,
): NativeMcpServerRecord {
  return { source: "zcodeagentmcp", scope, name, config, enabled };
}

/* 合并次序是**设计契约**（设计 §3.3）：`user 级(enabled) < workspace 级(enabled) < agent 自有 mcpServers`，
   同名时**后者整条覆盖前者**（按 server 名浅合并，不做字段级深合并）。
   为什么同名要「整条」而不是「字段级」：两条配置是**同一条 server 的两份声明**，
   字段级合并会造出一条谁都没写过的配置（例如 user 的 args 配上 agent 的 command），
   失败的形态是「连上了但拿的是错的凭据/参数」，且不报错。 */
test("合并次序：user < workspace < agent 自有；同名整条浅覆盖；enabled=false 不参与", () => {
  // 顺序刻意**反着给**（workspace 在前）：次序由 scope 决定，不由入参数组的顺序决定 ——
  // 依赖数组顺序的实现在换一个读取器（或读取器改成先 user 后 workspace）时会静默反过来。
  const base: NativeMcpServerRecord[] = [
    record("workspace", "dup", { command: "ws-dup", args: ["--ws"] }),
    record("workspace", "base-dup", { command: "ws-base-dup" }),
    record("workspace", "ws-only", { url: "https://ws.test/sse", type: "sse" }),
    record("workspace", "ws-disabled", { command: "ws-disabled" }, false),
    record("user", "dup", { command: "user-dup" }),
    record("user", "base-dup", { command: "user-base-dup" }),
    record("user", "user-only", { command: "user-only" }),
    record("user", "user-disabled", { command: "user-disabled" }, false),
  ];

  const merged = mergeTeamAgentMcpServers(base, {
    dup: { command: "agent-dup", args: ["--agent"] },
    "agent-only": { url: "https://agent.test/mcp" },
  });

  // ① 停用条目不退场以外的全貌（名字齐备）。
  assert.deepEqual(
    Object.keys(merged).sort(),
    ["agent-only", "base-dup", "dup", "user-only", "ws-only"],
    "停用的条目（enabled=false）不进合并集；其余按名字齐备",
  );
  // ② 两个 base 层之间的次序：`base-dup` 没有 agent 覆盖项 ⇒ 这一格**只看** workspace 赢 user。
  //    少了这一条，「user 与 workspace 谁赢」就没有任何断言真的观察过（只测 agent 覆盖时两者都被压住）。
  assert.deepEqual(
    merged["base-dup"],
    { command: "ws-base-dup" },
    "同名时 workspace 级整条覆盖 user 级（弱 → 强：user < workspace）",
  );
  // ③ agent 自有同名整条覆盖：拿的是 agent 那条**原样**，不是 workspace 的字段拼上 agent 的字段。
  assert.deepEqual(merged.dup, { command: "agent-dup", args: ["--agent"] });
  assert.deepEqual(merged["ws-only"], { url: "https://ws.test/sse", type: "sse" });
  assert.deepEqual(merged["user-only"], { command: "user-only" });

  // ④ 次序与入参顺序无关：把同一份 base 反过来给，结论逐字相同。
  const reversed = mergeTeamAgentMcpServers([...base].reverse(), {
    dup: { command: "agent-dup", args: ["--agent"] },
    "agent-only": { url: "https://agent.test/mcp" },
  });
  assert.deepEqual(reversed, merged, "入参顺序不得改变合并结论（次序由 scope 决定）");

  // ⑤ agent 字段缺席 ⇒ 合并集就是 base（「缺席 = 该层无覆盖项」，设计 §3.1 的三态第一态）。
  const baseOnly = mergeTeamAgentMcpServers(base);
  assert.deepEqual(
    Object.keys(baseOnly).sort(),
    ["base-dup", "dup", "user-only", "ws-only"],
    "agent 没有 mcpServers 时合并集只由 base 构成（user-only 与 ws-only 都在）",
  );
  assert.deepEqual(baseOnly["base-dup"], { command: "ws-base-dup" }, "缺席时次序不变");
  // ⑥ 空 map 与缺席等价（v1 不做「空 map = 严格空集/屏蔽继承」，设计 §3.1）：既不屏蔽 base，也不报错。
  assert.deepEqual(mergeTeamAgentMcpServers(base, {}), baseOnly);
});

/* 转换 + 三态（设计 §3.0 / §3.9）：
   能识别的条目转成 `createTask({ mcpServers })` 要的协议形状；**一条坏配置只跳过那一条**并
   只报出它的**名字**（内容可能含凭据，绝不进日志）；整张表为空时返回 `undefined`。 */
test("转换：识别不了的条目只跳过它自己（回调只给名字），空集不产生参数", () => {
  const skipped: string[] = [];
  const servers = toZCodeAgentMcpServers(
    {
      "code-search": { command: "npx", args: ["-y", "code-search-mcp"], env: { TOKEN: "t" } },
      "docs-http": {
        url: "https://docs.test/sse",
        type: "sse",
        headers: { Authorization: "Bearer t" },
      },
      "broken-transport": { type: "carrier-pigeon", command: "npx" },
    },
    (name) => skipped.push(name),
  );

  // ① 坏条目只影响自己：另外两条照常挂上（对齐 multica「一条坏 overlay 不得弄掉全部基座」）。
  assert.deepEqual(skipped, ["broken-transport"], "跳过回调只报名字（内容含凭据，不进日志）");
  assert.deepEqual(servers, [
    {
      name: "code-search",
      command: "npx",
      args: ["-y", "code-search-mcp"],
      env: [{ name: "TOKEN", value: "t" }],
    },
    {
      name: "docs-http",
      type: "sse",
      url: "https://docs.test/sse",
      headers: [{ name: "Authorization", value: "Bearer t" }],
    },
  ]);

  // ② 空集 ⇒ `undefined`：**不传**该参数 = 三态里「没有任何托管 server」那一态，CLI 按 config 文件
  //    原生继承（user + workspace + plugin 底座）。显式传入的集合是**覆盖集**（设计 §2.2）——
  //    两态在挂载层分开表达，不依赖下游把空数组归一。
  assert.equal(toZCodeAgentMcpServers({}), undefined);
});

// 有配置但**一条都转不出来**（全是识别不了的传输）⇒ 结论同样是 `undefined`：
// 挂载层面「没有任何可挂的 server」只有一种处置（不传参数），不因来路是「空表」还是「全坏」而分叉。
test("转换：条目全识别不了时也是 undefined（不传参数）", () => {
  const servers = toZCodeAgentMcpServers({ bad: { type: "carrier-pigeon", command: "npx" } });
  assert.equal(servers, undefined);
});
