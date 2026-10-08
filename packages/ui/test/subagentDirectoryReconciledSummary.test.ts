import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { subagentDirectoryRowSummary } from "../src/lib/subagentDirectoryRow.js";

/* 子智能体目录的「孤儿收敛」副文案：目录行有 summary 槽位，但 `subagentDirectory.summary.reconciled`
   一直没有消费方（审查发现项 P2-3 的死文案键）。本轮把它接上线：读面对「因收敛落 lost」的条目打
   标记，目录行据此补一句成因文案。本组用例锁定 ① 判据（哪一行、显示什么、与真实 summary 的优先
   关系）② 目录行接线（整段交给纯函数、只渲染结果）③ 文案键在场。

   ui 包没有渲染测试设施（本项目既定做法，见 squadRunsDirectorySection.test.ts），
   所以用「纯函数 + 结构守卫」两条腿。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 记录翻译调用，断言「显示了哪个键」（而不是把文案文本抄进测试当期望）。 */
function recordingFormatMessage(): { ids: string[]; formatMessage: (id: string) => string } {
  const ids: string[] = [];
  return {
    ids,
    formatMessage: (id: string) => {
      ids.push(id);
      return `i18n:${id}`;
    },
  };
}

test("副文案：收敛落 lost 的条目（无自身 summary）⇒ 成因文案", () => {
  const { ids, formatMessage } = recordingFormatMessage();
  assert.equal(
    subagentDirectoryRowSummary({ reconciled: true }, formatMessage),
    "i18n:subagentDirectory.summary.reconciled",
  );
  assert.deepEqual(ids, ["subagentDirectory.summary.reconciled"]);
});

test("副文案：其它条目不给副文案（非收敛 / 未标记 / 标记为假）", () => {
  const formatMessage = () => {
    throw new Error("不该为这些条目取文案");
  };
  assert.equal(subagentDirectoryRowSummary({}, formatMessage), undefined, "普通 ended/running 行");
  assert.equal(subagentDirectoryRowSummary({ reconciled: false }, formatMessage), undefined);
});

test("副文案：child 自己的 summary 优先（它是证据，成因文案只兜底）", () => {
  const { ids, formatMessage } = recordingFormatMessage();
  assert.equal(
    subagentDirectoryRowSummary(
      { reconciled: true, summary: "子 agent 的真实结果" },
      formatMessage,
    ),
    "子 agent 的真实结果",
  );
  assert.deepEqual(ids, [], "有真实 summary 时不该再取成因文案");
});

// 变异（M1）：把 `const summary = subagentDirectoryRowSummary(item, …)` 换回 `item.summary`
// ⇒ 第一条断言必红（收敛行不再有成因文案，死键复活）。
test("守卫｜目录行的副文案整段交给纯函数，渲染槽位只读结果", () => {
  const pane = readSource("app-shell/SubagentDirectorySidePane.tsx");

  assert.equal(
    (pane.match(/subagentDirectoryRowSummary\(/g) ?? []).length,
    1,
    "判据只能问纯函数一次（在组件里内联 status === 'lost' 就是第二判据）",
  );
  assert.match(
    pane,
    /const summary = subagentDirectoryRowSummary\(item,/,
    "副文案必须整段来自纯函数（不得退回 `item.summary` 的裸渲染）",
  );
  assert.equal(
    (pane.match(/\{summary \? \(/g) ?? []).length,
    1,
    "渲染槽位只该有一处（抄第二处 = 同一语义两份实现）",
  );
  assert.ok(
    !pane.includes("{item.summary ? ("),
    "渲染槽位不许直接读 item.summary（那样收敛行的成因文案永远不出现）",
  );
});

test("i18n：成因文案两语在场（不再是只写不用的死键）", () => {
  assert.equal(zhCN["subagentDirectory.summary.reconciled"], "运行时已退出，结果未知");
  assert.equal(enUS["subagentDirectory.summary.reconciled"], "Runtime exited, result unknown");
});
