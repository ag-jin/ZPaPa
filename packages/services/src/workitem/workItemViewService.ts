import { z } from "zod";
import { resolveWorkspaceKey, type WorkItemCreator } from "@zcode/shared";
import type { SquadRuntime } from "./squadContracts.js";
import type { ISquadRuntimeService, SquadWorkspaceTarget } from "./squadRuntimeService.js";
import type {
  WorkItemViewDefinitionPatch,
  WorkItemViewOwner,
  WorkItemViewRecord,
  WorkItemViewScopeType,
  WorkItemViewVisibility,
} from "./workItemViewRepo.js";

/* 工作项**保存视图**的**服务面六个方法**（`listWorkItemViews` / `createWorkItemView` /
   `patchWorkItemView` / `deleteWorkItemView` / `getWorkItemViewPrefs` / `putWorkItemViewPrefs`）
   的唯一实现（R6a 切片 3/4）。

   为什么单独成文件（照 `squadWakeRules.ts` / `workItemAssignee.ts` 的两条先例）：
   ① `squadRuntimeService.ts` 是描述符那一侧、**必须保持浏览器安全**（根入口值导入导出它）；
   ② 组装 / 校验 / 权限 / 配额 / CAS 的逻辑搬出来，描述符侧只留接线。

   形态与判据全部照 multica 先例（`server/internal/handler/issue_view.go` /
   `issue_view_preference.go`，证据 reports/2026-10-09-saved-views-multica-evidence.md §1/§2/§7）：

   · **读权 = owner 或 shared**（`canReadIssueView`）：越权读与「不存在」**同码** —— 私有视图的
     存在性不许泄露（multica 的 loadIssueViewForUser 一律 404）。
   · **管理权（改/删）= owner，或 workspace 管理员且视图是 shared**（`canManageIssueView`）：
     ZPaPa v1 没有 workspace 管理员名册（单机单身份，人类名册归 C4）⇒ 这一格退化为 **owner**。
     非 owner 改/删**共享**视图 ⇒ 403 等价物（与「读不到」区分：他看得见这个视图，只是不能改）；
     非 owner 改/删**私有**视图 ⇒ 读权那道闸先把它挡成「不存在」。
   · **my 档强制 private 三处**（multica 3 处同款）：① 创建时**强制**（不报错，multica
     `CreateIssueView` 把 visibility 改写成 private）；② 更新时**响亮拒绝**（`UpdateIssueView` 400
     "my views are always private"）；③ DB CHECK（迁移 0020）。
   · **配额**：每 owner 每 workspace 100（multica `issueViewsPerOwnerMax`），**写之前**判
     （超限时不许落盘）。列表硬上限 200 在 repo 的 SQL 里（`WORK_ITEM_VIEW_LIST_LIMIT`）。
   · **revision 是乐观并发**：patch 必填 `expectedRevision`（multica 必填、≤0 ⇒ 400）；CAS 未命中
     ⇒ 409 等价物。**删除不带 revision**（multica 同款：删除没有 fencing）。
   · **query/display 不解释**：服务端只校验「合法 JSON object」（`z.record(z.string(), z.unknown())`
     同款）；facet 集（status/priority × display 子集）由 UI 层定义 —— 服务面不枚举、不白名单，
     加 facet 不需要动服务端。
   · **载荷上限 128KiB**（multica `issueViewBodyMaxBytes`）：multica 卡整个请求体，ZPaPa 的 RPC 没有
     HTTP 体 ⇒ 卡两处真正无界的部分（query / display 序列化后的字节数；name 另有 80 字符上限）。
   · **prefs**：无行 ⇒ 空文档 `{}`（不是 404）；整文档 last-write-wins、无 revision
     （multica `issue_view_preference.go:80-155`）。

   **稳定错误码**（跨 RPC 到 UI 后按码分流，照 `SQUAD_DISPATCH_DISABLED_CODE` 的做法）：
   `not_found`（不存在 / 无权读，两者同码防存在性泄露）/ `forbidden`（看得见但改不动）/
   `revision_conflict`（409 等价物）/ `quota_exceeded` / `invalid`（名称、JSON object、闭集、
   expectedRevision、载荷超限）。 */

export const WORK_ITEM_VIEW_NOT_FOUND_CODE = "work_item_view_not_found";
export const WORK_ITEM_VIEW_FORBIDDEN_CODE = "work_item_view_forbidden";
export const WORK_ITEM_VIEW_REVISION_CONFLICT_CODE = "work_item_view_revision_conflict";
export const WORK_ITEM_VIEW_QUOTA_EXCEEDED_CODE = "work_item_view_quota_exceeded";
export const WORK_ITEM_VIEW_INVALID_CODE = "work_item_view_invalid";

export type WorkItemViewErrorCode =
  | typeof WORK_ITEM_VIEW_NOT_FOUND_CODE
  | typeof WORK_ITEM_VIEW_FORBIDDEN_CODE
  | typeof WORK_ITEM_VIEW_REVISION_CONFLICT_CODE
  | typeof WORK_ITEM_VIEW_QUOTA_EXCEEDED_CODE
  | typeof WORK_ITEM_VIEW_INVALID_CODE;

/** 名称上限（与 DDL 的 `length(name) BETWEEN 1 AND 80` 同一把尺子：**码点**，不是 UTF-16）。 */
export const WORK_ITEM_VIEW_NAME_MAX_LENGTH = 80;
/** 每 owner 每 workspace 的视图数上限（multica `issueViewsPerOwnerMax`）。 */
export const WORK_ITEM_VIEWS_PER_OWNER_MAX = 100;
/** 单个 JSON 文档（query / display / prefs）序列化后的字节上限（multica 请求体上限的等价物）。 */
export const WORK_ITEM_VIEW_PAYLOAD_MAX_BYTES = 128 * 1024;

export class WorkItemViewError extends Error {
  readonly code: WorkItemViewErrorCode;
  constructor(code: WorkItemViewErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "WorkItemViewError";
    this.code = code;
  }
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

export type CreateWorkItemViewInput = {
  name: string;
  /** `workspace`（工作区共享位面）或 `my`（我的视角）；v1 无 project 档与 variant 轴。 */
  scopeType: WorkItemViewScopeType;
  /** 缺省 `private`（multica 的 DEFAULT 同款）。`my` 档无论传什么都会被**强制**成 private。 */
  visibility?: WorkItemViewVisibility;
  /** 客户端契约版本；缺省 1（multica 的客户端恒写 1，服务端只存不解释）。 */
  definitionVersion?: number;
  /** 过滤定义：**必填**、必须是 JSON object（不解释内容）。 */
  query: Record<string, unknown>;
  /** 显示定义：缺省 `{}`（只作「首次打开」的种子）。 */
  display?: Record<string, unknown>;
};

/** 全量定义式 PATCH（未给的字段保持现值）；`scopeType` 有意不在 patch 里 —— 归属轴不可改（multica 同款）。 */
export type WorkItemViewDefinitionPatchInput = {
  name?: string;
  visibility?: WorkItemViewVisibility;
  query?: Record<string, unknown>;
  display?: Record<string, unknown>;
};

export type PatchWorkItemViewInput = {
  id: string;
  /** 必填且为正整数（multica 400 "expected_revision is required" 的等价物）。 */
  expectedRevision: number;
  patch: WorkItemViewDefinitionPatchInput;
};

/** 偏好文档：客户端自有、服务端只认「是 JSON object」（multica 同款；键集由 UI 层定义）。 */
export type WorkItemViewPrefsDocument = Record<string, unknown>;

export type WorkItemViewOpsDeps = {
  /** 按目标现构 runtime（裁定 4：不缓存、不取首个）——与描述符侧同一个工厂。 */
  createRuntime: (target: SquadWorkspaceTarget) => Promise<SquadRuntime>;
  /**
   * **本机操作者身份**（视图的 owner）：与 0018 的 `createWorkItem` 创建人**同一处定义点**
   * （组合根本机操作者常量，见 node.ts 的身份单源——注释不直书 token，字面量守卫扫全 src 树）。
   * 身份是审计与权限事实，**不能**由调用方自证；
   * 未注入 ⇒ 六个方法**响亮抛**（视图没有 owner 就没有权限语义，不许造一行「无主视图」）。
   */
  localHumanActor?: () => WorkItemCreator;
  /** 时钟（测试可钉死；缺省 `Date.now`）。 */
  now?: () => number;
};

export function createWorkItemViewOps(
  deps: WorkItemViewOpsDeps,
): Pick<
  ISquadRuntimeService,
  | "listWorkItemViews"
  | "createWorkItemView"
  | "patchWorkItemView"
  | "deleteWorkItemView"
  | "getWorkItemViewPrefs"
  | "putWorkItemViewPrefs"
> {
  const now = deps.now ?? (() => Date.now());

  /**
   * 本机操作者 = 视图 owner（见 deps.localHumanActor 的理由）。未接通 ⇒ 响亮抛：
   * 静默用「空身份」会让视图长在谁也认不出的 owner 上，而权限矩阵的第一格就是 owner 比对。
   */
  const requireActor = (): WorkItemViewOwner => {
    const actor = deps.localHumanActor?.();
    if (!actor) {
      throw new Error(
        "保存视图服务面未接通本机操作者身份：组合根必须注入 localHumanActor（与 0018 的创建人同一处定义点）。" +
          "视图的 owner 是权限矩阵的第一格 —— 没有它，读/改/删就没有判据，故一律抛。",
      );
    }
    return { kind: actor.kind, id: actor.id };
  };

  /** 权限三判据（唯一实现）：
      读 = owner 或共享；管理 = owner（v1 无 workspace 管理员名册，登记在交付报告）。 */
  const isOwner = (view: WorkItemViewRecord, actor: WorkItemViewOwner): boolean =>
    view.owner.kind === actor.kind && view.owner.id === actor.id;
  const canRead = (view: WorkItemViewRecord, actor: WorkItemViewOwner): boolean =>
    isOwner(view, actor) || view.visibility === "workspace";
  const canManage = (view: WorkItemViewRecord, actor: WorkItemViewOwner): boolean =>
    isOwner(view, actor);

  /** 越权读与不存在**同码同文案**：私有视图的存在性不许从错误里泄露（multica 404 口径）。 */
  const notFound = (id: string): WorkItemViewError =>
    new WorkItemViewError(
      WORK_ITEM_VIEW_NOT_FOUND_CODE,
      `保存视图「${id}」不存在，或你无权读它（二者同码：私有视图的存在性不泄露）。` +
        "刷新视图条后再看 —— 它可能已被删除，或本来就是别人的私有视图。",
    );

  const forbidden = (id: string): WorkItemViewError =>
    new WorkItemViewError(
      WORK_ITEM_VIEW_FORBIDDEN_CODE,
      `保存视图「${id}」不是你的（你可以读它，但只有视图的创建者能改/删）。` +
        "要改它请「另存为新视图」（multica 同款：非 owner 的入口是 Save as）。",
    );

  const invalid = (message: string): WorkItemViewError =>
    new WorkItemViewError(WORK_ITEM_VIEW_INVALID_CODE, message);

  /** 名称校验：`[...name].length` 按**码点**计数 —— 与 DDL 的 `length(name)` 同一把尺子。 */
  const assertName: (name: unknown) => asserts name is string = (name) => {
    if (typeof name !== "string")
      throw invalid(`视图名必须是字符串（收到 ${JSON.stringify(name)}）。`);
    const length = [...name].length;
    if (length < 1 || length > WORK_ITEM_VIEW_NAME_MAX_LENGTH) {
      throw invalid(
        `视图名必须在 1..${WORK_ITEM_VIEW_NAME_MAX_LENGTH} 个字符之间（收到 ${length} 个字符）。` +
          "空名或超长名一律拒绝（不静默截断：截断会让用户保存的视图与输入的名字不一致）。",
      );
    }
  };

  /** 载荷上限（文件头：multica 卡请求体，ZPaPa 卡两个无界文档的序列化字节数）。 */
  const assertPayloadWithinLimit = (doc: Record<string, unknown>, label: string): void => {
    const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (bytes > WORK_ITEM_VIEW_PAYLOAD_MAX_BYTES) {
      throw invalid(
        `${label} 超过载荷上限（${bytes} > ${WORK_ITEM_VIEW_PAYLOAD_MAX_BYTES} 字节）。` +
          "视图定义是过滤器文档，正常只有几 KB —— 这个量级说明传错了对象。",
      );
    }
  };

  /** 「合法 JSON object」的**唯一**校验点（query / display / prefs 三处共用）。 */
  const assertJsonObject = (value: unknown, label: string): Record<string, unknown> => {
    const parsed = jsonObjectSchema.safeParse(value);
    if (!parsed.success) {
      throw invalid(
        `${label} 必须是 JSON object（收到 ${JSON.stringify(value) ?? "undefined"}）。` +
          "服务端不解释文档内容（facet 集归 UI 层），但顶层形状必须是 object —— " +
          "数组 / 标量 / null 一律拒绝，否则落盘的定义没人能解释。",
      );
    }
    assertPayloadWithinLimit(parsed.data, label);
    return parsed.data;
  };

  const assertScopeType = (value: unknown): WorkItemViewScopeType => {
    if (value !== "workspace" && value !== "my")
      throw invalid(`scopeType 必须是 workspace 或 my（收到 ${JSON.stringify(value)}）。`);
    return value;
  };

  const assertVisibility = (value: unknown): WorkItemViewVisibility => {
    if (value !== "private" && value !== "workspace")
      throw invalid(`visibility 必须是 private 或 workspace（收到 ${JSON.stringify(value)}）。`);
    return value;
  };

  /** 定义式 PATCH 的逐字段校验（未给的字段不进 patch；全空 patch ⇒ 响亮抛，不做空写）。 */
  const assemblePatch = (patch: WorkItemViewDefinitionPatchInput): WorkItemViewDefinitionPatch => {
    const assembled: WorkItemViewDefinitionPatch = {};
    if (patch.name !== undefined) {
      assertName(patch.name);
      assembled.name = patch.name;
    }
    if (patch.visibility !== undefined) assembled.visibility = assertVisibility(patch.visibility);
    if (patch.query !== undefined) assembled.query = assertJsonObject(patch.query, "query");
    if (patch.display !== undefined) assembled.display = assertJsonObject(patch.display, "display");
    if (Object.keys(assembled).length === 0) {
      throw invalid("patch 没有给任何要改的字段（空 patch）：不执行空写，请至少给一个定义字段。");
    }
    return assembled;
  };

  const assertExpectedRevision = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw invalid(
        `expectedRevision 必须是正整数（收到 ${JSON.stringify(value)}）：` +
          "它是乐观并发的比较对象，缺了它就无法区分「我改的是我看到的那一版」与「盖掉别人刚改的」。",
      );
    }
    return value;
  };

  return {
    /**
     * 本 workspace 的**可见**视图（读权谓词在 repo 的 SQL 里：owner 或 shared）。
     * 排序（created_at ASC, id ASC）与上限（200）由 repo 单源给出，本层不重排、不截断。
     * 每行带**观察者归属** `ownedByViewer`（repo 按注入身份 `(kind, id)` 两列现场算）——
     * UI 的权限镜像（他人的共享视图 ⇒ 编辑禁用 / 删除不渲染）据此分「我的 / 别人的」，
     * 不再有「身份不可判定」的中间态需求（D1-A：UI 不自造身份，读面带回真值）。
     * 不过门禁：读不是新派发（与 `listWakeRules` 同款）。
     */
    async listWorkItemViews(target) {
      const runtime = await deps.createRuntime(target);
      return runtime.workItemViewRepo.listVisible(workspaceKeyOf(runtime), requireActor());
    },

    /**
     * 建一条视图。四步，次序固定（与 multica `CreateIssueView` 的检查序一致）：
     * ① 名称（1..80）；② 配额（**写之前**判，超限不落盘）；③ scope/visibility/JSON 文档校验
     * （my 档**强制** private）；④ 落盘后读回返回（读回证明「落的就是你给的」，不是把入参原样回抛）。
     */
    async createWorkItemView(target, input) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const workspaceKey = workspaceKeyOf(runtime);
      assertName(input.name);
      const scopeType = assertScopeType(input.scopeType);
      const query = assertJsonObject(input.query, "query");
      const display = input.display === undefined ? {} : assertJsonObject(input.display, "display");
      // 缺省 private（DDL DEFAULT 同款）；my 档强制 private（三处闸的第二处是 patch，第三处是 DB CHECK）。
      const requestedVisibility =
        input.visibility === undefined ? "private" : assertVisibility(input.visibility);
      const visibility: WorkItemViewVisibility =
        scopeType === "my" ? "private" : requestedVisibility;
      const definitionVersion = input.definitionVersion ?? 1;
      if (!Number.isInteger(definitionVersion) || definitionVersion <= 0) {
        throw invalid(
          `definitionVersion 必须是正整数（收到 ${JSON.stringify(input.definitionVersion)}）：` +
            "它是 query/display 的解释契约版本，客户端目前恒写 1。",
        );
      }
      const owned = runtime.workItemViewRepo.countByOwner(workspaceKey, actor);
      if (owned >= WORK_ITEM_VIEWS_PER_OWNER_MAX) {
        throw new WorkItemViewError(
          WORK_ITEM_VIEW_QUOTA_EXCEEDED_CODE,
          `保存视图已达每工作区上限（每 owner ${WORK_ITEM_VIEWS_PER_OWNER_MAX} 条）：` +
            "删掉不用的视图再建（不静默丢弃旧视图 —— 那会让用户以为存下来了）。",
        );
      }

      const id = globalThis.crypto.randomUUID();
      const timestamp = now();
      runtime.workItemViewRepo.insert({
        id,
        workspaceKey,
        owner: actor,
        name: input.name,
        scopeType,
        visibility,
        definitionVersion,
        query,
        display,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const created = runtime.workItemViewRepo.get(workspaceKey, id);
      if (!created) {
        throw new Error(
          `创建保存视图失败：写入成功后读回为空（id=${id}）：不可达态，须查库 —— ` +
            "不返回 undefined，避免调用方在下一层才炸。",
        );
      }
      return created;
    },

    /**
     * 定义式 PATCH（`expectedRevision` 必填、CAS）。六步，次序固定：
     * ① 读现行（不存在 / 无权读 ⇒ **同码** not_found）；② 管理权（非 owner 改共享 ⇒ forbidden）；
     * ③ 逐字段校验与组装（my 档 visibility 只许 private —— 与创建时的「强制」不同，
     * 更新时是**响亮拒绝**，multica 同款）；④ CAS 写盘（revision+1）；未命中 ⇒ 409 等价物；
     * ⑤ 读回返回。
     */
    async patchWorkItemView(target, input) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const workspaceKey = workspaceKeyOf(runtime);
      const expectedRevision = assertExpectedRevision(input.expectedRevision);
      const current = runtime.workItemViewRepo.get(workspaceKey, input.id);
      if (!current || !canRead(current, actor)) throw notFound(input.id);
      if (!canManage(current, actor)) throw forbidden(input.id);
      const patch = assemblePatch(input.patch);
      if (
        patch.visibility !== undefined &&
        current.scopeType === "my" &&
        patch.visibility !== "private"
      ) {
        throw invalid(
          "my 档视图恒为 private（共享一个「我的视角」没有意义：它在每个人眼里呈现的都不一样）。" +
            "要共享请另建一条 workspace 档视图。",
        );
      }
      const updated = runtime.workItemViewRepo.update({
        workspaceKey,
        id: input.id,
        expectedRevision,
        patch,
        updatedAt: now(),
      });
      if (!updated) {
        throw new WorkItemViewError(
          WORK_ITEM_VIEW_REVISION_CONFLICT_CODE,
          `保存视图「${input.id}」的定义已被别处改过（或已被删除）：` +
            `本次基于 revision ${expectedRevision} 的修改没有落盘。重读后再改（或另存为新视图）。`,
        );
      }
      return updated;
    },

    /**
     * 删除（无 revision 参数 —— multica 同款：删除没有 fencing）。三步：
     * ① 读现行（不存在 / 无权读 ⇒ not_found）；② 管理权（非 owner 删共享 ⇒ forbidden）；
     * ③ `remove` 恰命中一行才算成功，未命中（读到之后被并发删除）⇒ not_found 等价物
     * （对界面而言「它没了」就是全部结论）。
     */
    async deleteWorkItemView(target, input) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const workspaceKey = workspaceKeyOf(runtime);
      const current = runtime.workItemViewRepo.get(workspaceKey, input.id);
      if (!current || !canRead(current, actor)) throw notFound(input.id);
      if (!canManage(current, actor)) throw forbidden(input.id);
      if (!runtime.workItemViewRepo.remove(workspaceKey, input.id)) throw notFound(input.id);
    },

    /**
     * 视图条偏好：**无行 ⇒ 空文档 `{}`**（不是错误、不是 404 —— multica 的 no-rows 分支同款）。
     * 偏好按 (workspace, owner) 隔离：这份文档只属于调用者本人，读它不需要额外的权限判据。
     */
    async getWorkItemViewPrefs(target) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const document = runtime.workItemViewPrefsRepo.get(workspaceKeyOf(runtime), actor);
      if (document) return document;
      return {};
    },

    /**
     * 整文档覆盖写（last-write-wins、无 revision）。校验与 query/display 同一份：
     * 「是 JSON object」+ 载荷上限 —— 文档的**键集**（hidden / order）由 UI 层定义，服务端不解释。
     */
    async putWorkItemViewPrefs(target, input) {
      const runtime = await deps.createRuntime(target);
      const actor = requireActor();
      const prefs = assertJsonObject(input.prefs, "prefs");
      return runtime.workItemViewPrefsRepo.put({
        workspaceKey: workspaceKeyOf(runtime),
        owner: actor,
        prefs,
        updatedAt: now(),
      });
    },
  };
}

/** 本 runtime 的 `workspace_key`（C14 口径）：与 `getSnapshot` / `createWorkItem` 同一条式子。 */
function workspaceKeyOf(runtime: SquadRuntime): string {
  return resolveWorkspaceKey({
    workspacePath: runtime.boundWorkspace.path,
    workspaceIdentity: runtime.boundWorkspace.identity,
  });
}
