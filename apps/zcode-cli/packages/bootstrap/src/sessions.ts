import { createConfig } from "@zcode/adapters/config";
import { openStartupSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionInfo, SessionStorePort } from "@zcode/contracts";
import type { ListZCodeSessionsOptions, ResolveLatestSessionOptions } from "./app/types.js";
import { getSessionDbPath, isClosableSessionStore } from "./app/session-store.js";
import {
  buildRestartGapReconcileReport,
  type RestartGapReconcileReport,
} from "./zcode-protocol/restart-gap-reconcile-report.js";
export type { RestartGapReconcileReport };

export async function resolveLatestSession(
  options: ResolveLatestSessionOptions,
): Promise<SessionInfo | null> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    const sessions = await sessionStore.listSessions({
      directory: options.directory,
      limit: 1,
      roots: true,
    });
    return sessions[0] ?? null;
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}

export async function listZCodeSessions(
  options: ListZCodeSessionsOptions = {},
): Promise<SessionInfo[]> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    return await sessionStore.listSessions({
      directory: options.directory,
      limit: options.limit ?? 50,
      roots: true,
    });
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}

/**
 * 重启缺口的只读对账（spec 2026-10-08-subagent-orphan-reconcile 裁决 4 = 4C）。
 *
 * 与 `listZCodeSessions` 同一模式：自开自关 store；调用方传 `sessionStore` 时不自持生命周期。
 * 只读，不写任何状态；判据全部是 durable 事实（账本状态分布 / resume 收口残留 / 有终态无通知）。
 */
export async function readRestartGapReconcileReport(
  options: {
    env?: NodeJS.ProcessEnv;
    sessionStore?: SessionStorePort;
  } = {},
): Promise<RestartGapReconcileReport> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }
  try {
    return await buildRestartGapReconcileReport(sessionStore);
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}
