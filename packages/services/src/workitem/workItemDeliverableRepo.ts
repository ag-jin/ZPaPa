import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AuthorRef } from "./workItemCommentRepo.js";

/* #7 工作项级交付物（D1a）的**存储面**：`work_item_deliverables` 表（迁移 0016）的唯一读写口。

   设计报告 §3.1/§3.2/§3.5 的三条立身之本：
   ① **唯一写者面**：自动捕获（D1b 接线的捕获模块）与手动登记（D1b 的服务面）共用这一个 repo；
   ② **只增不改**：本文件结构上不存在 UPDATE/DELETE（与 `workItemActivityRepo` 同款负向守卫钉住）；
   ③ **读回不猜**：kind 闭集外的值一律响亮抛；`meta_json` 坏 JSON 也抛——静默按默认处理会让
      「这条交付物到底是什么」无人知道（同 Activity payload 的读回纪律）。

   两型的存储形态（设计 §3.2 的裁定，Q4/Q5）：
   · `diff`：正文**不进库**（真实 diff 可达数百 KB~MB，tasks-index 库被多窗口 Host 共连接），
     落 `<ws>/.zcode/squad/deliverables/<id>.diff`，表里只留**相对路径** + sha256 + 字节数；
   · `link`：`content_ref` 就是外部 URL，sha/字节数恒 NULL（正文不在本地，不伪造）。

   正文文件是**写一次、不更新**的（设计 §3.5）：同 dedupKey 重投先读回既存行直接返回，
   不重写正文——否则「重放出的第二次捕获」会用一个可能不同的 diff 覆盖掉第一次的事实。

   路径逃逸防护（P0 `teamAgentStorage` 先例，spec §17 列为「传 id 前必修」）：
   id 进文件名之前先过单段闸（`..` / 分隔符 / 空段一律响亮拒），读回时再按 content_ref
   解析出绝对路径并确认它仍落在正文根内——库里被写坏的一行不得变成一次越界读。 */

/** v1 类型闭集（设计 §3.2 / Q5 裁定：`file`/`summary` 后置）。列上不建 CHECK——枚举漂移
    要在代码里响亮（读写双闸），不在 DDL 里静默。 */
export const DELIVERABLE_KINDS = ["diff", "link"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** 实验命名空间下的正文根：`<workspacePath>/.zcode/squad/deliverables`。
    与 `.zcode/squad/{agents,squads}` 同一个命名空间 ⇒ 集中排除清单（`.zcode/squad`）零改动。 */
export function resolveDeliverableContentRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "squad", "deliverables");
}

const CONTENT_FILE_SUFFIX = ".diff";

export type WorkItemDeliverableRecord = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  /** NULL = 手动登记（挂工作项不挂 run）。 */
  runId: string | null;
  kind: DeliverableKind;
  title: string;
  /** 结构化事实（branch/base/statSummary/commitCount/batchLevel…）：形状随产生点而变，故 JSON 存。 */
  meta: Record<string, unknown>;
  /** diff = 相对路径（`.zcode/squad/deliverables/<id>.diff`）；link = 外部 URL。 */
  contentRef: string;
  contentSha: string | null;
  contentSize: number | null;
  actor: AuthorRef;
  dedupKey: string;
  createdAt: number;
  updatedAt: number;
};

type RegisterDeliverableBase = {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  workItemId: string;
  runId?: string;
  title: string;
  meta?: Record<string, unknown>;
  actor: AuthorRef;
  dedupKey: string;
  createdAt: number;
};

/**
 * 两型的**判别联合**：`diff` 必须交正文（repo 负责落盘 + 记 sha/字节数），`link` 必须交 URL。
 * 闭集外的 kind 在 TS 层就写不出来；JS 调用方 / 数据驱动路径由运行时的 `assertDeliverableKind` 挡。
 */
export type RegisterDeliverableInput = RegisterDeliverableBase &
  ({ kind: "diff"; content: string } | { kind: "link"; url: string });

/** 正文读回三态（设计 §8）：元数据在库、正文按 ref 探测——**不谎报、不重建**。 */
export type DeliverableContent =
  | { presence: "file"; text: string }
  | { presence: "missing" }
  | { presence: "external"; url: string };

/** 单条详情 = 表行 + 正文读回（列表路径只读行，不读盘——清单查询走库、正文按 ref）。 */
export type WorkItemDeliverableDetail = {
  record: WorkItemDeliverableRecord;
  content: DeliverableContent;
};

export interface WorkItemDeliverableRepo {
  /**
   * 登记一条交付物（**唯一写入口**）。同 `(workspaceKey, dedupKey)` 重投 ⇒ 返回既存行、
   * 正文文件不重写（写一次不更新）；只有真正的首投才落盘 + 插入。
   */
  register(input: RegisterDeliverableInput): WorkItemDeliverableRecord;
  /** 单条详情（含正文读回）；id 不存在返回 null（"没有这条"是正常状态，不是错误）。 */
  get(id: string): WorkItemDeliverableDetail | null;
  /** 某工作项的交付物清单（`created_at ASC, id ASC`；workspace 隔离）。 */
  listByWorkItem(workspaceKey: string, workItemId: string): WorkItemDeliverableRecord[];
  /** 某 run 的交付物清单（runId 是派发身份，跨库唯一；`created_at ASC, id ASC`）。 */
  listByRun(runId: string): WorkItemDeliverableRecord[];
}

interface DeliverableRow {
  id: string;
  workspace_key: string;
  workspace_path: string;
  work_item_id: string;
  run_id: string | null;
  kind: string;
  title: string;
  meta_json: string;
  content_ref: string;
  content_sha: string | null;
  content_size: number | null;
  actor_kind: string;
  actor_id: string;
  dedup_key: string;
  created_at: number;
  updated_at: number;
}

function readDeliverableKind(value: string): DeliverableKind {
  if (!(DELIVERABLE_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `work_item_deliverables.kind 读回非法值「${value}」：列被写坏或闭集被改小，一律抛。`,
    );
  }
  return value as DeliverableKind;
}

function assertDeliverableKind(kind: DeliverableKind): DeliverableKind {
  if (!(DELIVERABLE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`work_item_deliverables.kind 拒绝写入非法值「${String(kind)}」（不在闭集内）`);
  }
  return kind;
}

/** link 的写入闸：URL 是这条事实的**全部内容**，空白 URL 记下来只是一条没人能用的死链。 */
function assertNonBlankUrl(url: string): string {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      `work_item_deliverables.link 的 url 不得为空白（收到 ${JSON.stringify(url)}）：` +
        "一条没有 URL 的 link 交付物没有任何可复查的内容。",
    );
  }
  return url;
}

function readAuthorKind(value: string): AuthorRef["kind"] {
  if (!["human", "agent", "system"].includes(value)) {
    throw new Error(`work_item_deliverables.actor_kind 读回非法值「${value}」：一律抛。`);
  }
  return value as AuthorRef["kind"];
}

function rowToRecord(row: DeliverableRow): WorkItemDeliverableRecord {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(row.meta_json) as Record<string, unknown>;
  } catch {
    throw new Error("work_item_deliverables.meta_json 读回非法 JSON：一律抛。");
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workItemId: row.work_item_id,
    runId: row.run_id,
    kind: readDeliverableKind(row.kind),
    title: row.title,
    meta,
    contentRef: row.content_ref,
    contentSha: row.content_sha,
    contentSize: row.content_size,
    actor: { kind: readAuthorKind(row.actor_kind), id: row.actor_id },
    dedupKey: row.dedup_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * id 限死为**单一路径段**（P0 `teamAgentStorage` / `squadStorage` 同款拦法）：否则 `../evil`
 * 这类 id 会把正文写到实验命名空间之外（`<ws>/.zcode/squad/evil.diff`）。
 * `basename("..")` 返回 `".."` 本身，故 `.` / `..` 必须显式列出；`\\` 在 posix 下不是分隔符，
 * 但同一份数据可能在 Windows 上被读，故一并拒绝。
 */
function assertSinglePathSegment(id: string): void {
  const illegal =
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    basename(id) !== id;
  if (illegal) {
    throw new Error(
      `非法的交付物 id「${id}」：id 必须是单一路径段（不得为空、"."、".." 或含路径分隔符）——` +
        "id 会拼进正文文件名，放行即等于允许把文件写到实验命名空间之外。",
    );
  }
}

/** 正文文件的唯一收口：写路径与读路径都经这里，路径逃逸只在构造上不存在（而不是靠调用方自觉）。 */
function deliverableContentPath(root: string, id: string): string {
  assertSinglePathSegment(id);
  const path = join(root, `${id}${CONTENT_FILE_SUFFIX}`);
  // 第二道（纵深）：即使某天上面的闸被改松，越出正文根也在这里响亮失败。
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`交付物正文路径越出正文根：${path}（root=${root}）`);
  }
  return path;
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * 原子写（同目录临时文件 + fsync + rename）——与 `squadStorage.atomicWriteFile` 同一手法：
 * 崩溃留下的半截文件带 `.tmp` 后缀、不会被当成正文；rename 同目录内原子，读者看不到半个文件。
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

const ORDER = "ORDER BY created_at ASC, id ASC";

export function createWorkItemDeliverableRepo(db: DatabaseSync): WorkItemDeliverableRepo {
  function readByDedupKey(
    workspaceKey: string,
    dedupKey: string,
  ): WorkItemDeliverableRecord | null {
    const row = db
      .prepare("SELECT * FROM work_item_deliverables WHERE workspace_key = ? AND dedup_key = ?")
      .get(workspaceKey, dedupKey) as DeliverableRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** diff 的落盘半：正文写一次（原子），返回库要存的三个引用值。 */
  function writeDiffContent(input: { workspacePath: string; id: string; content: string }): {
    contentRef: string;
    contentSha: string;
    contentSize: number;
  } {
    const root = resolveDeliverableContentRoot(input.workspacePath);
    mkdirSync(root, { recursive: true });
    atomicWriteFile(deliverableContentPath(root, input.id), input.content);
    return {
      // 库里的引用恒为**相对路径**（正斜杠：同一行数据可能在 Windows 上被读）。
      contentRef: [".zcode", "squad", "deliverables", `${input.id}${CONTENT_FILE_SUFFIX}`].join(
        "/",
      ),
      contentSha: createHash("sha256").update(input.content, "utf8").digest("hex"),
      contentSize: Buffer.byteLength(input.content, "utf8"),
    };
  }

  /** 正文读回（单条详情用）：link 恒为外部引用；diff 按 ref 探测，缺文件 ⇒ `missing`（不抛、不重建）。 */
  function readContent(record: WorkItemDeliverableRecord): DeliverableContent {
    if (record.kind === "link") {
      return { presence: "external", url: record.contentRef };
    }
    // content_ref 是相对路径：解析回绝对路径前先确认它落在**正文根**内（库里被写坏的一行
    // 不得变成一次越界读）。
    const root = resolveDeliverableContentRoot(record.workspacePath);
    const path = resolve(record.workspacePath, record.contentRef);
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `work_item_deliverables.content_ref 越出正文根，拒绝读取：${JSON.stringify(record.contentRef)}`,
      );
    }
    try {
      return { presence: "file", text: readFileSync(path, "utf8") };
    } catch (error) {
      // 缺文件 = 「正文缺失」这一**呈现态**（元数据在库，不谎报、不重建，设计 §8）；
      // 其余读取错误（权限/IO）照样响亮抛——那不是「用户删了 .zcode」。
      if (isNotFoundError(error)) return { presence: "missing" };
      throw error;
    }
  }

  return {
    register(input) {
      /* id 闸**先于一切分支**（P3-1，D1 复验发现）：单段闸原先只藏在 `deliverableContentPath`
         （diff 落盘半）里，于是 link 行的 `../../escape` 能落库。id 是主键与寻址面，两型同口径；
         放在读 dedupKey **之前**，是为了让非法输入零副作用（否则重投会返回一行用坏 id 建的既存行）。 */
      assertSinglePathSegment(input.id);
      assertDeliverableKind(input.kind);
      if (input.kind === "link") assertNonBlankUrl(input.url);
      // 幂等：同键重投返回既存行、**不重写正文**（写一次不更新——重放的第二次捕获可能算出
      // 不同的 diff，覆盖会让表里的 sha 与盘上正文分叉）。跨连接并发下的双投由唯一索引兜底
      // （INSERT OR IGNORE），那个窗口里的正文重写登记为已接受的边角（同 Activity 先例）。
      const existing = readByDedupKey(input.workspaceKey, input.dedupKey);
      if (existing) return existing;
      const content =
        input.kind === "diff"
          ? writeDiffContent({
              workspacePath: input.workspacePath,
              id: input.id,
              content: input.content,
            })
          : // link：正文在外部，content_ref 就是 URL；sha/字节数恒 NULL（本地没有正文可算，不伪造）。
            { contentRef: input.url, contentSha: null, contentSize: null };
      db.prepare(
        `INSERT OR IGNORE INTO work_item_deliverables (
           id, workspace_key, workspace_path, work_item_id, run_id, kind, title, meta_json,
           content_ref, content_sha, content_size, actor_kind, actor_id, dedup_key,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.workspaceKey,
        input.workspacePath,
        input.workItemId,
        input.runId ?? null,
        input.kind,
        input.title,
        JSON.stringify(input.meta ?? {}),
        content.contentRef,
        content.contentSha,
        content.contentSize,
        input.actor.kind,
        input.actor.id,
        input.dedupKey,
        input.createdAt,
        input.createdAt,
      );
      const row = readByDedupKey(input.workspaceKey, input.dedupKey);
      if (!row) {
        throw new Error(
          `work_item_deliverables 写入后读不回（id=${input.id}, dedupKey=${input.dedupKey}）：不可达态，须查库。`,
        );
      }
      return row;
    },

    get(id) {
      const row = db.prepare("SELECT * FROM work_item_deliverables WHERE id = ?").get(id) as
        | DeliverableRow
        | undefined;
      if (!row) return null;
      const record = rowToRecord(row);
      return { record, content: readContent(record) };
    },

    listByWorkItem(workspaceKey, workItemId) {
      const rows = db
        .prepare(
          `SELECT * FROM work_item_deliverables WHERE workspace_key = ? AND work_item_id = ? ${ORDER}`,
        )
        .all(workspaceKey, workItemId) as unknown as DeliverableRow[];
      return rows.map(rowToRecord);
    },

    listByRun(runId) {
      const rows = db
        .prepare(`SELECT * FROM work_item_deliverables WHERE run_id = ? ${ORDER}`)
        .all(runId) as unknown as DeliverableRow[];
      return rows.map(rowToRecord);
    },
  };
}
