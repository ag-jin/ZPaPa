import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { McpServerConfig, NativeMcpServerRecord, ZCodeAgentMcpServer } from "@zcode/shared";
import { createSquadMcpMountResolver } from "../src/host/squadMcpMount.js";

/* 独立复验（per-agent MCP 切片 1）：**挂载链路**。
   两半：
     ① 装配点行为 —— 注入假读取器，直接观察「问了哪个路径 / 结论是什么 / 失败怎么办」；
     ② 接线守卫的**非空跑性** —— 每个源码守卫都配一条「变异」：把源码里的一处**可信回归**
        改出来（只在内存里的字符串上改，仓库文件不动），断言对应守卫**必须失败**。
        守卫全绿而变异也照样过 = 守卫其实是空跑（匹配到注释 / 匹配到空串 / 断言面写错）。
   守卫只能证明「这段接线在源码里存在且形状如此」，不能证明运行期行为 —— 行为那半由 ① 覆盖。 */

/** 挂载集按名字取（数组顺序只反映 map 插入次序，不是语义，故不当断言面）。 */
function byName(servers: ZCodeAgentMcpServer[] | undefined): Record<string, ZCodeAgentMcpServer> {
  return Object.fromEntries((servers ?? []).map((server) => [server.name, server]));
}

function record(
  scope: "user" | "workspace",
  name: string,
  config: McpServerConfig,
  enabled?: boolean,
): NativeMcpServerRecord {
  return { source: "zcodeagentmcp", scope, name, config, enabled };
}

/** 假读取器：记下每次被问的路径与调用次序（真实实现 = 服务面 IMcpSyncService 的目录读取器）。 */
function spyLoader(records: readonly NativeMcpServerRecord[]) {
  const asked: string[] = [];
  return {
    asked,
    loadBase: async (request: { workspacePath: string }) => {
      asked.push(request.workspacePath);
      return records;
    },
  };
}

// ---------- ① 装配点行为 ----------

test("装配点：一次调用问一次读取器，问的就是给它的主工作区路径；每次调用都现读（无缓存）", async () => {
  const loader = spyLoader([record("workspace", "ws-mcp", { command: "ws-cmd" })]);
  const resolveMount = createSquadMcpMountResolver({ loadBase: loader.loadBase });

  const first = await resolveMount({ workspacePath: "/repo/主工作区" });
  const second = await resolveMount({ workspacePath: "/repo/另一个工作区" });

  assert.deepEqual(loader.asked, ["/repo/主工作区", "/repo/另一个工作区"], "每次调用都必须现读一次");
  assert.deepEqual(byName(first), {
    "ws-mcp": { name: "ws-mcp", command: "ws-cmd", args: [], env: [] },
  });
  assert.deepEqual(byName(second), byName(first));
});

test("装配点：目录层停用条目不进集合、agent 同名胜出（两模块接合处的行为）", async () => {
  const loader = spyLoader([
    record("user", "shared", { command: "user-cmd" }),
    record("workspace", "shared", { command: "ws-cmd" }),
    record("workspace", "关掉的", { command: "off-cmd" }, false),
    record("user", "只读的", { command: "keep-cmd" }),
  ]);
  const resolveMount = createSquadMcpMountResolver({ loadBase: loader.loadBase });

  const servers = await resolveMount({
    workspacePath: "/repo/主工作区",
    agentMcpServers: { shared: { command: "agent-cmd", args: ["--own"] } },
  });

  assert.deepEqual(Object.keys(byName(servers)).sort(), ["shared", "只读的"].sort(), "名字集");
  assert.deepEqual(byName(servers)["shared"], {
    name: "shared",
    command: "agent-cmd",
    args: ["--own"],
    env: [],
  });
  assert.deepEqual(byName(servers)["只读的"], {
    name: "只读的",
    command: "keep-cmd",
    args: [],
    env: [],
  });
});

test("装配点：基准读取失败原样冒泡（不吞成空集合、也不降级成 agent-only）", async () => {
  const boom = new Error("读取 <ws>/.zcode/config.json 失败：Unexpected token }");
  const resolveMount = createSquadMcpMountResolver({
    loadBase: async () => {
      throw boom;
    },
  });

  await assert.rejects(
    () =>
      resolveMount({
        workspacePath: "/repo/主工作区",
        agentMcpServers: { only: { command: "agent-only-cmd" } },
      }),
    (error: unknown) => error === boom, // 必须是同一个错误对象：重新包装会丢掉原始判据
    "读取失败必须原样冒泡，连 agent 自有集合也不许降级挂上",
  );
});

test("装配点：坏条目留痕只给名字（配置里的凭据绝不进回调）；空表/全空 ⇒ 不产生参数", async () => {
  const secret = "tok-9d1f-do-not-echo";
  const loader = spyLoader([record("workspace", "好条目", { command: "good-cmd" })]);
  const resolveMount = createSquadMcpMountResolver({ loadBase: loader.loadBase });
  const seen: unknown[][] = [];

  const servers = await resolveMount({
    workspacePath: "/repo/主工作区",
    agentMcpServers: {
      "坏条目": { type: "carrier-pigeon", command: "bad", env: { TOKEN: secret } },
    },
    onSkippedServer: (...args) => seen.push(args),
  });

  assert.deepEqual(servers?.map((server) => server.name), ["好条目"]);
  assert.deepEqual(seen, [["坏条目"]], "跳过回调只带 server 名");
  assert.doesNotMatch(JSON.stringify(seen), /tok-9d1f/, "留痕里不得出现配置内容");

  // 空 base + 空 agent map ⇒ undefined（三态里「没有托管 server」那一态 ⇒ 调用方不传参数）。
  const empty = createSquadMcpMountResolver({ loadBase: spyLoader([]).loadBase });
  assert.equal(await empty({ workspacePath: "/repo/主工作区" }), undefined);
  assert.equal(await empty({ workspacePath: "/repo/主工作区", agentMcpServers: {} }), undefined);
});

// ---------- ② 接线守卫 + 变异自证 ----------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 派发桥实现体（`runSquadDispatch`）的源码区域：从函数签名到消息处理器之间。
 * 结构性边界（不是字节窗口）—— 实现体只可能在这段里，追加代码不会让它变成假红。
 */
function dispatchBridgeRegion(): string {
  const host = readFileSync(
    join(repoRoot, "packages", "desktop", "src", "host", "index.ts"),
    "utf8",
  );
  const implAt = host.indexOf("async function runSquadDispatch(");
  assert.ok(implAt >= 0, "host 里找不到 runSquadDispatch（派发桥实现体）");
  const handlerAt = host.indexOf('parentPort.on("message",', implAt);
  assert.ok(handlerAt > implAt, "找不到消息处理器边界");
  return host.slice(implAt, handlerAt);
}

/**
 * 丢掉**整行都是注释**的行：说明性注释里点名某个标识符是合法的（本仓踩过「注释还在、代码被删」
 * 的假绿），而「不兜底（不在这一层 try/catch）」这种注释会让「不得出现 catch」的守卫变成假红。
 */
function stripCommentLines(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return false;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        return false;
      }
      return !trimmed.startsWith("//");
    })
    .join("\n");
}

const RAW = dispatchBridgeRegion();
const SOURCE = stripCommentLines(RAW);

/** 两个锚点之间的源码（含起点、不含终点）；锚点缺失即抛（守卫不该靠「找不到」蒙过）。 */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到锚点：${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `找不到收尾锚点：${to}`);
  return source.slice(start, end);
}

/** 装配点（读取器注入）那一段。 */
function mountDepsRegion(source: string): string {
  return between(source, "createSquadMcpMountResolver({", "resolveSquadMcpServers({");
}

/** 挂载集解析那一调用的入参区（`await resolveSquadMcpServers({…})`）。 */
function mountCallRegion(source: string): string {
  return between(source, "resolveSquadMcpServers({", "zcodeTaskService.createTask({");
}

/** createTask 的入参区。 */
function createTaskPayloadRegion(source: string): string {
  return between(source, "zcodeTaskService.createTask({", "if (boundSessionId) {");
}

/** 取读取器 → 建会话 之间的源码（「读失败不得就地兜底」的判据面）。 */
function readerToCreateTaskRegion(source: string): string {
  return between(source, "getOptional(IMcpSyncService)", "zcodeTaskService.createTask({");
}

const GUARDS: ReadonlyArray<{ id: string; label: string; check: (source: string) => boolean }> = [
  {
    id: "①",
    label: "基准读取归属服务面（唯一实现）：host 不自己读 config.json、也不自己算 enabled",
    check: (source) => {
      const slice = readerToCreateTaskRegion(source);
      return (
        /getOptional\(IMcpSyncService\)/.test(slice) &&
        !/readFileSync/.test(slice) &&
        !/enabled\s*(?:===|!==)\s*false/.test(mountDepsRegion(source))
      );
    },
  },
  {
    id: "②",
    label: "读取器调用带工作区路径，且在派发函数体内（每次派发现建 = 现读；模块级缓存/丢路径都会失败）",
    check: (source) =>
      /createSquadMcpMountResolver\(\{/.test(source) &&
      /loadMcpFromUserDirectory\(\{ workspacePath \}\)/.test(mountDepsRegion(source)),
  },
  {
    id: "③",
    label: "合并/转换经注入装配点（host 不内联合并实现）",
    check: (source) =>
      /createSquadMcpMountResolver\(\{/.test(source) &&
      !/mergeTeamAgentMcpServers\(/.test(source) &&
      !/toZCodeAgentMcpServers\(/.test(source),
  },
  {
    id: "④",
    label: "三态进载荷：有值才传 mcpServers（在 createTask 入参里）",
    check: (source) =>
      /\.\.\.\(mcpServers \? \{ mcpServers \} : \{\}\),/.test(createTaskPayloadRegion(source)),
  },
  {
    id: "⑤",
    label: "基准读的是主工作区路径（msg.workspacePath），不是会话所在的工作树路径",
    check: (source) => {
      const mount = mountCallRegion(source);
      return /workspacePath: msg\.workspacePath,/.test(mount) && !/sessionWorkspacePath/.test(mount);
    },
  },
  {
    id: "⑥",
    label: "agent 自有配置按 enqueued.agentId 取名册行（队长 run 也生效；不得用 targetAgent）",
    check: (source) => {
      const lookup = between(source, "const dispatchedAgent", "const mcpServers");
      return /enqueued\.agentId/.test(lookup) && !/targetAgent/.test(lookup);
    },
  },
  {
    id: "⑦",
    label: "绑定会话（重投）不重挂：挂载集只在新建会话那一支取值",
    check: (source) =>
      /boundSessionId\s*\?\s*undefined\s*:\s*await resolveSquadMcpServers\(/.test(source),
  },
  {
    id: "⑧",
    label: "读取/转换失败不得就地 catch：必须冒泡到外层 transient 出口",
    check: (source) => {
      const slice = readerToCreateTaskRegion(source);
      assert.ok(slice.includes("loadMcpFromUserDirectory"), "判据切片必须真的包含读取调用");
      return !/catch/.test(slice);
    },
  },
  {
    id: "⑨",
    label: "日志只记 server 名单；挂载集（含 env/headers 凭据）不得被序列化",
    check: (source) =>
      /mcp=\$\{mcpServerNames\}/.test(source) &&
      /mcpServers\?\.map\(\(server\) => server\.name\)/.test(source) &&
      !/JSON\.stringify\(mcpServers/.test(source),
  },
];

for (const guard of GUARDS) {
  test(`接线守卫 ${guard.id}：${guard.label}`, () => {
    assert.ok(RAW.length > 5_000, "派发桥区域不能是空串（否则所有守卫都是空跑）");
    assert.ok(guard.check(SOURCE), `守卫 ${guard.id} 未通过：${guard.label}`);
  });
}

/* 变异自证（**非空跑**）：每条变异模拟一个「可信回归」，对应守卫必须失败。
   变异只施加在内存里的字符串上，仓库文件不动。 */
function mutate(source: string, from: string | RegExp, to: string): string {
  const next = source.replace(from, to);
  assert.notEqual(next, source, `变异未生效（锚点没命中）：${String(from)}`);
  return next;
}

const MUTATIONS: ReadonlyArray<{ works: string; guard: string; mutated: string }> = [
  {
    works: "host 绕开服务面、在 loadBase 里自己读 config.json",
    guard: "①",
    mutated: mutate(
      SOURCE,
      "(await mcpSyncService.loadMcpFromUserDirectory({ workspacePath })).servers,",
      'JSON.parse(readFileSync(join(workspacePath, ".zcode", "config.json"), "utf8")).mcp.servers,',
    ),
  },
  {
    works: "host 自己算 enabled（第二份「怎么算启用」的判据）",
    guard: "①",
    mutated: mutate(
      SOURCE,
      "(await mcpSyncService.loadMcpFromUserDirectory({ workspacePath })).servers,",
      "(await mcpSyncService.loadMcpFromUserDirectory({ workspacePath })).servers.filter((item) => item.enabled !== false),",
    ),
  },
  {
    works: "读取器调用丢掉工作区路径",
    guard: "②",
    mutated: mutate(
      SOURCE,
      "loadMcpFromUserDirectory({ workspacePath })",
      "loadMcpFromUserDirectory({})",
    ),
  },
  {
    works: "host 内联合并（绕开注入的装配点）",
    guard: "③",
    mutated: mutate(
      SOURCE,
      "const resolveSquadMcpServers = createSquadMcpMountResolver({",
      `const resolveSquadMcpServers = async (input: { agentMcpServers?: Record<string, McpServerConfig> }) =>
      toZCodeAgentMcpServers(mergeTeamAgentMcpServers(目录记录, input.agentMcpServers));
    const 未用到的装配点 = createSquadMcpMountResolver({`,
    ),
  },
  {
    works: "挂载集无条件进载荷（空集也显式传 ⇒ 覆盖集语义被架空）",
    guard: "④",
    mutated: mutate(SOURCE, "...(mcpServers ? { mcpServers } : {}),", "mcpServers,"),
  },
  {
    works: "基准改按会话（工作树）路径读取",
    guard: "⑤",
    mutated: mutate(
      mountCallRegion(SOURCE),
      "workspacePath: msg.workspacePath,",
      "workspacePath: sessionWorkspacePath,",
    ),
  },
  {
    works: "agent 自有配置改用 targetAgent（队长 run 会静默漏挂）",
    guard: "⑥",
    mutated: mutate(SOURCE, "entry.id === enqueued.agentId", "entry.id === targetAgentId"),
  },
  {
    works: "绑定会话也重新挂载（重投换了 runtime 配置）",
    guard: "⑦",
    mutated: mutate(
      SOURCE,
      /boundSessionId\s*\?\s*undefined\s*:\s*await resolveSquadMcpServers\(/,
      "await resolveSquadMcpServers(",
    ),
  },
  {
    works: "读取失败就地兜底成空集合（静默跑掉一整层 server）",
    guard: "⑧",
    mutated: mutate(
      SOURCE,
      /loadBase: async \(\{ workspacePath \}\) =>\s*\n\s*\(await mcpSyncService\.loadMcpFromUserDirectory\(\{ workspacePath \}\)\)\.servers,/,
      `loadBase: async ({ workspacePath }) => {
        try {
          return (await mcpSyncService.loadMcpFromUserDirectory({ workspacePath })).servers;
        } catch {
          return [];
        }
      },`,
    ),
  },
  {
    works: "日志序列化整个挂载集（含 env/headers 凭据）",
    guard: "⑨",
    mutated: mutate(SOURCE, "mcp=${mcpServerNames}", "mcp=${JSON.stringify(mcpServers)}"),
  },
];

for (const mutation of MUTATIONS) {
  test(`变异自证：${mutation.works} ⇒ 守卫 ${mutation.guard} 必须失败`, () => {
    const guard = GUARDS.find((entry) => entry.id === mutation.guard);
    assert.ok(guard, `没有编号为 ${mutation.guard} 的守卫`);
    // 判据切片若在变异版上锚点失效，check 会抛错 —— 那也是「守卫失败」，故兜成布尔。
    let passed = false;
    try {
      passed = guard.check(mutation.mutated);
    } catch {
      passed = false;
    }
    assert.equal(passed, false, `守卫 ${mutation.guard} 对「${mutation.works}」的变异仍然通过 = 空跑`);
  });
}

test("注释剥离本身是承重的：原文那句「不在这一层 try/catch」的说明若被当作代码，守卫⑧会假红", () => {
  assert.ok(RAW.includes("try/catch"), "原文注释里应当有 try/catch 的说明（否则这条自证没意义）");
  assert.equal(SOURCE.includes("try/catch"), false, "剥离注释后不该再有该说明");
});
