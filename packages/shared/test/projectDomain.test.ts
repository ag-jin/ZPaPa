import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_STATUS_DEFAULT,
  PROJECT_STATUS_KEYS,
  isProjectShortCode,
  projectShortCodeErrorMessage,
  projectStatusErrorMessage,
  resolveProjectShortCode,
  resolveProjectStatus,
} from "../src/project.js";
import { formatWorkItemIdentifier } from "../src/work-item.js";

/* 工作项**编号显示**的纯函数（R-P1 服务面轮；放 shared 的单一来源）。

   形态（用户裁定「编号换项目短码」+ v1 取舍「序号语义不动」）：
   · 有前缀（项目短码快照）⇒ `{短码}-{序号}`（multica 形态 `MUL-123`：multica 在读取时拼
     `issue_prefix + "-" + number`，见 `server/internal/handler/issue.go:478-479`）；
   · 无前缀 ⇒ `#{序号}`（保持本仓既有 `#N` 形态，不因项目维度上线而改既有工作项的编号）；
   · 序号缺失（存量行 / 未设置）⇒ `null`：调用方据此**整块不渲染**（空串是噪音，与「未设置」不是同一件事）。

   本函数是纯函数、无 i18n、不抛：坏前缀（手改库 / 跨版本残留）按「无前缀」呈现，不把渲染
   变成异常路径。 */

test("编号显示：有前缀 ⇒ 短码-序号；无前缀 ⇒ #序号；序号缺失 ⇒ null", () => {
  assert.equal(
    formatWorkItemIdentifier({ prefix: "PLT", seq: 12 }),
    "PLT-12",
    "有项目短码快照时 = {短码}-{序号}（multica 的 MUL-123 形态）",
  );
  assert.equal(
    formatWorkItemIdentifier({ prefix: null, seq: 12 }),
    "#12",
    "无项目 = #序号（既有 #N 形态逐字保持）",
  );
  assert.equal(
    formatWorkItemIdentifier({ seq: 7 }),
    "#7",
    "前缀字段缺席与 null 同义（未绑定项目）",
  );
  assert.equal(formatWorkItemIdentifier({ prefix: "PLT", seq: 0 }), "PLT-0", "序号按原值拼接");
  assert.equal(
    formatWorkItemIdentifier({ prefix: "PLT", seq: null }),
    null,
    "没有序号就没有编号文本（返回 null 而不是空串）",
  );
  assert.equal(formatWorkItemIdentifier({}), null, "序号缺席 = 未设置 ⇒ null");
  // 坏前缀（手改库 / 跨版本残留）按「无前缀」呈现：渲染不抛，也不产出 "-12" 这种残形。
  assert.equal(formatWorkItemIdentifier({ prefix: "", seq: 3 }), "#3", "空串前缀 = 无前缀");
});

test("短码闭集：2-8 位大写字母数字才合法；小写/短长/连字符一律 invalid（响亮，不静默规整）", () => {
  assert.equal(isProjectShortCode("AB"), true);
  assert.equal(isProjectShortCode("ABCD1234"), true);
  assert.equal(isProjectShortCode("A"), false);
  assert.equal(isProjectShortCode("ABCDEFGHI"), false);
  assert.equal(isProjectShortCode("abc"), false, "小写不是合法短码（不做静默大写化）");
  assert.equal(isProjectShortCode("AB-1"), false);
  assert.equal(isProjectShortCode(" AB"), false, "空白不做静默裁剪");
  assert.deepEqual(resolveProjectShortCode("PLT"), { kind: "ok", shortCode: "PLT" });
  assert.deepEqual(resolveProjectShortCode("plt"), { kind: "invalid", value: "plt" });
  assert.deepEqual(resolveProjectShortCode(undefined), { kind: "invalid", value: "undefined" });
  assert.deepEqual(resolveProjectShortCode(null), { kind: "invalid", value: "null" });
  assert.deepEqual(resolveProjectShortCode(42), { kind: "invalid", value: "42" });
  const message = projectShortCodeErrorMessage({ kind: "invalid", value: "plt" });
  assert.match(message, /plt/, "错误文本带原值");
  assert.match(message, /大写/, "错误文本说清形状（UI 直接展示这句话）");
});

test("项目 status 闭集：五档（缺省 planned）；闭集外与 null/undefined 一律 invalid（写入口响亮拒）", () => {
  assert.deepEqual(PROJECT_STATUS_KEYS, [
    "planned",
    "in_progress",
    "paused",
    "completed",
    "cancelled",
  ]);
  assert.equal(PROJECT_STATUS_DEFAULT, "planned");
  for (const key of PROJECT_STATUS_KEYS)
    assert.deepEqual(resolveProjectStatus(key), { kind: "ok", status: key });
  assert.deepEqual(resolveProjectStatus("archived"), { kind: "invalid", value: "archived" });
  assert.deepEqual(resolveProjectStatus(undefined), { kind: "invalid", value: "undefined" });
  assert.deepEqual(resolveProjectStatus(null), { kind: "invalid", value: "null" });
  assert.match(
    projectStatusErrorMessage({ kind: "invalid", value: "archived" }),
    /planned/,
    "错误文本列出闭集（写入口与 UI 共用同一句话）",
  );
});
