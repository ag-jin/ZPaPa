/**
 * 一次性验证：用真实产物样本验证读取链路。
 *
 * 用户手上的两份样本存在 /Users/linguojin/Downloads/WIKI/，其目录名是
 * workspace 路径的 sha256 前 12 位。这里把样本按新布局（<workspace>/.wiki/）
 * 复制到临时目录，验证 wikiStore + 渲染树能把它们正确读出来。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WIKI_DIR_RELATIVE_PATH,
  readBestWiki,
  readDraftPages,
  readWikiDocument,
  readWikiTaskState,
} from "../src/wiki/wikiStore.js";
import { buildWikiRenderTree, countWikiPageNodes } from "../src/wiki/wikiTypes.js";
import { listWikisForWorkspace } from "../src/wiki/wikiRead.js";

const SAMPLES_ROOT = "/Users/linguojin/Downloads/WIKI";

/** 把某个样本目录搬进 <tmp>/.wiki/，模拟正式产物布局。 */
async function stageSample(
  sampleDir: string,
): Promise<{ workspace: string; cleanup: () => Promise<void> }> {
  const workspace = await mkdtemp(join(tmpdir(), "wiki-sample-"));
  const target = join(workspace, WIKI_DIR_RELATIVE_PATH);
  await mkdir(target, { recursive: true });
  for (const name of await readdir(sampleDir)) {
    await cp(join(sampleDir, name), join(target, name), { recursive: true });
  }
  return { workspace, cleanup: async () => rm(workspace, { recursive: true, force: true }) };
}

const samples = await readdir(SAMPLES_ROOT).catch(() => []);
const hasSamples = samples.filter((name) => !name.startsWith(".")).length >= 2;

test("真实样本：老化产物（14 页规划 / 10 页成功 / 4 页失败）", { skip: !hasSamples }, async () => {
  // 385551730d64 = sha256("/Volumes/数据盘/网站/agent军团")[:12]
  const { workspace, cleanup } = await stageSample(join(SAMPLES_ROOT, "385551730d64"));
  try {
    const doc = await readWikiDocument(workspace);
    assert.ok(doc, "应能读出 wiki.json");
    assert.equal(doc.language, "zh-CN");
    // 旧版 schema：只有 generationModel，没有 modelSelection
    assert.equal(doc.modelSelection, undefined);
    assert.equal(doc.generationModel?.modelName, "GLM-5.3-Flash");
    assert.equal(doc.generationOptions?.maxOutputTokens, 16384);

    // 规划 14 页，实际只有 10 页正文
    assert.equal(countWikiPageNodes(doc.catalogTree), 14);
    assert.equal(doc.pages.length, 10);

    const task = await readWikiTaskState(workspace);
    assert.ok(task);
    assert.equal(task.totalPages, 14);
    assert.equal(task.completedPages, 10);
    assert.equal(task.failedPages, 4);

    // 渲染树必须保留那 4 个没有正文的节点（否则用户看不出哪些页失败了）
    const tree = buildWikiRenderTree(doc.catalogTree, doc.pages);
    let total = 0;
    let missing = 0;
    const walk = (nodes: typeof tree) => {
      for (const node of nodes) {
        if (node.page !== null || node.children.length === 0) total += 1;
        if (node.page && !node.page.markdown) missing += 1;
        walk(node.children);
      }
    };
    walk(tree);
    assert.ok(total >= 14, `目录树节点数应覆盖全部规划页，实际 ${total}`);

    // draft.json 应含全部 14 条（含占位页）与 10 条已完成 id
    const best = await readBestWiki(workspace);
    assert.ok(best);
    const draftPages = await readDraftPages(workspace);
    assert.equal(draftPages.length, 10);
  } finally {
    await cleanup();
  }
});

test("真实样本：新版产物（52 页全部成功，含 mermaid 图）", { skip: !hasSamples }, async () => {
  // 7b050da874c6 = sha256("/Volumes/数据盘/网站/新赛马")[:12]
  const { workspace, cleanup } = await stageSample(join(SAMPLES_ROOT, "7b050da874c6"));
  try {
    const doc = await readWikiDocument(workspace);
    assert.ok(doc);
    // 新版 schema：有 modelSelection 与 reasoningLevel
    assert.equal(doc.modelSelection?.modelId, "GLM-5.3-Flash");
    assert.equal(doc.modelSelection?.options?.reasoningLevel, "max");
    assert.equal(doc.generationOptions?.maxOutputTokens, 65536);

    assert.equal(countWikiPageNodes(doc.catalogTree), 52);
    assert.equal(doc.pages.length, 52);

    const task = await readWikiTaskState(workspace);
    assert.ok(task);
    assert.equal(task.failedPages, 0);
    assert.equal(task.completedPages, 52);

    // 开启 generateDiagrams 的产物应含 mermaid 图
    const allMarkdown = doc.pages.map((page) => page.markdown ?? "").join("\n");
    assert.ok(allMarkdown.includes("```mermaid"), "应含 mermaid 图块");

    // 摘要：pageCount 只数有正文的页
    const summaries = await listWikisForWorkspace(workspace);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.pageCount, 52);
    assert.equal(summaries[0]?.catalogNodeCount, 52);
  } finally {
    await cleanup();
  }
});
