/**
 * 项目看板面板的读取注入点（卡 #32；错误态四态分离见卡 #70）。
 *
 * 契约义务（`.zcode/board/board-consumption-contract.md` §0/§1/§2/§7.3/§7.6/§14）：
 * 按固定路径直读 `<工作目录>/.zcode/board/board.json`；读不到 / 版本过新 / 版本过旧 /
 * JSON 损坏 / 文件过大分别成态呈现，不得静默或空白。读取经既有文件服务缝（renderer 不碰文件系统），
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

/**
 * 面板占位态（卡 #70 四态分离后）：
 * - missing=空态 A；empty=空态 B；damaged=损坏态（JSON 解析失败 / 结构非法 / 读取失败）；
 * - version-newer=板版本过新（提示升级应用/技能）；version-older=板版本过旧（提示重编译）；
 * - too-large=板文件超过读取上限被截断（不部分渲染；独立词条，不借损坏态）；
 * - ready=可渲染。
 * `unavailable` = **暂时不可读**（RPC 未就绪 / 断连），与 damaged 分开（评审 #32-P3）：
 * 断连不是板的错，指引「重编译」在断连时是假动作。
 */
export type BoardLoadState =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "damaged" }
  | { kind: "version-newer"; version: number }
  | { kind: "version-older"; version: number }
  | { kind: "too-large" }
  | { kind: "unavailable" }
  | { kind: "ready"; board: BoardViewModel };

/** 面板对外状态：ready 之外为占位态（8 态）——loading、missing/empty、damaged、version-newer/version-older、too-large、unavailable。 */
export type BoardPaneLoadState = { kind: "loading" } | BoardLoadState;

/**
 * 连接门禁（评审 #32-P3）：RPC 未就绪（`connectionKind === "remote-waiting"`）时不发读取。
 * 收**回调**而不是布尔：断连可能发生在读取途中，失败后要能再探一次（调用方读最新连接态）。
 */
export type BoardRpcReadyGate = () => boolean;

const ALWAYS_RPC_READY: BoardRpcReadyGate = () => true;

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
  /** 连接门禁（缺省视为就绪）：未就绪 → 不发 RPC，呈现「暂时不可读」。 */
  isRpcReady?: BoardRpcReadyGate;
}): Promise<BoardLoadState> {
  const boardPath = resolveBoardJsonPath(params.workspacePath);
  const isRpcReady = params.isRpcReady ?? ALWAYS_RPC_READY;
  if (!isRpcReady()) {
    // 断连代理上的请求只会得到可恢复错误；直接给「暂时不可读」，不误判成损坏。
    return { kind: "unavailable" };
  }

  let exists = false;
  try {
    const [existence] = await params.fileService.checkFilesExist({ paths: [boardPath] });
    exists = existence?.exists === true;
  } catch {
    // 存在性检查本身失败（如 host 断连）：读不到就按损坏态（C3）呈现，不假装没有板。
    return isRpcReady() ? { kind: "damaged" } : { kind: "unavailable" };
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
      // 前缀（它可能恰好能解析，会把不完整的板静默当完整的板渲染），按「文件过大」独立态
      // 呈现（卡 #70（d）：E5 推演的增长面——词条独立、指引指向应用侧能力，不借损坏态）。
      return { kind: "too-large" };
    }
    content = file.content;
  } catch (error) {
    // 检查通过后文件消失（竞态）仍属「无板」；读取途中断连按「暂时不可读」；
    // 连接仍在的其余读取失败归损坏态（C3）（评审 #32-P3）。
    if (isBoardFileMissingError(error)) return { kind: "missing" };
    return isRpcReady() ? { kind: "damaged" } : { kind: "unavailable" };
  }

  const outcome = parseBoardJson(content);
  switch (outcome.kind) {
    case "ready":
      return { kind: "ready", board: outcome.board };
    case "empty":
      return { kind: "empty" };
    case "version-newer":
      return { kind: "version-newer", version: outcome.version };
    case "version-older":
      return { kind: "version-older", version: outcome.version };
    // 显式列 damaged、不留 default：将来给 BoardParseOutcome 加新 kind 时这里会亮 tsc 错，
    // 而不是被 default 静默吞成损坏态（评审 CR-S2）。
    case "damaged":
      return { kind: "damaged" };
  }
}
