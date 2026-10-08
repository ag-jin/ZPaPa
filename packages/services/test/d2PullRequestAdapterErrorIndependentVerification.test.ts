import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDefaultPullRequestProvider,
  createGitHubPullRequestProvider,
  createNullPullRequestProvider,
  normalizeGitHubPullRequestUrl,
  PULL_REQUEST_TOKEN_MISSING_REASON,
  type PullRequestFetchResult,
} from "../src/workitem/pullRequestProvider.js";

/* #8 D2 **独立复验**（test-verifier）：GitHub PAT adapter 的**错误面穷举** + URL 归一化变体矩阵 +
   凭据零回显。

   与实现者单测的区别：这里的每个失败面都用**同一个用例体**跑（表驱动），断言是
   「code + 可行动原因 + 整个结果对象里没有 token + 请求里确实带了 token（否则「没回显」可能只是
   「根本没发」）」。URL 矩阵的期望值按 GitHub 真实地址形态独立写出。 */

const TOKEN = "ghp_IndependentVerifySecret_9f8e7d6c5b4a";
const PULL_URL = "https://github.com/acme/widget/pull/7";

function providerWith(
  impl: typeof fetch,
  over: { logWarn?: (message: string, error?: unknown) => void; timeoutMs?: number } = {},
) {
  return createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: impl,
    now: () => 1234,
    ...(over.logWarn ? { logWarn: over.logWarn } : {}),
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}),
  });
}

function jsonOk(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/* ---------------- ① 错误面穷举：五类形态逐格 ---------------- */

test("错误面｜401/403/404/5xx：code=http_error + status 原样 + 可行动原因；结果对象零 token", async () => {
  const cases: Array<{ status: number; pattern: RegExp }> = [
    { status: 401, pattern: /401/ },
    { status: 403, pattern: /403/ },
    { status: 404, pattern: /404/ },
    { status: 429, pattern: /429/ },
    { status: 500, pattern: /500/ },
    { status: 502, pattern: /502/ },
  ];
  for (const { status, pattern } of cases) {
    let sawTokenInRequest = false;
    const impl = (async (_input: unknown, init?: RequestInit) => {
      sawTokenInRequest =
        (init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${TOKEN}`;
      return new Response(JSON.stringify({ message: "nope" }), { status });
    }) as typeof fetch;
    const result = (await providerWith(impl).fetchPullRequest(PULL_URL)) as PullRequestFetchResult;
    assert.equal(result.ok, false, `${status} 必须是失败`);
    if (result.ok) continue;
    assert.equal(result.code, "http_error", `${status} 的 code`);
    assert.equal(result.status, status, "HTTP 状态原样带出（UI 与复盘都要它）");
    assert.match(result.reason, pattern, `${status} 的原因要点明状态码`);
    assert.equal(
      JSON.stringify(result).includes(TOKEN),
      false,
      `${status} 的整个结果对象里不得出现 token`,
    );
    assert.equal(sawTokenInRequest, true, "请求确实带了 Bearer（否则「没回显」没有意义）");
  }
});

test("错误面｜超时（悬挂请求）与网络抛：code=network_error、原因带出真实错因；结果零 token", async () => {
  // 超时：fetch 永不 resolve，adapter 必须自己收口（有界）。
  const hanging = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      }),
    timeoutMs: 15,
  });
  const timedOut = (await hanging.fetchPullRequest(PULL_URL)) as PullRequestFetchResult;
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) {
    assert.equal(timedOut.code, "network_error");
    assert.match(timedOut.reason, /超时|timeout|15/i, "要说明是超时（而不是笼统「网络失败」）");
    assert.equal(JSON.stringify(timedOut).includes(TOKEN), false);
  }

  // 网络层抛（DNS/TLS）：原因原样带出（不是把所有网络错误折成同一句）。
  const thrown = providerWith((async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as typeof fetch);
  const network = (await thrown.fetchPullRequest(PULL_URL)) as PullRequestFetchResult;
  assert.equal(network.ok, false);
  if (!network.ok) {
    assert.equal(network.code, "network_error");
    assert.match(network.reason, /ENOTFOUND/);
    assert.equal(JSON.stringify(network).includes(TOKEN), false);
  }
});

test("错误面｜非 JSON / 少字段 / 闭集外 state / 不可解析时刻：code=malformed_response，不猜值", async () => {
  const payloads: Array<{ label: string; impl: typeof fetch }> = [
    {
      label: "HTML 错误页（200 + text/html）",
      impl: (async () =>
        new Response("<html>Bad gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as typeof fetch,
    },
    { label: "空体", impl: (async () => new Response("", { status: 200 })) as typeof fetch },
    {
      label: "缺 title",
      impl: jsonOk({ state: "open", head: { ref: "b", sha: "s" } }),
    },
    {
      label: "缺 head.sha",
      impl: jsonOk({ state: "open", title: "t", head: { ref: "b" } }),
    },
    {
      label: "state 闭集外",
      impl: jsonOk({ state: "queued", title: "t", head: { ref: "b", sha: "s" } }),
    },
    {
      label: "merged_at 不可解析",
      impl: jsonOk({
        state: "closed",
        merged: true,
        merged_at: "not-a-date",
        title: "t",
        head: { ref: "b", sha: "s" },
      }),
    },
  ];
  for (const { label, impl } of payloads) {
    const warnings: Array<{ message: string; error: unknown }> = [];
    const provider = providerWith(impl, {
      logWarn: (message, error) => warnings.push({ message, error }),
    });
    const result = (await provider.fetchPullRequest(PULL_URL)) as PullRequestFetchResult;
    assert.equal(result.ok, false, `${label} 必须失败（不猜值）`);
    if (result.ok) continue;
    assert.equal(result.code, "malformed_response", `${label} 的 code`);
    assert.ok(result.reason.trim().length > 0, `${label} 必须带原因`);
    assert.equal(
      JSON.stringify(result).includes(TOKEN),
      false,
      `${label}：结果对象里不得出现 token`,
    );
    for (const warning of warnings) {
      assert.equal(
        JSON.stringify(warning).includes(TOKEN),
        false,
        `${label}：日志参数里也不得出现 token`,
      );
    }
  }
});

test("错误面｜无 token（空白/undefined）：code=unavailable、零出站、零 token 回显", async () => {
  for (const token of ["", "   ", undefined, "\t"]) {
    let calls = 0;
    const provider = createGitHubPullRequestProvider({
      readToken: () => token,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(provider.describe(), {
      available: false,
      reason: PULL_REQUEST_TOKEN_MISSING_REASON,
    });
    const result = (await provider.fetchPullRequest(PULL_URL)) as PullRequestFetchResult;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unavailable");
      assert.equal(result.reason, PULL_REQUEST_TOKEN_MISSING_REASON, "与 null adapter 同一句原因");
    }
    assert.equal(calls, 0, "没 token ⇒ 一次请求都不能发（离线缺省零出站）");
  }
  // null adapter 同款（结构上不持 fetch）。
  const nullResult = (await createNullPullRequestProvider().fetchPullRequest(
    PULL_URL,
  )) as PullRequestFetchResult;
  assert.equal(nullResult.ok, false);
  if (!nullResult.ok) assert.equal(nullResult.code, "unavailable");
});

test("错误面｜缺省 provider：token 配/清在**同一实例**上现判（不清缓存结论）", async () => {
  let token: string | undefined;
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ state: "open", title: "t", head: { ref: "b", sha: "s" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const provider = createDefaultPullRequestProvider({ readToken: () => token, fetchImpl: impl });

  assert.equal(provider.describe().available, false);
  assert.equal((await provider.fetchPullRequest(PULL_URL)).ok, false);
  assert.equal(calls, 0);

  token = TOKEN;
  assert.equal(provider.describe().available, true);
  assert.equal((await provider.fetchPullRequest(PULL_URL)).ok, true);
  assert.equal(calls, 1);

  token = "  ";
  assert.equal(provider.describe().available, false, "只输空格 ⇒ 回到离线（与 shared 判据同口径）");
  assert.equal((await provider.fetchPullRequest(PULL_URL)).ok, false);
  assert.equal(calls, 1, "清空后不得再出站");
});

/* ---------------- ② URL 归一化变体矩阵 ---------------- */

test("URL 矩阵｜github.com 页面变体全部收敛到同一规范地址（含 pulls / files / 查询 / 锚点 / 大小写 host）", () => {
  const canonical = "https://github.com/acme/widget/pull/7";
  const cases: Array<[string, string]> = [
    [canonical, canonical],
    ["https://github.com/acme/widget/pull/7/", canonical],
    ["https://github.com/acme/widget/pulls/7", canonical],
    ["https://github.com/acme/widget/pull/7/files", canonical],
    ["https://github.com/acme/widget/pull/7/commits", canonical],
    ["https://github.com/acme/widget/pull/7?diff=split", canonical],
    ["https://github.com/acme/widget/pull/7#discussion_r123", canonical],
    ["http://github.com/acme/widget/pull/7", canonical],
    ["https://www.github.com/acme/widget/pull/7", canonical],
    ["https://GITHUB.COM/acme/widget/pull/7", canonical],
    ["   https://github.com/acme/widget/pull/7   ", canonical],
    ["https://github.com/acme/my_repo.js/pull/12", "https://github.com/acme/my_repo.js/pull/12"],
    ["https://github.com/acme/widget/pull/1234567", "https://github.com/acme/widget/pull/1234567"],
    ["https://github.com/acme/widget/pull/7?x=1&y=2#z", canonical],
  ];
  for (const [input, expected] of cases) {
    const address = normalizeGitHubPullRequestUrl(input);
    assert.equal(address.canonicalUrl, expected, `必须归一化：${input}`);
    assert.equal(
      normalizeGitHubPullRequestUrl(expected).canonicalUrl,
      expected,
      "规范地址再归一化必须是不动点（幂等）",
    );
  }
});

test("URL 矩阵｜非 GitHub / 非 PR 路径 / 无号 / 非法号一律响亮拒（gitlab、issues、gist、pull 无号、0、负、字母）", () => {
  const rejected = [
    "",
    "   ",
    "not a url",
    "github.com/acme/widget/pull/7",
    "ftp://github.com/acme/widget/pull/7",
    "https://gitlab.com/acme/widget/pull/7",
    "https://gitlab.com/acme/widget/merge_requests/7",
    "https://bitbucket.org/acme/widget/pull-requests/7",
    "https://github.com/acme/widget/issues/7",
    "https://github.com/acme/widget/issues/7#issuecomment-1",
    "https://github.com/acme/widget/commits/main",
    "https://github.com/acme/widget",
    "https://github.com/acme/widget/pull",
    "https://github.com/acme/widget/pulls",
    "https://github.com/acme/widget/pull/0",
    "https://github.com/acme/widget/pull/-1",
    "https://github.com/acme/widget/pull/1.5",
    "https://github.com/acme/widget/pull/abc",
    "https://github.com/acme/widget/pull/",
    "https://github.com/../widget/pull/7",
    "https://gist.github.com/acme/1234",
    "https://api.github.com/repos/acme/widget/pulls/7",
  ];
  for (const input of rejected) {
    assert.throws(
      () => normalizeGitHubPullRequestUrl(input),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.trim().length > 0, `拒绝必须有可读原因：${input}`);
        return true;
      },
      `必须响亮拒：${input}`,
    );
  }
});

/* ---------------- ③ 凭据纪律的结构守卫 ---------------- */

test("SEC 守卫｜provider 源码里 token 只出现在 Authorization 头与读取口；日志调用点不带 token", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/workitem/pullRequestProvider.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // token 的每一次出现都必须是「读 token / 判空 / 拼 Authorization 头」三种形态之一。
  const occurrences = [...code.matchAll(/token/gi)];
  assert.ok(occurrences.length > 0);
  for (const match of occurrences) {
    const around = code.slice(Math.max(0, match.index - 90), match.index + 60);
    const sanctioned =
      /readToken|isGithubPullRequestTokenConfigured|Authorization: `Bearer \$\{token\}`|Bearer|PULL_REQUEST_TOKEN_MISSING_REASON|const token = deps\.readToken\(\)/i.test(
        around,
      );
    assert.ok(
      sanctioned,
      `token 出现在未预期的位置（凭据纪律要求它只进 Authorization 头）：…${around.replace(/\n/g, " ")}…`,
    );
  }
  // 日志调用点：logWarn 的实参里不得出现 token（日志是唯一会外流的地方）。
  for (const call of code.matchAll(/logWarn\((?:[^()]|\([^()]*\))*\)/g)) {
    assert.equal(/token/i.test(call[0]), false, `logWarn 实参里不得出现 token：${call[0]}`);
  }
  // 出站只有 api.github.com 一个目标（token 不进 URL）。
  assert.equal(/api\.github\.com\/repos\/\$\{address/.test(code), true);
  assert.equal(/token.*\?.*=|搜索|search/.test(code), false, "token 不得作为查询参数");
});
