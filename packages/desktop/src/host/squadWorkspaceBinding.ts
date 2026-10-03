/**
 * 小队运行时该绑定**哪一个** workspace —— **显式，且不许静默取首个**。
 *
 * 为什么需要它：`ISquadRuntimeService` 的每个方法第一个参数都是 `SquadWorkspaceTarget`
 * （裁定 4 / 确认 3：runtime 为**某一个**目标现构，服务层没有环境绑定），所以「小队运行时的
 * 目标 workspace」这件事最终必须由某个调用点**给出唯一一个**。启动回收就是这样一个调用点：
 * 它发生在启动路径上，那里能拿到的是一份**候选**（main 决定的启动预热名单），不是一个确定项。
 *
 * 为什么多于一个时必须**拒绝并报告候选清单**而不是挑一个：挑一个的表现是「用户看到的是
 * 『我没建过小队』，而真相是我们在另一个 workspace 上读写 / 删分支」——本项目一路在消灭的
 * 那类静默错选（多 workspace 的完整支持登记为 P2c）。静默取首个在这里尤其危险：启动回收会
 * **删分支与工作树**，挑错的代价是删掉别人仓库里的东西。
 *
 * 与 `Node` 侧真实装配的一致性：`<ws>/.zcode/squad/` 是小队定义根，`<ws>/.worktree/` 是运行目录
 * （都由目标 path 派生）⇒ 目标选错 = 在一个没有小队的仓库上做回收，且回收器会把「不属于本域」
 * 的东西报成 `foreign`（这是它自己的第二道闸，不是本函数的替代）。
 */
export type SquadWorkspaceBinding = { path: string; identity: string };

export function resolveSquadWorkspaceBinding(
  candidates: ReadonlyArray<SquadWorkspaceBinding>,
): SquadWorkspaceBinding {
  if (candidates.length === 0) {
    throw new Error(
      "小队运行时未绑定 workspace：没有候选。" +
        "启动回收需要一个明确的目标（它要按目标仓库的分支命名空间决定删什么），" +
        "而这次启动没有可用的 workspace 候选。",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "小队运行时未绑定 workspace：候选多于一个，必须显式指定（本期不支持多 workspace）→ " +
        candidates.map((candidate) => `${candidate.identity}(${candidate.path})`).join(" / "),
    );
  }
  // 返回副本：调用方拿到的是「本次解析的结论」，不该被后续对候选数组元素的就地修改影响。
  return { ...candidates[0]! };
}
