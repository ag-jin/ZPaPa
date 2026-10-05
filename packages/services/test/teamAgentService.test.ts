import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamAgentService } from "../src/teams/teamAgentService.js";

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  return createTeamAgentService({ root: join(ws, ".zcode", "squad", "agents") });
}

test("预填只拷贝字段，不建立引用", () => {
  const svc = setup();
  const source = {
    id: "user:user:reviewer", name: "审查者", description: "d", systemPrompt: "sp",
    path: "/tmp/x.md", scope: "user", source: "user", enabled: true,
    modelSelection: { providerId: "p", modelId: "m" },
  } as never;
  const draft = svc.prefillFrom(source);
  assert.equal(draft.name, "审查者");
  assert.equal(draft.systemPrompt, "sp");
  // 预填结果里不得残留来源的 id / path，否则会形成隐式引用。
  assert.equal("id" in draft, false);
  assert.equal("path" in draft, false);
  assert.equal("modelSelection" in draft, true);
});

test("新建后可归档（归档而非硬删）", () => {
  const svc = setup();
  const a = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });
  svc.archive(a.id);
  assert.ok(svc.list().some((x) => x.id === a.id && x.archivedAt !== undefined));
});

test("启停开关生效", () => {
  const svc = setup();
  const a = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });
  svc.setEnabled(a.id, false);
  assert.equal(svc.get(a.id)?.enabled, false);
});

// ---------- maxConcurrentRuns（C1）：字段透传 + 编辑白名单 ----------

test("create 省略 maxConcurrentRuns ⇒ 盘上无该键（存量零改写）；显式 10 ⇒ 读回 10", () => {
  const svc = setup();
  const omitted = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });
  // 缺省不落盘：读数方经 resolve 拿 6，盘上缺键让「未设置」与「显式 6」可区分。
  assert.equal("maxConcurrentRuns" in (svc.get(omitted.id) ?? {}), false);
  const explicit = svc.create({
    name: "b", systemPrompt: "s", memoryScope: "project", maxConcurrentRuns: 10,
  });
  assert.equal(svc.get(explicit.id)?.maxConcurrentRuns, 10);
});

test("update 白名单含 maxConcurrentRuns；白名单外字段（enabled/archivedAt）原样保留", () => {
  const svc = setup();
  const a = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project", maxConcurrentRuns: 2 });
  const updated = svc.update(a.id, { maxConcurrentRuns: 5 });
  assert.equal(updated.maxConcurrentRuns, 5);
  // 运行期越界键不得生效：patch 对象多带 enabled/archivedAt（反序列化载荷场景），
  // 逐字段合并必须忽略它们——「改并发上限」不得顺带复活/停用智能体。
  const smuggled = svc.update(a.id, {
    name: "a2",
    enabled: false,
    archivedAt: 123,
  } as never);
  assert.equal(smuggled.enabled, true, "update 不得改 enabled（入口是 setEnabled）");
  assert.equal(smuggled.archivedAt, undefined, "update 不得写 archivedAt（入口是 archive）");
  assert.equal(smuggled.name, "a2", "白名单内字段正常生效");
});
