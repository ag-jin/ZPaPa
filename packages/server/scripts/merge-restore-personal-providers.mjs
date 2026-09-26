#!/usr/bin/env node
/**
 * 恢复个人 Provider 配置(合并式,不覆盖用户新增条目),并提供跨机生成模式。
 *
 * 背景:连通性探针用空 envelope 调了 provisioning apply()(写接口),把
 * provider_config.json 覆盖为空、并删除了 allowlist 内的 OAuth 凭据。
 * 旧 config.json(产品自身的迁移源)完整保留,本脚本复用产品迁移器
 * (readLegacyZCodeConfigProviders + importLegacyPersonalProviderConfig)
 * 生成条目,再与现有文件合并。
 *
 * 用法:
 *   # 本机恢复:读 ~/.zcode/v2/config.json,合并写回 provider_config.json
 *   node scripts/merge-restore-personal-providers.mjs [--home=<dir>] [--write]
 *
 *   # 跨机生成:读对端的 config.json,输出可整份拷到对端的 provider_config.json
 *   # (对端常无仓库/Node,必须在本机生成规范格式后再传)
 *   node scripts/merge-restore-personal-providers.mjs --legacy=<path> --out=<path>
 *
 * 默认 dry-run;--write 才落盘(先备份 .pre-restore.bak)。
 *
 * 关键约束:严禁手写 api.type。产品只接受
 * anthropic-messages | openai-chat-completions | openai-responses;
 * 手写成 openai-compatible 之类旧枚举会让对端 ZodError、个人配置整体降级为空
 * (曾因此让 B 端恢复失效)。所有输出都经 encodeProviderConfigFile 生成,
 * 并由 assertValidApiFormats 在落盘前拦截。
 */
import { readFile, writeFile, rename, copyFile, mkdir, copyFile as cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const VALID_API_FORMATS = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

/** 落盘前拦截:手写旧枚举会解析失败并让整份个人配置降级为空。 */
function assertValidApiFormats(rules) {
  const bad = rules.filter((rule) => !VALID_API_FORMATS.includes(rule.config?.api?.type));
  if (bad.length > 0) {
    throw new Error(
      `非法 api.type(产品仅接受 ${VALID_API_FORMATS.join(" | ")}):` +
        bad.map((rule) => `${rule.providerId}=${rule.config?.api?.type}`).join(", "),
    );
  }
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const homeArg = process.argv.find((a) => a.startsWith("--home="));
const home = homeArg ? homeArg.slice("--home=".length) : homedir();
const legacyArg = process.argv.find((a) => a.startsWith("--legacy="));
const outArg = process.argv.find((a) => a.startsWith("--out="));
const crossMachine = Boolean(legacyArg && outArg);
const target = crossMachine
  ? outArg.slice("--out=".length)
  : join(home, ".zcode", "v2", "provider_config.json");

// 跨机模式:对端的 config.json 先落到临时数据目录,再让产品读者去读它。
// services/paths.ts 在模块加载时读 ZCODE_DATA_BASE_DIR,故必须在 tsImport 之前设置。
let crossMachineHome = null;
if (crossMachine) {
  crossMachineHome = join(tmpdir(), `zpapa-restore-${process.pid}`);
  await mkdir(join(crossMachineHome, ".zcode", "v2"), { recursive: true });
  await copyFile(legacyArg.slice("--legacy=".length), join(crossMachineHome, ".zcode", "v2", "config.json"));
  process.env.ZCODE_DATA_BASE_DIR = crossMachineHome;
} else if (home !== homedir()) {
  process.env.ZCODE_DATA_BASE_DIR = home;
}

const { readLegacyZCodeConfigProviders } = await tsImport(
  pathToFileURL(
    join(packageRoot, "../services/src/model-provider/legacyZCodeConfigProviderReader.ts"),
  ).href,
  import.meta.url,
);
const { importLegacyPersonalProviderConfig } = await tsImport(
  pathToFileURL(
    join(packageRoot, "../services/src/model-provider/legacyPersonalProviderConfigImporter.ts"),
  ).href,
  import.meta.url,
);
const { encodeProviderConfigFile } = await tsImport(
  pathToFileURL(join(packageRoot, "../provider-node/src/provider-config-file-codec.ts")).href,
  import.meta.url,
);

const legacy = await readLegacyZCodeConfigProviders();
// 迁移器只保留旧 store 里仍属用户意图的自定义 Provider(内置/账号由当前 Builtin 重建)。
const imported = importLegacyPersonalProviderConfig({ legacyProviders: legacy });
const importedFile = encodeProviderConfigFile(imported);
const importedRules = importedFile.config.providerConfigRules.providerRules;
const importedModels = importedFile.config.modelConfigRules;
console.log(`[restore] legacy custom providers imported: ${importedRules.length}`);
for (const rule of importedRules) {
  console.log(`   - ${rule.providerId} (${rule.providerName ?? "?"}) group=${rule.config?.group}`);
}

// 跨机模式:输出即对端最终文件(对端通常为空),不与本地文件合并。
if (crossMachine) {
  assertValidApiFormats(importedRules);
  console.log(
    `[restore] cross-machine: ${importedRules.length} providers, ${(importedModels?.providerModelRules ?? []).length} model rules`,
  );
  await writeFile(target, JSON.stringify(importedFile, null, 2), { mode: 0o600 });
  console.log(`[restore] ✅ wrote ${target}(拷到对端 ~/.zcode/v2/provider_config.json 后 chmod 600)`);
  process.exit(0);
}

const current = JSON.parse(await readFile(target, "utf8"));
const currentConfig = current?.config ?? current;
const currentRules = currentConfig?.providerConfigRules?.providerRules ?? [];
const currentIds = new Set(currentRules.map((rule) => rule.providerId));
console.log(
  `[restore] current providers kept: ${currentRules.map((r) => r.providerId).join(", ") || "(none)"}`,
);

const added = importedRules.filter((rule) => !currentIds.has(rule.providerId));
console.log(`[restore] to append: ${added.map((r) => r.providerId).join(", ") || "(nothing)"}`);

const mergedRules = [...currentRules, ...added];
const currentModelRules = currentConfig?.modelConfigRules ?? {};
const providerModelRules = [...(currentModelRules.providerModelRules ?? [])];
const seen = new Set(providerModelRules.map((rule) => `${rule.providerId}::${rule.modelId}`));
for (const rule of importedModels?.providerModelRules ?? []) {
  const key = `${rule.providerId}::${rule.modelId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  providerModelRules.push(rule);
}
const manualRules = currentModelRules.manualProviderModelRules ?? [];

const order = currentConfig?.providerOrder ?? [];
const orderSet = new Set(order);
const mergedOrder = [
  ...order,
  ...mergedRules.map((rule) => rule.providerId).filter((id) => !orderSet.has(id)),
];

const next = {
  schemaVersion: 1,
  config: {
    ...(mergedOrder.length > 0 ? { providerOrder: mergedOrder } : {}),
    providerConfigRules: { providerRules: mergedRules },
    modelConfigRules: { providerModelRules, manualProviderModelRules: manualRules },
  },
};
assertValidApiFormats(mergedRules);
const text = JSON.stringify(next, null, 2);
console.log(
  `[restore] result: ${mergedRules.length} providers, ${providerModelRules.length} model rules, order=[${mergedOrder.join(", ")}]`,
);

if (added.length === 0) {
  console.log("[restore] nothing to append");
  process.exit(0);
}
if (!write) {
  console.log("[restore] dry run — 加 --write 才落盘");
  process.exit(0);
}

await copyFile(target, `${target}.pre-restore.bak`);
console.log(`[restore] backup written: ${target}.pre-restore.bak`);
const tmp = `${target}.restore-tmp`;
await writeFile(tmp, text, { mode: 0o600 });
await rename(tmp, target);
console.log(`[restore] ✅ wrote ${target}`);
