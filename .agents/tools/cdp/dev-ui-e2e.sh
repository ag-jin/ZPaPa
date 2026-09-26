#!/bin/bash
WS="$1"; # 既可 source 也可直接执行；source 时 BASH_SOURCE 可能不指向本文件，
# 因此以「向上找 .git」为兜底，避免路径解析失败。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../.." 2>/dev/null && pwd)"
[ -d "$REPO_ROOT/.git" ] || REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "无法定位仓库根" >&2; return 1 2>/dev/null || exit 1; }
cd "$REPO_ROOT"
export ZPAPA_ROOT="$REPO_ROOT"
C="node"
open_settings() {
  $C "$REPO_ROOT/.agents/tools/cdp/cdp.mjs" "$WS" "(document.querySelector('[data-testid=task-settings-button]')?.click(), 'ok')" >/dev/null; sleep 4
  $C "$REPO_ROOT/.agents/tools/cdp/cdp.mjs" "$WS" "(document.querySelector('[data-testid=settings-section-nav-remoteDevice]')?.click(), 'ok')" >/dev/null; sleep 6
}
click_text() {
  $C "$REPO_ROOT/.agents/tools/cdp/cdp.mjs" "$WS" "
  (() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const b = [...document.querySelectorAll('button')].filter(vis).find(x => (x.textContent||'').trim() === '$1');
    b?.click(); return { clicked: !!b };
  })()
  "
}
state() {
  $C "$REPO_ROOT/.agents/tools/cdp/cdp.mjs" "$WS" "
  (() => {
    const rootEl=document.getElementById('root');
    const ck=Object.keys(rootEl||{}).find(k=>k.startsWith('__reactContainer'));
    let f=rootEl?.[ck],seen=new Set(),p=null;
    function w(x,d){if(!x||d>120||seen.has(x)||p)return;seen.add(x);
      const n=typeof x.type==='function'?(x.type.displayName||x.type.name):'';
      if(n==='TabStoreProvider'){p=x;return;} w(x.child,d+1); w(x.sibling,d);}
    w(f,0);
    const st=p?.memoizedState?.memoizedState?.current;
    const tabs=st.getState().tabs;
    const proj=tabs.filter(t=>t.projection);
    const by={}; for(const t of proj){const k=t.projection.deviceSessionId.slice(0,8); by[k]=(by[k]??0)+1;}
    return { 投射项: proj.length, 按设备: by };
  })()
  "
}
