#!/usr/bin/env node
/**
 * 远程设备投射 · 三层回归跑器（工单 07）。
 *
 * 把探索期沉淀的验证手段按「接缝层级」固定下来，每层能独立跑、独立判成败：
 *
 *   层 1 · 纯函数/契约（无设备、无网络）
 *     判定与投影逻辑的契约。秒级完成，改任何一层都能先跑这层。
 *         node scripts/remote/regression.mjs --layer=1
 *
 *   层 2 · 跨机只读（需 B 在线）
 *     真实设备上的数据面：连得上、读得到、投射端不留痕。全程只读。
 *         node scripts/remote/regression.mjs --layer=2
 *
 *   层 3 · 跨机写带回滚（需 B 在线；会写对端）
 *     写路径的隔离与可用性。只操作自建的一次性会话，结束归档。
 *         node scripts/remote/regression.mjs --layer=3
 *
 * 不带 --layer 时跑 1 + 2（默认不跑写测试：需要显式同意才动对端数据）。
 * 跑全部三层：--layer=all（等价于显式同意写对端的一次性测试会话）。
 *
 * 为什么分三层：写测试与只读测试的风险不同 —— 只读测试可以随便跑，写测试必须
 * 是有意识的动作。层级把"要不要动对端数据"变成调用方显式的选择，而不是默认。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");

/** 一个测试项：跑什么、属于哪层、要多久、是否写对端。 */
const SUITES = [
  // ── 层 1：纯函数与契约（无设备）──
  {
    layer: 1,
    id: "loopback-preview",
    title: "回环预览判定（工单 08 判定层）",
    cwd: "packages/ui",
    file: "test/remoteLoopbackPreview.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "projection-sync",
    title: "投射同步差异计算（工单 04 数据面）",
    cwd: "packages/ui",
    file: "test/remoteDeviceProjection.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "tab-lifecycle-decoupling",
    title: "关投射 tab 不断连（连接归设备所有）",
    cwd: "packages/ui",
    file: "test/remoteTabLifecycleDecoupling.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "device-record-merge",
    title: "设备记录合并写不丢 visibleProjects",
    cwd: "packages/ui",
    file: "test/deviceRecordMerge.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "device-identity-rule",
    title: "设备身份口径全仓一致（deviceKey 与 isSameDeviceTarget 同判）",
    cwd: "packages/ui",
    file: "test/deviceIdentityRule.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "device-access",
    title: "设备访问与项目清单并集（工单 02/03）",
    cwd: "packages/ui",
    file: "test/remoteDeviceAccess.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "scope-contract",
    title: "远程 scope 构造契约（identity 必需）",
    cwd: "packages/ui",
    file: "test/remoteScopeContract.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "device-persistence",
    title: "设备配置独立于 tab 持久化",
    cwd: "packages/ui",
    file: "test/remoteDevicePersistence.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "write-path-isolation",
    title: "写路径不发本端 identity 给对端（本轮修的缺陷）",
    cwd: "packages/desktop",
    file: "test/writePathIdentityIsolation.test.ts",
  },
  {
    layer: 1,
    id: "remote-visibility",
    title: "远程 source 只按对端键查询（读路径隔离）",
    cwd: "packages/desktop",
    file: "test/remoteSessionVisibility.test.ts",
  },
  {
    layer: 1,
    id: "multi-project-write-scope",
    title: "同设备多项目写作用域矩阵（穷举 24 格，含 fail-closed）",
    cwd: "packages/desktop",
    file: "test/remoteMultiProjectWriteScope.test.ts",
  },
  {
    layer: 1,
    id: "device-workspace-bindings",
    title: "设备 workspace 绑定按列表存（绑过不丢 / 未绑定必拒）",
    cwd: "packages/desktop",
    file: "test/remoteDeviceWorkspaceBindings.test.ts",
  },
  {
    layer: 1,
    id: "device-config-store",
    title: "设备配置独立文件存储与坏数据容错",
    cwd: "packages/desktop",
    file: "test/acceptance-device-config-store.ts",
  },
  {
    layer: 1,
    id: "dynamic-workflow-mode-env",
    title: "工作流灰度落值（打包档位必须写「开」，否则整块能力静默消失）",
    cwd: "packages/desktop",
    file: "test/dynamicWorkflowModeHostEnv.test.ts",
  },
  {
    layer: 1,
    id: "tail-parts-ordering",
    title: "会话尾部窗口的 parts 截断不变量（按需加载）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-tail-parts-ordering.ts",
  },
  {
    layer: 1,
    id: "provisioning-channel",
    title: "挂载面提供 provisioning target（首次同步屏障的前提）",
    cwd: ".",
    file: "packages/desktop/test/providerProvisioningChannel.test.ts",
  },
  {
    layer: 1,
    id: "projection-keep-focus",
    title: "从设置页连接不抢焦点（条目进侧栏，设置页不被卸载）",
    cwd: "packages/ui",
    file: "test/projectionKeepFocus.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "provisioning-sync-cancelled",
    title: "模型配置同步保持取消（目标端零依赖触碰、发起端零推送）",
    cwd: ".",
    file: "packages/desktop/test/providerProvisioningSyncCancelled.test.ts",
  },
  {
    layer: 1,
    id: "timeline-scroll-anchor",
    title: "会话按需加载的位置不变式（预取来源门/回放取消/前插平移三段）",
    cwd: "packages/ui",
    file: "test/timelineScrollAnchor.test.ts",
    usesTsconfigPaths: true,
  },
  {
    layer: 1,
    id: "conversation-load-budget",
    title: "长会话打开/切换的加载预算（首 turn 补窗上限 + 目录按需）",
    cwd: "packages/ui",
    file: "test/conversationLoadBudget.test.ts",
    usesTsconfigPaths: true,
  },

  // ── 层 2：跨机只读（需 B 在线）──
  {
    layer: 2,
    id: "index-isolation",
    title: "两端索引隔离不变量（投射端无远程前缀行）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-index-isolation.ts",
  },
  {
    layer: 2,
    id: "device-access-cross",
    title: "真实设备上的设备访问与项目清单",
    cwd: ".",
    file: "packages/desktop/test/acceptance-device-access.ts",
  },
  {
    layer: 2,
    id: "projection-sync-cross",
    title: "真实设备数据上的投射同步",
    cwd: ".",
    file: "packages/desktop/test/acceptance-projection-sync.ts",
  },
  {
    layer: 2,
    id: "loopback-tunnel",
    title: "回环预览隧道端到端（只读 GET）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-loopback-tunnel.ts",
  },
  {
    layer: 2,
    id: "device-lifecycle",
    title: "设备连接的完整生命周期（读配置→连接→访问→投射）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-device-lifecycle.ts",
  },
  {
    layer: 2,
    id: "resident-exposure",
    title: "设备暴露面可挂载（单一运行时的前提，ADR 0003）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-resident-exposure.ts",
  },
  {
    layer: 2,
    id: "device-topology",
    title: "设备侧 host/runtime 拓扑体检（双 host 分裂检测）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-device-topology.ts",
  },
  {
    layer: 2,
    id: "visibility-cross",
    title: "远程会话可见性（host Controller 全链路）",
    cwd: ".",
    file: "packages/desktop/test/e2e-remote-visibility.ts",
  },

  // ── 层 3：跨机写带回滚（需 B 在线；写对端自建会话）──
  {
    layer: 3,
    id: "write-path-cross",
    title: "写路径隔离（自建会话 + 归档清理）",
    cwd: ".",
    file: "packages/desktop/test/acceptance-write-path-isolation.ts",
  },
];

const args = process.argv.slice(2);
const layerArg = args.find((arg) => arg.startsWith("--layer="))?.split("=")[1] ?? "1,2";
const onlyArg = args.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const listOnly = args.includes("--list");

const layers =
  layerArg === "all"
    ? new Set([1, 2, 3])
    : new Set(
        layerArg
          .split(",")
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isInteger(value)),
      );

let suites = SUITES.filter((suite) => layers.has(suite.layer));
if (onlyArg) {
  suites = suites.filter((suite) => suite.id === onlyArg || suite.title.includes(onlyArg));
}

if (listOnly) {
  for (const suite of suites) {
    console.log(`层 ${suite.layer}  ${suite.id.padEnd(24)} ${suite.title}`);
    console.log(`         ${suite.cwd === "." ? "" : suite.cwd + "/"}${suite.file}`);
  }
  process.exit(0);
}

if (suites.length === 0) {
  console.error(`没有匹配的测试项（--layer=${layerArg}${onlyArg ? ` --only=${onlyArg}` : ""}）`);
  process.exit(1);
}

/** 跨机层需要设备可达；不可达时明确跳过而不是假装失败。 */
async function deviceReachable(host) {
  return new Promise((resolve) => {
    const probe = spawn("nc", ["-z", "-w", "4", host, "22"], { stdio: "ignore" });
    probe.on("close", (code) => resolve(code === 0));
    probe.on("error", () => resolve(false));
  });
}

const DEVICE_HOST = process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2";
const needsDevice = suites.some((suite) => suite.layer >= 2);
if (needsDevice && !(await deviceReachable(DEVICE_HOST))) {
  console.error(
    `\n❌ 跨机层需要设备 ${DEVICE_HOST}:22 可达（Tailscale 上的被投射端未在线？）\n` +
      `   只跑层 1：node scripts/remote/regression.mjs --layer=1\n`,
  );
  process.exit(1);
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", suite.file], {
      cwd: join(repoRoot, suite.cwd),
      env: {
        ...process.env,
        // ui 包内测试直接 import src，靠 `@/*` 别名解析；tsx 从 tsconfig 的 paths 取值。
        ...(suite.usesTsconfigPaths ? { TSX_TSCONFIG_PATH: "tsconfig.test.json" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

/** 从 node:test 的输出里取 pass/fail；非 node:test 脚本退化为按退出码判断。 */
function summarize(stdout) {
  const pass = /^ℹ pass (\d+)$/m.exec(stdout);
  const fail = /^ℹ fail (\d+)$/m.exec(stdout);
  if (pass) return { pass: Number(pass[1]), fail: fail ? Number(fail[1]) : 0 };
  return null;
}

console.log(`\n远程设备投射 · 回归（层 ${[...layers].sort().join("、")}）`);
console.log(`仓库: ${repoRoot}\n`);

// 先确认每个测试文件都在，避免"跑了个不存在的脚本却算通过"。
const missing = suites.filter((suite) => !existsSync(join(repoRoot, suite.cwd, suite.file)));
if (missing.length > 0) {
  console.error(`❌ 测试文件不存在:`);
  for (const suite of missing) {
    console.error(`   ${join(suite.cwd, suite.file)}  （${suite.id}）`);
  }
  process.exit(1);
}

const results = [];
for (const suite of suites) {
  process.stdout.write(`▸ 层 ${suite.layer} · ${suite.title} … `);
  const result = await runSuite(suite);
  const summary = summarize(result.stdout);
  const ok = result.code === 0;
  results.push({ suite, result, summary, ok });
  const took = `${(result.elapsedMs / 1000).toFixed(1)}s`;
  console.log(
    ok
      ? `✅ ${summary ? `(${summary.pass} 通过) ` : ""}${took}`
      : `❌ 退出码 ${result.code} ${took}`,
  );
  if (!ok) {
    const detail = (result.stdout + result.stderr)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-14)
      .join("\n      ");
    console.log(`      ${detail}`);
  }
}

const failed = results.filter((entry) => !entry.ok);
const passed = results.length - failed.length;

console.log(`\n═══ 汇总 ═══`);
console.log(`通过 ${passed}/${results.length}`);
console.log(`层 1（纯函数/契约）: ${results.filter((r) => r.suite.layer === 1).length} 项`);
console.log(`层 2（跨机只读）:    ${results.filter((r) => r.suite.layer === 2).length} 项`);
const layer3Ran = results.some((r) => r.suite.layer === 3);
if (layer3Ran) {
  console.log(
    `层 3（跨机写带回滚）: ${results.filter((r) => r.suite.layer === 3).length} 项（写了对端自建会话，已归档）`,
  );
} else {
  console.log(`层 3（跨机写带回滚）: 未跑（需显式 --layer=3 或 --layer=all）`);
}

if (failed.length > 0) {
  console.log(`\n失败项:`);
  for (const entry of failed) {
    console.log(`  ❌ ${entry.suite.title}（${entry.suite.id}）`);
  }
  process.exit(1);
}
console.log(`\n全部通过 ✅`);
