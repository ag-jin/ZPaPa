import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMacDesignatedRequirement,
  resolveGitHubReleasesPageUrl,
  resolveMacAppBundlePath,
  shouldUseInAppAutoUpdate,
} from "../src/main/autoUpdatePolicy.js";

/**
 * mac 应用内自动更新的判定契约。
 *
 * 背景（2026-09-29 实测）：Squirrel.Mac 初始化时要取当前应用的 designated requirement；
 * **完全未签名**的应用取不到，原生 `setFeedURL()` 直接抛
 * `Could not get code signature for running application` —— 未签名包不是「安装被拒」，
 * 而是连更新器都起不来。所以打包侧改为总是给 identity（无证书时 ad-hoc + 显式
 * identifier 型 DR），运行期再用本文件这些判定兜底回退。
 *
 * 这些判定写错的后果都是静默失效：要么让用户点了更新没反应，
 * 要么把可用的应用内更新误判成不可用、永远只能手动下载。故逐条锁定。
 */

test("parseMacDesignatedRequirement：未签名（codesign 非 0 退出）判为无 DR", () => {
  // 真实未签名输出：codesign -d -r- 退出码非 0，stderr 写 "code object is not signed at all"
  assert.equal(
    parseMacDesignatedRequirement(1, "", "/Applications/ZCode.app: code object is not signed at all"),
    false,
  );
  // 退出码是稳定契约：即使 stderr 为空/被本地化，也必须判否
  assert.equal(parseMacDesignatedRequirement(1, "", ""), false);
});

test("parseMacDesignatedRequirement：ad-hoc 与正式签名都判为有 DR", () => {
  // ad-hoc：identifier 型 DR（本仓库打包侧显式指定的形态）
  assert.equal(
    parseMacDesignatedRequirement(0, 'designated => identifier "dev.zcode.app"', ""),
    true,
  );
  // ad-hoc 自动生成：cdhash 型 DR —— 能让 Squirrel 取到 DR，故也算有
  assert.equal(
    parseMacDesignatedRequirement(0, '# designated => cdhash H"35d594ff5639"', ""),
    true,
  );
  // 正式签名：DR 含锚定到 Developer ID 的团队信息
  assert.equal(
    parseMacDesignatedRequirement(
      0,
      'designated => identifier "dev.zcode.app" and anchor apple generic and certificate leaf[subject.OU] = "TEAM123"',
      "",
    ),
    true,
  );
});

test("parseMacDesignatedRequirement：有签名但取不到 DR 时判否", () => {
  // 退出码 0 但输出里没有任何 DR/identifier —— 不能假定可用
  assert.equal(parseMacDesignatedRequirement(0, "Executable=/path/to/ZCode\n", ""), false);
});

test("resolveMacAppBundlePath：从可执行文件上溯到 .app 根", () => {
  // 必须返回 .app bundle 根而不是 Contents/Resources/app.asar：
  // asar 本身无签名，拿它去问 codesign 会把正常签名误判成未签名（实测）。
  assert.equal(
    resolveMacAppBundlePath("/Applications/ZCode.app/Contents/MacOS/ZCode"),
    "/Applications/ZCode.app",
  );
  // 路径含空格
  assert.equal(
    resolveMacAppBundlePath("/Users/a/b/My App.app/Contents/MacOS/My App"),
    "/Users/a/b/My App.app",
  );
  // 带括号的 helper 可执行文件同样上溯三层
  assert.equal(
    resolveMacAppBundlePath("/Applications/ZCode.app/Contents/MacOS/ZCode Helper (GPU)"),
    "/Applications/ZCode.app",
  );
});

test("shouldUseInAppAutoUpdate：未打包沿用 dev 开关，不谎称支持", () => {
  assert.equal(
    shouldUseInAppAutoUpdate({
      platform: "darwin",
      isPackaged: false,
      devAutoUpdateEnabled: false,
    }),
    false,
  );
  assert.equal(
    shouldUseInAppAutoUpdate({
      platform: "darwin",
      isPackaged: false,
      devAutoUpdateEnabled: true,
    }),
    true,
  );
});

test("shouldUseInAppAutoUpdate：非 darwin 打包态维持既有行为", () => {
  for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
    assert.equal(
      shouldUseInAppAutoUpdate({ platform, isPackaged: true, devAutoUpdateEnabled: false }),
      true,
      `${platform} 打包态应维持既有行为`,
    );
  }
});

test("shouldUseInAppAutoUpdate：macOS 打包态取决于是否取到 DR", () => {
  // 这是本次修复的核心：有 DR（ad-hoc 或正式签名）→ 应用内更新可用
  assert.equal(
    shouldUseInAppAutoUpdate({
      platform: "darwin",
      isPackaged: true,
      devAutoUpdateEnabled: false,
      macHasDesignatedRequirement: true,
    }),
    true,
  );
  // 未签名 → 必须回退到打开发布页，不能进注定失败的状态机
  assert.equal(
    shouldUseInAppAutoUpdate({
      platform: "darwin",
      isPackaged: true,
      devAutoUpdateEnabled: false,
      macHasDesignatedRequirement: false,
    }),
    false,
  );
  // 探测未执行（缺字段）时保守判否：宁可让用户走发布页，也不要点进去没反应
  assert.equal(
    shouldUseInAppAutoUpdate({
      platform: "darwin",
      isPackaged: true,
      devAutoUpdateEnabled: false,
    }),
    false,
  );
});

test("resolveGitHubReleasesPageUrl：稳定通道照旧指向 latest，预览通道不得被送到正式版页", () => {
  assert.equal(
    resolveGitHubReleasesPageUrl("ag-jin", "ZPaPa", "stable"),
    "https://github.com/ag-jin/ZPaPa/releases/latest",
  );

  const previewUrl = resolveGitHubReleasesPageUrl("ag-jin", "ZPaPa", "preview");
  // /releases/latest 会被 GitHub 重定向到最新**正式版**（prerelease 不计入 latest），
  // 预览用户会看不到自己这条通道的产物；必须改指完整发布列表。
  assert.doesNotMatch(previewUrl, /\/latest$/, "预览通道不得指向 latest 正式版页");
  assert.equal(previewUrl, "https://github.com/ag-jin/ZPaPa/releases");
});
