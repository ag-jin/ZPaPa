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
