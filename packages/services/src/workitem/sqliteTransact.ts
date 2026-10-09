import type { DatabaseSync } from "node:sqlite";

/* 协作域 G8（§8.3）：**跨 repo 不变量**的显式事务口（组合根注入给 CommentService）。
   本文件只 `import type node:sqlite`（无运行时 node 依赖，照 `workItemProjectRepo` / `workItemViewRepo`
   的形态），是「评论 + Activity + receipt 三条事实同生共死」这一条不变量的**唯一** BEGIN/COMMIT 出处。

   边界纪律（对先例的延伸裁定，逐条照 `workItemProjectRepo.remove`）：
   ① repo 自有两句 SQL 的事务边界**在 repo**（先例原话「不把 BEGIN/COMMIT 交给调用方」）；
   ② **跨 repo 不变量**的事务边界归不变量所有者（这里是 `commentService`）——
      把 BEGIN/COMMIT 交给上层调用方，等于让不变量在两处各写一份；
   ③ `transact` 内**不得再开事务**：SQLite 不支持嵌套 BEGIN（会响亮抛），嵌套也不是本口的语义；
   ④ 回滚失败（IO 已坏）**不覆盖原始异常**——先例的 try/catch 原样保留。

   为什么是 `BEGIN IMMEDIATE` 而不是默认的 deferred：本口存在的理由就是把「读队列状态窗 → 写裁决结论」
   收进同一把写锁；deferred 要等第一次写才升级锁，读到的状态窗在升级前仍可被别的窗口改掉
   （多窗口 Host 共用同一 tasks-index 库文件）。`busy_timeout` 由连接侧（`taskIndexRepo.initialize`）
   兜底，持锁时长 = 调用方那段回调。 */

/**
 * 生成一条共享连接上的事务执行器（`BEGIN IMMEDIATE` → fn → `COMMIT`；fn 抛 ⇒ `ROLLBACK` 后原样 rethrow）。
 *
 * 逐字照 `workItemProjectRepo.remove`（`workItemProjectRepo.ts:266-288`）的既有模式：不另立第二套事务口径
 * ——两套「怎么算一个事务」的实现在同一个库里迟早漂移，而漂移的表现是「有时回滚有时不回」，不报错。
 */
export function createSqliteTransact(db: DatabaseSync): <T>(fn: () => T) => T {
  return <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } catch {
        /* 回滚也可能 IO 失败：不覆盖真正的原始异常。 */
      }
      throw error;
    }
  };
}
