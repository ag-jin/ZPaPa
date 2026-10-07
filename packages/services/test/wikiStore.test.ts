import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  countWikiPageNodes,
  buildWikiRenderTree,
  flattenWikiPageNodes,
  type WikiCatalogNode,
  type WikiPage,
} from "../src/wiki/wikiTypes.js";
import {
  WIKI_DIR_NAME,
  normalizeWikiDocument,
  readBestWiki,
  readDraftPages,
  readWikiDraft,
  readWikiTaskState,
  readWikiDocument,
  resolveWikiStorePaths,
  wikiPageFileName,
  writeDraftPage,
  writeWikiDocument,
} from "../src/wiki/wikiStore.js";

/**
 * 这两份常量是从真实产物抄下来的结构等价样本，覆盖两种 schema 版本与失败场景：
 * - legacy：旧版 schema（只有 generationModel，无 modelSelection），14 页规划 / 10 页成功
 * - modern：新版 schema（有 modelSelection），2 页规划 / 2 页成功
 */

const legacyCatalog: WikiCatalogNode[] = [
  {
    id: "node-1-root",
    title: "项目全景",
    order: 1,
    children: [
      { id: "node-2", title: "约定默认路径", order: 2, pageId: "page-1-aaaa1111" },
      { id: "node-3", title: "失败页示例", order: 3, pageId: "page-2-bbbb2222" },
    ],
  },
];

const modernCatalog: WikiCatalogNode[] = [
  { id: "node-10-root", title: "服务端核心", order: 1, pageId: "page-1-cccc3333" },
];

function makeLegacyWiki() {
  return {
    wikiId: "wiki-legacy",
    repoId: "/tmp/agent军团",
    workspaceKey: "/tmp/agent军团",
    workspacePath: "/tmp/agent军团",
    language: "zh-CN",
    generationModel: { providerId: "builtin:x", providerName: "X", modelName: "M" },
    generationOptions: { generateDiagrams: true, thoughtLevel: "max", maxOutputTokens: 16384 },
    manifestHash: "hash-legacy",
    context: {
      repoId: "/tmp/agent军团",
      workspaceKey: "/tmp/agent军团",
      name: "agent军团",
      rootPath: "/tmp/agent军团",
    },
    catalogTree: legacyCatalog,
    // 旧样本实测：totalPages=14 但 pages 只有 10 条 —— 失败页不在 pages 里
    pages: [
      {
        id: "page-1-aaaa1111",
        parentId: "node-2",
        title: "约定默认路径",
        order: 1,
        description: "paths.mjs 定义默认路径",
        filePaths: [".agents/skills/x/scripts/lib/paths.mjs"],
        markdown: "# 约定默认路径\n\n正文",
        sources: [{ path: ".agents/skills/x/scripts/lib/paths.mjs", startLine: 1 }],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    createdAt: 100,
    updatedAt: 200,
  };
}

function makeModernWiki() {
  return {
    wikiId: "wiki-modern",
    repoId: "/tmp/新赛马",
    workspaceKey: "/tmp/新赛马",
    workspacePath: "/tmp/新赛马",
    language: "zh-CN",
    modelSelection: {
      providerId: "account:x",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "max" },
    },
    generationOptions: { generateDiagrams: true, thoughtLevel: "max", maxOutputTokens: 65536 },
    manifestHash: "hash-modern",
    catalogTree: modernCatalog,
    pages: [
      {
        id: "page-1-cccc3333",
        parentId: "node-10-root",
        title: "数据库与存储",
        order: 1,
        description: "db.js 封装数据库访问",
        filePaths: ["server/lib/db.js"],
        markdown: "# 数据库与存储\n\n正文",
      },
    ],
    createdAt: 300,
    updatedAt: 400,
  };
}

test("归一化旧版产物：无 modelSelection 也能读出，保留 generationModel", () => {
  const doc = normalizeWikiDocument(makeLegacyWiki());
  assert.ok(doc);
  assert.equal(doc.wikiId, "wiki-legacy");
  assert.equal(doc.modelSelection, undefined);
  assert.equal(doc.generationModel?.modelName, "M");
  assert.equal(doc.generationOptions?.maxOutputTokens, 16384);
  assert.equal(doc.pages.length, 1);
});

test("归一化新版产物：保留 modelSelection 与 maxOutputTokens 65536", () => {
  const doc = normalizeWikiDocument(makeModernWiki());
  assert.ok(doc);
  assert.equal(doc.modelSelection?.modelId, "GLM-5.3-Flash");
  assert.equal(doc.modelSelection?.options?.reasoningLevel, "max");
  assert.equal(doc.generationOptions?.maxOutputTokens, 65536);
});

test("归一化拒绝非对象与缺 wikiId 的输入", () => {
  assert.equal(normalizeWikiDocument(null), null);
  assert.equal(normalizeWikiDocument("x"), null);
  assert.equal(normalizeWikiDocument({ catalogTree: [] }), null);
});

test("flattenWikiPageNodes 只收集带 pageId 的节点（= totalPages 语义）", () => {
  const flat = flattenWikiPageNodes(legacyCatalog);
  assert.equal(flat.length, 2);
  assert.deepEqual(
    flat.map((item) => item.pageId),
    ["page-1-aaaa1111", "page-2-bbbb2222"],
  );
  // 分组节点没有 pageId，不计入
  assert.equal(flattenWikiPageNodes([{ id: "n", title: "分组", order: 1 }]).length, 0);
});

test("countWikiPageNodes 统计规划页数（含尚未生成正文的页）", () => {
  // 规划 2 页、实际只有 1 页正文 —— totalPages 取 2，不是 1
  assert.equal(countWikiPageNodes(legacyCatalog), 2);
});

test("buildWikiRenderTree 以目录树为准，正文缺失的页不消失", () => {
  const doc = normalizeWikiDocument(makeLegacyWiki());
  assert.ok(doc);
  const tree = buildWikiRenderTree(doc.catalogTree, doc.pages);
  assert.equal(tree.length, 1);
  const root = tree[0]!;
  assert.equal(root.children.length, 2);
  // 第一页有正文
  assert.ok(root.children[0]!.page);
  assert.equal(root.children[0]!.page?.markdown, "# 约定默认路径\n\n正文");
  // 第二页正文缺失（生成失败），节点仍在树里，page 为 null
  assert.equal(root.children[1]!.page, null);
  assert.equal(root.children[1]!.title, "失败页示例");
});

test("buildWikiRenderTree 按 order 排序", () => {
  const nodes: WikiCatalogNode[] = [
    { id: "b", title: "B", order: 2 },
    { id: "a", title: "A", order: 1 },
  ];
  const tree = buildWikiRenderTree(nodes, []);
  assert.deepEqual(
    tree.map((n) => n.title),
    ["A", "B"],
  );
});

test("产物路径固定在 workspace 下的 wiki 目录", () => {
  const paths = resolveWikiStorePaths("/tmp/proj");
  assert.equal(paths.root, `/tmp/proj/${WIKI_DIR_NAME}`);
  assert.equal(paths.wikiFile, `/tmp/proj/${WIKI_DIR_NAME}/wiki.json`);
  assert.equal(paths.taskFile, `/tmp/proj/${WIKI_DIR_NAME}/task.json`);
  assert.equal(paths.draftFile, `/tmp/proj/${WIKI_DIR_NAME}/draft.json`);
  assert.equal(paths.draftPagesDir, `/tmp/proj/${WIKI_DIR_NAME}/draft-pages`);
});

test("单页文件名用 pageId 的 sha256 前 16 位", () => {
  // 与历史产物实测一致：page-1-80e1e11c -> 0b6e4e79cff99ec6
  assert.equal(wikiPageFileName("page-1-80e1e11c"), "0b6e4e79cff99ec6.json");
  assert.equal(wikiPageFileName("page-4-9a358327"), "030ebda9955928ce.json");
});

test("写读往返：正式产物", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-store-"));
  try {
    const doc = normalizeWikiDocument(makeModernWiki());
    assert.ok(doc);
    await writeWikiDocument(dir, doc);
    const read = await readWikiDocument(dir);
    assert.ok(read);
    assert.equal(read.wikiId, "wiki-modern");
    assert.equal(read.pages.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("写读往返：单页落盘到 draft-pages，文件名与 pageId 对应", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-page-"));
  try {
    const page: WikiPage = {
      id: "page-1-80e1e11c",
      parentId: "node-1",
      title: "约定默认路径与 workspace 发现",
      order: 1,
      description: "desc",
      filePaths: ["lib/paths.mjs"],
      markdown: "# 标题\n\n正文",
    };
    await writeDraftPage(dir, page);

    const raw = await readFile(
      join(dir, WIKI_DIR_NAME, "draft-pages", "0b6e4e79cff99ec6.json"),
      "utf8",
    );
    assert.match(raw, /page-1-80e1e11c/);

    const pages = await readDraftPages(dir);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.id, "page-1-80e1e11c");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未生成过时读取返回 null，不抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-empty-"));
  try {
    assert.equal(await readWikiDocument(dir), null);
    assert.equal(await readWikiDraft(dir), null);
    assert.equal(await readWikiTaskState(dir), null);
    assert.deepEqual(await readDraftPages(dir), []);
    assert.equal(await readBestWiki(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("草稿损坏时按「没有」处理，不影响其他读取", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-broken-"));
  try {
    const doc = normalizeWikiDocument(makeModernWiki());
    assert.ok(doc);
    await writeWikiDocument(dir, doc);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, WIKI_DIR_NAME, "draft.json"), "{ 不是 JSON", "utf8");

    assert.equal(await readWikiDraft(dir), null);
    // 正式产物仍可读
    const best = await readBestWiki(dir);
    assert.ok(best);
    assert.equal(best.fromDraft, false);
    assert.equal(best.document.wikiId, "wiki-modern");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBestWiki 在草稿更完整时优先草稿（生成中途场景）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-best-"));
  try {
    const { atomicWriteJson } = await import("../src/fs/atomicFileUtils.js");
    const paths = resolveWikiStorePaths(dir);
    // 正式产物只有 1 页
    const doc = normalizeWikiDocument(makeModernWiki());
    assert.ok(doc);
    await writeWikiDocument(dir, doc);
    // 草稿有 3 页（生成中途，wiki.json 尚未刷新）
    await atomicWriteJson(paths.draftFile, {
      ...makeModernWiki(),
      taskId: "task-1",
      generatedPageIds: ["page-1-cccc3333"],
      pages: [
        ...makeModernWiki().pages,
        {
          id: "page-2",
          parentId: "node-10-root",
          title: "第二页",
          order: 2,
          description: "d",
          filePaths: [],
          markdown: null,
        },
        {
          id: "page-3",
          parentId: "node-10-root",
          title: "第三页",
          order: 3,
          description: "d",
          filePaths: [],
          markdown: "# 三",
        },
      ],
    });

    const best = await readBestWiki(dir);
    assert.ok(best);
    assert.equal(best.fromDraft, true);
    assert.equal(best.document.pages.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
