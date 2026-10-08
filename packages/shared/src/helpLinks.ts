// 帮助菜单四个入口统一收口：目标全部指向 ZPaPa GitHub 仓库，
// desktop 主进程与 ui/web 共用同一份字面量，避免复制后各自漂移。
const ZPAPA_GITHUB_REPOSITORY_URL = "https://github.com/ag-jin/ZPaPa";

/** 产品文档：仓库 README。 */
export const ZPAPA_PRODUCT_DOCS_URL = `${ZPAPA_GITHUB_REPOSITORY_URL}#readme`;

/** 用户社群：仓库 Discussions。 */
export const ZPAPA_COMMUNITY_URL = `${ZPAPA_GITHUB_REPOSITORY_URL}/discussions`;

/** 问题上报 / 提需求：仓库新建 issue 页。 */
export const ZPAPA_ISSUE_NEW_URL = `${ZPAPA_GITHUB_REPOSITORY_URL}/issues/new`;
