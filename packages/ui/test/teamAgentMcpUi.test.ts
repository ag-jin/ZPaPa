import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* per-agent MCP 的 **UI 呈现位**（设计 §3.6）守卫：编辑表单新分区 + 详情页只读徽标。
   ui 包没有渲染设施（既有做法，见 squadAgentsPage.test.ts 说明），组件行为拆成两半验证：
   ① 判断在 `teamAgentMcpViewModel.ts`（纯函数，`teamAgentMcpViewModel.test.ts` 逐条钉住）；
   ② 接线在组件里 —— 用**结构守卫**钉「分区在场 / 判据走唯一实现 / 字段真的进了提交载荷」。
   每条守卫都写明变异方式（改哪一处会让它红）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

test("守卫｜MCP 分区：逐行（名字 + 传输徽标 + 编辑/删除）、空态、添加入口齐全", () => {
  const section = readSource("squad/TeamAgentMcpSection.tsx");
  assert.ok(section.includes('data-testid="squad-agent-mcp-section"'), "分区 testid");
  for (const testId of [
    "squad-agent-mcp-row",
    "squad-agent-mcp-transport",
    "squad-agent-mcp-edit",
    "squad-agent-mcp-remove",
    "squad-agent-mcp-add",
    "squad-agent-mcp-empty",
  ]) {
    assert.ok(section.includes(`data-testid="${testId}"`), `缺 ${testId}（少一个就是少一件可见能力）`);
  }
  assert.ok(
    section.includes("listMcpServerEntries("),
    "行投影必须走 view model 的唯一实现（另写一份排序/传输判据会漂）",
  );
  assert.ok(
    section.includes("mcpTransportMessageId("),
    "传输徽标文案必须走唯一映射（stdio/http/sse/streamableHttp 的键名不散落）",
  );
  assert.ok(
    section.includes("rows.length === 0") && section.includes("squad.agentMcp.empty"),
    "空 map 合法 ⇒ 显示空态（不是报错、也不是不渲染）",
  );
  // 分区挂在外层表单里：任何一个 Button 用了默认 type="submit" 都会变成「删一个 server 顺手提交整张表单」。
  assert.equal(
    (section.match(/<Button/g) ?? []).length,
    (section.match(/type="button"/g) ?? []).length,
    "本文件每个 Button 都必须显式 type=\"button\"",
  );
  assert.ok(!section.includes("<form"), "分区不得自带 form（没有第二个提交入口）");
});

test("守卫｜MCP 对话框：名字 + JSON 两个控件、行内错误、保存判据走 validateMcpServerEntry", () => {
  const section = readSource("squad/TeamAgentMcpSection.tsx");
  for (const testId of [
    "squad-agent-mcp-dialog-name",
    "squad-agent-mcp-dialog-config",
    "squad-agent-mcp-dialog-name-error",
    "squad-agent-mcp-dialog-config-error",
  ]) {
    assert.ok(section.includes(`data-testid="${testId}"`), `缺 ${testId}`);
  }
  assert.ok(
    section.includes("validateMcpServerEntry("),
    "保存判据必须走 view model 的合成判据（组件里再写一遍名字/JSON 判断就会两边漂）",
  );
  // 变异：把 `disabled={!validation.entry}` 改成不禁用 ⇒ 保存按钮能在校验不通过时点下去。
  assert.ok(
    section.match(/disabled=\{!validation\.entry\}/),
    "保存按钮由校验结果驱动（畸形配置不能落盘）",
  );
  // 变异：编辑既有行时不传 keepName ⇒ 「保存」会被自己判成重名，改不动任何东西。
  assert.ok(section.includes("keepName"), "编辑既有行时把原名字传给判据（否则改不动）");
  // 名字与配置的文案都经 i18n（键树 squad.agentMcp.*，且键名由 view model 生成）。
  assert.ok(
    section.includes("mcpServerNameErrorMessageId("),
    "名字错误文案走 view model 的键生成器（档位改名时不会留下写死的旧键）",
  );
  assert.ok(section.includes("configMessageId"), "配置错误文案走 i18n 键（schema 的 detail 只作副行）");
  // 安全提示（设计 §3.5 的 R4/R5 文案落点）。
  assert.ok(section.includes("squad.agentMcp.securityHint"), "凭据扩散提示在场（R4）");
  assert.ok(section.includes("squad.agentMcp.oauthHint"), "oauth 无头超时提示在场（R5）");
});

test("守卫｜TeamAgentDialog 接线：分区进表单、map 受控、提交经 mcpServersSubmitPatch", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(dialog.includes("<TeamAgentMcpSection"), "表单必须渲染 MCP 分区");
  assert.match(
    dialog,
    /\[mcpServers, setMcpServers\] = useState/,
    "map 状态由对话框持有（分区受控，不另存副本）",
  );
  assert.ok(
    dialog.includes("onChange={setMcpServers}"),
    "分区的更新直接写回该状态（少这一句 = 行内增删点了没反应）",
  );
  assert.ok(
    dialog.includes("mcpServersSubmitPatch("),
    "提交语义走 view model（空 map 清空 vs 不落盘的两义不能写错在表单里）",
  );
  // 变异：initial 类型里不放 mcpServers ⇒ 编辑既有 agent 时配置读不进来（一保存就清空）。
  assert.match(dialog, /mcpServers\?: Record<string, McpServerConfig>/, "initial / 提交入参形状含该字段");
  assert.ok(dialog.includes("initial?.mcpServers"), "初值来自既有定义");
});

/* 白名单字段未接线的两种表现都在这一条守卫里：编辑时读不到（一保存就清空）与提交时丢字段
   （改了不落盘）。变异：删掉页面里任一处 ⇒ 本用例红。 */
test("守卫｜SquadAgentsPage 接线：编辑回填 mcpServers、提交入参形状含该字段、载荷原样进 patch", () => {
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("dialog.agent.mcpServers !== undefined"),
    "编辑初值回填 mcpServers（缺失时传 undefined 会被服务面当成「没提」——回填必须条件化）",
  );
  assert.ok(
    page.includes("mcpServers: dialog.agent.mcpServers"),
    "初值把既有 map 交给对话框",
  );
  assert.match(
    page,
    /mcpServers\?: TeamAgent\["mcpServers"\]/,
    "submitDialog 入参形状含该字段（不带它，对话框的提交在页面这一层就被丢掉）",
  );
  assert.ok(
    page.includes("service.updateTeamAgent(target, { id, patch: input })"),
    "提交载荷原样作为 patch 进服务面（字段随白名单落盘，页面不做二次筛选）",
  );
});

/* 切片 2 的另一半：详情页只读呈现（设计 §3.6：名字 + 传输类型）。
   变异：去掉条件渲染（无配置也画一行）⇒ 「无配置不渲染」断言红；
        改用手写的传输判据（不读 mcpTransportMessageId）⇒ 「唯一实现」断言红。 */
test("守卫｜详情页只读徽标行：有配置才渲染，名字 + 类型走同一份行投影", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes('data-testid="squad-agent-detail-mcp"'), "MCP 徽标行 testid");
  assert.ok(page.includes('data-testid="squad-agent-detail-mcp-server"'), "逐条徽标 testid");
  assert.ok(page.includes("listMcpServerEntries("), "行投影与编辑列表共用同一实现（不另写一份）");
  assert.ok(page.includes("mcpTransportMessageId("), "类型文案走唯一映射");
  assert.ok(
    page.includes("const mcpRows = listMcpServerEntries(agent.mcpServers);"),
    "行投影直接读 agent.mcpServers（该字段随快照到达，不需要新增读取通路）",
  );
  assert.match(
    page,
    /mcpRows\.length > 0 \?/,
    "无配置（字段缺席或空 map）不渲染该行 —— 空徽标行是噪音",
  );
});
