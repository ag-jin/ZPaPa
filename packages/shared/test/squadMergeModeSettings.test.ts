import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema, resolveSquadMergeMode } from "@zcode/shared";

/* #8 D3：`appSettings.squadMergeMode` —— 小队整批收尾的**模式开关**（设计 §6 的「设置模式开关」）。

   闭集两值（设计 §4.4 的模式表）：
   · `local`（缺省）：finalize 合回本地 target，终态由本地收尾给（现状，离线唯一形态）；
   · `pr-gate`：finalize 改为 push 集成分支 + 开 PR，终态交 PR merge（本片新增）。

   三条纪律与 token 字段同族：
   ① **缺省 = local**（不是 undefined 的含糊态）：缺省不得把用户带向远端 —— 「没配过」与
      「配了本地」在行为上必须一致，且都**不发生任何出站**；
   ② **闭集外响亮拒**（两处 schema 同步）：脏值静默按某一端处理，等于让收尾方式由数据损坏决定；
   ③ 读出口**只有一份判据** `resolveSquadMergeMode`：脏值一律收敛到 `local`（fail-safe 方向 =
      不动远端），避免「设置页显示某个模式、收尾按另一个模式」这种自相矛盾。 */

test("字段存在：缺省解析为 local（缺省不走向远端），显式值原样往返，闭集外响亮拒", () => {
  assert.equal(appSettingsSchema.parse({}).squadMergeMode, "local", "缺省必须是 local");
  assert.equal(appSettingsSchema.parse({ squadMergeMode: "local" }).squadMergeMode, "local");
  assert.equal(
    appSettingsSchema.parse({ squadMergeMode: "pr-gate" }).squadMergeMode,
    "pr-gate",
  );
  for (const bad of ["pr_gate", "prgate", "remote", "PR-GATE", "", 1, null]) {
    assert.throws(
      () => appSettingsSchema.parse({ squadMergeMode: bad as never }),
      `闭集外值必须响亮拒：${JSON.stringify(bad)}`,
    );
  }
});

test("patch 两处同步：能写、能省（省略 = 不改这一格）；闭集外拒", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ squadMergeMode: "pr-gate" }).squadMergeMode,
    "pr-gate",
  );
  assert.equal(
    appSettingsPatchSchema.parse({}).squadMergeMode,
    undefined,
    "省略 = 不改这一格（与 token 字段同款：没有「清除模式」这回事，只有选哪个模式）",
  );
  assert.throws(() => appSettingsPatchSchema.parse({ squadMergeMode: "merge" as never }));
  assert.throws(() => appSettingsPatchSchema.parse({ squadMergeMode: 2 as never }));
});

test("读出口唯一：resolveSquadMergeMode 对 undefined/脏值收敛到 local（fail-safe = 不动远端）", () => {
  assert.equal(resolveSquadMergeMode(undefined), "local");
  assert.equal(resolveSquadMergeMode("local"), "local");
  assert.equal(resolveSquadMergeMode("pr-gate"), "pr-gate");
  // 数据损坏 / 手改 setting.json 绕过 schema 的形态：一律按 local（绝不静默走向远端写路径）。
  for (const dirty of ["", "PR-GATE", "garbage", 0, null, {}, []]) {
    assert.equal(resolveSquadMergeMode(dirty), "local", `脏值必须收敛到 local：${String(dirty)}`);
  }
});
