import { randomUUID } from "node:crypto";
import { SQUAD_INSTRUCTION_SLOTS, validateSquad, type Squad } from "@zcode/shared";
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

/**
 * 「编辑一支小队」**可改字段的白名单**（状态字段 enabled/archivedAt 有自己的入口）。
 *
 * 为什么必须是白名单而不是 `Partial<Omit<Squad, "id">>`：那是「编辑名册」与「改状态」的边界。
 * 整包部分字段展开合并（`{ ...current, ...patch }`）时，一个只想改名字的调用顺手带上
 * `enabled: false` / `archivedAt: 123` 就会**静默改掉状态**且不报错 —— 而这两件事各有入口
 * （`update({ enabled })` 与 `archive`）。白名单把「编辑定义」与「状态迁移」在类型层就分开。
 *
 * `instructions` 是**逐槽合并**的入参：只写给出的槽位，不整包替换（整包替换会把调用方
 * 没在编辑的槽位静默清掉 —— 8 槽位里界面通常只收 2 个）。
 */
export type SquadRosterPatch = {
  name?: string;
  leaderAgentId?: string;
  /** 队员 agentId 列表（**不含队长**也合法：队长会被自动并入，与 create 同规则）。 */
  members?: string[];
  /** 只合并**给出的槽位**（不清空未提供的槽位）；必填槽位被清空会被校验响亮拒绝。 */
  instructions?: Partial<Squad["instructions"]>;
};

export interface SquadService {
  create(input: CreateSquadInput): Squad;
  get(id: string): Squad | null;
  /** 含已归档：是否隐藏归档项由上层决定，存储层不做过滤。 */
  list(): Squad[];
  /** 局部更新；`id` 不可改。合并后重新校验，故不能借 update 绕过 create 的闸。 */
  update(id: string, patch: Partial<Omit<Squad, "id">>): Squad;
  /**
   * 编辑小队**可改字段的白名单**（见 `SquadRosterPatch`），返回写盘后的实体。
   *
   * 四条语义：
   * 1. **id 不存在 ⇒ 响亮抛**（`小队不存在：${id}`）—— 静默 no-op 会让界面以为改成功了；
   * 2. **只在 patch 给了 `leaderAgentId` 或 `members` 时才重建 members**（走 `create` 同款
   *    `composeMembers`：队长置首、`role: "leader"`、其余按给定顺序）。**只改名字时不得重建
   *    members** —— 重建是**有损**的（非队长的 `role` 标签在重建中不保留；今天没有别的入口设
   *    非队长 role，但「今天没有」不是「永远没有」，不能把一次改名变成一次静默的标签擦除）；
   * 3. `instructions` **逐槽合并**（只覆盖给出且非 `undefined` 的槽位），不是整包替换 ——
   *    整包替换会把用户没在编辑的那些槽位（8 槽位里界面只收一部分）**静默清掉**；
   * 4. 合并后走既有 `assertValid`（`validateSquad`）**响亮**校验；`enabled` / `archivedAt` 不在
   *    白名单（运行期多带的键被忽略，逐字段显式构造 `next`）。patch 没有任何有效字段
   *    ⇒ 返回原实体、**不重写盘**（重复点「保存」不该产生一次内容相同的重写）。
   */
  updateRoster(id: string, patch: SquadRosterPatch): Squad;
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

    /* 编辑名册（见接口注释的四条语义）。实现要点：
       ①  逐字段显式构造 `next`，**不做整包展开** —— patch 的静态类型虽是白名单，运行期的对象
          可能多带键（调用方透传 / 反序列化载荷）；展开会把 `enabled` / `archivedAt` 一起覆盖，
          一次「改名字」就能把已归档的小队悄悄复活，且不报错。逐字段构造让白名单成为**运行期**
          的承重墙，而不只是类型层的君子协定。
       ②  members 的重建是**条件性**的（只在 patch 给了 leaderAgentId / members 时）：
          重建从零拼花名册，非队长的 `role` 标签会丢 —— 只改名字的调用不该付这个代价。
       ③  instructions 逐槽合并（跳过 `undefined` 的槽位，不清空未提供的槽位）。 */
    updateRoster(id, patch) {
      const current = readSquad(root, id);
      if (!current) throw new Error(`小队不存在：${id}`);

      let name = current.name;
      let leaderAgentId = current.leaderAgentId;
      let members = current.members;
      let instructions = current.instructions;
      let changed = false;

      if (patch.name !== undefined && patch.name !== current.name) {
        name = patch.name;
        changed = true;
      }

      /* ② 只在真给了队长 / 名册时才重建：`members` 缺省用**现有名册**的 agentId（旧队长就此
         回落到普通队员），队长由 `composeMembers` 置首并去重（与 create 同一条规则）。 */
      if (patch.leaderAgentId !== undefined || patch.members !== undefined) {
        const nextLeaderAgentId = patch.leaderAgentId ?? current.leaderAgentId;
        const nextMembers = composeMembers(
          nextLeaderAgentId,
          patch.members ?? current.members.map((member) => member.agentId),
        );
        if (
          nextLeaderAgentId !== current.leaderAgentId ||
          !sameMembers(nextMembers, current.members)
        ) {
          leaderAgentId = nextLeaderAgentId;
          members = nextMembers;
          changed = true;
        }
      }

      /* ③ 逐槽合并：`undefined` 的槽位保持原值（不是"清空"）；必填槽位被清成空白由下面的
         assertValid 响亮拒绝（这里不另写一份判据）。 */
      if (patch.instructions !== undefined) {
        const merged: Squad["instructions"] = { ...current.instructions };
        let instructionsChanged = false;
        for (const slot of SQUAD_INSTRUCTION_SLOTS) {
          const value = patch.instructions[slot];
          if (value === undefined || value === merged[slot]) continue;
          merged[slot] = value;
          instructionsChanged = true;
        }
        if (instructionsChanged) {
          instructions = merged;
          changed = true;
        }
      }

      // ④ 没有任何有效字段（或全部与现值相同）⇒ 交回读到的原实体，一个字节都不落盘。
      if (!changed) return current;

      const next: Squad = {
        id: current.id,
        name,
        // description 不在白名单（不可经本入口编辑），但**必须逐字保留**（显式构造的代价）。
        ...(current.description !== undefined ? { description: current.description } : {}),
        leaderAgentId,
        members,
        instructions,
        // 状态字段不在白名单：从现值显式抄回（patch 里多带的键在类型与运行期都被忽略）。
        enabled: current.enabled,
        ...(current.archivedAt !== undefined ? { archivedAt: current.archivedAt } : {}),
      };
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
 * 两份名册是否**逐条相同**（agentId 与 role 都比）。用于 `updateRoster` 判断「重建出来的
 * 名册与现值一样」⇒ 不必写盘。逐条比而不是 `JSON.stringify` 比较：定义文件可能是手写的，
 * 键序与 `composeMembers` 的构造序不保证一致，字符串比较会把「没变」误报成「变了」。
 */
function sameMembers(a: Squad["members"], b: Squad["members"]): boolean {
  return (
    a.length === b.length &&
    a.every((member, index) => {
      const other = b[index];
      return other !== undefined && member.agentId === other.agentId && member.role === other.role;
    })
  );
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
