/**
 * 项目看板面板的读取注入点（卡 #32）。
 *
 * 契约义务（`.zcode/board/board-consumption-contract.md` §0/§1/§7.3/§7.6）：
 * 按固定路径直读 `<工作目录>/.zcode/board/board.json`；读不到 / 解析失败 / 版本不认识
 * 分别按空态 A/C 呈现，不得静默或空白。读取经既有文件服务缝（renderer 不碰文件系统），
 * 本模块只依赖一个最小端口，便于在测试中注入假件。
 */
import type { FileTextSlice } from "@zcode/shared";
import { joinFilePath } from "@/lib/path.js";
import { parseBoardJson, type BoardViewModel } from "./boardViewModel.js";

/** 固定读取点（契约 §0/§7.3）：不做全局注册表、不看 `~/.zcode`。 */
export const BOARD_JSON_RELATIVE_PATH = ".zcode/board/board.json";

/**
 * 读取上限＝文件服务文本读的硬上限。
 * 来源（单一真源）：`packages/services/src/file/fileService.ts:32-33` 的
 * `DEFAULT_TEXT_READ_BYTES = 128 * 1024` / `MAX_TEXT_READ_BYTES = 256 * 1024`；
 * 同值先例 `packages/ui/src/lib/codeViewer.ts:25` 的 `FILE_VIEWER_MAX_TEXT_BYTES`
 * （PreviewPane 读取时显式传该值）。这里不 import 该先例：board 读取只依赖一个最小端口，
 * 不为一个数字把 codeViewer 的重依赖（shiki 等）拉进本模块。
 *
 * 必须显式传：服务默认上限只有 128 KiB，不传会把 ≥128 KiB 的合法板截断，
 * 而板是活动物（本工作区真实板已 60 KB 量级），越线只是时间问题。
 */
export const BOARD_JSON_MAX_READ_BYTES = 256 * 1024;

export function resolveBoardJsonPath(workspacePath: string): string {
  return joinFilePath(workspacePath, BOARD_JSON_RELATIVE_PATH);
}

/** IFileService 的最小投影：本面板只用「存在性检查 + 读文本」。 */
export interface BoardFileServicePort {
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
}

/** 面板四态：missing=空态 A；empty=空态 B；damaged=空态 C；ready=可渲染。 */
export type BoardLoadState =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "damaged" }
  | { kind: "ready"; board: BoardViewModel };

/** 面板对外状态：加载中 + 四态。 */
export type BoardPaneLoadState = { kind: "loading" } | BoardLoadState;

/** 与 PreviewPane 的缺失文件判定同一约定：RPC 错误带 code 或文案 ENOENT。 */
export function isBoardFileMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
}

export async function loadBoardDocument(params: {
  fileService: BoardFileServicePort;
  workspacePath: string;
}): Promise<BoardLoadState> {
  const boardPath = resolveBoardJsonPath(params.workspacePath);

  let exists = false;
  try {
    const [existence] = await params.fileService.checkFilesExist({ paths: [boardPath] });
    exists = existence?.exists === true;
  } catch {
    // 存在性检查本身失败（如 host 断连）：读不到就按空态 C 呈现，不假装没有板。
    return { kind: "damaged" };
  }
  if (!exists) {
    return { kind: "missing" };
  }

  let content: string;
  try {
    const file = await params.fileService.readTextFile({
      path: boardPath,
      offset: 0,
      length: BOARD_JSON_MAX_READ_BYTES,
    });
    if (file.truncated) {
      // 「读不全」与「解析失败」分开：读取成功但内容被 256 KiB 硬上限截断时，不解析这个
      // 前缀（它可能恰好能解析，会把不完整的板静默当完整的板渲染），按空态 C 呈现。
      // 残余限制（如实留痕，不发明词条）：>256 KiB 的板超出本期契约 §2 的三空态词条范围，
      // 暂借空态 C 兜底；后续若为「板过大」立项，替换此分支的呈现即可。
      return { kind: "damaged" };
    }
    content = file.content;
  } catch (error) {
    // 检查通过后文件消失（竞态）仍属「无板」；其余读取失败归空态 C。
    return isBoardFileMissingError(error) ? { kind: "missing" } : { kind: "damaged" };
  }

  const outcome = parseBoardJson(content);
  if (outcome.kind === "ready") {
    return { kind: "ready", board: outcome.board };
  }
  return { kind: outcome.kind === "empty" ? "empty" : "damaged" };
}
