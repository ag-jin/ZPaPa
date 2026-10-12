// 「/grill compact 恢复：notes 在场即续跑」断言（卡 #207/A6）。
//
// 为什么这组用例承重：A5 把 `design/grill-notes.md` 的实时落盘约定注入 /grill 正文后，
// 文件在磁盘上活着（deliberation-v2/B-design-space.md：实时落，compact 免疫；compact/跨会话恢复
// 「强（文件在）」），但正文当时只写了「起占位」——一条**无条件**指令：compact/clear 后重跑
// 同一任务，模型会按正文再起一份占位，把要续跑的笔记覆盖掉（#206 三绿评审 SP-2，owner=A6）。
// 恢复力因此不在文件侧，而在**正文是否教了识别与续跑**：模型读到 exists→read/continue 才不
// 会从头再来。本文件把这条续跑契约钉在 A5 同款缝上（resolveZCodeBuiltinPromptCommand 展开）。
//
// 独立真源：卡文 #207（「compact/clear 后 grill-notes 仍在、/grill 可识别既有笔记续跑
// （不从头再来）」；验收「compact→续跑从已定决策继续（断言）」）；#206 三绿评审 SP-2（条件化
// exists→read and continue）与 SP-3（slug 撞名避让一句+一断言）；落点与三节语义沿用 A5 契约
// （`.zcode/<任务ID>/design/grill-notes.md`，A-facts.md U7）。断言取正文独有短语（不复用别处
// 已出现的词），突变删句即红。

import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

// 恢复判据真源：卡文 #207「/grill 可识别既有笔记续跑（不从头再来）」。compact/clear 之后会话
// 记忆被压掉或清空，唯一残存的事实是磁盘上的 `design/grill-notes.md`；正文必须把「已存在」
// 变成显式分支：先读全三节恢复上下文 → 从 `## 已定决策` 继续 → `## 待定问题` 才是新一轮前沿，
// 且不重问已定问题、不从头再来。缺任一句，模型都有空间重开一场拷问（SP-2 的失败面）。
test("/grill 展开：notes 已存在 ⇒ 续跑恢复（先读三节、从已定决策继续、待定问题=新一轮前沿）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /already exists/,
    "恢复判据 = notes 已在（compact/clear 后重跑 /grill 的现实形态；卡文「可识别既有笔记」）",
  );
  assert.match(
    expanded,
    /do NOT overwrite it/,
    "既有笔记禁止覆写（SP-2：无条件起占位会覆掉 compact 后要续跑的记录）",
  );
  assert.match(
    expanded,
    /all three sections/,
    "先读三节（卡文「读 notes 恢复上下文」= 已定决策/待定问题/下一步三元组）",
  );
  assert.match(
    expanded,
    /continue\s+from the settled decisions/,
    "从『已定决策』继续（验收：compact→续跑从已定决策继续）",
  );
  assert.match(
    expanded,
    /treat `## 待定问题` as the\s+frontier/,
    "『待定问题』= 新一轮拷问前沿（恢复后接着问，不从头问）",
  );
  assert.match(
    expanded,
    /Never re-ask/,
    "不重复已定问题（恢复纪律；卡文「不从头再来」在提问面的落地）",
  );
  assert.match(
    expanded,
    /never restart the\s+interview from scratch/,
    "不从头再来（卡文本体目标：续跑而非重开）",
  );
});

// 条件化另一半真源：#206 三绿评审 SP-2 原文——「正文『起占位』是**无条件**指令：compact 后同
// slug 再跑 /grill 可能覆盖要续跑的笔记」。修法是条件化：已存在→读它续跑；不存在→才起占位骨架。
// 本用例钉「不存在」分支的限定词与骨架形态：删掉限定词（回到无条件起占位）即红。
test("/grill 展开：起占位条件化——仅当 notes 不存在才起骨架（存在分支在前，骨架不被本卡改动）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /Only when `design\/grill-notes\.md` does not exist yet/,
    "起占位的限定词=Only when 不存在（无条件起占位=compact 后覆写续跑笔记，SP-2 本旨）",
  );
  assert.ok(
    expanded.indexOf("already exists") < expanded.indexOf("does not exist yet"),
    "分支顺序=先存在（续跑）后不存在（起占位）：读起来是 if/else 而非两个并列动作",
  );
  assert.match(expanded, /placeholder/, "不存在分支仍起占位（A5 骨架约定保留）");
  for (const section of ["## 已定决策", "## 待定问题", "## 下一步"]) {
    assert.ok(expanded.includes(section), `占位骨架分节「${section}」仍在（条件化不删产物形态）`);
  }
});

// 撞名避让真源：#206 三绿评审 SP-3（终裁「裁给 A6 同段一次改完」，修法=1 句+1 断言）——
// 失败面四类实测：slug=design/archive ⇒ 任务目录与既有结构同名（后续稿静默不入扫描面）；
// slug=既有任务 id ⇒ 跨任务污染（笔记写进别人的 design/）；slug=worktrees ⇒ 违反收纳纪律；
// slug=board ⇒ 板上多出假任务。slug 是目录名且确认前零落盘，所以避让必须在定名时判。
test("/grill 展开：slug 撞名避让——与 .zcode/ 既有条目或既有任务 id 撞名 ⇒ 换名并向用户说明", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /collides/,
    "撞名判据成文（SP-3：slug 直接决定任务目录名，重名即写进既有结构）",
  );
  assert.match(
    expanded,
    /`board\/`, `plans\/`,\s+`design\/`, `archive\/`, `worktrees\/`/,
    "既有条目点名五项（评审实测失败面清单：board/plans/design/archive/worktrees）",
  );
  assert.match(
    expanded,
    /existing task id/,
    "既有任务 id 不得复用（跨任务污染：笔记会落进别人的 design/）",
  );
  assert.match(expanded, /pick a different slug/, "撞名动作=换一个（不静默复用、不硬闯）");
  assert.match(expanded, /tell me why/, "向用户说明（确认前零落盘，改名只说一句的成本最低）");
});
