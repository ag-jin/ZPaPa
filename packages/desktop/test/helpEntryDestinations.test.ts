import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 帮助四个入口（产品文档 / 用户社群 / 问题上报 / 提需求）的接线守卫。
 *
 * 目的地字面量已由 packages/shared/test/helpLinks.test.ts 钉住，动作层与主进程外开
 * 也各有行为测试；这里只补两个从外部观测不到的表面：
 *  - 工作区帮助菜单与 quick pick、原生菜单模板的「入口 → 动作」接线；
 *  - 退役的远端/本地 config 解析（feedback_url / community_urls）不得回到这些路径。
 * 因此用源码接线守卫（与 schedulerWiring/autoUpdater 的既有做法同源），而不是再起 Electron。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

test("工作区帮助菜单：四个入口都接线到 helpMenuActions/platform，不再走内置需求弹窗", () => {
  const source = read("packages/ui/src/WorkspaceHelpMenuButton.tsx");
  for (const wiring of [
    "helpMenuActions.openProductDocs",
    "helpMenuActions.openIssueReport",
    "helpMenuActions.openFeatureRequest",
    "platform.openCommunity()",
  ]) {
    assert.ok(source.includes(wiring), `帮助菜单缺少接线：${wiring}`);
  }
  assert.ok(
    !source.includes("useFeedbackStore"),
    "帮助菜单不得再直接打开内置反馈/需求弹窗（问题上报与提需求已改为外开 GitHub issue）",
  );
});

test("quick pick：三个帮助命令由 App handlers 落到平台外开（同一批常量/命令）", () => {
  const quickPickSource = read("packages/ui/src/quickpick/quickPickCommands.ts");
  for (const wiring of [
    'id: "feedback"',
    'id: "community"',
    'id: "product-docs"',
    "handlers.openFeedback",
    "handlers.openCommunity",
    "handlers.openProductDocs",
  ]) {
    assert.ok(quickPickSource.includes(wiring), `quick pick 缺少接线：${wiring}`);
  }

  const appSource = read("packages/ui/src/App.tsx");
  for (const wiring of [
    "platform.openExternal(ZCODE_PRODUCT_DOCS_URL)",
    "void platform.openFeedback()",
    "platform.openCommunity()",
  ]) {
    assert.ok(appSource.includes(wiring), `App handlers 缺少接线：${wiring}`);
  }
});

test("原生菜单：「问题上报」仍走 OpenFeedback 命令（同一条主进程外开链路）", () => {
  const menuSource = read("packages/desktop/src/main/desktopApplicationMenu.ts");
  assert.match(
    menuSource,
    /helpFeedback[\s\S]*?DesktopCommandIds\.OpenFeedback/,
    "原生菜单 helpFeedback 必须走 OpenFeedback 命令",
  );
});

test("主进程/Web 落点：四入口硬指 GitHub 常量，config 解析路径已退役", () => {
  const handlers = read("packages/desktop/src/main/desktopCommandHandlers.ts");
  assert.ok(handlers.includes("shell.openExternal(ZPAPA_ISSUE_NEW_URL)"));
  assert.ok(handlers.includes("shell.openExternal(ZPAPA_COMMUNITY_URL)"));
  for (const retired of [
    "feedback_url",
    "community_urls",
    "resolveHelpAppConfig",
    "fetchHelpConfig",
  ]) {
    assert.ok(!handlers.includes(retired), `desktop 命令处理不得再解析帮助 config：${retired}`);
  }

  const webSource = read("packages/web/src/main.tsx");
  assert.ok(webSource.includes("ZPAPA_ISSUE_NEW_URL"));
  assert.ok(webSource.includes("ZPAPA_COMMUNITY_URL"));
  for (const retired of ["resolveWebHelpConfig", "resolveWebCommunityUrl", "feedback_url"]) {
    assert.ok(!webSource.includes(retired), `Web 平台不得再解析帮助 config：${retired}`);
  }

  const productDocsSource = read("packages/ui/src/lib/productDocs.ts");
  assert.ok(productDocsSource.includes("ZPAPA_PRODUCT_DOCS_URL"));
});

test("帮助表面不再残留旧目的地（zcode.z.ai/docs、飞书、Discord）", () => {
  const helpSurfaceFiles = [
    "packages/shared/src/helpLinks.ts",
    "packages/ui/src/lib/productDocs.ts",
    "packages/ui/src/lib/helpMenuActions.ts",
    "packages/ui/src/WorkspaceHelpMenuButton.tsx",
    "packages/ui/src/App.tsx",
    "packages/ui/src/quickpick/quickPickCommands.ts",
    "packages/desktop/src/main/desktopCommandHandlers.ts",
    "packages/desktop/src/main/desktopApplicationMenu.ts",
    "packages/web/src/main.tsx",
  ];
  for (const file of helpSurfaceFiles) {
    const source = read(file).toLowerCase();
    for (const legacy of ["zcode.z.ai/docs", "feishu", "discord.gg"]) {
      assert.ok(!source.includes(legacy), `${file} 仍含旧目的地：${legacy}`);
    }
  }
});
