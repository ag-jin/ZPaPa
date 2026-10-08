import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  GITHUB_PULL_REQUEST_TOKEN_MAX_LENGTH,
  isGithubPullRequestTokenConfigured,
} from "@zcode/shared";

/* #8 D2 **独立复验**（test-verifier）：`appSettings.githubPullRequestToken`（本仓第一个 secret 字段）。

   复核三件（判据来自任务卡，不是实现）：
   ① **两处 schema 同步**（object + patch）：同一份取值矩阵在两处结论必须一致（避免「设置文件里读得回
      而 patch 写不进」或反之）；
   ② **无默认值**：未配置就是 undefined（补空串默认会让「有没有配」在设置文件里失去唯一形态）；
      空串是**合法的清除值**；trim 后 255 是边界（255 收、256 拒）；
   ③ **判据单源**：`isGithubPullRequestTokenConfigured` 由服务侧（provider 可用性）与呈现侧
      （设置区状态行）**同一份实现**消费 —— 两处各写一份会在「只输空格」上分叉。 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "ghp_IndependentVerify_9f8e7d6c5b4a";

test("两处 schema 同步｜取值矩阵在 object 与 patch 上结论逐格一致", () => {
  const matrix: Array<{ label: string; value: unknown; ok: boolean }> = [
    { label: "正常 token", value: TOKEN, ok: true },
    { label: "带前后空白（trim）", value: `  ${TOKEN}  `, ok: true },
    { label: "空串（合法清除值）", value: "", ok: true },
    { label: "恰 255 长", value: "x".repeat(255), ok: true },
    { label: "256 长", value: "x".repeat(256), ok: false },
    { label: "数字", value: 123, ok: false },
    { label: "对象", value: {}, ok: false },
    { label: "数组", value: [TOKEN], ok: false },
    { label: "null", value: null, ok: false },
  ];
  for (const { label, value, ok } of matrix) {
    const objectResult = appSettingsSchema.safeParse({ githubPullRequestToken: value });
    const patchResult = appSettingsPatchSchema.safeParse({ githubPullRequestToken: value });
    assert.equal(
      objectResult.success,
      ok,
      `object schema 对「${label}」的结论（期望 ${ok ? "收" : "拒"}）`,
    );
    assert.equal(
      patchResult.success,
      ok,
      `patch schema 对「${label}」的结论（期望 ${ok ? "收" : "拒"}）`,
    );
    // 结论一致还不够：**收下时的值**也要一致（trim 行为同步）。
    if (ok && objectResult.success && patchResult.success) {
      assert.equal(
        objectResult.data.githubPullRequestToken,
        patchResult.data.githubPullRequestToken,
        `两处 schema 对「${label}」归一后的值必须一致`,
      );
    }
  }
  assert.equal(GITHUB_PULL_REQUEST_TOKEN_MAX_LENGTH, 255, "上限常量与边界一致");
});

test("无默认值｜缺省不产生 token（未配置 ≠ 空串占位）；显式值原样往返；省略 ≠ 清除", () => {
  const defaults = appSettingsSchema.parse({});
  assert.equal(defaults.githubPullRequestToken, undefined, "缺省必须是 undefined（不是空串）");
  assert.equal(
    Object.hasOwn(defaults, "githubPullRequestToken"),
    false,
    "缺省解析不得凭空补出这个键",
  );
  assert.equal(
    appSettingsSchema.parse({ githubPullRequestToken: TOKEN }).githubPullRequestToken,
    TOKEN,
  );
  assert.equal(
    appSettingsPatchSchema.parse({}).githubPullRequestToken,
    undefined,
    "省略 = 不改这一格",
  );
  assert.equal(
    appSettingsPatchSchema.parse({ githubPullRequestToken: "" }).githubPullRequestToken,
    "",
    "空串 = 显式清除（与省略是两件事）",
  );
});

test("判据单源｜空白视同未配置；非空白才是已配置（含边界形态）", () => {
  for (const [value, expected] of [
    [TOKEN, true],
    [` ${TOKEN} `, true],
    ["", false],
    ["   ", false],
    ["\t\n", false],
    [undefined, false],
    [null, false],
  ] as const) {
    assert.equal(
      isGithubPullRequestTokenConfigured(value),
      expected,
      `判据对 ${JSON.stringify(value)} 的结论`,
    );
  }
});

test("判据单源｜两个消费点（服务侧 provider / 呈现侧设置区）都从 @zcode/shared 取同一实现", () => {
  const services = readFileSync(
    resolve(HERE, "../../services/src/workitem/pullRequestProvider.ts"),
    "utf8",
  );
  const ui = readFileSync(resolve(HERE, "../../ui/src/settings/ExperimentsSection.tsx"), "utf8");
  for (const [label, source] of [
    ["services/pullRequestProvider.ts", services],
    ["ui/ExperimentsSection.tsx", ui],
  ] as const) {
    assert.ok(
      /import \{[^}]*isGithubPullRequestTokenConfigured[^}]*\} from "@zcode\/shared"/.test(source),
      `${label} 必须从 @zcode/shared 取判据（不自己写一份空白判据）`,
    );
    /* 不得在**token 相关**的行上自己再写一份「trim 后是否为空」的判据
       （同文件里 mergeable_state 之类的空白判据是另一件事，不算违规）。 */
    for (const match of source.matchAll(/^.*trim\(\).*(!==|===)\s*""[^\n]*$/gm)) {
      const line = match[0];
      assert.equal(
        /token/i.test(line),
        false,
        `${label} 不得自写 token 的空白判据（应经 shared 的唯一实现）：${line.trim()}`,
      );
    }
  }
  // shared 内部也恰一处实现（导出面只有一个名字）。
  const validation = readFileSync(resolve(HERE, "../src/validationAppSettings.ts"), "utf8");
  assert.equal(
    (validation.match(/export function isGithubPullRequestTokenConfigured/g) ?? []).length,
    1,
    "判据在 shared 里恰一份",
  );
});
