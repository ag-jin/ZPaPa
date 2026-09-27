#!/usr/bin/env node
/**
 * 验收（层 2 · 跨机只读）：远端设备的 host/runtime 拓扑体检。
 *
 * 背景（诊断见 .agents/plans/finding-dual-host-runtime-split.md）：
 * 被投射设备上可能存在**两个 host**，各自拉起独立的 agent runtime，而
 * runtime 的会话状态是**进程内内存态**（`context.sessions` 是每进程 Map，
 * resume 命中内存即早退、不重读库）。同一项目因此可能有多个 runtime 驻留，
 * 各自的进度互不可见 —— 用户表现为「A 跑了，B 的 UI 停在原地」。
 *
 * 本脚本只读，给出可复现的客观事实：
 *   T1 设备上存在哪些 host 进程（本机 host / 常驻主机）
 *   T2 每个 host 下拉起了哪些项目的 runtime
 *   T3 是否存在「同一项目被两个 host 同时持有 runtime」（分裂的直接证据）
 *   T4 重复 runtime 的资源代价（内存）
 *
 * 为什么需要它：设备侧的问题只能从设备侧取证，而 B 的桌面 UI 没有可远程
 * 读取的调试接口（实测不监听任何端口）。本脚本用 SSH + ps/lsof 取客观事实，
 * 不依赖 UI，因而可在用户离线时复现。
 *
 * 跑法：node --import tsx packages/desktop/test/acceptance-device-topology.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const DEVICE_HOST = process.env.ZPAPA_DEVICE_HOST ?? "100.66.1.2";
const DEVICE_USER = process.env.ZPAPA_DEVICE_USER ?? "linguojin";
const DEVICE_KEY = process.env.ZPAPA_DEVICE_KEY ?? join(homedir(), ".ssh/id_ed25519_imac");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function note(label: string, detail = ""): void {
  console.log(`ℹ ${label}${detail ? `\n     ${detail}` : ""}`);
}

/**
 * 已知缺陷（非新增回归）的专用报告口。
 *
 * 为什么不与 check 一样算失败：双 host 分裂是**已诊断、待架构决策**的问题
 * （见 finding-dual-host-runtime-split.md），不是需要立刻红的回归。若让它
 * 常红，跑器就失去"绿=没有新问题"的信号价值 —— 人会习惯性忽略红色。
 * 因此这里醒目提示并把处置指向 finding，但不让整条回归变红。
 */
let knownDefects = 0;
function knownDefect(label: string, present: boolean, detail = ""): void {
  if (!present) return;
  knownDefects += 1;
  console.log(`⚠️  [已知缺陷] ${label}${detail ? `\n     ${detail}` : ""}`);
  console.log(`     处置：见 .agents/plans/finding-dual-host-runtime-split.md`);
}

/** 在设备上跑一段 shell，返回 stdout。只读命令，不做任何写操作。 */
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
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.stdin.write(script);
    child.stdin.end();
    child.on("close", () => resolve(out + (err ? `\n[stderr] ${err}` : "")));
  });
}

console.log(`设备拓扑体检 · ${DEVICE_USER}@${DEVICE_HOST}\n`);

// ── T1：host 进程 ──
const hostRaw = await ssh(`
ps -eo pid,ppid,command | grep -E "[z]code-host-local|[Z]Code Helper" | grep -E "node.mojom|zcode-host-local" | while read pid ppid rest; do
  case "$rest" in
    *zcode-host-local*) echo "LOCAL $pid $ppid" ;;
    *node.mojom.NodeService*) echo "RESIDENT_OR_UTILITY $pid $ppid" ;;
  esac
done
echo "---"
cat ~/.zcode/v2/resident-host.json 2>/dev/null | tr -d ' \\n'
`);
const hostLines = hostRaw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("LOCAL ") || l.startsWith("RESIDENT_OR_UTILITY "));
const residentMatch = /"pid":(\d+)/.exec(hostRaw);
const residentPid = residentMatch?.[1];
const localHost = hostLines
  .filter((l) => l.startsWith("LOCAL "))
  .map((l) => ({ pid: l.split(" ")[1]!, ppid: l.split(" ")[2]! }));

console.log("=== T1：host 进程 ===");
check(
  "存在本机 host（B 的桌面 UI 使用）",
  localHost.length > 0,
  localHost.length > 0 ? `pid=${localHost.map((h) => h.pid).join(",")}` : "未找到 zcode-host-local",
);
check(
  "存在常驻主机（远程投射挂载用）",
  Boolean(residentPid),
  residentPid ? `pid=${residentPid}（resident-host.json 声明）` : "未在 resident-host.json 找到 pid",
);
const dualHost = localHost.length > 0 && Boolean(residentPid);
if (dualHost) {
  note(
    `两个 host 并存 —— runtime 会话状态是进程内内存态，因此两边的运行进度互不可见`,
    `本机 host pid=${localHost[0]!.pid} ／ 常驻主机 pid=${residentPid}`,
  );
}

// ── T2/T3：各 host 下的 runtime 分布 ──
const runtimeRaw = await ssh(`
for pid in $(ps -eo pid,command | grep "[z]code-cli" | awk '{print $1}'); do
  ppid=$(ps -p $pid -o ppid= 2>/dev/null | tr -d ' ')
  cwd=$(lsof -nP -p $pid -a -d cwd 2>/dev/null | awk 'NR>1 {print $NF}')
  rss=$(ps -p $pid -o rss= 2>/dev/null | tr -d ' ')
  echo "RT $pid $ppid $rss $cwd"
done
`);
const runtimes = runtimeRaw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("RT "))
  .map((l) => {
    const parts = l.split(" ");
    return { pid: parts[1]!, ppid: parts[2]!, rssKb: Number(parts[3] ?? 0), cwd: parts.slice(4).join(" ") };
  });

console.log("\n=== T2/T3：runtime 分布 ===");
const byProject = new Map<string, typeof runtimes>();
for (const rt of runtimes) {
  const list = byProject.get(rt.cwd);
  if (list) list.push(rt);
  else byProject.set(rt.cwd, [rt]);
}
const hostPids = new Set([...localHost.map((h) => h.pid), ...(residentPid ? [residentPid] : [])]);
let splitProjects: string[] = [];
for (const [project, list] of byProject) {
  const owners = new Set(list.map((rt) => rt.ppid));
  const spansTwoHosts = [...owners].filter((o) => hostPids.has(o)).length > 1;
  const tag = spansTwoHosts ? "⚠️ 跨两个 host" : "单 host";
  console.log(`  ${project || "(未知)"}  → ${list.length} 个 runtime（${tag}）`);
  for (const rt of list) {
    const who =
      rt.ppid === localHost[0]?.pid ? "本机 host" : rt.ppid === residentPid ? "常驻主机" : `ppid=${rt.ppid}`;
    console.log(`      pid=${rt.pid}  ${who}  RSS=${(rt.rssKb / 1024).toFixed(0)}MB`);
  }
  if (spansTwoHosts) splitProjects.push(project);
}
knownDefect(
  `${splitProjects.length} 个项目的 runtime 跨两个 host —— 远程与设备本机的进度必然分叉`,
  splitProjects.length > 0,
  splitProjects.join("、") +
    `\n     两个 host 各持一份该项目的内存运行态；resume 命中内存即早退不重读库，` +
    `\n     因此远程端看到的进度不代表设备本机的执行状态（反之亦然）`,
);

// ── T4：资源代价 ──
const totalRssMb = runtimes.reduce((sum, rt) => sum + rt.rssKb, 0) / 1024;
console.log("\n=== T4：资源代价 ===");
note(`runtime 总数 ${runtimes.length}，总 RSS ${totalRssMb.toFixed(0)} MB`);
const duplicateProjects = [...byProject.entries()].filter(([, list]) => list.length > 1);
note(
  `一个项目多个 runtime 的项目数：${duplicateProjects.length}`,
  duplicateProjects.map(([p, l]) => `${p.split("/").pop()} ×${l.length}`).join("、") || "无",
);

console.log("\n=== 结论 ===");
if (dualHost && splitProjects.length > 0) {
  console.log("⚠️ 检测到设备侧双 host 各持一份运行态 —— 远程投射的进度必然与设备本机分叉。");
  console.log("   根因与修法见 .agents/plans/finding-dual-host-runtime-split.md");
  console.log("   修复前，远程端看到的进度不代表设备本机的执行状态（反之亦然）。");
} else if (dualHost) {
  console.log("设备上有两个 host，但当前没有项目跨 host 持有 runtime（分叉风险存在但未触发）。");
} else {
  console.log("设备上只有一个 host —— 运行态唯一，不存在分叉。");
}
console.log(
  failures === 0
    ? `\n本项体检通过 ✅${knownDefects > 0 ? `（${knownDefects} 项已知缺陷，见上）` : ""}`
    : `\n${failures} 项断言失败 ❌`,
);
process.exit(failures === 0 ? 0 : 1);
