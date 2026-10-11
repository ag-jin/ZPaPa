// App 设置 → Agent/Bot 运行时偏好同步载荷的单元断言（卡 #204/A3）：
// ask-matt 实验开关必须与呈现面同判据（askMattFlowEntryVisible：只有显式 true 才下发），
// 既有字段（askUser 缺省开 / modelIo 缺省关）判据保持不变。
// 回炉修复（F1 整链）：同步载荷的单点不仅服务 Root 初始化/广播接收，还必须覆盖
// useSettingService.update 的即时同步路径——否则一次「改别的偏好」就会把 ask-matt 打成关，
// 且广播载荷丢字段会让其他窗口同样误关（判据单点见 src/settings/appRuntimePreferences.ts）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "@zcode/shared";
import {
  buildAppRuntimePreferences,
  buildAppRuntimePreferencesFromPatch,
} from "../src/settings/appRuntimePreferences.js";

test("ask-matt 开关只有显式 true 才下发（false / 未设置 = 关）", () => {
  const base = { askUserQuestionAutoResolutionEnabled: true };
  assert.equal(
    buildAppRuntimePreferences({ ...base, experimentalAskMattFlowEnabled: true })
      .askMattFlowEnabled,
    true,
  );
  assert.equal(
    buildAppRuntimePreferences({ ...base, experimentalAskMattFlowEnabled: false })
      .askMattFlowEnabled,
    false,
  );
  assert.equal(buildAppRuntimePreferences(base).askMattFlowEnabled, false);
});

test("既有字段判据不变：askUser 缺省开、modelIo 缺省关", () => {
  const payload = buildAppRuntimePreferences({});
  assert.equal(payload.askUserQuestionAutoResolutionEnabled, true, "askUser 缺省开（存量兼容）");
  assert.equal(payload.modelIoFullRetentionEnabled, false, "modelIo 缺省关");
  assert.equal(payload.askMattFlowEnabled, false, "askMatt 缺省关");
  assert.equal(
    buildAppRuntimePreferences({ askUserQuestionAutoResolutionEnabled: false })
      .askUserQuestionAutoResolutionEnabled,
    false,
  );
  assert.equal(
    buildAppRuntimePreferences({ modelIoFullRetentionEnabled: true }).modelIoFullRetentionEnabled,
    true,
  );
});

test("乘积态：ask-matt 开关不改变既有字段，载荷只含三个同步字段", () => {
  const payload = buildAppRuntimePreferences({
    askUserQuestionAutoResolutionEnabled: true,
    experimentalAskMattFlowEnabled: true,
    modelIoFullRetentionEnabled: true,
  });
  assert.deepEqual(payload, {
    askUserQuestionAutoResolutionEnabled: true,
    askMattFlowEnabled: true,
    modelIoFullRetentionEnabled: true,
  });
});

const USETTING_SERVICE_SOURCE = fileURLToPath(
  new URL("../src/hooks/useSettingService.ts", import.meta.url),
);

test("patch 合并：update 路径载荷与快照/补丁同判据，ask-matt 不被旁路丢弃", () => {
  // 关 → 开：只 patch ask-matt，其余字段取自上一快照。
  assert.deepEqual(
    buildAppRuntimePreferencesFromPatch(
      { experimentalAskMattFlowEnabled: true },
      {
        askUserQuestionAutoResolutionEnabled: true,
        experimentalAskMattFlowEnabled: false,
        modelIoFullRetentionEnabled: false,
      },
    ),
    {
      askUserQuestionAutoResolutionEnabled: true,
      askMattFlowEnabled: true,
      modelIoFullRetentionEnabled: false,
    },
  );
  // 开 → 关：显式 false 覆盖快照 true（与呈现面同判据）。
  assert.equal(
    buildAppRuntimePreferencesFromPatch(
      { experimentalAskMattFlowEnabled: false },
      { experimentalAskMattFlowEnabled: true },
    ).askMattFlowEnabled,
    false,
  );
  // patch 不含偏好字段：沿用快照的 ask-matt 值，不得打成 false（F1 整链回炉点）。
  assert.equal(
    buildAppRuntimePreferencesFromPatch(
      { askUserQuestionAutoResolutionEnabled: false },
      { experimentalAskMattFlowEnabled: true },
    ).askMattFlowEnabled,
    true,
    "改其他偏好不得把 ask-matt 误关",
  );
  // 快照缺失（设置加载中/未加载）：fail-closed。
  assert.equal(buildAppRuntimePreferencesFromPatch({}, null).askMattFlowEnabled, false);
});

test("跨包合同：update 路径同步载荷必须被广播接收 schema 接受（否则其他窗口丢 ask-matt）", () => {
  const payload = buildAppRuntimePreferencesFromPatch(
    { experimentalAskMattFlowEnabled: true },
    { askUserQuestionAutoResolutionEnabled: true, modelIoFullRetentionEnabled: true },
  );
  const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse(payload);
  assert.equal(
    parsed.success,
    true,
    `同步载荷必须过 appRuntimePreferencesChangedBroadcastPayloadSchema，实收 ${JSON.stringify(payload)}`,
  );
  assert.equal(parsed.success && parsed.data.askMattFlowEnabled, true);
});

test("装配守卫：useSettingService.update 的即时同步路径必须经单点函数且把 ask-matt 纳入触发条件", () => {
  const source = readFileSync(USETTING_SERVICE_SOURCE, "utf8");
  assert.match(
    source,
    /buildAppRuntimePreferencesFromPatch\(/,
    "update 路径载荷必须走 settings/appRuntimePreferences.ts 单点，不得就地拼两个字段",
  );
  assert.match(
    source,
    /typeof patch\.experimentalAskMattFlowEnabled === "boolean"/,
    "ask-matt 开关翻转必须触发即时同步（否则只能等 Root 效应，且会被后续两字段同步覆盖）",
  );
});
