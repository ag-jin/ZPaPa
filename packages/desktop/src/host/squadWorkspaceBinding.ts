/**
 * 小队运行时的**启动维护目标**：把「候选名单」规范化成**逐候选**要处理的 target 列表。
 *
 * 背景（2026-10-03 用户真机实测）：启动三步（**重驱 / 回收 / 队长行和解**）原本都先调
 * `resolveSquadWorkspaceBinding` 要求「候选**恰好一个**」，而用户机器上最近 workspace 有三个
 * ⇒ 三步**全部 skip**（各自 warn 一行、带候选清单）⇒ 启动维护在他那儿**从来没跑过**。
 *
 * 为什么改成**逐候选**是安全的（不是放宽了原来那道闸）：
 * 原函数防的是「**从多个候选里挑一个**」——挑错 = 在**别人**的仓库里删分支/删工作树。
 * 而这三步的每一步都是**目标作用域内**的动作：
 *   · 回收：只碰 `<target.path>/.worktree/` 下的树 + `squad/member/**` 命名空间的分支（回收器自己的第二道闸）；
 *   · 重驱：只结算 `workspace_key` 属于该目标的台账行；
 *   · 和解：只收该目标自己的队长行。
 * ⇒ 「逐个都做，每个只在自己的地盘」既不挑错，也不跨仓库动手 —— 这正是原来想避免的那件事。
 *
 * 因此**不再有**「候选多于一个 ⇒ 抛」这条语义；`resolveSquadWorkspaceBinding` 随之删除
 * （它已无生产调用方，留着就是「零调用方的判据」——本项目在 §5.7(1) 那件事上刚吃过这种亏）。
 *
 * 顺序按入参原序（调用方给的启动预热名单自带有序），并**按 path+identity 去重**：
 * 同一对出现两次只应处理一次（重复处理回收是幂等的，但重复探会话与重复结算日志没有必要）。
 */
export type SquadWorkspaceBinding = { path: string; identity: string };

export function listSquadWorkspaceTargets(
  candidates: ReadonlyArray<SquadWorkspaceBinding>,
): SquadWorkspaceBinding[] {
  const seen = new Set<string>();
  const targets: SquadWorkspaceBinding[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.path}\u0000${candidate.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 返回副本：调用方拿到的是「本次解析的结论」，不该被后续对候选数组元素的就地修改影响。
    targets.push({ ...candidate });
  }
  return targets;
}
