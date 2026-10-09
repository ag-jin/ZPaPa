/* C4（⑤刀 Concurrency 半边）：run 结算事实的扇出 hub。
   为什么需要它：释放容量/分支的收尾动作触发者分散（host 订阅闭包 / 派发 catch / 启动和解 /
   UI 审查 / 编排器）——「host 在每个已知收尾点各挂一次」会漏掉 UI 审查与编排器路径（C0 2.4 事实 2）。
   生命周期是唯一写者（squadRunRepo 文件头），所有收尾都经它 ⇒ 在收尾迁移之后 publish，
   一次覆盖全部路径。形态照 createSquadDispatchRequestHub（组合根建一份、runtime 注入）；
   浏览器安全（纯内存 Set，零 node:* 依赖）。推进/重放的消费方（host）在 C4b 接线。 */

export type SquadRunSettlement = {
  runId: string;
  workspaceKey: string;
  /** 本地定位快照（C4b）：推进侧由它构造 SquadWorkspaceTarget（identity 口径同 C14）。 */
  workspacePath: string;
  /** 结算的那条 run 属于哪个 agent（推进扫描按 agent 找排队行/义务）。 */
  agentId: string;
  /** 收尾后的终态（produced / rejected / merged / discarded）。 */
  status: "produced" | "rejected" | "merged" | "discarded";
};

export type SquadRunSettlementHub = {
  publish(settlement: SquadRunSettlement): void;
  subscribe(handler: (settlement: SquadRunSettlement) => void): () => void;
};

export function createSquadRunSettlementHub(): SquadRunSettlementHub {
  const handlers = new Set<(settlement: SquadRunSettlement) => void>();
  return {
    publish(settlement) {
      // 逐个调用，与 dispatchRequestHub / runtime fanout 同形：一个订阅者抛错不影响其余订阅者。
      for (const handler of handlers) handler(settlement);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
