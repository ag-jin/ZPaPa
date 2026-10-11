/**
 * 卡片引用派发浏览器断言的**页面入口**（卡 #186；由 `boardCardDispatchBrowser.ts` 读入并打成 bundle）。
 *
 * 页面挂两块同屏（复刻真实布局：看板侧面板与聚焦会话并存）：
 * - `#composer`：真 `ChatPromptEditor`（会话输入框，Lexical contenteditable）；
 * - `#board`：真 `BoardPane` 面板（读假文件服务的板切片）。
 *
 * 消费接线复刻 SessionPane 的形状，但判定与落地都调**真实单点**：
 * `selectComposerTextInsertRequest`（目标判定）→ `applyExternalTextInsertRequestToComposer`（落地）
 * → `clearComposerTextInsertRequest`（应用后清理）。驱动侧不重算任何业务判据。
 */
/// <reference types="vite/client" />
import { useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BoardPane } from "@/board/BoardPane.js";
import { resolveBoardJsonPath } from "@/board/loadBoardDocument.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { IPlatformService } from "@zcode/shared";
import type { IFileService, IServiceAccessor, ISettingService } from "@zcode/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyExternalTextInsertRequestToComposer,
  selectComposerTextInsertRequest,
} from "@/v4/composer/composerTextInsert.js";

declare global {
  // eslint-disable-next-line no-var
  var __BOARD_JSON__: string | undefined;
  // eslint-disable-next-line no-var
  var __CARD_DISPATCH_PROBE__:
    | (() => {
        requestText: string | null;
        fileCalls: { reads: number; writes: number };
      })
    | undefined;
}

const WORKSPACE_PATH = "/fake/watch-workspace";
/** 聚焦面绑定的会话（当前焦点会话）；目标判定走真实 selector，不在此重写规则。 */
const FOCUSED_SESSION_ID = "sess-focused-186";
const boardPath = resolveBoardJsonPath(WORKSPACE_PATH);
const boardJson = globalThis.__BOARD_JSON__ ?? "";
const slice = {
  path: boardPath,
  content: boardJson,
  offset: 0,
  bytesRead: boardJson.length,
  totalBytes: boardJson.length,
  truncated: false,
  isBinary: false,
};

/* 板文件读写金丝雀：读计数 + 任何写尝试计数（写方法一律抛错——面板不得写板）。 */
const fileCalls = { reads: 0, writes: 0 };
const fileService = {
  checkFilesExist: async (params: { paths: string[] }) => {
    fileCalls.reads += 1;
    return params.paths.map((filePath) => ({ path: filePath, exists: filePath === boardPath }));
  },
  readTextFile: async () => {
    fileCalls.reads += 1;
    return slice;
  },
  writeTextFile: async () => {
    fileCalls.writes += 1;
    throw new Error("看板面板不得写板文件");
  },
  deleteFile: async () => {
    fileCalls.writes += 1;
    throw new Error("看板面板不得写板文件");
  },
  moveFile: async () => {
    fileCalls.writes += 1;
    throw new Error("看板面板不得写板文件");
  },
} as unknown as IFileService;

/** 会话输入框宿主（复刻 SessionPane 消费形状；判定/落地/清理都调真实函数）。 */
function ComposerHost() {
  const request = useZCodeSessionStore(
    (state) => state.getWorkspaceState(WORKSPACE_PATH).composerTextInsertRequest,
  );
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const appliedRef = useRef<number | null>(null);
  useEffect(() => {
    const apply = () => {
      const consumed = selectComposerTextInsertRequest({
        request,
        focused: true,
        sessionId: FOCUSED_SESSION_ID,
      });
      if (!consumed || !inputApiRef.current) return;
      appliedRef.current = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedRef.current,
        inputApi: inputApiRef.current,
        request: consumed,
        requestFocus: () => {},
        scheduleDraftPersist: () => {},
        updateText: () => {},
      });
      if (appliedRef.current === consumed.requestId) {
        useZCodeSessionStore
          .getState()
          .clearComposerTextInsertRequest(WORKSPACE_PATH, consumed.requestId);
      }
    };
    apply();
    const timer = setInterval(apply, 50);
    return () => clearInterval(timer);
  }, [request]);
  return (
    <div data-dispatch-composer="">
      <ChatPromptEditor
        workspacePath={WORKSPACE_PATH}
        taskId={null}
        submitLabel=""
        // 本页只驱动草稿文本，不做提交：提交一律拒绝，行为与「未接发送」等价。
        onSubmit={() => false}
        placeholder=""
        initialValue="先看这张卡："
        inputApiRef={inputApiRef}
      />
    </div>
  );
}

/* 页面侧失败诊断：React 渲染错误只在控制台，回传 stdout 才能定位（断言失败时先看这条）。 */
window.addEventListener("error", (event) => {
  const text =
    event.error instanceof Error ? (event.error.stack ?? event.error.message) : String(event.error);
  // 换行折成 " | "：Electron 的 console-message 回传按行过滤，多行栈会被截到第一行。
  console.log("PAGE_ERROR_STACK " + text.replace(/\n/g, " | "));
});

/**
 * 最小平台替身：本页只驱动输入框的**草稿文本**，链上唯一平台用法是
 * `useSettings` 的 `platform.onSettingsChanged?.()` 订阅（`useSettingService` 里）。
 */
const platformStub = {
  onSettingsChanged: () => () => {},
} as unknown as IPlatformService;

/**
 * 最小设置替身：`useSettingService.refreshSettingsStore` 在 settingService 缺省时直接返回快照，
 * 但 `useSettings()` 会 destructure 该服务——给一个 get 返回空设置，避免链上首帧落到异常分支。
 */
const settingServiceStub = { get: async () => ({}) } as unknown as ISettingService;

/**
 * 最小客户端配置替身：`usePluginStoreOrder` 在 `service` 缺省时会出现
 * `undefined === undefined` 命中「快照服务一致」分支并读 `snapshot.order`（真应用必有该服务）；
 * 给一个返回空排序的快照，让插件 mention 提供器照常返回空目录。
 */
const clientConfigServiceStub = {
  getSnapshot: async () => ({ pluginStoreOrder: null }),
} as unknown as IServiceAccessor["clientConfigService"];

/** 服务替身集合（本页只用到这一组；缺省成员由消费方按可选访问处理）。 */
const servicesStub = {
  fileService,
  settingService: settingServiceStub,
  clientConfigService: clientConfigServiceStub,
} as unknown as IServiceAccessor;

function Providers({ children }: { children: ReactNode }) {
  // TooltipProvider：与 Root 同款的根层注入（输入框工具栏的 tooltip 需要）。
  return (
    <TooltipProvider>
      <ServiceProvider services={servicesStub}>
        <PlatformProvider platform={platformStub}>
          <TabStoreProvider>
            <ZCodeIntlProvider initialLocale="zh-CN">{children}</ZCodeIntlProvider>
          </TabStoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("composer")!).render(
  <Providers>
    <ComposerHost />
  </Providers>,
);
createRoot(document.getElementById("board")!).render(
  <Providers>
    <BoardPane workspacePath={WORKSPACE_PATH} focused />
  </Providers>,
);

globalThis.__CARD_DISPATCH_PROBE__ = () => {
  const request = useZCodeSessionStore
    .getState()
    .getWorkspaceState(WORKSPACE_PATH).composerTextInsertRequest;
  return { requestText: request ? request.text : null, fileCalls };
};
