import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* 小队闭环的**最终接线**（Wave 2）：启动回收调用点 + 批次收尾的装配。

   这些断言都是**源码守卫**：本文件要钉住的不是某个返回值，而是「某条线**接上了**」这件事实。
   没有它们，漏接的表现是「功能整块空转且不报错」（recon.md C6 的原形态）——组件全绿、没有任何报错，
   只是没有任何地方去调用它们。 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (...p: string[]): string => readFileSync(join(repoRoot, ...p), "utf8");

// 启动回收是 spec §6.4 / §6.6 的**正确性前置**（孤儿占住分支会让重派发撞「分支已存在」）。
// 只写在文档里不算：本用例把「host 启动路径上真的调了它」钉成断言。
test("host 启动路径调用 reapStartupOrphans", () => {
  const host = read("packages/desktop/src/host/index.ts");
  assert.match(host, /reapStartupOrphans/, "host 未调用启动回收；孤儿会占住分支名");
  // 必须是**异步不阻塞 UI** 的调用（spec §11.4「孤儿清理在启动时异步」）。
  assert.match(host, /void\s+[\s\S]{0,200}reapStartupOrphans/);
  // 加强那两条 grep 的力度：被 `void` 的那个调用**真的**把服务面方法调了
  //（否则「void 一个恰好叫 reapStartupOrphans 的名字」也能通过）。
  assert.match(
    host,
    /await\s+squadRuntime\.reapStartupOrphans\(/,
    "best-effort 包装里必须真的 await 服务面的 reapStartupOrphans",
  );
});

// 回收必须**在 database startup ready 之后**（不是「服务起了就算」：回收要按目标仓库的分支命名空间
// 决定删什么，而库就绪前 repos 还没走完迁移/回填）。
test("启动回收挂在 database ready 之后", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const readyAt = host.indexOf('if (state.phase === "ready")');
  assert.ok(readyAt >= 0, "host 里没有 database ready 分支");
  const reapAt = host.indexOf("reapStartupOrphansBestEffort(activeServices");
  assert.ok(reapAt > readyAt, "回收的调用点必须在 ready 分支里（库就绪之后）");
  assert.ok(reapAt - readyAt < 3000, "回收调用点必须就在 ready 分支内，而不是文件另一处");
});

// 硬约束：`activeBranches` 的**唯一口径来源**是 `SquadRunRepo.listActive()`（含 produced/rejected）。
// host 侧不得自己算一遍「哪些工作树还该活着」（例如按「当前有没有在跑的 run」估）——
// 那会让被打回待修的树在下次启动被静默回收（spec §6.2 / §16 S5 失效且不报错）。
// 本任务的做法是**不投影**：整件事交给服务面的 `reapStartupOrphans`。
test("启动回收不自己算活跃集合（口径只有 SquadRunRepo.listActive 一处）", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const start = host.indexOf("async function reapStartupOrphansBestEffort(");
  assert.ok(start >= 0, "host 里没有启动回收的 best-effort 包装");
  const wrapper = host.slice(start, host.indexOf("\n/**", start + 10));
  assert.doesNotMatch(wrapper, /listActive|squadRunRepo|activeBranches/);
  assert.match(wrapper, /reapStartupOrphans\(target\)/);
});

// 「子项全完成 ⇒ 整批收尾」这条链只有挂上去才存在。挂点必须是 runtime 的事件出口，
// 不得有第二处轮询（轮询会与事件流并发出两套判据）。
//
// 断言用**带括号的调用形状**而不是裸标识符：裸标识符在说明性注释里也会出现，于是
// 「代码行被删掉、注释还在」也能通过 —— 本用例的第一次变异（删掉订阅行）正好漏过去了。
test("批次编排挂在 runtime 的事件出口上", () => {
  const node = read("packages/services/src/node.ts");
  assert.match(node, /createSquadOrchestrator\(\{ runtime \}\)/);
  assert.match(node, /runtime\.subscribeWorkItemEvents\(forwardSquadChildCompleted\(runtime\)\)/);
  assert.match(node, /\.advanceAfterChildrenDone\(\{/);
});

// 批次收尾的**驱动**是 `child_completed` 事件，且它不得在回调里被 `await`
//（serializeOnRepo 的队列键是模块级的仓库根 ⇒ await 会自等死锁）。这条把「只 void + catch」钉住。
test("批次收尾在事件回调里只 void（不 await，避免自等死锁）", () => {
  const node = read("packages/services/src/node.ts");
  assert.match(node, /void createSquadOrchestrator\(\{ runtime \}\)/);
  assert.match(node, /\.catch\(/);
});

// desktop 只能经 `@zcode/services/node` 与 `.` 两个入口取东西（packages/services/package.json#exports）。
// B 的工厂若没被 re-export，host 就够不到它——而编译期不会报错（host 侧是 getOptional 式取用）。
test("node.ts re-export 了 B 的编排工厂", () => {
  const node = read("packages/services/src/node.ts");
  assert.match(
    node,
    /export \{ createSquadOrchestrator \} from "\.\/workitem\/squadOrchestrator\.js";/,
  );
});

// 确认 2（**单点门禁**）：判据只有服务层一处，desktop 侧**一处都不许有**。
// 这条检查是本计划里唯一能拦住「判据被复制成第二份」的东西 —— 复制发生时不会有任何编译错。
test("desktop 侧不读开关（门禁判据在服务层）", () => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(entry.name) &&
        readFileSync(full, "utf8").includes("experimentalAgentSquadsEnabled")
      ) {
        hits.push(full);
      }
    }
  };
  walk(join(repoRoot, "packages", "desktop", "src"));
  assert.deepEqual(hits, [], `门禁判据只能有一处（服务层）：${hits.join(", ")}`);
});

// host 只**调**服务层门禁并按稳定 code 分流；不得自己读设置。
test("host 调服务层门禁并按稳定 code 翻译成 permanent", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const start = host.indexOf("HostMessageTypes.SquadWake");
  assert.ok(start >= 0, "host 里没有 SquadWake 分支");
  const branch = host.slice(start, start + 8000);
  assert.match(branch, /assertDispatchEnabled/);
  assert.match(branch, /SQUAD_DISPATCH_DISABLED_CODE|isSquadDispatchDisabledError/);
  assert.match(branch, /failureKind: "permanent"/);
});

// 三个 `squad/*` 协议分支落在 services 的应答面（不是 desktop：`packages/desktop/src/host/**`
// 零协议 handler，且依赖方向 desktop→services）——漏了它们的表现是队长每次派单都拿 -32601。
test("三个 squad/* 协议分支落在 zcodeAgentService 的 onRequest 链上", () => {
  const agent = read("packages/services/src/zcode-agent/zcodeAgentService.ts");
  const fallbackAt = agent.indexOf("Unsupported ZCode Protocol request");
  for (const method of ["squadCreateChildWorkItem", "squadAssignWorkItem", "squadListRoster"]) {
    const at = agent.indexOf(`zcodeProtocolMethods.${method}`);
    assert.ok(at >= 0, `zcodeAgentService 里没有 ${method} 分支`);
    assert.ok(at < fallbackAt, `${method} 必须落在 -32601 兜底之前`);
  }
});
