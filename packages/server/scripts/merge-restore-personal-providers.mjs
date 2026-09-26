#!/usr/bin/env node
/**
 * 合并恢复个人 Provider 配置:把旧 config.json 里的自定义 provider 补回
 * provider_config.json,保留文件里已有的条目(不覆盖用户新增的)。
 *
 * 背景:连通性探针用空 envelope 调了 provisioning apply()(写接口),把
 * provider_config.json 覆盖为空、并删除了 allowlist 内的 OAuth 凭据。
 * 旧 config.json(产品自身的迁移源)完整保留,本脚本复用产品迁移器
 * (readLegacyZCodeConfigProviders + importLegacyPersonalProviderConfig)
 * 生成条目,再与现有文件合并。
 *
 * 用法:
 *   node scripts/merge-restore-personal-providers.mjs [--home=<dir>] [--write]
 * 默认 dry-run;加 --write 才落盘(先备份 .pre-restore.bak)。
 * 注意:--home 必须在 tsImport 之前设置 ZCODE_DATA_BASE_DIR(模块加载时读取)。
 */
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");
const homeArg = process.argv.find((a) => a.startsWith("--home="));
const home = homeArg ? homeArg.slice("--home=".length) : homedir();
// provider-node/paths.js 在模块加载时读 env,故须先于 tsImport 设置。
if (home !== homedir()) process.env.ZCODE_DATA_BASE_DIR = home;
const target = join(home, ".zcode", "v2", "provider_config.json");

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
