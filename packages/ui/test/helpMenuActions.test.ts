import assert from "node:assert/strict";
import test from "node:test";
import { ZPAPA_ISSUE_NEW_URL, ZPAPA_PRODUCT_DOCS_URL } from "@zcode/shared";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "../src/lib/helpMenuActions.js";

/**
 * 工作区帮助菜单四个入口改指 ZPaPa GitHub 仓库（位置/图标/文案不变，只换目的地）。
 *
 * 这里锁住菜单动作层：产品文档/问题上报/提需求都是「点击直达外开浏览器」——
 * 每个动作只产生一次 openExternal 调用，不得再拉起内置反馈弹窗或加确认步骤。
 * 用户社群走 platform.openCommunity（desktop 主进程/web 平台实现各自外开），不在本层断言。
 */

function createFakePlatform() {
  const opened: string[] = [];
  const platform = {
    exportLogs: async () => ({ success: true }),
    openExternal: (url: string) => {
      opened.push(url);
    },
  };
  return { opened, platform };
}

const intl: IntlInstance = { formatMessage: ({ id }) => id };

test("产品文档：菜单动作外开仓库 README", () => {
  const { opened, platform } = createFakePlatform();
  const actions = createHelpMenuActionHandlers({ platform, intl });
  actions.openProductDocs();
  assert.deepEqual(opened, [ZPAPA_PRODUCT_DOCS_URL]);
  assert.equal(ZPAPA_PRODUCT_DOCS_URL, "https://github.com/ag-jin/ZPaPa#readme");
});

test("问题上报：菜单动作直接外开新建 issue，不再打开内置反馈弹窗", () => {
  const { opened, platform } = createFakePlatform();
  const actions = createHelpMenuActionHandlers({ platform, intl });
  void actions.openIssueReport();
  assert.deepEqual(opened, [ZPAPA_ISSUE_NEW_URL]);
  assert.equal(ZPAPA_ISSUE_NEW_URL, "https://github.com/ag-jin/ZPaPa/issues/new");
});

test("提需求：菜单动作直接外开新建 issue", () => {
  const { opened, platform } = createFakePlatform();
  const actions = createHelpMenuActionHandlers({ platform, intl });
  actions.openFeatureRequest();
  assert.deepEqual(opened, [ZPAPA_ISSUE_NEW_URL]);
});
