import assert from "node:assert/strict";
import test from "node:test";
import {
  ZPAPA_COMMUNITY_URL,
  ZPAPA_ISSUE_NEW_URL,
  ZPAPA_PRODUCT_DOCS_URL,
} from "../src/helpLinks.js";

/**
 * 帮助菜单四个入口统一改指 ZPaPa GitHub 仓库。
 *
 * 期望值来自需求给定的目标 URL 表（不是按实现推导），字面量一旦漂移必须在这里红：
 * 产品文档 = 仓库 README、用户社群 = discussions、问题上报/提需求 = issues/new。
 */
test("帮助菜单外链收口指向 ZPaPa GitHub 仓库", () => {
  assert.equal(ZPAPA_PRODUCT_DOCS_URL, "https://github.com/ag-jin/ZPaPa#readme");
  assert.equal(ZPAPA_COMMUNITY_URL, "https://github.com/ag-jin/ZPaPa/discussions");
  assert.equal(ZPAPA_ISSUE_NEW_URL, "https://github.com/ag-jin/ZPaPa/issues/new");
});
