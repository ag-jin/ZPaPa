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

/**
 * 启动维护**异步链**的源码区域（W2 契约修订时加）：从「启动恢复只跑一次」那道闸到该异步链闭合。
 *
 * 为什么不再用「`void` 之后 200 字符内出现某函数名」这种字节窗口：窗口是**脆**的 —— 任何一次
 * 正当的次序调整（本轮就调整了：run 和解整块前移到回收之前）都会把断言变成假红，而假红最终
 * 会被「再放宽一点」，守卫随之失效。这里改用**结构边界**：启动链只有这一段
 * （闸 + 候选计算 + 四步），四步（及两步和解）都必须出现在这段里、且次序可断言。
 */
function startupMaintenanceChainSource(): string {
  const host = read("packages/desktop/src/host/index.ts");
  const start = host.indexOf("if (!squadStartupRecoveryStarted) {");
  assert.ok(start >= 0, "host 里没有启动恢复的「只跑一次」闸（找不到启动链起点）");
  const end = host.indexOf("})();", start);
  assert.ok(end > start, "找不到启动维护异步链的结尾");
  return host.slice(start, end);
}

// 启动回收是 spec §6.4 / §6.6 的**正确性前置**（孤儿占住分支会让重派发撞「分支已存在」）。
// 只写在文档里不算：本用例把「host 启动路径上真的调了它」钉成断言。
test("host 启动路径调用 reapStartupOrphans", () => {
  const host = read("packages/desktop/src/host/index.ts");
  assert.match(host, /reapStartupOrphans/, "host 未调用启动回收；孤儿会占住分支名");
  // 必须是**异步不阻塞 UI** 的调用（spec §11.4「孤儿清理在启动时异步」）：调用点落在启动维护的
  // 异步链里（该链整体被 `void` 掉 —— 边界见 `startupMaintenanceChainSource`）。
  assert.match(
    startupMaintenanceChainSource(),
    /reapStartupOrphansBestEffort\(activeServices, candidates\);/,
    "回收必须落在启动维护的异步链里（不阻塞 UI），而不是被挪成同步调用或另起一处",
  );
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
  assert.match(branch, /squadRunSubscriptions\.set\(/, "订阅句柄没有被持有（会残留到进程退出）");
  // ② 失败路径（catch）里解绑 —— 这条是并行那一路报的残留的**正面修复**。
  assert.match(
    branch,
    /disposeSquadRunSubscription\(runSubscriptionKey\)/,
    "派发失败的 catch 路径必须解绑该订阅",
  );
  // ③ 本次派发的终态到达时也解绑：不是「只在失败路径」，也不是「只在成功终态」。
  assert.match(
    branch,
    /outcome\.inputId === traceId\)[\s\S]{0,120}disposeSquadRunSubscription\(subscriptionKey\)/,
  );
  // ④ 同一 (taskId, traceId) 先解绑旧的：重投同一 eventKey 时不要叠两条监听。
  assert.match(
    branch,
    /disposeSquadRunSubscription\(subscriptionKey\);\n\s*runSubscriptionKey = subscriptionKey;/,
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

/* ---- 改派泛化（2026-10-03）：派发请求的载荷是 `assignee`（类型 + id），不是裸 `agentId` ----

   请求的语义是「把这条活派给**谁**」——小队也能是被派发对象（用户把工作项改派给小队 ⇒ 派发路径
   解析出一条队长 run），裸 agentId 只描述得了队员这一种。**身份里必须带类型**：`eventKey` 是这次
   派发的身份（台账 runId / trace），而 agent 与 squad 的 id 空间彼此独立 —— 「智能体 X」与「小队 X」
   不得用同一个身份字符串代表（旧形态会撞名，而撞名**不报错**，只让台账/日志读起来指错对象）。
   变异：把 eventKey 退回 `request.agentId`（或删掉类型段）⇒ 本用例必红。 */
test("派发请求载荷是 assignee（类型 + id）：eventKey 与日志都按它取名", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /request\.assignee\.type/,
    "派发请求载荷必须带 assignee 类型（小队也能被指派；agent/squad 的 id 空间独立，不得只按 id 取名）",
  );
  assert.match(
    branch,
    /assign:\$\{request\.workItemId\}:\$\{request\.assignee\.type\}:\$\{request\.assignee\.id\}:/,
    "eventKey（台账 runId 的身份）必须含 workItemId + assignee 类型 + id",
  );
  assert.doesNotMatch(
    branch,
    /request\.agentId/,
    "派发请求已无裸 agentId 字段（载荷泛化为 assignee）",
  );
});

/* ---- P2b 余项：队长 run 的台账写入口（spec §5.7(1)：没有记录就无从判「进行中」）---- */

// 派发桥必须**真的**为队长 run 登记台账行（服务面新增的 `recordLeaderRun`，**只登记不执行**）。
// 这条是**接线守卫**：`runSquadDispatch` 未导出、无法在测试里直接驱动（导入 host/index.ts 会牵起
// Electron 侧效应），漏接的表现是「队长 run 依旧不进台账 ⇒ §5.7(1) 的合并判据恒为假、
// `getSnapshot().runs` 也看不见队长 run」，且**没有任何报错**（recon.md C6 的原形态）。
test("派发桥为队长 run 登记台账行（recordLeaderRun，落在队长那一支）", () => {
  const branch = squadDispatchBridgeSource();
  // ① 真的调了服务面的 recordLeaderRun，且带上本次派发的身份（`runId` = `eventKey`，幂等键的稳定一半）。
  assert.match(
    branch,
    /squadRuntime\.recordLeaderRun\(target, \{[\s\S]{0,200}?runId: eventKey/,
    "队长 run 未登记台账行 —— §5.7(1) 的「进行中」判据与 getSnapshot().runs 都会继续架空",
  );
  // ② 必须落在**队长**那一支：形如 `if (ledgerAction === "open_member_run") { … }
  //    else if (ledgerAction === "record_leader_run") { … recordLeaderRun … }`。
  //    落错支的后果非对称：写进队员支会漏登记；让队长走 openMemberRun 会给它**开一棵树**（§6.1 落空）。
  assert.match(
    branch,
    /if \(ledgerAction === "open_member_run"\) \{[\s\S]*?\}\s*else if \(ledgerAction === "record_leader_run"\) \{[\s\S]{0,900}?recordLeaderRun\(target, \{/,
    "recordLeaderRun 必须在「非队员」（队长）分支里调用",
  );
  // ③ 队长那一支**不得**碰 openMemberRun：openMemberRun 只该有一处调用（队员支）。
  assert.equal(
    (branch.match(/openMemberRun\(/g) ?? []).length,
    1,
    "openMemberRun 只该有一处调用（队员支）——队长走它会给队长开树",
  );
});

/* ---- P2b 余项（单独安排 vs 队员，spec §6.1）：派发桥必须**按类别分流** ----

   缺陷（复审确认）：`planDispatch` 的非队长结果此前**没有可分辨字段**（唯一带 `squadId` 的是队长）
   ⇒ 派发桥只能写「非队长 ⇒ 开树」，于是**单独安排的智能体**也被开了一棵树 —— 那条分支**永不合并、
   也永不被回收**（`activeBranches` 只覆盖小队命名空间），且不报错。修法有两半，都必须接线：
   ① 类别取自 `planDispatch` 的显式判别字段 `runClass`（不得再用 `isLeaderTask` 二分去猜）；
   ② 开树/台账那一格按类别**查表**（`ledgerActionForRunClass`），`standalone` **两者都不做**。
   这里是**接线守卫**：`runSquadDispatch` 未导出、无法在测试里直接驱动（导入 host/index.ts 会牵起
   Electron 侧效应），漏接的表现正是「单独安排照旧被开树」，而**没有任何报错**（recon.md C6 的原形态）。 */
test("派发桥按 runClass 三类分流，单独安排不开工作树、不登记台账", () => {
  const branch = squadDispatchBridgeSource();
  // ① 类别取自 `planDispatch` 的判别字段（不是靠 isLeaderTask / squadId 猜）。
  assert.match(
    branch,
    /const kind: SquadDispatchKind = enqueued\.runClass;/,
    "类别必须来自 runClass（显式判别字段）",
  );
  assert.doesNotMatch(
    branch,
    /enqueued\.isLeaderTask \?/,
    "不得再用 isLeaderTask 二分 —— 那正是「单独安排被当成队员开树」的形态",
  );
  // ② 分流经**唯一一处**查表：类别的动作只有 `ledgerActionForRunClass` 一处定义。
  assert.match(branch, /ledgerActionForRunClass\(kind\)/, "开树/台账那一格必须按类别查表");
  // ③ 开树只发生在队员支：`openMemberRun(` 全桥**恰好一处**（standalone 若也开树，这里会变成 2）。
  assert.equal(
    (branch.match(/openMemberRun\(/g) ?? []).length,
    1,
    "openMemberRun 只该有一处调用（队员支）——单独安排走它就会被塞进一条永不合并的分支",
  );
  // ④ 单独安排不得登记台账行：`recordLeaderRun(` 同样恰好一处（队长支）。
  assert.equal(
    (branch.match(/recordLeaderRun\(/g) ?? []).length,
    1,
    "recordLeaderRun 只该有一处调用（队长支）——单独安排不在小队里，台账行无从收口",
  );
  // ⑤ 单独安排**没有台账行 ⇒ 不得订阅一个「按 runId 动台账」的终态收口**：
  //    整块收口必须被 `ledgerAction !== "none"` 挡住（否则终态到达时去动一行不存在的 run，响亮抛）。
  assert.match(branch, /if \(ledgerAction !== "none"\) \{/, "没有台账行的那一类不得订阅终态收口");
});

/* ---- §5.7(1)/S13：队长 run 进行中的重复指派**合并为同一次**（判据取自服务层唯一读法）---- */

// 决定本身在**纯函数**里（`decideSquadDispatch`，`hostSquadDispatch.test.ts` 有行为用例，
// 含与忙检查的次序）。这里钉的是**接线**：那个布尔必须由服务层的唯一读法算出来，不能写死。
// 写死/恒 false 的表现是「同一个工作项能起两条队长 run」——两个会话干同一件事，
// 而 §5.7(1) 要求合并；更糟的是它**不报错**（判据接了线却一行不跑，正是 recon.md C6 那类静默失效）。
test("派发桥把「有没有进行中的队长 run」按服务层读法算出来再交给决策", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /leaderRunInProgress:[\s\S]{0,160}?hasInProgressLeaderRun\(snapshot\.runs, workItem\.id\)/,
    "leaderRunInProgress 未取服务层读法（hasInProgressLeaderRun）：§5.7(1) 的合并判据会恒为假",
  );
  assert.doesNotMatch(
    branch,
    /leaderRunInProgress:\s*(?:false|true)\b/,
    "leaderRunInProgress 不得写死常量：那等于把判据摘掉（看起来接了线、实际不动）",
  );
});

/* ---- §5.7(1) 的另一面：残留队长行的**启动和解**（否则该工作项的指派被永久静默吃掉）---- */

// 和解的判据是**纯函数**（`selectStaleLeaderRuns`，`hostSquadDispatch.test.ts` 有行为用例）。
// 这里钉接线：① 台账会话回写必须覆盖队长行（和解要靠它读出「哪条会话」）；② 启动链必须真的调它。
test("派发桥：台账会话回写覆盖队长行（按「有没有台账行」判，不按 kind 枚举）", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /if \(ledgerAction !== "none"\) \{[\s\S]{0,200}?bindMemberRunSession\(/,
    "回写必须覆盖队长行 —— 队长行的启动和解要从台账读 sessionId（恒 null 就没法判死活）",
  );
  // 反向钉住旧形态：按 `kind === "member"` 枚举会**静默漏掉队长行**，那正是恒 null 的成因。
  assert.doesNotMatch(
    branch,
    /if \(kind === "member"\) \{[\s\S]{0,200}?bindMemberRunSession\(/,
    "按 kind 枚举会漏掉队长行：将来多一类带台账行的 run 同样会被漏掉",
  );
});

/* ---- 启动链的**次序契约**（W2 契约修订：旧次序是「重驱 → 回收 → 队长和解」，现为
   「重驱 → run 和解（队长臂 + 队员臂）→ 回收 → 队列全量推进」）----

   为什么次序是契约（不是风格）：队员和解臂结算僵尸 run ⇒ 它们离开活跃集 ⇒ **同一次启动**的回收
   才收得掉它们的树与分支。若和解仍在回收之后，僵尸树要等到**下一次完整启动**才被收，而它占着分支名
   会让重派发一直撞「分支已被占用」（§6.6/S15）。
   为什么「重驱必须先于回收」照旧（本轮只前插、不动这一对相对次序）：重驱会把未收尾的批 finalize
   （清掉它的集成分支与已 `merged` 的队员分支），而 `merged` 恰不在活跃集 ⇒ 先回收会把这批的成果分支
   删掉，重驱随后撞「分支不存在」而失败。
   强度不降：**四步（+两步和解）仍须全部被调用、次序逐条断言、failMemberRun 仍是唯一写者**。 */

test("启动链次序：重驱 → run 和解（队长臂、队员臂）→ 回收 → 队列全量推进", () => {
  const chain = startupMaintenanceChainSource();

  // ① 四步 + 两个和解臂**全部**被调（少任何一步 = 那条恢复线整块空转且不报错）。
  const steps: Array<[string, RegExp]> = [
    ["重驱", /replayUnfinalizedBatchesBestEffort\(activeServices, candidates\);/],
    ["队长和解臂", /settleStaleLeaderRunsBestEffort\(activeServices, candidates\);/],
    ["队员和解臂", /settleStaleMemberRunsBestEffort\(activeServices, candidates\);/],
    ["回收", /reapStartupOrphansBestEffort\(activeServices, candidates\);/],
    ["队列全量推进", /advanceSquadQueueAfterSettlement\(activeServices, target\)/],
  ];
  const positions = steps.map(([name, pattern]) => {
    const match = chain.match(pattern);
    assert.ok(match, `启动链缺少「${name}」这一步（漏接 = 这条恢复线空转且不报错）`);
    return { name, at: chain.indexOf(match[0]) };
  });

  // ② 次序逐条断言（相邻两步 + 关键的总关系）。
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i]!.at > positions[i - 1]!.at,
      `${positions[i - 1]!.name} 必须先于 ${positions[i]!.name}（新契约：和解整块前移到回收之前）`,
    );
  }
  // 「重驱先于回收」这条**既有**契约单独再钉一次（本轮只前插，不得动这一对的相对次序）。
  const replayAt = positions[0]!.at;
  const reapAt = positions[3]!.at;
  assert.ok(
    reapAt > replayAt,
    "重驱必须先于回收：重驱要 finalize 的批次分支（merged）不在活跃集，先回收会把成果删掉",
  );
});

test("启动链的两个和解臂收口都走 failMemberRun（唯一写者），host 里没有第二种改台账状态的手段", () => {
  const host = read("packages/desktop/src/host/index.ts");
  const tick = read("packages/desktop/src/host/squadWatchdogTick.ts");
  // 队长臂：`selectStaleLeaderRuns` 之后逐条 `failMemberRun`（既有形态不变）。
  assert.match(
    host,
    /const stale = selectStaleLeaderRuns\(\{[\s\S]{0,900}?failMemberRun\(target, \{/,
    "队长行收口要走 failMemberRun（唯一写者）",
  );
  // 队员臂：结算走 `runSquadWatchdogSweep` 的执行臂，而执行臂只经注入的 `settleRun` 端口 ——
  // 端口的唯一实现必须落到服务面 `failMemberRun`。
  assert.match(
    tick,
    /settleRun: \(target, input\) =>\s*\n?\s*squadRuntime\.failMemberRun\(\{ path: target\.path, identity: target\.identity \}, input\)/,
    "队员臂的结算端口必须接服务面 failMemberRun（唯一写者）",
  );
  // 反向：两处都不得出现「直接写状态」的手段（`setStatus` / 裸 UPDATE）——
  // 那会绕开结算事实扇出（容量释放与队列推进都靠它）。
  for (const [name, source] of [
    ["host/index.ts", host],
    ["host/squadWatchdogTick.ts", tick],
  ] as const) {
    assert.doesNotMatch(
      source,
      /squadRunRepo\.setStatus\(|UPDATE squad_runs/,
      `${name} 里不得出现第二种改台账状态的手段（只经服务面方法）`,
    );
  }
});

/* 「派发时的事实」与「类别**声明**」必须**一起**进规划：类别不再由父项的有无**推断** ——
   那条推断把「调用方漏传父项」与「本项确实不在批次里」合并成同一个 `standalone`，前者是接线缺陷
   却被静默当成后者 ⇒ 队员**直接改主工作区**（§6.1 的隔离承诺静默落空，且不报错）。
   三件事都要在：① 父项从**同一份快照**取；② 类别用**服务层的唯一策略** `declaredRunClassFor` 声明
   （本层不另写一份推导）；③ 声明与事实都进 `planDispatch`（缺一或矛盾即响亮抛，见 `resolveAgentRunClass`）。 */
test("派发桥把父项事实与类别声明一起传给 planDispatch（声明 + 校验）", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /const parentWorkItem = workItem\.parentId[\s\S]{0,200}?snapshot\.workItems\.find/,
    "父项必须从**同一份快照**取（快照按 workspace 过滤、且不含归档行）",
  );
  assert.match(
    branch,
    /declaredRunClassFor\(\{[\s\S]{0,140}?parentId: workItem\.parentId,[\s\S]{0,90}?parent: parentWorkItem/,
    "类别必须**声明**（经服务层唯一策略 declaredRunClassFor），不得在派发桥另写一份推导",
  );
  assert.match(
    branch,
    /planDispatch\(\{[\s\S]{0,200}?parentWorkItem,[\s\S]{0,300}?runClass: declaredRunClass/,
    "父项事实与类别声明必须一起传给 planDispatch —— 漏传父项曾经会静默落成 standalone（队员丢隔离）",
  );
  // 反向：不得再出现「按父项有无推断类别」的旧写法（本轮修掉的那条静默缺省）。
  assert.doesNotMatch(
    branch,
    /isSquadBatchChild\(/,
    '类别推断不得回到派发桥（旧写法是 isSquadBatchChild(...) ? "member" : "standalone"）',
  );
});

/* ---- P2b 余项（终态事实）：队长 run 的终态必须**真的被写回** ----

   `recordLeaderRun` 只登记成 `open`；队长 run 又没有队员那一步 review/merge ⇒ 若不接终态出口，
   **成功的队长行长驻 `open`** ⇒ §5.7(1)「进行中」恒真 ⇒ 该工作项的后续指派被永久合并，且**不报错**。
   这里钉两件事：① 出口用的是**与队员同一条**既有机制（`onDynamicTaskTerminalOutcome` + `inputId === traceId`，
   不得自造第二条轮询兜底）；② 成功的入账动作是**队长专用**的 `completeLeaderRun`（不是 `completeMemberRun`
   —— 后者会把父项推 `in_review`，违反 §5.7(2)）。 */

test("派发桥为队长 run 接上终态收口（同一条出口 + completeLeaderRun）", () => {
  const branch = squadDispatchBridgeSource();
  // ① 队长 run 的终态收口真的接上了：非队员那一支调了 `watchLeaderRunSettlement`。
  assert.match(
    branch,
    /watchLeaderRunSettlement\(/,
    "队长 run 未接终态收口 —— 成功的队长行会长驻 open（§5.7(1) 判据恒真、重复指派被永久合并）",
  );
  // ② 成功的入账是**队长专用**动作：completeLeaderRun（不碰工作项）；不得错用 completeMemberRun。
  assert.match(
    branch,
    /completeLeaderRun: \(runId\) => squadRuntime\.completeLeaderRun\(target, \{ runId \}\)/,
    "队长的成功入账必须是 completeLeaderRun（completeMemberRun 会把父项推 in_review，违反 §5.7(2)）",
  );
  // ③ **同一条出口**：终态订阅只该有一处 `onDynamicTaskTerminalOutcome(` —— 两种 run 共用它。
  //    两处订阅（或另加轮询）就是对同一次终态有两套判据，迟早给出不同结论。
  assert.equal(
    (branch.match(/onDynamicTaskTerminalOutcome\(/g) ?? []).length,
    1,
    "终态出口只该有一处订阅（队员与队长共用它，不得自造第二条兜底）",
  );
  // ④ 两种 run 复用**同一个**订阅闭包（同一个 `subscribe` 值），这也是「同一条出口」的正面证据。
  assert.equal(
    (branch.match(/subscribe: subscribeTerminal,/g) ?? []).length,
    2,
    "队员与队长必须复用同一个终态订阅闭包（两条出口 = 两套判据）",
  );
  // ⑤ 失败/中止那一支两种 run 都走 `failMemberRun`（同一条出口；它的契约是「这条 run」而非身份）。
  assert.match(branch, /failMemberRun\(target, \{[\s\S]{0,120}runLabel/);
});

/* ---- 派发成因落台账（2026-10-04）：三路成因在派发桥**归并**，队员 run 另带入边 ----

   `squad_runs.dispatch_cause` 是时间线把「队长→队员」弧线从渲染时推断升级为**事实**的数据依据；
   `caused_by_run_id` 记「哪个队长派的」。两列都只在**派发时刻**由 host 派发桥给出：
   漏传的表现是两列恒 NULL（弧线永远只能推断），而下游一路**不报错** —— 故这里钉接线。 */

// 成因的三路来源在派发桥归并成一处：规则触发（消息形状里没有 cause）就地落 `rule`，
// 人发起那一支用**服务面给的** cause（队长工具 / UI 改派 —— 服务面在事件源头就分好了）。
// 反向守卫：不得按调用者反推成因（那是二次判定，推断错会往台账里落一个错的成因且读回不报错）。
test("派发桥归并三路成因：rule 就地归并、人发起用服务面给的 cause", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /msg\.trigger === "rule"\s*\?\s*"rule"\s*:\s*msg\.trigger === "replay"\s*\?\s*msg\.replayCause\s*:\s*msg\.cause/,
    "成因必须在派发桥归并成一处（规则就地落 rule；replay 携带台账原始成因，缺 ⇒ undefined 落 NULL；人发起读 msg.cause）",
  );
  assert.doesNotMatch(
    branch,
    /dispatchCause\s*=\s*"(?:leader_tool|user_reassign|rule)"/,
    "不得在派发桥写死成因 —— 人发起那两支的成因是服务面给的事实，本层只搬运",
  );
  // 人发起两条入口的薄分支：hub 请求的 cause 原样填进消息（`dispatchSquadAssignment`）。
  assert.match(
    branch,
    /cause: request\.cause/,
    "dispatchSquadAssignment 必须把 request.cause 原样填进派发消息",
  );
});

// 两处台账写入口都要拿到成因；队员那处还要拿入边（`caused_by_run_id`）。
// 入边的解析只有服务层那一处读法（`findActiveLeaderRunId`），host 不得自己 `find(...)` 拼一份。
// 断言按**代码形状**匹配（整行键 + 条件展开），不用裸标识符：注释里提到字段名是合法的
//（本仓踩过「注释还在、代码被删」的假绿），故这里要求的是真的作为参数出现。
test("派发桥两处台账调用都传 dispatchCause；队员处传 causedByRunId", () => {
  const branch = squadDispatchBridgeSource();
  assert.match(
    branch,
    /openMemberRun\(target, \{[\s\S]{0,400}?\n\s+dispatchCause,\n/,
    "队员 run 的台账行必须带成因（丢它就是「弧线永远只能推断」）",
  );
  assert.match(
    branch,
    /openMemberRun\(target, \{[\s\S]{0,400}?\.\.\.\(causedByRunId !== null \? \{ causedByRunId \} : \{\}\),/,
    "队员 run 的入边必须按「仅非 null 时带键」的既有风格传（null 不是一条事实）",
  );
  assert.match(
    branch,
    /recordLeaderRun\(target, \{[\s\S]{0,300}?\n\s+dispatchCause,\n/,
    "队长 run 的台账行必须带成因",
  );
  // 入边只在「队长工具派发的队员 run」这一格解析，且用服务层的唯一读法 + 同一份快照。
  assert.match(
    branch,
    /kind === "member" && dispatchCause === "leader_tool" && parentWorkItem[\s\S]{0,200}?findActiveLeaderRunId\(snapshot\.runs, parentWorkItem\.id\)/,
    "causedByRunId 必须只在「member + leader_tool + 有父项」时按服务层读法解析",
  );
  // 队长那一支**不得**带 causedByRunId（队长 run 是批次起点，无入边 ⇒ NULL）。
  assert.doesNotMatch(
    branch,
    /recordLeaderRun\(target, \{[\s\S]{0,300}?causedByRunId/,
    "队长 run 无入边：recordLeaderRun 不得传 causedByRunId",
  );
});

/* ---- per-agent MCP（multica 欠账 #2）：挂载点在 createTask，基准来自服务面的目录读取器 ----

   一个 run 挂的 MCP 集合 = 「user 级 + workspace 级（enabled）」+「该 agent 自有的 mcpServers」，
   同名时后者赢，结论**显式**传进 `createTask({ mcpServers })`。为什么必须显式传（而不是靠 CLI 原生读）：
   队员 run 的会话落在 `<repo>/.worktree/<dir>`（新检出目录），主工作区未跟踪的 `.zcode/config.json`
   不在那棵树里 ⇒ 原生读取拿不到 workspace 级 server，**队长读得到、队员读不到且不报错**。
   显式传入的代价是「覆盖集语义」：既然替换掉原生读取，就必须由 host 把基准补齐（下面第 ① 条）。
   漏接的表现同样是 C6 那种静默跑掉一整层 server。 */
test("派发桥在 createTask 处显式传 mcpServers；基准经服务面目录读取器、agent 自有合并", () => {
  // 断言面用**丢掉整行注释**的源码：注释里提到 `catch`/字段名是合法的（本仓踩过「注释还在、代码被删」的假绿）。
  const branch = withoutCommentLines(squadDispatchBridgeSource());
  // ① 基准读取归属**服务面**（唯一实现）：host 不自己读 config.json、也不自己算 enabled。
  assert.match(
    branch,
    /getOptional\(IMcpSyncService\)/,
    "基准读取必须取服务面的目录读取器（自己读 = 第二份「在哪 / 怎么算 enabled」的判据）",
  );
  assert.match(
    branch,
    /loadMcpFromUserDirectory\(\{ workspacePath \}\)/,
    "基准必须逐次派发现读（改完配置下一个任务生效，无需重启）",
  );
  // ② 合并/转换由注入的装配点做（accept dependencies, don't create them）。
  assert.match(branch, /createSquadMcpMountResolver\(\{/, "挂载解析必须经注入装配点");
  // ③ 结论进 createTask 载荷；**没有可挂的 server 时不传该字段**（三态：不传 = CLI 原生继承，
  //    显式传入的集合是覆盖集 —— 空集合走「不传」那一态，不靠下游归一空数组）。
  assert.match(
    branch,
    /\.\.\.\(mcpServers \? \{ mcpServers \} : \{\}\),/,
    "mcpServers 必须按「有值才传」的三态进 createTask 载荷",
  );
  // ④ 基准读的是**主工作区**路径（msg.workspacePath），不是会话所在的工作树路径 —— 这正是缺口修复：
  //    工作树里没有主工作区的 .zcode/config.json。
  assert.match(
    branch,
    /workspacePath: msg\.workspacePath,[\s\S]{0,240}?agentMcpServers/,
    "基准必须按主工作区路径读取（工作树路径读不到主工作区的 .zcode/config.json）",
  );
  assert.doesNotMatch(
    branch,
    /workspacePath: sessionWorkspacePath,[\s\S]{0,240}?agentMcpServers/,
    "基准不得按会话（工作树）路径读取",
  );
  // ⑤ agent 自有配置取自**本次派发的那个 agent**（按 `enqueued.agentId` 在名册里查名册行），
  //    三类 run 都成立 —— 用 `targetAgent` 会漏掉队长 run（队长 run 的 targetAgent 恒为 undefined），
  //    表现是「给队长配的 server 只有队员跑得上」，且不报错。
  assert.match(
    branch,
    /const dispatchedAgent = snapshot\.teamAgents\.find\([\s\S]{0,40}?entry\.id === enqueued\.agentId/,
    "agent 自有配置必须按本次派发的 agentId 取名册行（队长 run 也要带上队长自己的 server）",
  );
  assert.match(
    branch,
    /agentMcpServers: dispatchedAgent\.mcpServers/,
    "agentMcpServers 必须来自上一步取到的那个 agent 定义（不得改用 targetAgent）",
  );
  // ⑥ 绑定会话（重投）**不重挂**：挂载只在新建会话那一支取值（MCP 是 runtime 启动期配置，
  //    随会话创建冻结；恢复会话沿用既有 runtimeConfig）。
  assert.match(
    branch,
    /boundSessionId\s*\?\s*undefined\s*:\s*await resolveSquadMcpServers\(/,
    "绑定会话那一支不得取值挂载集（重投不重挂）",
  );
  // ⑦ 日志只记 server 名单与计数（配置里可能有凭据，绝不记配置内容）。
  assert.match(branch, /mcp=\$\{mcpServerNames/, "派发完成日志必须留一行 server 名单");
  assert.doesNotMatch(
    branch,
    /logger\.(?:info|warn|error)\([^)]*JSON\.stringify\(mcpServers/,
    "日志不得序列化挂载集（含 env/headers 凭据）",
  );
  // ⑧ 基准读失败**不得就地兜底**（裁定 B）：从取读取器到进 createTask 这一段里不许出现 catch ——
  //    吞掉的表现是「这次 run 悄悄少了一整层 server」，比失败更坏；冒泡出去走既有 **transient** 出口
  //    （派发中途抛错的统一归宿：响亮 + 重投，配置文件修好后自愈）。
  const mountAt = branch.indexOf(
    "const mcpSyncService = targetServices.getOptional(IMcpSyncService);",
  );
  const createTaskAt = branch.indexOf("zcodeTaskService.createTask({");
  assert.ok(mountAt >= 0 && createTaskAt > mountAt, "取读取器到 createTask 之间必须相连");
  assert.doesNotMatch(
    branch.slice(mountAt, createTaskAt),
    /catch/,
    "基准读取/转换不得就地 catch（吞错 = 静默跑掉一层 server；必须冒泡到外层 transient 出口）",
  );
});
