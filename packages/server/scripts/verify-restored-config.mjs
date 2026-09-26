#!/usr/bin/env node
/** 校验恢复后的 provider_config.json 能被产品自身解码器正常解析(不写盘)。 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ?? join(homedir(), ".zcode/v2/provider_config.json");
const { decodeProviderConfigFile } = await tsImport(
  pathToFileURL(join(packageRoot, "../provider-node/src/provider-config-file-codec.ts")).href,
  import.meta.url,
);
const decoded = decodeProviderConfigFile(JSON.parse(await readFile(target, "utf8")));
const rules = decoded.providers.toJSON();
console.log(`[verify] ${target}`);
console.log(`[verify] ✅ decoded ok, providers=${Object.keys(rules).length}`);
for (const [id, rule] of Object.entries(rules)) {
  console.log(`   - ${id} group=${rule.config?.group} models=${(rule.config?.personalModelIds ?? []).length}`);
}
