import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.match(entry, /createWakeTick/, "scheduler 入口必须引用并启动 createWakeTick，否则生产静默不跑");
  assert.match(entry, /wakeTick\.run\(/, "scheduler 入口必须真的调用 wakeTick.run(...)");
});

test("fork 的模块路径指向 scheduler 入口（不是别的目录）", () => {
  const env = readFileSync(join(desktopSrc, "main/desktopRuntimeEnv.ts"), "utf8");
  assert.match(env, /schedulerModulePath = join\(import\.meta\.dirname, "\.\.\/scheduler\/index\.js"\)/);
});

// recon.md 缺口 #6：唤醒规则必须接进**既有的 20 秒 tick**，不得新增第二套定时器——
// 两套 tick 会相对漂移，misfire / 退避语义也会跟着出现第二套口径。
test("唤醒规则复用同一个 20s tick，没有第二套定时器", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  const intervals = entry.match(/setInterval\(/g) ?? [];
  assert.equal(intervals.length, 1, "只允许唯一的 20s tick 定时器（pollTimer）");
  assert.match(entry, /requireWakeRuleRepo\(\)\.listReady\(now, WAKE_TICK_LIMIT\)/, "tick 内必须按 limit 扫到点规则");
});

// 唤醒规则是**同一个库的另一条连接**：与 repo / offPeakRepo 并列，各自 close，
// 否则退出时这条句柄会跨重启泄漏（无报错，只是残留）。
// 注意：`WakeRuleRepo` 接口本身没有 close（它只是读写薄壳），句柄由调度器侧持有 ——
// 所以这里断言的是连接本身被关掉，不是 repo 上凭空多一个方法。
test("dispose 各自 close 唤醒规则的连接", () => {
  const entry = readFileSync(join(desktopSrc, "scheduler/index.ts"), "utf8");
  assert.match(entry, /wakeDb\?\.close\(\)/);
  assert.doesNotMatch(entry, /wakeRuleRepo\.close\(\)/, "WakeRuleRepo 没有 close：句柄由调度器侧关闭");
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
  assert.match(incoming, /hostSquadWakeMessageSchema/, "main → host 的并集必须收 hostSquadWakeMessageSchema");
  const outgoing = validation.slice(
    validation.indexOf("export const hostResponseMessageSchema = z.discriminatedUnion"),
    validation.indexOf("export const zcodeTaskPersistStatusSchema"),
  );
  assert.match(outgoing, /hostSquadWakeResultResponseSchema/, "host → main 的并集必须收 hostSquadWakeResultResponseSchema");
});
