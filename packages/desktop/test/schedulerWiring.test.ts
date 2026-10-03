import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostResponseMessageSchema } from "@zcode/shared";

const desktopSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/* 接线守卫：这些断言查的是**源码文本**，因为要拦的失败都是**静态可见**的
   （逻辑写对了但挂错地方 ⇒ 生产静默不跑；加了常量没进并集 ⇒ 消息被入口丢弃）。
   静态断言的价值恰在于：它们不依赖任何运行时环境，生产与 dev 布局差异也拦不住它们。 */

// recon.md F4：`schedulerModulePath` 基于 `import.meta.dirname`（desktopRuntimeEnv.ts:83），
// dev 与打包布局不同。scheduler 是 electronUtilityProcess.fork 出来的**独立入口**，
// 新逻辑若挂在 main/ 或 host/ 里（那些模块只在 dev 的相对布局下被 dev 入口加载），
// 生产包里**根本不会执行**——而且不报错。故把「唤醒 tick 必须挂在被 fork 的那个入口上」钉成断言。
test("唤醒 tick 挂在被 fork 的 scheduler 入口上", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  assert.match(
    entry,
    /createWakeTick/,
    "scheduler 入口必须引用并启动 createWakeTick，否则生产静默不跑",
  );
  assert.match(entry, /wakeTick\.run\(/, "scheduler 入口必须真的调用 wakeTick.run(...)");
});

test("fork 的模块路径指向 scheduler 入口（不是别的目录）", () => {
  const env = readFileSync(join(desktopSrc, "main/desktopRuntimeEnv.ts"), "utf8");
  assert.match(
    env,
    /schedulerModulePath = join\(import\.meta\.dirname, "\.\.\/scheduler\/index\.js"\)/,
  );
});

// recon.md 缺口 #6：唤醒规则必须接进**既有的 20 秒 tick**，不得新增第二套定时器——
// 两套 tick 会相对漂移，misfire / 退避语义也会跟着出现第二套口径。
test("唤醒规则复用同一个 20s tick，没有第二套定时器", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  const intervals = entry.match(/setInterval\(/g) ?? [];
  assert.equal(intervals.length, 1, "只允许唯一的 20s tick 定时器（pollTimer）");
  /* 「tick 内必须按 limit 扫到点规则」这条不变式仍然要守，只是**落点**从入口搬到了 `wakeTick.ts`：
     扫描（`listReady` 的 SQL LIMIT）随判定逻辑一起下沉，入口只负责每轮把它接上
     （见下面那条「每轮无条件跑 run」的接线守卫）。断言因此改为钉**新的真实形状** ——
     不删守卫（不变式还在），只把它钉在逻辑真正所在的文件上。 */
  const wakeTick = readFileSync(join(desktopSrc, "scheduler/wakeTick.ts"), "utf8");
  assert.match(
    wakeTick,
    /deps\.listReady\(now, WAKE_TICK_LIMIT\)/,
    "到点扫描必须按 WAKE_TICK_LIMIT 限幅（一次数据库异常不该拖住整个 tick）",
  );
});

/* 排期计算（`nominalInstant` / `nextFireAtAfter`）的**唯一实现**在 `@zcode/services/node`
   （`workitem/wakeSchedule.ts`，由 `wakeTick.ts` 整体搬入）：调度器（fire 后推进下一格）与服务面
   （`createWakeRule` / `resumeWakeRule` 算首格）共用它，而「同一份实现」只有在**源代码只有一处**
   时才成立 —— 在 wakeTick 里复制一份本地实现，两份会静默漂移：建出来的规则与调度器推进的网格
   对不上（同一格算出两个名义时刻），eventKey 去重静默失效，且没有任何报错。
   故 wakeTick.ts 只允许 **import / 再导出**，不得出现本地定义（函数声明与变量赋值两种形态都不行）。 */
test("wakeTick 不得再定义排期计算（唯一实现在 services 的 wakeSchedule.ts）", () => {
  const wakeTick = readFileSync(join(desktopSrc, "scheduler/wakeTick.ts"), "utf8");
  for (const name of ["nextFireAtAfter", "nominalInstant"]) {
    assert.doesNotMatch(
      wakeTick,
      new RegExp(`(?:export\\s+)?function\\s+${name}\\b`),
      `${name} 不得在 wakeTick.ts 里再定义一份（函数声明形态）：两份实现会与 services 的唯一实现静默漂移`,
    );
    assert.doesNotMatch(
      wakeTick,
      new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`),
      `${name} 不得在 wakeTick.ts 里再定义一份（变量赋值形态）：同上`,
    );
  }
  assert.match(
    wakeTick,
    /import\s*\{[^}]*nextFireAtAfter[^}]*\}\s*from\s*"@zcode\/services\/node"/,
    "排期计算必须从 @zcode/services/node 导入（搬运的落点），不得留在本包",
  );
});

/* 唤醒规则必须**每轮无条件**跑 `wakeTick.run` —— 这是本次修复在生产中生效的关键：   `fire()` 是 advance-before-post，已 fire 的规则 `next_fire_at` 已前进到未来 ⇒ 安静期里
   `listReady` 恒为空。若像基线那样「入口先按 limit 预扫一遍，为空就跳过 run」，则安静期的
   **重投与 TTL 淘汰整段永不执行**（一条 once 规则的瞬时失败会静默丢失）。所以钉住两件事：
   ① run 被直接 `await` 调用；② 入口里没有那层预判门控 —— 门控的**签名**就是入口直接用
   `WAKE_TICK_LIMIT` 常量去 listReady（扫描下沉后，入口只把 `limit` 变量透传给注入的 dep）。 */
test("唤醒规则每轮无条件跑 wakeTick.run（不得回到 listReady 预判门控）", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  const call = "wakeTick.run(now)";
  const at = entry.indexOf(call);
  assert.ok(at > 0, "tick 内必须每轮调用 wakeTick.run(now)（不是靠 listReady 预判之后才调）");
  assert.doesNotMatch(
    entry,
    /WAKE_TICK_LIMIT/,
    "入口不得再按 WAKE_TICK_LIMIT 预扫：那层预判（为空即跳过 run）会让安静期的重投 / TTL 淘汰永不执行",
  );
  // 门控的另一种形态：把 run 包在条件里（`if (...) { await wakeTick.run(now); }`）。
  // 逐行判 run 所在语句不得自带条件，避免「守住了常量、却把门控换个写法又溜回来」。
  const runLine = entry.slice(entry.lastIndexOf("\n", at) + 1, entry.indexOf("\n", at));
  assert.match(runLine, /await wakeTick\.run\(now\)/, "run 必须是被 await 的直接调用");
  assert.doesNotMatch(
    runLine,
    /\bif\s*\(/,
    "run 不得被条件门控（预判为空即跳过会让重投/淘汰整段失效）",
  );
});

// 唤醒规则是**同一个库的另一条连接**：与 repo / offPeakRepo 并列，各自 close，
// 否则退出时这条句柄会跨重启泄漏（无报错，只是残留）。
// 注意：`WakeRuleRepo` 接口本身没有 close（它只是读写薄壳），句柄由调度器侧持有 ——
// 所以这里断言的是连接本身被关掉，不是 repo 上凭空多一个方法。
test("dispose 各自 close 唤醒规则的连接", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  assert.match(entry, /wakeDb\?\.close\(\)/);
  assert.doesNotMatch(
    entry,
    /wakeRuleRepo\.close\(\)/,
    "WakeRuleRepo 没有 close：句柄由调度器侧关闭",
  );
});

// 派发请求要经 main 转发到 host：常量与 schema 必须**两头都加**（常量 + 入口并集），
// 只加常量不加并集会让消息在入口被 schema 丢掉——**静默**丢，没有任何日志。
test("SquadWake 常量与 schema 都进了入口并集", () => {
  const channels = readFileSync(resolve(desktopSrc, "../../shared/src/channels.ts"), "utf8");
  assert.match(channels, /SquadWake: "squad-wake"/);
  assert.match(channels, /SquadWakeResult: "squad-wake-result"/);
  // 并集断言必须**限定在并集块内**：整文件 grep 会让「schema 定义了但没进并集」照样通过，
  // 而那正是本条要拦的失败（消息在入口被丢弃，且没有任何日志）。
  const validation = readFileSync(resolve(desktopSrc, "../../shared/src/validation.ts"), "utf8");
  const incoming = validation.slice(
    validation.indexOf("export const hostIncomingMessageSchema = z.discriminatedUnion"),
    validation.indexOf("export const hostRemoteWorkspaceConnectedResponseSchema"),
  );
  assert.match(
    incoming,
    /hostSquadWakeMessageSchema/,
    "main → host 的并集必须收 hostSquadWakeMessageSchema",
  );
  const outgoing = validation.slice(
    validation.indexOf("export const hostResponseMessageSchema = z.discriminatedUnion"),
    validation.indexOf("export const zcodeTaskPersistStatusSchema"),
  );
  assert.match(
    outgoing,
    /hostSquadWakeResultResponseSchema/,
    "host → main 的并集必须收 hostSquadWakeResultResponseSchema",
  );
});

/* ── Important-B：唤醒回执必须**真的走到** scheduler ──

   计划的 Files 漏了 `main/index.ts`，于是 host 的六处 SquadWakeResult 经 schema 校验后在 main
   被**丢掉**（`handleSquadWakeResult` 无人调用）：调度器等不到结算，那次唤醒成了「到点了但什么都
   没发生」，日志里也没有任何线索。为什么这里用逐跳断言而不是把整条链实例化：`main/index.ts` 是
   Electron 主进程入口（host 用 `electronUtilityProcess.fork` 拉起），测试进程里没有 electron 运行时，
   整条链无法启动。每一跳都在**同一份源码**里可判，**四跳齐备**才算通 —— 少任何一跳，回执都会
   在那一跳静默消失（正是上一版的形态）。 */
test("唤醒回执的每一跳都在场：host 发出 → host 进程桥 → main 转发 → scheduler 结算", () => {
  const host = readFileSync(join(desktopSrc, "host/index.ts"), "utf8");
  const hostProcess = readFileSync(join(desktopSrc, "main/desktopHostProcess.ts"), "utf8");
  const mainIndex = readFileSync(join(desktopSrc, "main/index.ts"), "utf8");
  const cronScheduler = readFileSync(join(desktopSrc, "main/desktopCronScheduler.ts"), "utf8");
  const schedulerEntry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");

  // ① host 真的发回执，且带 ruleId（调度器按 (ruleId, eventKey) 定位那条重投记录）。
  assert.match(
    host,
    /type: HostResponseTypes\.SquadWakeResult,[\s\S]{0,120}?ruleId: msg\.ruleId/,
    "① host 必须发 SquadWakeResult 并带上 ruleId",
  );
  // ② main 的 host 进程桥（schema 校验之后）把它交给依赖注入的回调 —— 校验失败会在这里被静默 return。
  assert.match(
    hostProcess,
    /result\.data\.type === HostResponseTypes\.SquadWakeResult[\s\S]{0,300}?onSquadWakeResult\?\.\(/,
    "② desktopHostProcess 必须把 SquadWakeResult 分派到 onSquadWakeResult",
  );
  // ③ main 入口把回调接上转发函数（**上一版缺的就是这一跳**）。
  assert.match(
    mainIndex,
    /onSquadWakeResult: forwardSquadWakeResult/,
    "③ spawnHostProcess 的 deps 必须接 onSquadWakeResult —— 缺这一跳就是上一版「回执被丢掉」",
  );
  const forward = mainIndex.slice(mainIndex.indexOf("function forwardSquadWakeResult"));
  assert.match(
    forward.slice(0, 400),
    /cronScheduler\?\.handleSquadWakeResult\(result\)/,
    "③ 转发函数必须真的转给 scheduler handle（不能只声明）",
  );
  // ④ scheduler 句柄把它翻成 scheduler 通道的消息。
  assert.match(
    cronScheduler,
    /handleSquadWakeResult\(result\)[\s\S]{0,200}?type: "squad-wake-dispatch-result"/,
    "④ CronSchedulerHandle.handleSquadWakeResult 必须转成 squad-wake-dispatch-result",
  );
  // ⑤ scheduler 入口**结算**它（重投 / 放弃 / 留痕），而不是只打一条日志。
  //    只打日志 = 瞬时结果（无 host / 转发失败 / 库未就绪）被丢弃，而规则已被 CAS 推进 ⇒ 那次唤醒消失。
  assert.match(
    schedulerEntry,
    /msg\.type === "squad-wake-dispatch-result"[\s\S]{0,1200}?wakeTick\.settle\(/,
    "⑤ scheduler 入口必须调 wakeTick.settle（重投向量），不能只打日志",
  );
});

/* 回执还必须**穿过 main 的 schema 校验**：desktopHostProcess 对校验失败的消息直接 return（静默丢弃），
   所以「常量进了并集」还不够，字段不全一样会被丢。`ruleId` 必填是刻意的：调度器按
   `(ruleId, eventKey)` 找重投记录，做成可选就等于允许「静默错键」（一次回执撤掉另一条规则的重投）。 */
test("squad-wake-result 穿过入口校验；缺 ruleId 被拒（不允许静默错键）", () => {
  assert.equal(
    hostResponseMessageSchema.safeParse({
      type: "squad-wake-result",
      ruleId: "w1",
      runId: "e:id:squad:wi_1:3:0",
      ok: true,
    }).success,
    true,
  );
  assert.equal(
    hostResponseMessageSchema.safeParse({
      type: "squad-wake-result",
      runId: "e:id:squad:wi_1:3:0",
      ok: true,
    }).success,
    false,
    "缺 ruleId 必须被拒（否则调度器无从定位重投记录）",
  );
});
