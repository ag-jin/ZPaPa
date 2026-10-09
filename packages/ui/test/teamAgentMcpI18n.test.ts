import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  mcpServerNameErrorMessageId,
  mcpTransportMessageId,
  parseMcpServerConfigText,
} from "../src/squad/teamAgentMcpViewModel.js";

/* per-agent MCP 的**双语成对**守卫（设计 §3.6/§3.5）：分区、对话框与两条安全提示的键在两语里
   都必须存在，且「判据生成的键」（名字档位 / 配置档位 / 传输类型）都能解析到文案 ——
   档位改名却忘了改文案时，只有这一条能发现。
   变异：删掉任一语里的一个键 ⇒ 本组红（`squad.*` 前缀的全集比较另有一条既有守卫）。 */

/* ---------- i18n：键成对 + 判据生成的键真实可解析 ----------
   变异：从任一语里删掉一个 MCP 键 ⇒ 本组红（`squad.*` 前缀的全集比较另有一条既有守卫，
   这里补的是「判据生成的键确实存在」——前缀/档位改名而不改文案，只有这条能发现）。 */

test("i18n：MCP 分区与对话框的键两语成对，安全提示要点（R4 / R5）都在", () => {
  const keys = [
    "squad.common.mcpServers",
    "squad.agentMcp.empty",
    "squad.agentMcp.add",
    "squad.agentMcp.remove",
    "squad.agentMcp.removeAria",
    "squad.agentMcp.inheritHint",
    "squad.agentMcp.securityHint",
    "squad.agentMcp.oauthHint",
    "squad.agentMcp.dialog.addTitle",
    "squad.agentMcp.dialog.editTitle",
    "squad.agentMcp.dialog.hint",
    "squad.agentMcp.dialog.config",
  ];
  for (const key of keys) {
    assert.ok(zhCN[key], `zh-CN 缺 ${key}`);
    assert.ok(enUS[key], `en-US 缺 ${key}`);
  }
  // 带占位符的键：`{name}` 只译一侧会让用户看到原始花括号。
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  assert.equal(placeholdersOf(zhCN["squad.agentMcp.removeAria"] ?? ""), "name");
  assert.equal(placeholdersOf(enUS["squad.agentMcp.removeAria"] ?? ""), "name");

  // R4：凭据扩散提示必须点名 `.zcode/squad`（只说「注意安全」等于没说）。
  for (const [locale, name] of [
    [zhCN, "zh-CN"],
    [enUS, "en-US"],
  ] as const) {
    assert.ok(
      (locale["squad.agentMcp.securityHint"] ?? "").includes(".zcode/squad"),
      `${name} 的凭据扩散提示必须点名 .zcode/squad（提交进仓库 ⇒ 凭据随仓库扩散）`,
    );
  }
  // R5：授权码型 server 在无人值守 run 里的 15s 超时。
  for (const [locale, name] of [
    [zhCN, "zh-CN"],
    [enUS, "en-US"],
  ] as const) {
    const hint = locale["squad.agentMcp.oauthHint"] ?? "";
    assert.ok(hint.includes("authorization_code"), `${name} 的提示要点名 authorization_code 型`);
    assert.ok(hint.includes("15"), `${name} 的提示要给出 15 秒这个可核对的量`);
  }
});

test("i18n：判据生成的键（名字档位 / 配置档位 / 传输类型）两语都能解析到文案", () => {
  for (const issue of ["required", "format", "duplicate"] as const) {
    const key = mcpServerNameErrorMessageId(issue);
    assert.ok(zhCN[key] && enUS[key], `名字档位 ${issue} 的文案键缺失：${key}`);
  }
  const configSamples: Array<[string, string]> = [
    ["invalidJson", "{ not json"],
    ["notObject", "42"],
    ["missingTransport", "{}"],
    ["invalidShape", '{"url": 1}'],
  ];
  for (const [issue, text] of configSamples) {
    const result = parseMcpServerConfigText(text);
    assert.ok(!result.ok, `${text} 应当校验失败`);
    assert.equal(result.issue, issue, `${text} 的档位`);
    assert.ok(
      zhCN[result.messageId] && enUS[result.messageId],
      `配置档位 ${issue} 的文案键缺失：${result.messageId}`,
    );
  }
  for (const kind of ["stdio", "http", "sse", "streamableHttp"] as const) {
    const key = mcpTransportMessageId(kind);
    assert.ok(zhCN[key] && enUS[key], `传输类型 ${kind} 的文案键缺失：${key}`);
  }
});
