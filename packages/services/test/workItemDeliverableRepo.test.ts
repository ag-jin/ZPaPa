import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createWorkItemDeliverableRepo,
  resolveDeliverableContentRoot,
  type RegisterDeliverableInput,
} from "../src/workitem/workItemDeliverableRepo.js";

/* #7 交付物存储面（D1a）：`work_item_deliverables` 表的唯一读写口（迁移 0016）。
   本文件只测**存储面契约**：两型注册（diff 正文落盘 / link 带 URL）、dedupKey 幂等、
   读写双闸（kind 闭集）、正文文件命名与路径逃逸防护、读回三态（正文可读/缺失/外部）。
   捕获函数（run 级/批级 diff 的 git 侧）在 workItemDeliverableCapture.test.ts 单测。 */

/** 固定 diff 正文：sha 与字节数是**外部算好的字面量**（`printf … | shasum -a 256`），
    不在测试里用实现同一路径重算。 */
const DIFF_TEXT = "diff --git a/a.txt b/a.txt\n+1\n";
const DIFF_SHA = "ac78fd9cd4177b2bbbd907139ca4383b36483be9d00880cb7735f9fa6a69f3e9";
const DIFF_BYTES = 30;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "deliv-"));
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { root, db, repo: createWorkItemDeliverableRepo(db) };
}

const SYSTEM = { kind: "system" as const, id: "squad-runtime" };

function base(root: string) {
  return {
    id: "deliverable-run-1-diff",
    workspaceKey: "ws",
    workspacePath: root,
    workItemId: "wi-1",
    runId: "run-1",
    title: "squad/member/wi-1/agent-a",
    meta: { branch: "squad/member/wi-1/agent-a", base: "main", commitCount: 1 },
    actor: SYSTEM,
    dedupKey: "deliverable:run-1:diff",
    createdAt: 100,
  };
}

function diffInput(
  root: string,
  over: Partial<RegisterDeliverableInput> = {},
): RegisterDeliverableInput {
  return { ...base(root), kind: "diff", content: DIFF_TEXT, ...over } as RegisterDeliverableInput;
}

function linkInput(
  root: string,
  over: Partial<RegisterDeliverableInput> = {},
): RegisterDeliverableInput {
  return {
    ...base(root),
    id: "deliverable-link-1",
    runId: undefined,
    title: "PR #42",
    meta: {},
    actor: { kind: "human", id: "u-1" },
    dedupKey: "deliverable:link-1:registered",
    kind: "link",
    url: "https://example.com/pr/42",
    ...over,
  } as RegisterDeliverableInput;
}

test("register(diff)：正文落盘 <ws>/.zcode/squad/deliverables/<id>.diff，表行读回 sha/字节数对得上", () => {
  const { root, repo } = setup();
  try {
    const record = repo.register(diffInput(root));
    // 表行：两型判别字段与归因逐项落库。
    assert.equal(record.kind, "diff");
    assert.equal(record.id, "deliverable-run-1-diff");
    assert.equal(record.runId, "run-1");
    assert.equal(record.title, "squad/member/wi-1/agent-a");
    assert.deepEqual(record.meta, {
      branch: "squad/member/wi-1/agent-a",
      base: "main",
      commitCount: 1,
    });
    assert.deepEqual(record.actor, { kind: "system", id: "squad-runtime" });
    assert.equal(record.dedupKey, "deliverable:run-1:diff");
    assert.equal(record.createdAt, 100);
    // 正文引用 = **相对路径**（设计 §3.2：diff 存相对路径，link 存 URL）。
    assert.equal(record.contentRef, ".zcode/squad/deliverables/deliverable-run-1-diff.diff");
    // sha / 字节数 = 外部算好的字面量（防「实现自己算一遍自己验」）。
    assert.equal(record.contentSha, DIFF_SHA);
    assert.equal(record.contentSize, DIFF_BYTES);
    // 正文真的落到了盘上（内容逐字节相等）。
    const path = join(resolveDeliverableContentRoot(root), "deliverable-run-1-diff.diff");
    assert.equal(readFileSync(path, "utf8"), DIFF_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedupKey 幂等：同键重投返回既存行、不产生第二行、正文不重写（唯一索引是兜底）", () => {
  const { root, db, repo } = setup();
  try {
    const first = repo.register(diffInput(root));
    // 重投：同键、不同的 id/标题/正文/时间 —— 模拟「重放的第二次捕获」，键咬住即不得产生第二条。
    const retry = repo.register(
      diffInput(root, {
        id: "deliverable-replayed",
        title: "重放",
        meta: { replay: true },
        content: "diff --git a/b.txt b/b.txt\n+2\n",
        createdAt: 999,
      }),
    );
    assert.equal(retry.id, first.id, "同键重投返回既存行（不新建 id）");
    assert.equal(retry.title, first.title, "既存行的列不被改写（事实只增不改）");
    assert.equal(retry.createdAt, 100);
    assert.equal(retry.contentSha, DIFF_SHA, "sha 仍是首投那份");
    const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_deliverables").get() as {
      n: number;
    };
    assert.equal(count.n, 1, "同键只许一行");
    // 正文文件也**没有被第二次覆盖**：盘上仍是首投的 diff（写一次、不更新）。
    const path = join(resolveDeliverableContentRoot(root), `${first.id}.diff`);
    assert.equal(readFileSync(path, "utf8"), DIFF_TEXT);
    // 第二个 id 的正文文件根本没被建出来（重投连文件都不该落）。
    assert.equal(
      existsSync(join(resolveDeliverableContentRoot(root), "deliverable-replayed.diff")),
      false,
    );

    // 存储层兜底（跨连接并发下先查后插挡不住）：人为写重复 (workspace_key, dedup_key) ⇒ 唯一索引抛。
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO work_item_deliverables (id, workspace_key, workspace_path, work_item_id,
               run_id, kind, title, meta_json, content_ref, actor_kind, actor_id, dedup_key,
               created_at, updated_at)
             VALUES ('deliverable-dup', 'ws', ?, 'wi-1', NULL, 'diff', 'x', '{}', 'x.diff',
               'system', 'squad-runtime', ?, 1, 1)`,
          )
          .run(root, first.dedupKey),
      /UNIQUE/,
    );

    /* 结构性兜底（**变异存活暴露的测试缺口**）：上面那次「同键重投」被预读早退挡在前面，
       所以它证明不了写入语句本身是幂等的——跨连接并发（两个 Host 同投一条事实）时预读可能
       双双错过对方，那时把重复插入交给唯一索引才会「OR IGNORE 吞掉 / 裸 INSERT 响亮抛」。
       语句形态因此必须被钉住（源码扫描，同 `workItemCollaborationAppendOnly` 手法）。 */
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../src/workitem/workItemDeliverableRepo.ts",
      ),
      "utf8",
    );
    assert.match(
      source,
      /INSERT OR IGNORE INTO work_item_deliverables/,
      "幂等靠 OR IGNORE + 唯一索引（跨连接并发下裸 INSERT 会把一次重投变成响亮失败）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kind 闭集读写双闸：写入/读回非法值一律响亮抛；link 空 URL 拒写（不落坏事实）", () => {
  const { root, db, repo } = setup();
  try {
    // 写入闸：JS 调用方（或数据驱动路径）绕过 TS 判别联合把闭集外的 kind 递进来。
    assert.throws(
      () => repo.register({ ...diffInput(root), kind: "file" } as never),
      /kind/,
      "闭集外的 kind 必须响亮拒（v1 只有 diff|link）",
    );
    // link 的 url 是这条事实的**全部内容**：空 URL 记下来只是一条没人能用的死链。
    assert.throws(() => repo.register(linkInput(root, { url: "   " })), /url/i);

    // 读回闸：库里被写坏的一行 ⇒ get 抛（静默按默认处理会让「这条交付物到底是什么」无人知道）。
    repo.register(diffInput(root));
    db.prepare(
      "UPDATE work_item_deliverables SET kind = 'bogus' WHERE id = 'deliverable-run-1-diff'",
    ).run();
    assert.throws(() => repo.get("deliverable-run-1-diff"), /kind/);
    db.prepare(
      `UPDATE work_item_deliverables SET kind = 'diff', meta_json = '{bad'
       WHERE id = 'deliverable-run-1-diff'`,
    ).run();
    assert.throws(() => repo.get("deliverable-run-1-diff"), /JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("路径逃逸防护：id 含 ../ 或分隔符 ⇒ 零副作用拒写；被写坏的 content_ref 读回也拒", () => {
  const { root, db, repo } = setup();
  try {
    // id 会拼进正文文件名：`../evil` 这类 id 若放行，正文就写到实验命名空间之外。
    for (const id of ["../evil", "..", ".", "a/b", "a\\b", ""]) {
      assert.throws(
        () => repo.register(diffInput(root, { id, dedupKey: `d-${id}` })),
        /id/,
        `非法 id ${JSON.stringify(id)} 必须响亮拒`,
      );
    }
    // 零副作用：逃逸目标位置没有任何文件被建出来，库里也没有行（拒绝发生在写盘与写库之前）。
    assert.equal(existsSync(join(root, ".zcode", "squad", "evil.diff")), false);
    assert.equal(existsSync(join(root, ".zcode", "evil.diff")), false);
    assert.equal(existsSync(join(root, "evil.diff")), false);
    const empty = db.prepare("SELECT COUNT(*) AS n FROM work_item_deliverables").get() as {
      n: number;
    };
    assert.equal(empty.n, 0);

    // 读侧同闸：库里被写坏的一行（content_ref 越出正文根）不得变成一次越界读。
    repo.register(diffInput(root));
    db.prepare(
      `UPDATE work_item_deliverables SET content_ref = '.zcode/squad/../../outside.txt'
       WHERE id = 'deliverable-run-1-diff'`,
    ).run();
    assert.throws(() => repo.get("deliverable-run-1-diff"), /正文根/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3-1 单段闸对两型同口径：link 行的逃逸 id 同样零副作用拒写（D1 复验发现）", () => {
  const { root, db, repo } = setup();
  try {
    /* 复验发现（P3-1）：单段闸原先只在 diff 分支（`deliverableContentPath` 里）——link 行不落盘，
       于是 `../../escape` 这样的 id 能落库。id 是这张表的**主键与寻址面**（get(id) / 未来按 id 取数），
       放行它等于让「id 是单一路径段」这条不变量只在一条写入口上成立 —— 两条入口分叉，且不报错。 */
    for (const id of ["../evil", "..", ".", "a/b", "a\\b", ""]) {
      assert.throws(
        () => repo.register(linkInput(root, { id, dedupKey: `lk-${id}` })),
        /id/,
        `link 行的非法 id ${JSON.stringify(id)} 必须与 diff 同口径响亮拒`,
      );
    }
    // 零副作用：一条都没落库（拒绝发生在写库之前，而不是「写进去了然后读不回来」）。
    const count = db.prepare("SELECT COUNT(*) AS n FROM work_item_deliverables").get() as {
      n: number;
    };
    assert.equal(count.n, 0);
    // 合法 id 不受影响（闸只挡形态，不挡内容）。
    assert.equal(
      repo.register(linkInput(root, { id: "deliverable-link-ok" })).id,
      "deliverable-link-ok",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读回｜listByWorkItem（workspace 隔离 + created_at,id 序）与 listByRun（run 维度）", () => {
  const { root, repo } = setup();
  try {
    repo.register(diffInput(root, { id: "d-2", dedupKey: "dk-2", createdAt: 200 }));
    repo.register(diffInput(root, { id: "d-1", dedupKey: "dk-1", createdAt: 100 }));
    // 同工作项 id、不同 workspace：两条线不得串台（workspace_key 是第一维）。
    repo.register(
      diffInput(root, {
        id: "d-other",
        dedupKey: "dk-other",
        workspaceKey: "ws-2",
        runId: "run-other",
        createdAt: 50,
      }),
    );
    // 手动登记的 link 不挂 run（同一工作项里与 diff 混排：created_at 序）。
    repo.register(linkInput(root, { createdAt: 300 }));

    assert.deepEqual(
      repo.listByWorkItem("ws", "wi-1").map((r) => r.id),
      ["d-1", "d-2", "deliverable-link-1"],
      "created_at ASC, id ASC",
    );
    assert.deepEqual(
      repo.listByWorkItem("ws-2", "wi-1").map((r) => r.id),
      ["d-other"],
    );
    assert.deepEqual(repo.listByWorkItem("ws", "wi-none"), []);
    assert.deepEqual(
      repo.listByRun("run-1").map((r) => r.id),
      ["d-1", "d-2"],
    );
    assert.deepEqual(repo.listByRun("run-none"), []);
    assert.equal(
      repo.listByRun("run-1").some((r) => r.id === "deliverable-link-1"),
      false,
      "手动 link（runId NULL）不出现在任何 run 的清单里",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读回｜detail 三态：正文可读 / 文件缺失（不谎报、不重建）/ link 外部；未知 id 为 null", () => {
  const { root, repo } = setup();
  try {
    repo.register(diffInput(root));
    repo.register(linkInput(root));

    const diff = repo.get("deliverable-run-1-diff");
    assert.ok(diff);
    assert.deepEqual(diff.content, { presence: "file", text: DIFF_TEXT });
    const link = repo.get("deliverable-link-1");
    assert.ok(link);
    assert.deepEqual(link.content, { presence: "external", url: "https://example.com/pr/42" });
    assert.equal(repo.get("deliverable-none"), null, "没有这条是正常状态，不是错误");

    // 用户删掉 .zcode：元数据仍在库、正文读回标 missing —— 不抛、不重建、不谎报。
    rmSync(resolveDeliverableContentRoot(root), { recursive: true, force: true });
    const after = repo.get("deliverable-run-1-diff");
    assert.ok(after);
    assert.equal(after.record.contentSha, DIFF_SHA, "元数据一字不动");
    assert.equal(after.record.contentSize, DIFF_BYTES);
    assert.deepEqual(after.content, { presence: "missing" });
    assert.equal(
      existsSync(join(resolveDeliverableContentRoot(root), "deliverable-run-1-diff.diff")),
      false,
      "读回不重建正文文件",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("register(link)：content_ref = URL（runId/sha/字节数 NULL，不落盘）", () => {
  const { root, repo } = setup();
  try {
    const record = repo.register(linkInput(root));
    assert.equal(record.kind, "link");
    assert.equal(record.contentRef, "https://example.com/pr/42");
    assert.equal(record.contentSha, null, "link 的正文不在本地：sha 恒 NULL，不伪造");
    assert.equal(record.contentSize, null);
    assert.equal(record.runId, null, "手动登记挂工作项不挂 run");
    assert.deepEqual(record.actor, { kind: "human", id: "u-1" });
    assert.deepEqual(record.meta, {});
    // link 不写任何正文文件（正文在外部）。
    assert.equal(
      existsSync(join(resolveDeliverableContentRoot(root), "deliverable-link-1.diff")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
