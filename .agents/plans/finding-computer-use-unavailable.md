# 发现：computer-use 在本机不可用的三重根因

日期：2026-09-26
影响：官方 ZCode 包（非 dev 构建）里的「电脑控制」从安装起就不可用，所有调用返回
`capture_app: the target app has no readable accessibility tree` 或
`broker_not_accepting` 超时。

## 结论先行

computer-use **本身没有缺陷**，是三个独立的环境问题叠加。三者都会让调用失败，但报错
文案指向同一句话，因此极易误判为「权限没给」或「功能没开源」。

## 根因一：安装目录里的 helper 是旧协议版本

磁盘上的 helper 与 app 包内的 helper 版本不一致：

| 位置 | 版本 | 启动协议 |
|---|---|---|
| `~/.zcode/computer-use/`（host 实际使用） | 3.12.3 | 要求拉起着铸造 `--token-file` |
| `~/.zcode/computer-use/dev/` | 3.9.2 | 同上 |
| `/Applications/ZCode.app/Contents/Resources/cua-helper/`（包内） | **3.14.1** | 用 `--launcher-pid` + 原生签名校验 |

当前 host（`node-repl-host`）只发 `--launcher-pid`，不铸造 token-file，所以旧 helper
启动即退出：

```
ZCode Computer Use broker requires a launcher-minted --token-file;
refusing to start an unauthenticated (or attacker-supplied --token/env) broker
```

**为什么难以发现**：`ensureStandaloneHelperLaunched` 的 `open` 调用是
`await promisify(execFile)("/usr/bin/open", args, {timeout: 5e3}).catch(() => {})` ——
错误被完全吞掉，SDK 侧只看到 34 秒重试后超时。

刷新逻辑本该覆盖这个情况（`shouldRefreshLocalDevBundledHelper` + `ensureInstalled`），
但在本机没有生效，原因未查明。

修复：把包内 3.14.1 复制到 `~/.zcode/computer-use/`，并同步 `.zcode-cua-helper-meta.json`。

## 根因二：`--launcher-pid` 必须是当前 ZCode 本体

helper 用原生 `verifyProcessCodeSignature` 校验 `--launcher-pid` 指向的进程必须是
签名匹配的 ZCode 主进程。ZCode 重启后 PID 变化（本机 20017 → 6245），而 app 环境变量
`ZCODE_CUA_LAUNCHER_PID` 在下次重启前仍是旧值。

直接执行 helper 二进制也不行（缺 LaunchServices 上下文，同样报签名校验失败），
必须走 `/usr/bin/open -n -g <app> --args ...`。

## 根因三：「启用电脑控制」总开关为关闭状态

设置页 → 电脑控制 →最上方的 **启用电脑控制** 开关。源码见
`packages/ui/src/settings/ComputerUseSection.tsx:131`：

```ts
// 总开关 = zcode-cua 插件启用态
const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
const cuaEnabled = cuaPlugin?.enabled ?? false;
```

落盘位置：`~/.zcode/cli/config.json` → `plugins.enabledPlugins["computer-use@zcode-plugins-official"]`。

**授权弹窗不出现的机制**：权限一旦被拒绝过一次（TCC `auth_value=0`），macOS 不再弹窗，
只能手动到 系统设置 → 隐私与安全性 里打开。因此若先误点过「不允许」，后续不会再有机会
自动恢复。`tccutil reset Accessibility dev.zcode.cua-helper` 可清除记录，但清完仍需要
有人点弹窗。

## 附带发现：dev 构建（ZPaPa）不携带 CUA 资源

```
.zcode-runtime/desktop-dev/41.0.3-x64/ZCode Dev.app/Contents/Resources/
  ✗ 无 cua-helper/
  ✗ 无 glm/packages/node-repl-host/
```

所以 computer-use 在 dev 构建里**永远不可用**，与权限、开关都无关。需要验证
computer-use 行为时必须在官方包（或补齐资源的打包产物）里进行。

## 排查手法（可复用）

判断「到底卡在哪一层」的检查顺序：

1. **helper 进程活着吗** `pgrep -f cua-helper`；socket 在吗 `ls /tmp/zcode-cua-$(id -u)/broker.sock`
2. **权限到底给没给** —— 不要猜，调 SDK 的权威接口：
   ```js
   const r = await agent.computerUse.requestAccess();
   r.accessibility          // "granted" | "denied"
   r.accessibility_probe    // { ok, ax_error, classification }
   ```
3. **TCC 落盘记录**（需要完全磁盘访问）
   ```sh
   sqlite3 /Library/Application\ Support/com.apple.TCC/TCC.db \
     "select service, client, auth_value from access where client like '%cua-helper%';"
   ```
   `2=已允许 0=已拒绝`
4. **helper 退出日志**（含真实死因，比 SDK 报错有用得多）
   `~/.zcode/computer-use/logs/zcode-cua-helper-<日期>.jsonl`
5. **总开关** `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins`

## 尚未解决

- `ensureStandaloneHelperLaunched` 的静默失败未修复：错误被 `.catch(() => {})` 吞掉，
  导致任何启动失败都表现为 34 秒超时，无法自诊断。建议至少写一行日志。
- 安装目录与包内 helper 的版本刷新机制为何未生效，未定位。
- app 环境变量 `ZCODE_CUA_LAUNCHER_PID` 的更新时机（下个版本可考虑改为运行时读取）。
