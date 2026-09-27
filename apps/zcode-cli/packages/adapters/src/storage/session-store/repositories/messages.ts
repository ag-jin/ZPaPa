import type { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { decodeMessageRow, decodePartRow, partCreatedAt } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { MessageRow, PartRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 只补回旧版快照字段，不合并整个 JSON：递归 merge 会让已清空的 metadata/options 残留。
function preserveLegacyMembers(table: "message" | "part", keys: readonly string[]): string {
  return keys.reduce(
    (sql, key) =>
      `(select case when json_type(${table}.data, '$.${key}') is not null
      then json_set(previous.data, '$.${key}', json_extract(${table}.data, '$.${key}')) else previous.data end
      from (select ${sql} as data) as previous)`,
    "excluded.data",
  );
}

const MESSAGE_DATA_UPDATE = preserveLegacyMembers("message", [
  "model",
  "providerID",
  "modelID",
  "variant",
]);
const PART_DATA_UPDATE = preserveLegacyMembers("part", ["fromModel", "toModel", "model"]);

// on-conflict 的 sequence 规则：
// 同 scope 再保存必须原样保留现有 sequence——包括 NULL。coalesce(existing, excluded)
// 会把 NULL 历史行（迁移遗漏/旧版本二进制写入）在任何一次再保存时重排到队尾（excluded=max+1），
// assistant 完成后的二次 save 就足以触发，造成时间线漂移；NULL 由 0015 backfill 统一修复。
// 跨 scope 改绑（id 冲突但 session/message 不同，仅导入 upsert 场景）才取 excluded 的新 scope 队尾。
export async function saveMessage(
  db: DatabaseSync,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  const { id, sessionID, ...data } = input;
  // 冻结旧版协议 mapper 无条件读取 user.model；缺少整个对象会让正文也无法打开。
  // 只补必需对象；旧行的原 model 仍由冲突更新/复制逻辑保留，新版 Reader 不使用它。
  const storedData =
    input.role === "user"
      ? {
          ...data,
          model: input.modelSelection
            ? {
                providerID: input.modelSelection.providerId,
                modelID: input.modelSelection.modelId,
                ...(input.modelSelection.options?.reasoningLevel
                  ? { variant: input.modelSelection.options.reasoningLevel }
                  : {}),
              }
            : {},
        }
      : data;
  const timeCreated = input.time.created;
  const timeUpdated =
    input.role === "assistant" ? (input.time.completed ?? Date.now()) : timeCreated;

  db.prepare(
    `
      insert into message (id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = ?
        )
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        -- 旧字段是回滚快照，不能因新版 Reader 隐藏了它们而在普通更新时丢掉。
        data = case when message.session_id = excluded.session_id then ${MESSAGE_DATA_UPDATE} else excluded.data end,
        sequence = case
          when message.session_id = excluded.session_id then message.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    sessionID,
    timeCreated,
    timeUpdated,
    encodeJson(copyLegacyMembers(db, "message", storedData, copyFrom)),
    sessionID,
  );
  touchSession(db, sessionID, timeUpdated);
}

export async function removeMessage(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  db.prepare("delete from message where id = ? and session_id = ?").run(
    input.messageID,
    input.sessionID,
  );
}

export async function savePart(
  db: DatabaseSync,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  const { id, sessionID, messageID, ...data } = input;
  let storedData: Record<string, unknown> = data;
  if (input.type === "timeline" && input.timelineType === "model_change") {
    const { fromModel, toModel, ...part } = data as typeof input;
    // 冻结旧版 Reader 直接访问 toModel.providerID；只为这一个必需对象做最小兼容写入。
    // 当前 Reader 不读它，更新同一旧行时 SQL 保留原快照，不持续反向同步。
    const oldToModel = toModel
      ? {
          providerID: toModel.providerId,
          modelID: toModel.modelId,
          ...(toModel.options?.reasoningLevel ? { variant: toModel.options.reasoningLevel } : {}),
          label: toModel.label,
        }
      : {};
    storedData = {
      ...part,
      toModel: oldToModel,
      fromModelSelection: fromModel,
      toModelSelection: toModel,
    };
  } else if (input.type === "subtask") {
    const { model, ...part } = data as typeof input;
    storedData = { ...part, modelSelection: model };
  }
  const now = Date.now();

  db.prepare(
    `
      insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
      values (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = ?
        )
      )
      on conflict(id) do update set
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        time_updated = excluded.time_updated,
        data = case when part.message_id = excluded.message_id and part.session_id = excluded.session_id
          then ${PART_DATA_UPDATE} else excluded.data end,
        sequence = case
          when part.message_id = excluded.message_id and part.session_id = excluded.session_id
            then part.sequence
          else excluded.sequence
        end
      `,
  ).run(
    id,
    messageID,
    sessionID,
    partCreatedAt(input, now),
    now,
    encodeJson(copyLegacyMembers(db, "part", storedData, copyFrom)),
    messageID,
  );
  touchSession(db, sessionID, now);
}

function copyLegacyMembers(
  db: DatabaseSync,
  table: "message" | "part",
  data: Record<string, unknown>,
  source: Parameters<SessionStorePort["saveMessage"]>[1],
): Record<string, unknown> {
  if (!source) return data;
  // 复制只搬运存储快照；运行层不读取旧字段，也不能凭当前选择重建旧值。
  const row = db
    .prepare(`SELECT data FROM ${table} WHERE id=? AND session_id=?`)
    .get(source.id, source.sessionID);
  if (!row) throw new Error(`Storage copy source missing: ${table}/${source.id}`);
  const original = JSON.parse(String(row.data)) as Record<string, unknown>;
  const result = { ...data };
  const keys =
    table === "message"
      ? ["model", "providerID", "modelID", "variant"]
      : ["fromModel", "toModel", "model"];
  for (const key of keys) if (Object.hasOwn(original, key)) result[key] = original[key];
  return result;
}

export async function removePart(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  db.prepare("delete from part where id = ? and message_id = ? and session_id = ?").run(
    input.partID,
    input.messageID,
    input.sessionID,
  );
}

/**
 * 读取会话消息。
 *
 * `tailPartLimit` 可选：**只给最近 N 条消息装配 parts**，更早的消息返回空 parts。
 *
 * 为什么是「裁 parts 而不是裁 messages」：调用方（session snapshot）在读取后要跑
 * rewind 分支投影，那一步必须看到**完整消息序列**（它按 keptMessageIDs 在全量里
 * 建索引查分支），裁掉早期消息会让回退分支判定出错。但 parts 没有这个约束 ——
 * 只要窗口内消息的 parts 齐备，首屏就能正常渲染（更早内容的 parts 由后续
 * rows/range 分页拉取）。
 *
 * 实测收益（单会话 3137 条消息 / 14556 块 parts）：parts 是全量读取的主要成本
 * （209ms / 87%），限到尾部 60 条消息后只读 242 块（-98.3%）。
 */
export async function messages(
  db: DatabaseSync,
  input: { sessionID: SessionId; tailPartLimit?: number },
): Promise<MessageWithParts[]> {
  const messageRows = db
    .prepare(
      `
      select * from message
      where session_id = ?
      order by sequence is null, sequence, time_created, rowid
      `,
    )
    .all(input.sessionID) as unknown as MessageRow[];

  const tailPartLimit =
    typeof input.tailPartLimit === "number" &&
    Number.isFinite(input.tailPartLimit) &&
    input.tailPartLimit > 0
      ? Math.floor(input.tailPartLimit)
      : undefined;

  let partRows: PartRow[];
  if (tailPartLimit === undefined || tailPartLimit >= messageRows.length) {
    partRows = db
      .prepare(
        `
        select * from part
        where session_id = ?
        order by message_id, sequence is null, sequence, time_created, id
        `,
      )
      .all(input.sessionID) as unknown as PartRow[];
  } else {
    // 只给尾部窗口装配 parts。用子查询在 SQL 内定位，避免把几千个 id 传进 IN 子句。
    //
    // 排序陷阱：不能写成 `order by sequence is null, ... desc` —— 末尾的
    // desc 会同时作用于 `sequence is null` 这个排序键，把 null（即最早写入、
    // 尚无 sequence 的那批消息）翻到最前面，于是"取尾部"实际取到了最老的消息
    // （实测：DESC limit 3 返回的是 rowid 1/2/3 的最初三条，而非最新三条）。
    // 正确写法是让 null 仍排最后（`sequence is null` 显式升序），其余键降序。
    partRows = db
      .prepare(
        `
        select * from part
        where message_id in (
          select id from message
          where session_id = ?
          order by sequence is null, sequence desc, time_created desc, rowid desc
          limit ?
        )
        order by message_id, sequence is null, sequence, time_created, id
        `,
      )
      .all(input.sessionID, tailPartLimit) as unknown as PartRow[];
  }

  const partsByMessage = new Map<string, MessagePart[]>();

  for (const row of partRows) {
    const part = decodePartRow(row);
    const list = partsByMessage.get(row.message_id) ?? [];
    list.push(part);
    partsByMessage.set(row.message_id, list);
  }

  return messageRows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
}

export async function messageWithParts(
  db: DatabaseSync,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<MessageWithParts | null> {
  const messageRow = db
    .prepare("select * from message where id = ? and session_id = ?")
    .get(input.messageID, input.sessionID) as unknown as MessageRow | undefined;
  if (!messageRow) return null;

  const partRows = db
    .prepare(
      `
      select * from part
      where message_id = ? and session_id = ?
      order by sequence is null, sequence, time_created, id
      `,
    )
    .all(input.messageID, input.sessionID) as unknown as PartRow[];
  return {
    info: decodeMessageRow(messageRow),
    parts: partRows.map(decodePartRow),
  };
}
