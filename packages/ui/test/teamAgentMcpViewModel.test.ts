import assert from "node:assert/strict";
import test from "node:test";
import {
  inferMcpTransport,
  listMcpServerEntries,
  mcpServersSubmitPatch,
  mcpTransportMessageId,
  parseMcpServerConfigText,
  validateMcpServerEntry,
  validateMcpServerName,
} from "../src/squad/teamAgentMcpViewModel.js";

/* per-agent MCP 编辑面（设计 §3.6）的**纯逻辑**用例：ui 包没有渲染设施（既有做法，
   见 squadAgentsPage.test.ts 的说明），表单行为落在 `src/squad/teamAgentMcpViewModel.ts`
   这个纯模块上，组件只做投影。

   判据来源不是本仓实现，而是对齐目标（multica agent 级对话框 `mcp-server-dialog.tsx:283-293`）：
   名字必填 / 字符集 `^[A-Za-z0-9_-]+$` / 与既有行重名 ⇒ duplicate（沿用原名的行除外）。 */

test("名字校验：空白 ⇒ required；字符集之外的字符 ⇒ format", () => {
  assert.equal(validateMcpServerName("", []), "required");
  assert.equal(validateMcpServerName("   ", []), "required", "纯空白不是名字");
  // 字符集 `[A-Za-z0-9_-]`：允许的三种字符形态逐类打全。
  assert.equal(validateMcpServerName("github", []), null);
  assert.equal(validateMcpServerName("GitHub-MCP_2", []), null);
  assert.equal(
    validateMcpServerName("my server", []),
    "format",
    "空格不在字符集内（空白名字在协议里会变成 mcp__<server>__ 的孤儿前缀）",
  );
  assert.equal(validateMcpServerName("mcp.servers", []), "format", "点号不在字符集内");
  assert.equal(validateMcpServerName("服务器", []), "format", "非 ASCII 不在字符集内");
  assert.equal(validateMcpServerName("mcp/server", []), "format");
});

test("名字校验：与既有行同名 ⇒ duplicate；沿用原名（编辑本行）不算重复；两侧 trim", () => {
  assert.equal(validateMcpServerName("github", ["github", "files"]), "duplicate");
  assert.equal(validateMcpServerName("files", ["github", "files"]), "duplicate");
  assert.equal(validateMcpServerName("new-one", ["github", "files"]), null);
  assert.equal(
    validateMcpServerName("github", ["github", "files"], { keepName: "github" }),
    null,
    "编辑既有行时名字没改 ⇒ 不能和自己重复",
  );
  assert.equal(
    validateMcpServerName("files", ["github", "files"], { keepName: "github" }),
    "duplicate",
    "改成一个别的行的名字 ⇒ 仍然重复",
  );
  assert.equal(validateMcpServerName("  github  ", ["github"]), "duplicate", "两侧 trim 后再比");
  assert.equal(validateMcpServerName("  github  ", []), null, "trim 后合法 ⇒ 通过");
});

/* 名字与字符集的关系（独立真值）：字符集正则本身是导出常量，组件与测试共用一份，
   避免「组件里写一份、测试里再抄一份」的漂移。 */
test("字符集常量与判据同源：pattern 拒空串、接受字符集内组合", async () => {
  const module = await import("../src/squad/teamAgentMcpViewModel.js");
  assert.ok(module.MCP_SERVER_NAME_PATTERN instanceof RegExp, "字符集正则是导出常量");
  assert.equal(module.MCP_SERVER_NAME_PATTERN.test("a-B_9"), true);
  assert.equal(module.MCP_SERVER_NAME_PATTERN.test(""), false);
  assert.equal(module.MCP_SERVER_NAME_PATTERN.test("a b"), false);
});

/* ---------- 配置 JSON 的浅校验（逐条 safeParse）----------
   真值来源：shared 的 `teamAgentMcpServersSchema`（落盘前唯一收口）——编辑面判据必须与落盘判据
   同源，否则会出现「表单放行、保存时报错」或反向的静默丢弃。 */

test("配置浅校验：JSON 语法错误 ⇒ invalidJson，且结果里不回显输入内容", () => {
  // 这段输入里带了看起来像凭据的片段：错误结果**任何字段**都不得把它带出来。
  const text = '{"url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer sk-SECRET"},,}';
  const result = parseMcpServerConfigText(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.issue, "invalidJson");
  assert.equal(result.messageId, "squad.agentMcp.jsonError.invalidJson");
  assert.equal(
    result.detail,
    undefined,
    "JSON.parse 的消息会带输入片段（node: Unexpected token 'x', \"{...}\" is not valid JSON）⇒ 整条丢掉",
  );
  assert.ok(
    !JSON.stringify(result).includes("sk-SECRET") && !JSON.stringify(result).includes("mcp.example.com"),
    "错误结果不得回显配置内容（env/headers 里就是凭据）",
  );
});

test("配置浅校验：不是 JSON 对象 ⇒ notObject（数组 / 字符串 / null 都拒）", () => {
  for (const text of ['"just-a-string"', "[1,2]", "null", "42"]) {
    const result = parseMcpServerConfigText(text);
    assert.ok(!result.ok, `${text} 必须被拒`);
    assert.equal(result.issue, "notObject", `${text} 的档位`);
    assert.equal(result.messageId, "squad.agentMcp.jsonError.notObject");
  }
});

test("配置浅校验：缺 command 与 url ⇒ missingTransport（走 shared schema 的 refine，文案不含内容）", () => {
  const result = parseMcpServerConfigText('{"apiKey": "sk-SECRET-2"}');
  assert.ok(!result.ok);
  assert.equal(result.issue, "missingTransport");
  assert.equal(result.messageId, "squad.agentMcp.jsonError.missingTransport");
  assert.ok((result.detail ?? "").length > 0, "schema 的首条 message 要透出（不是静默拒绝）");
  assert.ok(
    !JSON.stringify(result).includes("sk-SECRET-2"),
    "detail 只能是 schema 的固定文案，不得夹带用户内容",
  );
});

test("配置浅校验：字段类型不对 ⇒ invalidShape（首条 issue 进 detail）", () => {
  const result = parseMcpServerConfigText('{"url": 123}');
  assert.ok(!result.ok);
  assert.equal(result.issue, "invalidShape");
  assert.equal(result.messageId, "squad.agentMcp.jsonError.invalidShape");
  assert.match(result.detail ?? "", /string/, "首条 issue 说明期望的类型（schema 原文）");
});

test("配置浅校验：合法配置原样读出（开放形状不剥字段——编辑要能 round-trip）", () => {
  const config = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { TOKEN: "sk-SECRET" },
    timeoutMs: 30000,
  };
  const result = parseMcpServerConfigText(JSON.stringify(config));
  assert.ok(result.ok);
  assert.deepEqual(result.config, config, "未知/扩展字段（timeoutMs 等）不得在编辑往返中被剥掉");

  // url 家族同样放行（http / sse 由 url 承载）。
  const urlResult = parseMcpServerConfigText('{"url": "https://mcp.example.com/sse", "headers": {}}');
  assert.ok(urlResult.ok);
  assert.deepEqual(urlResult.config, { url: "https://mcp.example.com/sse", headers: {} });
});

/* ---------- 传输类型与行投影（编辑列表与详情页徽标共用同一份）---------- */

test("传输类型推断：command ⇒ stdio、url ⇒ http、显式 type 优先（sse / streamableHttp）", () => {
  assert.equal(inferMcpTransport({ command: "npx" }), "stdio");
  assert.equal(inferMcpTransport({ url: "https://mcp.example.com/mcp" }), "http");
  assert.equal(inferMcpTransport({ type: "sse", url: "https://mcp.example.com/sse" }), "sse");
  assert.equal(
    inferMcpTransport({ type: "streamableHttp", url: "https://mcp.example.com/mcp" }),
    "streamableHttp",
  );
  assert.equal(
    inferMcpTransport({ type: "http", url: "https://mcp.example.com/mcp" }),
    "http",
    "显式 http 与 url 推断同档",
  );
  // 两个字段同时存在 ⇒ command 赢（与设置页 McpServerList 的行展示同口径，不另立一份判据）。
  assert.equal(inferMcpTransport({ command: "npx", url: "https://mcp.example.com/mcp" }), "stdio");
  assert.equal(mcpTransportMessageId("stdio"), "squad.agentMcp.transport.stdio");
  assert.equal(mcpTransportMessageId("streamableHttp"), "squad.agentMcp.transport.streamableHttp");
});

test("行投影：名字排序稳定，逐行带传输类型；缺席 / 空 map ⇒ 空数组（空态由调用方渲染）", () => {
  const rows = listMcpServerEntries({
    zeta: { url: "https://z.example.com/mcp" },
    alpha: { command: "npx" },
    beta: { type: "sse", url: "https://b.example.com/sse" },
  });
  assert.deepEqual(rows, [
    { name: "alpha", transport: "stdio" },
    { name: "beta", transport: "sse" },
    { name: "zeta", transport: "http" },
  ]);
  assert.deepEqual(listMcpServerEntries(undefined), [], "字段缺席 = 没有覆盖项");
  assert.deepEqual(listMcpServerEntries({}), [], "空 map 合法（服务面语义见提交用例）");
});

/* ---------- 提交语义（表单 → TeamAgentEditablePatch.mcpServers）----------
   三态必须能被读出来：有配置 = 提交整张 map；编辑时删光 = 提交 `{}`（服务面 `{}` 是「清空」不是
   「没提」）；本来就没有 = 字段不落盘（不给存量定义文件添加空对象）。 */

test("提交语义：有 server ⇒ 提交整张 map；删光 ⇒ 提交 {}；本来没有 ⇒ 不带该字段", () => {
  const github = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
  assert.deepEqual(
    mcpServersSubmitPatch({ github }, false),
    { mcpServers: { github } },
    "有配置：连同字段一起提交",
  );
  assert.deepEqual(
    mcpServersSubmitPatch({}, true),
    { mcpServers: {} },
    "编辑时删光必须提交空 map —— undefined 会被服务面当成「没提这个字段」而保留旧配置",
  );
  assert.deepEqual(
    mcpServersSubmitPatch({}, false),
    {},
    "新建且没配 server：不落盘（「没有这个字段」= 不覆盖任何 server 的那一态）",
  );
  assert.deepEqual(mcpServersSubmitPatch(undefined, false), {}, "缺席同空 map 处理");
  assert.deepEqual(mcpServersSubmitPatch(undefined, true), { mcpServers: {} }, "删光无剩余 ⇒ 清空");
});

/* ---------- 对话框「保存」判据（两个字段的档位一起给出）----------
   组件据此渲染两个行内错误并决定保存按钮是否可用：只有两条都干净时才有可落盘的条目。 */

test("整条校验：两个字段的档位分别给出；都通过才产出可保存条目（名字 trim 后落库）", () => {
  const clean = validateMcpServerEntry({
    name: "github",
    configText: '{"command": "npx"}',
    existingNames: ["files"],
  });
  assert.equal(clean.nameIssue, null);
  assert.equal(clean.configIssue, null);
  assert.deepEqual(clean.entry, { name: "github", config: { command: "npx" } });

  const trimmed = validateMcpServerEntry({
    name: "  github  ",
    configText: '{"url": "https://mcp.example.com/mcp"}',
    existingNames: [],
  });
  assert.deepEqual(trimmed.entry, {
    name: "github",
    config: { url: "https://mcp.example.com/mcp" },
  });

  // 空名但配置合法：名字档位要报出来，且**不产出**可保存条目（否则保存按钮会放行一条无名配置）。
  const badName = validateMcpServerEntry({
    name: "",
    configText: '{"command": "npx"}',
    existingNames: [],
  });
  assert.equal(badName.nameIssue, "required");
  assert.equal(badName.configIssue, null, "配置那边是干净的 —— 归因必须分清");
  assert.equal(badName.entry, null);

  // 名字合法但配置坏：配置档位（含 i18n 键）报出来。
  const badConfig = validateMcpServerEntry({
    name: "github",
    configText: "{ not json",
    existingNames: [],
  });
  assert.equal(badConfig.nameIssue, null);
  assert.equal(badConfig.configIssue, "invalidJson");
  assert.equal(badConfig.configMessageId, "squad.agentMcp.jsonError.invalidJson");
  assert.equal(badConfig.entry, null);

  // 重名：编辑本行沿用原名放行；撞别的行拦住。
  const keep = validateMcpServerEntry({
    name: "github",
    configText: '{"command": "npx"}',
    existingNames: ["github", "files"],
    keepName: "github",
  });
  assert.equal(keep.nameIssue, null);
  assert.ok(keep.entry, "沿用原名的编辑必须能保存");
  const clash = validateMcpServerEntry({
    name: "files",
    configText: '{"command": "npx"}',
    existingNames: ["github", "files"],
    keepName: "github",
  });
  assert.equal(clash.nameIssue, "duplicate");
  assert.equal(clash.entry, null);
});
