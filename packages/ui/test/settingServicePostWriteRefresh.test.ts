import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { refreshSettingsAfterWrite, refreshSettingsStore } from "../src/hooks/useSettingService.js";

/**
 * 卡 #177（63-1）次级竞态夹具：写成功后的 refresh 不得被 in-flight 去重吞掉。
 *
 * `useSettingService` 的 store 按 Service 实例共享，并对并发读去重（刷新去重本身是必要的：
 * 设置页多次挂载/广播事件会重复触发）。但「写前发起的读」在写成功后仍是 in-flight 时，
 * 复用它会返回写前快照——用户看到设置弹回（现场：实验开关拨动后回弹，见
 * `.zcode/board/evidence/debug-toggle/trace.md` C7）。
 *
 * 夹具以「第一次 get 在调用时捕获写前快照、延迟到写之后才返回」复现该时序：
 * 写后刷新必须等旧读收口并重新读一次，快照落到写后事实。
 */

const SETTINGS_HOOK_SOURCE = fileURLToPath(
  new URL("../src/hooks/useSettingService.ts", import.meta.url),
);

interface RacingSettingServiceHarness {
  readonly service: ISettingService;
  readonly getCalls: () => number;
  /** 让下一次（也是唯一一次）get 在调用时捕获快照并挂起，直到 release 返回的函数被调用。 */
  holdNextRead: () => () => void;
}

function createRacingSettingService(initial: Partial<AppSettings>): RacingSettingServiceHarness {
  let current = { ...initial } as AppSettings;
  let getCalls = 0;
  let readGate: Promise<void> | null = null;
  let releaseReadGate: (() => void) | null = null;

  const service = {
    async get(): Promise<AppSettings> {
      getCalls += 1;
      if (readGate) {
        // 读发生在写之前：这里捕获的是写前快照（真实链路里是 server 已读、响应在途）。
        const snapshotAtCall = { ...current };
        await readGate;
        readGate = null;
        releaseReadGate = null;
        return snapshotAtCall;
      }
      return { ...current };
    },
    async update(patch: Partial<AppSettings>): Promise<void> {
      current = { ...current, ...patch };
    },
  } as unknown as ISettingService;

  return {
    service,
    getCalls: () => getCalls,
    holdNextRead: () => {
      readGate = new Promise<void>((resolve) => {
        releaseReadGate = resolve;
      });
      return () => {
        releaseReadGate?.();
      };
    },
  };
}

test("写后刷新竞态：写前发起的读在飞行中时，写后刷新必须落到写后快照", async () => {
  const harness = createRacingSettingService({ memoryEnabled: false });
  const releaseRead = harness.holdNextRead();

  // 写前发起的读（挂起中，持有写前快照）
  const staleRead = refreshSettingsStore(harness.service);
  await harness.service.update({ memoryEnabled: true });

  // 写成功后触发刷新；去重若复用 staleRead，快照会停在 false
  const postWriteRefresh = refreshSettingsAfterWrite(harness.service);
  releaseRead();

  const snapshot = await postWriteRefresh;
  await staleRead;

  assert.equal(
    snapshot.settings?.memoryEnabled,
    true,
    "写后刷新必须拿到写后快照，而不是写前 in-flight 的旧值",
  );
  assert.equal(harness.getCalls(), 2, "写后刷新必须重新读一次，不能复用写前的读");
});

test("刷新去重不回归：无写发生时并发 refresh 仍只读一次", async () => {
  const harness = createRacingSettingService({ memoryEnabled: false });
  const releaseRead = harness.holdNextRead();

  const first = refreshSettingsStore(harness.service);
  const second = refreshSettingsStore(harness.service);
  releaseRead();

  await Promise.all([first, second]);
  assert.equal(harness.getCalls(), 1);
});

test("守卫｜update 写成功后走 refreshSettingsAfterWrite（普通 refresh 会被在途去重吞掉）", () => {
  const source = readFileSync(SETTINGS_HOOK_SOURCE, "utf8");
  assert.match(source, /await refreshSettingsAfterWrite\(settingService\);/);
});
