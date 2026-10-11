/**
 * 卡 #219/D6「索引 + 分片」读取路径的**浏览器行为断言**（真引擎 + 真 Tailwind 产物 CSS + 真 DOM +
 * 真事件）——独立脚本，文件名不含 `.test.`（与 `boardEmptyStatesBrowser.ts` 同款：`node --test`
 * 常规套件不收它）。
 *
 * 为什么必须真引擎：首屏读 INDEX（不读 board.json）、点卡按 `cardFile` 指针**按需读分片**、
 * 分片卡文进弹窗——这些都是「真宿主加载链 + 真事件」下的行为结果（SSR 结构断言不构成行为证据）。
 *
 * 验证域（卡文要求：迁移域夹具形态，勿动真实板）：由 zcode-board 编译器在**临时副本域**产出
 * （任务目录 `.zcode/<任务ID>/plans/` → `cards/<no>.md` 分片 + INDEX.json），真实板只读。
 * 域路径取 `ZCODE_BOARD_MIGRATED_DOMAIN`（缺省 `/tmp/zcb-d6-migrated`）；域不存在则报错退出，
 * 不静默跳过。域内 `board.json` 超 256 KiB 读限——正因如此才必须走 INDEX（本卡根除读限）。
 *
 * 命令（在 `packages/ui` 下，先按需构建域）：
 *   node --import tsx test/boardShardLoadingBrowser.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { build as esbuild } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { parseBoardIndex } from "../src/board/boardIndexViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { BOARD_BROWSER_DRIVER_PRELUDE } from "./boardBrowserProbeKit.js";
import {
  compileBoardPaneCss,
  runBoardPaneInElectron,
  UI_DIR,
} from "./boardKanbanBrowserLayoutHarness.js";

const HOST_HEIGHT = 620;

const DOMAIN = process.env.ZCODE_BOARD_MIGRATED_DOMAIN ?? "/tmp/zcb-d6-migrated";
const BOARD_DIR = join(DOMAIN, ".zcode/board");
const INDEX_PATH = join(BOARD_DIR, "INDEX.json");
const BOARD_PATH = join(BOARD_DIR, "board.json");

if (!existsSync(INDEX_PATH)) {
  throw new Error(
    `迁移域不存在（${INDEX_PATH}）：请先用 zcode-board 编译器构建（任务目录 plans → 分片 + INDEX），或设 ZCODE_BOARD_MIGRATED_DOMAIN`,
  );
}

/** 递归收集域内全部分片文件（`.../cards/<no>.md`）→ 绝对路径 → 文本。 */
function collectShardFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md") && dir.split(sep).includes("cards")) {
        out.set(full, readFileSync(full, "utf8"));
      }
    }
  };
  walk(join(root, ".zcode"));
  return out;
}

/** 从分片文本独立取卡文三字段（不借被测解析器，避免「同实现自证」）。 */
function extractCardText(shard: string): {
  goal: string | null;
  deliverables: string[];
  acceptance: string | null;
} {
  const lines = shard.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s*卡文\s*$/.test(line));
  if (start < 0) return { goal: null, deliverables: [], acceptance: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);
  let goal: string | null = null;
  let acceptance: string | null = null;
  const deliverables: string[] = [];
  let inDeliverables = false;
  for (const line of block) {
    const g = /^-\s*目标:\s*(.+)$/.exec(line);
    if (g) {
      goal = (g[1] ?? "").trim() || null;
      inDeliverables = false;
      continue;
    }
    const a = /^-\s*验收:\s*(.+)$/.exec(line);
    if (a) {
      acceptance = (a[1] ?? "").trim() || null;
      inDeliverables = false;
      continue;
    }
    if (/^-\s*交付面全量枚举:\s*$/.test(line)) {
      inDeliverables = true;
      continue;
    }
    if (inDeliverables) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (item) deliverables.push((item[1] ?? "").trim());
      else if (line.trim()) inDeliverables = false;
    }
  }
  return { goal, deliverables, acceptance };
}

/** 目标卡：INDEX 里首个有分片指针、且分片带非空「目标」的卡（弹窗卡文断言用）。 */
function pickTarget(
  indexJson: { features: unknown },
  shards: Map<string, string>,
): { no: number; cardFile: string; expected: ReturnType<typeof extractCardText> } {
  const tasks: Array<{ no: number; cardFile: string }> = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.no === "number" && typeof record.cardFile === "string") {
        tasks.push({ no: record.no, cardFile: record.cardFile });
      }
      walk(record.tasks);
    }
  };
  for (const feature of (indexJson.features as Array<{ tasks?: unknown }>) ?? []) {
    walk(feature.tasks);
  }
  for (const task of tasks) {
    const abs = join(DOMAIN, task.cardFile);
    const shard = shards.get(abs);
    if (!shard) continue;
    const expected = extractCardText(shard);
    if (
      expected.goal !== null &&
      expected.deliverables.length > 0 &&
      expected.acceptance !== null
    ) {
      return { no: task.no, cardFile: task.cardFile, expected };
    }
  }
  throw new Error("迁移域里找不到带完整卡文（目标/交付面/验收）的分片卡");
}

/* ---------------- 页面：真组件 bundle（宿主 + 假文件服务 + 读取计数） ---------------- */

function buildClientEntry(params: { files: Record<string, string>; workspace: string }): string {
  return `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BoardPane } from "./src/board/BoardPane.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";

const WORKSPACE_PATH = ${JSON.stringify(params.workspace)};
const FILES = globalThis.__FILES__;
globalThis.__READS__ = [];
const fileService = {
  checkFilesExist: async (params) => params.paths.map((path) => ({ path, exists: path in FILES })),
  readTextFile: async ({ path }) => {
    globalThis.__READS__.push(path);
    if (!(path in FILES)) {
      const error = new Error("ENOENT: no such file or directory, stat '" + path + "'");
      error.code = "ENOENT";
      throw error;
    }
    const content = FILES[path];
    return { path, content, offset: 0, bytesRead: content.length, totalBytes: content.length, truncated: false, isBinary: false };
  },
};
const host = document.getElementById("host");
createRoot(host).render(
  createElement(
    ServiceProvider,
    { services: { fileService } },
    createElement(
      TabStoreProvider,
      null,
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(BoardPane, { workspacePath: WORKSPACE_PATH, focused: true }),
      }),
    ),
  ),
);
`;
}

/** 页面内驱动：首屏读面 → 指引面五槽 → 列表视图 → 点卡弹窗卡文（按需读分片）。 */
function driverSource(params: { targetNo: number }): string {
  return `(async () => {
${BOARD_BROWSER_DRIVER_PRELUDE}
  const textOf = (el) => (el ? el.textContent.trim() : null);
  const reads = () => globalThis.__READS__.slice();
  await waitFor(() => document.querySelector("[data-board-pane]"), "面板渲染");
  await waitFor(() => globalThis.__READS__.length > 0, "首屏读取发生");
  const readsAfterLoad = reads();

  // 指引面（默认视图）：五槽值直取 screen 投影（薄索引面）。
  const slotValues = {};
  for (const slot of ["attention", "blocked", "running", "review", "recent"]) {
    const el = document.querySelector('[data-board-guide-slot="' + slot + '"]');
    slotValues[slot] = el ? el.getAttribute("data-board-guide-slot-value") : null;
  }
  const guidePlanCount = document.querySelectorAll("[data-board-guide-plan]").length;
  const guideQueueRows = document.querySelectorAll("[data-board-guide-queue-row]").length;

  // 列表视图：全卡平铺。
  await switchToView("list");
  const listCards = document.querySelectorAll('[data-board-view="list"] [data-board-card]').length;

  // 点卡 → 弹窗 → 卡文（按 cardFile 指针按需读分片）。
  const targetId = "task:" + String(${params.targetNo});
  const card = await waitFor(
    () => document.querySelector('[data-board-view="list"] [data-board-card="' + targetId + '"]'),
    "目标卡在场",
  );
  const readsBeforeOpen = reads().length;
  dispatchPointerClick(card);
  await waitFor(() => document.querySelector('[data-board-dialog="' + targetId + '"]'), "卡片弹窗打开");
  const dialog = document.querySelector('[data-board-dialog="' + targetId + '"]');
  const goalValue = await waitFor(() => {
    const el = dialog.querySelector('[data-board-dialog-card-text="goal"] [data-board-dialog-card-text-value]');
    return el ? el.textContent.trim() : null;
  }, "卡文目标（分片按需读）");
  const deliverables = Array.from(
    dialog.querySelectorAll('[data-board-dialog-card-text="deliverables"] [data-board-dialog-card-text-item]'),
  ).map((el) => el.textContent.trim());
  const acceptanceEl = dialog.querySelector(
    '[data-board-dialog-card-text="acceptance"] [data-board-dialog-card-text-value]',
  );
  const readsAfterOpen = reads();

  return {
    ua: navigator.userAgent,
    readsAfterLoad,
    readsBeforeOpen,
    readsAfterOpen,
    slotValues,
    guidePlanCount,
    guideQueueRows,
    listCards,
    dialogGoal: goalValue,
    deliverables,
    acceptanceText: textOf(acceptanceEl),
  };
})()`;
}

function buildPage(params: { css: string; bundle: string; files: Record<string, string> }): string {
  const filesLiteral = JSON.stringify(params.files).replaceAll("<", "\\u003c");
  const bundle = params.bundle.replaceAll("</script", "<\\/script");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-shard-loading</title>
<style>${params.css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="host" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1400px;overflow:hidden"></div>
<script>globalThis.__FILES__=${filesLiteral};</script>
<script>${bundle}</script>
</body></html>`;
}

interface ShardLoadingResult {
  ua: string;
  readsAfterLoad: string[];
  readsBeforeOpen: number;
  readsAfterOpen: string[];
  slotValues: Record<string, string | null>;
  guidePlanCount: number;
  guideQueueRows: number;
  listCards: number;
  dialogGoal: string | null;
  deliverables: string[];
  acceptanceText: string | null;
}

async function main(): Promise<void> {
  const indexText = readFileSync(INDEX_PATH, "utf8");
  const shards = collectShardFiles(DOMAIN);
  assert.ok(shards.size > 0, "迁移域应含分片（任务目录卡 → cards/<no>.md）");

  const indexOutcome = parseBoardIndex(indexText);
  assert.equal(indexOutcome.kind, "ready", "迁移域 INDEX 应是可消费的 v3 薄索引");
  if (indexOutcome.kind !== "ready") return;
  const board = indexOutcome.board;
  assert.ok(board.screen !== null, "薄索引面应带 screen 五槽计数");

  const indexJson = JSON.parse(indexText) as { features: unknown };
  const target = pickTarget(indexJson, shards);
  const targetShardPath = join(DOMAIN, target.cardFile);
  const boardBytes = statSync(BOARD_PATH).size;
  assert.ok(
    boardBytes > 256 * 1024,
    `夹具前提：迁移域 board.json 应超 256 KiB 读限（实测 ${boardBytes} B）——正因如此才必须走 INDEX`,
  );
  const indexBytes = Buffer.byteLength(indexText);
  assert.ok(indexBytes < 50 * 1024, `夹具前提：薄索引应恒小（<50KB 不变量；实测 ${indexBytes} B）`);
  assert.ok(indexBytes < boardBytes, "夹具前提：INDEX 应远小于 board.json（详情不在索引里）");

  // 文件面：INDEX + 全部分片；**不放 board.json**（证明首屏与点卡都不读旧面大文件）。
  const files: Record<string, string> = { [INDEX_PATH]: indexText };
  for (const [abs, content] of shards) files[abs] = content;

  // 产物 CSS：迁移域 board.json 文本供类名收集（SSR 渲染不读盘，超限与读取上限无关）+
  // 打开态弹窗（卡片正文区块的类名只在弹窗里）。
  const migratedBoardJson = readFileSync(BOARD_PATH, "utf8");
  const extraClassNames: string[] = [];
  const dialogMarkup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(BoardPaneView, {
        state: { kind: "ready" as const, board },
        viewMode: "list",
        openCardId: `task:${target.no}`,
      }),
    }),
  );
  for (const match of dialogMarkup.matchAll(/class="([^"]*)"/g)) {
    for (const token of (match[1] ?? "").split(/\s+/)) if (token) extraClassNames.push(token);
  }
  const css = await compileBoardPaneCss({
    boards: [migratedBoardJson],
    viewModes: ["guide", "list"],
    extraClassNames,
  });

  const bundle = await esbuild({
    stdin: {
      contents: buildClientEntry({ files, workspace: DOMAIN }),
      resolveDir: UI_DIR,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: join(UI_DIR, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const bundleText = bundle.outputFiles?.[0]?.text;
  if (!bundleText) throw new Error("esbuild 应产出 bundle");

  const result = (await runBoardPaneInElectron({
    pageHtml: buildPage({ css, bundle: bundleText, files }),
    driver: driverSource({ targetNo: target.no }),
    label: "shard-loading",
  })) as ShardLoadingResult;

  /* ---- ① 首屏读 INDEX（不读 board.json） ---- */
  assert.deepEqual(
    result.readsAfterLoad,
    [INDEX_PATH],
    "首屏只读 INDEX.json 一次（读限根除：不读超限的 board.json）",
  );

  /* ---- 指引面五槽 = screen 投影（薄索引面） ---- */
  assert.deepEqual(
    result.slotValues,
    {
      attention: String(board.screen?.attention),
      blocked: String(board.screen?.blocked),
      running: String(board.screen?.running),
      review: String(board.screen?.review),
      recent: String(board.screen?.recent),
    },
    "指引面五槽应直取 INDEX screen（不按卡字段自算）",
  );
  assert.ok(result.guidePlanCount > 0, "指引面应渲染计划区块");
  assert.ok(result.guideQueueRows > 0, "指引面应有可执行前沿队列行（frontier 投影）");

  /* ---- 列表视图全卡平铺 ---- */
  assert.ok(result.listCards > 0, "列表视图应渲染卡片");

  /* ---- ② 点卡按需读分片：读取面新增恰好该卡的分片 ---- */
  assert.equal(result.readsBeforeOpen, 1, "点卡前不应读任何分片（按需读，不预读全量）");
  assert.deepEqual(result.readsAfterOpen.slice(0, 1), [INDEX_PATH], "读取面首位仍是 INDEX");
  assert.deepEqual(
    result.readsAfterOpen.slice(1),
    [targetShardPath],
    `点卡 #${target.no} 应恰好按 cardFile 读该分片一次`,
  );

  /* ---- 弹窗卡文来自分片（目标/交付面/验收） ---- */
  assert.equal(result.dialogGoal, target.expected.goal, "弹窗目标应来自分片卡文");
  assert.deepEqual(result.deliverables, target.expected.deliverables, "弹窗交付面应来自分片卡文");
  assert.equal(result.acceptanceText, target.expected.acceptance, "弹窗验收应来自分片卡文");

  console.log(
    `[219] 索引+分片浏览器断言通过（UA ${result.ua}）：INDEX ${Buffer.byteLength(indexText)} B / board.json ${boardBytes} B（超限）/ 分片 ${shards.size} 件 / 点卡 #${target.no} 分片按需读`,
  );
}

await main();
