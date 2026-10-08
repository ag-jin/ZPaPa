import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { GitHubIntegrationSettingsRow } from "../src/settings/GitHubIntegrationSettingsRow.js";

/* #8 D2：设置 ▸ 实验功能里的 **GitHub 集成（PAT）行** —— 本仓第一个 secret 字段。

   本文件钉住「不回显明文」的两道：
   ① **行为面**（真渲染）：已配置状态下 DOM 里只有「已配置」状态行 + 固定脱敏点串，
      输入框值恒为空串（**本次输入草稿**），且整段 HTML 里不出现任何形似凭据的串；
   ② **结构面**（源码切片）：呈现组件的 props 里没有 token 字段、容器调用点只传布尔事实 ——
      「回显」在结构上不可能（拿不到的东西渲染不出来），而不是靠人记住别写。 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** 一个**像真的**凭据串（若它出现在渲染结果里，就是回显）。 */
const TOKEN_LIKE = "ghp_SuperSecretTokenValue1234567890";

function render(props: { tokenConfigured: boolean; saving?: boolean }): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(GitHubIntegrationSettingsRow, {
        tokenConfigured: props.tokenConfigured,
        saving: props.saving ?? false,
        onSave: async () => {},
        onClear: async () => {},
      }),
    }),
  );
}

test("SEC-① 真渲染｜已配置：状态「已配置」+ 固定脱敏点串；输入框值恒空（草稿），HTML 里没有任何凭据串", () => {
  const html = render({ tokenConfigured: true });
  assert.ok(html.includes("已配置"), "状态行必现");
  assert.ok(html.includes("••••••••"), "脱敏点串（固定 8 枚，不按长度派生）");
  const input = html.match(/<input[^>]*data-testid="github-integration-token-input"[^>]*>/)?.[0];
  assert.ok(input, `输入框必须渲染：\n${html}`);
  assert.ok(input!.includes('type="password"'), "输入类型必须是 password（脱敏输入）");
  assert.ok(input!.includes('value=""'), "输入框值恒为空串：绝不预填已保存的 token");
  assert.ok(input!.includes('autoComplete="off"'), "不参与浏览器自动填充");
  assert.equal(html.includes(TOKEN_LIKE), false, "HTML 里不得出现凭据串");
  assert.equal(/ghp_[A-Za-z0-9]/.test(html), false, "任何 `ghp_` 前缀串都不得出现（形态级守卫）");
  // 清除按钮在「已配置」时可点，保存按钮在空草稿时禁用（不让人提交一个空 token）。
  assert.equal(
    html
      .match(/<button[^>]*data-testid="github-integration-token-clear"[^>]*>/)?.[0]!
      .includes("disabled="),
    false,
  );
  assert.ok(
    html
      .match(/<button[^>]*data-testid="github-integration-token-save"[^>]*>/)?.[0]!
      .includes("disabled="),
    "空草稿时保存禁用（空串是「清除」的语义，不该走保存）",
  );
});

test("SEC-② 真渲染｜未配置：状态「未配置」、无脱敏点串、清除按钮禁用（没有东西可清）", () => {
  const html = render({ tokenConfigured: false });
  assert.ok(html.includes("未配置"));
  assert.equal(html.includes("••••••••"), false, "没配置就不显示脱敏串");
  assert.ok(
    html
      .match(/<button[^>]*data-testid="github-integration-token-clear"[^>]*>/)?.[0]!
      .includes("disabled="),
    "清除禁用",
  );
  assert.ok(html.includes("明文"), "文案必须向用户言明明文落盘的取舍");
});

test("SEC-③ 结构守卫｜呈现组件的 props 里没有 token 字段；容器调用点只传布尔事实", () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const row = strip(
    readFileSync(resolve(SRC, "settings/GitHubIntegrationSettingsRow.tsx"), "utf8"),
  );
  // props 解构里只有布尔事实与两个回调（出现 token 字段即红）。
  const destructure = row.match(
    /export function GitHubIntegrationSettingsRow\(\{([\s\S]*?)\}: \{/,
  )?.[1];
  assert.ok(destructure, "找不到 props 解构");
  assert.equal(
    /(^|\s)token\s*[,:]/.test(destructure!),
    false,
    "呈现组件的 props 里不得有 token 值（只许 tokenConfigured 布尔事实）",
  );
  assert.ok(destructure!.includes("tokenConfigured"));
  // 组件体里不得出现「读设置拿 token」的形态（它连 useSettings 都不该 import）。
  assert.equal(row.includes("useSettings"), false, "呈现组件不读设置（token 值进不来）");
  assert.equal(row.includes("githubPullRequestToken"), false);

  // 容器调用点：**只**把布尔事实传下去。`githubPullRequestToken` 只允许作为判据函数的实参出现
  // （读值 → 算布尔），不得作为属性值直接传给渲染层（那才是回显的入口）。
  const section = strip(readFileSync(resolve(SRC, "settings/ExperimentsSection.tsx"), "utf8"));
  const callSite = section.match(/<GitHubIntegrationSettingsRow[\s\S]*?\/>/)?.[0];
  assert.ok(callSite, "找不到 GitHubIntegrationSettingsRow 的调用点");
  assert.ok(callSite!.includes("tokenConfigured="), "调用点必须传布尔事实");
  const occurrences = [...callSite!.matchAll(/githubPullRequestToken/g)];
  assert.ok(occurrences.length >= 1, "调用点必须真的从设置里读出 token 来算布尔（否则恒未配置）");
  for (const occurrence of occurrences) {
    const before = callSite!.slice(0, occurrence.index);
    assert.ok(
      before.trimEnd().endsWith("isGithubPullRequestTokenConfigured(settings?."),
      "token 字段只允许作为 `isGithubPullRequestTokenConfigured(…)` 的实参出现" +
        `（读值算布尔），不得直接进 JSX 属性：\n${callSite}`,
    );
  }
  assert.equal(
    /=\{\s*settings\??\.githubPullRequestToken/.test(callSite!),
    false,
    "不得把 token 直接作为属性值传给渲染层（回显的入口形态）",
  );
});

test("呈现｜设置区文案键双语齐备（标签/说明/占位/状态/保存/清除/失败）", () => {
  const ids = [
    "settings.experiments.githubIntegration.label",
    "settings.experiments.githubIntegration.description",
    "settings.experiments.githubIntegration.tokenPlaceholder",
    "settings.experiments.githubIntegration.tokenConfigured",
    "settings.experiments.githubIntegration.tokenNotConfigured",
    "settings.experiments.githubIntegration.tokenSave",
    "settings.experiments.githubIntegration.tokenClear",
    "settings.experiments.githubIntegration.saveFailed",
  ];
  for (const id of ids) {
    assert.ok(id in zhCN, `zh-CN 缺键 ${id}`);
    assert.ok(id in enUS, `en-US 缺键 ${id}`);
  }
  // 说明里必须出现「明文」的字面告知（用户裁定的取舍要落到界面上）。
  assert.ok(String(zhCN["settings.experiments.githubIntegration.description"]).includes("明文"));
  assert.ok(
    String(enUS["settings.experiments.githubIntegration.description"])
      .toLowerCase()
      .includes("plaintext"),
  );
});

/* ---------- #8 D3：整批收尾**模式**（pr-gate 开关）在设置区的呈现 ---------- */

function renderWithMode(props: {
  mergeMode: "local" | "pr-gate";
  tokenConfigured: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(GitHubIntegrationSettingsRow, {
        tokenConfigured: props.tokenConfigured,
        saving: false,
        mergeMode: props.mergeMode,
        onSave: async () => {},
        onClear: async () => {},
        onSelectMergeMode: async () => {},
      }),
    }),
  );
}

test("D3 模式行｜两档可选、当前档可见；选 pr-gate 但没配 token ⇒ 就地说明「会降级为本地合并」", () => {
  const local = renderWithMode({ mergeMode: "local", tokenConfigured: false });
  assert.ok(local.includes('data-testid="github-integration-merge-mode"'), "模式行必现");
  assert.ok(local.includes("本地合并"), `两档文案都在：\n${local}`);
  assert.ok(local.includes("pr-gate"), "pr-gate 档文案");
  assert.equal(
    local.includes('data-testid="github-integration-merge-mode-degrade"'),
    false,
    "local 模式不提示降级（本来就该本地合）",
  );
  // 当前档：按钮带 aria-pressed（可读的选中态，不靠颜色）。
  const pressed = local.match(/<button[^>]*aria-pressed="true"[^>]*>/g) ?? [];
  assert.equal(pressed.length, 1, "恰一个按钮处于选中态");
  assert.ok(pressed[0]!.includes('data-testid="github-integration-merge-mode-local"'));

  const gated = renderWithMode({ mergeMode: "pr-gate", tokenConfigured: false });
  assert.ok(
    gated.includes('data-testid="github-integration-merge-mode-degrade"'),
    "pr-gate 没配 token：必须就地说明「收尾会降级为本地合并」（不静默）",
  );
  assert.ok(gated.includes("降级"), `降级说明文案：\n${gated}`);
  const pressedGated = gated.match(/<button[^>]*aria-pressed="true"[^>]*>/g) ?? [];
  assert.ok(pressedGated[0]!.includes('data-testid="github-integration-merge-mode-pr-gate"'));

  const configured = renderWithMode({ mergeMode: "pr-gate", tokenConfigured: true });
  assert.equal(
    configured.includes('data-testid="github-integration-merge-mode-degrade"'),
    false,
    "配了 token 就不再提示降级",
  );
});

test("D3 模式行｜SEC 纪律不因新模式行松动：props 里仍没有 token 字段、渲染里无凭据串", () => {
  const html = renderWithMode({ mergeMode: "pr-gate", tokenConfigured: true });
  assert.equal(html.includes(TOKEN_LIKE), false);
  assert.equal(/ghp_[A-Za-z0-9]/.test(html), false, "任何 `ghp_` 前缀串都不得出现");
  const component = readFileSync(resolve(SRC, "settings/GitHubIntegrationSettingsRow.tsx"), "utf8");
  // 模式行不得挟带 token 值：props 解构里仍只许 tokenConfigured 这个布尔事实
  //（判据与 SEC-③ 同一处写法；回调签名里的入参草稿不在 props 解构位，故不冲突）。
  const destructure = component.match(
    /export function GitHubIntegrationSettingsRow\(\{([\s\S]*?)\}: \{/,
  )?.[1];
  assert.ok(destructure, "找不到 props 解构");
  assert.equal(
    /(^|\s)token\s*[,:]/.test(destructure!),
    false,
    "呈现组件的 props 里不得有 token 值（只许 tokenConfigured 布尔事实）",
  );
  assert.ok(destructure!.includes("tokenConfigured"));
  assert.ok(destructure!.includes("mergeMode"), "模式行的 props 必须含 mergeMode");
});
