import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { UpdateUpToDateNotice } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  deriveUpdateChannelSettingsView,
  shouldExplainBlockedReturnToStable,
} from "../src/updateStatusModel.js";

/**
 * T3 ① 的证据（验收本体见 docs/superpowers/plans/2026-10-02-preview-update-channel.md 第四、五节）。
 *
 * 要拦的缺陷是「用户看不出自己在哪条通道」与「回不到正式版时界面上只显示『已是最新』」：
 *  - `updateStatusModel.updateChannel` 算了却没有消费点 ⇒ 用户无法判断预览/正式；
 *  - 「装了预览版 + 关掉开关 + 正式版号更低」这一格，若界面只说「已是最新」，
 *    用户会以为一切正常，实则回不到正式版（不允许降级、正式版还没追上来）。
 *
 * 说明：结论里的「事实」由 main 用 semver 算好（shared 的 UpdateUpToDateNotice），
 * 这里只测 renderer 的展示层映射，以及「消费点确实存在」的接线守卫。
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const dialogSource = readFileSync(resolve(testDir, "../src/UpdateStatusDialog.tsx"), "utf8");
const controllerSource = readFileSync(
  resolve(testDir, "../src/UpdateStatusDialogController.tsx"),
  "utf8",
);
const statusModelSource = readFileSync(resolve(testDir, "../src/updateStatusModel.ts"), "utf8");
const settingsHelperSource = readFileSync(
  resolve(testDir, "../src/settingsPageHelpers.tsx"),
  "utf8",
);
const rootEffectsSource = readFileSync(
  resolve(testDir, "../src/root/useRootPlatformEffects.ts"),
  "utf8",
);

const stuckNotice: UpdateUpToDateNotice = {
  channel: "stable",
  currentVersion: "3.17.0-preview.1",
  latestChannelVersion: "3.16.3",
  stableCatchUpPending: true,
};

/* --------------------------- 展示层映射（纯函数） --------------------------- */

test("通道显示：取 main 报来的已应用通道，拿不到才退回开关值", () => {
  assert.equal(
    deriveUpdateChannelSettingsView({
      appliedChannel: "preview",
      receivePreviewUpdates: false,
      upToDateNotice: null,
    }).channel,
    "preview",
    "已应用通道是真值，优先于开关值（开关可能与生效通道不同步）",
  );
  assert.equal(
    deriveUpdateChannelSettingsView({
      appliedChannel: null,
      receivePreviewUpdates: true,
      upToDateNotice: null,
    }).channel,
    "preview",
    "冷启动尚未检查时退回开关值",
  );
  assert.equal(
    deriveUpdateChannelSettingsView({
      appliedChannel: null,
      receivePreviewUpdates: false,
      upToDateNotice: null,
    }).channel,
    "stable",
  );
});

test("回不到正式版这一格：必须报出原因，且不得在其它格误报", () => {
  const stuck = deriveUpdateChannelSettingsView({
    appliedChannel: "stable",
    receivePreviewUpdates: false,
    upToDateNotice: stuckNotice,
  });
  assert.equal(stuck.stableCatchUpPending, true);
  assert.equal(stuck.currentVersion, "3.17.0-preview.1");
  assert.equal(stuck.latestChannelVersion, "3.16.3");

  // 普通「已是最新」（main 不给事实）不得让界面说「回不到正式版」。
  assert.equal(
    deriveUpdateChannelSettingsView({
      appliedChannel: "stable",
      receivePreviewUpdates: false,
      upToDateNotice: null,
    }).stableCatchUpPending,
    false,
  );
  // 预览通道下即使装的是预览版，也没有「回不去」这回事。
  assert.equal(
    deriveUpdateChannelSettingsView({
      appliedChannel: "preview",
      receivePreviewUpdates: true,
      upToDateNotice: null,
    }).stableCatchUpPending,
    false,
  );
});

test("「已是最新」toast 必须走同一个判据（只有该状态才改文案）", () => {
  assert.equal(shouldExplainBlockedReturnToStable(stuckNotice), true);
  assert.equal(shouldExplainBlockedReturnToStable(undefined), false);
  assert.equal(
    shouldExplainBlockedReturnToStable({ ...stuckNotice, stableCatchUpPending: false }),
    false,
    "事实带在但结论为否时不得改文案",
  );
});

/* ----------------------------- i18n（两语齐全） ----------------------------- */

test("通道与「回不到正式版」文案两语齐全（缺一种语言会露出裸 key）", () => {
  for (const key of [
    "settings.updateChannel.current.stable",
    "settings.updateChannel.current.preview",
    "settings.updateChannel.stableCatchUpPending",
    "updateDialog.channel.stable",
    "updateDialog.channel.preview",
    "update.toast.stableCatchUpPending",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺少 ${key}`);
    assert.ok(enUS[key], `en-US 缺少 ${key}`);
  }
});

/* ------------------------------- 接线守卫 ------------------------------- */

test("接线守卫｜updateStatusModel 算出的 updateChannel 必须有消费点（去掉消费 ⇒ 必红）", () => {
  // 字段本身仍在（它是数据源）。
  assert.match(statusModelSource, /updateChannel:/);

  // 更新弹窗：controller 从 view model 取出并透传，dialog 渲染成徽标。
  assert.match(controllerSource, /updateChannel,/);
  assert.match(controllerSource, /updateChannel=\{updateChannel\}/);
  assert.match(dialogSource, /update-status-channel-badge/);
  assert.match(dialogSource, /updateDialog\.channel\.\$\{updateChannel\}/);
});

test("接线守卫｜设置页把通道接到界面，并且「回不到正式版」有可见文案", () => {
  // 设置页消费展示模型（去掉 ⇒ 用户又看不出自己在哪里）。
  assert.match(settingsHelperSource, /deriveUpdateChannelSettingsView\(/);
  assert.match(settingsHelperSource, /useUpdateChannelStatus\(/);
  assert.match(
    settingsHelperSource,
    /settings\.updateChannel\.current\.\$\{updateChannelView\.channel\}/,
  );
  // 「装了预览版 + 关开关 + 正式号更低」这一格：必须有专门的可见文案与落点。
  assert.match(settingsHelperSource, /settings\.updateChannel\.stableCatchUpPending/);
  assert.match(settingsHelperSource, /settings-update-channel-stable-catch-up-pending/);
  assert.match(settingsHelperSource, /updateChannelView\.stableCatchUpPending/);
});

test("接线守卫｜up-to-date toast 在「回不到正式版」时改说原因", () => {
  assert.match(rootEffectsSource, /shouldExplainBlockedReturnToStable\(/);
  assert.match(rootEffectsSource, /update\.toast\.stableCatchUpPending/);
});
