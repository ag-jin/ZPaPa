/* oxlint-disable eslint(max-lines) -- 三个路径（读 / 写 / 列举）共用同一个适配器与同一套失败归一
   （buildAuthHeaders 是凭据唯一出口、requestJson 是出站唯一收口）：拆文件会让 SEC 结构守卫（按本文件切片）
   失去单点，且「三个路径的形状一致性」在文件边界上再也读不出来。 */
import { isGithubPullRequestTokenConfigured } from "@zcode/shared";
import type { PullRequestSnapshot, PullRequestState } from "./workItemPullRequestRepo.js";

/* #8 D2 的 **PullRequestProvider seam**（设计 §4.2）：工作项 ↔ 远端 PR 的读数口。

   两个真实 adapter（设计 §4.1 的「两个真实形态 ⇒ seam 成立」）：
   · `createNullPullRequestProvider`——**离线缺省**：恒 unavailable；`fetchPullRequest` 返回
     一个带原因的失败（`code: "unavailable"`），**不抛、不发请求**。没配 token 时详情页 PR 区
     照常显示「手动登记的链接」，快照态显示「未配置 token」——**不是错误**（用户裁定）。
   · `createGitHubPullRequestProvider`——PAT + REST `GET /repos/{owner}/{repo}/pulls/{number}`。

   一条贯穿的错误纪律（与「留痕失败不抛」相反，这里**必须响**）：无 token / 网络失败 / 401 / 限流 /
   限流 / 响应形态不对，一律收敛成 `{ok:false, code, reason, status?}` —— **原因原样带出**，
   由同步模块记进 SyncReport、由 UI 呈现。静默的办法（返回 null、抛异常让上层吞、把失败折成
   「没有变化」）都会让「PR 区看起来一切正常，实际早就不再刷新」。

   凭据纪律（AGENTS.md）：token 只进 Authorization 头；失败原因与日志**零回显** token。
   `readToken` 是**每次调用现判**的读取口（token 是运行期可改的设置），不在构造期冻结结论。

   不做的事（设计 §4.2 的 v1 边界）：不拉 GraphQL statusCheckRollup（`checks_rollup_state` 后置）、
   不做 `listOpenByBranchPrefix` 自动关联（Q6 裁定：v1 手动贴 URL）。 */

export type PullRequestProviderStatus = { available: true } | { available: false; reason: string };

export type PullRequestFetchFailureCode =
  | "unavailable"
  | "http_error"
  | "network_error"
  | "malformed_response"
  /* P3-2（D2 复验）：**请求侧**的地址形态问题（库里那一行的 URL 不是 GitHub PR 地址）。
     此前与网络失败共用一个 code —— 而两者的处置完全不同（一个是修这一行，一个是查网络）；
     误报成 network_error 会把人引去重启网络，真正要做的事（改地址）反而没人做。 */
  | "invalid_url";

export type PullRequestFetchResult =
  | { ok: true; snapshot: PullRequestSnapshot }
  | { ok: false; code: PullRequestFetchFailureCode; reason: string; status?: number };

export interface PullRequestProvider {
  /** 同步、无 IO：只回答「现在有没有可用的读数面」（UI 据此决定显示快照态还是「未配置 token」）。 */
  describe(): PullRequestProviderStatus;
  /** 一次读数（无 token 时零出站）；**不抛**——一切失败都在返回值里带原因。 */
  fetchPullRequest(url: string): Promise<PullRequestFetchResult>;
}

/** 规范地址（登记与 fetch 共用一份形状；`htmlUrl` 列存的就是它）。 */
export type GitHubPullRequestAddress = {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  canonicalUrl: string;
};

/**
 * 一次读/写带回的**远端 PR 事实**（`createPullRequest` 与 `listOpenByBranchPrefix` 共用）。
 *
 * `snapshot` 与 `GET /pulls/{n}` 的映射**同一形状**（同一个 `mapPullPayload`）：
 * 写路径带回来的也是一份快照，落库直接走既有的 `replaceSnapshot` —— 不为写路径另造一套快照形状
 * （两套形状迟早分叉，而分叉的表现是「开完 PR 的登记行缺字段」且不报错）。
 */
export type RemotePullRequestFact = {
  /** GitHub 的 PR 号（正整数；非此形态一律 malformed，不猜）。 */
  number: number;
  /** 远端事实自带的规范页地址（不要自己从 owner/repo/number 拼 —— 那是第二份拼装口径）。 */
  htmlUrl: string;
  snapshot: PullRequestSnapshot;
};

/** `createPullRequest` 的入参（POST `/repos/{owner}/{repo}/pulls` 的全部内容）。 */
export type CreatePullRequestInput = {
  repoOwner: string;
  repoName: string;
  title: string;
  /** head 分支（短名即可；同仓库 PR 不需要 `owner:` 前缀）。 */
  head: string;
  /** base 分支（小队的 target）。 */
  base: string;
  body?: string;
};

/** 写路径的失败面与读路径**同一族码值**（同一套词汇，不另造一份枚举）。 */
export type PullRequestFailure = {
  ok: false;
  code: PullRequestFetchFailureCode;
  reason: string;
  status?: number;
};

export type PullRequestCreateResult =
  | { ok: true; pullRequest: RemotePullRequestFact }
  | PullRequestFailure;

export type PullRequestListResult =
  | { ok: true; pullRequests: RemotePullRequestFact[] }
  | PullRequestFailure;

export interface PullRequestProvider {
  /** 同步、无 IO：只回答「现在有没有可用的读数面」（UI 据此决定显示快照态还是「未配置 token」）。 */
  describe(): PullRequestProviderStatus;
  /** 一次读数（无 token 时零出站）；**不抛**——一切失败都在返回值里带原因。 */
  fetchPullRequest(url: string): Promise<PullRequestFetchResult>;
  /**
   * 开一个 PR（**写路径**，D3 的 pr-gate 收尾用）：`POST /repos/{owner}/{repo}/pulls`。
   *
   * 纪律与读路径一致：无 token ⇒ `unavailable` 且**零出站**；网络/HTTP/形态失败各自带原因返回
   * （**不抛**）；HTTP 失败时把远端 `message` 带出（**定长截断**，P3-1）——「同 head 的 PR 已存在」
   * 这类判别句必须看得见，否则用户只知道「远端拒绝了」。
   */
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestCreateResult>;
  /**
   * 列举某仓库**开着的** PR 并按 head 分支前缀过滤（`GET /pulls?state=open&per_page=100` +
   * 本地前缀过滤 —— GitHub REST 的 `head` 过滤是**精确匹配**，给不了前缀语义）。
   *
   * 用途（v1）：pr-gate 收尾在「开 PR 的那一刻」进程崩溃、本地登记行没写成时，按集成分支前缀
   * 把已存在的 PR **认回来**（设计 Q6 的自动关联留位按「列出待确认」口径使用，不做自动落表）。
   * 无 token ⇒ `unavailable` 且零出站；一切失败带原因返回（不抛）。
   */
  listOpenByBranchPrefix(input: {
    repoOwner: string;
    repoName: string;
    prefix: string;
  }): Promise<PullRequestListResult>;
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
/** GitHub 的 owner 位：字母数字与 `-`（`--` 连续是保留形态，这里只做形态闸）。 */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** repo 位：字母数字、`-`、`_`、`.`（`repo.git` 也照收 —— 粘地址的人常带它）。 */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * URL 归一化（**纯函数**，设计 §4.2「multica normalizePullRequestURL 的形态可移植」）：
 * 只认 github.com 的 `<owner>/<repo>/pull[s]/<number>`（尾巴上的 `/files`、查询串、锚点都吃掉，
 * 数字之后不再有歧义段）。任何其它形态**响亮抛**：贴错地址时静默登记成一条普通链接，
 * 会让「这条关联到底指什么」从此无人能答 —— 宁可当场报错。
 */
export function normalizeGitHubPullRequestUrl(input: string): GitHubPullRequestAddress {
  const raw = typeof input === "string" ? input.trim() : "";
  const reject = (why: string): never => {
    throw new Error(
      `不是有效的 GitHub PR 地址（收到 ${JSON.stringify(input)}）：${why}。` +
        "请贴形如 https://github.com/<owner>/<repo>/pull/<number> 的地址。",
    );
  };
  if (raw === "") reject("地址为空");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("无法解析为 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return reject(`协议必须是 http(s)，收到 ${url.protocol}`);
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    return reject(`只支持 github.com 的地址，收到主机 ${url.hostname}`);
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const [owner, repo, marker, numberText] = segments;
  if (!owner || !repo || !marker || numberText === undefined) {
    return reject("缺少 <owner>/<repo>/pull/<number> 中的一段");
  }
  if (marker !== "pull" && marker !== "pulls") {
    return reject(`路径段必须是 pull 或 pulls，收到 ${JSON.stringify(marker)}`);
  }
  if (!OWNER_PATTERN.test(owner)) return reject(`owner 形态非法：${JSON.stringify(owner)}`);
  if (!REPO_PATTERN.test(repo)) return reject(`repo 形态非法：${JSON.stringify(repo)}`);
  if (!/^[1-9]\d*$/.test(numberText)) {
    return reject(`PR 号必须是正整数，收到 ${JSON.stringify(numberText)}`);
  }
  const prNumber = Number.parseInt(numberText, 10);
  return {
    repoOwner: owner,
    repoName: repo,
    prNumber,
    canonicalUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
  };
}

/** 缺省超时（有界出站：悬挂请求不得把一次「刷新」永远吊住）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 「未配 token」的**唯一一句原因**（null adapter 与 GitHub adapter 的无 token 分支共用）。 */
export const PULL_REQUEST_TOKEN_MISSING_REASON =
  "未配置 GitHub 访问令牌（PAT）：PR 快照不可用，PR 区只显示手动登记的链接。";

export function createNullPullRequestProvider(
  reason: string = PULL_REQUEST_TOKEN_MISSING_REASON,
): PullRequestProvider {
  const unavailable: PullRequestFetchResult = { ok: false, code: "unavailable", reason };
  // 写路径与列举口**同一句原因、同一个对象形状**（无 token 是同一个事实，不该有两种说法）。
  const unavailableWrite: PullRequestFailure = { ok: false, code: "unavailable", reason };
  return {
    describe: () => ({ available: false, reason }),
    // 不持 fetch ⇒ 结构上发不出请求；返回同一个失败对象（不可变值，调用方无法改坏共享实例）。
    fetchPullRequest: async () => unavailable,
    createPullRequest: async () => unavailableWrite,
    listOpenByBranchPrefix: async () => unavailableWrite,
  };
}

type GitHubPullPayload = {
  number?: unknown;
  state?: unknown;
  draft?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  title?: unknown;
  html_url?: unknown;
  head?: { ref?: unknown; sha?: unknown } | null;
  mergeable?: unknown;
  mergeable_state?: unknown;
  /** 失败响应（HTTP 非 2xx）的远端说明；只在失败面上读，**定长截断**后才进原因（P3-1）。 */
  message?: unknown;
};

/** 把 REST 的 `mergeable_state` 归一成大写原值（GitHub 给的是小写：clean/dirty/blocked/…）。 */
function normalizeMergeStateStatus(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().toUpperCase();
}

/** `mergeable`：true/false/null 三分（null ⇒ UNKNOWN，与 multica 的 GraphQL 枚举同口径）。 */
function normalizeMergeable(value: unknown): string | null {
  if (value === true) return "MERGEABLE";
  if (value === false) return "CONFLICTING";
  return "UNKNOWN";
}

/** 形态不对就抛（**声明式 never**：调用点的控制流收窄靠它；由调用方折成 malformed_response）。 */
function throwPullPayloadProblem(what: string): never {
  throw new Error(`GitHub 响应缺少可用字段：${what}`);
}

/* P3-1（D2 复验）：远端可控字段进**错误文案**前一律定长截断。
 *
 * 为什么必须有界：`state` / `merged_at` 这类字段是远端（及其背后的代理/网关）可控的任意长字符串，
 * 整段 JSON.stringify 进失败原因后，会一路进 SyncReport → 界面 → 日志。除了「文案可以无限长」，
 * 更实际的风险是**回显**：若中间有代理把请求原文（含 Authorization 头）折进响应体，这段文本就会被
 * 搬进报告面。截断不是消毒（不假装能识别凭据），而是把**任何**单字段的影响面钉在一个常数量级上；
 * 同时保留字段名与开头若干字符 —— 截断不得吃掉「哪个字段畸形」这条可行动性。 */
export const REMOTE_FIELD_MAX_LENGTH = 120;

/** 远端可控值 → 有界的可读形态（超长则截断并**写明被截断**，不假装原文就这么短）。 */
export function truncateRemoteField(value: string, max: number = REMOTE_FIELD_MAX_LENGTH): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…（截断，原文 ${value.length} 字）`;
}

/** 远端可控值 → 有界的 JSON 形态（字符串原样截断，其余走 JSON.stringify）。 */
function boundedRemoteJson(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return JSON.stringify(truncateRemoteField(text));
}

/** 响应 → 快照；形态不对 ⇒ 抛（由调用方折成 malformed_response，不猜值）。 */
function mapPullPayload(payload: GitHubPullPayload, fetchedAt: number): PullRequestSnapshot {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title === "") throwPullPayloadProblem("title");
  const headSha = typeof payload.head?.sha === "string" ? payload.head.sha.trim() : "";
  if (headSha === "") throwPullPayloadProblem("head.sha");
  const branch = typeof payload.head?.ref === "string" ? payload.head.ref : null;

  const state: PullRequestState =
    payload.merged === true
      ? "merged"
      : payload.draft === true
        ? "draft"
        : payload.state === "open"
          ? "open"
          : payload.state === "closed"
            ? "closed"
            : throwPullPayloadProblem(
                // 远端可控 ⇒ 定长截断（P3-1）；字段名照旧点名。
                `state=${boundedRemoteJson(payload.state)}（闭集 open/closed + merged/draft 标志）`,
              );

  let mergedAt: number | null = null;
  if (typeof payload.merged_at === "string" && payload.merged_at.trim() !== "") {
    const parsed = Date.parse(payload.merged_at);
    if (!Number.isFinite(parsed))
      throwPullPayloadProblem(`merged_at=${boundedRemoteJson(payload.merged_at)}`);
    mergedAt = parsed;
  }

  return {
    state,
    mergedAt,
    title,
    branch,
    mergeable: normalizeMergeable(payload.mergeable),
    mergeStateStatus: normalizeMergeStateStatus(payload.mergeable_state),
    headSha,
    fetchedAt,
  };
}

/**
 * 响应 → **远端 PR 事实**（`createPullRequest` / `listOpenByBranchPrefix` 的映射）。
 * `number` / `html_url` 是我们**认这条 PR**的两个句柄：缺一个或形态不对就抛（不猜、不拼）。
 */
function mapRemotePullRequest(
  payload: GitHubPullPayload,
  fetchedAt: number,
): RemotePullRequestFact {
  const htmlUrl = typeof payload.html_url === "string" ? payload.html_url.trim() : "";
  if (htmlUrl === "") throwPullPayloadProblem("html_url");
  const rawNumber = payload.number;
  if (typeof rawNumber !== "number" || !Number.isInteger(rawNumber) || rawNumber <= 0) {
    throwPullPayloadProblem(`number=${boundedRemoteJson(rawNumber)}（必须是正整数）`);
  }
  return { number: rawNumber, htmlUrl, snapshot: mapPullPayload(payload, fetchedAt) };
}

/**
 * GitHub PAT adapter。`readToken` 每次调用现判；token 空白 ⇒ 与 null adapter 同形的
 * `unavailable`（**零出站**，不抛）。一切失败都带原因返回（见文件头）。
 */
export function createGitHubPullRequestProvider(deps: {
  readToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  logWarn?: (message: string, error?: unknown) => void;
}): PullRequestProvider {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 缺省落 console.warn（服务日志面不是本模块依赖）；第二参数透传原始错误（P3-2 同款纪律）。
  const logWarn =
    deps.logWarn ?? ((message: string, error?: unknown) => console.warn(message, error));

  const unavailable = (): PullRequestFetchResult => ({
    ok: false,
    code: "unavailable",
    reason: PULL_REQUEST_TOKEN_MISSING_REASON,
  });
  const unavailableFailure = (): PullRequestFailure => ({
    ok: false,
    code: "unavailable",
    reason: PULL_REQUEST_TOKEN_MISSING_REASON,
  });

  /**
   * 认证与协议头 —— **全模块唯一一处把凭据写进请求的地方**（读/写/列举三条路径共用一份；
   * 三处各拼一遍迟早在某一处漏掉版本头、Accept 或凭据）。
   *
   * 返回 `null` = 未配置（**零出站**）：调用方据此走 unavailable，结构上不会带着空凭据发请求。
   */
  function buildAuthHeaders(json: boolean): Record<string, string> | null {
    const token = deps.readToken()?.trim();
    if (!isGithubPullRequestTokenConfigured(token)) return null;
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  /**
   * 一次出站（**唯一的超时/网络失败收口点**）：有界超时 + 非 2xx + JSON 解析三段在这里归一。
   * `action` 只进文案（「读取」/「创建」）；头由调用方经 `buildAuthHeaders` 拿（凭据不在这里流转）。
   */
  async function requestJson(input: {
    authHeaders: Record<string, string>;
    url: string;
    action: "读取" | "创建";
    method: "GET" | "POST";
    body?: unknown;
  }): Promise<{ ok: true; payload: unknown } | PullRequestFailure> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(input.url, {
        method: input.method,
        headers: input.authHeaders,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      /* 网络层失败（DNS/TLS/超时中止）。原因原样带出：ENOTFOUND 与 abort 的处理方式不同，
         把它们折成同一句「网络失败」会让复盘时看不出该改网络还是该改超时。 */
      return {
        ok: false,
        code: "network_error",
        reason:
          `请求 GitHub API 失败（${input.url}，超时上限 ${timeoutMs}ms）：` +
          (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      /* 失败响应体里的远端 `message` 常是唯一可行动的判别句（「同 head 的 PR 已存在」、
         「No commits between base and head」）——带出但**定长截断**（P3-1：远端可控文本）。 */
      const detail = await readRemoteFailureDetail(response);
      return {
        ok: false,
        code: "http_error",
        status: response.status,
        reason:
          describeHttpFailure(response.status, input.url, input.action) +
          (detail === null ? "" : `（远端：${truncateRemoteField(detail)}）`),
      };
    }

    try {
      return { ok: true, payload: JSON.parse(await response.text()) };
    } catch (error) {
      logWarn(`[pull-request] GitHub 响应不是 JSON（${input.url}）`, error);
      return {
        ok: false,
        code: "malformed_response",
        reason: `GitHub 对 ${input.url} 的响应不是 JSON（响应体可能被代理/网关改写）。`,
      };
    }
  }

  return {
    describe() {
      return isGithubPullRequestTokenConfigured(deps.readToken())
        ? { available: true }
        : { available: false, reason: PULL_REQUEST_TOKEN_MISSING_REASON };
    },

    async fetchPullRequest(url) {
      const authHeaders = buildAuthHeaders(false);
      if (authHeaders === null) return unavailable();

      let address: GitHubPullRequestAddress;
      try {
        address = normalizeGitHubPullRequestUrl(url);
      } catch (error) {
        return {
          ok: false,
          code: "invalid_url",
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      const apiUrl = `https://api.github.com/repos/${address.repoOwner}/${address.repoName}/pulls/${address.prNumber}`;
      const response = await requestJson({
        authHeaders,
        url: apiUrl,
        action: "读取",
        method: "GET",
      });
      if (!response.ok) return response;

      try {
        return { ok: true, snapshot: mapPullPayload(response.payload as GitHubPullPayload, now()) };
      } catch (error) {
        return {
          ok: false,
          code: "malformed_response",
          reason: `GitHub 对 ${address.canonicalUrl} 的响应形态不认识：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },

    async createPullRequest(input) {
      const authHeaders = buildAuthHeaders(true);
      if (authHeaders === null) return unavailableFailure();

      const apiUrl = `https://api.github.com/repos/${input.repoOwner}/${input.repoName}/pulls`;
      const response = await requestJson({
        authHeaders,
        url: apiUrl,
        action: "创建",
        method: "POST",
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
      });
      if (!response.ok) return response;

      try {
        return {
          ok: true,
          pullRequest: mapRemotePullRequest(response.payload as GitHubPullPayload, now()),
        };
      } catch (error) {
        return {
          ok: false,
          code: "malformed_response",
          reason: `GitHub 对 ${apiUrl} 的创建响应形态不认识：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },

    async listOpenByBranchPrefix(input) {
      const authHeaders = buildAuthHeaders(false);
      if (authHeaders === null) return unavailableFailure();

      const apiUrl = `https://api.github.com/repos/${input.repoOwner}/${input.repoName}/pulls?state=open&per_page=100`;
      const response = await requestJson({
        authHeaders,
        url: apiUrl,
        action: "读取",
        method: "GET",
      });
      if (!response.ok) return response;

      try {
        const payload = response.payload;
        if (!Array.isArray(payload)) throwPullPayloadProblem("期望一个 PR 数组");
        const facts = (payload as GitHubPullPayload[]).map((entry) =>
          mapRemotePullRequest(entry, now()),
        );
        return {
          ok: true,
          pullRequests: facts.filter((fact) =>
            (fact.snapshot.branch ?? "").startsWith(input.prefix),
          ),
        };
      } catch (error) {
        return {
          ok: false,
          code: "malformed_response",
          reason: `GitHub 对 ${apiUrl} 的响应形态不认识：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
}

/** 失败响应体里的远端说明（取 `message` 字段；读不出/不是 JSON ⇒ null，不猜）。 */
async function readRemoteFailureDetail(response: Response): Promise<string | null> {
  try {
    const parsed = JSON.parse(await response.text()) as GitHubPullPayload;
    return typeof parsed.message === "string" && parsed.message.trim() !== ""
      ? parsed.message.trim()
      : null;
  } catch {
    return null;
  }
}

/** HTTP 状态 → 可行动的原因（401 = 凭据、403 = 权限/限流、404 = 不存在或不可见、5xx = 远端）。 */
function describeHttpFailure(status: number, url: string, action: "读取" | "创建"): string {
  if (status === 401) {
    return `GitHub 返回 401（${url}）：访问令牌无效或已过期，请在设置里重新配置。`;
  }
  if (status === 403) {
    return (
      `GitHub 返回 403（${url}）：令牌权限不足或触发了 API 限流` +
      "（403 + X-RateLimit-Remaining: 0 即限流，等窗口重置后重试）。"
    );
  }
  if (status === 404) {
    return action === "创建"
      ? `GitHub 返回 404（${url}）：仓库不存在，或令牌看不见这个仓库（创建 PR 需要 contents/pull request 写权限）。`
      : `GitHub 返回 404（${url}）：该 PR 不存在，或令牌看不见这个仓库。`;
  }
  if (status === 422 && action === "创建") {
    return (
      `GitHub 返回 422（${url}）：这次创建被拒 —— 常见因：同 head 分支的 PR 已存在、` +
      "head 与 base 之间没有差异、或 base 分支不存在。"
    );
  }
  return `GitHub 返回 ${status}（${url}）：远端拒绝了这次${action}。`;
}

/**
 * **缺省 provider**（runtime 的唯一构造口径）：token 空白 ⇒ null adapter，有 token ⇒ GitHub adapter。
 * 每次调用现判 —— 设置里配/清 token 后无需重建 runtime 即生效（token 是运行期设置）。
 */
export function createDefaultPullRequestProvider(deps: {
  readToken: () => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  logWarn?: (message: string, error?: unknown) => void;
}): PullRequestProvider {
  const github = createGitHubPullRequestProvider(deps);
  const offline = createNullPullRequestProvider();
  const pick = (): PullRequestProvider =>
    isGithubPullRequestTokenConfigured(deps.readToken()) ? github : offline;
  return {
    describe: () => pick().describe(),
    fetchPullRequest: (url) => pick().fetchPullRequest(url),
    createPullRequest: (input) => pick().createPullRequest(input),
    listOpenByBranchPrefix: (input) => pick().listOpenByBranchPrefix(input),
  };
}
