# Changelog

## [3.16.6](https://github.com/ag-jin/ZPaPa/compare/v3.16.5...v3.16.6) (2026-10-09)

### Bug Fixes

* **cli:** 后台 Bash 收敛补批量唤醒轮终态覆盖并锚定 ACK 解析 ([ea171aa](https://github.com/ag-jin/ZPaPa/commit/ea171aade54d317149b514f83d646bbc44e937d0))

* **cli:** 后台 Bash 重启收敛与冷恢复真实时间戳 ([5ea0823](https://github.com/ag-jin/ZPaPa/commit/5ea0823c1c89a0001d62ecb269e67608e3eca042))
  * 新读面 background-task-session-query.ts：候选 = Bash launch ACK（三种模板文本 +
  * 新模块 background-task-orphan-reconcile.ts：判据 J1-J5（后台启动 / 已知 work /
  * 挂点：activateSessionForResume 尾部、子 agent 收敛之后（同一「本 runtime 零在飞」时刻），
  * 投影同源：cold merge 新增 reconciledBackgroundTasks 输入，把收敛事实合成
  * bootstrap/test/coldHydrationRealTimestamps.test.ts 5 例（修前 1/5 绿：行时间 = 1700000000004
  * bootstrap/test/background-task-orphan-reconcile.test.ts 13 例（读面模板解析、判据 skip
  * sessionResumeOrphanReconcileHook.test.ts 补 1 例：接管尾部同时收敛后台 Bash（删掉那行
  * 既有套件逐例不回归：bootstrap 45 → 64 全绿（含 coldHydrationSubagentStatus 14 例），


### Documentation

* **cli:** 同进程悬死 running 对账设计（R1 看门狗方案） ([859b54c](https://github.com/ag-jin/ZPaPa/commit/859b54c4208816d1dc5b0bfc96df003b50ff149b))

## [3.16.5](https://github.com/ag-jin/ZPaPa/compare/v3.16.4...v3.16.5) (2026-10-09)

### Features

* **cli:** 后台子 agent 孤儿收敛判据与 subagent_outcome 落盘模块 ([9d84528](https://github.com/ag-jin/ZPaPa/commit/9d84528c2526dde717133ae20b2bcac7632215b0))
  * 新模块 subagent-orphan-reconcile.ts：判据纯函数 selectSubagentOrphans（J1 后台启动 /
  * 权威清单读取（readSessionSubagentInventory）补两个判据事实，与 running/ended 同一次读：
  * 判据我不自造：J2/J3 直接消费权威清单的 childSessionIds/running，不自己判活/判终态。

* **cli:** 重启后孤儿收敛——接管时落盘 subagent_outcome ([071b444](https://github.com/ag-jin/ZPaPa/commit/071b444150ce03eea6e00cd23caabfec46050ea9))
  * 读面消费（subagent-session-query / readSessionSubagentInventory）：读取 child 时顺带读
  * 挂点（activateSessionForResume 尾部一行）：app.resume() 返回后本 runtime 对该会话零在飞
  * bootstrap/test/subagent-orphan-reconcile.test.ts 20 例（判据分支、落盘形状、幂等、读面优先级、
  * bootstrap/test/coldHydrationSubagentStatus.test.ts 13 例（原 11 例**逐例保持绿** + 新增
  * core backgroundSubagentTerminalEvent 4/4、squadTools 11/11 绿；bootstrap/core typecheck 通过；

* **desktop:** 帮助菜单四入口改指 ZPaPa GitHub 仓库 ([32fa094](https://github.com/ag-jin/ZPaPa/commit/32fa0942102cb00fe18315024daab3b487c1b9fb))

* **ui:** T1 网页元素上下文契约支持评语与身份合并 ([e30824c](https://github.com/ag-jin/ZPaPa/commit/e30824c92e5150edd7d63aa057bab12b79cc9960))

* **ui:** T2 网页元素注入脚本改为阶段状态机与祖先链滑轨 ([e7c2463](https://github.com/ag-jin/ZPaPa/commit/e7c2463aa7add3ef3172066e1b53430c9c064ff5))

* **ui:** T3 网页元素附件支持评语展示与内联编辑 ([2df7111](https://github.com/ag-jin/ZPaPa/commit/2df7111a2698ce47e3b423322324f946fc001cc9))

* **ui:** T4 网页元素拾取会话循环支持层级调整与评语阶段 ([3c3c0a7](https://github.com/ag-jin/ZPaPa/commit/3c3c0a71fbcbb6c09d893a7a771a52e35da3b5ec))

* **ui:** T5 网页元素拾取浮条与 UnifiedBrowserView 接线 ([4bcd036](https://github.com/ag-jin/ZPaPa/commit/4bcd0369c0de30739ec65b42cd7202e75d0e608a))

* **ui:** 子智能体目录补孤儿收敛摘要文案（可选增强） ([64eb54e](https://github.com/ag-jin/ZPaPa/commit/64eb54e42688c019b6bd096d827e19e07f4c7dee))
  * zh-CN：subagentDirectory.summary.reconciled =「运行时已退出，结果未知」
  * en-US：Runtime exited, result unknown

* **ui:** 子智能体表单增加后台派发开关 ([93bccd2](https://github.com/ag-jin/ZPaPa/commit/93bccd2efbf7bd600ed2ffe96f5f3cb1686df55f))


### Bug Fixes

* **cli:** 冷恢复按 child 真实终态判定后台 agent，不再把 spawn part 当终态 ([54a95e6](https://github.com/ag-jin/ZPaPa/commit/54a95e6e138af3bc7d85910eaedc781cd1f40bda))
  * transcript-hydration 新增 subagentChildFacts（knownChildSessionIds + terminalStates）：
  * server-operations 抽出 readSessionSubagentInventory（RPC 分页只是展示层包装）；
  * 阻塞式 Agent 语义不变：它等 child 真正结束才 completed/error，part 终态即 child 终态。

* **cli:** 后台 Agent 终态不再委派发布，修后台面板卡片永久「执行中」 ([5185c97](https://github.com/ag-jin/ZPaPa/commit/5185c9787280a8730633c741fc222711718a632e))

* **cli:** 孤儿收敛加固——TUI 同源读面、挂点测试、收敛行时间 ([97fba74](https://github.com/ag-jin/ZPaPa/commit/97fba74f3924a336e4720bfc166aa9bea7b47cc3))

* **ui:** 子智能体目录给收敛落 lost 的条目补成因副文案 ([6435054](https://github.com/ag-jin/ZPaPa/commit/64350546390e496896a8bacba0f18d39a65cea8b))

* **ui:** 审查收尾——stateKey 移除与注入脚本去名加固 ([abc88a1](https://github.com/ag-jin/ZPaPa/commit/abc88a1ef59fafde49258411e87775dbb9de9855))

* **ui:** 拾取计数按元素身份去重 ([b49388f](https://github.com/ag-jin/ZPaPa/commit/b49388fd2985291a5258edfb891523ba48f6f015))

* **ui:** 注入脚本组装改为压缩安全的位置参数注入 + 防回归测试 ([6b188b9](https://github.com/ag-jin/ZPaPa/commit/6b188b98f3f10145b80a8f814fa89d10bd83338d))


### Chores

* **repo:** 补 issue 模板并将社群徽章指向仓库 Discussions ([48ab973](https://github.com/ag-jin/ZPaPa/commit/48ab97389a36bb6f5d361326e261c3e840ae427a))


### Documentation

* **cli:** 后台子 agent 重启后孤儿收敛行为 spec ([98f2e4c](https://github.com/ag-jin/ZPaPa/commit/98f2e4c18128c8a31104573b3581a24cbe7bd390))

* **cli:** 核实 J4 认领信号覆盖不到进程内活 child，记录会话关闭例外 ([ad2a5e4](https://github.com/ag-jin/ZPaPa/commit/ad2a5e438b265e2dff4175ba42d8bbd991c9fc00))
  * J4 的 liveInProcess 只认 host record；生产拓扑里 subagent child 没有 record ⇒ 该判据
  * 主路径仍然安全，靠的是「挂点位置 + 后台 child 钉住常驻池 + 无连带终止入口 + 宽容期」，
  * 唯一例外（已确认可达）：显式会话关闭（deleteSession / session/close）绕过常驻池闸门，
  * 未决修法（新建进程级认领信号 / 会话关闭时收走后会话的后台 agent）涉及新状态所有者与

* **cli:** 补孤儿收敛三面同源与收敛行呈现的验收条文 ([f580ad8](https://github.com/ag-jin/ZPaPa/commit/f580ad878fe2733ad5a7813f3bdf0f0deb6670b3))

* **update:** 纠正「正式版发布 ⇒ 预览用户自动升回」—— 只在**开关关着**时成立 ([79dc0f6](https://github.com/ag-jin/ZPaPa/commit/79dc0f6c19e6f212bc3becbac6889331e9c656de))

* 内置浏览器元素拾取设计文档（评审输入） ([e714812](https://github.com/ag-jin/ZPaPa/commit/e714812fe51022a5cb3bf643ec5a7d87a48b661e))


### Refactorings

* **cli:** 孤儿收敛收尾（写入口绑定 store，测试去无用解构） ([ad690db](https://github.com/ag-jin/ZPaPa/commit/ad690db549a613b25621e0f759b4af970c161118))
  * 写入口取 store 上的绑定引用再调用：一是 adapter 的实现依赖 this，二是避免
  * 混合场景用例去掉未使用的解构变量（测试目录 lint 归零）。

* **cli:** 收紧孤儿收敛模块的导出面 ([80051d0](https://github.com/ag-jin/ZPaPa/commit/80051d081997d3942bba64d4e06d0efffe934100))

* **ui:** 拾取浮条合并层级与评语为一步提交 ([702f26f](https://github.com/ag-jin/ZPaPa/commit/702f26f9d6ddd5a446700860137caa1b227d05ff))
  * 浮条调整阶段：删掉多行祖先链面包屑，改为一行紧凑层级指示（当前档位短标签
  * 会话状态机：hover → adjust →「加入对话」→ hover，confirmSelection 直接携带
  * i18n：删 browser.elementPicker.bar.confirm / bar.done / comment.skip，新增
  * test-ids：删 CONFIRM_BUTTON / COMMENT_SKIP_BUTTON，DONE_BUTTON 更名
  * 设计文档 §1/§3/§4.3/§4.4/§5.1/§6/§9/§10/§11/§14 同步到新实现。
  * 测试：会话单次派发（带/不带评语）、计数去重改断言；新增浮条结构守卫

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
