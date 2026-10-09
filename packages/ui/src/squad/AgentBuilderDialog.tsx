import { useCallback, useRef, useState } from "react";
import type { IAgentBuilderService } from "@zcode/services";
import type { AgentBuilderDraft } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { AgentBuilderPanel } from "./AgentBuilderPanel.js";
import {
  agentBuilderFailureOf,
  agentBuilderHistoryOf,
  agentBuilderSessionOnFailure,
  agentBuilderSessionOnResult,
  agentBuilderSessionOnSend,
  agentBuilderSessionOnStop,
  emptyAgentBuilderSession,
  type AgentBuilderMessage,
  type AgentBuilderSession,
} from "./agentBuilderViewModel.js";

/* AI 访谈式智能体的**访谈对话框**（设计报告 §4-D3/D4、§5.2）：状态与编排在这里，
   呈现全在 AgentBuilderPanel（纯 props，可被真渲染钉住）。

   为什么是独立对话框而不是塞进 TeamAgentDialog：那张表单是「唯一一份表单」纪律的产物
   （创建/编辑两用），把聊天塞进去会让它膨胀并在字段校验上分叉；multica 的原生形态也是两条入口。

   状态所有权：访谈消息与草稿是本组件的 React state（唯一写者），关闭即弃（§5.2）。
   一轮一次 await（不流式，§8-Q4），pending 时可停止（abort）——服务端收到 abort 后不再产出，
   界面回 idle 且**保留**刚发出的用户消息，于是「重试本轮」有同一条答案可重发。

   `service` 为 null 时面板**给原因**（不把入口藏掉、不静默成"访谈不可用"）：
   与列表入口「可见性不依赖取数成功」同款纪律。 */

export function AgentBuilderDialog({
  workspacePath,
  workspaceIdentity,
  service,
  onClose,
  onOpenManualForm,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 访谈服务；null = 当前 accessor 上没有（面板给原因，两个出口仍可用）。 */
  service: IAgentBuilderService | null;
  /** 用户明确关闭（若已有对话，关闭前先确认）。 */
  onClose: () => void;
  /** 「去确认」/「改为手动创建」共用的出口：带着当前草稿（可能为 null）打开既有表单。 */
  onOpenManualForm: (draft: AgentBuilderDraft | null) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [session, setSession] = useState<AgentBuilderSession>(emptyAgentBuilderSession);
  const [answer, setAnswer] = useState("");
  /** 在飞请求的取消句柄；非空即 pending（单轮单飞：pending 时发送/重试都被忽略）。 */
  const abortRef = useRef<AbortController | null>(null);
  const t = useCallback((id: string) => intl.formatMessage({ id }), [intl]);

  /** 一轮调用：abort 判定与失败分流都在这里，其余部分只管渲染。 */
  const runTurn = useCallback(
    async (history: readonly AgentBuilderMessage[], draft: AgentBuilderDraft | null) => {
      if (!service) return;
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await service.interviewTurn({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          history: agentBuilderHistoryOf(history),
          draft,
          signal: controller.signal,
          locale,
        });
        setSession((current) => agentBuilderSessionOnResult(current, result));
      } catch (error) {
        // 用户按了停止：服务端已不再产出，这不是失败，界面回 idle（消息保留）。
        setSession((current) =>
          controller.signal.aborted
            ? agentBuilderSessionOnStop(current)
            : agentBuilderSessionOnFailure(current, agentBuilderFailureOf(error)),
        );
      } finally {
        abortRef.current = null;
      }
    },
    [locale, service, workspaceIdentity, workspacePath],
  );

  const send = useCallback(() => {
    if (!service || session.status === "pending") return;
    const next = agentBuilderSessionOnSend(session, answer);
    if (next === session) return; // 空输入不产生一轮
    setAnswer("");
    setSession(next);
    void runTurn(next.messages, next.draft);
  }, [answer, runTurn, service, session]);

  const retryTurn = useCallback(() => {
    if (!service || session.status === "pending") return;
    setSession({ ...session, status: "pending", failure: null });
    void runTurn(session.messages, session.draft);
  }, [runTurn, service, session]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* 关闭前确认：访谈历史只在内存里，丢弃不可恢复（§8-Q5）—— 还没说话时不必打扰用户。 */
  const requestClose = useCallback(async () => {
    if (session.messages.length === 0) {
      onClose();
      return;
    }
    const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
      title: t("squad.agentBuilder.closeConfirmTitle"),
      description: t("squad.agentBuilder.closeConfirmDescription"),
      confirmLabel: t("squad.agentBuilder.closeConfirmDiscard"),
      cancelLabel: t("squad.common.cancel"),
      confirmVariant: "destructive",
    });
    if (confirmed) onClose();
  }, [onClose, session.messages.length, t]);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : void requestClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("squad.agentBuilder.title")}
            <Badge variant="secondary" data-testid="agent-builder-recommended">
              {t("squad.agentBuilder.recommended")}
            </Badge>
          </DialogTitle>
          <DialogDescription>{t("squad.agentBuilder.intro")}</DialogDescription>
        </DialogHeader>
        <AgentBuilderPanel
          session={session}
          answer={answer}
          serviceAvailable={service !== null}
          onAnswerChange={setAnswer}
          onSend={send}
          onRetry={retryTurn}
          onStop={stop}
          onOpenManualForm={onOpenManualForm}
        />
      </DialogContent>
    </Dialog>
  );
}
