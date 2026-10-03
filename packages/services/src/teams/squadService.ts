import { randomUUID } from "node:crypto";
import { validateSquad, type Squad } from "@zcode/shared";
import { listSquads, readSquad, writeSquad } from "./squadStorage.js";

/* 小队（Squad）的服务层：在同步存储之上提供 CRUD + 归档。
   保持同步（与存储一致）——get/list/update/archive 都直接返回结果而非 Promise。

   本层是「花名册」的唯一组装点：`create` 把 leader **并进** members 并标 role=leader，
   再交给 Task 1 的 `validateSquad` 做跨字段校验（schema 只管形状，不管关系）。 */

export interface CreateSquadInput {
  name: string;
  description?: string;
  /** 队长：会被自动并入 `members`（spec §3.3「leader 自动作为成员」），调用方不必重复列。 */
  leaderAgentId: string;
  /** 队员 agentId 列表；**不含**队长也没关系（队长由 leaderAgentId 自动补上）。 */
  members: string[];
  /** 队长指令：缺必填槽位（stopCondition / maxRounds）会在 create/update 时抛错。 */
  instructions?: Squad["instructions"];
  /** 省略即 true：新建的小队默认启用。 */
  enabled?: boolean;
}

export interface SquadService {
  create(input: CreateSquadInput): Squad;
  get(id: string): Squad | null;
  /** 含已归档：是否隐藏归档项由上层决定，存储层不做过滤。 */
  list(): Squad[];
  /** 局部更新；`id` 不可改。合并后重新校验，故不能借 update 绕过 create 的闸。 */
  update(id: string, patch: Partial<Omit<Squad, "id">>): Squad;
  /** 归档而非硬删：只写 `archivedAt`，花名册与指令都保留。重复归档保留原时间戳。 */
  archive(id: string): Squad;
}

export interface SquadServiceDeps {
  /** 小队定义根（`resolveSquadDefinitionRoot(ws)` → `<ws>/.zcode/squad/squads`）。 */
  root: string;
  /** 队员 Agent 定义根（`resolveSquadAgentRoot(ws)` → `<ws>/.zcode/squad/agents`）。
      P1 只做小队名册 CRUD，不解析队员定义；T6 派发时才需要它把 members 的 agentId
      解析成 TeamAgent。现在接收是为了让 T6 不必改本函数的签名。 */
  teamAgentRoot: string;
}

/** 校验不过就抛**可读**错误：把 validateSquad 的中文 problems 全部带出去，
    让 UI 能一次说清「缺哪个槽位 / 队长不在名册」。**不另写一套校验**——
    队长没有终止条件时会一直派单或早早停工，这条闸必须与域模型同源。 */
function assertValid(squad: Squad, action: string): void {
  const verdict = validateSquad(squad);
  if (!verdict.ok) {
    throw new Error(`无法${action}小队：${verdict.problems.join("；")}`);
  }
}

export function createSquadService(deps: SquadServiceDeps): SquadService {
  const { root } = deps;

  return {
    create(input) {
      const squad: Squad = {
        /* id 用随机 UUID，**不**由 name 派生：同名小队若共用 id 会互相覆盖定义。 */
        id: randomUUID(),
        name: input.name,
        description: input.description,
        leaderAgentId: input.leaderAgentId,
        members: composeMembers(input.leaderAgentId, input.members),
        instructions: input.instructions ?? {},
        enabled: input.enabled ?? true,
      };
      // 先合并再校验：入参 members 可以为空，只要 leader 补得进名册。
      assertValid(squad, "创建");
      return writeSquad(root, squad);
    },

    get(id) {
      return readSquad(root, id);
    },

    list() {
      return listSquads(root);
    },

    update(id, patch) {
      const current = readSquad(root, id);
      if (!current) throw new Error(`小队不存在：${id}`);
      // patch 里即便带了 id 也被末尾的 id 覆盖，id 永不改变（改名不该换身份）。
      const next: Squad = { ...current, ...patch, id };
      assertValid(next, "更新");
      return writeSquad(root, next);
    },

    /* 归档**只做归档**（F8 冻结的无依赖签名不变）：只写 `archivedAt`，花名册与指令都保留。
       spec §3.10/§16 S10 的「归档 → 工作项指派转交队长」**不在这里**——它需要按 assignee 查工作项、
       属于工作项查询层，而本服务的 deps 只有两个定义根目录。转交由组合层 `archiveSquadAndTransfer`
       （`workitem/squadRuntime.ts`）在做完归档侧的组合后执行：`SquadService` 保持无依赖，
       转交逻辑也不必为了拿到 workItemRepo 而把本服务改造成「什么都懂」的服务。
       若把转交塞进本方法的早退分支里，「已归档但漏转交」的残局就再也修不回来。 */
    archive(id) {
      const current = readSquad(root, id);
      if (!current) throw new Error(`小队不存在：${id}`);
      // 已归档就原样返回（不重写）：时间戳记的是「何时离开在用名单」，重复点击不该把它推后。
      if (current.archivedAt !== undefined) return current;
      return writeSquad(root, { ...current, archivedAt: Date.now() });
    },
  };
}

/**
 * 把 leader **并进** members 并置于首位、标 `role: "leader"`（spec §3.3「leader 自动作为成员」）。
 * 先从入参里滤掉 leaderAgentId 再去重，是因为「A 当队长，A/B/C 是队员」是最自然的输入；
 * 若直接前置就会与入参里的队长撞成「agentId 重复」而报错。非队长的重复仍交给
 * validateSquad 拦下（重复队员会让派单与记账出现两份，不该被静默去重）。
 */
function composeMembers(leaderAgentId: string, members: string[]): Squad["members"] {
  return [
    { agentId: leaderAgentId, role: "leader" },
    ...members.filter((agentId) => agentId !== leaderAgentId).map((agentId) => ({ agentId })),
  ];
}
