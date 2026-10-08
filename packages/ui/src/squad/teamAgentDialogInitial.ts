import type { McpServerConfig, ModelSelection, TeamAgent } from "@zcode/shared";

/**
 * 协作智能体表单（TeamAgentDialog）的**初值形状**：编辑回填与 AI 访谈产物预填共用一份。
 *
 * 为什么单独成文件而不是就地写在 SquadCreateDialogs.tsx 里：这个类型被**纯函数层**
 * （`agentBuilderDraftToTeamAgentInitial`）与页面引用。若它挂在对话框组件文件上，任何
 * `import type` 都会把组件链（ModelPickerRow → 模型设置 → Electron webview 等）拉进
 * UI 测试工程的编译图里 —— 测试只需要这个形状，不需要那串依赖。
 *
 * 「字段一改两边同时编译报错」这条约束仍由本文件承担：表单、草稿映射、页面同读一份。
 */
export interface TeamAgentDialogInitial {
  name: string;
  systemPrompt: string;
  memoryScope: TeamAgent["memoryScope"];
  description?: string;
  color?: TeamAgent["color"];
  modelSelection?: ModelSelection;
  skills?: string[];
  permissionMode?: TeamAgent["permissionMode"];
  tools?: string[];
  disallowedTools?: string[];
  maxConcurrentRuns?: number;
  /** per-agent MCP：既有定义的 server map（缺席 = 该 agent 不覆盖任何 server）。 */
  mcpServers?: Record<string, McpServerConfig>;
}
