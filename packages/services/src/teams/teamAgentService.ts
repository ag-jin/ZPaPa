import { randomUUID } from "node:crypto";
import type { AgentSummary, TeamAgent, TeamAgentInput } from "@zcode/shared";
import {
  listTeamAgents,
  readTeamAgent,
  writeTeamAgent,
} from "./teamAgentStorage.js";

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
  /** 省略即 true：新建的队友默认启用，用户不必额外开一次开关。 */
  enabled?: boolean;
  provenance?: TeamAgent["provenance"];
}

export interface TeamAgentService {
  create(input: CreateTeamAgentInput): TeamAgent;
  get(id: string): TeamAgent | null;
  /** 含已归档：是否隐藏归档项由上层决定，存储层不做过滤。 */
  list(): TeamAgent[];
  /** 一次性预填：只拷贝可复用的定义字段，不建立对来源的引用。 */
  prefillFrom(agent: AgentSummary): Partial<TeamAgent>;
  /** 归档而非硬删：只写 archivedAt，定义与记忆都保留。 */
  archive(id: string): void;
  /** 只改 enabled，其余字段（含 archivedAt）原样保留。 */
  setEnabled(id: string, enabled: boolean): void;
}

/**
 * 读-改-写一个已存在定义；id 不存在则抛错（静默 no-op 会让界面以为改成功了）。
 * `mutate` 返回**同一个对象引用**即表示无需变更，此时跳过写盘——重复归档之类的操作
 * 不该产生一次内容相同的重写。
 */
function update(
  root: string,
  id: string,
  mutate: (agent: TeamAgent) => TeamAgent,
): void {
  const agent = readTeamAgent(root, id);
  if (!agent) throw new Error(`协作智能体不存在：${id}`);
  const next = mutate(agent);
  if (next === agent) return;
  writeTeamAgent(root, next);
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
