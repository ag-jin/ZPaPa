import { z } from "zod";

/** 工作项生命周期：4 category / 6 键。category 才是机器判定依据，键只是标签。 */
export const WORK_ITEM_STATUS_KEYS = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type WorkItemStatusKey = (typeof WORK_ITEM_STATUS_KEYS)[number];

export type WorkItemStatusCategory = "unstarted" | "started" | "done" | "closed";

export const WORK_ITEM_STATUS_CATEGORY: Record<WorkItemStatusKey, WorkItemStatusCategory> = {
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

/** 终态：done 与 closed 两类。聚合判定（如 children_done）必须用它，不要比较键名。 */
export function isTerminalWorkItemStatus(key: WorkItemStatusKey): boolean {
  const category = WORK_ITEM_STATUS_CATEGORY[key];
  return category === "done" || category === "closed";
}

export const WORK_ITEM_MAX_DEPTH = 5;
export const WORK_ITEM_MAX_CHILDREN = 50;

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_KEYS);

export const workItemAssigneeSchema = z.object({
  type: z.enum(["user", "agent", "squad"]),
  id: z.string().min(1),
});

export const workItemSchema = z.object({
  id: z.string().min(1),
  workspaceIdentity: z.string().min(1),
  workspacePath: z.string().min(1),
  parentId: z.string().min(1).optional(),
  stage: z.number().int().nonnegative().optional(),
  title: z.string(),
  body: z.string(),
  status: workItemStatusSchema,
  assignee: workItemAssigneeSchema,
  labels: z.array(z.string()).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  position: z.number().default(0),
  archivedAt: z.number().int().nonnegative().optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
