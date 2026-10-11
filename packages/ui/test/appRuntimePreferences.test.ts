// App 设置 → Agent/Bot 运行时偏好同步载荷的单元断言（卡 #204/A3）：
// ask-matt 实验开关必须与呈现面同判据（askMattFlowEntryVisible：只有显式 true 才下发），
// 既有字段（askUser 缺省开 / modelIo 缺省关）判据保持不变。

import assert from "node:assert/strict";
import test from "node:test";
import { buildAppRuntimePreferences } from "../src/settings/appRuntimePreferences.js";

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
