/**
 * 「看板真实布局缝」浏览器断言的工具层（评审 #35-S1 二轮）——被
 * `boardKanbanBrowserLayout.ts` 使用，自身不含断言（断言在被测脚本里，便于一眼看清判据）。
 *
 * 与业务代码的关系：**只**做「把真组件打成 bundle + 编译真 Tailwind 产物 CSS + 起本地 HTTP +
 * 应用自己的引擎（Electron / Chromium）跑页面 + 把页面量取结果带回 Node」这套管道；
 * 页面里的量取脚本（driver）在真 DOM 上跑，本身不重算业务判据。
 *
 * 运行条件见 `boardKanbanBrowserLayout.ts` 头部（Electron 二进制 / @tailwindcss/node / esbuild）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { build as esbuild } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPaneView } from "../src/board/BoardPaneView.js";
import { parseBoardJson } from "../src/board/boardViewModel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(testDir, "..");
/** 宿主高度（面板给到 620px：列盒约 485，夹具列内容远超它）。 */
export const HOST_HEIGHT = 620;
export const STAGES = ["待设计", "待办", "执行中", "审核中", "阻塞", "已完成", "已取消"] as const;

/* ---------------- 量取结果的形状（页面 ↔ Node 的缝） ---------------- */

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  h: number;
  w: number;
}

export interface ColumnMeasure {
  stage: string;
  missing?: true;
  tag: string;
  display: string;
  ariaExpanded: string | null;
  headerTag: string | null;
  headerBox: Box | null;
  colBox: Box;
  bodyBox: Box | null;
  bodyClientH: number | null;
  bodyScrollH: number | null;
  bodyCanScroll: boolean | null;
  bodyScrolledTo: number | null;
  contentH: number | null;
  bodyOverflowsBox: boolean | null;
  cardCount: number;
}

export interface Snapshot {
  label: string;
  row: { box: Box; scrollH: number; clientH: number };
  columns: ColumnMeasure[];
}

export interface RevealMeasure {
  targetInDomWhileCollapsed: boolean;
  ariaExpanded: string | null;
  highlighted: boolean;
  cardBox: Box;
  bodyBox: Box;
  cardInsideBody: boolean;
  cardInViewport: boolean;
  bodyCanScroll: boolean;
}

export interface RunResult {
  reveal: RevealMeasure | null;
  toggleMissing: boolean;
  measurements: Snapshot[];
}

/* ---------------- 页面：真组件 bundle + 真 Tailwind 产物 CSS + 真排版量取 ---------------- */

const CLIENT_ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BoardPane } from "./src/board/BoardPane.js";
import { resolveBoardJsonPath } from "./src/board/loadBoardDocument.js";
import { ServiceProvider } from "./src/hooks/useServices.js";
import { ZCodeIntlProvider } from "./src/i18n/IntlProvider.js";
import { TabStoreProvider } from "./src/store/TabStoreProvider.js";

const WORKSPACE_PATH = "/fake/watch-workspace";
const boardPath = resolveBoardJsonPath(WORKSPACE_PATH);
const boardJson = globalThis.__BOARD_JSON__ ?? "";
const slice = {
  path: boardPath,
  content: boardJson,
  offset: 0,
  bytesRead: boardJson.length,
  totalBytes: boardJson.length,
  truncated: false,
  isBinary: false,
};
// 契约 §0/§1 的最小文件服务投影：只服务这一块板（真实 loader 照常判五态）。
const fileService = {
  checkFilesExist: async (params) => params.paths.map((p) => ({ path: p, exists: p === boardPath })),
  readTextFile: async () => slice,
};
createRoot(document.getElementById("host")).render(
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

export function buildPageHtml(params: { css: string; boardJson: string; bundle: string }): string {
  const boardJsonLiteral = JSON.stringify(params.boardJson).replaceAll("<", "\\u003c");
  const bundle = params.bundle.replaceAll("</script", "<\\/script");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>board-kanban-layout</title>
<style>${params.css}</style>
<style>html,body{margin:0;padding:0}</style>
</head><body>
<div id="host" style="height:${HOST_HEIGHT}px;display:flex;flex-direction:column;width:1400px;overflow:hidden"></div>
<script>globalThis.__BOARD_JSON__=${boardJsonLiteral};</script>
<script>${bundle}</script>
</body></html>`;
}

/* ---------------- 真 Tailwind 产物 CSS + 真组件 bundle ---------------- */

let cssCompiler: Awaited<ReturnType<typeof compile>> | null = null;

/** 用仓库真实 `src/styles.css` + 本页出现的全部类名（展开/折叠两态取并集）编译出真实产物 CSS。 */
export async function compileBoardPaneCss(params: { boards: string[] }): Promise<string> {
  const cssSource = readFileSync(path.join(UI_DIR, "src", "styles.css"), "utf8");
  cssCompiler = await compile(cssSource, {
    base: path.join(UI_DIR, "src"),
    onDependency: () => {},
  });
  const candidates = new Set<string>();
  for (const boardJson of params.boards) {
    const outcome = parseBoardJson(boardJson);
    if (outcome.kind !== "ready") continue;
    for (const expanded of [true, false]) {
      const markup = renderToStaticMarkup(
        createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN" as const,
          children: createElement(BoardPaneView, {
            state: { kind: "ready" as const, board: outcome.board },
            viewMode: "kanban" as const,
            kanbanCompletedExpanded: expanded,
          }),
        }),
      );
      for (const match of markup.matchAll(/class="([^"]*)"/g)) {
        for (const token of (match[1] ?? "").split(/\s+/)) if (token) candidates.add(token);
      }
    }
  }
  return cssCompiler.build([...candidates]);
}

export async function bundleBoardPaneClient(): Promise<string> {
  const build = await esbuild({
    stdin: { contents: CLIENT_ENTRY, resolveDir: UI_DIR, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    tsconfig: path.join(UI_DIR, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const output = build.outputFiles?.[0]?.text;
  if (!output) throw new Error("esbuild 应产出 bundle");
  return output;
}

/* ---------------- Electron（应用自己的引擎） ---------------- */

/** 沿 test 目录上溯找 `node_modules/electron`（worktree 未装产物时能命主仓那份）。 */
export function resolveElectronBinary(): string {
  const explicit = process.env.ZCODE_ELECTRON_BINARY?.trim();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  let dir = UI_DIR;
  for (;;) {
    const packageDir = path.join(dir, "node_modules", "electron");
    if (existsSync(path.join(packageDir, "package.json"))) {
      // path.txt（安装产物）给的是 dist 内的相对路径；没装成的包没有该文件 → 按平台默认。
      const pathFile = path.join(packageDir, "path.txt");
      const relative = existsSync(pathFile)
        ? readFileSync(pathFile, "utf8").trim()
        : process.platform === "darwin"
          ? "Electron.app/Contents/MacOS/Electron"
          : process.platform === "win32"
            ? "electron.exe"
            : "electron";
      candidates.push(path.join(packageDir, "dist", relative));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `找不到 Electron 二进制（试过：\n${candidates.join("\n")}\n）；用 ZCODE_ELECTRON_BINARY 显式指定`,
    );
  }
  return found;
}

/** 起本地 HTTP（file:// 下 module/CORS 限制多，本地服务最省事）→ 真引擎跑驱动 → 收量取结果。 */
export async function runBoardPaneInElectron(params: {
  pageHtml: string;
  driver: string;
  label: string;
}): Promise<unknown> {
  const workDir = mkdtempSync(path.join(tmpdir(), "zcode-board-layout-"));
  const electronBinary = resolveElectronBinary();
  const mainScript = path.join(workDir, "electron-main.cjs");
  const driverPath = path.join(workDir, "driver.js");
  writeFileSync(mainScript, electronMainSource());
  writeFileSync(driverPath, params.driver);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(params.pageHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("HTTP 服务应已监听");
  }
  try {
    // 注意：不能用 spawnSync——它会冻住本进程的事件循环，本地 HTTP 服务就没法应答 Electron 的
    // 请求（loadURL 永远等不到），必须异步 spawn 让服务能在这个进程里跑。
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          electronBinary,
          [mainScript, `http://127.0.0.1:${address.port}/`, driverPath, params.label],
          { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } },
        );
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 120_000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      },
    );
    const pageLogs = (run.stdout ?? "")
      .split("\n")
      .filter((entry) => entry.startsWith("PAGE_"))
      .join("\n");
    if (pageLogs) console.log(pageLogs);
    if (run.status !== 0) {
      throw new Error(
        `Electron 进程应正常退出（${params.label}）：status=${run.status}\n${run.stdout}\n${run.stderr}`,
      );
    }
    const prefix = "BOARD_LAYOUT_RESULT ";
    const line = (run.stdout ?? "").split("\n").find((entry) => entry.startsWith(prefix));
    if (!line) {
      throw new Error(`Electron 应回传量取结果（${params.label}）：\n${run.stdout}\n${run.stderr}`);
    }
    const payload = JSON.parse(line.slice(prefix.length)) as { ua: string; result: unknown };
    console.log(`UA ${params.label}: ${payload.ua}`);
    return payload.result;
  } finally {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

function electronMainSource(): string {
  return (
    `const { app, BrowserWindow } = require("electron");\n` +
    `const fs = require("node:fs");\n` +
    `app.disableHardwareAcceleration();\n` +
    `const url = process.argv[2];\n` +
    `const driverPath = process.argv[3];\n` +
    `const label = process.argv[4] || "";\n` +
    `const log = (line) => process.stdout.write(line + "\\n");\n` +
    `app.whenReady().then(async () => {\n` +
    `  const win = new BrowserWindow({ show: false, width: 1600, height: 900 });\n` +
    `  win.webContents.on("did-fail-load", (_event, code, description, failedUrl) =>\n` +
    `    log("PAGE_FAIL_LOAD " + code + " " + description + " " + failedUrl),\n` +
    `  );\n` +
    // 页面侧进度与异常转到 stdout（Electron 41 的 console-message 走单事件对象，旧签名兼容）。
    `  win.webContents.on("console-message", (event, level, message) => {\n` +
    `    const text = event && event.message !== undefined ? event.message : message;\n` +
    `    log("PAGE_CONSOLE " + text);\n` +
    `  });\n` +
    `  await win.loadURL(url);\n` +
    `  const source = fs.readFileSync(driverPath, "utf8");\n` +
    `  const result = await win.webContents.executeJavaScript(source, true);\n` +
    `  const ua = await win.webContents.executeJavaScript("navigator.userAgent");\n` +
    `  log("BOARD_LAYOUT_RESULT " + JSON.stringify({ label, ua, result }));\n` +
    `  app.quit();\n` +
    `}).catch((error) => {\n` +
    // 失败也要把话说完：app.exit 会丢未 flush 的 stdout/stderr，所以打印后走正常退出。
    `  log("BOARD_LAYOUT_ERROR " + ((error && error.stack) || String(error)));\n` +
    `  process.exitCode = 1;\n` +
    `  app.quit();\n` +
    `});\n`
  );
}
