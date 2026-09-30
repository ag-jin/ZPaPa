#!/usr/bin/env node
/**
 * 回归（层 1 · 本机回环，无需设备）：窗口 host 兼常驻主机后，挂载面必须仍提供
 * `provider-provisioning-target`。
 *
 * ## 为什么要有这条
 *
 * 远程工作区的建立有一个 fail-closed 的「Provider Provisioning 首次同步」屏障
 * （`desktopRemoteSessions.ts` 的 handleConnected → registration.initialSync，
 * `providerProvisioningEnvironmentCoordinator.ts` 对 environment-online 失败直接抛出）。
 * 该屏障要求**被挂载端**的 host 暴露 provider-provisioning-target channel。
 *
 * ADR 0003 把常驻主机职责移交给窗口 host（`serviceAuthorityMode: "desktop-local"`）后，
 * `createLocalServices` 的注册条件（`desktop-attached-remote || providerProvisioningTargetEnabled`）
 * 两个都不满足 —— channel 直接消失。真实故障表现（2026-09-29 实测）：
 *
 *   A 侧：Provider Provisioning 首次同步失败 (failed)  → 整个 remote workspace 建不起来
 *   B 侧：Unknown channel: provider-provisioning-target（ChannelServer 1000ms 超时）
 *
 * 注意 `connectResidentRemote` 本身**不会**因此返回 null —— 挂载在传输层是成功的，
 * 失败发生在之后的 initialSync 屏障。所以「挂得上」不代表这条通过，必须直接探测 channel。
 *
 * 2026-09-30 补充：模型/供应商配置同步已**取消**（`isProviderProvisioningSyncEnabled()`
 * 恒为 false，目标端只回 already-applied、不写任何配置）。但 channel **必须继续注册** ——
 * 旧版本对端仍在推送，channel 消失会让它们的发布屏障超时失败，连接整个建不起来。
 * 所以下面的探测逻辑一字不改，只是目标端不再落盘。
 *
 * ## 判据（只读）
 *
 * 刻意不调写接口 `providerProvisioningTargetService.apply()` —— 它是写接口
 * （captureBeforeState → 覆盖 personal config → 按 allowlist 删除 OAuth/账号凭据），
 * 探针传空 envelope 曾清空过对端个人 Provider 配置与 8 个凭据。
 *
 * 改用「不存在的方法名」探测路由是否存在，两种情况都零写入：
 *   channel 未注册 → ChannelServer 无路由 → 1000ms 超时（"timed out"）
 *   channel 已注册 → ProxyChannel 立即回 "Method not found"
 *
 * ## 覆盖
 *
 *   T1 desktop-local（窗口 host 兼常驻主机）→ channel 必须可达
 *   T2 desktop-attached-remote（独立常驻主机 / legacy 形态）→ channel 必须可达
 *   T3 web-remote-replayable 连接不得拿到真实 target（凭据写接口的信任边界）
 *
 * 跑法：node --import tsx packages/desktop/test/providerProvisioningChannel.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** 探测结果：区分「渠道缺失（超时）」与「渠道可用（Method not found）」。 */
type ChannelProbe = "channel-present" | "channel-missing" | `unexpected: ${string}`;

interface LoopbackHost {
  readonly port: number;
  probe(clientMode: "desktop-continuous" | "web-remote-replayable"): Promise<ChannelProbe>;
  /** 用非受信连接调真实 apply，返回错误文本（null = 竟然写成功）。 */
  applyAsUntrusted(): Promise<string | null>;
  /** 端到端同步一次，返回 target 的 status（applied/already-applied 即屏障放行）。 */
  syncOnce(): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * 起一个真实的服务面 + HTTP/WS 挂载点，模式与 targetOptions.serviceAuthorityMode 一致。
 * 数据目录隔离到临时目录，绝不读写用户真实配置。
 */
async function startLoopbackHost(
  serviceAuthorityMode: "desktop-local" | "desktop-attached-remote",
): Promise<LoopbackHost> {
  const servicesModule = await tsImport(
    pathToFileURL(join(repoRoot, "packages/services/src/node.ts")).href,
    import.meta.url,
  );
  // 必须用 setDataBaseDir 显式切换：paths.ts 在模块加载时一次性捕获
  // ZCODE_DATA_BASE_DIR 环境变量，只改 env 对已加载的实例无效，
  // 会让多个 host 共用同一个数据目录（前一个 dispose 删目录后，后续用例
  // 报 ENOENT/锁超时，表现为测试自身的假失败）。
  const dataDir = mkdtempSync(join(tmpdir(), "zcode-provisioning-channel-"));
  const previousDataDir = servicesModule.getDataBaseDir();
  servicesModule.setDataBaseDir(dataDir);
  const serverModule = await tsImport(
    pathToFileURL(join(repoRoot, "packages/server/src/http.ts")).href,
    import.meta.url,
  );
  const rpcModule = await tsImport(
    pathToFileURL(join(repoRoot, "packages/rpc/src/index.ts")).href,
    import.meta.url,
  );
  const sharedModule = await tsImport(
    pathToFileURL(join(repoRoot, "packages/shared/src/index.ts")).href,
    import.meta.url,
  );
  const clientModule = await tsImport(
    pathToFileURL(join(repoRoot, "packages/client/src/index.ts")).href,
    import.meta.url,
  );
  const { default: WebSocket } = await import("ws");

  // 内置 Provider Config 必须存在：createLocalServices 依赖它做 Provider Registry 装配。
  const builtinConfigPath = join(repoRoot, "config/provider/zcode-builtin.json");
  const services = await servicesModule.createLocalServices({
    zcodeBuiltinProviderConfigFilePath: builtinConfigPath,
    serviceAuthorityMode,
  });

  let server: {
    address(): unknown;
    close(): void;
    once(event: string, cb: () => void): void;
  } | null = null;
  const httpServer = serverModule.createHttpServer(services, 0, { host: "127.0.0.1" });
  server = httpServer;
  const port = await new Promise<number>((resolve, reject) => {
    const initial = httpServer.address() as { port?: number } | null;
    if (typeof initial === "object" && initial?.port) {
      resolve(initial.port);
      return;
    }
    httpServer.once("listening", () => {
      const listening = httpServer.address() as { port?: number } | null;
      resolve(typeof listening === "object" && listening ? (listening.port ?? 0) : 0);
    });
    httpServer.once("error", reject);
  });
  assert.ok(port > 0, "回环 HTTP 服务应成功监听");

  /** 建立一条与生产同款的挂载连接（/ws/host + 一次性票据；replayable 走 /ws）。 */
  const connect = async (
    clientMode: "desktop-continuous" | "web-remote-replayable",
  ): Promise<{
    client: InstanceType<typeof rpcModule.ChannelClient>;
    close(): void;
  }> => {
    const ticketResponse = await fetch(`http://127.0.0.1:${port}/api/rpc-host-capability`, {
      method: "POST",
    });
    const ticket = (await ticketResponse.json()) as { capability?: string };
    const path = clientMode === "desktop-continuous" ? "/ws/host" : "/ws";
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { [sharedModule.ZCODE_RPC_HOST_CAPABILITY_HEADER]: ticket.capability ?? "" },
    });
    // 与 connect-resident 相同：wrap/protocol/client 必须在 await open 之前构造，
    // 否则服务端 Initialize 帧可能先到而丢失。
    const client = new rpcModule.ChannelClient(
      new rpcModule.SocketProtocol(serverModule.wrapWebSocket(ws)),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("protocol initialize timed out")), 15_000);
      const disposable = client.onDidInitialize(() => {
        clearTimeout(timer);
        disposable.dispose();
        resolve();
      });
    });
    return {
      client,
      close() {
        try {
          ws.close();
        } catch {
          /* 连接已断 */
        }
        client.dispose();
      },
    };
  };

  return {
    port,
    async probe(clientMode): Promise<ChannelProbe> {
      const { client, close } = await connect(clientMode);
      try {
        const channel = client.getChannel(sharedModule.ServiceChannels.ProviderProvisioningTarget);
        try {
          // 不存在的方法名：有路由 → 立即 Method not found；无路由 → 1000ms 超时。
          await channel.call("__probe_no_such_method__", []);
          return "unexpected: probe unexpectedly succeeded";
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("timed out")) return "channel-missing";
          if (message.includes("Method not found")) return "channel-present";
          return `unexpected: ${message}`;
        }
      } finally {
        close();
      }
    },
    /**
     * 用非受信连接（replayable）调真实方法名 apply，返回错误文本（null = 竟然写成功了）。
     * 空 envelope 只会打到桩上，不会落到真实 target 的写路径上。
     */
    async applyAsUntrusted(): Promise<string | null> {
      const { client, close } = await connect("web-remote-replayable");
      try {
        const target = new clientModule.RemoteServiceAccess(client)
          .providerProvisioningTargetService;
        try {
          await target.apply({
            schemaVersion: 1,
            syncId: "untrusted-probe",
            personalConfig: {
              providerConfigRules: { providerRules: [] },
              modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            },
            accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
            credentials: [],
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      } finally {
        close();
      }
    },
    /**
     * 端到端跑一次真实同步（A 的 Source → ws 通道 → B 的 Target），
     * 断言用户真正关心的结果：屏障是否放行（status applied/already-applied）。
     * 两侧数据都在临时目录，不触碰任何真实 Provider 配置与凭据。
     */
    async syncOnce(): Promise<string> {
      const { client, close } = await connect("desktop-continuous");
      try {
        // 源侧：另起一个隔离环境的真实 Source（等价于 A 自己的 provider 事实）。
        const sourceDir = mkdtempSync(join(tmpdir(), "zcode-provisioning-source-"));
        const previousSourceDataDir = servicesModule.getDataBaseDir();
        servicesModule.setDataBaseDir(sourceDir);
        let envelope;
        try {
          const sourceServices = await servicesModule.createLocalServices({
            zcodeBuiltinProviderConfigFilePath: join(
              repoRoot,
              "config/provider/zcode-builtin.json",
            ),
            serviceAuthorityMode: "desktop-local",
          });
          envelope = await servicesModule
            .getProviderProvisioningSource(sourceServices)
            .read(`regression-${Date.now()}`);
          await servicesModule.disposeServiceResourcesAndWait?.(sourceServices);
        } finally {
          servicesModule.setDataBaseDir(previousSourceDataDir);
          rmSync(sourceDir, { recursive: true, force: true });
        }

        const target = new clientModule.RemoteServiceAccess(client)
          .providerProvisioningTargetService;
        const result = await target.apply(envelope);
        return result.status;
      } finally {
        close();
      }
    },
    async dispose(): Promise<void> {
      try {
        server?.close();
      } catch {
        /* 已关闭 */
      }
      await servicesModule.disposeServiceResourcesAndWait?.(services);
      servicesModule.setDataBaseDir(previousDataDir);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("窗口 host（desktop-local）挂载面提供 provider-provisioning-target", async () => {
  const host = await startLoopbackHost("desktop-local");
  try {
    // 这是 ADR 0003 之后的真实形态：窗口 host 兼常驻主机，A 经 /ws/host 挂载。
    assert.equal(
      await host.probe("desktop-continuous"),
      "channel-present",
      "desktop-local 的挂载面缺少 provider-provisioning-target —— 远程连接的首次同步屏障会失败，" +
        "表现为「Provider Provisioning 首次同步失败 (failed)」，整个 remote workspace 建不起来",
    );
  } finally {
    await host.dispose();
  }
});

test("独立常驻主机（desktop-attached-remote）挂载面提供 provider-provisioning-target", async () => {
  const host = await startLoopbackHost("desktop-attached-remote");
  try {
    assert.equal(await host.probe("desktop-continuous"), "channel-present");
  } finally {
    await host.dispose();
  }
});

test("web-remote-replayable 连接拿不到真实 target（凭据写接口信任边界）", async () => {
  const host = await startLoopbackHost("desktop-local");
  try {
    // 手机/Web 远控走 replayable。即使 channel 名可见，也不能拿到会写凭据的真实实现：
    // 允许的情形是「渠道存在但被 stub 拦截」（Method not found 之下的 apply 抛错），
    // 绝不允许「拿到真实 target」。
    const verdict = await host.probe("web-remote-replayable");
    assert.notEqual(
      verdict,
      `unexpected: probe unexpectedly succeeded`,
      "replayable 连接不应拿到可用 target",
    );
    assert.ok(
      verdict === "channel-present" || verdict === "channel-missing",
      `replayable 探测结果异常：${verdict}`,
    );
  } finally {
    await host.dispose();
  }
});

test("非受信连接即使拿到频道名也写不进去（信任边界的真正保证）", async () => {
  const host = await startLoopbackHost("desktop-local");
  try {
    // 上一条只验证「探测不到通道」，这里是更强的断言：直接对 replayable 连接调真实的
    // apply 方法名（空 envelope），必须被桩拒绝。空 envelope 只会打到桩上，
    // 不会落到真实 target（后者才会按 allowlist 改动配置与凭据）。
    const error = await host.applyAsUntrusted();
    assert.ok(
      error !== null,
      "replayable 连接必须被桩拒绝，不能写入 Provisioning（拿到了可用 target 才是缺陷）",
    );
    assert.match(error ?? "", /仅支持受信 Desktop Host/);
  } finally {
    await host.dispose();
  }
});

test("端到端：桌面挂载的首次同步屏障放行（用户可见症状）", async () => {
  const host = await startLoopbackHost("desktop-local");
  try {
    const status = await host.syncOnce();
    // 一条断言同时锁两件事：屏障放行 + 取消后不写配置。这里走的是**真通道上的真实 target**，
    // 能兜住「单测里 target 被换成桩」的情形。
    //   failed / unsupported → 用户看到的「Provider Provisioning 首次同步失败」（连接建不起来）
    //   applied             → 模型配置同步又被打开了，那是整份覆盖对端配置的事故入口
    assert.equal(
      status,
      "already-applied",
      `期望「屏障放行且未写配置」，实际 status=${status}`,
    );
  } finally {
    await host.dispose();
  }
});
