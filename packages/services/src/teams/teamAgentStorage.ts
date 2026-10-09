import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { teamAgentSchema, type TeamAgent, type TeamAgentInput } from "@zcode/shared";

/* 协作智能体定义的存储：**实验命名空间** <ws>/.zcode/squad/agents，与现有 subagent 的
   <ws>/.zcode/agents 完全分离（决策 C3）。
   隔离的意义是「可整块删除」：删掉 .zcode/squad/ 不会碰到任何现有 subagent 定义或记忆。

   全部用同步 fs：定义是小文件、调用点是服务层的同步 CRUD（Task 8 的 get/list/archive 都是同步
   返回，不返回 Promise），异步只会把复杂度推给每个调用点。 */

/**
 * 实验命名空间根：`<workspacePath>/.zcode/squad/agents`。
 * 刻意**不**落在 `.zcode/agents`（那是现有 subagent 目录）：两个根之间没有前缀包含关系，
 * 删掉本目录整棵树不会碰到现有 subagent 的任何文件。
 */
export function resolveSquadAgentRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "squad", "agents");
}

const DEFINITION_FILE_SUFFIX = ".json";

function definitionPath(root: string, id: string): string {
  return join(root, `${id}${DEFINITION_FILE_SUFFIX}`);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * 原子写：同目录写临时文件（fsync + close）后 renameSync 覆盖。
 * 临时候选名以 `.tmp` 结尾而**不是** `.json`，所以崩溃留下的半截文件既不会被
 * `listTeamAgents` 的 `*.json` 过滤读入，也不会被误当成某个智能体的定义。
 * rename 在同一目录内原子：观察者要么看到旧定义，要么看到完整新定义，看不到半个。
 */
function atomicWriteFile(path: string, content: string): void {
  const directory = dirname(path);
  const tempPath = join(
    directory,
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o644);
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败无关紧要：下面的 rm 才是必须做的清理。
      }
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 临时文件清理失败不应掩盖真正的写错误。
    }
    throw error;
  }
}

/**
 * 写一个定义（覆盖同名 id）。先按 **strict** schema 解析：未知字段（含 `hostBinding`）与空 id
 * 在这里就被拒，不会落盘成一份非法定义；`skills` 等带 default 的字段在此归一化后写入。
 * 返回归一化后的定义，调用方不必再解析一次。
 */
export function writeTeamAgent(root: string, agent: TeamAgentInput): TeamAgent {
  const parsed = teamAgentSchema.parse(agent);
  const path = definitionPath(root, parsed.id);
  mkdirSync(root, { recursive: true });
  atomicWriteFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

/**
 * 读单个定义。文件不存在返回 null（"没有这个智能体"是正常状态，不是错误）；
 * 文件存在但内容非法则**抛错**——按 id 显式读取时把损坏暴露出来。
 * 列表读取（listTeamAgents）为了可用性跳过坏文件，两者刻意不对称。
 */
export function readTeamAgent(root: string, id: string): TeamAgent | null {
  let raw: string;
  try {
    raw = readFileSync(definitionPath(root, id), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  const parsed = teamAgentSchema.parse(JSON.parse(raw));
  if (parsed.id !== id) {
    // 文件名 id 与内容 id 必须一致：list 以文件名为键，read 以内容为键，
    // 不一致会让两条路径指向不同的智能体（记忆 key 也会指错人）。
    throw new Error(`team agent 定义的文件名与内容 id 不一致：期望 ${id}，实际 ${parsed.id}`);
  }
  return parsed;
}

/**
 * 列出目录下全部定义（**包含已归档**——归档只加时间戳，是否隐藏由上层决定）。
 * 单个文件坏掉（半截 JSON / 被手工改坏 / strict 校验不过）只跳过它自己：
 * 一个坏文件不该让整份花名册消失。目录不存在即空列表。
 */
export function listTeamAgents(root: string): TeamAgent[] {
  if (!existsSync(root)) {
    return [];
  }
  const agents: TeamAgent[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (!entry.endsWith(DEFINITION_FILE_SUFFIX)) {
      continue;
    }
    const id = entry.slice(0, -DEFINITION_FILE_SUFFIX.length);
    if (id.length === 0) {
      continue;
    }
    try {
      const agent = readTeamAgent(root, id);
      if (agent) {
        agents.push(agent);
      }
    } catch {
      // 坏文件跳过：宁可少一个智能体，也不让整份列表崩（用户可从文件系统手工修）。
      continue;
    }
  }
  return agents;
}

/** 硬删定义文件（归档走 writeTeamAgent 写 archivedAt，不走这里）。幂等：文件已不在也算成功。 */
export function deleteTeamAgent(root: string, id: string): void {
  rmSync(definitionPath(root, id), { force: true });
}
