import {
  resolveWorkspaceKey,
  validateWakeRule,
  type WakeRule,
  type WakeRuleKind,
  type WakeRuleMode,
} from "@zcode/shared";
import type { SquadRuntime } from "./squadContracts.js";
import type { ISquadRuntimeService, SquadWorkspaceTarget } from "./squadRuntimeService.js";
import { nextFireAtAfter } from "./wakeSchedule.js";

/* 唤醒规则的**服务面六个方法**（`listWakeRules` / `createWakeRule` / `pauseWakeRule` /
   `resumeWakeRule` / `updateWakeRule` / `deleteWakeRule`）的唯一实现（P2b 第二半 + 收口：
   让规则**能被建出来、能被暂停/恢复、能被调度真的命中**；UI 面一轮；编辑与删除一轮）。

   为什么单独成文件（照 `workItemAssignee.ts` 的两条先例）：
   ① `squadRuntimeService.ts` 是描述符那一侧、**必须保持浏览器安全**（`packages/services/src/index.ts`
      用值导入导出它，触达 `node:*` 会让 renderer 在挂载前整包失败，见 browserSafeRootEntry.test.ts）——
      本文件同样只做浏览器安全的引用（`@zcode/shared` + 本地 `wakeSchedule.js`，零 `node:*`）；
   ② `squadRuntimeService.ts` 贴着 oxlint 的 400 行硬门槛（skipComments 口径），四个方法的组装 /
      校验 / 排期 / CAS 逻辑搬出来，描述符侧只留「接上 runtime 工厂与门禁」的接线。

   **门禁口径**（服务侧唯一判据仍是 `squadRuntimeService` 的私有 `assertEnabled`，本文件不写第二份：
   经 deps 注入的 `assertEnabled` 调用）：
   - `createWakeRule` / `resumeWakeRule` / `updateWakeRule` **过门禁**：三者都让**未来的派发
     变样**（规则 = 未来派发的排班表；恢复 = 恢复排期；编辑 = 改排班表）⇒ 属 §5.7.6 的「新派发」
     的准备。次序与 `createWorkItem` 同款：**门禁在构造 runtime 之前**过 —— 门禁要回答的是
     「现在允不允许新派发」，与目标 workspace 是不是可用的 git 仓库无关；先建 runtime 会在非 git
     目标上把门禁结论换成「base 分支解析失败」，上层按稳定码分流就分不出来。
   - `pauseWakeRule` / `listWakeRules` / `deleteWakeRule` **不过门禁**：停下与删除都不是新派发
     （删掉 = 未来派发**减少**，与 pause 同款理由 —— 关掉实验开关后仍应能清掉一条配错的规则）；
     `listWakeRules` 只读。
     **本文件不得写任何第二份开关判据**。

   **CAS 与「前置读当时状态」**（照既有纪律）：pause/resume 都先 `get(id)` 拿到**当时**的
   `revision`，再用它作 `casAdvance` 的 expectRevision —— 读到写之间若有人并发改动
   （例如调度器刚 fire 并推进了一格），`changes=0` ⇒ **响亮抛**，绝不把一次「按旧状态计算」的
   状态迁移静默盖上去（那会让「已停」与「还在跑」在两边同时为真）。

   **幂等 / 响亮的分格**（本实现已定口径，逐条写清）：
   - id 不存在 ⇒ 两个方法都**响亮抛**（静默 no-op 会让界面以为动作生效了）。
   - pause 在「已经不再到点」的规则上（`nextFireAt` 为空：已暂停 / 一次性已触发完）⇒ **幂等早退**
     （不写盘、不 bump revision）：目标状态（停下来）已达成，重复点击不该产生一次内容相同的重写。
   - resume 在「已在排期」的规则上（`nextFireAt` 非空：未暂停）⇒ **幂等早退，不重算**：
     重算会把一条在跑的规则挪到新的网格轴上（静默改日程），比报错更坏；目标状态（在跑）已达成。
   - resume 重算后**没有未来排期点** ⇒ **响亮抛且不写盘**（死动作：恢复一条永不触发的规则，
     用户会以为它又开始跑了；与 create 的「建成即不触发」同一条理由）。

   **「用户暂停」的落库口径（审查收口，2026-10-03）**：实体自己有**用户启停**字段 ——
   `WakeRule.enabled`（schema 默认 true，`listReady` 的 `enabled = 1` 条件真正消费它）。
   故 pause = **关主开关 `enabled=false` + 清排期 `nextFireAt=null`**；resume = **开开关 + 重算排期**。
   为什么不写 `pausedReason`：那是**闸暂停**的专列（封闭枚举 `max_fires | rate | loop`，写枚举外值
   会让该行读不回来、调度器整批扫描炸掉；写闸的码 = 伪造闸原因）。两件事由此可分辨：
   「我停的」= `enabled=false`；「被闸停的」= `enabled=true` + `pausedReason` 有值 + 排期空。
   恢复都走 resume（闸暂停时它会清原因并重排 —— 即「人工复位」）。 */

/**
 * 建一条唤醒规则的入参（**加法**，P2b 第二半）。形状覆盖 `wakeRuleSchema` 的必填与互斥所需的字段，
 * 由 `validateWakeRule` 在服务面**响亮**校验（互斥问题以中文 problems 原样带出，见 `createWakeRule`）。
 *
 * 为什么声明在本文件（而描述符 `squadRuntimeService.ts` 只做类型转发）：那是 400 行硬门槛的
 * 拆分点 —— 与 `MemberRunRequest`（声明在 `squadRunLifecycle.ts`、由两个入口再导出）同一条先例。
 *
 * 三条有意的形状决定（逐条写清）：
 * 1. `kind` **只给三种排班 kind**（`at` / `every` / `cron`，类型上排除 `event`）：
 *    `condition` / `eventTypes` / `filters` **本轮不支持** —— 事件型规则需要**事件词汇表**
 *    （哪些事件类型、条件参数键名，spec §3.5 未枚举）⇒ 留给下一半，不猜。类型上不给入口，
 *    运行期多带的键也被组装层忽略（逐字段显式构造，不整包展开）。
 * 2. `mode` 显式给出（不替调用方默认）：`at` 只能配 `once`、`every`/`cron` 只能配 `continuous`
 *    （`validateWakeRule` 互斥第 1 条）。配错 ⇒ 中文 problems 响亮拒绝，不静默改写。
 * 3. 排期字段（`at` / `intervalSeconds` / `cronExpression`）按 kind 各带一个：给了别的 kind 的字段
 *    会被互斥第 7 条拒绝（两种调度口径并存时另一种永不生效 = 静默死配置）。
 */
export type CreateWakeRuleRequest = {
  /** 挂在哪个工作项上（必须存在、未归档、且属于本次调用的目标 workspace —— 见 createWakeRule）。 */
  workItemId: string;
  kind: Exclude<WakeRuleKind, "event">;
  mode: WakeRuleMode;
  /** `kind: "at"` 的绝对到点时刻（epoch ms）；必须**严格晚于创建时刻**（否则建成即过点 ⇒ 响亮抛）。 */
  at?: number;
  /** `kind: "every"` 的间隔秒数（正数）；首格落在创建时刻之后一个间隔内。 */
  intervalSeconds?: number;
  /** `kind: "cron"` 的表达式；创建时刻之后**必须有命中**（无未来命中 ⇒ 响亮抛）。 */
  cronExpression?: string;
  /** 连续规则的触发上限（1..1000，未给时调度侧按默认 20 执行）；只在 `continuous` 时有意义。 */
  maxFires?: number;
  /** 时区（非空；未给由调度器取默认）。**注意**：现有排期计算（croner）用本地时区，
   *  `timezone` 目前只做落盘留存 —— 已有缺口（shared TODO(P2) 第 2 条），本轮登记不补。 */
  timezone?: string;
  /** 过期时刻（epoch ms）。**注意**：调度侧尚未消费 `expires_at`（wakeTick 不判过期）——
   *  既有缺口，本轮只透传落盘，登记不猜。 */
  expiresAt?: number;
};

/** id 生成：不 import `node:crypto`（本文件必须浏览器安全，见头注释）——`globalThis.crypto` 两侧都有。 */
const newRuleId = (): string => globalThis.crypto.randomUUID();

/**
 * 编辑规则的**配置**入参（**加法**，P2b 收口：规则能改配置、能删）。
 *
 * 形状 = **与创建同集**减去三个不在此暴露的项（逐条写清，避免与 `CreateWakeRuleRequest` 漂移）：
 * · `kind` / 该 kind 的排期字段（`at` / `intervalSeconds` / `cronExpression`）/ `maxFires?` —— 与创建
 *   逐字段同义，同一份 `validateWakeRule` 校验（中文 problems 原样带出）；
 * · `mode` 保留（与创建同集）：编辑表单同样**由 kind 推导**（at⇒once、every/cron⇒continuous），
 *   推导结果随 patch 一起交上来 —— 服务面不另写一份推导（第二份判据会与域模型漂移），
 *   `validateWakeRule` 互斥第 1 条是最终判据；
 * · **不含 `workItemId`**：挂载对象不可改（改了等于换一条规则的归属 —— 列表按工作项反查归属，
 *   换归属应删旧建新），故它在类型上就没有入口；
 * · **不含 `timezone` / `expiresAt`**：第 39 轮硬约束 —— 界面不暴露（调度侧未消费 timezone、
 *   wakeTick 不判 expiresAt）。落盘的旧值原样留存（`casUpdateConfig` 不写这两列）。
 */
export type UpdateWakeRuleRequest = Omit<
  CreateWakeRuleRequest,
  "workItemId" | "timezone" | "expiresAt"
>;

/** `updateWakeRule` 的入参（id + patch）。**具名声明**而不是在描述符里内联的原因之一：
    `squadRuntimeService.ts` 贴着 400 行 lint 门槛 —— 内联形状要把签名折成四行，具名后一行装得下；
    形状本身一字未变（就是 `{ id: string; patch: UpdateWakeRuleRequest }`）。 */
export type UpdateWakeRuleInput = { id: string; patch: UpdateWakeRuleRequest };

/**
 * 首格排期点（`createWakeRule` 与 `resumeWakeRule` 共用**同一份**计算）：与调度器同一网格语义。
 *
 * - `at`：名义时刻就是 `at` 本身；`at` 必须**严格晚于 now**（否则建成即已过点）。返回 null 表示
 *   「无未来命中」。**不能对 at 直接调 `nextFireAtAfter`**：它按 `mode === "once"` 提前返回 null
 *   （那是**触发之后**的终态语义），会把每一条合法的「未来 at」规则都误判成死配置。
 * - `every`：锚点取 `now`（创建/恢复时刻），交给调度器的 `nextFireAtAfter` 推一格（严格晚于 now，
 *   落点 = now + interval ⇒ 「nextFireAt 落在未来一个间隔内」）。锚点一旦落盘就固定（后续推进
 *   只做整数倍步进，网格不漂移）；恢复时锚点 = 恢复时刻（不补跑错过的窗口，与 misfire-skip 同义）。
 * - `cron`：表达式在 `now` 之后的下一次命中（`nextFireAtAfter` 的 cron 分支不读名义时刻——
 *   cron 的网格就是表达式命中的那些时刻）。null ⇒ 无未来命中。
 *
 * `every`/`cron` 缺各自的排期字段时 `nextFireAtAfter` 会抛（validateWakeRule 已先拦，理论不可达）。
 */
function initialNextFireAt(rule: WakeRule, now: number): number | null {
  if (rule.kind === "at") {
    return rule.at !== undefined && rule.at > now ? rule.at : null;
  }
  if (rule.kind === "every") {
    // 名义时刻锚点 = now（`nextFireAtAfter` 的 every 分支要求规则自带 next_fire_at）。
    return nextFireAtAfter({ ...rule, nextFireAt: now }, now);
  }
  return nextFireAtAfter(rule, now);
}

/** `initialNextFireAt` 返回 null 的**原因口径**（写进响亮错误文案，便于直接定位是哪一条不成立）。 */
function noFutureScheduleReason(rule: WakeRule, now: number): string {
  if (rule.kind === "at") {
    return rule.at === undefined
      ? "kind「at」没有 at（validateWakeRule 本应拦住）"
      : `「at」的到点时刻 ${rule.at}（${new Date(rule.at).toISOString()}）不晚于当前时刻 ${now}——到点时刻已经过去`;
  }
  if (rule.kind === "cron") {
    return `cron 表达式「${rule.cronExpression ?? "<缺失>"}」在当前时刻之后没有任何命中（无未来排期点）`;
  }
  return `kind「${rule.kind}」推进后没有下一格`;
}

/**
 * 组装新规则：**逐字段显式构造**（不整包展开入参 —— 运行期多带的键必须被忽略，照 `updateRoster`
 * 的白名单纪律）。`condition` / `eventTypes` / `filters` **本轮不支持**：类型上就没有入口
 * （事件型规则需要**事件词汇表**，spec 未枚举 ⇒ 留给下一半，不猜）。
 * `fireCount` / `revision` / `enabled` 显式给初值（schema 的 default 只对 parse 生效，这里是构造）。
 */
function assembleWakeRule(input: CreateWakeRuleRequest, id: string): WakeRule {
  const rule: WakeRule = {
    id,
    workItemId: input.workItemId,
    kind: input.kind,
    mode: input.mode,
    fireCount: 0,
    revision: 0,
    enabled: true,
  };
  // 排期字段原样透传（给了哪个传哪个）：**混装 / 缺字段由 validateWakeRule 出中文 problems**，
  // 组装层不另写一套判据（第二份判据会与域模型漂移）。
  if (input.at !== undefined) rule.at = input.at;
  if (input.intervalSeconds !== undefined) rule.intervalSeconds = input.intervalSeconds;
  if (input.cronExpression !== undefined) rule.cronExpression = input.cronExpression;
  if (input.maxFires !== undefined) rule.maxFires = input.maxFires;
  if (input.timezone !== undefined) rule.timezone = input.timezone;
  if (input.expiresAt !== undefined) rule.expiresAt = input.expiresAt;
  return rule;
}

export type WakeRuleOpsDeps = {
  /** 按目标现构 runtime（裁定 4 + 确认 3：不缓存、不取首个）——与描述符侧同一个工厂。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /** 服务侧**唯一**门禁（描述符里的私有 `assertEnabled`）：create / resume 在构造 runtime **之前**过它。 */
  assertEnabled: () => Promise<void>;
};

export function createWakeRuleOps(
  deps: WakeRuleOpsDeps,
): Pick<
  ISquadRuntimeService,
  | "listWakeRules"
  | "createWakeRule"
  | "pauseWakeRule"
  | "resumeWakeRule"
  | "updateWakeRule"
  | "deleteWakeRule"
> {
  /** 本 runtime 的 `workspace_key`（C14 口径）：与 `getSnapshot` / `createWorkItem` 同一条式子。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

  /**
   * 规则的宿主工作项体检（创建时）：**不存在 / 已归档 / 不属于目标 workspace** ⇒ 响亮抛。
   *
   * 为什么必须查：规则是挂在工作项上的排班表 ——（a）调度器按工作项解析派发目标
   * （`wake_rules` 没有 workspace 列，host 对归档工作项一律解析为 null ⇒ tick 响亮失败），
   * 挂不上的规则**永远不会触发**；（b）`listWakeRules` 按「本 workspace 的工作项 id 集合」反查，
   * 挂到别处（或挂到已归档项）的规则**从列表里消失** —— 两者都是「静默死配置」的形态，
   * 与 pause 不写假的 pausedReason 是同一条理由：宁可此刻响亮，也不留下一条谁也看不见的规则。
   */
  const assertRuleHost = (runtime: SquadRuntime, workItemId: string): void => {
    const item = runtime.workItemRepo.get(workItemId);
    if (!item) {
      throw new Error(
        `无法创建唤醒规则：工作项「${workItemId}」不存在或已归档。` +
          "规则是挂在工作项上的排班表（调度器按工作项解析派发目标）——挂不上的规则永远不会触发，" +
          "静默落盘只会让它在界面上看起来正常。",
      );
    }
    const itemKey = resolveWorkspaceKey({
      workspacePath: item.workspacePath,
      workspaceIdentity: item.workspaceIdentity,
    });
    if (itemKey !== keyOf(runtime)) {
      throw new Error(
        `无法创建唤醒规则：工作项「${workItemId}」不属于本次调用的目标 workspace` +
          `（目标「${keyOf(runtime)}」，工作项「${itemKey}」）。` +
          "规则按工作项反查归属（wake_rules 没有 workspace 列），挂到别处会从本 workspace 的列表里消失。",
      );
    }
  };

  /** CAS 未命中的统一响亮文案（pause / resume 共用；静默丢弃会让界面以为动作生效了）。 */
  const casMissError = (action: string, id: string, revision: number): Error =>
    new Error(
      `${action}唤醒规则失败：规则「${id}」的 CAS 未命中（revision ${revision} 已被并发改动，` +
        "例如调度器刚推进了一格）。静默丢弃会让用户以为动作生效了，而库里的状态并不是那样。请重读后再试。",
    );

  return {
    /**
     * 本 workspace 的唤醒规则（经工作项反查 —— `wake_rules` 表没有 workspace 列，见调度器注释）。
     * **不过门禁**：只读不是新派发。取数：`listAll()` 全量读出后用本 workspace 的工作项 id 集合过滤
     * （过滤判据只有这一处；排序由 repo 单源给出，本层不重排）。
     */
    async listWakeRules(target) {
      const runtime = await deps.createRuntime(target);
      const itemIds = new Set(
        runtime.workItemRepo.listByWorkspace(keyOf(runtime)).map((item) => item.id),
      );
      return runtime.wakeRuleRepo.listAll().filter((rule) => itemIds.has(rule.workItemId));
    },

    /**
     * 建一条唤醒规则。**过门禁**（规则 = 未来派发的排班表，属「新派发」的准备；次序：门禁在
     * 构造 runtime 之前，照 `createWorkItem`）。
     *
     * 四步，次序固定：① 组装（逐字段）；② `validateWakeRule` **优先**（中文 problems 原样带出）；
     * ③ 首格排期（与调度器**同一份** `nextFireAtAfter`；`null` ⇒ 死配置 ⇒ **响亮抛**）；
     * ④ `insert` 写盘后**读回**返回（照 `updateRoster` 的读回口径）。
     */
    async createWakeRule(target, input) {
      await deps.assertEnabled();
      const runtime = await deps.createRuntime(target);
      const now = Date.now();
      const rule = assembleWakeRule(input, newRuleId());
      const verdict = validateWakeRule(rule);
      if (!verdict.ok) {
        throw new Error(`无法创建唤醒规则：${verdict.problems.join("；")}`);
      }
      assertRuleHost(runtime, rule.workItemId);
      const nextFireAt = initialNextFireAt(rule, now);
      if (nextFireAt === null) {
        // 死配置：建成即永不触发。静默落盘正是本半要消灭的形态（listReady 永远扫不到它）。
        throw new Error(
          `无法创建唤醒规则：这条规则建成即永不触发（死配置）—— ${noFutureScheduleReason(rule, now)}。` +
            "静默落盘只会让界面看起来正常，而调度器的到点扫描（next_fire_at <= now）永远扫不到它。",
        );
      }
      rule.nextFireAt = nextFireAt;
      runtime.wakeRuleRepo.insert(rule);
      const readBack = runtime.wakeRuleRepo.get(rule.id);
      if (!readBack) {
        throw new Error(
          `创建唤醒规则失败：规则「${rule.id}」写入成功后读回为空（理论不可达）——` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return readBack;
    },

    /**
     * 暂停（不清除配置）：置空 `nextFireAt`（= 不再是到点扫描的候选），`pausedReason` 原样保留
     * （口径与理由见文件头注释 —— 不伪造闸原因）。**不过门禁**：停下不是新派发。
     * 已不再到点的规则上**幂等早退**（不写盘、不 bump revision）。
     */
    async pauseWakeRule(target, input) {
      const runtime = await deps.createRuntime(target);
      const rule = runtime.wakeRuleRepo.get(input.id);
      if (!rule) {
        throw new Error(
          `暂停唤醒规则失败：规则「${input.id}」不存在或读不回来。` +
            "静默 no-op 会让界面以为它已经停下来了，而到点扫描仍会命中它。",
        );
      }
      // 幂等：主开关已关（目标状态「停下来」已达成）⇒ 不写盘、不 bump revision。
      if (!rule.enabled) return;
      /* **关主开关 + 清排期**：`enabled` 是**用户启停**（`listReady` 的 `enabled = 1` 条件），
         语义与「闸暂停」（`pausedReason` + 清排期、开关不动）分开 —— 于是界面上「我停的」与
         「被闸停的」是两件可分辨的事，各自带各自的复位路径（resume / 等窗口滑过或 resume）。
         `pausedReason` 原样保留（不伪造闸原因：那是封闭枚举，写码 = 假数据）。 */
      const ok = runtime.wakeRuleRepo.casAdvance(
        rule.id,
        rule.revision,
        null,
        rule.fireCount,
        rule.pausedReason,
        false,
      );
      if (!ok) throw casMissError("暂停", rule.id, rule.revision);
    },

    /**
     * 恢复：清 `pausedReason` 并**重算** `nextFireAt`（与 `createWakeRule` 同一份首格排期计算）。
     * **过门禁**（恢复 = 让未来的派发重新可能）；次序同 create：门禁在构造 runtime 之前。
     * 已在排期的规则上**幂等早退且不重算**（重算会静默挪动在跑规则的网格）；
     * 重算后没有未来排期点 ⇒ **响亮抛且不写盘**（死动作，理由见文件头注释）。
     */
    async resumeWakeRule(target, input) {
      await deps.assertEnabled();
      const runtime = await deps.createRuntime(target);
      const rule = runtime.wakeRuleRepo.get(input.id);
      if (!rule) {
        throw new Error(
          `恢复唤醒规则失败：规则「${input.id}」不存在或读不回来。` +
            "静默 no-op 会让界面以为它又开始跑了。",
        );
      }
      // 幂等：开关开着**且**已在排期（目标状态「在跑」已达成）⇒ 不写盘、更不重算
      // （重算会把一条在跑的规则挪到新的网格轴上，静默改日程比报错更坏）。
      if (rule.enabled && rule.nextFireAt !== undefined) return;
      const now = Date.now();
      const nextFireAt = initialNextFireAt(rule, now);
      if (nextFireAt === null) {
        throw new Error(
          `无法恢复唤醒规则：重算后没有未来排期点 —— ${noFutureScheduleReason(rule, now)}。` +
            "恢复一条永不触发的规则等于建一条死配置，用户会以为它又开始跑了。**不写盘**（该行保持原样）。",
        );
      }
      const ok = runtime.wakeRuleRepo.casAdvance(
        rule.id,
        rule.revision,
        nextFireAt,
        rule.fireCount,
        undefined, // 清 pausedReason（闸暂停的复位路径；`undefined ⇒ null`）
        true,
      );
      if (!ok) throw casMissError("恢复", rule.id, rule.revision);
    },

    /**
     * 编辑规则的**配置**（kind + 排期字段 + maxFires；挂载对象不可改）。**过门禁**（编辑让未来派发
     * 变样 —— 与 createWakeRule 同一处判据、同一次序：门禁在构造 runtime **之前**过）。
     *
     * 复用**同一份**组装与首格排期（不得另写校验 / 排期）。六步，次序固定：
     * ① 读现行（不存在 ⇒ 响亮抛：静默 no-op 会让界面以为保存成功了）；
     * ② **合并**：`assembleWakeRule({...patch, workItemId: rule.workItemId}, rule.id)` 造出
     *    「新配置实体」—— 实体只由 patch 的字段构成，**旧 kind 的排期字段不会被带进来**
     *    （kind 切换即天然清掉；若写成 `{...rule, ...patch}`，every→cron 会把旧的 intervalSeconds
     *    与新表达式一起留在实体里 —— 正是 `validateWakeRule` 互斥第 7 条要拦的脏形状）；
     * ③ **不归编辑管**的字段从现行抄回：`fireCount` / `enabled` / `pausedReason`（若有）/
     *    `expiresAt`（若有；本方法不写这一列，抄回只为实体自洽）。编辑不改开关与闸态。
     * ④ `validateWakeRule` 不过 ⇒ 响亮抛（中文 problems 原样带出）；
     * ⑤ 排期：**在跑**（`enabled === true` **且无** `pausedReason`）⇒
     *    `nextFireAt = initialNextFireAt(merged, now)`（与 create / resume **同一份**首格计算），
     *    `null` ⇒ **响亮抛且不写盘**（死配置，理由同 create）；
     *    **暂停中**（用户暂停 `enabled === false`，或闸暂停 `pausedReason` 有值）⇒ 排期置空 ——
     *    暂停中编辑不改排期（那是 resume 的事，恢复路径本就会重算）。
     *    **两处「暂停中」一视同仁（有意收口，登记）**：闸暂停的落库形态是
     *    `enabled=true + pausedReason + 排期空`，若编辑只按 `enabled` 重排，就会在保留闸原因的同时
     *    把规则重新排上（界面显示「防失控已停」而它其实会再触发）—— 与「编辑不改闸态」直接矛盾。
     * ⑥ `casUpdateConfig` 写盘（**revision+1**，§5.7 fencing 契约）；CAS 未命中（并发改动，例如
     *    调度器刚推进一格）⇒ 用既有 `casMissError` 的口径响亮抛；读回返回。
     */
    async updateWakeRule(target, input) {
      await deps.assertEnabled();
      const runtime = await deps.createRuntime(target);
      const rule = runtime.wakeRuleRepo.get(input.id);
      if (!rule) {
        throw new Error(
          `编辑唤醒规则失败：规则「${input.id}」不存在或读不回来。` +
            "静默 no-op 会让界面以为保存成功了，而库里仍是旧配置。",
        );
      }
      /* ② 合并（见 doc）；③ 抄回不归编辑管的字段。`revision` 也抄现行 —— 写盘时由 SQL 做
         revision+1，实体自身保持「写盘前是哪一版」的诚实（CAS 用 rule.revision 作前置）。 */
      const merged = assembleWakeRule({ ...input.patch, workItemId: rule.workItemId }, rule.id);
      merged.fireCount = rule.fireCount;
      merged.enabled = rule.enabled;
      if (rule.pausedReason !== undefined) merged.pausedReason = rule.pausedReason;
      if (rule.expiresAt !== undefined) merged.expiresAt = rule.expiresAt;
      merged.revision = rule.revision;

      const verdict = validateWakeRule(merged);
      if (!verdict.ok) {
        throw new Error(`无法编辑唤醒规则：${verdict.problems.join("；")}`);
      }

      const now = Date.now();
      if (merged.enabled && merged.pausedReason === undefined) {
        const nextFireAt = initialNextFireAt(merged, now);
        if (nextFireAt === null) {
          throw new Error(
            `无法编辑唤醒规则：改后的配置永不触发（死配置）—— ${noFutureScheduleReason(merged, now)}。` +
              "静默落盘会让界面看起来正常，而调度器的到点扫描（next_fire_at <= now）永远扫不到它；" +
              "**不写盘**（该行保持原样）。",
          );
        }
        merged.nextFireAt = nextFireAt;
      } else {
        // 暂停中（用户暂停 / 闸暂停）编辑：排期保持空 —— 恢复路径（resume）本就会重算。
        merged.nextFireAt = undefined;
      }

      if (!runtime.wakeRuleRepo.casUpdateConfig(rule.id, rule.revision, merged)) {
        throw casMissError("编辑", rule.id, rule.revision);
      }
      const readBack = runtime.wakeRuleRepo.get(rule.id);
      if (!readBack) {
        throw new Error(
          `编辑唤醒规则失败：规则「${rule.id}」写入成功后读回为空（理论不可达）——` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return readBack;
    },

    /**
     * 删除规则。**不过门禁**（删掉 = 未来派发**减少**，与 pauseWakeRule 同款理由：关掉实验开关后
     * 也要能清配置 —— 试验中配错一条 cron 的出路就在这里）。
     *
     * 两步：① 读现行（不存在 ⇒ 响亮抛：静默 no-op 会让界面以为删除成功了，而列表里还留着它）；
     * ② `remove`；**未命中**（读到之后被别人删了）⇒ 响亮抛且文案说清「可能已被并发删除」。
     * 删除的后果（`fire_count` 等触发记录随行消失、**不可撤销**）由 UI 的二次确认文案向用户交代
     * （`squad.rules.deleteConfirmDescription`）；本层不写第二份确认逻辑，也不做软删（见 repo doc）。
     */
    async deleteWakeRule(target, input) {
      const runtime = await deps.createRuntime(target);
      const rule = runtime.wakeRuleRepo.get(input.id);
      if (!rule) {
        throw new Error(
          `删除唤醒规则失败：规则「${input.id}」不存在或读不回来。` +
            "静默 no-op 会让界面以为它已经被删掉了，而列表里还留着。",
        );
      }
      if (!runtime.wakeRuleRepo.remove(input.id)) {
        throw new Error(
          `删除唤醒规则失败：规则「${input.id}」未被删除（可能已被并发删除）。` +
            "恰命中一行才算成功 —— 静默丢弃会让界面与库里的状态分叉。",
        );
      }
    },
  };
}
