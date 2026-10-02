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

/**
 * 丢掉**整行都是注释**的行再匹配：说明性注释里点名某个标识符是**合法**的（例如「为什么不去碰它」），
 * 而裸 grep 会把「解释了不调谁」判成「调了谁」——本仓已经踩过一次（见 squadProtocolMethods.test.ts）。
 *
 * 为什么按**行**丢而不是用「块注释整体正则替换」：源码里有 glob（星号 + 斜杠 + 星号）这类字符串，
 * 那种正则会把第一个注释起始标记到后面某个注释结束标记之间**成片的代码**一起吃掉（断言随即变成假红）。
 * 只丢注释行既不碰字符串、也不碰代码。
 */
function withoutCommentLines(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return false;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        return false;
      }
      return !trimmed.startsWith("//");
    })
    .join("\n");
}

/**
 * host 的**派发桥**源码区域（2026-10-02 第 2 轮裁定之后：实现体从 SquadWake 分支里抽成了
 * `runSquadDispatch`，由**两条入口**共用 —— 规则到点的消息分支、队长派单经 hub 来的
 * `dispatchSquadAssignment`）。断言「派发路径用了强探测 / 门禁 / 收口 / 失败出口」时必须覆盖
 * **实现体 + 薄分支**两段：只看分支会漏掉实现（断言变成假绿），只看实现会漏掉接线。
 *
 * 不再用固定字节窗口：窗口是脆的（下一次正当的追加就会把断言变成假红），而「从函数签名到
 * 消息处理器之间」是**结构上**的边界（实现体只可能在那一段里）。 */
function squadDispatchBridgeSource(): string {
  const host = read("packages/desktop/src/host/index.ts");
  const implAt = host.indexOf("async function runSquadDispatch(");
  assert.ok(implAt >= 0, "host 里没有 runSquadDispatch（派发桥实现体）");
  const handlerAt = host.indexOf('parentPort.on("message",', implAt);
  assert.ok(handlerAt > implAt, "找不到消息处理器边界");
  const branchAt = host.indexOf("HostMessageTypes.SquadWake", handlerAt);
  assert.ok(branchAt >= 0, "host 里没有 SquadWake 分支");
  // 实现体（runSquadDispatch + dispatchSquadAssignment）+ 薄分支（两条入口的接线）。
  return host.slice(implAt, handlerAt) + host.slice(branchAt, branchAt + 4_000);
}

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
  const branch = squadDispatchBridgeSource();
  assert.match(branch, /assertDispatchEnabled/);
  assert.match(branch, /SQUAD_DISPATCH_DISABLED_CODE|isSquadDispatchDisabledError/);
  assert.match(branch, /failureKind: "permanent"/);
});

// 并行那一路报的残留（它自己关不掉、必须在本文件所在的这一侧补）：
// **派发中途抛错、且那次 run 的终态永不到达**时，`subscribe(...)` 拿到的 `{ dispose() }`
// 无信号可依 ⇒ 会残留一个订阅句柄直到进程退出。修法照 cron 侧 `cronRunSubscriptions` 的既有形态：
// 句柄持有在 host 级登记表里，**失败路径也解绑**（不只在成功终态解绑）。
test("队员 run 的终态订阅在派发失败路径上也会解绑", () => {
  const branch = squadDispatchBridgeSource();
  // ① 句柄真的被持有：订阅处的返回值进了 host 级登记表（否则解绑无从谈起）。
  assert.match(
    branch,
    /squadMemberRunSubscriptions\.set\(/,
    "订阅句柄没有被持有（会残留到进程退出）",
  );
  // ② 失败路径（catch）里解绑 —— 这条是并行那一路报的残留的**正面修复**。
  assert.match(
    branch,
    /disposeSquadMemberRunSubscription\(memberRunSubscriptionKey\)/,
    "派发失败的 catch 路径必须解绑该订阅",
  );
  // ③ 本次派发的终态到达时也解绑：不是「只在失败路径」，也不是「只在成功终态」。
  assert.match(
    branch,
    /outcome\.inputId === traceId\)[\s\S]{0,120}disposeSquadMemberRunSubscription\(subscriptionKey\)/,
  );
  // ④ 同一 (taskId, traceId) 先解绑旧的：重投同一 eventKey 时不要叠两条监听。
  assert.match(
    branch,
    /disposeSquadMemberRunSubscription\(subscriptionKey\);\n\s*memberRunSubscriptionKey = subscriptionKey;/,
  );
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

/* ---- Wave 2 第 1 轮裁定（Important-2/3/4）的 host 接线守卫 ---- */

// Important-2：启动**重驱**未收尾的批次。它是「崩溃窗口」那格唯一的恢复动作（没有别的东西会重放
// `child_completed`）。必须：在 ready 之后；**先于**启动回收（回收会删掉 `merged` 的队员分支 ⇒ 重驱
// 会撞「分支不存在」而失败）；失败逐条带原文记日志（不静默）。
test("host 启动路径重驱未收尾的批次（ready 之后，且先于启动回收）", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const readyAt = host.indexOf('if (state.phase === "ready")');
  assert.ok(readyAt >= 0, "host 里没有 database ready 分支");
  const replayAt = host.indexOf("await replayUnfinalizedBatchesBestEffort(activeServices");
  const reapAt = host.indexOf("await reapStartupOrphansBestEffort(activeServices");
  assert.ok(replayAt > readyAt, "重驱必须在 ready 分支里（库就绪之后）");
  assert.ok(replayAt - readyAt < 3000, "重驱调用点必须就在 ready 分支内，而不是文件另一处");
  assert.ok(reapAt > replayAt, "重驱必须**先于**回收（否则回收会先删掉 merged 的队员分支）");
  // 失败可被看见：逐条 error 带原文。
  assert.match(host, /for \(const failure of outcome\.failures\)[\s\S]{0,200}logger\.error/);
});

// Important-3：失败 run 的出口必须真的接上（服务面没有出口之前，失败 run 永远留在活跃集 ⇒
// 工作树/分支永不被回收）。两条路径都要接：派发中途失败（catch）与队员会话终态 failed/stopped（订阅闭包）。
test("host 在两条失败路径上都调用 failMemberRun", () => {
  const branch = squadDispatchBridgeSource();
  const calls = branch.match(/\.failMemberRun\(/g) ?? [];
  assert.ok(
    calls.length >= 2,
    `失败出口必须同时接在「派发中途失败」与「会话终态未产出」两条路径上（实际 ${calls.length} 处）`,
  );
  assert.match(branch, /failMemberRun\(target, \{ runId: eventKey, reason/);
});

// Important-4：建会话之后把 sessionId **回写台账**，否则忙检查的强探测与 deferred 分支永不可达。
// 位置也要钉：必须在 createTask 之后（会话还没建时没有 id 可写）。
test("host 在建会话之后把 sessionId 回写 run 台账", () => {
  const branch = squadDispatchBridgeSource();
  const bindAt = branch.indexOf("bindMemberRunSession(");
  const createAt = branch.indexOf("createTask({");
  assert.ok(bindAt >= 0, "host 没有把 sessionId 回写台账（忙检查的强探测将永不可达）");
  assert.ok(createAt >= 0, "分支里应当有 createTask");
  assert.ok(bindAt > createAt, "回写必须在 createTask 之后（会话建好才知道 sessionId）");
  assert.match(branch, /sessionId: task\.taskId/);
});

/* ---- 第 2 轮裁定（指派 = **人发起**，走与「人手动触发」**同一条**派发路径；落点 ii = 可注入的单例 hub）---- */

// 缺口（复审点名）：runtime 按目标现构 ⇒ 事件订阅表在实例内部 ⇒ 常驻侧订不到 ⇒ 指派**驱动不出 run**。
// 修法：把「派发请求」这一格的出口做成**可注入的单例 hub**，组合根订**一次**并转给 host 的派发执行体。
// 三处接线逐条钉死：① 组合根建一份 hub 并订一次；② 每个 runtime 都 publish 到那一份；③ host 注入执行体。
test("指派经组合根的单例 hub 转给 host 的派发执行体（落点 ii）", () => {
  const node = withoutCommentLines(read("packages/services/src/node.ts"));
  assert.match(node, /createSquadDispatchRequestHub\(\)/, "组合根必须建那一份 hub");
  assert.match(
    node,
    /squadDispatchRequests\.subscribe\(/,
    "组合根必须**订一次**（否则常驻侧收不到）",
  );
  assert.match(node, /onSquadDispatchRequested/, "组合根必须把请求转给 host 的派发执行体");
  // 每个 runtime 都要 publish 到那一份 hub（只建不注入 = 订了也收不到，整条链静默失效）。
  assert.match(node, /dispatchRequestHub: squadDispatchRequests/);
  const host = withoutCommentLines(read("packages/desktop/src/host/index.ts"));
  assert.match(host, /onSquadDispatchRequested: dispatchSquadAssignment/, "host 必须注入执行体");
});

// 同一条派发路径：规则到点与人发起（队长派单）都调 `runSquadDispatch`，只差 `trigger`。
// 同时**不得**为了派发去写唤醒规则（那与「`@` ≠ 指派」/「人发起豁免三道闸」直接冲突，spec §5.5）。
test("规则与人发起共用 runSquadDispatch（只差 trigger），且不写唤醒规则", () => {
  const host = withoutCommentLines(read("packages/desktop/src/host/index.ts"));
  const branch = squadDispatchBridgeSource();
  assert.match(branch, /trigger: "rule"/, "规则到点那条入口必须仍走同一条路径");
  assert.match(branch, /trigger: "user"/, "人发起（队长派单）必须走同一条路径");
  assert.doesNotMatch(
    host,
    /wakeRuleRepo|createWakeRule/,
    "指派不得要求先写一条唤醒规则（人发起豁免三道闸）",
  );
});
