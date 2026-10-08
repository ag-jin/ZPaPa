import { ZPAPA_ISSUE_NEW_URL, type IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

interface HelpMenuActionHandlers {
  openIssueReport: () => void;
  openFeatureRequest: () => void;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    // 帮助菜单里「问题上报」与「提需求」都直达仓库新建 issue 页；
    // 内置反馈中心只保留错误横幅等入口，不再从帮助菜单进入。
    openIssueReport: () => {
      platform.openExternal(ZPAPA_ISSUE_NEW_URL);
    },
    openFeatureRequest: () => {
      platform.openExternal(ZPAPA_ISSUE_NEW_URL);
    },
    openProductDocs: () => {
      platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
