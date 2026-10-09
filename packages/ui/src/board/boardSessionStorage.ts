/**
 * 看板面板的会话内偏好骨架（评审 #34-S1：三处 storage try/catch 各写一份）。
 *
 * sessionStorage 在隐私模式 / 配额打满 / 纯 node 下都可能不可用或抛错；面板的偏好都是
 * 「有则更好」的视图偏好（视图模式、表格列选择），因此统一口径：**读回 null、写静默丢弃，功能照常**。
 * 先例：`settings/saved-workflows/automationsPageTabMemory.ts`（#33/#34 两份记忆模块同款）。
 *
 * 注意：`sessionStorage` 的可用性必须在**调用时**判定（不能模块级缓存），
 * 否则同进程内安装的假 storage（测试）与运行期注入的 storage 都读不到。
 */
export function readBoardSessionValue(key: string): string | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeBoardSessionValue(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额）就不记：下次打开回到默认，不影响功能。
  }
}
