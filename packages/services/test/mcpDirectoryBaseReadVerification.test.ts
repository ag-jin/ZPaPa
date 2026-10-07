import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeTeamAgentMcpServers, toZCodeAgentMcpServers } from "@zcode/shared";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

/* 独立复验（per-agent MCP 切片 1 / D1 落点）：**真实**目录读取器与合并的接合。
   切片把基准读取的落点放在服务面 `IMcpSyncService.loadMcpFromUserDirectory`（而不是 host 自己读
   config.json）。既有的单测只注入**假读取器**，于是「真读取器给出的记录形状与数组顺序，能否被合并
   层正确消化」没有任何断言观察过 —— 若读取器返回顺序反了（user 在前），而合并又依赖入参顺序，
   覆盖方向会静默反过来（同名拿错配置），全套假读取器测试仍然全绿。

   这里用**真实实现 + 真实临时目录**（HOME 隔离到临时目录，避免读到真机上的用户级配置）走一遍：
     `<ws>/.zcode/config.json` 的 `mcp.servers` + `$HOME/.zcode/cli/config.json` 的 `mcp.servers`
     → `loadMcpFromUserDirectory` → 合并（含 agent 覆盖）→ 协议载荷。 */

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("真实读取器 → 合并 → 协议载荷：workspace 赢 user、停用不挂、与数组顺序无关", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const workspace = mkdtempSync(join(tmpdir(), "ws-"));
  const previousHome = process.env.HOME;
  // 用户级目录必须隔离到临时 home：否则这条用例读的是真机上那个人的配置（不确定、还会泄漏进断言）。
  process.env.HOME = home;
  try {
    writeJsonFile(join(home, ".zcode", "cli", "config.json"), {
      mcp: {
        servers: {
          同名: { command: "user-版" },
          只在用户级: { command: "user-only" },
          用户级关掉的: { command: "user-停用", enabled: false },
        },
      },
    });
    writeJsonFile(join(workspace, ".zcode", "config.json"), {
      mcp: {
        servers: {
          同名: { command: "workspace-版", args: ["--ws"] },
          只在工作区级: { command: "ws-only" },
          工作区级关掉的: { command: "ws-停用", enabled: false },
        },
      },
    });

    const service = createMcpSyncService();
    const { servers } = await service.loadMcpFromUserDirectory({ workspacePath: workspace });

    // ① 读取器的事实面：两个作用域的记录都在，scope 标对、enabled 由**读取器**算出（host 不自己算）。
    const namesIn = (scope: "user" | "workspace") =>
      servers
        .filter((record) => record.scope === scope)
        .map((record) => record.name)
        .sort();
    const sorted = (values: string[]) => [...values].sort(); // 两侧都排序，避开默认排序的码位陷阱
    assert.deepEqual(namesIn("workspace"), sorted(["同名", "只在工作区级", "工作区级关掉的"]));
    assert.deepEqual(namesIn("user"), sorted(["同名", "只在用户级", "用户级关掉的"]));
    assert.equal(
      servers.find((record) => record.name === "工作区级关掉的")?.enabled,
      false,
      "enabled 由读取器从配置里读出（`!== false` 口径）",
    );
    assert.equal(servers.find((record) => record.name === "只在工作区级")?.enabled, true);

    // ② 接合：真记录直接喂给合并层，同名由 workspace 赢（不是被 user 反压）。
    const merged = mergeTeamAgentMcpServers(servers, { 同名: { command: "agent-版" } });
    assert.deepEqual(Object.keys(merged).sort(), sorted(["同名", "只在工作区级", "只在用户级"]));
    assert.deepEqual(merged["同名"], { command: "agent-版" }, "agent 覆盖赢两个目录层");

    const mergedWithoutAgent = mergeTeamAgentMcpServers(servers);
    assert.deepEqual(
      mergedWithoutAgent["同名"],
      { command: "workspace-版", args: ["--ws"] },
      "没有 agent 覆盖项时：workspace 级赢 user 级",
    );

    // ③ 顺序无关：把真读取器给的数组倒过来，结论必须逐字相同（读取器的返回顺序不是判据）。
    assert.deepEqual(
      mergeTeamAgentMcpServers([...servers].reverse(), { 同名: { command: "agent-版" } }),
      merged,
      "合并结论不得依赖读取器的返回顺序",
    );

    // ④ 协议载荷：停用的目录条目不进载荷；载荷里不得残留存储标志（enabled）等配置字段。
    const payload = toZCodeAgentMcpServers(merged);
    assert.deepEqual(
      payload?.map((server) => server.name).sort(),
      sorted(["同名", "只在工作区级", "只在用户级"]),
    );
    assert.deepEqual(payload?.[0], { name: "同名", command: "agent-版", args: [], env: [] });

    // 目录记录里带的 enabled 是**存储标志位**，不得漏进协议 DTO（下游 strict 校验会因此改判）。
    const withFlag = toZCodeAgentMcpServers({ 带标志: { command: "带标志", enabled: true } });
    assert.equal("enabled" in (withFlag?.[0] ?? {}), false, "存储标志位不得进协议载荷");
  } finally {
    process.env.HOME = previousHome;
  }
});
