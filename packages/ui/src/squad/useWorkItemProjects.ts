import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor, SquadWorkspaceTarget } from "@zcode/services";
import { logger } from "@/logger.js";
import { resolveSquadRuntimeService } from "./squadRuntimeAccess.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import type { WorkItemProjectDraft, WorkItemProjectOption } from "./workItemProjectViewModel.js";

/* 工作项的**项目清单 + 项目写路径**（R-P2 项目绑定 · UI 轮）—— UI 里 `listProjects` /
   `createProject` 的**唯一调用点**（照 `useWorkItemReactions` 的先例：一个 hook 包住一面的读写，
   消费面只投影它的结论，不各自取服务）。

   为什么是独立 hook（而不是塞进页面或某个组件）：
   · 页面已到 `max-lines = 400` 硬线（阶段三起「不动 Page」的硬约束）⇒ 取数/状态必须在页面之外；
   · 它被**三处**消费（动作行的项目过滤、宿主下的看板/卡片/快速创建条、新建对话框），
     所以所有者必须是页面级的**一份**（接线层持有它，页面把同一个 handle 投给三处）——
     三处各自 `useState` 就会出现「在这一处建的项目，另一处的清单里没有」这种静默分叉。

   三条纪律（与快速创建 / 视图条同款）：
   ① **无乐观插入**：清单只来自服务面回读（`listProjects`），新建成功后**回读**才更新；
   ② **读失败不清空已有清单**：刷新失败是「这次没读到」，不是「项目都没了」（与页面 `reload`
      同款：失败只留痕，列表保持上一次读到的值）；
   ③ **写走服务面唯一入口**（`createProject`），失败**不吞**：翻成 `SquadEntryFeedback` 交给
      调用方**就地**显示（拾取器里的内联表单不关闭 —— 与快速创建条的失败形态一致），
      本层不自己弹 toast（同一件事两处说 = 噪音）。 */

/** 新建项目的**结论**：成功 ⇒ 服务面读回的那条（拾取器据此选中它）；失败 ⇒ 可就地显示的原因。 */
export type WorkItemProjectCreateResult =
  | { kind: "ok"; project: WorkItemProjectOption }
  | { kind: "failed"; feedback: SquadEntryFeedback };

/** 项目清单与写路径的**唯一 handle**（接线层产出，页面投给消费面；消费面只读它）。 */
export type WorkItemProjectsHandle = {
  /** 项目清单（`null` = 还没读到：消费面据此只给「无项目」这一档，不假装清单是空的）。 */
  projects: readonly WorkItemProjectOption[] | null;
  /** 内联新建（拾取器里的小表单）：入参是**预检后**的取值（判据在纯函数里）。 */
  createProject: (draft: WorkItemProjectDraft) => Promise<WorkItemProjectCreateResult>;
  /** 手动重读（读失败后的重试入口；正常路径由 hook 在挂载/换目标时自动读）。 */
  reload: () => Promise<void>;
};

export function useWorkItemProjects(input: {
  services: IServiceAccessor;
  /** `null` = 没有激活工作区 ⇒ 不读（消费面只给「无项目」这一档）。 */
  target: SquadWorkspaceTarget | null;
}): WorkItemProjectsHandle {
  const { services, target } = input;
  const [projects, setProjects] = useState<readonly WorkItemProjectOption[] | null>(null);
  /* 归属代（换 workspace 即换代）：在途的读/写返回只落在**同代**，旧 workspace 的清单
     不会落到新 workspace 名下（与 `useWorkItemReactions` 的 seq 守卫同一条纪律）。
     用 ref 而不是 state：它只参与「丢弃过期返回」的判据，不参与渲染。 */
  const generationRef = useRef(0);
  useEffect(() => {
    generationRef.current += 1;
    /* 换目标即清空：新 workspace 的清单还没读到 ⇒ `null`（绝不是「上一个 workspace 的项目」）。 */
    setProjects(null);
  }, [services, target]);

  const reload = useCallback(async () => {
    if (!target) return;
    const startedAt = generationRef.current;
    try {
      const list = await resolveSquadRuntimeService(services).listProjects(target);
      if (startedAt !== generationRef.current) return; // 过期读返回丢弃
      setProjects(list);
    } catch (error) {
      logger.warn("[WorkItemProjects] 读取项目清单失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      /* 读失败不清空已有清单（见文件头 ②）：首次读失败 ⇒ 保持 null（消费面只给「无项目」档）。 */
    }
  }, [services, target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createProject = useCallback(
    async (draft: WorkItemProjectDraft): Promise<WorkItemProjectCreateResult> => {
      if (!target) {
        return { kind: "failed", feedback: { tone: "error", messageId: "squad.common.noWorkspace" } };
      }
      const startedAt = generationRef.current;
      try {
        const project = await resolveSquadRuntimeService(services).createProject(target, {
          name: draft.name,
          shortCode: draft.shortCode,
        });
        /* 写完**回读清单**（无乐观插入：清单只来自读面 —— 新项目因此来自服务面的排序与形状）。 */
        const list = await resolveSquadRuntimeService(services).listProjects(target);
        if (startedAt === generationRef.current) setProjects(list);
        return { kind: "ok", project };
      } catch (error) {
        const feedback = squadEntryErrorFeedback(error);
        logger.warn("[WorkItemProjects] 新建项目失败", {
          messageId: feedback.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { kind: "failed", feedback };
      }
    },
    [services, target],
  );

  return { projects, createProject, reload };
}
