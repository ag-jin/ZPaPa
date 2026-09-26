# dev UI 验证工具（CDP）

在改动 ZCode 桌面端 UI 后，用它驱动运行中的 dev 实例做验证 —— 比反复截屏/盲点可靠得多。

## 为什么需要

dev 版带 `--remote-debugging-port=9229`，renderer 暴露完整 CDP 接口。
用 `Runtime.evaluate` 可以直接读 DOM、读 store 实况、触发点击，
不用靠截屏猜状态。踩过的坑：靠 CGEvent 盲点 + 截图判断 UI 状态，
命中率低且无法确认结果，浪费大量时间。

## 用法

```sh
# 1) 拿到 renderer 的 ws 地址
WS=$(curl -s http://127.0.0.1:9229/json/list \
  | python3 -c "import json,sys; print([t['webSocketDebuggerUrl'] for t in json.load(sys.stdin) if t['type']=='page'][0])")

# 2) 执行一段表达式
node .agents/tools/cdp/cdp.mjs "$WS" "document.title"

# 3) 读取 zustand store 实况（比推断代码可靠）
node .agents/tools/cdp/cdp.mjs "$WS" "
(async () => {
  const m = await import('/@fs/Users/linguojin/Workspace/ZCode/ZPaPa/packages/ui/src/store/tabStore.ts');
  return Object.keys(m);
})()
"
```

`dev-ui-e2e.sh` 是包了常用动作的 shell（开设置页、按文案点按钮、读投射项数）。

## 从 tab store 读实况的惯用法

`useTabStore` 是 hook，不能在 React 外调。从 TabStoreProvider 的 fiber 取 store 实例：

```js
const rootEl = document.getElementById('root');
const ck = Object.keys(rootEl).find(k => k.startsWith('__reactContainer'));
let fiber = rootEl[ck], seen = new Set(), provider = null;
(function walk(f, d) {
  if (!f || d > 120 || seen.has(f) || provider) return;
  seen.add(f);
  const n = typeof f.type === 'function' ? (f.type.displayName || f.type.name) : '';
  if (n === 'TabStoreProvider') { provider = f; return; }
  walk(f.child, d + 1); walk(f.sibling, d);
})(fiber, 0);
const store = provider.memoizedState.memoizedState.current;  // useRef
store.getState().tabs;
```

## 换页/重挂载的注意点

- 点击连接后设置页会被卸载（连接流程切到工作区），组件内 state 全部丢失。
  验证连接后状态要**重新打开设置页**再读，别依赖点击前的快照。
- 多次 `open_settings` 是幂等的，但连着点会把它切回工作区；脚本里按需调用。
