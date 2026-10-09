import { z } from "zod";
import { convertToZCodeAgentMcpServer } from "./mcp.js";
import type {
  McpScope,
  McpServerConfig,
  NativeMcpServerRecord,
  ZCodeAgentMcpServer,
} from "./mcp.js";

/* 协作智能体的 **per-agent MCP 配置**：形状校验 + 三层合并 + 协议 DTO 转换。
   本模块是**纯函数**（零 IO）：文件读写在 host 的挂载点上（服务面读取器），这里只回答三个问题 ——
     · 这份配置形状对不对（`teamAgentMcpServersSchema`，落盘前由 strict 的 teamAgentSchema 收口）；
     · 三层（user / workspace / agent 自有）合并后谁覆盖谁（`mergeTeamAgentMcpServers`）；
     · 合并集怎么变成 `createTask({ mcpServers })` 要的协议形状（`toZCodeAgentMcpServers`）。
   为什么单独一个模块而不是塞回 `team-agent.ts`：名字规则与覆盖次序是**派发期**行为，
   放进 schema 文件会让「schema 解析」与「运行期挂载」共用一份实现，改一处影响两个语义面；
   放在 host 派发桥里则会把 4k 行的派发桥再撑大、且 wiring 测试里还得再写一份「同名谁赢」。 */

/**
 * 单个 server 的值校验：**刻意浅**（设计 §3.5 的纪律）。
 *
 * 浅到什么程度、为什么不再深一步：
 *  · 只判「能否看出传输形态」的两个字段（`command` 走 stdio、`url` 走 http/sse）+ 必须是非空对象；
 *  · **不**检视、也不回显 `env` / `headers` / `oauth` / `apiKey` 等字段的**内容** —— 那些位置就是凭据，
 *    校验信息里带上一段 token 就等于把凭据写进日志与界面（校验只看形状，永不看内容）；
 *  · 开放形状（`looseObject`）：`McpServerConfig` 本身就是开放形状（`[key: string]: any`），
 *    逐个列出 args/env/headers/timeoutMs/oauth… 只会让「设置页刚写完的新字段」在落盘时被拒。
 * 与 workspace 级设置页的对话框同款判据（对象、非空、`command`/`url` 至少其一）。 */
const mcpServerConfigShape = z
  .looseObject({
    command: z.string().optional(),
    url: z.string().optional(),
  })
  .refine((value) => value.command !== undefined || value.url !== undefined, {
    message: "MCP server 配置至少要给出 command（stdio）或 url（http/sse）之一",
  });

/**
 * TeamAgent 的 `mcpServers` 字段：`Record<server 名, McpServerConfig>`。
 *
 * 为什么是**map**而不是整段 `{"mcpServers": …}` 文档：ZPaPa 只有**一个** agent runtime，
 * canonical 形状就是「名字 → 配置」这一层（`.zcode/config.json` 的 `mcp.servers`、
 * 目录读取器的 `NativeMcpServerRecord`、workspace 设置页都是这个形状）。外层信封在单 runtime 下
 * 携带零信息，只会让每个读者多拆一层、让 strict schema 被迫兼容 legacy 容器写法。
 *
 * server 名**非空**：空名在协议里会变成 `mcp__<server>__` 前缀的孤儿段，且与「同名覆盖」的
 * 判据（按名比较）互相矛盾 —— 宁可在这里拒掉。
 */
export const teamAgentMcpServersSchema = z.record(z.string().min(1), mcpServerConfigShape);

/**
 * 目录记录的作用域**弱 → 强**次序：`common`（本链路读不到，留作最弱档）< `user` < `workspace`。
 * 用显式 rank 而不是依赖读取器给的数组顺序：读取器的返回顺序是实现细节，
 * 换了实现（或将来先 user 后 workspace）会让覆盖方向**静默反过来** —— 那正好是「同名用错凭据」的形态。
 */
const MCP_SCOPE_RANK: Record<McpScope, number> = { common: 0, user: 1, workspace: 2 };

/**
 * 三层合并（设计 §3.3）：`user 级(enabled) + workspace 级(enabled) + agent 自有` ⇒ 一张挂载表。
 *
 * 三条语义（调用方只需要知道这三条）：
 *  · **同名整条覆盖**：workspace 赢 user、agent 赢 workspace（按 server 名浅合并，不做字段级深合并）；
 *  · **`enabled === false` 的目录条目不进集合**（`undefined` 视为启用，与目录读取器同口径）——
 *    这是「用户关掉的 server 不会被 agent 定义重新拉起」的那道闸；
 *  · **缺席 = 该层没有覆盖项**：`agentServers` 为 `undefined` 或 `{}` 时合并集就是 base
 *    （v1 **不做**「空 map = 严格空集/屏蔽继承」，见设计 §3.1 的三态说明）。
 *
 * 返回的是**新表**（条目复制）：调用方拿到的是本次合并的结论，之后对 base 记录的改动不得回流。
 * agent 自有条目**不做** enabled 过滤：那是**定义**（用户显式写下的能力声明），
 * 而 `(enabled)` 这一限定在设计里只加在两个目录层上（目录文件里的 `enabled` 是存储标志位）。
 */
export function mergeTeamAgentMcpServers(
  base: readonly NativeMcpServerRecord[],
  agentServers?: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  // 先按 scope 弱 → 强展开（`sort` 稳定 ⇒ 同档内保持入参原序），后出现的同名条目覆盖前面的。
  const byScope = [...base].sort(
    (left, right) => MCP_SCOPE_RANK[left.scope] - MCP_SCOPE_RANK[right.scope],
  );
  const merged: Record<string, McpServerConfig> = {};
  for (const entry of byScope) {
    if (entry.enabled === false) continue;
    merged[entry.name] = { ...entry.config };
  }
  if (agentServers) {
    for (const [name, config] of Object.entries(agentServers)) {
      merged[name] = { ...config };
    }
  }
  return merged;
}

/**
 * 合并集 ⇒ `createTask({ mcpServers })` 要的协议形状（`ZCodeAgentMcpServer[]`）。
 *
 * 三件事：
 *  · 逐条经由**既有**转换器 `convertToZCodeAgentMcpServer`（不另写一份「command ⇒ stdio / url ⇒ http」
 *    的判据：那正是 Windows `cmd /c` 拆包、timeoutMs/isolation 过滤等细节所在，抄一份必然漂移）；
 *  · 转不出来的条目**只跳过它自己**，并通过 `onSkippedServer(name)` 报出**名字**（内容可能含凭据，
 *    日志里只许出现 server 名）—— 一条配置写错不该判掉整个派发；
 *  · 集合为空（本来就是空表，或全部条目都转不出来）⇒ 返回 **`undefined`**：调用方据此**不传**该参数。
 *    这是**三态语义**里「没有任何托管 server」那一态：不传 ⇒ CLI 按 config 文件原生继承
 *    （user + workspace + plugin 底座）；显式传集合 ⇒ 该集合是**覆盖集**（设计 §2.2 的既有语义）。
 *    为什么空集合走「不传」而不是传 `[]`：语义上「没有托管项」与「托管集合为空」在这里是同一件事，
 *    而 `[]` 在协议层会被读成后者（覆盖集为空）。桌面适配器当前恰好把空数组归一成「未提供」
 *    （`zcodeTaskServiceAdapter.resolveProductMcpServers`），我们不依赖那个下游细节 ——
 *    三态在挂载层显式表达，换适配器也不会翻面。
 */
export function toZCodeAgentMcpServers(
  merged: Record<string, McpServerConfig>,
  onSkippedServer?: (name: string) => void,
): ZCodeAgentMcpServer[] | undefined {
  const servers: ZCodeAgentMcpServer[] = [];
  for (const [name, config] of Object.entries(merged)) {
    const converted = convertToZCodeAgentMcpServer(name, config);
    if (converted) {
      servers.push(converted);
    } else {
      onSkippedServer?.(name);
    }
  }
  return servers.length > 0 ? servers : undefined;
}
