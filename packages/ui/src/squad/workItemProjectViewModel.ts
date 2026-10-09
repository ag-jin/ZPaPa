import {
  isProjectShortCode,
  resolveProjectShortCode,
  type ProjectStatusKey,
} from "@zcode/shared";

/* 工作项↔项目绑定在 **UI 面的呈现判据**（R-P2 项目绑定 · UI 轮）。

   为什么要有这一层（与 `workItemsViewModel` / `workItemSurfaceViewModel` 同一理由）：本包没有
   渲染测试设施，判据写进组件就等于不可测；而这里的坏法全是**静默**的 ——
   项目列/项目过滤/项目 chip/子项项目预填四处各拼一份「无项目」的判据（一处把 `null` 当有项目、
   一处把清单里没有的挂接回落成「无项目」），界面就会在**没人报错**的情况下说两套话。
   服务面已就绪（`listProjects` / `createProject` / `setWorkItemProject` 五件，R-P1），本层只做
   「服务事实 → 界面结论」的纯映射：**不 import React、不 import UI 原语、不碰服务实现、不碰
   i18n 文案正文**（只给消息 id 或返回结构化结论，正文在 locales，两语成对）。

   三条与 multica 同款的语义（证据 `reports/2026-10-09-multica-issue-project-binding.md` A1/A3）：
   · **「无项目」是显式合法状态**（不是脏数据）：它有自己的列键、自己的过滤开关、自己的下拉选项，
     绝不与「清单里查不到的项目」合并成一个说法；
   · **清单里查不到 ⇒ 回落 id**（不显示成「无项目」）：那会把「挂在某个已看不见的项目上」读成
     「没挂项目」—— 与 `resolveAssigneeName` / `workItemQuickCreateParentDisplay` 同一条纪律；
   · **列/选项的次序取服务面给的次序**（repo 已按 `created_at ASC, id ASC` 排好）：本层不重排，
     也不按名字/locale 排序（那会让界面次序随改名漂移）。 */

/* ---------------- 项目清单的**呈现投影** ---------------- */

/**
 * UI 需要的项目形状（**窄化投影**）：服务面读回的 `WorkItemProjectRecord` 结构上直接满足它
 * （多出的字段不影响），而发起请求/写路径的类型不在本层（本层是纯判据，不碰服务面）。
 * `shortCode` 是编号前缀的来源，也是「新建项目」内联表单的必填项。
 */
export type WorkItemProjectOption = {
  id: string;
  name: string;
  shortCode: string;
  /** 项目状态（可空闭集在 shared；列表呈现不用它，但选择器的「新项目」回声要能带全形状）。 */
  status?: ProjectStatusKey;
};

/** 按 id 找项目（**唯一**查找点：列头 / chip / 过滤器回显四处共用，各写一份 find 迟早分叉）。 */
export function findWorkItemProject(
  projects: readonly WorkItemProjectOption[],
  projectId: string,
): WorkItemProjectOption | null {
  return projects.find((entry) => entry.id === projectId) ?? null;
}

/**
 * 项目在**行/chip/列头**上的显示文本：命中 ⇒ 项目名；清单里没有（跨版本残留 / 读面还没回来）
 * ⇒ **回落 id**（绝不回落成「无项目」—— 那是在说一件不成立的事）。
 */
export function workItemProjectText(input: {
  projectId: string;
  projects: readonly WorkItemProjectOption[];
}): string {
  return findWorkItemProject(input.projects, input.projectId)?.name ?? input.projectId;
}

/**
 * 项目 chip 的显示文本：`undefined` = **无项目** ⇒ `null`（调用方整块不渲染 —— 与
 * `workItemIdentifierText` 的「未设置 ⇒ null」同款：空 chip 是噪音，与「没挂项目」不是一回事）。
 */
export function workItemProjectChipText(input: {
  projectId?: string;
  projects: readonly WorkItemProjectOption[];
}): string | null {
  if (input.projectId === undefined) return null;
  return workItemProjectText({ projectId: input.projectId, projects: input.projects });
}

/* ---------------- 项目的**列键**（看板按项目分组的稳定身份） ---------------- */

/**
 * 「无项目」列的键（**常量**，不是某个项目的 id 的形态）：id 由服务面生成（uuid），
 * 不会与它相同。它恒为项目分组的第一列，且**恒保留**（multica 的 drop 目标语义；
 * 本仓 v1 拖拽只在状态分组开放，这条形态仍按真源保留）。
 */
export const WORK_ITEM_NO_PROJECT_LANE_KEY = "project:none";

/** 项目 id ⇒ 看板列键（前缀避免与其他维度的列键撞：列键是 `data-lane-key` 的取值）。 */
export function projectLaneKey(projectId: string): string {
  return `project:${projectId}`;
}

/** 行的**挂接值** ⇒ 列键（`undefined` = 无项目 ⇒ 无项目列；两者是不同的事实，不合并）。 */
export function workItemProjectLaneKey(projectId: string | undefined): string {
  return projectId === undefined ? WORK_ITEM_NO_PROJECT_LANE_KEY : projectLaneKey(projectId);
}

/** 列键 ⇒ 项目 id（无项目列 ⇒ `null`；不认识的键 ⇒ 原样回，调用方按 missing 呈现）。 */
export function projectIdFromLaneKey(laneKey: string): string | null {
  if (laneKey === WORK_ITEM_NO_PROJECT_LANE_KEY) return null;
  return laneKey.startsWith("project:") ? laneKey.slice("project:".length) : laneKey;
}

/**
 * 项目列头的**显示结论**（判别联合：三种情形分开，不合并成一个字符串）——
 * 与 `workItemQuickCreateParentDisplay` 同款形态，渲染层按 `kind` 取文案。
 */
export type WorkItemProjectLaneDisplay =
  | { kind: "none" }
  | { kind: "project"; name: string; shortCode: string }
  | { kind: "missing"; id: string };

export function workItemProjectLaneDisplay(input: {
  laneKey: string;
  projects: readonly WorkItemProjectOption[];
}): WorkItemProjectLaneDisplay {
  const projectId = projectIdFromLaneKey(input.laneKey);
  if (projectId === null) return { kind: "none" };
  const project = findWorkItemProject(input.projects, projectId);
  return project === null
    ? { kind: "missing", id: projectId }
    : { kind: "project", name: project.name, shortCode: project.shortCode };
}

/* ---------------- 新建项目（拾取器内联表单）的**预检** ---------------- */

/**
 * 内联「新建项目」表单的输入原文（会话内状态；`""` = 没填）。
 * 名字与短码**都是必填**（服务面：name 必填；shortCode 2-8 位大写字母数字且 workspace 内唯一）。
 */
export type WorkItemProjectDraft = { name: string; shortCode: string };

export function workItemProjectEmptyDraft(): WorkItemProjectDraft {
  return { name: "", shortCode: "" };
}

/**
 * 新建项目的**预检结论**（判别联合，照 `WorkItemLabelsParseResult`：非 ok 必须**指名**坏在哪一项，
 * 而不是一句「输入不合法」）。
 *
 * 短码的判据**只有一份**：shared 的 `resolveProjectShortCode`（2-8 位大写字母数字，不做静默
 * 大小写规整/裁剪 —— 短码进编号，宁可响亮拒）。本函数只做两件 UI 侧的事：① 名字 trim 后非空；
 * ② 把短码原文交给 shared 判。**不在这里预判唯一性**（那是服务面的事务内判据，UI 抢答会
 * 在并发下说错话：唯一性判据第二份 = 迟早与库不一致）。
 */
export type WorkItemProjectDraftResult =
  | { kind: "ok"; name: string; shortCode: string }
  | { kind: "invalid"; field: "name" }
  | { kind: "invalid"; field: "shortCode"; value: string };

export function parseWorkItemProjectDraft(
  draft: WorkItemProjectDraft,
): WorkItemProjectDraftResult {
  const name = draft.name.trim();
  if (name.length === 0) return { kind: "invalid", field: "name" };
  const shortCode = resolveProjectShortCode(draft.shortCode);
  if (shortCode.kind !== "ok") return { kind: "invalid", field: "shortCode", value: shortCode.value };
  return { kind: "ok", name, shortCode: shortCode.shortCode };
}

/** 短码形状的**即时提示**（表单在输入时就能说「这样不行」，而不是等到提交才拒）：
 *  `""` = 还没填（不提示，避免一打开表单就一片红）；否则只回答「是不是合法形状」。 */
export function workItemProjectShortCodeLooksValid(raw: string): boolean {
  return raw.length === 0 || isProjectShortCode(raw);
}

/** 坏在哪一项 ⇒ 文案 id（**穷尽映射**：加一项 ⇒ 编译期在这里报缺失，而不是界面上多一个裸 key）。 */
export const WORK_ITEM_PROJECT_DRAFT_ERROR_MESSAGE_IDS = {
  name: "squad.workItems.project.nameRequired",
  shortCode: "squad.workItems.project.shortCodeInvalid",
} as const;

export function workItemProjectDraftErrorMessageId(
  failure: Exclude<WorkItemProjectDraftResult, { kind: "ok" }>,
): string {
  return WORK_ITEM_PROJECT_DRAFT_ERROR_MESSAGE_IDS[failure.field];
}

/* ---------------- 项目过滤菜单的选项清单 ---------------- */

/**
 * 项目过滤菜单的一项（判别联合：「无项目」不是一个项目，故不是 id 列表里的一枚）。
 * 形态真源：multica `issues-header.tsx:549-566`（「No project」为首枚 checkbox + 其后的项目清单）。
 */
export type WorkItemProjectFilterOption =
  | { kind: "none" }
  | { kind: "project"; id: string; name: string };

/**
 * 选项清单（**纯函数**：组件只渲染它，不自己拼遍历顺序）。三条口径：
 * ① 「无项目」**恒第一枚**（它是存量行的常态，也是这一维最常用的一档）；
 * ② 清单为 `null`（还没读到）⇒ 只有「无项目」这一档 —— 不假装清单是空的；
 * ③ 项目次序 = 服务面给的次序（本层不重排、不按名字排序：界面次序不该随改名漂移）。
 */
export function workItemProjectFilterOptions(
  projects: readonly WorkItemProjectOption[] | null,
): WorkItemProjectFilterOption[] {
  return [
    { kind: "none" },
    ...(projects ?? []).map((project) => ({ kind: "project" as const, ...project })),
  ];
}

/* ---------------- 创建流的**项目预填**（子项继承） ---------------- */

/**
 * 「选了父项 ⇒ 项目预填父项的项目」的**唯一判据**（快速创建条与完整表单共用）。
 *
 * 口径（multica A2 的三个预填来源里，本仓 v1 只做「子项继承父项项目」这一条）：
 * · 选中的父项**有项目** ⇒ 预填它的项目 id（子项与父项同属一个项目 —— 这是用户已经表达过的意图）；
 * · 父项**无项目**、没选父项、或父项不在候选里 ⇒ `undefined`（= 无项目）；
 * · **不记忆「上次用的项目」**（multica MUL-5862 的纪律）：本函数只看**这一次**的父项选择，
 *   没有任何跨次/跨会话的状态 —— 「上次选的项目」不会顺着连续创建溜到下一条。
 */
export function workItemProjectPrefillForParent(input: {
  parentId?: string;
  /** 父项候选（宿主给的**原始**列表：本函数只读 id 与 projectId 两列）。 */
  candidates: readonly { id: string; projectId?: string }[];
}): string | undefined {
  if (input.parentId === undefined) return undefined;
  return input.candidates.find((item) => item.id === input.parentId)?.projectId;
}
