import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  isGithubPullRequestTokenConfigured,
} from "@zcode/shared";

/* #8 D2：`appSettings.githubPullRequestToken` —— **本仓第一个 secret 字段**（设计 §4.3 / Q2 裁定）。

   本文件钉三件事：
   ① 字段存在且**不是**默认值（缺省 = 未配置，不得被 schema 补出一个空串或占位值）；
   ② **两处 schema 同步**（object + patch，既有设置字段纪律）：patch 能写、能清（"" / 省略），
      超长拒；
   ③ 「已配置」判据**只有一份**（`isGithubPullRequestTokenConfigured`）：服务侧（provider 可用性）
      与呈现侧（设置区状态行）共用 —— 两处各写一份空白判据会在「只输空格」这类输入上分叉。

   明文落盘的取舍（本地单机、单用户、文件权限即边界）在设置区文案里向用户言明，见 UI 侧用例。 */

const TOKEN = "ghp_example_token_value_1234567890";

test("字段存在：缺省解析不产生 token（未配置 ≠ 空串占位），显式值原样往返", () => {
  const defaults = appSettingsSchema.parse({});
  assert.equal(
    Object.hasOwn(defaults, "githubPullRequestToken") &&
      defaults.githubPullRequestToken !== undefined,
    false,
    "缺省不得补出 token（不设默认值 —— 「未配置」就是没有这个键/为 undefined）",
  );
  assert.equal(defaults.githubPullRequestToken, undefined);

  const parsed = appSettingsSchema.parse({ githubPullRequestToken: TOKEN });
  assert.equal(parsed.githubPullRequestToken, TOKEN, "读回原样（不脱敏改写存储事实）");
});

test("patch 两处同步：能写（trim）、能清（空串与缺省）、超长响亮拒", () => {
  assert.equal(
    appSettingsPatchSchema.parse({ githubPullRequestToken: `  ${TOKEN}  ` }).githubPullRequestToken,
    TOKEN,
  );
  assert.equal(
    appSettingsPatchSchema.parse({ githubPullRequestToken: "" }).githubPullRequestToken,
    "",
  );
  assert.equal(
    appSettingsPatchSchema.parse({}).githubPullRequestToken,
    undefined,
    "省略 = 不改这一格（不是清除）",
  );
  const tooLong = "x".repeat(256);
  assert.throws(() => appSettingsPatchSchema.parse({ githubPullRequestToken: tooLong }));
  assert.doesNotThrow(() =>
    appSettingsPatchSchema.parse({ githubPullRequestToken: "x".repeat(255) }),
  );
  // 非字符串形态同样拒（数据驱动路径绕过 TS 时不得静默落盘）。
  assert.throws(() => appSettingsPatchSchema.parse({ githubPullRequestToken: 123 as never }));
});

test("「已配置」判据唯一：空白（含全空格）与 undefined 都是未配置，非空白才是已配置", () => {
  assert.equal(isGithubPullRequestTokenConfigured(TOKEN), true);
  assert.equal(isGithubPullRequestTokenConfigured(undefined), false);
  assert.equal(isGithubPullRequestTokenConfigured(null), false);
  assert.equal(isGithubPullRequestTokenConfigured(""), false);
  assert.equal(
    isGithubPullRequestTokenConfigured("   "),
    false,
    "只输空格 = 未配置（不当作已配好）",
  );
  assert.equal(isGithubPullRequestTokenConfigured(` ${TOKEN} `), true);
});
