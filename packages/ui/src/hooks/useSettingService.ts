/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { buildAppRuntimePreferencesFromPatch } from "@/settings/appRuntimePreferences.js";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";

type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};

interface SettingsStore {
  snapshot: SettingsSnapshot;
  inflightRefresh: Promise<SettingsSnapshot> | null;
  /** 当前在途读起飞时的已完成写次数；用于判断在途读是否早于最近一次写。 */
  inflightStartWrites: number;
  /** 本 Service 实例上已完成的写次数（经 refreshSettingsAfterWrite 打点）。 */
  completedWrites: number;
  listeners: Set<(snapshot: SettingsSnapshot) => void>;
}

// SettingsPage 外层与模型配置页内层可能分别绑定 Local/Remote Service；
// 共享一份 snapshot/inflight 会让一次 Environment 的刷新结果覆盖另一份事实源。
// 按 Service 实例隔离 store，保持同一 Environment 内的组件共享，同时阻断跨 Environment 串写。
const stores = new WeakMap<object, SettingsStore>();
const unavailableSettingsStore: SettingsStore = {
  snapshot: {
    settings: null,
    loading: true,
    error: null,
  },
  inflightRefresh: null,
  inflightStartWrites: 0,
  completedWrites: 0,
  listeners: new Set(),
};

function getSettingsStore(settingService: ISettingService | undefined): SettingsStore {
  if (
    !settingService ||
    (typeof settingService !== "object" && typeof settingService !== "function")
  ) {
    return unavailableSettingsStore;
  }
  const existing = stores.get(settingService);
  if (existing) {
    return existing;
  }
  const created: SettingsStore = {
    snapshot: {
      settings: null,
      loading: true,
      error: null,
    },
    inflightRefresh: null,
    inflightStartWrites: 0,
    completedWrites: 0,
    listeners: new Set(),
  };
  stores.set(settingService, created);
  return created;
}

function emitSettingsSnapshot(store: SettingsStore) {
  for (const listener of store.listeners) {
    listener(store.snapshot);
  }
}

export async function refreshSettingsStore(
  settingService: ISettingService | undefined,
): Promise<SettingsSnapshot> {
  const store = getSettingsStore(settingService);
  if (!settingService) {
    return store.snapshot;
  }
  while (store.inflightRefresh && store.inflightStartWrites !== store.completedWrites) {
    // #177 次级竞态：在途读起飞于最近一次写之前时，它的快照可能停在写前值。
    // 写后刷新必须等它收口再重读；收口后再判一次，避免等待期间又完成了新写。
    await store.inflightRefresh;
  }
  if (store.inflightRefresh) {
    return store.inflightRefresh;
  }

  store.snapshot = {
    ...store.snapshot,
    loading: true,
    error: null,
  };
  emitSettingsSnapshot(store);

  const startWrites = store.completedWrites;
  const request = (async (): Promise<SettingsSnapshot> => {
    try {
      const result = await settingService.get();
      store.snapshot = {
        settings: result,
        loading: false,
        error: null,
      };
    } catch (error) {
      store.snapshot = {
        // 设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
        settings: store.snapshot.settings,
        loading: false,
        error,
      };
    }
    emitSettingsSnapshot(store);
    return store.snapshot;
  })();
  const tracked = request.finally(() => {
    if (store.inflightRefresh === tracked) {
      store.inflightRefresh = null;
    }
  });
  store.inflightRefresh = tracked;
  store.inflightStartWrites = startWrites;

  return tracked;
}

/**
 * 写成功后的刷新入口（#177）。
 *
 * 先给该 Service 的 store 记一次「已完成写」，再走常规刷新：常规刷新只在
 * 「在途读不早于最近一次写」时复用 in-flight；写前起飞的读会被等收口后重读。
 * 否则写成功后复用了写前的读快照，界面表现为设置弹回。
 */
export async function refreshSettingsAfterWrite(
  settingService: ISettingService,
): Promise<SettingsSnapshot> {
  const store = getSettingsStore(settingService);
  store.completedWrites += 1;
  return refreshSettingsStore(settingService);
}

/** 获取和更新应用设置 */
export function useSettings() {
  const { botsService, broadcastService, settingService, zcodeAgentService } = useServices();
  const platform = usePlatform();
  const settingsStore = getSettingsStore(settingService);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(settingsStore.snapshot);

  const refresh = useCallback(async () => {
    await refreshSettingsStore(settingService);
  }, [settingService]);

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    settingsStore.listeners.add(listener);
    setSnapshot(settingsStore.snapshot);
    void refresh();

    return () => {
      settingsStore.listeners.delete(listener);
    };
  }, [refresh, settingsStore]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        void refresh();
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      await settingService.update(patch);
      platform.syncAppSettings?.(patch);
      // #177：写成功必须走写后刷新入口。普通 refresh 会被写前起飞的 in-flight 去重吞掉，
      // 返回写前快照——设置页据此渲染会导致开关弹回。
      await refreshSettingsAfterWrite(settingService);
      if (
        typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
        typeof patch.experimentalAskMattFlowEnabled === "boolean" ||
        typeof patch.modelIoFullRetentionEnabled === "boolean"
      ) {
        // 载荷单点在 settings/appRuntimePreferences.ts：这里只给 patch + 当前快照。
        // 曾就地拼 askUser/modelIo 两字段，改任一偏好都会把未携带的 ask-matt 归一化成
        // false 下发（UI 开关看着开、Host 命令面被误关）；广播载荷同源复用，其他窗口不丢字段。
        const preferences = buildAppRuntimePreferencesFromPatch(
          patch,
          settingsStore.snapshot.settings,
        );
        const syncResults = await Promise.allSettled([
          zcodeAgentService.syncAppRuntimePreferences(preferences),
          botsService.syncAppRuntimePreferences(preferences),
        ]);
        const syncError = syncResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        await broadcastService.send({
          channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
          payload: preferences,
        });
        if (syncError) {
          throw syncError;
        }
      }
    },
    [botsService, broadcastService, settingService, settingsStore, zcodeAgentService, platform],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
