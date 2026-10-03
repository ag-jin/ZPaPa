import assert from "node:assert/strict";
import test from "node:test";
import { listSquadWorkspaceTargets } from "../src/host/squadWorkspaceBinding.js";

/* 启动维护的**逐候选**目标（2026-10-03 改）。

   原来这里测的是 `resolveSquadWorkspaceBinding`「候选多于一个 ⇒ 抛」——那条语义已被删掉：
   用户真机实测（最近 workspace 三个）触发「三步全部 skip ⇒ 启动维护从来没跑过」。
   改成逐候选后，要钉的是**别的东西**：
   1. 没有候选 ⇒ **返回空表**（调用方据此记 info 并跳过，不是失败）；
   2. 多个候选 ⇒ **全都保留、且按入参原序**（顺序即预热名单的顺序，不得被打乱）；
   3. 同一对 (path, identity) 重复 ⇒ **只处理一次**；
   4. 返回的是**副本**：调用方对候选数组元素的就地修改不得改变已解析的结论。 */

test("没有候选 ⇒ 空表（跳过由调用方记 info，不是抛）", () => {
  assert.deepEqual(listSquadWorkspaceTargets([]), []);
});

test("多个候选 ⇒ 全部保留且保持原序", () => {
  assert.deepEqual(
    listSquadWorkspaceTargets([
      { path: "/ws/b", identity: "b" },
      { path: "/ws/a", identity: "a" },
      { path: "/ws/c", identity: "c" },
    ]),
    [
      { path: "/ws/b", identity: "b" },
      { path: "/ws/a", identity: "a" },
      { path: "/ws/c", identity: "c" },
    ],
  );
});

test("同一对 (path, identity) 重复 ⇒ 只处理一次；同 path 不同 identity 是**两个**目标", () => {
  assert.deepEqual(
    listSquadWorkspaceTargets([
      { path: "/ws/a", identity: "a" },
      { path: "/ws/a", identity: "a" },
      { path: "/ws/a", identity: "a@remote" },
    ]),
    [
      { path: "/ws/a", identity: "a" },
      { path: "/ws/a", identity: "a@remote" },
    ],
  );
});

test("返回的是副本（就地改候选元素不得改变结论）", () => {
  const only = { path: "/ws/a", identity: "a" };
  const resolved = listSquadWorkspaceTargets([only]);
  only.identity = "changed";
  assert.deepEqual(resolved, [{ path: "/ws/a", identity: "a" }]);
});
