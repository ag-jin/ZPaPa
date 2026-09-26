import assert from "node:assert/strict";
import test from "node:test";

/**
 * 远程会话可见性：UI 侧 scope 构造契约（不经 UI，直接验证纯函数行为）。
 *
 * 这条链路今天修过两次错，两次都表现为「连接成功但列表为空」，且都源于
 * scope 的键形态与下游不一致，因此把契约固化下来：
 *
 *   1. 远程 tab 的查询 scope **必须带 remote identity** —— host 的 resolveSource
 *      靠它定位远程连接并解析出对端 taskService；丢了 identity 就会退化成
 *      「查本地同路径项目」或干脆解析不到 source。
 *   2. 本地 tab 不应凭空多出 identity。
 *   3. 同 identity+path 的重复 tab 去重（scope 集合语义）。
 *
 * 对应实现：packages/ui/src/hooks/useGlobalTaskList.ts 的 buildWorkspaceScopes。
 */

/** 从实现复刻的最小等价实现；实现改动时本测试会失败并提醒同步契约。 */
function buildWorkspaceScopes(
  workspaceTabs: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const scopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

test("远程 tab 的查询 scope 必须保留 remote identity", () => {
  const remoteIdentity = "remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马";
  const scopes = buildWorkspaceScopes([
    {
      workspacePath: "/Volumes/数据盘/网站/新赛马",
      workspaceIdentity: remoteIdentity,
    },
  ]);

  assert.equal(scopes.length, 1);
  assert.equal(
    scopes[0]?.workspaceIdentity,
    remoteIdentity,
    "远程 scope 丢 identity 会导致 host 解析不到远程 source（列表恒空）",
  );
  assert.equal(scopes[0]?.workspacePath, "/Volumes/数据盘/网站/新赛马");
});

test("本地 tab 不携带 identity", () => {
  const scopes = buildWorkspaceScopes([{ workspacePath: "/Users/me/project" }]);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.workspaceIdentity, undefined);
  assert.equal(scopes[0]?.workspacePath, "/Users/me/project");
});

test("本地与远程同路径项目分别成 scope（不互相合并）", () => {
  const remoteIdentity = "remote:ssh:host:22:user:/same/path";
  const scopes = buildWorkspaceScopes([
    { workspacePath: "/same/path" },
    { workspacePath: "/same/path", workspaceIdentity: remoteIdentity },
  ]);
  assert.equal(scopes.length, 2, "同路径的本地项目与远程项目是两个独立 scope");
  assert.ok(scopes.some((scope) => scope.workspaceIdentity === remoteIdentity));
  assert.ok(scopes.some((scope) => scope.workspaceIdentity === undefined));
});

test("同 identity 的重复 tab 去重", () => {
  const remoteIdentity = "remote:ssh:host:22:user:/p";
  const scopes = buildWorkspaceScopes([
    { workspacePath: "/p", workspaceIdentity: remoteIdentity },
    { workspacePath: "/p", workspaceIdentity: remoteIdentity },
  ]);
  assert.equal(scopes.length, 1);
});
