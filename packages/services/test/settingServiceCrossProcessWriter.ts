import type { AppSettings } from "@zcode/shared";
import { createSettingService } from "../src/setting/settingService.js";

/**
 * 卡 #177（63-1）跨进程写竞态夹具的**子进程写者**。用真实 settingService 对共享的
 * `setting.json` 写一次，模拟「其它进程也在写同一份设置文件」：
 *   node --import tsx settingServiceCrossProcessWriter.ts <home> <patchJson>
 * home 经 `ZCODE_DESKTOP_HOME_DIR` 传入，与 settingService 的路径解析口径一致。
 *
 * 注意：`node --test` 的裸发现会把 `test/` 下所有文件当测试文件收走（实测量到），
 * 因此无参数调用（裸发现场景）必须无副作用地正常结束；带参但缺参才按用法错误退出。
 */
const [, , home, patchJson] = process.argv;
if (home !== undefined || patchJson !== undefined) {
  if (!home || !patchJson) {
    console.error("usage: settingServiceCrossProcessWriter.ts <home> <patchJson>");
    process.exit(2);
  }
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  await createSettingService().update(JSON.parse(patchJson) as Partial<AppSettings>);
}
