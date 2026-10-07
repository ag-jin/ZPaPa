#!/usr/bin/env node
/**
 * 验收（层 3 · 跨机写带回滚）：对投射条目的写操作不污染对端索引。
 *
 * 背景（真实缺陷，实测复现）：用户对投射出来的条目做置顶/归档/删除时，A 会把
 * 自己为远程工作区起的隔离标签（`remote:ssh:...:path`）原样发给 B 的 taskService。
 * B 从未写过这个键，于是落库成一条**永远不该存在的重复行** —— 用户看到同一会话
 * 在设备列表里出现两次。修复前实测 B 的 tasks-index 里留有 2 条这样的行：
 *
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_8c8af48f-...
 *   remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_e38c8742-...
 *
 * 本脚本验证修复：走 host Controller 的真实写路径（mutateTask）操作一个**自己
 * 新建的一次性会话**，然后直接读对端库断言该会话只有一条、且键不含本端 identity。
 *
 * 数据安全（严格遵守）：
 *   - 只操作本脚本自己新建的会话（护栏 assertTestOwnedTarget），绝不碰用户会话。
 *   - 写操作只有 pin/unpin（可逆，不改内容），结尾归档并复原。
 *   - 断言全部为只读库查询。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-write-path-isolation.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { IZCodeTaskService, ServiceCollection } from "@zcode/services";
import { assertTestOwnedTarget, buildTestSessionTitle } from "./support/testIsolation.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEVICE_HOST = process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2";
const DEVICE_USER = process.env.ZPAPA_DEVICE_USER ?? "linguojin";
// 探针专用项目：优先用配置的项目；用不到时退化为设备上的默认工作区。
const PROJECT_PATH = process.env.ZPAPA_PROJECT_PATH ?? "/Volumes/数据盘/网站/新赛马";
const remoteIdentity = `remote:ssh:${DEVICE_HOST}:22:${DEVICE_USER}:${PROJECT_PATH}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const { connectResidentRemote } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
  import.meta.url,
);
const { createRemoteBackend } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
  import.meta.url,
);
const { createWindowHostControllerRuntime } = await tsImport(
  pathToFileURL(join(repoRoot, "packages/desktop/src/host/windowHostControllerService.ts")).href,
  import.meta.url,
);

const backend = await createRemoteBackend({
  kind: "ssh",
  host: DEVICE_HOST,
  port: 22,
  username: DEVICE_USER,
  privateKeyPath: process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac"),
});
const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
if (!connection) {
  console.error("❌ 挂载 B 的常驻主机失败");
  process.exit(1);
}
console.log("已挂载 B 的常驻主机\n");

/** 直接读对端库里某会话的某一列（只读，交叉验证"写操作真的落库"，而不是只看返回值）。 */
async function readRemoteColumn(taskId: string, column: string): Promise<string | null> {
  const sql = `select coalesce(${column},'') from tasks where task_id='${taskId}' limit 1;`;
  const dbPath = `$HOME/.zcode/v2/tasks-index.sqlite`;
  const stream = await backend.exec(`sqlite3 ${dbPath} ${JSON.stringify(sql)}`);
  let out = "";
  for await (const chunk of stream.stdout) out += chunk.toString();
  const value = out.trim();
  return value.length > 0 ? value : null;
}

/** 直接读对端库统计某会话的索引行（只读，交叉验证代理层返回值）。 */
async function countRemoteRowsFor(taskId: string): Promise<{ rows: string[] }> {
  const sql = `select workspace_key from tasks where task_id='${taskId}';`;
  const dbPath = `$HOME/.zcode/v2/tasks-index.sqlite`;
  const stream = await backend.exec(`sqlite3 ${dbPath} ${JSON.stringify(sql)}`);
  let out = "";
  for await (const chunk of stream.stdout) out += chunk.toString();
  const rows = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { rows };
}

// ── 建一次性测试会话（唯一允许被写的对象）──
//
// 建会话时**不带本端 identity**：对端按自己的键落库是这个脚本要断言的正确形态
// （带 identity 会在对端多出一行 `remote:...`，那是尚未修的 V4/createTask 泄漏，
// 见 .agents/plans/finding-cross-machine-identity-write-verification.md）。
console.log("=== 建一次性测试会话（唯一被写对象）===");
const created = await connection.services.zcodeTaskService.createTask({
  workspacePath: PROJECT_PATH,
  v4Create: true,
});
const testSessionId = created.taskId as string;
const createdSessionIds = new Set<string>([testSessionId]);
console.log(`  会话: ${testSessionId}`);

// 打上可识别标题，便于在对端审计与事后清理（只改自己刚建的这一个）。
// createTask 不接受 title，用 renameTask；`remoteIdentity` 这里**刻意不传** ——
// 传了就是本脚本要防止的那类泄漏。
const testTitle = buildTestSessionTitle("write-path-isolation");
try {
  await connection.services.zcodeTaskService.renameTask({
    taskId: testSessionId,
    workspacePath: PROJECT_PATH,
    title: testTitle,
  });
} catch (error) {
  console.log(
    `  ⚠️ 重命名失败（不影响断言）: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// 基线：建会话不该产生 remote: 前缀行（对端只按自己的键记一次）
const baseline = await countRemoteRowsFor(testSessionId);
console.log(`  对端索引行数（基线）: ${baseline.rows.length}`);
for (const row of baseline.rows) console.log(`    ${row}`);
check(
  "I1 建会话后，对端索引里该会话只有一条、且不含本端 identity",
  baseline.rows.length === 1 && !baseline.rows[0]?.startsWith("remote:"),
  `实际 ${baseline.rows.length} 行: ${baseline.rows.join(" | ")}`,
);

// ── 走真实 Controller 写路径：pin → unpin ──
const runtime = createWindowHostControllerRuntime({
  createId: (() => {
    let n = 0;
    return () => `wp-${++n}`;
  })(),
  resolveSource: (scope: { workspaceIdentity?: string }) => {
    if (scope.workspaceIdentity !== remoteIdentity) return null;
    return {
      scope: {
        kind: "remote",
        remoteSessionId: "write-path-check",
        workspacePath: PROJECT_PATH,
        workspaceIdentity: remoteIdentity,
      },
      taskService: connection.services.zcodeTaskService,
      sourceAvailability: "online",
    };
  },
});

// 地址必须经 resolveTaskAddress 解析得到（这正是 UI 的 route() 路径：先按 scope 解析
// 出唯一 source、顺带登记投影行，再 mutate）。直接手拼 address 会因投影里没有 source
// 而以「没有与任务地址匹配的 source」失败 —— 那是夹具问题，不是被测行为。
let address: Record<string, unknown>;
try {
  address = await runtime.resolveTaskAddress({
    taskId: testSessionId,
    workspacePath: PROJECT_PATH,
    workspaceIdentity: remoteIdentity,
    attachmentScope: {
      kind: "remote",
      remoteSessionId: "write-path-check",
      workspacePath: PROJECT_PATH,
      workspaceIdentity: remoteIdentity,
    },
  });
} catch (error) {
  address = {
    taskId: testSessionId,
    workspacePath: PROJECT_PATH,
    workspaceIdentity: remoteIdentity,
    remoteSessionId: "write-path-check",
  };
  console.log(
    `  ⚠️ resolveTaskAddress 异常: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const guard = assertTestOwnedTarget({
  taskId: testSessionId,
  createdSessionIds,
  operation: "mutateTask(pin)",
});
if (!guard.allowed) {
  console.error(`❌ ${guard.reason}`);
  await connection.disposeAndWait({ timeoutMs: 5_000 });
  process.exit(1);
}

console.log("\n=== 走真实 Controller 写路径：pin → unpin ===");
let pinnedInPeerDb: string | null = null;
let unpinnedInPeerDb: string | null = null;
try {
  const pinned = await runtime.service.mutateTask({
    address: address as never,
    mutation: { kind: "pin", pinned: true } as never,
  });
  console.log(
    `  pin 返回: ${pinned ? `pinned=${(pinned as { pinned?: boolean }).pinned}` : "null"}`,
  );
  // 返回值只说明代理层；写操作是否真的落到对端要看对端的库。
  pinnedInPeerDb = await readRemoteColumn(testSessionId, "pinned");

  const unpinned = await runtime.service.mutateTask({
    address: address as never,
    mutation: { kind: "pin", pinned: false } as never,
  });
  console.log(
    `  unpin 返回: ${unpinned ? `pinned=${(unpinned as { pinned?: boolean }).pinned}` : "null"}`,
  );
  unpinnedInPeerDb = await readRemoteColumn(testSessionId, "pinned");
} catch (error) {
  console.log(
    `  ⚠️ mutateTask 调用异常: ${error instanceof Error ? error.message : String(error)}`,
  );
}
check("I5 pin 真的写进对端库（pinned=1）", pinnedInPeerDb === "1", `对端 pinned=${pinnedInPeerDb}`);
check(
  "I6 unpin 后对端库回到 pinned=0",
  unpinnedInPeerDb === "0",
  `对端 pinned=${unpinnedInPeerDb}`,
);

// 关键断言：写操作之后，对端库里该会话**仍然只有一条**、且不含本端 identity。
const after = await countRemoteRowsFor(testSessionId);
console.log(`\n=== 写操作后的对端索引行 ===`);
console.log(`  行数: ${after.rows.length}`);
for (const row of after.rows) console.log(`    ${row}`);

const leaked = after.rows.filter((row) => row.startsWith("remote:"));
check(
  "I2 写操作后对端索引无本端 identity 行（修复的写路径不泄漏）",
  leaked.length === 0,
  leaked.length === 0 ? "0 条泄漏" : `${leaked.length} 条: ${leaked.join(" | ")}`,
);
check(
  "I3 写操作后该会话仍只有一条索引行（无重复键）",
  after.rows.length === 1,
  `实际 ${after.rows.length} 行`,
);
check(
  "I4 对端索引键是设备自己的纯项目路径",
  after.rows.length === 1 && after.rows[0] === PROJECT_PATH,
  `实际键: ${after.rows.join(" | ")}`,
);

// ── J 段：跨项目写作用域（同一设备上另一个项目；实机缺陷 2026-10-03）──
//
// 一台被投射设备只有一个 logical session，而投射端只有一份设备级 services；绑定
// 曾按单值覆盖，于是对"非当前绑定项目"的会话做归档会被 resolveTaskAddress 以
// 「列表 mutation 与 remote attachment scope 不匹配」拒绝（实机：archiveTask 0 成功 /
// 2 失败，setTaskUnread 253 失败 / 10 成功）。
//
// 本段用**真实 registry + 真实 resolveRemoteControllerSource + 真实设备**复现该场景，
// 断言修复后写操作能到达对端并以对端自己的键落库。
const OTHER_PROJECT_PATH = process.env.ZPAPA_PROJECT_PATH_2 ?? "/Volumes/数据盘/网站/通通赛马";
const otherIdentity = `remote:ssh:${DEVICE_HOST}:22:${DEVICE_USER}:${OTHER_PROJECT_PATH}`;

async function projectExistsOnDevice(projectPath: string): Promise<boolean> {
  const stream = await backend.exec(
    `test -d ${JSON.stringify(projectPath)} && echo yes || echo no`,
  );
  let out = "";
  for await (const chunk of stream.stdout) out += chunk.toString();
  return out.trim() === "yes";
}

let otherTaskId: string | null = null;
if (!(await projectExistsOnDevice(OTHER_PROJECT_PATH))) {
  console.log(
    `\n⚠️ 跳过 J 段：设备上不存在 ${OTHER_PROJECT_PATH}（可用 ZPAPA_PROJECT_PATH_2 指定）`,
  );
} else {
  const { createWindowRemoteConnectionRegistry } = await tsImport(
    pathToFileURL(join(repoRoot, "packages/desktop/src/host/windowRemoteConnectionRegistry.ts"))
      .href,
    import.meta.url,
  );
  const { resolveRemoteControllerSource } = await tsImport(
    pathToFileURL(join(repoRoot, "packages/desktop/src/host/windowRemoteControllerSource.ts")).href,
    import.meta.url,
  );

  console.log("\n=== J 段：跨项目写作用域（设备绑定 A 项目，归档 B 项目的会话）===");
  const createdOther = await connection.services.zcodeTaskService.createTask({
    workspacePath: OTHER_PROJECT_PATH,
    v4Create: true,
  });
  otherTaskId = createdOther.taskId as string;
  createdSessionIds.add(otherTaskId);
  console.log(`  B 项目一次性会话: ${otherTaskId}`);
  await connection.services.zcodeTaskService
    .renameTask({
      taskId: otherTaskId,
      workspacePath: OTHER_PROJECT_PATH,
      title: buildTestSessionTitle("cross-project-scope"),
    })
    .catch((error: unknown) =>
      console.log(
        `  ⚠️ 重命名失败（不影响断言）: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );

  const otherGuard = assertTestOwnedTarget({
    taskId: otherTaskId,
    createdSessionIds,
    operation: "cross-project archive",
  });
  if (!otherGuard.allowed) {
    console.error(`❌ ${otherGuard.reason}`);
  } else {
    // 真实 registry 的 TServices 在 host 里是 ServiceCollection（Controller 靠
    // services.get(IZCodeTaskService) 取对端 taskService），这里按同一形状包一层。
    const peerServices = new ServiceCollection().register(
      IZCodeTaskService,
      connection.services.zcodeTaskService,
    );
    // 真实 registry：一个 logical session，先后绑定两个项目（bind 是"增加"不是"覆盖"）。
    const registry = createWindowRemoteConnectionRegistry({
      createId: () => "cross-project-write-scope",
      connect: async () => ({
        services: peerServices,
        dispose: () => undefined,
      }),
    });
    const descriptor = await registry.connect({
      requestId: "cross-project-write-scope",
      target: {
        kind: "ssh",
        host: DEVICE_HOST,
        port: 22,
        username: DEVICE_USER,
        privateKeyPath: process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac"),
      },
      remoteAssets: {},
      workspacePath: OTHER_PROJECT_PATH,
      workspaceIdentity: otherIdentity,
    });
    const remoteSessionId = descriptor.remoteSessionId as string;
    // 设备此刻"当前绑定"切回 A 项目 —— 这就是单值覆盖会丢掉 B 项目的历史的那一步。
    await registry.bindWorkspaceContext({
      remoteSessionId,
      workspacePath: PROJECT_PATH,
      workspaceIdentity: remoteIdentity,
    });

    const scopeRuntime = createWindowHostControllerRuntime({
      createId: (() => {
        let n = 0;
        return () => `j-${++n}`;
      })(),
      resolveSource: (scope: { workspacePath: string; workspaceIdentity?: string }) =>
        resolveRemoteControllerSource({ scope, registry }),
    });

    try {
      const scopedAddress = await scopeRuntime.resolveTaskAddress({
        taskId: otherTaskId,
        workspacePath: OTHER_PROJECT_PATH,
        workspaceIdentity: otherIdentity,
        attachmentScope: {
          kind: "remote",
          remoteSessionId,
          workspacePath: PROJECT_PATH,
          workspaceIdentity: remoteIdentity,
        },
      });
      const scopedMeta = await scopeRuntime.service.mutateTask({
        address: scopedAddress as never,
        mutation: { kind: "archive", archived: true } as never,
      });
      check(
        "J1 设备当前绑定 A 项目时，归档 B 项目的会话成功返回 meta",
        scopedMeta != null,
        scopedMeta == null ? "返回 null（UI 会报『归档 mutation 后 task 投影缺失』）" : "",
      );
    } catch (error) {
      check(
        "J1 设备当前绑定 A 项目时，归档 B 项目的会话成功返回 meta",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }

    const otherRows = await countRemoteRowsFor(otherTaskId);
    check(
      "J2 对端索引仍只有一条、键为设备自己的纯路径（无本端 identity 泄漏）",
      otherRows.rows.length === 1 && otherRows.rows[0] === OTHER_PROJECT_PATH,
      `实际 ${otherRows.rows.length} 行: ${otherRows.rows.join(" | ")}`,
    );
    const stillDefault = (
      await connection.services.zcodeTaskService.listTasks({ workspacePath: OTHER_PROJECT_PATH })
    ).some((task: { taskId: string }) => task.taskId === otherTaskId);
    check("J3 归档后该会话已从对端默认列表移除", !stillDefault, stillDefault ? "仍在默认列表" : "");
  }
}

// ── 清理：归档两个一次性会话，不给设备列表留垃圾 ──
console.log("\n=== 清理 ===");
for (const target of [
  { taskId: testSessionId, workspacePath: PROJECT_PATH },
  ...(otherTaskId ? [{ taskId: otherTaskId, workspacePath: OTHER_PROJECT_PATH }] : []),
]) {
  try {
    await connection.services.zcodeTaskService.archiveTask(target);
    console.log(`  已归档测试会话 ${target.taskId}`);
  } catch (error) {
    console.log(
      `  ⚠️ 归档失败（需手工清理）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await connection.disposeAndWait({ timeoutMs: 5_000 });

console.log("\n=== 验收结论（写路径隔离 + 跨项目作用域）===");
if (failures === 0) {
  console.log("I1 建会话不产生 remote 前缀行 ✅");
  console.log("I2 写操作不泄漏本端 identity ✅");
  console.log("I3 无重复索引键 ✅");
  console.log("I4 对端键为自身路径 ✅");
  console.log("I5/I6 pin 往返真的落到对端库 ✅");
  if (otherTaskId) {
    console.log("J1 非当前绑定项目的归档能到达对端 ✅");
    console.log("J2 对端键为自身路径、无泄漏 ✅");
    console.log("J3 归档后移出对端默认列表 ✅");
  }
  console.log("全部通过 ✅");
} else {
  console.log(`存在 ${failures} 项失败 ❌`);
}
process.exit(failures === 0 ? 0 : 1);
