import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSquadService } from "../src/teams/squadService.js";
import { readSquad, resolveSquadDefinitionRoot, writeSquad } from "../src/teams/squadStorage.js";
import type { Squad } from "@zcode/shared";

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  return createSquadService({
    root: join(ws, ".zcode", "squad", "squads"),
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
}

/** 一份除 id 外全部合法的 squad：用于直接打存储层（服务层不暴露写坏 id 的入口）。 */
function validSquad(id: string): Squad {
  return {
    id,
    name: "网关组",
    leaderAgentId: "ta_lead",
    members: [{ agentId: "ta_lead", role: "leader" }],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
    enabled: true,
  };
}

test("create 把 leader 并入 members 并标 role=leader", () => {
  const svc = setup();
  // 计划里这条的 create 漏传 instructions，与下一条「缺必填槽位必须抛错」直接矛盾
  // （同一份入参不能既合法又该抛错）。这里补上必填槽位，让它只验证本条真正要验的事：
  // leader 被并入名册且排在首位、role 标成 leader，普通队员不带 role。
  const s = svc.create({
    name: "网关组",
    leaderAgentId: "ta_lead",
    members: ["ta_a"],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.deepEqual(
    s.members.map((m) => [m.agentId, m.role]),
    [
      ["ta_lead", "leader"],
      ["ta_a", undefined],
    ],
  );
});

// 缺必填槽位不得被静默接受：队长没有终止条件就会一直派。
test("create 缺收手条件/轮次上限则抛错", () => {
  const svc = setup();
  assert.throws(
    () => svc.create({ name: "x", leaderAgentId: "ta_lead", members: [] }),
    /stopCondition|maxRounds/,
  );
});

// ⑤刀剩余半边（矩阵裁定#2：归档可恢复，与智能体同口径）。
test("归档后可恢复（restore 清 archivedAt；未知 id 响亮抛）", () => {
  const svc = setup();
  const s0 = svc.create({
    name: "sq",
    leaderAgentId: "ta-1",
    members: ["ta-1"],
    instructions: { stopCondition: "x", maxRounds: "3" },
  });
  svc.archive(s0.id);
  assert.ok(svc.get(s0.id)?.archivedAt !== undefined);
  svc.restore(s0.id);
  const restored = svc.get(s0.id)!;
  assert.equal(restored.archivedAt, undefined, "恢复 = 清归档时间戳（花名册与指令保留）");
  assert.equal(restored.name, "sq");
  svc.restore(s0.id); // 幂等 no-op
  assert.equal(svc.get(s0.id)?.archivedAt, undefined);
  assert.throws(() => svc.restore("nope"), /不存在/);
});

test("归档写 archivedAt 而非删除，且 list 仍含它", () => {
  const svc = setup();
  const s = svc.create({
    name: "网关组",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
  });
  svc.archive(s.id);
  assert.ok(svc.get(s.id)?.archivedAt !== undefined);
  assert.ok(svc.list().some((x) => x.id === s.id));
});

test("update 不改变 id", () => {
  const svc = setup();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const updated = svc.update(s.id, { name: "b" });
  assert.equal(updated.id, s.id);
  assert.equal(updated.name, "b");
});

// ---- 以下为 Step 5 穷举清单的补充覆盖 ----

// 定义根必须落在 <ws>/.zcode/squad/squads：与现有 <ws>/.zcode/agents 无前缀包含关系，
// 删掉整棵 .zcode/squad 不会碰到现有 subagent。
test("定义根落在 .zcode/squad/squads，且不含 .zcode/agents", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  assert.ok(resolveSquadDefinitionRoot(ws).endsWith(join(".zcode", "squad", "squads")));
  assert.equal(resolveSquadDefinitionRoot(ws).includes(join(".zcode", "agents")), false);
});

// 目录尚不存在时 list 必须是空列表而不是抛错：首次进入「小队」界面时目录还没建。
test("首次 create 前 list 返回空列表", () => {
  const svc = setup();
  assert.deepEqual(svc.list(), []);
});

// 未知 id 是「没有这个小队」，不是错误；但 update/archive 改不到目标必须显式报错，
// 否则界面会以为改成功了。
test("未知 id：get 返回 null，update/archive 抛错", () => {
  const svc = setup();
  assert.equal(svc.get("nope"), null);
  assert.throws(() => svc.update("nope", { name: "x" }), /不存在/);
  assert.throws(() => svc.archive("nope"), /不存在/);
});

// 重复归档只该保留第一次的时间戳：它记的是「何时离开在用名单」，重复点击不该把它推后。
test("重复归档幂等，保留原时间戳", () => {
  const svc = setup();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const first = svc.archive(s.id).archivedAt;
  const second = svc.archive(s.id).archivedAt;
  assert.equal(second, first);
});

// 一个坏文件只该丢掉它自己：手改坏的定义若让整份列表崩，用户将看不到任何小队。
test("list 跳过无法解析的文件，其余小队照常返回", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadDefinitionRoot(ws);
  const svc = createSquadService({
    root,
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
  const s = svc.create({
    name: "好的",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ta_broken.json"), "{ 不是合法 JSON");
  assert.deepEqual(
    svc.list().map((x) => x.id),
    [s.id],
  );
});

// P0 的 teamAgentStorage 用 `${id}.json` 拼路径而未约束 id 为单一目录段，留下 `..` 逃逸隐患。
// 这里必须一开始就把 id 限死为单一路径段：`../x`、`a/b`、空串都不能通过。
test("id 含路径分隔符或为 .. / 空串时被拒（读写两路）", () => {
  const svc = setup();
  for (const bad of ["..", "../evil", "a/b", "", "a\\b"]) {
    assert.throws(() => svc.get(bad), /单一路径段/, `get(${JSON.stringify(bad)}) 应被拒`);
    assert.throws(
      () => svc.update(bad, { name: "x" }),
      /单一路径段/,
      `update(${JSON.stringify(bad)}) 应被拒`,
    );
    assert.throws(() => svc.archive(bad), /单一路径段/, `archive(${JSON.stringify(bad)}) 应被拒`);
  }
  // 写路径同样要拦：服务层的 create 用随机 uuid，只有直接打存储层才能喂进坏 id。
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadDefinitionRoot(ws);
  assert.throws(() => writeSquad(root, validSquad("../evil")), /单一路径段/);
  assert.throws(() => readSquad(root, "../evil"), /单一路径段/);
});

// 承重：真的尝试逃逸一次，确认既被拒、也没有在定义根之外落下任何文件。
// `../../evil` 若被直接拼接，落点会是 <ws>/.zcode/evil.json（定义根的上一级）。
test("逃逸尝试被拒且不会在定义根之外写出文件", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadDefinitionRoot(ws);
  assert.throws(() => writeSquad(root, validSquad("../../evil")), /单一路径段/);
  assert.equal(existsSync(join(ws, ".zcode", "evil.json")), false);
  assert.equal(existsSync(join(ws, "evil.json")), false);
});

// 非队长的重复队员仍必须被拒：过滤只对 leader 生效，不能顺手把重复也静默去重，
// 否则花名册与派单会出现两份、run 记账与记忆都会串。
test("非队长 agentId 重复仍被拒", () => {
  const svc = setup();
  assert.throws(
    () =>
      svc.create({
        name: "a",
        leaderAgentId: "ta_lead",
        members: ["ta_x", "ta_x"],
        instructions: { stopCondition: "s", maxRounds: "1" },
      }),
    /重复/,
  );
});

// update 合并后必须**重新校验**：否则可以借 update 把必填槽位抹掉，绕过 create 的闸。
test("update 把 instructions 改成缺必填槽位会被拒", () => {
  const svc = setup();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.throws(
    () => svc.update(s.id, { instructions: { goal: "只填目标" } }),
    /stopCondition|maxRounds/,
  );
});

// 「leader 自动作为成员」在入参已把 leader 列进 members 时也必须成立：
// 这是最自然的输入（「A 当队长，A/B/C 是队员」），不该反而撞上「agentId 重复」。
test("入参 members 已含 leader 时不产生重复队员", () => {
  const svc = setup();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_a",
    members: ["ta_a", "ta_b"],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.deepEqual(
    s.members.map((m) => [m.agentId, m.role]),
    [
      ["ta_a", "leader"],
      ["ta_b", undefined],
    ],
  );
});

// id 不由 name 派生：同名小队必须拿到不同 id，否则改名/重建会互相覆盖。
test("同名 create 生成不同 id", () => {
  const svc = setup();
  const a = svc.create({
    name: "同名",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const b = svc.create({
    name: "同名",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.notEqual(a.id, b.id);
});

// 落盘内容与文件名 id 必须一致：list 以文件名为键、read 以内容为键，不一致会让两条路径指错小队。
test("文件名与内容 id 不一致时 read 抛错", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadDefinitionRoot(ws);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ta_x.json"), JSON.stringify(validSquad("ta_y")));
  assert.throws(() => readSquad(root, "ta_x"), /不一致/);
});

// 删除整个实验命名空间不应牵连现有 subagent 目录（决策 C3 的承重证明）。
test("删掉整个 .zcode/squad 后现有 .zcode/agents 定义仍在", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const legacyAgentFile = join(ws, ".zcode", "agents", "legacy.md");
  mkdirSync(dirname(legacyAgentFile), { recursive: true });
  writeFileSync(legacyAgentFile, "# 现有 subagent\n");
  const svc = createSquadService({
    root: resolveSquadDefinitionRoot(ws),
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
  svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  rmSync(join(ws, ".zcode", "squad"), { recursive: true, force: true });
  assert.equal(existsSync(legacyAgentFile), true);
});

// 小队定义只写在 <ws>/.zcode/squad/ 下：写完一份定义，除了 squads 目录外不应多出别的目录。
test("小队定义只落在 .zcode/squad/squads 下", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const svc = createSquadService({
    root: resolveSquadDefinitionRoot(ws),
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
  svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  assert.deepEqual(readdirSync(join(ws, ".zcode", "squad")), ["squads"]);
});

// ---- updateRoster（2026-10-03 加法：一级入口「小队」的名册编辑）----

/** 同 setup()，但把定义根一并交出来：`updateRoster` 的几条用例要直接读盘 / 打存储层。 */
function setupWithRoot() {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = join(ws, ".zcode", "squad", "squads");
  const svc = createSquadService({
    root,
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
  return { svc, root };
}

// 改名**不得**重建名册：重建从零拼，非队长的 `role` 标签会静默丢掉。
// 今天没有别的入口设非队长 role，但「今天没有」不是「永远没有」——直接打存储层注入一份带标签的
// 名册，让「重建一旦发生就会咬」这条断言是承重的。
test("updateRoster：只改名字 ⇒ members 逐字节未动（不重建，非队长的 role 标签保住）", () => {
  const { svc, root } = setupWithRoot();
  const created = svc.create({
    name: "网关组",
    leaderAgentId: "ta_lead",
    members: ["ta_x"],
    instructions: { stopCondition: "收工", maxRounds: "5" },
  });
  const before = writeSquad(root, {
    ...created,
    members: [
      { agentId: "ta_lead", role: "leader" },
      { agentId: "ta_x", role: "reviewer" },
    ],
  });

  const updated = svc.updateRoster(created.id, { name: "改过的名字" });

  assert.equal(updated.name, "改过的名字");
  assert.deepEqual(
    updated.members,
    before.members,
    "只改名字时 members 必须逐字节未动（重建是有损的）",
  );
  assert.deepEqual(updated.instructions, before.instructions);
  assert.equal(updated.leaderAgentId, before.leaderAgentId);
  assert.equal(updated.enabled, before.enabled);
  assert.equal(updated.archivedAt, undefined);
  // 读盘：盘上那份也一样（保住的不是返回值的内存副本）。
  assert.deepEqual(svc.get(created.id), updated);
});

// 单独换队长：新队长置首标 leader，旧队长回落到普通队员（composeMembers 的过滤让它不重复）。
test("updateRoster：单独换 leaderAgentId ⇒ 新队长在 members 首位且 role=leader，旧队长仍在名册无重复", () => {
  const { svc } = setupWithRoot();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: ["ta_x"],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });

  const updated = svc.updateRoster(s.id, { leaderAgentId: "ta_x" });

  assert.equal(updated.leaderAgentId, "ta_x");
  assert.deepEqual(
    updated.members.map((member) => [member.agentId, member.role]),
    [
      ["ta_x", "leader"],
      ["ta_lead", undefined],
    ],
    "新队长置首并标 leader、旧队长回落到普通队员（与 create 同一条组装规则）",
  );
  const ids = updated.members.map((member) => member.agentId);
  assert.equal(new Set(ids).size, ids.length, "换队长不得造成重复队员");
});

// 重复队员不得被静默去重（与 create 同一条闸：validateSquad 拦下）。
test("updateRoster：members 含重复 agentId ⇒ 响亮抛（不得静默去重），盘上不动", () => {
  const { svc } = setupWithRoot();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: ["ta_x"],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const before = svc.get(s.id);

  assert.throws(
    () => svc.updateRoster(s.id, { members: ["ta_x", "ta_x"] }),
    /重复/,
    "重复队员会让派单与记账出现两份，必须响亮拒绝",
  );
  assert.deepEqual(svc.get(s.id), before, "被拒的补丁一个字节都不该落盘");
});

// instructions 逐槽合并：没给的槽位（本轮界面只收 2 个，其余 6 个常常是历史填的）必须原样保留。
test("updateRoster：instructions 只给 goal ⇒ 其余槽位原样保留；清空必填槽位 ⇒ 响亮抛", () => {
  const { svc } = setupWithRoot();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "收工", maxRounds: "5", reporting: "日报" },
  });

  const updated = svc.updateRoster(s.id, { instructions: { goal: "只填目标" } });
  assert.equal(updated.instructions.goal, "只填目标");
  assert.equal(
    updated.instructions.stopCondition,
    "收工",
    "未提供的槽位原样保留（整包替换会静默清掉）",
  );
  assert.equal(updated.instructions.maxRounds, "5");
  assert.equal(updated.instructions.reporting, "日报");

  assert.throws(
    () => svc.updateRoster(s.id, { instructions: { stopCondition: "   " } }),
    /stopCondition/,
    "把必填槽位清成空白必须被 validateSquad 响亮拒绝",
  );
  assert.equal(svc.get(s.id)?.instructions.stopCondition, "收工", "被拒的补丁不得落盘");
});

// 白名单是**运行期**的承重墙：patch 多带 enabled / archivedAt 时不得被展开写进盘里。
test("updateRoster：白名单承重 —— patch 多带的 enabled/archivedAt 被忽略（读盘断言）", () => {
  const { svc } = setupWithRoot();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });

  // 绕过类型限制模拟「调用方透传了运行时多出来的键」（反序列化载荷 / 手写对象）。
  const hostilePatch = { name: "改名", enabled: false, archivedAt: 123 } as never;
  const updated = svc.updateRoster(s.id, hostilePatch);
  assert.equal(updated.name, "改名", "白名单内的字段照常写入");
  const onDisk = svc.get(s.id);
  assert.ok(onDisk);
  assert.equal(onDisk.enabled, true, "enabled 必须原样保留（它有自己入口）");
  assert.equal(onDisk.archivedAt, undefined, "archivedAt 必须原样保留（它有自己入口）");

  // 已归档的小队改名也不得「复活」：归档状态逐字保留。
  const archived = svc.archive(s.id);
  const renamed = svc.updateRoster(s.id, { name: "归档后改名" });
  assert.equal(renamed.name, "归档后改名");
  assert.equal(renamed.archivedAt, archived.archivedAt);
});

// 空 patch（全 undefined）⇒ 返回原实体、**不重写盘**（重复点「保存」不该产生一次内容相同的重写）。
test("updateRoster：空 patch ⇒ 返回原实体、内容与 mtime 都不变", () => {
  const { svc, root } = setupWithRoot();
  const s = svc.create({
    name: "a",
    leaderAgentId: "ta_lead",
    members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const filePath = join(root, `${s.id}.json`);
  const contentBefore = readFileSync(filePath, "utf8");
  const mtimeBefore = statSync(filePath).mtimeMs;

  const returned = svc.updateRoster(s.id, { name: undefined, instructions: undefined });

  assert.deepEqual(returned, svc.get(s.id), "返回读到的原实体");
  assert.equal(readFileSync(filePath, "utf8"), contentBefore, "空 patch 不得产生任何写入");
  assert.equal(statSync(filePath).mtimeMs, mtimeBefore, "mtime 也不得变（真的没有写盘）");
});

// id 不存在 ⇒ 响亮抛：静默 no-op 会让界面以为改成功了。
test("updateRoster：id 不存在 ⇒ 响亮抛", () => {
  const { svc } = setupWithRoot();
  assert.throws(() => svc.updateRoster("nope", { name: "x" }), /小队不存在：nope/);
  assert.throws(() => svc.updateRoster("nope", {}), /小队不存在：nope/);
});
