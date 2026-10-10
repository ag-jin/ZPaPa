#!/usr/bin/env node
/**
 * zcode-board / T6 夹具工具（assets/test/fixtures/build-fixture.mjs）
 *
 * 职责：
 *   1. 在**系统临时目录**构造隔离的最小项目（绝不触碰真实工作区）；
 *   2. 提供源码快照 / 差异工具，供断言脚本做"检查点 3：默认模式源零写入"断言；
 *   3. 暴露两份真实 plan 样例的**副本**路径（fixtures/samples/，sha256 与真实文件一致）。
 *
 * 无第三方依赖：仅 node 内置模块。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** assets/（compile-board.mjs、lib/、test/、tools/ 的父目录） */
export const ASSETS_DIR = resolve(TEST_DIR, "..", "..");
export const SAMPLES_DIR = join(TEST_DIR, "samples");
export const COMPILER = join(ASSETS_DIR, "compile-board.mjs");

/** 编译器允许写入（且仅允许写入）的产物相对路径。 */
export const ALLOWED_OUTPUTS = [".zcode/board/board.json", ".zcode/board/board.md"];

export const SAMPLE_PLAN_E5545AAC = "plan-sess_e5545aac-beff-45c6-9654-46569478d90a.md";
export const SAMPLE_PLAN_F1A2D0BB = "plan-sess_f1a2d0bb-5238-4077-84d2-dae1f5a8f841.md";

/** 读取真实 plan 样例的夹具副本文本。 */
export function sampleText(name) {
  return readFileSync(join(SAMPLES_DIR, name), "utf8");
}

export function toPosix(p) {
  return p.split(sep).join("/");
}

/** 夹具根目录（默认系统临时目录；可用 ZCODE_BOARD_T6_TMP 覆盖以便留证）。 */
export function fixtureBaseDir() {
  const base = process.env.ZCODE_BOARD_T6_TMP || join(tmpdir(), "zcode-board-t6");
  mkdirSync(base, { recursive: true });
  return base;
}

/** 新建一个唯一夹具根：<base>/<tag>-<随机>。 */
export function newRoot(tag) {
  return mkdtempSync(join(fixtureBaseDir(), `${tag}-`));
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 固定某文件 mtime（本地时间 ISO，无时区后缀），用于"时间戳取自 mtime 而非墙钟"的可判别断言。 */
export function setMtime(root, rel, localIso) {
  const t = new Date(localIso);
  utimesSync(join(root, rel), t, t);
}

/** 写文件（自动建目录），返回绝对路径。 */
export function w(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function exists(p) {
  return existsSync(p);
}

export function isFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 递归快照：rel 路径 -> {sha256, size, mtimeMs}。
 * rel 用 posix 分隔符，便于跨平台断言与留证。
 */
export function treeSnapshot(root) {
  const map = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = toPosix(relative(root, abs));
      map.set(rel, {
        sha256: sha256(readFileSync(abs)),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  if (isDir(root)) walk(root);
  return map;
}

/**
 * 对比两次快照：返回 changed（字节或 mtime 变化）/ removed / added。
 * allowedNew：允许新增的相对路径集合（编译器产物）。
 */
export function diffSnapshot(before, after, allowedNew = []) {
  const allowed = new Set(allowedNew);
  const changed = [];
  const removed = [];
  const added = [];
  for (const [rel, b] of before) {
    const a = after.get(rel);
    if (!a) {
      removed.push(rel);
      continue;
    }
    if (a.sha256 !== b.sha256 || a.mtimeMs !== b.mtimeMs) {
      changed.push({ rel, before: b, after: a });
    }
  }
  for (const rel of after.keys()) {
    if (!before.has(rel) && !allowed.has(rel)) added.push(rel);
  }
  return { changed, removed, added };
}
