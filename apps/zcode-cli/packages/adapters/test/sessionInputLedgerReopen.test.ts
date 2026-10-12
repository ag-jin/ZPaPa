// session_input 账本的重开语义（spec 2026-10-08-subagent-orphan-reconcile §3.3，2026-10-12 裁决 1）。
//
// 为什么这组用例承重：父侧丢失唤醒的交付标记就是一行 `session_input`（确定性 id）。取消/重启会把
// 未消费的 admitted 收口为 `discarded`；若同 id 重投递不能把它重开为 admitted，唤醒会在「进程崩在
// drain 前」的场景静默丢失（红队 A1-3 的权威写缺口）。本用例直接在真实 sqlite adapter 上驱动
// `saveSessionInput` 的冲突分支：discarded 重开、promoted/cancelled/failed 不动。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const SESSION_ID = "sess_ledger_reopen_parent" as never;
const WAKE_INPUT_ID = "subagent-orphan-wake:sess_subagent_agent_ledger_0001";

function withStore<T>(run: (store: SqliteSessionStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-ledger-reopen-"));
  const store = new SqliteSessionStore({ dbPath: join(dir, "db.sqlite") });
  return createParentSession(store)
    .then(() => run(store))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

/** session_input.session_id 是外键：先把会话行落库（与生产同一条 createSession 路径）。 */
async function createParentSession(store: SqliteSessionStore): Promise<void> {
  await store.createSession({
    id: SESSION_ID,
    projectID: "proj_ledger_reopen" as never,
    slug: "ledger-reopen",
    directory: "/tmp/ledger-reopen",
    title: "ledger reopen",
    version: "0.0.0-test",
  });
}

async function admitWake(store: SqliteSessionStore): Promise<void> {
  await store.saveSessionInput({
    id: WAKE_INPUT_ID,
    sessionID: SESSION_ID,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: { text: "<task-notification>lost</task-notification>" },
  });
}

async function statusOf(store: SqliteSessionStore): Promise<string | undefined> {
  const record = await store.getSessionInputById(WAKE_INPUT_ID);
  return record?.status;
}

test("账本重开：discarded(session_resumed) 行被同 id 重投递重开为 admitted 并清原因", async () => {
  await withStore(async (store) => {
    await admitWake(store);
    assert.equal(await statusOf(store), "admitted");

    await store.settleSessionInput({
      id: WAKE_INPUT_ID,
      sessionID: SESSION_ID,
      status: "discarded",
      reason: "session_resumed",
    });
    assert.equal(await statusOf(store), "discarded");

    // 重启后的重投递（同一确定性 id）。
    await admitWake(store);

    const reopened = await store.getSessionInputById(WAKE_INPUT_ID);
    assert.equal(reopened?.status, "admitted", "discarded 必须可重开（否则唤醒静默丢失）");
    assert.equal(reopened?.statusReason, undefined, "重开后不许残留上一次的收口原因");
  });
});

test("账本重开：promoted 行不被同 id 重投递改写（已交付标记是真实结论）", async () => {
  await withStore(async (store) => {
    await admitWake(store);
    await store.markSessionInputPromoted({
      id: WAKE_INPUT_ID,
      sessionID: SESSION_ID,
      promotedMessageID: "msg_wake_promoted" as never,
    });
    assert.equal(await statusOf(store), "promoted");

    await admitWake(store);

    assert.equal(await statusOf(store), "promoted", "promoted 不许被重开（否则每次激活都会重投）");
  });
});

test("账本重开：cancelled / failed 行不被同 id 重投递改写", async () => {
  await withStore(async (store) => {
    await admitWake(store);
    await store.settleSessionInput({
      id: WAKE_INPUT_ID,
      sessionID: SESSION_ID,
      status: "failed",
      reason: "runtime_unavailable",
    });
    assert.equal(await statusOf(store), "failed");

    await admitWake(store);

    assert.equal(await statusOf(store), "failed", "failed 是终局，重投递不许把它翻回 admitted");
  });
});
