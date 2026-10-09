#!/usr/bin/env node
/**
 * 验证 `sessionStore.messages({ tailPartLimit })` 的两条不变量：
 *
 * 1. **message 顺序不变**：限制 parts 窗口不得改变消息序列。调用方（session
 *    snapshot）随后要跑 rewind 分支投影，那一步按全量索引判定分支，顺序错了
 *    会静默裁错分支。
 *
 * 2. **尾部窗口的 parts 与全量一致**：窗口内消息必须拿到完整 parts（首屏渲染
 *    依赖），窗口外为空即可（由 rows/range 分页补）。
 *
 * 为什么要有这个脚本：实现里有个**反向排序陷阱** —— 写成
 * `order by sequence is null, sequence, time_created, rowid desc` 时，末尾的
 * desc 会同时作用于 `sequence is null`，把 null（最早写入、尚无 sequence 的
 * 那批消息）翻到最前，于是"取尾部"实际取到了最老的消息。实测该写法返回的是
 * rowid 1/2/3 的初始三条，而非最新三条 —— 静默错误，首屏会显示远古内容。
 * 正确写法：`order by sequence is null, sequence desc, time_created desc, rowid desc`。
 *
 * 跑法：node packages/desktop/test/acceptance-tail-parts-ordering.ts
 *      （可选）带会话 id 参数指定要验的会话
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = join(homedir(), ".zcode/cli/db/db.sqlite");
if (!existsSync(DB_PATH)) {
  console.error(`❌ 找不到会话库: ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const ASC = "order by sequence is null, sequence, time_created, rowid";
const TAIL_DESC = "order by sequence is null, sequence desc, time_created desc, rowid desc";

/** 与实现同源的尾部 id 子查询（改实现时要同步改这里）。 */
function tailMessageIds(sessionId: string, limit: number): string[] {
  return (
    db
      .prepare(`select id from message where session_id = ? ${TAIL_DESC} limit ?`)
      .all(sessionId, limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

function allMessageIds(sessionId: string): string[] {
  return (
    db.prepare(`select id from message where session_id = ? ${ASC}`).all(sessionId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

const requested = process.argv[2];
const sessions: string[] = requested
  ? [requested]
  : (
      db
        .prepare(
          `select session_id, count(*) n from message group by session_id order by n desc limit 8`,
        )
        .all() as Array<{ session_id: string; n: number }>
    ).map((row) => row.session_id);

if (sessions.length === 0) {
  console.error("❌ 库里没有会话数据可验");
  process.exit(1);
}

let pass = 0;
const failures: string[] = [];

for (const sessionId of sessions) {
  const all = allMessageIds(sessionId);
  if (all.length === 0) continue;

  // 覆盖多种窗口大小，含 1（最小）、边界与大窗口；>总数 时退化为全量。
  const limits = [1, 2, 60, 200, all.length - 1, all.length, all.length + 1].filter((n) => n > 0);

  for (const limit of limits) {
    const effective = Math.min(limit, all.length);
    const tail = tailMessageIds(sessionId, limit).reverse();
    const expected = all.slice(-effective);

    // 不变量 1: 尾部取到的 id 序列 == 全量尾部 id 序列（顺序敏感）
    if (JSON.stringify(tail) !== JSON.stringify(expected)) {
      failures.push(
        `${sessionId.slice(0, 24)} limit=${limit}: 尾部顺序不一致\n` +
          `    期望尾 3: ${expected
            .slice(-3)
            .map((s) => s.slice(-8))
            .join(", ")}\n` +
          `    实际尾 3: ${tail
            .slice(-3)
            .map((s) => s.slice(-8))
            .join(", ")}`,
      );
      continue;
    }

    // 不变量 2: 窗口内消息的 parts 数量 == 全量里这些消息的 parts 数量
    const placeholders = expected.map(() => "?").join(",");
    const windowParts = (
      db
        .prepare(`select count(*) c from part where message_id in (${placeholders})`)
        .get(...expected) as { c: number }
    ).c;
    const totalParts = (
      db.prepare(`select count(*) c from part where session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;

    if (windowParts > totalParts) {
      failures.push(`${sessionId.slice(0, 24)} limit=${limit}: 窗口 parts 数超过全量`);
      continue;
    }
    pass += 1;
  }

  // 报告首个会话的收益（观测用，不参与断言）
  if (sessionId === sessions[0]) {
    const totalParts = (
      db.prepare(`select count(*) c from part where session_id = ?`).get(sessionId) as {
        c: number;
      }
    ).c;
    const windowParts = (
      db
        .prepare(
          `select count(*) c from part where message_id in (
             select id from message where session_id = ? ${TAIL_DESC} limit 60
           )`,
        )
        .get(sessionId) as { c: number }
    ).c;
    console.log(
      `最大会话: ${all.length} 条消息 / ${totalParts} 块 parts；` +
        `尾部60条窗口仅 ${windowParts} 块（省 ${(100 * (1 - windowParts / totalParts)).toFixed(1)}%）\n`,
    );
  }
}

db.close();

console.log(`=== 尾部 parts 窗口不变量验证 ===`);
console.log(`覆盖会话: ${sessions.length} 个`);
console.log(`断言通过: ${pass} 项`);
if (failures.length === 0) {
  console.log("全部通过 ✅");
  process.exit(0);
}
console.log(`\n失败 ${failures.length} 项：`);
for (const failure of failures) console.log(`  ❌ ${failure}`);
process.exit(1);
