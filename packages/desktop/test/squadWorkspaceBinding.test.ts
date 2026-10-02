import assert from "node:assert/strict";
import test from "node:test";
import { resolveSquadWorkspaceBinding } from "../src/host/squadWorkspaceBinding.js";

/* 小队运行时的 workspace 绑定：**显式，且不许静默取首个**（裁定 4 / 确认 3）。

   为什么这一层的用例必须存在：启动回收会**删分支与工作树**，而它需要一个唯一目标；
   目标在启动路径上只以「候选」的形式出现。挑错的表现是「在一个没有小队的仓库上动手」，
   两边都不报错 —— 这类静默错选只有把三条路径钉成断言才拦得住。 */

test("唯一候选 ⇒ 绑定它", () => {
  const only = { path: "/ws/a", identity: "a" };
  assert.deepEqual(resolveSquadWorkspaceBinding([only]), only);
  // 返回的是**副本**：后续对候选数组元素的就地修改不得改变已解析的结论。
  only.identity = "changed";
  assert.deepEqual(resolveSquadWorkspaceBinding([{ path: "/ws/a", identity: "a" }]), {
    path: "/ws/a",
    identity: "a",
  });
});

test("没有候选 ⇒ 抛（不返回一个空目标）", () => {
  assert.throws(() => resolveSquadWorkspaceBinding([]), /没有候选/);
});

test("多候选 ⇒ 抛，且**列出全部候选**（不许静默挑一个）", () => {
  const error = (() => {
    try {
      resolveSquadWorkspaceBinding([
        { path: "/ws/a", identity: "a" },
        { path: "/ws/b", identity: "b" },
      ]);
      return null;
    } catch (caught: unknown) {
      return caught;
    }
  })();
  assert.ok(error instanceof Error, "多候选必须抛");
  // 文案里两侧都要有：只报「有多少个」而不报「是哪几个」，收错误的人无从选择。
  assert.match(error.message, /a\(\/ws\/a\)/);
  assert.match(error.message, /b\(\/ws\/b\)/);
});
