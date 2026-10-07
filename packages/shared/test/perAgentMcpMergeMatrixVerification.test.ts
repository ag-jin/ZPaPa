import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig, NativeMcpServerRecord } from "../src/mcp.js";
import { mergeTeamAgentMcpServers, teamAgentMcpServersSchema, toZCodeAgentMcpServers } from "../src/team-agent-mcp.js";

/* 独立复验（per-agent MCP 切片 1）：合并语义的**穷举矩阵**。
   本文件的期望值取自需求契约（不是实现），夹具与断言面**不复用**实现者的用例：
     · 层序：user 级 < workspace 级 < agent 自有（更具体的一方赢）；同名**整条**浅覆盖（不做字段级深合并）；
     · `enabled === false` 的**目录条目**不参与（`undefined` 视为启用）；该过滤只作用于两个目录层；
     ·「没有覆盖项」有两种写法且等价：agent 侧 `undefined` 与 `{}`（v1 不做「空 map = 严格空集」）；
     · 最终形态三态：合并集为空 ⇒ `undefined`（调用方据此**不传**参数，CLI 按 config 原生继承）；
     · 单条转换失败只跳过那一条，留痕**只给名字**（配置里可能有凭据，内容绝不进日志）。 */

type DirScope = "user" | "workspace" | "common";
type Layer = "user" | "workspace" | "agent";

/** 期望的层序（弱 → 强）。测试内自持一份，不读实现里的 rank 表（否则就是同义反复）。 */
const STRENGTH: readonly Layer[] = ["user", "workspace", "agent"];

/** 层标记进 config：赢家是哪一层一眼可辨，且不同层的配置永不相同。 */
function tagged(label: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: `cmd:${label}`, ...extra };
}

/** 目录读取器的原样记录（`IMcpSyncService.loadMcpFromUserDirectory` 的返回元素形状）。 */
function dirRecord(
  scope: DirScope,
  name: string,
  config: McpServerConfig,
  enabled?: boolean,
): NativeMcpServerRecord {
  return { source: "zcodeagentmcp", scope, name, config, enabled };
}

// ---------- ① 三层 × 同名：2^3 在场组合全矩阵 ----------

test("三层同名在场组合（2^3）全矩阵：赢家恒为在场的最强层，且不产生多余条目", () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const present = STRENGTH.filter((_layer, index) => (mask & (1 << index)) !== 0);
    const base = present
      .filter((layer) => layer !== "agent")
      .map((layer) => dirRecord(layer as DirScope, "dup", tagged(`${layer}-声明`)));
    const agentServers = present.includes("agent")
      ? { dup: tagged("agent-声明") }
      : undefined;

    const merged = mergeTeamAgentMcpServers(base, agentServers);
    const winner = present.at(-1); // 在场的最强层

    assert.deepEqual(
      Object.keys(merged),
      winner === undefined ? [] : ["dup"],
      `在场组合 [${present.join(",")}] 的名字集`,
    );
    if (winner === undefined) continue;
    // 整条覆盖：拿到的必须是赢家那一份**原样**（字段级拼接会在这里露出来）。
    assert.deepEqual(
      merged["dup"],
      tagged(`${winner}-声明`),
      `在场组合 [${present.join(",")}] 的赢家应为 ${winner}`,
    );
  }
});

// ---------- ② enabled 矩阵：只作用于两个目录层 ----------

const ENABLED_STATES: readonly (boolean | undefined)[] = [true, false, undefined];

test("enabled 3×3 矩阵（user × workspace，同名）：停用条目不参与，undefined 视为启用", () => {
  for (const userEnabled of ENABLED_STATES) {
    for (const wsEnabled of ENABLED_STATES) {
      const base = [
        dirRecord("user", "dup", tagged("user-声明"), userEnabled),
        dirRecord("workspace", "dup", tagged("workspace-声明"), wsEnabled),
      ];
      // 契约：只有显式 false 才是停用；undefined 与目录读取器同口径（启用）。
      const effectiveUser = userEnabled !== false;
      const effectiveWs = wsEnabled !== false;
      const expected = effectiveWs
        ? tagged("workspace-声明")
        : effectiveUser
          ? tagged("user-声明")
          : undefined;

      const merged = mergeTeamAgentMcpServers(base);
      if (expected === undefined) {
        assert.equal(
          "dup" in merged,
          false,
          `user=${String(userEnabled)} / workspace=${String(wsEnabled)}：两层都停用 ⇒ 名字不该在合并集里`,
        );
      } else {
        assert.deepEqual(
          merged["dup"],
          expected,
          `user=${String(userEnabled)} / workspace=${String(wsEnabled)} 的赢家`,
        );
      }
    }
  }

  // 具名四格（把上面矩阵里最容易被改错的四格写成显式期望，防止契约被悄悄重定义）：
  const grid: Array<{ user: boolean | undefined; ws: boolean | undefined; expected?: string }> = [
    { user: undefined, ws: false, expected: "user-声明" }, // workspace 停用不遮蔽 user
    { user: true, ws: false, expected: "user-声明" },
    { user: false, ws: true, expected: "workspace-声明" },
    { user: false, ws: undefined, expected: "workspace-声明" },
  ];
  for (const row of grid) {
    const merged = mergeTeamAgentMcpServers([
      dirRecord("user", "dup", tagged("user-声明"), row.user),
      dirRecord("workspace", "dup", tagged("workspace-声明"), row.ws),
    ]);
    assert.deepEqual(
      merged["dup"],
      tagged(row.expected!),
      `user=${String(row.user)} / workspace=${String(row.ws)}`,
    );
  }
});

test("enabled 过滤只作用于目录层：agent 自有条目（含配置里的 enabled:false）原样进合并集", () => {
  // agent 侧是**定义**（用户显式写下的能力声明），不是目录里的存储标志位 ⇒ 不做 enabled 过滤。
  const merged = mergeTeamAgentMcpServers(
    [
      dirRecord("user", "shared", tagged("user-声明")),
      dirRecord("workspace", "only-disabled", tagged("workspace-停用"), false),
    ],
    { shared: tagged("agent-声明"), "own-flag": tagged("agent-带 enabled 字段", { enabled: false }) },
  );

  assert.deepEqual(Object.keys(merged).sort(), ["own-flag", "shared"], "目录停用条目仍在场外");
  assert.deepEqual(merged["own-flag"], tagged("agent-带 enabled 字段", { enabled: false }));
  assert.deepEqual(merged["shared"], tagged("agent-声明"), "agent 同名覆盖两个目录层");
});

// ---------- ③ 空 map ≡ 缺席（同一态的两种写法）----------

test("空 map 与缺席严格等价：多种 base 上逐一对拍（含全停用、全空、有同名冲突）", () => {
  const bases: readonly (readonly NativeMcpServerRecord[])[] = [
    [],
    [dirRecord("user", "u1", tagged("user-u1"))],
    [dirRecord("workspace", "off", tagged("ws-off"), false)],
    [
      dirRecord("user", "dup", tagged("user-声明")),
      dirRecord("workspace", "dup", tagged("workspace-声明")),
    ],
    [dirRecord("common", "c1", tagged("common-c1"))],
  ];
  for (const base of bases) {
    assert.deepEqual(
      mergeTeamAgentMcpServers(base, {}),
      mergeTeamAgentMcpServers(base),
      `base=${JSON.stringify(base.map((r) => r.name))}：{} 与缺席必须给出同一结论`,
    );
  }
});

// ---------- ④ 浅覆盖 + 次序无关 + 引用隔离 ----------

test("同名是整条浅覆盖（不做字段级深合并）：不会造出谁都没写过的配置", () => {
  const base = [
    dirRecord(
      "user",
      "dup",
      tagged("user-声明", { args: ["--user 侧参数"], env: { USER_ONLY: "1" }, timeoutMs: 9000 }),
    ),
    dirRecord("workspace", "dup", {
      url: "https://workspace.test/sse",
      type: "sse",
      headers: { "X-Workspace": "1" },
    }),
  ];
  const merged = mergeTeamAgentMcpServers(base);
  assert.deepEqual(
    merged["dup"],
    { url: "https://workspace.test/sse", type: "sse", headers: { "X-Workspace": "1" } },
    "赢家是 workspace 那一条原样：user 的 args/env/timeoutMs 一个都不该残留",
  );
  assert.equal("command" in merged["dup"]!, false);
  assert.equal("timeoutMs" in merged["dup"]!, false);
});

test("合并结论与入参顺序无关（打乱 base 顺序逐一对拍）", () => {
  const base = [
    dirRecord("workspace", "dup", tagged("workspace-声明")),
    dirRecord("user", "dup", tagged("user-声明")),
    dirRecord("user", "u-only", tagged("user-u-only")),
    dirRecord("workspace", "w-only", tagged("workspace-w-only")),
    dirRecord("workspace", "off", tagged("workspace-off"), false),
  ];
  const shape = (records: readonly NativeMcpServerRecord[]) =>
    mergeTeamAgentMcpServers(records, { dup: tagged("agent-声明") });
  const expected = shape(base);
  for (let rotation = 1; rotation < base.length; rotation += 1) {
    const rotated = [...base.slice(rotation), ...base.slice(0, rotation)];
    assert.deepEqual(shape(rotated), expected, `旋转 ${rotation} 位后的结论必须逐字相同`);
  }
  assert.deepEqual(Object.keys(expected).sort(), ["dup", "u-only", "w-only"]);
  assert.deepEqual(expected["dup"], tagged("agent-声明"));
});

test("引用隔离：返回的是本次合并的快照，两个方向都不共享可变数据", () => {
  const source: McpServerConfig = tagged("user-原始");
  const merged = mergeTeamAgentMcpServers([dirRecord("user", "x", source)]);
  source.command = "改过了";
  assert.deepEqual(merged["x"], tagged("user-原始"), "改入参不得回流到已给出的合并结论");

  source.command = "user-原始";
  const merged2 = mergeTeamAgentMcpServers([dirRecord("user", "x", source)]);
  (merged2["x"] as McpServerConfig).command = "改返回值";
  assert.equal(source.command, "user-原始", "改合并结论不得改写目录记录本身");

  const agentSource: McpServerConfig = tagged("agent-原始");
  const merged3 = mergeTeamAgentMcpServers([], { own: agentSource });
  agentSource.command = "改过了";
  assert.deepEqual(merged3["own"], tagged("agent-原始"), "agent 条目同样是拷贝");
});

// ---------- ⑤ 目录范围的边界（common 档最弱；防御性契约）----------

test("common 档最弱：同名时 user 级赢 common（本链路读不到 common，属防御性契约）", () => {
  const merged = mergeTeamAgentMcpServers([
    dirRecord("common", "dup", tagged("common-声明")),
    dirRecord("user", "dup", tagged("user-声明")),
  ]);
  assert.deepEqual(merged["dup"], tagged("user-声明"));
});

// ---------- ⑥ 形状校验：只看形状、不回显内容 ----------

test("schema 只判形状：合法 map 通过；空名/非对象/无 command 也无 url 一律拒绝", () => {
  assert.equal(
    teamAgentMcpServersSchema.safeParse({
      stdio: { command: "npx", args: ["-y", "x"], env: { A: "1" } },
      http: { url: "https://a.test/mcp" },
      sse: { type: "sse", url: "https://a.test/sse" },
    }).success,
    true,
  );
  for (const [label, value] of [
    ["空名", { "": { command: "npx" } }],
    ["值不是对象", { bad: "npx" }],
    ["空对象", { bad: {} }],
    ["只有别的键", { bad: { args: ["-y"] } }],
  ] as const) {
    assert.equal(teamAgentMcpServersSchema.safeParse(value).success, false, `${label} 必须被拒`);
  }
});

test("校验失败信息不得回显配置内容（env 里就是凭据）", () => {
  const rejected = teamAgentMcpServersSchema.safeParse({
    bad: { args: ["--token"], env: { SECRET_TOKEN: "tok-9d1f-do-not-echo" } },
  });
  assert.equal(rejected.success, false);
  const surface = rejected.success ? "" : JSON.stringify(rejected.error.issues);
  assert.doesNotMatch(surface, /tok-9d1f-do-not-echo/, "错误信息里不得出现凭据内容");
});

// ---------- ⑦ 转换 + 三态：端到端（目录记录 → 合并 → 协议载荷）----------

test("端到端：三层合并 ⇒ 协议载荷；坏条目只跳过自己且留痕只给名字；停用条目不上挂", () => {
  const secret = "tok-9d1f-do-not-echo";
  const records = [
    dirRecord("user", "shared", tagged("user-声明")),
    dirRecord("workspace", "shared", tagged("workspace-声明")),
    dirRecord("workspace", "ws-停用", tagged("workspace-停用"), false),
    dirRecord("user", "user-保留", tagged("user-保留")),
  ];
  const skippedArgs: unknown[][] = [];
  const servers = toZCodeAgentMcpServers(
    mergeTeamAgentMcpServers(records, {
      shared: tagged("agent-声明"),
      "agent-坏传输": { type: "carrier-pigeon", command: "agent-坏", env: { SECRET: secret } },
    }),
    (...args) => skippedArgs.push(args),
  );

  assert.deepEqual(skippedArgs, [["agent-坏传输"]], "跳过回调每次只带一个参数，且只有 server 名");
  assert.doesNotMatch(JSON.stringify(skippedArgs), /tok-9d1f/, "留痕里不得出现配置内容");
  assert.deepEqual(
    servers?.map((server) => server.name),
    ["shared", "user-保留"],
    "已停用的目录条目不上挂；同名按 agent 声明",
  );
  assert.deepEqual(servers?.[0], {
    name: "shared",
    command: "cmd:agent-声明",
    args: [],
    env: [],
  });
});

test("三态：合并集为空 ⇒ 不产生参数（undefined），三种来路同处置", () => {
  // ① 目录本来就空、agent 也没有自有配置
  assert.equal(toZCodeAgentMcpServers(mergeTeamAgentMcpServers([])), undefined);
  // ② 目录条目全被停用、agent 给的是空 map（等价于缺席）
  assert.equal(
    toZCodeAgentMcpServers(
      mergeTeamAgentMcpServers([dirRecord("user", "off", tagged("user-停用"), false)], {}),
    ),
    undefined,
  );
  // ③ 有配置但一条都转不出来（全部传输形态识别不了）⇒ 同一态：不传参数
  const allBad: Record<string, McpServerConfig> = {
    "a-坏": { type: "carrier-pigeon", command: "a" },
    "b-坏": { command: "" },
  };
  const names: string[] = [];
  assert.equal(
    toZCodeAgentMcpServers(allBad, (name) => names.push(name)),
    undefined,
  );
  assert.deepEqual(names, ["a-坏", "b-坏"], "每条转换失败的条目都要留痕（只给名字）");
});
