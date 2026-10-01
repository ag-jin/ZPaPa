import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGED_DYNAMIC_WORKFLOW_MODE,
  resolveDynamicWorkflowModeHostEnv,
} from "../src/main/dynamicWorkflowModeHostEnv.js";

/**
 * 动态工作流灰度在桌面 host 环境里的落值契约。
 *
 * 这组判定的失效方式是**静默丢功能**：值没写下去（或被本机变量顶掉），
 * Host 端 resolveDynamicWorkflowClientConfig 就 fallback 到 disabled，
 * 自动化页的「工作流」标签与下发给模型的九个工具一并消失 —— 用户看到的就是
 * 「工作流功能怎么没了」（2026-10-01 实测症状）。所以逐条锁定。
 */

test("打包档位：写入固定值，不看 shell（本 fork 的 production 也开）", () => {
  for (const inheritedValue of [undefined, "disabled", "onDemand", "alwaysOn"]) {
    assert.deepEqual(
      resolveDynamicWorkflowModeHostEnv({ inheritedValue, isPackaged: true }),
      { ZCODE_DYNAMIC_WORKFLOW_MODE: PACKAGED_DYNAMIC_WORKFLOW_MODE },
      `打包档位必须写死为 ${PACKAGED_DYNAMIC_WORKFLOW_MODE}：被 shell 值影响等于把灰度交给本机环境变量`,
    );
  }
});

test("打包档位：取值必须是「开」（disabled 会让整块工作流能力消失）", () => {
  const env = resolveDynamicWorkflowModeHostEnv({ inheritedValue: undefined, isPackaged: true });
  const mode = env.ZCODE_DYNAMIC_WORKFLOW_MODE;
  assert.ok(mode !== undefined, "打包档位必须落值 —— 不落值就是这次「工作流没了」的成因");
  assert.notEqual(mode, "disabled", "disabled 会让 Host 判 enabled=false，标签与工具都不下发");
});

test("未打包 dev：透传 shell 里的合法取值，方便手工切档", () => {
  assert.deepEqual(
    resolveDynamicWorkflowModeHostEnv({ inheritedValue: "onDemand", isPackaged: false }),
    { ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand" },
  );
});

test("未打包 dev：非法取值直接丢弃，不转发给 Host", () => {
  for (const inheritedValue of [undefined, "", "  ", "on", "true", "ALWAYS_ON"]) {
    assert.deepEqual(
      resolveDynamicWorkflowModeHostEnv({ inheritedValue, isPackaged: false }),
      {},
      `非法值 ${JSON.stringify(inheritedValue)} 必须落空，而不是原样穿透`,
    );
  }
});
