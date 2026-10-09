/* 协作域 X1.2：评论派发请求的稳定键（§8.1）。**独立构造**——不得复用既有 eventKey
   （`e:id:...` / `e:fp:...` / `s:...`）的拼接格式：两种事实的键混在同一形态里，
   将来任何一侧改分隔/归一规则都会静默改动另一侧的去重行为。

   格式 = `comment-dispatch:v1:` + 四个分量各自 `长度:值`，用 `|` 连接。
   为什么带长度前缀：朴素 `a|b` 拼接下 {ws:"a|b", wi:"c"} 与 {ws:"a", wi:"b|c"} 会撞键 ——
   撞键意味着两条不同的请求被存储层当成同一条（重投幂等会把第二条静默吞掉）。 */

export type CommentDispatchKeyInput = {
  workspaceKey: string;
  workItemId: string;
  targetAgentId: string;
  commentId: string;
};

function assertNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `computeCommentDispatchKey 的 ${field} 不得为空白（收到 ${JSON.stringify(value)}）：` +
        "空白分量会让两条不同请求算出同一个键，重投幂等随即把其中一条静默吞掉。",
    );
  }
  return value;
}

/** 稳定键：同输入两次调用逐字节相同；无 IO、无时钟。 */
export function computeCommentDispatchKey(input: CommentDispatchKeyInput): string {
  const segments = [
    assertNonBlank(input.workspaceKey, "workspaceKey"),
    assertNonBlank(input.workItemId, "workItemId"),
    assertNonBlank(input.targetAgentId, "targetAgentId"),
    assertNonBlank(input.commentId, "commentId"),
  ];
  return `comment-dispatch:v1:${segments.map((value) => `${value.length}:${value}`).join("|")}`;
}
