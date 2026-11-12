/**
 * Backend 接口：前端访问“核心库 + 系统能力”的唯一入口。
 * 三套实现：tauri.ts（真实，invoke/listen/Channel + 插件）、web/web.ts（浏览器里直接实现主控端，VITE_TARGET=web 构建）
 * 与 mock.ts（纯浏览器假后端）。
 *
 * Tauri 命令一览（snake_case，参数键 camelCase；括号内为前端方法名）
 *
 *   local_info                    ()                                   -> LocalInfo                  (localInfo)
 *   refresh_temp_password         ()                                   -> string                     (refreshTempPassword)
 *   set_fixed_password            { password: string | null }          -> ()                         (setFixedPassword)
 *   accept_incoming               { sessionId }                        -> ()                         (acceptIncoming)
 *   reject_incoming               { sessionId }                        -> ()                         (rejectIncoming)
 *   disconnect_incoming           { sessionId }                        -> ()                         (disconnectIncoming)
 *   disconnect_all_incoming       ()                                   -> ()                         (disconnectAllIncoming)
 *   list_known_hosts              ()                                   -> KnownHost[]                (listKnownHosts)
 *   remove_known_host             { deviceCode }                       -> ()                         (removeKnownHost)
 *   get_settings                  ()                                   -> Settings                   (getSettings)
 *   set_settings                  { settings: Settings }               -> Settings                   (setSettings)
 *   connect                       { deviceCode, password, requestId }  -> SessionId                  (connect)
 *   cancel_connect                { requestId }                        -> ()                         (cancelConnect)
 *   disconnect                    { sessionId }                        -> ()                         (disconnect)
 *   open_term                     { sessionId, profile, shellId, cwd, cols, rows, command, launch, onOutput: Channel }
 *                                                                      -> TermOpened                 (openTerm)
 *   list_terms                    { sessionId }                        -> TermInfo[]                 (listTerms)
 *   attach_term                   { sessionId, termId, cols, rows, lastSeq, onOutput: Channel } -> () (attachTerm)
 *   term_input                    { sessionId, termId, data: number[] } -> ()                        (termInput)
 *   term_submit                   { sessionId, termId, text, attachments: FileId[] } -> ()           (termSubmit)
 *   term_resize                   { sessionId, termId, cols, rows }    -> ()                         (termResize)
 *   term_ack                      { sessionId, termId, consumed }      -> ()                         (termAck)
 *   close_term                    { sessionId, termId }                -> ()                         (closeTerm)
 *   upload_path                   { sessionId, path }                  -> UploadStarted              (uploadPath)
 *   upload_bytes                  原始请求体 + 头 x-session-id/x-name/x-mime -> UploadStarted        (uploadBytes)
 *   cancel_upload                 { sessionId, fileId }                -> ()                         (cancelUpload)
 *   read_clipboard_files          ()                                   -> string[]                   (readClipboardFiles)
 *   term_action                   { sessionId, termId, actionId, args: Record<string,string> } -> ActionOutcome (termAction)
 *   command_list_req              { sessionId, termId }                -> ()                         (commandListReq)
 *
 * connect / cancel_connect 约定：
 *   - requestId 是前端生成的任意唯一字符串（crypto.randomUUID）。connect 是等待很久的 invoke（对方设置了连接确认时
 *     不设超时，可能等很久），所以需要 requestId 才能在它返回之前取消。
 *   - 对方设置了连接确认：Rust 在收到对方“等待确认”后发 core-event
 *     { type:'sessionState', sessionId:'', requestId, state:'awaitingApproval' }，connect 继续等待，不设超时。
 *   - cancel_connect{requestId}：取消仍在进行的 connect（通知信令/对方撤销请求，对方侧收到 incomingClosed reason=cancelled）；
 *     被取消的 connect 以 CommandError{code:'CANCELLED'} 失败。requestId 不存在或已结束时静默成功（幂等）。
 *
 * 事件：`core-event`（载荷 CoreEvent）。
 * 前端直接使用的 Tauri 插件（Rust 侧需注册并在 capabilities 中授权）：
 *   dialog（open）、notification、clipboard-manager（writeText）、updater（check/downloadAndInstall）、
 *   process（relaunch）、autostart、opener（openUrl）；窗口拖放事件用 getCurrentWebview().onDragDropEvent。
 */
import type {
  ActionOutcome,
  CommandError,
  CoreEvent,
  DragDropEvent,
  FileId,
  KnownHost,
  LocalInfo,
  OutputHandler,
  SessionId,
  Settings,
  TermAttachParams,
  TermId,
  TermInfo,
  TermOpened,
  TermOpenParams,
  UpdateInfo,
  UploadBytesParams,
  UploadStarted,
  Unsubscribe,
} from './types';

export * from './types';

export interface Backend {
  readonly kind: 'tauri' | 'mock' | 'web';

  // —— 本机（被控）——
  localInfo(): Promise<LocalInfo>;
  refreshTempPassword(): Promise<string>;
  /** null 表示清除固定密码 */
  setFixedPassword(password: string | null): Promise<void>;
  acceptIncoming(sessionId: SessionId): Promise<void>;
  rejectIncoming(sessionId: SessionId): Promise<void>;
  disconnectIncoming(sessionId: SessionId): Promise<void>;
  disconnectAllIncoming(): Promise<void>;
  listKnownHosts(): Promise<KnownHost[]>;
  removeKnownHost(deviceCode: string): Promise<void>;

  // —— 设置 ——
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<Settings>;

  // —— 主控 ——
  /** requestId 由前端生成，用于在 connect 返回前通过 cancelConnect 取消；被取消时抛 CANCELLED */
  connect(deviceCode: string, password: string, requestId: string): Promise<SessionId>;
  cancelConnect(requestId: string): Promise<void>;
  disconnect(sessionId: SessionId): Promise<void>;
  openTerm(params: TermOpenParams, onOutput: OutputHandler): Promise<TermOpened>;
  listTerms(sessionId: SessionId): Promise<TermInfo[]>;
  attachTerm(params: TermAttachParams, onOutput: OutputHandler): Promise<void>;
  termInput(sessionId: SessionId, termId: TermId, data: Uint8Array): Promise<void>;
  termSubmit(sessionId: SessionId, termId: TermId, text: string, attachments: FileId[]): Promise<void>;
  termResize(sessionId: SessionId, termId: TermId, cols: number, rows: number): Promise<void>;
  termAck(sessionId: SessionId, termId: TermId, consumed: number): Promise<void>;
  closeTerm(sessionId: SessionId, termId: TermId): Promise<void>;
  uploadPath(sessionId: SessionId, path: string): Promise<UploadStarted>;
  uploadBytes(params: UploadBytesParams): Promise<UploadStarted>;
  cancelUpload(sessionId: SessionId, fileId: FileId): Promise<void>;
  /** 读取系统剪贴板里的文件列表（文件管理器里复制的文件）；失败抛 CLIPBOARD_UNAVAILABLE */
  readClipboardFiles(): Promise<string[]>;
  termAction(
    sessionId: SessionId,
    termId: TermId,
    actionId: string,
    args: Record<string, string>,
  ): Promise<ActionOutcome>;
  commandListReq(sessionId: SessionId, termId: TermId): Promise<void>;

  // —— 事件 ——
  onEvent(handler: (e: CoreEvent) => void): Promise<Unsubscribe>;
  /** 窗口级文件拖放；Tauri 下给出本地路径 */
  onDragDrop(handler: (e: DragDropEvent) => void): Promise<Unsubscribe>;

  // —— 系统能力（前端直接用 Tauri 插件）——
  /** 文件选择对话框，返回本地路径 */
  pickFiles(): Promise<string[]>;
  copyText(text: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** 系统通知；权限未授予时静默忽略 */
  notify(title: string, body: string): Promise<void>;
  isAutostartEnabled(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  checkUpdate(): Promise<UpdateInfo | null>;
  /** 下载、校验、安装并重启；progress 为 0-1 */
  installUpdate(onProgress: (ratio: number) => void): Promise<void>;
}

/** 是否运行在 Tauri WebView 中 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 是否是 Web 版构建（vite --mode web，VITE_TARGET=web） */
export const isWebTarget = (): boolean => import.meta.env.VITE_TARGET === 'web';

/** 把任意抛出的值规整成 CommandError */
export function toCommandError(e: unknown): CommandError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const o = e as { code: unknown; message: unknown };
    return { code: String(o.code), message: String(o.message) };
  }
  if (e instanceof Error) return { code: 'UNKNOWN', message: e.message };
  return { code: 'UNKNOWN', message: typeof e === 'string' ? e : '操作失败' };
}

let cached: Promise<Backend> | null = null;

/** 按环境选择实现；Tauri 实现按需加载，纯浏览器下不会执行任何 Tauri 调用 */
export function getBackend(): Promise<Backend> {
  cached ??= isTauri()
    ? import('./tauri').then((m) => m.createTauriBackend())
    : isWebTarget()
      ? import('./web/web').then((m) => m.createWebBackend())
      : import('./mock').then((m) => m.createMockBackend());
  return cached;
}
