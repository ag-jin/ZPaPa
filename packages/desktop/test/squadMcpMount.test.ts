import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig, NativeMcpServerRecord, ZCodeAgentMcpServer } from "@zcode/shared";
import { createSquadMcpMountResolver } from "../src/host/squadMcpMount.js";

/* 小队派发的 **MCP 挂载点**（设计 §3.3/§3.8）：把「目录读取器的基准 + 该 agent 自有配置」
   合并、转换成 `createTask({ mcpServers })` 要的形态。
   这里只测**装配**（注入的读取器怎么被调、结论是什么），合并/转换/跳过规则在
   `@zcode/shared` 的 team-agent-mcp 里有完整矩阵 —— 本文件不重复那套矩阵。 */

/** 挂载集按 server 名比对：数组顺序只反映 map 的插入次序，不是语义（不拿它当断言面）。 */
function byName(servers: ZCodeAgentMcpServer[] | undefined): Record<string, ZCodeAgentMcpServer> {
  return Object.fromEntries((servers ?? []).map((server) => [server.name, server]));
}

function record(scope: "user" | "workspace", name: string, command: string): NativeMcpServerRecord {
  return { source: "zcodeagentmcp", scope, name, config: { command }, enabled: true };
}

/** 假读取器：记下被问的路径，返回给定的记录（真实实现 = IMcpSyncService.loadMcpFromUserDirectory）。 */
function fakeLoader(records: NativeMcpServerRecord[]) {
  const asked: string[] = [];
  return {
    asked,
    loadBase: async (request: { workspacePath: string }) => {
      asked.push(request.workspacePath);
      return records;
    },
  };
}

/* 队员 run 的会话落在 `<repo>/.worktree/<dir>`（新检出目录），主工作区未跟踪的
   `.zcode/config.json` **不在那棵树里** ⇒ CLI 的原生读取（按会话 cwd 解析 workspace 作用域）
   拿不到 workspace 级 server（队长能、队员不能，且不报错）。
   修法是 host 在**主工作区路径**上显式读一次、把结果显式传进 createTask（覆盖集语义）。
   本用例钉住这条链的前半段：基准读取器问的是**给它的那个工作区路径**，其结论进挂载集。 */
test("基准读取器按给定的工作区路径读一次，结果进挂载集（agent 无自有配置 ⇒ base-only）", async () => {
  const loader = fakeLoader([
    record("user", "user-docs", "user-docs-cmd"),
    record("workspace", "ws-search", "ws-search-cmd"),
  ]);
  const resolve = createSquadMcpMountResolver({ loadBase: loader.loadBase });

  const servers = await resolve({ workspacePath: "/repo/main" });

  assert.deepEqual(
    loader.asked,
    ["/repo/main"],
    "基准读取器必须被问一次，且问的是传进来的工作区路径",
  );
  assert.deepEqual(servers, [
    { name: "user-docs", command: "user-docs-cmd", args: [], env: [] },
    { name: "ws-search", command: "ws-search-cmd", args: [], env: [] },
  ]);
});

// 设计 §3.3 的合并次序：`user 级 < workspace 级 < agent 自有`，同名时 agent 赢（更具体的一方赢）。
test("agent 自有同名 server 整条覆盖 workspace 级（合并次序）；其余基准条目照旧在", async () => {
  const loader = fakeLoader([
    record("workspace", "shared-name", "workspace-cmd"),
    record("workspace", "ws-only", "ws-only-cmd"),
  ]);
  const resolve = createSquadMcpMountResolver({ loadBase: loader.loadBase });

  const servers = await resolve({
    workspacePath: "/repo/main",
    agentMcpServers: {
      "shared-name": { command: "agent-cmd", args: ["--agent"] },
      "agent-only": { url: "https://agent.test/mcp" },
    } satisfies Record<string, McpServerConfig>,
  });

  assert.deepEqual(byName(servers), {
    "ws-only": { name: "ws-only", command: "ws-only-cmd", args: [], env: [] },
    "shared-name": { name: "shared-name", command: "agent-cmd", args: ["--agent"], env: [] },
    "agent-only": { name: "agent-only", type: "http", url: "https://agent.test/mcp", headers: [] },
  });
});

/* 三态语义（设计 §3.1/§3.3）：**没有任何可挂的 server ⇒ 不传这个参数**。
   显式传入的集合在协议/CLI 层是**覆盖集**（设计 §2.2），「没有托管项」与「托管集合为空」
   在挂载层用同一态表达（不传），不靠下游把空数组归一 —— 换一层适配也不会翻面。 */
test("基准为空且 agent 无自有配置 ⇒ 不产生参数（undefined，CLI 原生继承）", async () => {
  const loader = fakeLoader([]);
  const resolve = createSquadMcpMountResolver({ loadBase: loader.loadBase });

  assert.equal(await resolve({ workspacePath: "/repo/main" }), undefined);
  assert.equal(
    await resolve({ workspacePath: "/repo/main", agentMcpServers: {} }),
    undefined,
    "空 map 与缺席同义（v1 不做「空 map = 严格空集」）",
  );
});

/* 基准读失败**不得被吞成空集合**（设计 §3.9 / 裁定 B）：吞掉的表现是「这次 run 悄悄少了
   一整层 server」——比失败更坏。这里钉住模块不自作主张兜底：错误原样抛出，
   由派发桥按既有 transient 出口处置（响亮 + 重投自愈）。 */
test("基准读取抛错 ⇒ 原样冒泡（不吞成空集合，也不降级成 agent-only）", async () => {
  const resolve = createSquadMcpMountResolver({
    loadBase: async () => {
      throw new Error("无法解析 MCP 配置文件 /repo/main/.zcode/config.json: Unexpected token");
    },
  });

  await assert.rejects(
    () => resolve({ workspacePath: "/repo/main", agentMcpServers: { s1: { command: "x" } } }),
    /无法解析 MCP 配置文件/,
    "读取失败必须冒泡（吞掉 = 静默跑掉一整层 server）",
  );
});
