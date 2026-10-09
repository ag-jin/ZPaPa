import {
  mergeTeamAgentMcpServers,
  toZCodeAgentMcpServers,
  type McpServerConfig,
  type NativeMcpServerRecord,
  type ZCodeAgentMcpServer,
} from "@zcode/shared";

/* 小队派发的 **MCP 挂载点**（设计 §3.3/§3.8）。
   一个 run 要挂哪些 MCP server = 「目录里的基准（user 级 + workspace 级，enabled）」叠加
   「该 agent 自有的 mcpServers」，同名时后者赢；结论经 `createTask({ mcpServers })` 显式传入
   （协议/服务/CLI 三层零改动：`IZCodeTaskService.createTask` 已收这个参数）。

   为什么把它单独抽成一个模块、并把读取器**当参数注入**：
     · host 的派发桥（`index.ts`）是 5k 行的装配文件，卷进「合并次序 / 转换 / 跳过规则」后就没法
       单独驱动 —— 而这里的三条语义（次序、三态、跳过）各自都对应一次**静默失效**的可能；
     · 读取器是环境依赖（真实实现是服务面的目录读取器），注入之后本模块零 IO、可在测试里注入假读取器，
       直接断言「问了哪个路径、拿到了什么集合」（accept dependencies, don't create them）；
     · 基准读取**归属服务面**（唯一实现）：host 不自己读 config.json —— 那会变成第二份
       「workspace/user 级 MCP 在哪、怎么算 enabled」的判据，改一处漏一处。 */

/**
 * 基准读取器端口：给一个工作区路径，回「user 级 + workspace 级」的目录记录。
 *
 * 为什么参数只有**工作区路径**、返回只有记录数组：真实实现（服务面 `IMcpSyncService.loadMcpFromUserDirectory`）
 * 的请求/响应信封在这一层没有信息量 —— 信封里的 `servers` 就是这里的返回值，其余字段没人读。
 * 调用方必须给**主工作区路径**（不是队员 run 的工作树路径）：那正是要修的那个缺口 ——
 * 工作树是主工作区之外的新检出目录，未跟踪的 `<ws>/.zcode/config.json` 不在其中，
 * CLI 按会话 cwd 原生读取时读不到 workspace 级 server（队长读得到、队员读不到，且不报错）。
 */
export type SquadMcpBaseLoader = (request: {
  workspacePath: string;
}) => Promise<readonly NativeMcpServerRecord[]>;

/** 一次派发的挂载结论：`undefined` = **不传**该参数（见下面 resolve 的三态说明）。 */
export type SquadMcpMountResult = ZCodeAgentMcpServer[] | undefined;

/**
 * 绑定一个基准读取器，得到「本次派发怎么挂」的解析函数（装配点注入的落点）。
 *
 * 三态（`undefined` 的那一格是**语义**而不是省事）：没有任何可挂的 server ⇒ 返回 `undefined`，
 * 调用方据此**不传** `mcpServers` —— CLI 在「没传」时按 config 文件原生继承（含 plugin 底座），
 * 而显式传入的集合是**覆盖集**（设计 §2.2）。桌面适配器当前恰好把空数组归一成「未提供」
 * （`zcodeTaskServiceAdapter.resolveProductMcpServers`），但三态由本层显式表达，不依赖那个下游细节。
 *
 * 错误归属：读取失败**不在这里兜底**（不返回空集合、也不降级成 agent-only）——
 * 吞掉的表现是「这次 run 悄悄少了整整一层 server」，比失败更坏。错误原样冒泡，
 * 由派发桥按既有 transient 出口处置（响亮 + 修好 config 后重投自愈）。
 */
export function createSquadMcpMountResolver(deps: { loadBase: SquadMcpBaseLoader }): (input: {
  /** **主工作区**路径（不是工作树路径）：基准读取的落点，见 `SquadMcpBaseLoader` 的说明。 */
  workspacePath: string;
  /** 本次派发的 agent 自有配置；缺席/空 map 都表示「该 agent 不额外覆盖任何 server」。 */
  agentMcpServers?: Record<string, McpServerConfig>;
  /** 逐条转换失败时的留痕出口：**只给 server 名**（配置里可能有凭据，日志不得带内容）。 */
  onSkippedServer?: (name: string) => void;
}) => Promise<SquadMcpMountResult> {
  return async (input) => {
    const base = await deps.loadBase({ workspacePath: input.workspacePath });
    return toZCodeAgentMcpServers(
      mergeTeamAgentMcpServers(base, input.agentMcpServers),
      input.onSkippedServer,
    );
  };
}
