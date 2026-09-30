#!/usr/bin/env node
/**
 * 回归（层 1 · 纯函数，无设备）：模型/供应商配置同步必须保持**取消**状态。
 *
 * ## 为什么要有这条
 *
 * 该功能的口径是「用户显式选方向（A→B / B→A / 不同步），可选合并」，落地的却是
 * 「一连上就自动把本端整份 Personal Provider 配置推给对端并整体替换」
 * （`providerProvisioningTarget.ts` 里 `personalRepository.update(...) => personalUpdate`），
 * 没有方向选择、没有合并、没有写入前预览。真实事故（2026-09-30）：B 端手工添加的模型
 * 在 A 连接后被整份覆盖丢失，两端 provider_config.json 变成同一份，凭据也按 allowlist
 * 被一并替换 —— 因为是整份替换，对端本地做的任何增量改动都不可恢复。
 *
 * 用户决定取消该功能。取消不能只是「不再主动调用」：旧版本对端仍会推送，所以目标端
 * 必须在**任何副作用之前**拒绝，且两端对失败口径必须一致。
 *
 * ## 判据
 *
 *   T1 目标端：一个 schema 合法、本来会整份覆盖配置的信封，apply 之后不得触碰任何
 *              依赖（personalRepository / credentialService / settingService /
 *              providerRuntime / 文件锁）。用 get 即抛的 Proxy 兜住选项对象 ——
 *              只要读了任何一个字段就立刻失败。
 *   T2 目标端：坏信封也不得抛 —— 旧版本把「首次同步成功」当 remote workspace 的
 *              发布屏障，返回 failed 会让连接整个建不起来（那是换一种坏法）。
 *   T3 发起端：不推送，且真实目标端写接口一次都没被调用。
 *
 * 这些断言依赖 `isProviderProvisioningSyncEnabled() === false`。要把同步做回来，必须先
 * 实现「方向选择 + 合并 + 写入前预览」，再改这里的断言 —— 而不是把开关翻回 true：
 * 整体替换的语义本身就是事故根因。
 *
 * 跑法：node --import tsx packages/desktop/test/providerProvisioningSyncCancelled.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const sharedModulePromise = tsImport(
  pathToFileURL(join(repoRoot, "packages/shared/src/index.ts")).href,
  import.meta.url,
);
const targetModulePromise = tsImport(
  pathToFileURL(
    join(repoRoot, "packages/services/src/model-provider/providerProvisioningTarget.ts"),
  ).href,
  import.meta.url,
);
const executorModulePromise = tsImport(
  pathToFileURL(
    join(repoRoot, "packages/desktop/src/host/remoteProviderProvisioningService.ts"),
  ).href,
  import.meta.url,
);

/**
 * 一个 schema 合法、且**本来会造成整份覆盖**的信封：带 Provider 规则、默认模型选择、
 * 顺序表与一条 allowlist 内的 OAuth 凭据。取消后 apply 它，必须什么都没发生。
 */
const WRITE_CAPABLE_ENVELOPE = {
  schemaVersion: 1,
  syncId: "regression-sync-cancelled",
  personalConfig: {
    providerConfigRules: {
      providerRules: [{ kind: "replace-all", providerIds: ["would-overwrite-peer"] }],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    providerOrder: ["would-overwrite-peer"],
    defaultModelSelection: {
      providerId: "would-overwrite-peer",
      modelId: "would-overwrite-peer",
    },
  },
  accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
  credentials: [
    {
      scope: "oauth-session",
      key: "oauth:zai:access_token",
      value: "would-overwrite-peer",
    },
  ],
};

/**
 * 选项对象用 Proxy 兜住：任何字段被读取都记账并抛错。
 * 「不写」不够 —— 连 stateFilePath 都不该被读到，读它就等于进了写路径。
 */
function forbiddenOptions(accessed: string[]): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        accessed.push(String(property));
        throw new Error(`同步已取消，不得触碰依赖：${String(property)}`);
      },
    },
  ) as never;
}

test("目标端：取消后 apply 不触碰任何依赖（信封本可整份覆盖配置）", async () => {
  const shared = await sharedModulePromise;
  const { createProviderProvisioningTarget } = await targetModulePromise;

  // 先证明信封本身合法：否则「没写进去」可能只是因为入参不合法，断言就空了。
  const parsed = shared.providerProvisioningEnvelopeSchema.safeParse(WRITE_CAPABLE_ENVELOPE);
  assert.equal(
    parsed.success,
    true,
    `测试信封必须 schema 合法，否则这条断言失去意义：${JSON.stringify(parsed)}`,
  );

  const accessed: string[] = [];
  const target = createProviderProvisioningTarget(forbiddenOptions(accessed));
  const result = await target.apply(WRITE_CAPABLE_ENVELOPE);

  assert.equal(
    result.status,
    "already-applied",
    "取消后必须回 already-applied：旧版本对端把首次同步成功当发布屏障，回 failed 会把连接建不起来",
  );
  assert.deepEqual(accessed, [], `取消后不得读取任何依赖，实际读了：${accessed.join(", ")}`);
});

test("目标端：取消后坏信封也不抛（旧版本对端的发布屏障必须放行）", async () => {
  const { createProviderProvisioningTarget } = await targetModulePromise;
  const accessed: string[] = [];
  const target = createProviderProvisioningTarget(forbiddenOptions(accessed));

  const result = await target.apply({} as never);

  assert.equal(result.status, "already-applied");
  assert.equal(result.syncId, "sync-disabled", "坏信封没有 syncId 时也要回一个合法结果");
  assert.deepEqual(accessed, [], "连坏信封都不该把取消路径变成写路径");
});

test("发起端：取消后不推送，真实目标端写接口零调用", async () => {
  const { createRemoteProviderProvisioningExecutorFromWorkspace } = await executorModulePromise;

  let applyCalls = 0;
  const executor = createRemoteProviderProvisioningExecutorFromWorkspace({
    // 故意不接 source：若开关被翻回 true，这条会走「能力不可用」分支得到 unsupported，
    // 断言立刻变红 —— 这正是我们要的回归信号。
    connectionServices: {
      providerProvisioningTargetService: {
        apply() {
          applyCalls += 1;
          throw new Error("同步已取消，不得调用对端写接口");
        },
      },
    } as never,
  });

  const result = await executor.syncLocalToRemote();

  assert.equal(
    result.status,
    "already-applied",
    `取消后必须放行对端屏障，实际 status=${result.status}`,
  );
  assert.equal(applyCalls, 0, "取消后不得调用对端写接口");
});
