import { randomUUID } from "node:crypto";
import type { AgentSummary, TeamAgent, TeamAgentInput } from "@zcode/shared";
import { listTeamAgents, readTeamAgent, writeTeamAgent } from "./teamAgentStorage.js";

/* 协作智能体的服务层：在 Task 7 的同步存储之上提供 CRUD + 一次性预填。
   保持同步（与存储一致）——get/list/archive/setEnabled 都直接返回结果而非 Promise。

   预填的语义是**拷贝而非引用**（spec §3.2）：来源 subagent 此后被重命名、改路径、删除，
   都不影响预填出的草稿。本文件是唯一定义「拷贝哪些字段」的地方，也是唯一给出
   「不拷贝哪些字段」的地方（id / path / scope / source / pluginId）。 */

export interface CreateTeamAgentInput {
  name: string;
  description?: string;
  color?: TeamAgent["color"];
  systemPrompt: string;
  /** 省略即空数组：新队友默认不带技能，避免静默继承一堆意外的能力。 */
  skills?: string[];
  modelSelection?: TeamAgent["modelSelection"];
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: TeamAgent["permissionMode"];
  /** 记忆作用域必须显式给出：它决定记忆写到哪个命名空间，猜错会把记忆写串。 */
  memoryScope: TeamAgent["memoryScope"];
  /** 每 agent 最大并发 run 数（C1）：省略即不落盘，读数方经 resolve 拿缺省 6。 */
  maxConcurrentRuns?: TeamAgent["maxConcurrentRuns"];
  /** 省略即 true：新建的队友默认启用，用户不必额外开一次开关。 */
  enabled?: boolean;
  provenance?: TeamAgent["provenance"];
}

/**
 * 「编辑一个协作智能体」**可改字段的白名单**（`update` 的入参形状）。
 *
 * 为什么必须是**白名单**而不是 `Partial<TeamAgent>`：那是「编辑名字」与「改状态」的边界。
 * 若 `update` 收整包 `TeamAgent` 的部分字段并展开合并（`{ ...agent, ...patch }`），
 * 一个只想改名字的调用顺手带上 `enabled: false` / `archivedAt: 123` 就会**静默改掉状态**，
 * 且不报任何错 —— 而这两件事各有自己的入口（`setEnabled` / `archive`，语义与通知都不同）。
 * 白名单把「编辑定义」与「状态迁移」在类型层就分开：越界的字段**传不进来**。
 */
export type TeamAgentEditablePatch = Partial<
  Pick<
    TeamAgent,
    "name" | "systemPrompt" | "memoryScope" | "maxConcurrentRuns" | "description" | "color" | "modelSelection"
  >
>;

export interface TeamAgentService {
  create(input: CreateTeamAgentInput): TeamAgent;
  get(id: string): TeamAgent | null;
  /** 含已归档：是否隐藏归档项由上层决定，存储层不做过滤。 */
  list(): TeamAgent[];
  /** 一次性预填：只拷贝可复用的定义字段，不建立对来源的引用。 */
  prefillFrom(agent: AgentSummary): Partial<TeamAgent>;
  /**
   * 改**可编辑的三个定义字段**（见 `TeamAgentEditablePatch` 白名单），返回写盘后的新实体。
   *
   * 三条语义（与 `archive` / `setEnabled` 同款纪律）：
   * 1. **id 不存在 ⇒ 响亮抛**（`协作智能体不存在：${id}`）—— 静默 no-op 会让界面以为改成功了；
   * 2. **只写 patch 里出现的键**：值为 `undefined` 的键保持原值（不是"清空"），
   *    且 `enabled` / `archivedAt` 等白名单外的字段**原样保留** —— 它们的入口是
   *    `setEnabled` / `archive`，从"编辑名字"的调用里悄悄改状态必须写不出来；
   * 3. **内容全同 ⇒ 不重写盘**（沿用私有 `update` 助手的引用相等短路），返回值即读到的实体。
   */
  update(id: string, patch: TeamAgentEditablePatch): TeamAgent;
  /** 归档而非硬删：只写 archivedAt，定义与记忆都保留。 */
  archive(id: string): void;
  /** 只改 enabled，其余字段（含 archivedAt）原样保留。 */
  setEnabled(id: string, enabled: boolean): void;
}

/**
 * 读-改-写一个已存在定义；id 不存在则抛错（静默 no-op 会让界面以为改成功了）。
 * `mutate` 返回**同一个对象引用**即表示无需变更，此时跳过写盘——重复归档之类的操作
 * 不该产生一次内容相同的重写。
 *
 * 返回**写盘后的实体**（未变更时即读到的那个）：`update` 方法要把它交回给调用方，
 * 而不是让调用方再读一次盘（第二次读可能撞上并发写入，拿到的就不是本次写的那份了）。
 */
function update(root: string, id: string, mutate: (agent: TeamAgent) => TeamAgent): TeamAgent {
  const agent = readTeamAgent(root, id);
  if (!agent) throw new Error(`协作智能体不存在：${id}`);
  const next = mutate(agent);
  if (next === agent) return agent;
  return writeTeamAgent(root, next);
}

export function createTeamAgentService(deps: { root: string }): TeamAgentService {
  const { root } = deps;

  return {
    create(input) {
      const agent: TeamAgentInput = {
        /* id 用随机 UUID，**不**由 name 派生：记忆 key 以 id 为准（spec §3.2 / §7），
           name 派生的 key 会让「改名」丢掉全部记忆，且同名队友会互相串记忆。 */
        id: randomUUID(),
        name: input.name,
        description: input.description,
        color: input.color,
        systemPrompt: input.systemPrompt,
        skills: input.skills ?? [],
        modelSelection: input.modelSelection,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        permissionMode: input.permissionMode,
        memoryScope: input.memoryScope,
        maxConcurrentRuns: input.maxConcurrentRuns,
        enabled: input.enabled ?? true,
        provenance: input.provenance ?? { source: "manual" },
      };
      return writeTeamAgent(root, agent);
    },

    get(id) {
      return readTeamAgent(root, id);
    },

    list() {
      return listTeamAgents(root);
    },

    /* 只取可复用的定义字段。刻意**不**取 id / path / scope / source / pluginId：
       带上来源的 id 会让草稿指向一个仍存在的 subagent，随后对来源的改名/删除
       都会通过这个 id 影响到草稿——那正是 spec §3.2 禁止的持续引用。
       memoryScope / enabled 同样不取：它们属于「新队友自己的决定」，不是来源的属性。 */
    prefillFrom(agent) {
      const draft: Partial<TeamAgent> = {
        name: agent.name,
        systemPrompt: agent.systemPrompt,
      };
      // 拷贝而非赋值：直接塞来源的数组/对象会让草稿与来源共享同一份可变数据（改一个动两个）。
      if (agent.description !== undefined) draft.description = agent.description;
      if (agent.color !== undefined) draft.color = agent.color;
      if (agent.modelSelection !== undefined) {
        draft.modelSelection = { ...agent.modelSelection };
      }
      if (agent.tools !== undefined) draft.tools = [...agent.tools];
      if (agent.disallowedTools !== undefined) draft.disallowedTools = [...agent.disallowedTools];
      if (agent.skills !== undefined) draft.skills = [...agent.skills];
      if (agent.permissionMode !== undefined) draft.permissionMode = agent.permissionMode;
      return draft;
    },

    /* 只写 patch 里**出现**的键（`!== undefined` 逐个判断，不做整包展开）。
       为什么不得用 `{ ...agent, ...patch }` 一把梭：patch 的静态类型虽是白名单，
       运行期的对象可能多带键（调用方透传 / 反序列化的载荷）；展开会把 `enabled`、
       `archivedAt` 一起覆盖 —— 一次「改名字」就能把已归档的定义悄悄复活，且不报错。
       逐字段合并让白名单成为**运行期**的承重墙，而不只是类型层的君子协定。 */
    update(id, patch) {
      // 这里的 `update(...)` 是模块级的读-改-写助手（方法名不产生词法绑定），
      // 与帮助文档里「沿用私有 update 助手的引用相等短路」指同一处。
      return update(root, id, (agent) => {
        const next: TeamAgent = { ...agent };
        let changed = false;
        if (patch.name !== undefined && patch.name !== agent.name) {
          next.name = patch.name;
          changed = true;
        }
        if (patch.systemPrompt !== undefined && patch.systemPrompt !== agent.systemPrompt) {
          next.systemPrompt = patch.systemPrompt;
          changed = true;
        }
        if (patch.memoryScope !== undefined && patch.memoryScope !== agent.memoryScope) {
          next.memoryScope = patch.memoryScope;
          changed = true;
        }
        if (
          patch.maxConcurrentRuns !== undefined &&
          patch.maxConcurrentRuns !== agent.maxConcurrentRuns
        ) {
          next.maxConcurrentRuns = patch.maxConcurrentRuns;
          changed = true;
        }
        // ②刀（2026-10-06）：描述/身份色/模型选择进编辑白名单（update 逐字段，越界键仍被忽略）。
        if (patch.description !== undefined && patch.description !== agent.description) {
          next.description = patch.description;
          changed = true;
        }
        if (patch.color !== undefined && patch.color !== agent.color) {
          next.color = patch.color;
          changed = true;
        }

        if (
          patch.modelSelection !== undefined &&
          JSON.stringify(patch.modelSelection) !== JSON.stringify(agent.modelSelection)
        ) {
          // 拷贝而非赋值：不让调用方的可变对象与台账定义共享引用（prefillFrom 同款纪律）。
          next.modelSelection = { ...patch.modelSelection };
          changed = true;
        }
        // 内容全同 ⇒ 交回原引用：助手据此跳过写盘（重复点「保存」不该产生一次重写）。
        return changed ? next : agent;
      });
    },

    archive(id) {
      update(root, id, (agent) =>
        // 已归档就原样返回（不重写）：时间戳记的是「何时离开在用名单」，重复点击不该把它推后。
        agent.archivedAt !== undefined ? agent : { ...agent, archivedAt: Date.now() },
      );
    },

    setEnabled(id, enabled) {
      // 展开原定义再覆盖 enabled：其余字段（含 archivedAt）逐字保留，本操作不改变归档状态。
      update(root, id, (agent) => ({ ...agent, enabled }));
    },
  };
}
