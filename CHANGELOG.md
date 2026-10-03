# Changelog

## [3.16.4](https://github.com/ag-jin/ZPaPa/compare/v3.16.3...v3.16.4) (2026-10-03)

### Features

* **desktop,ui:** 更新通道可见 + 回不到正式版说清原因 + 显式禁用降级 ([2af689b](https://github.com/ag-jin/ZPaPa/commit/2af689b006d950c15f3851462659e3b32febf98f))
  * updateStatusModel 的 updateChannel（原无消费点）接到更新弹窗徽标（预览版/正式版）；
  * 「装了预览版 + 关开关 + 正式版号更低」这一格不再只说「已是最新」：main 用 semver
  * 已核实 electron-updater 的 channel setter 每次赋值（含赋 null）都置 allowDowngrade=true
  * 在 channel 赋值之后显式关掉，理由写进注释：mac Squirrel 降级支持不完整，依赖它很可能
  * 测试桩忠实复刻 setter 副作用，删掉那一行必红（变异实测）。
  * 该字段只由已删除的平台 manifest 产出 ⇒ GitHub 路径恒 null ⇒ stale 守卫恒不生效，

* **会话:** rail 目录自动预载一段（有预算），碰 rail 再补全 ([5ab1028](https://github.com/ag-jin/ZPaPa/commit/5ab1028e9578d4f4941c8c96e027699f2390eaa2))
  * **预载**（自动、有预算）：窗口稳定后 1.5s 起跑一次 `loadAllOlder({ maxWindowRows:
  * **补全**（显式）：用户碰 rail（悬停停留 260ms / 键盘聚焦）→ 不设上限，补到完整目录。
  * 进入会话：rail 3 项 → **15 项**（窗口 240 → 1040 行，约 1.2s 后自动落定）。
  * 碰 rail：**167 项全在**，盒高 837px = 会话高度的 75%（上一轮的规格）。
  * 切换代价：点击阻塞 226ms / 内容可见 622ms（与预载前一致，预载不挡首屏）；
  * 补全（完整目录）后切回该会话仍是 ~4s（整窗数据模型进 React 的固有代价，未变）。


### Bug Fixes

* **desktop/test:** 补上 node-forge 环境声明的引用（非增量 typecheck 才暴露的缺口） ([2e3269b](https://github.com/ag-jin/ZPaPa/commit/2e3269b3068f326ace466436fb0135f2c662a402))

* **desktop:** 阻塞态拨开关不再被静默吞掉；删死代码 manifestUpdateProvider ([c448a5e](https://github.com/ag-jin/ZPaPa/commit/c448a5eb93595e554fc2601cbdd81c49de0aefb7))
  * isReleaseChannelChangeBlocked 收敛三种阻塞态的判定；
  * setAutoUpdaterMenuState（状态唯一收口点）与 completeAutoUpdateCheck 都尝试落地

* **desktop:** 预览开关拨动即时生效（allowPrerelease 与 channel 成对切换） ([a7deaef](https://github.com/ag-jin/ZPaPa/commit/a7deaef7a099ecbee013caf34c30accceb57505d))
  * 抽出 applyAutoUpdaterReleaseChannelConfig(channel)：setFeedURL + allowPrerelease
  * channel 同批应用；初始化与拨开关两条路径都调它，且都在 checkForUpdates 之前。
  * allowPrerelease 与 channel 成对切换（事实 2）：预览 ⇒ true/"preview"，
  * 切通道一并清 readyUpdateVersion / skippedElectronUpdateVersions /
  * 检查在飞时仍延后，但收口后真正应用通道（不再只重跑 check）。
  * 冷启动 await applyGitHubUpdateProvider 完再 triggerCheckForUpdates("startup")，
  * pendingManifestReleaseChannelRefresh 更名 pendingReleaseChannelRefresh，

* **会话:** 左侧导航条按规格改成会话高度 75%，目录补拉恢复列全 ([1a08e09](https://github.com/ag-jin/ZPaPa/commit/1a08e0986123da83bf0cc2f350fbc84d3a4dbcde))
  * 完整窗口 11042 行时 DOM 里只挂 20 行（虚拟化正常），代价不在渲染行数，
  * 因此「rail 一打开就全」与「切进去不等」在当前架构里互斥：
  * 两者都要，需要让 rail 的目录不再依赖渲染窗口（目录数据面 + 跳转时按需补窗），

* **会话:** 按需加载不得动用户已定的阅读位置 ([fc21e9d](https://github.com/ag-jin/ZPaPa/commit/fc21e9da147528b0cf84c082eb216a1885f2b32a))
  * 那条最长会话冷开首屏本来就是 60 行；涨到 11042 行不是预取级联（预取日志 0 条），
  * 零输入冷开 14s：由程序化/布局 scroll 触发的预取 = 0。
  * 用户拿回滚动权并静止后，后台连续补窗（实测 11~30 次）：锚点行视口偏移变化

* **会话:** 长会话打开/切换不再等整段历史（加载预算 + 目录按需） ([94a8f93](https://github.com/ag-jin/ZPaPa/commit/94a8f9308d2b3a1fc465241d73d028ab191641fc))
  * 切进那条最长会话：点击同步阻塞 4376~4931ms，内容可见在 4966ms；窗口被填到 11042 行。
  * 不动的对照：切进短会话 794ms 可见、无 >100ms 卡顿。
  * CPU profile（5.4s）：getBoundingClientRect 1111ms（2002 次，其中 radix 831 次）、
  * 切进长会话：点击阻塞 205/215ms，内容可见 560/626ms，窗口停在 60→240 行。
  * 用户继续上滚仍按需补窗，锚点行视口偏移变化 0.01px（位置不变式未破）。
  * 碰 rail：补拉 1 次、到达预算即停，窗口 240→1840 行、rail 10→29 项；

* **更新:** 打包档位落下工作流灰度开关 —— 离线裁剪后「自动化 → 工作流」整个消失 ([2564652](https://github.com/ag-jin/ZPaPa/commit/2564652064e346dd2c12d2cfcf5d1b13a0950434))


### Performance

* **会话:** rail 预载降到 600 行——预载量直接换切换延迟，实测定档 ([0f0db25](https://github.com/ag-jin/ZPaPa/commit/0f0db25d8f2e19b4dc5936c6233fe409d7ac7acc))
  * 进入后静置：一次 ~750ms 停顿（rail 预载落地）；
  * 上滚：无 >200ms 停顿（≤62ms）；
  * 碰 rail 补全完整目录：一次 2.5~5.1s 停顿。


### Chores

* **release:** 更新说明补 Performance 分区，perf 提交不再被漏掉 ([39cd8f1](https://github.com/ag-jin/ZPaPa/commit/39cd8f18593b5e76ce78ce8b9197fc9f41ec493d))


### Documentation

* **readme:** 补预览版发布流程与两条纪律（标识须为 preview / 预览号不得高于随后正式号） ([43b3fc5](https://github.com/ag-jin/ZPaPa/commit/43b3fc5865a083674d910043f60dc258fbe691d0))

* **update:** 预览更新通道实现计划（验收=逆推+穷举；含两条源码级事实：latest*.yml 回退、dev 污染与 channel 成对切换） ([a0ff6d5](https://github.com/ag-jin/ZPaPa/commit/a0ff6d5dc6c119ab3e47c305b0766ae511d6f65f))

* **更新:** 纠正「macOS 只打开发布页」的过时注释（398fc33 之后 mac 已走应用内更新） ([caf05cd](https://github.com/ag-jin/ZPaPa/commit/caf05cdff3aaf5f137d432ac671d0efdf0a6cef5))
