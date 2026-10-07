import assert from "node:assert/strict";
import test from "node:test";
import type { IFileService } from "../src/file/file.js";
import {
  buildManifestDigest,
  scanWikiWorkspace,
  workspaceDisplayName,
} from "../src/wiki/wikiScan.js";
import {
  buildCatalogPrompt,
  buildPagePrompt,
  extractJsonPayload,
  normalizeCatalogPlan,
  normalizePageMarkdown,
  resolveWikiModelSelection,
  validateCatalogPlan,
} from "../src/wiki/wikiPlan.js";

/** 用一个内存文件表假冒 IFileService：扫描只用到 readdir/stat/readTextFile。 */
function createFakeFileService(files: Record<string, string>): IFileService {
  // 真实 IFileService 的 path 是相对 workspace 根的；这里按同样的口径建目录集合，
  // 且不产出 "." / ".."（真实实现也不返回这两个）。
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }
  return {
    async readdir(params) {
      const dir = params.path === "." ? "" : params.path;
      const entries = new Map<string, "file" | "directory">();
      const allPaths = [...Object.keys(files), ...dirs];
      for (const candidate of allPaths) {
        const prefix = dir ? `${dir}/` : "";
        if (prefix && !candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest.length === 0) continue;
        const slash = rest.indexOf("/");
        if (slash < 0) {
          entries.set(rest, files[candidate] === undefined ? "directory" : "file");
        } else {
          entries.set(rest.slice(0, slash), "directory");
        }
      }
      return [...entries].map(([name, type]) => ({
        name,
        path: dir ? `${dir}/${name}` : name,
        type,
      }));
    },
    async stat(params) {
      const content = files[params.path];
      return {
        path: params.path,
        type: content === undefined ? "directory" : "file",
        size: content?.length ?? 0,
      };
    },
    async readTextFile(params) {
      const content = files[params.path];
      if (content === undefined) throw new Error("ENOENT");
      return {
        path: params.path,
        content,
        offset: 0,
        bytesRead: content.length,
        totalBytes: content.length,
        truncated: false,
        isBinary: false,
      };
    },
  } as unknown as IFileService;
}

const fixture = {
  "README.md": "# Demo\n\n一个演示项目。",
  "src/index.ts": "export const a = 1;",
  "src/util.ts": "export const b = 2;",
  "src/nested/deep.ts": "export const c = 3;",
  "package.json": "{}",
  "node_modules/junk/index.js": "should be skipped",
  "dist/bundle.js": "should be skipped",
};

test("扫描：统计语言与文件数，跳过 node_modules / dist", async () => {
  const scan = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  const paths = scan.files.map((file) => file.path);
  assert.ok(paths.includes("src/index.ts"));
  assert.ok(paths.includes("src/nested/deep.ts"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("package.json"));
  // 跳过目录不得进入清单
  assert.ok(!paths.some((path) => path.includes("node_modules")));
  assert.ok(!paths.some((path) => path.startsWith("dist/")));
  assert.equal(scan.fileCount, paths.length);
  assert.equal(
    scan.languageStats.ts,
    "export const a = 1;".length + "export const b = 2;".length + "export const c = 3;".length,
  );
});

test("扫描：产物目录 .wiki 被跳过，不会被算进 manifestHash", async () => {
  const withArtifacts = {
    ...fixture,
    ".wiki/wiki.json": '{"wikiId":"x"}',
    ".wiki/draft-pages/abc.json": '{"id":"page-1"}',
  };
  const scan = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(withArtifacts),
  });
  const paths = scan.files.map((file) => file.path);
  assert.ok(!paths.some((path) => path.startsWith(".wiki/")), `产物不应进清单：${paths.join(",")}`);

  // 关键：产物存在与否不改变 manifestHash，否则每次生成后都判定「项目变了」
  const baseline = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  assert.equal(scan.manifestHash, baseline.manifestHash);
});

test("扫描：项目自己的 wiki / docs 目录不被误跳过", async () => {
  // 按名匹配会连用户的真实目录一起跳过；按路径精确匹配才只跳产物目录。
  const withUserDirs = {
    ...fixture,
    "wiki/notes.md": "# 用户自己的 wiki 笔记",
    "docs/wiki/handbook.md": "# 用户自己放在 docs/wiki 下的文档",
    "docs/guide.md": "# 指南",
  };
  const scan = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(withUserDirs),
  });
  const paths = scan.files.map((file) => file.path);
  assert.ok(paths.includes("wiki/notes.md"), "用户的 wiki 目录不应被跳过");
  assert.ok(
    paths.includes("docs/wiki/handbook.md"),
    "用户的 docs/wiki 目录不应被跳过（产物目录是 .wiki）",
  );
  assert.ok(paths.includes("docs/guide.md"));
});

test("扫描：同内容不同路径产生不同 manifestHash，内容变化也改变 hash", async () => {
  const base = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  const changedContent = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService({ ...fixture, "src/util.ts": "export const b = 999;" }),
  });
  const addedFile = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService({ ...fixture, "src/new.ts": "x" }),
  });
  assert.notEqual(base.manifestHash, changedContent.manifestHash);
  assert.notEqual(base.manifestHash, addedFile.manifestHash);
  // 稳定：同样输入两次结果一致
  const again = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  assert.equal(base.manifestHash, again.manifestHash);
});

test("扫描：读出 README 作为项目上下文", async () => {
  const scan = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  assert.match(scan.readme ?? "", /一个演示项目/);
});

test("清单摘要按目录聚合且包含体量", async () => {
  const scan = await scanWikiWorkspace({
    workspacePath: "/tmp/demo",
    fileService: createFakeFileService(fixture),
  });
  const digest = buildManifestDigest(scan);
  assert.match(digest, /src\/ \(2 文件/);
  assert.match(digest, /index\.ts/);
});

test("workspaceDisplayName 取路径末段", () => {
  assert.equal(workspaceDisplayName("/Users/me/projects/demo"), "demo");
  assert.equal(workspaceDisplayName("/"), "/");
});

test("提取 JSON：容忍代码围栏与前后解释", () => {
  assert.deepEqual(extractJsonPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonPayload('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonPayload('这是结果：\n{"a":1}\n以上。'), { a: 1 });
  assert.equal(extractJsonPayload("完全不是 JSON"), null);
});

test("归一化目录：生成 id、区分分组与页面、清理非法路径", () => {
  const plan = normalizeCatalogPlan({
    catalogTree: [
      {
        title: "服务端",
        children: [
          {
            title: "入口",
            description: "启动流程",
            filePaths: ["server/index.js", "../escape.js", "/abs.js"],
          },
          { title: "存储", children: [{ title: "数据库", description: "d", filePaths: [] }] },
        ],
      },
    ],
  });
  assert.equal(plan.pages.length, 2);
  // id 由我们生成，不采信模型输入
  assert.match(plan.pages[0]!.id, /^page-\d+-[0-9a-f]{8}$/);
  assert.match(plan.catalogTree[0]!.id, /^node-\d+-[0-9a-f]{8}$/);
  // 穿越性路径被剔除
  assert.deepEqual(plan.pages[0]!.filePaths, ["server/index.js"]);
  // 页面正文初始为占位（null），等待第二跳填充
  assert.equal(plan.pages[0]!.markdown, null);
  assert.ok(validateCatalogPlan(plan).ok);
});

test("归一化目录：顶层单分组会被展平", () => {
  const plan = normalizeCatalogPlan({
    catalogTree: [
      { title: "唯一分组", children: [{ title: "A", description: "a", filePaths: [] }] },
    ],
  });
  assert.equal(plan.catalogTree.length, 1);
  assert.equal(plan.catalogTree[0]!.title, "A");
  assert.ok(plan.catalogTree[0]!.pageId);
});

test("校验目录：空产出与超限被拒", () => {
  assert.equal(validateCatalogPlan({ catalogTree: [], pages: [] }).ok, false);
  const big = {
    catalogTree: [],
    pages: Array.from({ length: 200 }, (_, index) => ({
      id: `page-${index}`,
      parentId: "",
      title: `t${index}`,
      order: index,
      description: "",
      filePaths: [],
      markdown: null,
    })),
  };
  assert.equal(validateCatalogPlan(big).ok, false);
});

test("正文清理：剥掉整篇围栏与开场白", () => {
  assert.equal(normalizePageMarkdown("```markdown\n# 标题\n\n正文\n```"), "# 标题\n\n正文");
  assert.equal(normalizePageMarkdown("好的，以下是这一页：\n\n# 标题\n\n正文"), "# 标题\n\n正文");
  assert.equal(normalizePageMarkdown("   "), "");
});

test("提示词：图表开关控制 mermaid 指令", () => {
  const base = {
    projectName: "demo",
    language: "zh-CN",
    readme: undefined,
    manifestDigest: "src/ (1 文件)",
  };
  const withDiagrams = buildCatalogPrompt({ ...base, generateDiagrams: true });
  const withoutDiagrams = buildCatalogPrompt({ ...base, generateDiagrams: false });
  assert.match(withDiagrams, /mermaid/);
  assert.match(withoutDiagrams, /不要输出 mermaid/);

  const page = buildPagePrompt({
    ...base,
    generateDiagrams: true,
    pageTitle: "入口",
    pageDescription: "启动",
    filePaths: ["src/index.ts"],
    siblingTitles: ["存储"],
  });
  assert.match(page, /入口/);
  assert.match(page, /src\/index\.ts/);
  assert.match(page, /存储/);
});

test("提示词：英文语言要求写入英文", () => {
  const prompt = buildCatalogPrompt({
    projectName: "demo",
    language: "en-US",
    generateDiagrams: false,
    readme: undefined,
    manifestDigest: "x",
  });
  assert.match(prompt, /English/);
});

test("模型选择：显式选择优先于 preferred，都缺则返回 null", () => {
  const requested = { providerId: "p1", modelId: "m1" };
  const preferred = { providerId: "p2", modelId: "m2" };
  assert.deepEqual(resolveWikiModelSelection({ requested, preferred }), requested);
  assert.deepEqual(resolveWikiModelSelection({ preferred }), preferred);
  assert.equal(resolveWikiModelSelection({}), null);
  // 半成品 selection 不被采信
  assert.deepEqual(
    resolveWikiModelSelection({ requested: { providerId: "", modelId: "" }, preferred }),
    preferred,
  );
});

test("推理档位独立于模型：只设档位也能挂到解析出的模型上", () => {
  // 用户可能只调档位、沿用默认模型 —— 这正是「选了默认模型就没法设档位」要修的问题
  const preferred = { providerId: "p", modelId: "m" };
  assert.deepEqual(resolveWikiModelSelection({ preferred, reasoningLevel: "max" }), {
    providerId: "p",
    modelId: "m",
    options: { reasoningLevel: "max" },
  });
  // 没有模型可挂时仍返回 null（不伪造模型）
  assert.equal(resolveWikiModelSelection({ reasoningLevel: "max" }), null);
});

test("推理档位：独立字段优先于模型自带的 options", () => {
  const requested = { providerId: "p1", modelId: "m1", options: { reasoningLevel: "low" } };
  assert.deepEqual(resolveWikiModelSelection({ requested, reasoningLevel: "high" }), {
    providerId: "p1",
    modelId: "m1",
    options: { reasoningLevel: "high" },
  });
  // 未独立设置时沿用模型自带的档位
  assert.deepEqual(resolveWikiModelSelection({ requested }), requested);
});

test("推理档位：空白字符串视为未设置，回落到模型自带档位", () => {
  const requested = { providerId: "p", modelId: "m", options: { reasoningLevel: "low" } };
  assert.deepEqual(resolveWikiModelSelection({ requested, reasoningLevel: "   " }), requested);
  // 模型也没带档位时，结果里不应出现空的 options
  const noOption = { providerId: "p", modelId: "m" };
  assert.deepEqual(
    resolveWikiModelSelection({ requested: noOption, reasoningLevel: "" }),
    noOption,
  );
});
