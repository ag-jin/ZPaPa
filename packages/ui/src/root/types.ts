import type { IPlatformService, RemoteTarget, UserInfo } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { ReactNode } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";

export interface RootProps {
  services: IServiceAccessor;
  platform: IPlatformService;
  /** 如果从 main 进程传入则跳过项目选择页 */
  initialWorkspaceAbsPath?: string;
  /** app-owned workspace 展示分类；缺省为真实项目。 */
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  /** 桌面启动时精确 active 的本地 workspace 不可用；仅用于本次 renderer 生命周期。 */
  unavailableWorkspacePath?: string;
  /** 初始 workspace 的身份隔离键，远程工作区需要透传 */
  initialWorkspaceIdentity?: string;
  /** 初始要打开的 task，从全局 task 列表进入时透传 */
  initialTaskId?: string;
  /** Electron renderer 传 true，用于启用自绘标题栏 */
  isDesktop?: boolean;
  /** macOS 桌面端需要给红绿灯按钮预留安全区 */
  isMacDesktop?: boolean;
  /** Windows 桌面端需要展示更准确的资源管理器文案 */
  isWindowsDesktop?: boolean;
  /** 是否恢复上次关闭时的标签页，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** 是否允许访问本地设置服务，远程窗口 false */
  supportsSettings?: boolean;
  /** 是否允许在当前壳层里切换/新开工作区 */
  allowOpenWorkspace?: boolean;
  /** 是否优先使用服务端目录浏览器，Web 普通模式不能依赖系统目录选择框 */
  preferDirectoryBrowser?: boolean;
  /** 是否支持 Electron 内嵌浏览器 side pane，默认仅桌面端支持 */
  supportsEmbeddedBrowser?: boolean;
  /** 是否启用远程工作区能力，Web 普通模式先只支持本地 server 工作区 */
  allowRemoteWorkspace?: boolean;
  /** 非桌面入口初始 workspace 注入前继续展示的 loading，桌面端不使用 */
  initialWorkspaceLoadingFallback?: ReactNode;
  /** Assistant code-comment 卡片灰度；默认关闭，关闭时保留原始 directive。 */
  assistantCodeCommentCardsEnabled?: boolean;
}

/**
 * 设备级连接能力：由 Root 注入，供设置页「远程设备」区块调用。
 *
 * 抽成独立类型是因为它要穿过 Root → RootWorkspaceContent → WorkspaceSettingsLayer
 * → SettingsPage 四层。此前只在 Root 内直传给 SettingsPage，而设置页实际渲染走的是
 * WorkspaceSettingsLayer 那条路径，prop 在中间层被丢掉，表现为点击「连接」时报
 * 「当前环境不支持远程设备连接」（日志里 hasConnectCapability: false）。
 */
export type RemoteDeviceConnect = (target: RemoteTarget) => Promise<{
  /** 设备级会话 id：设置页据此把连接登记进 deviceSessionStore（连接归设备所有）。 */
  sessionId: string;
  services: unknown;
  /**
   * 把设备项目同步为投射条目（见 ADR 0001）。
   *
   * `keepFocus`：只把投射条目放进侧边栏，**不抢走当前焦点**（不激活）
   * —— 从设置页发起连接时用，否则每连一次都会被甩进某个项目、
   * 设置页被卸载，用户没法连着调这个功能。缺省仍是激活（侧栏重连的既有语义）。
   */
  syncProjection?: (
    projects: ReadonlyArray<{ path: string; sessionCount: number }>,
    options?: { keepFocus?: boolean },
  ) => unknown;
  dispose?: () => void;
} | null>;

export interface WorkspaceSettingsLayerProps {
  workspaceScopedServices?: IServiceAccessor;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  allowOpenWorkspace?: RootProps["allowOpenWorkspace"];
  remoteDeviceConnect?: RemoteDeviceConnect;
  /**
   * 打开「远程连接」弹窗（新增远程设备时用）。
   * 连接表单由该弹窗负责（SSH 全套字段 + 目录步的「作为设备连接」），
   * 设置页只呈现已连接设备与项目勾选。
   */
  onOpenRemoteConnection?: (preference?: { preferredKind?: RemoteTarget["kind"]; preferredWslDistro?: string }) => void;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}
