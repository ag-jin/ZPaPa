import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultPullRequestProvider,
  createGitHubPullRequestProvider,
  createNullPullRequestProvider,
  normalizeGitHubPullRequestUrl,
  type PullRequestFetchResult,
} from "../src/workitem/pullRequestProvider.js";

/* #8 D2 的 **PullRequestProvider seam**（设计 §4.2）：接口 + null adapter（离线缺省）+ GitHub PAT
   adapter（REST `GET /repos/{owner}/{repo}/pulls/{number}`）。

   三条被测纪律：
   ① **URL 归一化**（粘哪一页都能登记）：只认 github.com 的 `<owner>/<repo>/pull[s]/<n>`，
      规范化成 `https://github.com/<owner>/<repo>/pull/<n>`；其余**响亮拒**（不猜、不静默降级）；
   ② **无 token / 网络失败 ⇒ 响亮失败原因**（`{ok:false, code, reason}`），**不静默**、不抛、
      不在无 token 时发出请求（离线形态下不得产生任何出站流量）；
   ③ 请求形状（API 地址 / Bearer 头 / Accept）与响应映射（state 四值闭集、merged_at → ms、
      head sha/ref、mergeable / mergeable_state 原值）。

   本文件的 fetch 全部是**注入的 stub**：真网络调用不在单测里做（无真实 token；
   真网络登记是人工演示项）。 */

const TOKEN = "ghp_test_token_do_not_log";

/** 响应 stub：`body` 走 JSON，`status` 缺省 200。 */
function jsonFetch(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): { calls: Array<{ url: string; init: RequestInit | undefined }>; impl: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: options.headers ?? { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

/** GitHub REST `GET /pulls/{n}` 的最小真实形状（字段名取自 GitHub 文档，不是我们自己的类型）。 */
function pullPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    title: "Add widget",
    html_url: "https://github.com/acme/widget/pull/7",
    head: { ref: "feat/widget", sha: "sha-head-1" },
    mergeable: true,
    mergeable_state: "clean",
    ...over,
  };
}

function expectOk(result: PullRequestFetchResult): Extract<PullRequestFetchResult, { ok: true }> {
  assert.equal(result.ok, true, `期望成功，实得：${JSON.stringify(result)}`);
  return result as Extract<PullRequestFetchResult, { ok: true }>;
}

function expectFail(
  result: PullRequestFetchResult,
): Extract<PullRequestFetchResult, { ok: false }> {
  assert.equal(result.ok, false, `期望失败，实得：${JSON.stringify(result)}`);
  return result as Extract<PullRequestFetchResult, { ok: false }>;
}

/* ---------------- ① URL 归一化 ---------------- */

test("URL 归一化｜github.com 的 pull/pulls 页与常见变体都收敛到同一规范地址", () => {
  const canonical = "https://github.com/acme/widget/pull/7";
  for (const input of [
    canonical,
    "https://github.com/acme/widget/pull/7/",
    "https://github.com/acme/widget/pulls/7",
    "https://github.com/acme/widget/pull/7/files",
    "https://github.com/acme/widget/pull/7?diff=split#discussion_r1",
    "http://github.com/acme/widget/pull/7",
    "https://www.github.com/acme/widget/pull/7",
    "  https://github.com/acme/widget/pull/7  ",
  ]) {
    assert.deepEqual(
      normalizeGitHubPullRequestUrl(input),
      { repoOwner: "acme", repoName: "widget", prNumber: 7, canonicalUrl: canonical },
      `必须接受并归一化：${input}`,
    );
  }
  // 带 .git 后缀 / 大写 host / 下划线与点号在 name 位都是合法 GitHub 形态。
  assert.deepEqual(normalizeGitHubPullRequestUrl("https://GitHub.com/acme/my_repo.js/pull/12"), {
    repoOwner: "acme",
    repoName: "my_repo.js",
    prNumber: 12,
    canonicalUrl: "https://github.com/acme/my_repo.js/pull/12",
  });
});

test("URL 归一化｜非 GitHub / 缺号 / 非法形态一律响亮拒（不猜、不静默降级为普通链接）", () => {
  for (const input of [
    "",
    "   ",
    "not a url",
    "https://gitlab.com/acme/widget/pull/7",
    "https://gist.github.com/acme/1234",
    "https://github.com/acme/widget/pulls",
    "https://github.com/acme/widget/pull/0",
    "https://github.com/acme/widget/pull/abc",
    "https://github.com/acme/widget/pull/-1",
    "https://github.com/acme/widget/issues/7",
    "https://github.com/acme/widget/pull/7/../../evil",
    "https://github.com/../widget/pull/7",
  ]) {
    assert.throws(
      () => normalizeGitHubPullRequestUrl(input),
      /PR|pull|GitHub|github/i,
      `必须响亮拒：${input}`,
    );
  }
});

/* ---------------- ② null adapter（离线缺省） ---------------- */

test("null adapter｜describe 恒 unavailable；fetch 返回响亮原因且**零出站**（不抛、不静默）", async () => {
  /* null adapter 自己不持 fetch ⇒ 结构上发不出请求；这里用一个「一被调用就断言失败」的
     全局 fetch 探针证明这一点（离线缺省形态不得产生任何网络尝试）。 */
  const originalFetch = globalThis.fetch;
  let probeCalls = 0;
  globalThis.fetch = (async () => {
    probeCalls++;
    throw new Error("null adapter 不得发请求");
  }) as typeof fetch;
  try {
    const provider = createNullPullRequestProvider();
    const status = provider.describe();
    assert.equal(status.available, false);
    assert.match(status.available === false ? status.reason : "", /令牌|token/i);

    const result = await provider.fetchPullRequest("https://github.com/acme/widget/pull/7");
    const failure = expectFail(result);
    assert.equal(failure.code, "unavailable");
    assert.match(failure.reason, /令牌|token/i, "失败原因必须点明「没配 token」，而不是笼统的失败");
    assert.equal(probeCalls, 0, "没有 token ⇒ 连一次请求都不该发");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---------------- ③ GitHub PAT adapter ---------------- */

test("GitHub adapter｜请求形状：规范 API 地址 + Bearer token + Accept；响应映射成快照字段", async () => {
  const { calls, impl } = jsonFetch(
    pullPayload({
      title: "Add widget",
      merged: false,
      mergeable: true,
      mergeable_state: "clean",
    }),
  );
  const provider = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: impl,
    now: () => 500,
  });
  assert.deepEqual(provider.describe(), { available: true });

  const snapshot = expectOk(
    await provider.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  ).snapshot;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/acme/widget/pulls/7");
  assert.equal(calls[0]!.init?.method, "GET");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.deepEqual(snapshot, {
    state: "open",
    mergedAt: null,
    title: "Add widget",
    branch: "feat/widget",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headSha: "sha-head-1",
    fetchedAt: 500,
  });
});

test("GitHub adapter｜状态映射：merged / draft / closed 三形态与 merged_at → ms；mergeable 三态", async () => {
  const merged = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: jsonFetch(
      pullPayload({
        state: "closed",
        merged: true,
        merged_at: "2025-01-02T03:04:05Z",
        mergeable: null,
        mergeable_state: "unknown",
      }),
    ).impl,
    now: () => 600,
  });
  const mergedSnapshot = expectOk(
    await merged.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  ).snapshot;
  assert.equal(mergedSnapshot.state, "merged");
  assert.equal(
    mergedSnapshot.mergedAt,
    1735787045000,
    "ISO 时刻 → epoch ms（字面量由独立换算得来）",
  );
  assert.equal(mergedSnapshot.mergeable, "UNKNOWN", "GitHub 说 null ⇒ UNKNOWN（不是「不合格」）");
  assert.equal(mergedSnapshot.mergeStateStatus, "UNKNOWN");

  const draft = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: jsonFetch(pullPayload({ draft: true, mergeable: false, mergeable_state: "dirty" }))
      .impl,
    now: () => 700,
  });
  const draftSnapshot = expectOk(
    await draft.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  ).snapshot;
  assert.equal(draftSnapshot.state, "draft", "draft 优先于 state=open");
  assert.equal(draftSnapshot.mergeable, "CONFLICTING");
  assert.equal(draftSnapshot.mergeStateStatus, "DIRTY");

  const closed = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: jsonFetch(pullPayload({ state: "closed" })).impl,
    now: () => 800,
  });
  assert.equal(
    expectOk(await closed.fetchPullRequest("https://github.com/acme/widget/pull/7")).snapshot.state,
    "closed",
  );
});

test("GitHub adapter｜HTTP 错误面：401/403/404 各自给出可行动的响亮原因（带状态码）", async () => {
  for (const [status, pattern] of [
    [401, /401|token|凭据/i],
    [403, /403|限流|权限/i],
    [404, /404|不存在/i],
  ] as const) {
    const provider = createGitHubPullRequestProvider({
      readToken: () => TOKEN,
      fetchImpl: jsonFetch({ message: "nope" }, { status }).impl,
      now: () => 1,
    });
    const failure = expectFail(
      await provider.fetchPullRequest("https://github.com/acme/widget/pull/7"),
    );
    assert.equal(failure.code, "http_error");
    assert.equal(failure.status, status);
    assert.match(failure.reason, pattern);
    assert.equal(failure.reason.includes(TOKEN), false, "失败原因里不得回显 token");
  }
});

test("GitHub adapter｜网络失败与超时：都收敛成带原因的失败（不抛、不静默）", async () => {
  const failing = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    },
  });
  const failure = expectFail(
    await failing.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  );
  assert.equal(failure.code, "network_error");
  assert.match(failure.reason, /ENOTFOUND/);

  /* 悬挂请求 + 极短 deadline：adapter 必须自己收口（有界），并把它报成超时失败。 */
  const hanging = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    timeoutMs: 20,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const timedOut = expectFail(
    await hanging.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  );
  assert.equal(timedOut.code, "network_error");
  assert.match(timedOut.reason, /超时|timeout|20/i);
});

test("GitHub adapter｜响应形态不对（非 JSON / 少 head.sha / state 越界）⇒ malformed_response，不猜值", async () => {
  const cases: Array<typeof fetch> = [
    (async () =>
      new Response("<html>502</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch,
    jsonFetch(pullPayload({ head: { ref: "x" } })).impl,
    jsonFetch(pullPayload({ state: "queued" })).impl,
  ];
  for (const impl of cases) {
    const provider = createGitHubPullRequestProvider({ readToken: () => TOKEN, fetchImpl: impl });
    const failure = expectFail(
      await provider.fetchPullRequest("https://github.com/acme/widget/pull/7"),
    );
    assert.equal(failure.code, "malformed_response", JSON.stringify(failure));
  }
});

test("GitHub adapter｜无 token：describe=unavailable，fetch 响亮拒且**零出站**（不静默、不抛）", async () => {
  let calls = 0;
  const provider = createGitHubPullRequestProvider({
    readToken: () => "   ",
    fetchImpl: (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(provider.describe().available, false);
  const failure = expectFail(
    await provider.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  );
  assert.equal(failure.code, "unavailable");
  assert.equal(calls, 0, "没 token 不发请求");
});

/* ---------------- ⑤ P3 加固（D2 复验报告的两条低危项，D3 同域顺手修） ---------------- */

test("P3-2｜库里的地址不是 GitHub PR：code=invalid_url 且**零出站**（不得误判成网络失败）", async () => {
  /* 来路：手工改库 / 历史行 / 换过归一化口径的旧行 —— 这种地址**不是网络问题**，
     报成 network_error 会让人去查网络（「重启试试」），而真正要做的是修这一行的地址。
     同时必须**零出站**：地址都不合法，一次请求都不该发。 */
  const { calls, impl } = jsonFetch(pullPayload());
  const provider = createGitHubPullRequestProvider({ readToken: () => TOKEN, fetchImpl: impl });
  for (const url of [
    "https://gitlab.com/acme/widget/pull/7",
    "not a url",
    "https://github.com/acme/widget/issues/7",
  ]) {
    const failure = expectFail(await provider.fetchPullRequest(url));
    assert.equal(failure.code, "invalid_url", `${url}：地址形态问题是**请求侧**的结论`);
    assert.match(failure.reason, /GitHub|地址|URL/i, `${url}：原因必须点明地址形态`);
  }
  assert.equal(calls.length, 0, "地址不合法 ⇒ 一次请求都不能发");
});

test("P3-1｜畸形响应里的远端可控字段：错误文案**定长截断**（远端文本不得整段进报告/日志）", async () => {
  /* 来路（D2 复验）：`state` / `merged_at` 是**远端可控**的任意长字符串，此前被整段
     JSON.stringify 进失败原因（再进 SyncReport / UI / 日志）。这不只是「文案很长」：
     若代理/网关把请求头回显进响应体，理论上有把凭据带进报告面的路径。
     修法：插值**定长截断**，但仍点名是哪个字段畸形（可行动性不因截断丢失）。 */
  const hostile = "A".repeat(4096);
  const provider = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: (async () =>
      new Response(JSON.stringify(pullPayload({ state: hostile, merged_at: hostile })), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const failure = expectFail(
    await provider.fetchPullRequest("https://github.com/acme/widget/pull/7"),
  );
  assert.equal(failure.code, "malformed_response");
  assert.equal(failure.reason.includes(hostile), false, "不得整段回显远端文本");
  assert.ok(
    failure.reason.length < 512,
    `失败原因必须有界（实得 ${failure.reason.length} 字）——它要进报告/界面/日志`,
  );
  assert.match(failure.reason, /state/, "仍要点名是哪个字段畸形（截断不得吃掉可行动性）");
  assert.match(failure.reason, /截断|truncat/i, "截断这件事本身要写明，不假装原文就是这么短");
});

/* ---------------- ⑥ 写路径与列举口（#8 D3：pr-gate 收尾要用） ---------------- */

test("createPullRequest｜请求形状：POST 规范地址 + Bearer + JSON 体（title/head/base/body）；响应映射成远端事实", async () => {
  const { calls, impl } = jsonFetch(
    pullPayload({
      number: 42,
      html_url: "https://github.com/acme/widget/pull/42",
      title: "批次 A",
      head: { ref: "squad/integration/wi-p", sha: "sha-int" },
    }),
  );
  const provider = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: impl,
    now: () => 777,
  });
  const result = await provider.createPullRequest({
    repoOwner: "acme",
    repoName: "widget",
    title: "批次 A",
    head: "squad/integration/wi-p",
    base: "main",
    body: "由 ZPaPa 小队整批收尾创建",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/acme/widget/pulls");
  assert.equal(calls[0]!.init?.method, "POST");
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    title: "批次 A",
    head: "squad/integration/wi-p",
    base: "main",
    body: "由 ZPaPa 小队整批收尾创建",
  });
  assert.equal(result.pullRequest.number, 42);
  assert.equal(result.pullRequest.htmlUrl, "https://github.com/acme/widget/pull/42");
  assert.deepEqual(result.pullRequest.snapshot, {
    state: "open",
    mergedAt: null,
    title: "批次 A",
    branch: "squad/integration/wi-p",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headSha: "sha-int",
    fetchedAt: 777,
  });
});

test("createPullRequest｜无 token ⇒ unavailable 零出站；422 ⇒ http_error 带远端 message（定长截断、零 token 回显）", async () => {
  let calls = 0;
  const offline = createGitHubPullRequestProvider({
    readToken: () => "",
    fetchImpl: (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const unavailable = await offline.createPullRequest({
    repoOwner: "acme",
    repoName: "widget",
    title: "t",
    head: "h",
    base: "main",
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "unavailable");
  assert.equal(calls, 0, "没 token ⇒ 写路径同样零出站");

  /* 422（已存在同名 PR 的典型响应）：远端 message 是**远端可控文本**，带出但定长截断（P3-1 同款）。 */
  const hostile = `A pull request already exists for acme:squad/integration/wi-p${"B".repeat(2048)}`;
  const created = createGitHubPullRequestProvider({
    readToken: () => TOKEN,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: hostile }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const failure = await created.createPullRequest({
    repoOwner: "acme",
    repoName: "widget",
    title: "t",
    head: "squad/integration/wi-p",
    base: "main",
  });
  assert.equal(failure.ok, false);
  if (failure.ok) return;
  assert.equal(failure.code, "http_error");
  assert.equal(failure.status, 422);
  assert.match(failure.reason, /already exists/, "远端 message 要带出（这是「已存在」的判别句）");
  assert.equal(failure.reason.includes(hostile), false, "不得整段回显远端文本");
  assert.ok(failure.reason.length < 512, `原因必须有界（实得 ${failure.reason.length} 字）`);
  assert.equal(failure.reason.includes(TOKEN), false, "失败原因里零 token 回显");
});

test("listOpenByBranchPrefix｜GET 开着的 PR 列表，按 head 前缀过滤（stub 断言，不联网）", async () => {
  const { calls, impl } = jsonFetch([
    pullPayload({ number: 7, head: { ref: "squad/integration/wi-p", sha: "s1" } }),
    pullPayload({ number: 8, head: { ref: "squad/integration/wi-q", sha: "s2" } }),
    pullPayload({ number: 9, head: { ref: "main", sha: "s3" } }),
  ]);
  const provider = createGitHubPullRequestProvider({ readToken: () => TOKEN, fetchImpl: impl });
  const result = await provider.listOpenByBranchPrefix({
    repoOwner: "acme",
    repoName: "widget",
    prefix: "squad/integration/wi-p",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(
    calls[0]!.url,
    "https://api.github.com/repos/acme/widget/pulls?state=open&per_page=100",
  );
  assert.deepEqual(
    result.pullRequests.map((pull) => pull.number),
    [7],
    "只留 head 命中前缀的（其余原样滤掉，不改写成别的形态）",
  );
  assert.equal(result.pullRequests[0]!.snapshot.branch, "squad/integration/wi-p");

  // 无 token ⇒ 同一句 unavailable，零出站。
  let offlineCalls = 0;
  const offline = createGitHubPullRequestProvider({
    readToken: () => undefined,
    fetchImpl: (async () => {
      offlineCalls++;
      return new Response("[]", { status: 200 });
    }) as typeof fetch,
  });
  const unavailable = await offline.listOpenByBranchPrefix({
    repoOwner: "acme",
    repoName: "widget",
    prefix: "squad/integration/",
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "unavailable");
  assert.equal(offlineCalls, 0);
});

test("缺省 provider｜写路径与列举口同样现判 token（未配 ⇒ unavailable，配上 ⇒ 转发实现）", async () => {
  let token: string | undefined;
  const { calls, impl } = jsonFetch(pullPayload({ number: 5 }));
  const provider = createDefaultPullRequestProvider({
    readToken: () => token,
    fetchImpl: impl,
    now: () => 1,
  });
  const offline = await provider.createPullRequest({
    repoOwner: "acme",
    repoName: "widget",
    title: "t",
    head: "h",
    base: "main",
  });
  assert.equal(offline.ok, false);
  assert.equal(calls.length, 0);

  token = TOKEN;
  const created = await provider.createPullRequest({
    repoOwner: "acme",
    repoName: "widget",
    title: "t",
    head: "h",
    base: "main",
  });
  assert.equal(created.ok, true);
  assert.equal(calls.length, 1);
});

/* ---------------- ④ 缺省 provider（runtime 的唯一构造口径） ---------------- */

test("缺省 provider｜token 空白 ⇒ null 形态；配了 token ⇒ GitHub 形态（每次调用现判，不缓存结论）", async () => {
  let token: string | undefined;
  const { calls, impl } = jsonFetch(pullPayload());
  const provider = createDefaultPullRequestProvider({
    readToken: () => token,
    fetchImpl: impl,
    now: () => 42,
  });

  assert.equal(provider.describe().available, false);
  assert.equal(
    expectFail(await provider.fetchPullRequest("https://github.com/acme/widget/pull/7")).code,
    "unavailable",
  );
  assert.equal(calls.length, 0);

  // 运行期配上 token（设置区保存）：同一 provider 实例下一次调用即走在线形态。
  token = TOKEN;
  assert.equal(provider.describe().available, true);
  assert.equal(
    expectOk(await provider.fetchPullRequest("https://github.com/acme/widget/pull/7")).snapshot
      .headSha,
    "sha-head-1",
  );
  assert.equal(calls.length, 1);

  // 清空 token（设置区清除）：回到离线形态。
  token = "";
  assert.equal(provider.describe().available, false);
  assert.equal(
    expectFail(await provider.fetchPullRequest("https://github.com/acme/widget/pull/7")).code,
    "unavailable",
  );
  assert.equal(calls.length, 1, "清空后不得再发请求");
});
