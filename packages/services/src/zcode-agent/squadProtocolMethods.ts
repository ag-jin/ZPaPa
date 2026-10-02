import { randomUUID } from "node:crypto";
import {
  zcodeSquadAssignWorkItemParamsSchema,
  zcodeSquadCreateChildWorkItemParamsSchema,
  zcodeSquadListRosterParamsSchema,
  type ZCodeSquadAssignWorkItemProtocolResult,
  type ZCodeSquadCreateChildWorkItemProtocolResult,
  type ZCodeSquadListRosterProtocolResult,
} from "@zcode/shared";
import type {
  ISquadRuntimeService,
  SquadWorkspaceTarget,
} from "../workitem/squadRuntimeService.js";

/* 队长派单的三个协议方法（`squad/*`）的**实现体**（Task 7 追加范围 item ①）。

   为什么单独一个文件、而不是直接把逻辑写进 `zcodeAgentService.ts` 的 `client.onRequest` if 链：
   那条链已有 14 个分支、上下文极重，而 `client.onRequest` 只能在**真实连接**里跑到 ⇒ 写进去
   就没法对「哪个协议方法落到哪个服务方法」这件事本身写用例。故 `zcodeAgentService.ts` 里
   那三个分支只做三件事：**显式构造目标**、调用本文件的对应方法、把结果写成应答。

   三条本文件必须守的边界：
   1. **只经 `ISquadRuntimeService`**（不 import 任何 repo / workItemService）：工作项状态的唯一写者
      是 `workItemService.transition`（spec §4.3 / §5.1），台账的唯一写入口是运行生命周期。
      本文件若自己去碰 repo，队长就多了一条绕过唯一写者的通路，而这条通路**不会有任何编译错**。
   2. **不读实验开关**：门禁判据只有服务层一处（确认 2）。开关关闭时服务层抛
      `SquadDispatchDisabledError`（稳定码 `squad_dispatch_disabled`），本文件把它**原样**翻译成
      应答（稳定码落到 `data.code`、文案逐字保留），不吞、不改写、不自己再判一遍。
   3. **目标显式**：每个方法第一个参数就是目标 workspace（裁定 4：没有隐式默认、没有环境绑定，
      结构上不存在「取首个 workspace」）。

   花名册的「哪个小队」（一处**已登记的** P2b 口径）：协议面没有 squad 参数
   （`listRoster` 的 params 是 `{}`，workspace 由 host 从 session 注入），而本期的工作区口径是
   **单小队**（多小队需要 session→squad 绑定，属 P2c）。故规则是「**恰好**一个在用小队，否则
   响亮拒绝并列出候选」——静默挑一个正是本项目一路在消灭的那类错选：用户看到的是「我明明派给了
   A 队」，真相却是在 B 队的名册上做校验，且两边都不报错。 */

const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;
/** 与既有 `offPeak/*` 分支同形：服务面没接上 ⇒ 按方法不存在响亮回执（静默 no-op 更糟）。 */
const SERVICE_UNAVAILABLE_CODE = -32601;

export type SquadProtocolError = { code: number; message: string; data?: unknown };

/** handler 的返回值就是「该怎么应答」：`ok:true` ⇒ respond，`ok:false` ⇒ respondError。
    做成判别联合而不是抛异常，是为了让 `zcodeAgentService.ts` 的分支体只剩三行，
    同时让 `code`（-32602 / -32603 / -32601）在用例里可直接断言。 */
export type SquadProtocolResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: SquadProtocolError };

export interface SquadProtocolHandlers {
  createChildWorkItem(
    target: SquadWorkspaceTarget,
    params: unknown,
  ): Promise<SquadProtocolResult<ZCodeSquadCreateChildWorkItemProtocolResult>>;
  assignWorkItem(
    target: SquadWorkspaceTarget,
    params: unknown,
  ): Promise<SquadProtocolResult<ZCodeSquadAssignWorkItemProtocolResult>>;
  listRoster(
    target: SquadWorkspaceTarget,
    params: unknown,
  ): Promise<SquadProtocolResult<ZCodeSquadListRosterProtocolResult>>;
}

/** zod 校验失败的**结构**形状（只取此文件要用的两件东西，不引入 zod 的类型依赖）。 */
type ParamsParseError = {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
  flatten(): unknown;
};

function invalidParams(method: string, error: ParamsParseError): SquadProtocolResult<never> {
  /* 文案里带**出错字段**：上层（工具 → 模型）读到的是这条 message，只回一句
     "Invalid params" 等于让调用方去猜哪个字段写错了。明细仍完整放进 `data`（供 CLI 侧排查）。 */
  const summary = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return {
    ok: false,
    error: {
      code: INVALID_PARAMS_CODE,
      message: `Invalid ${method} params: ${summary}`,
      data: error.flatten(),
    },
  };
}

/**
 * 服务面的错误 → 应答。**文案逐字保留**、稳定码（`error.code` 是字符串时）落到 `data.code`。
 *
 * 为什么保留稳定码：上层（CLI 的 SquadPort → 工具 → 模型）按码分流「实验关了 / 别的失败」。
 * 只回文案会把「按码分流」重新变成「读文案」，而文案会改（这正是既有
 * `AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE` 那条约定要防的）。
 */
function translateServiceError(error: unknown): SquadProtocolResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    ok: false,
    error: {
      code: INTERNAL_ERROR_CODE,
      message,
      ...(typeof code === "string" ? { data: { code } } : {}),
    },
  };
}

export function createProtocolSquadHandlers(deps: {
  /**
   * 服务面的来路。**惰性**（每次调用才取）：组合根在 ServiceCollection 装配完成后回填，
   * 而协议连接可能早于/晚于那个时点建立 —— 直接捕获实例会在装配顺序上留下时序陷阱。
   */
  resolveSquadRuntimeService: () => ISquadRuntimeService | undefined;
}): SquadProtocolHandlers {
  /** 取服务面；取不到就响亮（照 `offPeak/*` 分支的 `-32601 ... is unavailable` 同形）。 */
  function resolveService():
    | { service: ISquadRuntimeService }
    | { failure: SquadProtocolResult<never> } {
    const service = deps.resolveSquadRuntimeService();
    return service
      ? { service }
      : {
          failure: {
            ok: false,
            error: {
              code: SERVICE_UNAVAILABLE_CODE,
              message: "squad runtime service is unavailable on this host",
            },
          },
        };
  }

  return {
    /* 建子工作项 → `createWorkItem`（**入口②**「指派即入队」那一条服务面路径）。
       子项与指派在**同一次**调用里落到服务层：分开写会出现「子项建好了、指派没落」的半程状态，
       而那条半程状态在台账里看不出来（工作项是 todo、派发事件不存在）。 */
    async createChildWorkItem(target, params) {
      const parsed = zcodeSquadCreateChildWorkItemParamsSchema.safeParse(params);
      if (!parsed.success) return invalidParams("squad create-child-work-item", parsed.error);
      const resolved = resolveService();
      if ("failure" in resolved) return resolved.failure;
      try {
        const item = await resolved.service.createWorkItem(target, {
          title: parsed.data.title,
          // body 省略时不带这个键（服务面把它落成 ""）：显式给 undefined 与不给等价，
          // 但少一个键可以让「谁写了这个字段」在调用点一眼可读。
          ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
          parentId: parsed.data.parentId,
          assignee: { type: "agent", id: parsed.data.assigneeAgentId },
        });
        return { ok: true, result: { workItemId: item.id } };
      } catch (error) {
        return translateServiceError(error);
      }
    },

    /* 派给队员 → `openMemberRun`（**入口③**：队长的派单工具与规则 tick 的队员段汇到这里）。
       为什么是它而不是「改 assignee」：服务面上「起一位队员的一次运行 + 它的工作树 + 台账行」
       只有这一个入口，而「派给队员」的语义恰恰是这三件事一起发生（spec §6.1 的隔离承诺）。
       工作项状态一个字节都不写（唯一写者不变）。 */
    async assignWorkItem(target, params) {
      const parsed = zcodeSquadAssignWorkItemParamsSchema.safeParse(params);
      if (!parsed.success) return invalidParams("squad assign-work-item", parsed.error);
      const resolved = resolveService();
      if ("failure" in resolved) return resolved.failure;
      const { service } = resolved;
      try {
        /* 台账按 parent 归批（批次收尾读 `listByParent`），而协议只给了 workItemId ⇒
           必须先读到这条工作项才能知道它属于哪一批。读不到就**响亮**：
           静默造一条 parent 为自身/空的台账行，会把这次派发挂到一个不存在的批次上。 */
        const snapshot = await service.getSnapshot(target);
        const workItem = snapshot.workItems.find(
          (candidate) => candidate.id === parsed.data.workItemId,
        );
        if (!workItem) {
          return {
            ok: false,
            error: {
              code: INTERNAL_ERROR_CODE,
              message:
                `工作项不存在：${parsed.data.workItemId}。派单必须挂在一条真实工作项上` +
                "（静默造行会让它飘在批之外，且收尾永远看不到它）。",
            },
          };
        }
        await service.openMemberRun(target, {
          /* runId 由本次调用新造（真派发 = 一次新运行）。这与「同一条事实重投要幂等」不冲突：
             那条幂等键（eventKey）属于**规则事实**，而队长工具调用不是事实重投。
             同一位队员在同一条工作项上被派两次会在开树时撞「分支已被占用」而**响亮**失败
             （`planBranches` 对 (workItem, agent) 是确定的）——已知缺口「重复指派合并为一次」
             属 P2c，不在本任务。 */
          runId: randomUUID(),
          workItemId: workItem.id,
          parentWorkItemId: workItem.parentId ?? workItem.id,
          agentId: parsed.data.agentId,
          // 派给队员永远不是队长 run：队长 run 不建树，走的是另一条派发路径（host 的 SquadWake）。
          isLeaderTask: false,
        });
        return { ok: true, result: { dispatched: true } };
      } catch (error) {
        return translateServiceError(error);
      }
    },

    /* 列花名册 → `getSnapshot` 的**只读投影**（CLI 侧 `assignWorkItem` 靠它把「派给不存在的人」
       变成响亮失败）。只读 ⇒ 不过门禁（§5.7.6 只停**新派发**），开关关闭时它仍可用。 */
    async listRoster(target, params) {
      const parsed = zcodeSquadListRosterParamsSchema.safeParse(params ?? {});
      if (!parsed.success) return invalidParams("squad list-roster", parsed.error);
      const resolved = resolveService();
      if ("failure" in resolved) return resolved.failure;
      try {
        const snapshot = await resolved.service.getSnapshot(target);
        // 归档 = 长期退出（spec §3.10）：花名册与指令都还在，但不再接新派发 ⇒ 不参与候选，
        // 否则一条归档掉的小队会让在用小队的解析被搅成「多候选」而响亮失败。
        const squads = snapshot.squads.filter((squad) => squad.archivedAt === undefined);
        if (squads.length === 0) {
          return {
            ok: false,
            error: {
              code: INTERNAL_ERROR_CODE,
              message:
                "花名册无法解析：本工作区没有任何在用的小队。派单需要一支小队的名册" +
                "（静默回一份空名册会让 CLI 的花名册校验把每个队员都判成「不在名册」）。",
            },
          };
        }
        if (squads.length > 1) {
          return {
            ok: false,
            error: {
              code: INTERNAL_ERROR_CODE,
              message:
                `花名册无法解析：本工作区有 ${squads.length} 个在用小队，必须显式指定一个` +
                `（本期不支持多小队，session→squad 绑定属 P2c）→ ` +
                squads.map((squad) => `${squad.leaderAgentId}(${squad.name})`).join(" / "),
            },
          };
        }
        const squad = squads[0]!;
        return {
          ok: true,
          result: {
            leaderAgentId: squad.leaderAgentId,
            // 队长单列在 leaderAgentId 上，members 只留队员；调用方（CLI）取两者的**并集**，
            // 所以两种口径都不会漏人——区别只在这份回执读起来是否与它的字段名一致。
            members: squad.members
              .filter((member) => member.agentId !== squad.leaderAgentId)
              .map((member) => ({ agentId: member.agentId })),
          },
        };
      } catch (error) {
        return translateServiceError(error);
      }
    },
  };
}
