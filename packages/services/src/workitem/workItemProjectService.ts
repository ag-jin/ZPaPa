import {
  PROJECT_STATUS_DEFAULT,
  resolveProjectShortCode,
  resolveProjectStatus,
  resolveWorkItemDateOnly,
  resolveWorkItemPriority,
  resolveWorkspaceKey,
  projectShortCodeErrorMessage,
  projectStatusErrorMessage,
  workItemDateErrorMessage,
  workItemPriorityErrorMessage,
  type ProjectStatusKey,
  type WorkItemPriorityKey,
} from "@zcode/shared";
import type { SquadRuntime } from "./squadContracts.js";
import type { ISquadRuntimeService, SquadWorkspaceTarget } from "./squadRuntimeService.js";
import { isProjectShortCodeConflict, type WorkItemProjectPatch } from "./workItemProjectRepo.js";

/* 项目**五件的唯一实现**（`listProjects` / `createProject` / `updateProject` / `deleteProject` /
   `setWorkItemProject`，R-P1 切片 3/4）。

   为什么单独成文件（照 `squadWakeRules.ts` / `workItemViewService.ts` 的两条先例）：
   ① `squadRuntimeService.ts` 是描述符那一侧、**必须保持浏览器安全**（根入口值导入导出它）；
   ② 组装 / 校验 / 挂接矩阵的逻辑搬出来，描述符侧只留接线。

   形态取自 multica（`server/internal/handler/project.go`、`server/migrations/034/035/166`，
   证据 `reports/2026-10-09-multica-issue-project-binding.md` A1/A2）：

   · **短码 = 编号前缀**（ZPaPa 加法，用户裁定「编号换项目短码」）：2-8 位大写字母数字、
     workspace 内唯一。形状判据单源在 shared 纯函数（UI 表单共用同一句话），唯一性由存储层
     唯一索引兜底、本层把原生冲突翻译成稳定错误码。
   · **status 闭集五档、缺省 planned**（multica DDL 同款）：创建时不传 ⇒ 显式折成默认档；
     patch 里给闭集外/`null` ⇒ 响亮拒（不静默回落 —— 「想清空」与「没给」是两件事）。
   · **priority 闭集复用工作项的四档**（multica 项目优先级与 issue 同组：`035` 的
     `urgent|high|medium|low` + `none`；ZPaPa 的「未设置」统一是 NULL，不设显式 `none` 键）。
   · **日历日期**复用工作项的形状判据（`YYYY-MM-DD`，无时刻无时区）。
   · **「无项目」是显式合法状态**（A1 三层语义之一）：`setWorkItemProject(projectId: null)` 把
     `project_id` 与 `identifier_prefix` **同置 NULL**（编号显示回落 `#N`）；未知 / 跨 workspace 的
     项目一律拒绝（同码 `work_item_project_not_found`，跨域同码防存在性泄露）。
   · **删项目 = 置空挂接 + 删行**（multica `ON DELETE SET NULL` 的等价物，但由服务层显式做 ——
     本仓不建外键）：已签发编号的**前缀快照保留**，不重写历史编号。
   · **五个方法都不过门禁**（`assertEnabled`）：项目与派发无关，关掉实验开关后项目管理仍必须可用
     （与 `updateWorkItem` / 保存视图 / reactions 同款理由；本层不写第二份开关判据）。

   **稳定错误码**（跨层按码分流，照 `SQUAD_DISPATCH_DISABLED_CODE` 的做法）：
   `work_item_project_not_found`（项目不存在 / 属别的 workspace —— 同码）/ `work_item_not_found`
   （工作项不存在、已归档或属别的 workspace —— 同码）/ `work_item_project_short_code_conflict`
   （短码已被本 workspace 的另一个项目占用）/ `work_item_project_invalid`（name / 短码形状 /
   status / priority / 日期不合法）。 */

export const WORK_ITEM_PROJECT_NOT_FOUND_CODE = "work_item_project_not_found";
export const WORK_ITEM_NOT_FOUND_CODE = "work_item_not_found";
export const WORK_ITEM_PROJECT_SHORT_CODE_CONFLICT_CODE = "work_item_project_short_code_conflict";
export const WORK_ITEM_PROJECT_INVALID_CODE = "work_item_project_invalid";

export type WorkItemProjectErrorCode =
  | typeof WORK_ITEM_PROJECT_NOT_FOUND_CODE
  | typeof WORK_ITEM_NOT_FOUND_CODE
  | typeof WORK_ITEM_PROJECT_SHORT_CODE_CONFLICT_CODE
  | typeof WORK_ITEM_PROJECT_INVALID_CODE;

export class WorkItemProjectError extends Error {
  readonly code: WorkItemProjectErrorCode;
  constructor(code: WorkItemProjectErrorCode, message: string) {
    // 消息以 `[code]` 起头：跨进程边界（RPC）后按稳定码分流，照 WorkItemViewError 的既有做法。
    super(`[${code}] ${message}`);
    this.name = "WorkItemProjectError";
    this.code = code;
  }
}

export type CreateProjectInput = {
  name: string;
  shortCode: string;
  description?: string;
  icon?: string;
  /** 缺省 `planned`（DDL DEFAULT 同款）；闭集外响亮拒。 */
  status?: ProjectStatusKey;
  /** 可空 = 未设置；闭集与工作项优先级同源。 */
  priority?: WorkItemPriorityKey | null;
  startDate?: string | null;
  dueDate?: string | null;
};

/** 改写面**不含** `shortCode`（编号前缀来源，v1 不可改；见 repo 的 patch 类型注释）。 */
export type UpdateProjectInput = {
  id: string;
  patch: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    status?: ProjectStatusKey;
    priority?: WorkItemPriorityKey | null;
    startDate?: string | null;
    dueDate?: string | null;
  };
};

export type SetWorkItemProjectInput = { workItemId: string; projectId: string | null };

export type WorkItemProjectOpsDeps = {
  /** 按目标现构 runtime（裁定 4：不缓存、不取首个）——与描述符侧同一个工厂。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /** 时钟与 id 生成（**仅测试可钉死**，生产不注入；与 reactions 服务面同一手法）。 */
  now?: () => number;
  newId?: () => string;
};

/**
 * 「把 `projectId` 翻译成挂接两列」的唯一实现（三条写路径共用：创建工作项 / 编辑工作项 /
 * `setWorkItemProject`）。
 *
 * `projectId` 非空 ⇒ 取项目行（**必须属本 workspace** —— repo 的 SQL 租户守卫），
 * 返回 `{ projectId, identifierPrefix: 短码 }`；项目不存在 / 属别的 workspace ⇒ 同一稳定码
 * `work_item_project_not_found`（跨域同码：不泄露「别的 workspace 里有这个 id」）。
 * `projectId === null` ⇒ 回无项目：两列**同置 NULL**（语义单点，调用方不得自己拼一半）。
 */
export function resolveWorkItemProjectBinding(input: {
  repo: Pick<SquadRuntime["workItemProjectRepo"], "get">;
  workspaceKey: string;
  projectId: string | null;
}): { projectId: string | null; identifierPrefix: string | null } {
  if (input.projectId === null) return { projectId: null, identifierPrefix: null };
  const project = input.repo.get(input.workspaceKey, input.projectId);
  if (!project) {
    throw new WorkItemProjectError(
      WORK_ITEM_PROJECT_NOT_FOUND_CODE,
      `项目「${input.projectId}」不存在，或不属于本工作区（二者同码：跨域项目不泄露存在性）。` +
        "工作项挂接必须先确认项目在本工作区里 —— 挂到不存在的项目上只是把坏数据写进库。",
    );
  }
  return { projectId: project.id, identifierPrefix: project.shortCode };
}

export function createWorkItemProjectOps(
  deps: WorkItemProjectOpsDeps,
): Pick<
  ISquadRuntimeService,
  "listProjects" | "createProject" | "updateProject" | "deleteProject" | "setWorkItemProject"
> {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  /** 本 runtime 的 `workspace_key`（C14 口径）：与 `getSnapshot` / `createWorkItem` 同一条式子。 */
  const keyOf = (runtime: SquadRuntime): string =>
    resolveWorkspaceKey({
      workspacePath: runtime.boundWorkspace.path,
      workspaceIdentity: runtime.boundWorkspace.identity,
    });

  const invalid = (message: string): WorkItemProjectError =>
    new WorkItemProjectError(WORK_ITEM_PROJECT_INVALID_CODE, message);

  /** name 必填（multica `project.go:265`「title is required」的 ZPaPa 等价物）：trim 后非空。 */
  const assertName: (name: unknown) => asserts name is string = (name) => {
    if (typeof name !== "string" || name.trim() === "") {
      throw invalid(
        `项目名必须是**非空**字符串（收到 ${JSON.stringify(name)}）：` +
          "没有名字的项目在列表/看板/选择器里都是一片空白，等于建了一条谁也认不出的行。",
      );
    }
  };

  /** 短码形状：shared 纯函数是唯一判据（同一句话也用于 UI 表单提示）。 */
  const assertShortCode = (raw: unknown): string => {
    const parsed = resolveProjectShortCode(raw);
    if (parsed.kind !== "ok") throw invalid(projectShortCodeErrorMessage(parsed));
    return parsed.shortCode;
  };

  /** status：缺省只在**创建**路径折默认档（`undefined`）；patch 路径不给默认值。 */
  const resolveStatus = (raw: unknown, withDefault: boolean): ProjectStatusKey => {
    const value = raw === undefined && withDefault ? PROJECT_STATUS_DEFAULT : raw;
    const parsed = resolveProjectStatus(value);
    if (parsed.kind !== "ok") throw invalid(projectStatusErrorMessage(parsed));
    return parsed.status;
  };

  const resolvePriority = (raw: unknown): WorkItemPriorityKey | null => {
    const parsed = resolveWorkItemPriority(raw);
    if (parsed.kind !== "ok") throw invalid(workItemPriorityErrorMessage(parsed));
    return parsed.priority;
  };

  const resolveDate = (raw: unknown): string | null => {
    const parsed = resolveWorkItemDateOnly(raw);
    if (parsed.kind !== "ok") throw invalid(workItemDateErrorMessage(parsed));
    return parsed.date;
  };

  return {
    /**
     * 本 workspace 的全部项目（repo 单源排序 `created_at ASC, id ASC`，本层不重排、不截断）。
     * **不过门禁**：读不是新派发（与 `listWorkItemViews` / `listWakeRules` 同款）。
     */
    async listProjects(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.workItemProjectRepo.listByWorkspace(keyOf(runtime));
    },

    /**
     * 建一条项目。四步次序固定（照 `createWorkItemView` 的检查序）：
     * ① name 必填；② 短码形状（shared 判据）；③ status / priority / 日期过闸（坏值**零落盘**）；
     * ④ `insert` + 读回返回；短码撞唯一索引 ⇒ 翻译成稳定错误码。
     */
    async createProject(target, input) {
      const runtime = await deps.createRuntime(target);
      const workspaceKey = keyOf(runtime);
      assertName(input.name);
      const shortCode = assertShortCode(input.shortCode);
      const status = resolveStatus(input.status, true);
      // 三个可空字段：未给（undefined）与显式 null 都落 NULL（新建时二者同义）；给值才过闸。
      const priority = input.priority === undefined ? null : resolvePriority(input.priority);
      const startDate = input.startDate === undefined ? null : resolveDate(input.startDate);
      const dueDate = input.dueDate === undefined ? null : resolveDate(input.dueDate);
      const timestamp = now();
      try {
        return runtime.workItemProjectRepo.insert({
          id: newId(),
          workspaceKey,
          name: input.name,
          shortCode,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          status,
          ...(priority !== null ? { priority } : {}),
          ...(startDate !== null ? { startDate } : {}),
          ...(dueDate !== null ? { dueDate } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      } catch (error) {
        if (isProjectShortCodeConflict(error)) {
          throw new WorkItemProjectError(
            WORK_ITEM_PROJECT_SHORT_CODE_CONFLICT_CODE,
            `短码「${shortCode}」已被本工作区的另一个项目占用（短码是编号前缀，workspace 内唯一）。` +
              "换一个短码再建 —— 不静默改名，否则用户看到的编号与输入的不一致。",
          );
        }
        throw error;
      }
    },

    /**
     * 子集 patch：① 读现行（不存在 / 异 workspace ⇒ not_found，同码）；② 逐字段过闸与组装
     * （空 patch ⇒ 响亮 invalid，不做空写）；③ 命中才返回读回行；未命中（并发被删）⇒ not_found。
     */
    async updateProject(target, input) {
      const runtime = await deps.createRuntime(target);
      const workspaceKey = keyOf(runtime);
      const current = runtime.workItemProjectRepo.get(workspaceKey, input.id);
      if (!current) {
        throw new WorkItemProjectError(
          WORK_ITEM_PROJECT_NOT_FOUND_CODE,
          `项目「${input.id}」不存在，或不属于本工作区（二者同码）。刷新项目列表后再改。`,
        );
      }
      const patch: WorkItemProjectPatch = {};
      if (input.patch.name !== undefined) {
        assertName(input.patch.name);
        patch.name = input.patch.name;
      }
      if (input.patch.description !== undefined) patch.description = input.patch.description;
      if (input.patch.icon !== undefined) patch.icon = input.patch.icon;
      if (input.patch.status !== undefined) patch.status = resolveStatus(input.patch.status, false);
      if (input.patch.priority !== undefined)
        patch.priority = resolvePriority(input.patch.priority);
      if (input.patch.startDate !== undefined) patch.startDate = resolveDate(input.patch.startDate);
      if (input.patch.dueDate !== undefined) patch.dueDate = resolveDate(input.patch.dueDate);
      if (Object.keys(patch).length === 0) {
        throw invalid(
          "项目 patch 没有给任何要改的字段（空 patch）：不执行空写，请至少给一个字段。",
        );
      }
      const updated = runtime.workItemProjectRepo.update({
        workspaceKey,
        id: input.id,
        patch,
        updatedAt: now(),
      });
      if (!updated) {
        throw new WorkItemProjectError(
          WORK_ITEM_PROJECT_NOT_FOUND_CODE,
          `项目「${input.id}」在改写时已不存在（并发被删）：本次修改没有落盘。刷新后再看。`,
        );
      }
      return updated;
    },

    /**
     * 删项目 = **置空挂接 + 删行**（repo 在同一事务内做，次序：先置空、后删行）。
     * 恰命中一行才算成功；不存在 / 异 workspace ⇒ not_found 等价物（对界面而言「它没了」就是全部结论）。
     * 已签发编号的**前缀快照保留**（不重写历史编号）——见迁移 0022 与 repo 的注释。
     */
    async deleteProject(target, input) {
      const runtime = await deps.createRuntime(target);
      if (!runtime.workItemProjectRepo.remove(keyOf(runtime), input.id)) {
        throw new WorkItemProjectError(
          WORK_ITEM_PROJECT_NOT_FOUND_CODE,
          `项目「${input.id}」不存在，或不属于本工作区（二者同码）：没有可删的行。`,
        );
      }
    },

    /**
     * 单条工作项的挂接（bind / unbind 的唯一服务面入口）。四步：
     * ① 读工作项（不存在 / 已归档 / 异 workspace ⇒ **同码** work_item_not_found，不泄露存在性）；
     * ② `projectId` 非空 ⇒ 取项目（不存在 / 异 workspace ⇒ not_found）；
     * ③ 写挂接两列（`project_id` + 前缀快照，**同生共死**）；
     * ④ 读回返回（证明「库里就是这两列」）。
     */
    async setWorkItemProject(target, input) {
      const runtime = await deps.createRuntime(target);
      const workspaceKey = keyOf(runtime);
      const item = runtime.workItemRepo.get(input.workItemId);
      if (!item || item.workspaceIdentity !== workspaceKey) {
        throw new WorkItemProjectError(
          WORK_ITEM_NOT_FOUND_CODE,
          `工作项「${input.workItemId}」不存在、已归档，或不属于本工作区（三者同码）：` +
            "没有可挂接的目标行。刷新后再试。",
        );
      }
      const binding = resolveWorkItemProjectBinding({
        repo: runtime.workItemProjectRepo,
        workspaceKey,
        projectId: input.projectId,
      });
      const bound = runtime.workItemProjectRepo.bindWorkItem({
        workspaceKey,
        workItemId: input.workItemId,
        ...binding,
      });
      if (!bound) {
        // 读与写之间被并发归档：不静默 no-op（那会让界面以为挂上了，而库里没动）。
        throw new WorkItemProjectError(
          WORK_ITEM_NOT_FOUND_CODE,
          `工作项「${input.workItemId}」在挂接时已不可写（并发归档或删除）：本次挂接没有落盘。`,
        );
      }
      const updated = runtime.workItemRepo.get(input.workItemId);
      if (!updated) {
        throw new Error(
          `工作项「${input.workItemId}」挂接写入成功后读回为空：不可达态，须查库 —— ` +
            "不返回旧实体，避免调用方拿到「没挂上」的错觉。",
        );
      }
      return updated;
    },
  };
}
