#!/usr/bin/env node
/**
 * 合并两个 macOS 架构产出的 `latest-mac.yml`，供 electron-updater 使用。
 *
 * ## 为什么需要
 *
 * electron-builder 给 mac 的更新清单命名时**不带架构后缀**
 * （`getUpdateInfoFileName` 里的 `getArchPrefixForUpdateFile` 只给 Linux 加后缀），
 * 所以 mac-arm64 与 mac-x64 两个 job 都产出 `latest-mac.yml`。
 * 而 CI 的这两个架构是在**不同 runner 上分跑**的（x64 必须用 macos-15-intel
 * 原生构建，见 desktop-release.yml 注释），各自上传同名文件 → 后上传者覆盖先上传者，
 * 最终 Release 上只剩一份清单、只指向一个架构的包，另一个架构永远收不到更新。
 *
 * electron-updater 的 `MacUpdater.doDownloadUpdate` 会读清单里的 `files[]`
 * 并**按 URL 里是否含 "arm64" 自行筛选**当前机器该用哪个包，
 * 因此正确做法是发布一份**同时含两个架构条目**的清单。
 *
 * ## 为什么不用 YAML 库
 *
 * 本脚本在 release job 里运行，而那个 job**没有 checkout、也不装依赖**
 * （发布步骤应尽可能不依赖网络与 lockfile）。因此这里按 electron-builder 的
 * `serializeToYaml` 实际产出格式做**严格解析**：只认已知字段，遇到任何未预期的
 * 结构就报错退出，而不是猜着解析 —— 格式一旦变化要失败得响亮，不能静默产出坏清单。
 *
 * ## 用法
 *
 *   node scripts/merge-mac-update-manifests.mjs <arm64.yml> <x64.yml> <输出路径>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [arm64Path, x64Path, outPath] = process.argv.slice(2);
if (!arm64Path || !x64Path || !outPath) {
  console.error(
    "用法: node scripts/merge-mac-update-manifests.mjs <arm64.yml> <x64.yml> <输出路径>",
  );
  process.exit(1);
}

function fail(message) {
  console.error(`[merge-mac-manifest] ${message}`);
  process.exit(1);
}

/**
 * 解析时去掉一层引号（electron-builder 给 releaseDate 加了单引号）。
 * 注意：仅在**解析**阶段去引号；输出阶段必须按字段还原引号（见 formatValue），
 * 否则 `releaseDate` 会被 YAML 解析成 Date 而不是 `string`（updateInfo.d.ts 声明为 string）。
 */
function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 输出阶段还原 electron-builder 的序列化形状。
 *
 * 为什么必须单列处理 releaseDate（2026-09-30 实测，对照 Release v3.16.1 的真实 latest.yml）：
 * electron-builder 走 js-yaml 的 `dump`，对 ISO 时间串会写成 `releaseDate: '2026-...Z'`
 * —— **单引号是必需的**。若输出成裸串，js-yaml 会按 YAML 1.1 时间戳解析成 Date 对象，
 * 与 `builder-util-runtime` 的 `UpdateInfo.releaseDate: string` 声明不符
 * （已用 js-yaml 实测：带引号 → String，不带 → Date）。
 * 其他字段都是普通标量，按原样输出即可。
 */
function formatValue(key, value) {
  return key === "releaseDate" ? `'${value}'` : value;
}

const KNOWN_TOP_LEVEL = new Set(["version", "files", "path", "sha512", "releaseDate"]);

/**
 * 解析 electron-builder 生成的更新清单。
 * 期望形态（字段顺序不敏感，缩进为固定两级）：
 *
 *   version: 1.2.3
 *   files:
 *     - url: X.zip
 *       sha512: ...
 *       size: 123
 *   path: X.zip
 *   sha512: ...
 *   releaseDate: '...'
 */
function parseManifest(raw, label) {
  const result = { version: null, files: [], scalars: {} };
  let currentFile = null;
  let inFiles = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const listItem = /^\s*-\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine);
    if (listItem) {
      if (!inFiles) fail(`${label}: 顶层出现列表项，不在 files: 之下: ${rawLine}`);
      currentFile = {};
      currentFile[listItem[1]] = unquote(listItem[2]);
      result.files.push(currentFile);
      continue;
    }

    const entry = /^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!entry) fail(`${label}: 无法解析的行: ${rawLine}`);
    const [, indent, key, value] = entry;

    // 只接受两种精确缩进：0 = 顶层字段，>=2 且为偶数 = files 列表项字段。
    // 不接受任意缩进，避免把「缩进写错的行」误当成合法续行而静默产出坏清单。
    if (indent.length % 2 !== 0) {
      fail(`${label}: 缩进不是 2 的倍数，无法确定字段归属: ${rawLine}`);
    }
    if (indent.length > 0) {
      if (!currentFile) fail(`${label}: 缩进字段出现在列表项之外: ${rawLine}`);
      currentFile[key] = unquote(value);
      continue;
    }

    currentFile = null;
    inFiles = false;
    if (!KNOWN_TOP_LEVEL.has(key)) {
      fail(`${label}: 出现未预期的顶层字段 "${key}"，请检查 electron-builder 输出格式是否变化`);
    }
    if (key === "files") {
      inFiles = true;
      continue;
    }
    if (key === "version") {
      result.version = unquote(value);
      continue;
    }
    result.scalars[key] = unquote(value);
  }

  if (!result.version) fail(`${label}: 缺少 version 字段`);
  if (result.files.length === 0) fail(`${label}: files 为空`);
  for (const file of result.files) {
    if (!file.url) fail(`${label}: files 条目缺少 url: ${JSON.stringify(file)}`);
  }
  return result;
}

function readManifest(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`读取 ${label} 清单失败 (${path}): ${error.message}`);
  }
  return parseManifest(raw, label);
}

const arm64 = readManifest(arm64Path, "arm64");
const x64 = readManifest(x64Path, "x64");

if (arm64.version !== x64.version) {
  fail(
    `两个架构的版本不一致（arm64=${arm64.version} x64=${x64.version}）。` +
      `同一份 mac 更新清单只能描述同一个版本；请确认两个 job 构建的是同一 tag。`,
  );
}

// 按 url 去重合并；arm64 在前，让只读向后兼容字段的旧版 updater 优先看到 Apple Silicon 条目。
const mergedFiles = [];
const seenUrls = new Set();
for (const files of [arm64.files, x64.files]) {
  for (const file of files) {
    if (seenUrls.has(file.url)) continue;
    seenUrls.add(file.url);
    mergedFiles.push(file);
  }
}

const lines = [`version: ${arm64.version}`, "files:"];
for (const file of mergedFiles) {
  // 与 electron-builder 的输出形状保持一致：url 起头，其余字段缩进两格。
  lines.push(`  - url: ${file.url}`);
  for (const key of Object.keys(file)) {
    if (key === "url") continue;
    lines.push(`    ${key}: ${formatValue(key, file[key])}`);
  }
}
// 向后兼容字段（electron-updater 1.x / <2.15）：指向 arm64 的包，与 files[0] 一致。
for (const key of ["path", "sha512", "releaseDate"]) {
  if (arm64.scalars[key] !== undefined)
    lines.push(`${key}: ${formatValue(key, arm64.scalars[key])}`);
}

writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(
  `[merge-mac-manifest] 合并完成 version=${arm64.version} files=${mergedFiles.length} → ${outPath}`,
);
for (const file of mergedFiles) {
  console.log(`[merge-mac-manifest]   - ${file.url}`);
}
