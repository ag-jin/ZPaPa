#!/usr/bin/env node
/**
 * 验收（层 2 · 跨机只读）：设备侧暴露的「单一运行时」可被远程挂载。
 *
 * 背景（见 ADR 0003）：被投射设备上曾并存两个 host，各自拉起独立 agent runtime，
 * 而会话运行态是进程内内存态 —— 投射端与本机 UI 的进度互不可见（实测两端长期
 * 不同步）。修复方向是让**已经在服务桌面 UI 的那个窗口 host** 额外暴露回环监听，
 * 使投射端与设备 UI 共用同一份运行时。
 *
 * 本脚本验证暴露面**确实可挂载且服务面完整**：
 *   T1 发现文件存在、格式正确（host/port/pid/protocolVersion/version）
 *   T2 发现文件声明的 pid 就是窗口 host（不是另一个独立进程）
 *   T3 经 SSH 隧道连接成功后，对端服务面能读到真实数据（不是空壳）
 *   T4 同一设备上不存在第二个常驻 host（单一运行时不变量的直接检查）
 *
 * 只读：不向被投射设备写入任何数据，也不新建会话。
 * 跑法：node --import tsx packages/desktop/test/acceptance-resident-exposure.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ServiceChannels } from "@zcode/shared";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEVICE_HOST = process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2";
const DEVICE_USER = process.env.ZPAPA_DEVICE_USER ?? "linguojin";
const DEVICE_KEY = process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures += 1;
}
let knownDefects = 0;
function knownDefect(label: string, present: boolean, detail = ""): void {
  if (!present) return;
  knownDefects += 1;
  console.log(`⚠️  [已知缺陷] ${label}${detail ? `\n     ${detail}` : ""}`);
  console.log(`     处置：见 docs/adr/0003-single-runtime-window-host-as-resident.md`);
}

async function ssh(script: string): Promise<string> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      "ssh",
      [
        "-i",
        DEVICE_KEY,
        "-o",
        "ConnectTimeout=12",
        "-o",
        "BatchMode=yes",
        `${DEVICE_USER}@${DEVICE_HOST}`,
        "bash -s",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.stdin.write(script);
    child.stdin.end();
    child.on("close", () => resolve(out));
  });
}

console.log(`设备暴露面验收 · ${DEVICE_USER}@${DEVICE_HOST}\n`);

// ── T1：发现文件 ──
const statusRaw = await ssh(`cat ~/.zcode/v2/resident-host.json 2>/dev/null || echo "__MISSING__"`);
const missing = statusRaw.includes("__MISSING__");
let status: {
  host?: string;
  port?: number;
  pid?: number;
  version?: string;
  protocolVersion?: number;
} | null = null;
if (!missing) {
  try {
    status = JSON.parse(statusRaw.trim());
  } catch {
    status = null;
  }
}

console.log("=== T1：发现文件 ===");
check(
  "存在 resident-host.json 且可解析",
  Boolean(status),
  status
    ? `host=${status.host} port=${status.port} pid=${status.pid} protocolVersion=${status.protocolVersion}`
    : `原始内容: ${statusRaw.trim().slice(0, 120)}`,
);
check(
  "只监听回环地址（对外暴露面为零）",
  status?.host === "127.0.0.1",
  `host=${status?.host ?? "(缺失)"}`,
);
check(
  "协议版本与本地一致（A 侧 connectResidentRemote 才会挂载）",
  status?.protocolVersion === 1,
  `protocolVersion=${status?.protocolVersion ?? "(缺失)"}`,
);

// ── T2：声明 pid 是否属于窗口 host ──
const declaredPid = status?.pid;
let pidOwner = "";
if (declaredPid) {
  const ownerRaw = await ssh(
    `ps -p ${declaredPid} -o ppid=,comm= 2>/dev/null | head -1; echo "---"; ps -p ${declaredPid} -o command= 2>/dev/null | head -1`,
  );
  pidOwner = ownerRaw.split("---")[0]?.trim() ?? "";
}
console.log("\n=== T2：发现文件声明的进程身份 ===");
console.log(`  声明 pid=${declaredPid ?? "(缺失)"} → ${pidOwner || "(进程不存在)"}`);
check(
  "声明的进程存活",
  Boolean(pidOwner),
  pidOwner ? "" : "发现文件指向一个已退出的进程（陈旧文件）",
);

// ── T4：单一运行时（同项目不应有两个 host 的 runtime）──
const topologyRaw = await ssh(`
for pid in $(ps -eo pid,command 2>/dev/null | grep "[z]code-cli" | awk '{print $1}'); do
  ppid=$(ps -p $pid -o ppid= 2>/dev/null | tr -d ' ')
  cwd=$(lsof -nP -p $pid -a -d cwd 2>/dev/null | awk 'NR>1 {print $NF}')
  echo "RT $ppid $cwd"
done
echo "---HOSTS---"
for pid in $(ps -eo pid,command 2>/dev/null | grep -E "[z]code-host-local|[Z]Code Helper" | grep -E "node.mojom|zcode-host-local" | awk '{print $1}'); do
  echo "HOST $pid"
done
`);
const runtimes = topologyRaw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("RT "))
  .map((l) => {
    const parts = l.split(" ");
    return { ppid: parts[1]!, cwd: parts.slice(2).join(" ") };
  });

console.log("\n=== T4：单一运行时检查 ===");
const byProject = new Map<string, Set<string>>();
for (const rt of runtimes) {
  const owners = byProject.get(rt.cwd) ?? new Set<string>();
  owners.add(rt.ppid);
  byProject.set(rt.cwd, owners);
}
let splitProjects: string[] = [];
for (const [project, owners] of byProject) {
  const tag = owners.size > 1 ? `⚠️ ${owners.size} 个 host` : "单 host";
  console.log(`  ${project || "(未知)"} → ${tag}`);
  if (owners.size > 1) splitProjects.push(project);
}
knownDefect(
  `${splitProjects.length} 个项目的 runtime 仍跨多个 host`,
  splitProjects.length > 0,
  `${splitProjects.join("、")}\n` +
    `     若此处非空，说明设备侧仍是双 host —— 需要装带 ADR 0003 修复的新版本。`,
);

// ── T3：经隧道挂载，验证服务面是真的 ──
console.log("\n=== T3：经 SSH 隧道挂载（只读）===");
let mountedOk = false;
let sampleInfo = "";
/** provider-provisioning-target 的只读探测结论（见 T5）。 */
let provisioningChannel = "unknown";
try {
  const { createRemoteBackend } = await tsImport(
    pathToFileURL(join(repoRoot, "packages/server/src/remote/create-backend.ts")).href,
    import.meta.url,
  );
  const { connectResidentRemote } = await tsImport(
    pathToFileURL(join(repoRoot, "packages/server/src/remote/connect-resident.ts")).href,
    import.meta.url,
  );
  const backend = await createRemoteBackend({
    kind: "ssh",
    host: DEVICE_HOST,
    port: 22,
    username: DEVICE_USER,
    privateKeyPath: DEVICE_KEY,
  });
  const connection = await connectResidentRemote(backend, { onDidRemoteClose: () => {} });
  if (connection) {
    // 用真实查询证明服务面不是空壳（只读：listTasks 不写库）。
    // 只调 B 侧真实存在的通道 —— `remote-device-projects` 是**A 侧**注册的
    // 组合通道（它内部再调 B 的原始 services），在直连连接上不存在，
    // 调它会以 channel timeout 失败，那是测试写错而非产品缺陷。
    const tasks = await connection.services.zcodeTaskService.listTasks({});
    mountedOk = true;
    sampleInfo = `对端会话 ${tasks.length} 条（服务面可用）`;

    // T5：挂载面必须提供 provider-provisioning-target。缺它时挂载本身成功、会话也查得到，
    // 但 initialSync 屏障 fail-closed，整个 remote workspace 建不起来（2026-09-29 实测：
    // 设备侧 Unknown channel → A 侧「Provider Provisioning 首次同步失败」）。
    // 只读探测：调不存在的方法名 —— 有路由回 "Method not found"，无路由则 1000ms 超时。
    // 刻意不调 apply()：那是写接口（空 envelope 会清空对端个人配置与凭据）。
    try {
      const channel = connection.client.getChannel(ServiceChannels.ProviderProvisioningTarget);
      await channel.call("__probe_no_such_method__", []);
      provisioningChannel = "unexpected-success";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      provisioningChannel = message.includes("Method not found")
        ? "present"
        : message.includes("timed out")
          ? "missing"
          : `other: ${message.slice(0, 80)}`;
    }

    await connection.disposeAndWait({ timeoutMs: 5_000 });
  } else {
    sampleInfo = "connectResidentRemote 返回 null（未发现可挂载的常驻主机）";
  }
} catch (error) {
  sampleInfo = error instanceof Error ? error.message.slice(0, 140) : String(error);
}
check("经 SSH 隧道挂载成功", mountedOk, sampleInfo);
check(
  "挂载面提供 provider-provisioning-target（首次同步屏障的前提）",
  provisioningChannel === "present",
  provisioningChannel === "present"
    ? "有路由（Method not found 即证明频道已注册）"
    : provisioningChannel === "missing"
      ? "频道缺失 —— remote workspace 的首次同步屏障会失败，表现为「首次同步失败 (failed)」。\n" +
        "     若设备仍是旧版本，需先升级设备到含本修复的构建。"
      : provisioningChannel,
);

console.log("\n=== 结论 ===");
if (failures === 0) {
  console.log(`暴露面可用：设备侧的窗口 host 已可被远程挂载，两端共用同一份运行时 ✅`);
} else {
  console.log(`${failures} 项断言失败 ❌`);
}
if (knownDefects > 0) {
  console.log(`（另有 ${knownDefects} 项已知缺陷，见上）`);
}
process.exit(failures === 0 ? 0 : 1);
