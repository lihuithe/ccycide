/**
 * 前后端契约：前端（apps/desktop/src）与 Tauri Rust 侧（apps/desktop/src-tauri）之间的全部类型。
 *
 * 约定
 * - JSON 字段一律 camelCase；Tauri 命令名一律 snake_case；命令参数对象的键也是 camelCase（Tauri 2 默认行为）。
 * - 各种 ID（sessionId / termId / fileId / noticeId / reqId）在 JS 侧一律是 string。
 *   Rust 侧的 u64 用 `#[serde(with = "...")]` 序列化成十进制字符串。
 * - 字节计数（seq / consumed / size / sent / total）是 JS number（< 2^53，够用），Rust 侧 u64 直接序列化为数字。
 * - 命令失败时 Rust 返回 `Err(CommandError)`（推荐，serde 序列化为 `{code, message}`），
 *   或 `Err(String)`（中文短句，前端当作 `code = "UNKNOWN"`）。
 * - 低频事件：Rust `app.emit("core-event", CoreEvent)`；`CoreEvent` 是以 `type` 为标签的联合
 *   （`#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]`）。
 * - 终端输出：不走事件，走 `tauri::ipc::Channel<InvokeResponseBody>`，见 `TermOutputFrame`。
 */

// ———————————————————— 基础 ————————————————————

export type SessionId = string;
export type TermId = string;
/** u64 的字符串形式 */
export type FileId = string;

export interface CommandError {
  /** 机器可读的错误码，见 ErrorCodes */
  code: string;
  /** 给用户看的中文短句 */
  message: string;
}

/** 前端会专门处理的错误码（其余只显示 message） */
export const ErrorCodes = {
  /** 连接：设备码不存在或不在线 */
  UNAVAILABLE: 'UNAVAILABLE',
  REJECTED: 'REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  LOCKED: 'LOCKED',
  VERSION: 'VERSION',
  BANNED: 'BANNED',
  NO_RELAY: 'NO_RELAY',
  PASSWORD_WRONG: 'PASSWORD_WRONG',
  /** 网络不通、信令离线 */
  NETWORK: 'NETWORK',
  /** connect 被 cancel_connect 取消（用户在“等待对方确认”时点了取消）；前端静默处理，不显示错误 */
  CANCELLED: 'CANCELLED',
  /** 会话不在 Ready 状态（重连中/已关闭）时调用 term_submit / term_input / open_term */
  NOT_READY: 'NOT_READY',
  /** upload_path 收到目录 */
  IS_DIRECTORY: 'IS_DIRECTORY',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_DISABLED: 'FILE_DISABLED',
  /** 读取剪贴板失败（Wayland 等） */
  CLIPBOARD_UNAVAILABLE: 'CLIPBOARD_UNAVAILABLE',
  /** term_action 的错误码（18.6） */
  UNSUPPORTED: 'UNSUPPORTED',
  BAD_REQUEST: 'BAD_REQUEST',
  APP_NOT_RUNNING: 'APP_NOT_RUNNING',
  TERM_NOT_FOUND: 'TERM_NOT_FOUND',
  BUSY: 'BUSY',
  TERM_LIMIT: 'TERM_LIMIT',
  /** 终端正被另一个设备使用，不能抢占（attach_term 可直接抛出，或以 AppNotice{kind:error,title:"TERM_BUSY"} 到达） */
  TERM_BUSY: 'TERM_BUSY',
  /** 终端已被另一会话接管（同样可经 AppNotice 通道到达） */
  TERM_DETACHED: 'TERM_DETACHED',
  SPAWN_FAILED: 'SPAWN_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

// ———————————————————— 本机（被控）————————————————————

export interface LocalInfo {
  /** 9 位数字，不含空格 */
  deviceCode: string;
  tempPassword: string;
  /** 信令是否在线 */
  online: boolean;
  fixedPasswordSet: boolean;
  appVersion: string;
  /** windows | macos | linux */
  platform: string;
}

/** 来访会话（别人连入本机） */
export interface IncomingSession {
  sessionId: SessionId;
  fromCode: string;
  platform: string;
  /** 毫秒时间戳，连入时刻 */
  startedAt: number;
  /**
   * 开启“连接确认”时为 true：等待本机用户 accept_incoming / reject_incoming。
   * 没有超时：Rust 侧不得自动拒绝，前端也没有倒计时；一直等到用户处理、主控方取消（incomingClosed.reason = cancelled）
   * 或会话因其它原因关闭。可同时存在多个待确认来访，前端排队显示。
   */
  pendingConfirm: boolean;
}

export interface KnownHost {
  deviceCode: string;
  alias?: string;
  /** ISO 时间 */
  lastConnected?: string;
}

// ———————————————————— 设置（对应 17.2 配置文件，扁平化）————————————————————

export type TempPasswordPolicy = 'on_start' | 'after_session' | 'manual';
export type ThemeChoice = 'auto' | 'light' | 'dark';

export interface Settings {
  host: {
    /** 允许被远程连接；false 时信令上报 accept:false（“暂停被控”） */
    enabled: boolean;
    requireConfirm: boolean;
    tempPasswordPolicy: TempPasswordPolicy;
    fileReceive: boolean;
    notifyOnConnect: boolean;
    preventSleepWhenConnected: boolean;
    /**
     * 终端隔离（默认 true）。开启：不同主控设备互相看不到对方开的终端（list_terms 只返回本会话/本设备的）；
     * 关闭：可互相看到并附着。Rust 侧 get_settings / set_settings 必须持久化它，且修改后热生效
     * （对之后的 list_terms / attach_term 立即按新值判定，不需要重启）。
     */
    isolateTerminals: boolean;
    /** Claude Code 集成（hooks 状态回传），关闭后不注入任何参数 */
    claudeIntegration: boolean;
    /** 状态栏注入（上下文用量/费用） */
    claudeStatusline: boolean;
    /** 在所有终端里启用（改动用户级 Claude Code 配置） */
    claudeIntegrationAll: boolean;
  };
  controller: {
    fontSize: number;
    theme: ThemeChoice;
    notifyOnDone: boolean;
    notifyOnPermission: boolean;
  };
  server: {
    useSystemCerts: boolean;
  };
  app: {
    autostart: boolean;
    closeToTray: boolean;
    updateChannel: 'stable' | 'beta';
    crashReport: boolean;
    /** 首次启动安全须知是否已确认 */
    safetyNoticeAcked: boolean;
  };
}

// ———————————————————— 会话 / 终端 ————————————————————

/** 对应 Rust SessionState。Closed 的原因放在 reason / reasonCode */
/**
 * 对应 Rust SessionState。
 * awaitingApproval：对方设置了“连接确认”，正在等对方点同意；没有超时，直到对方处理或主控端取消。
 * 它既可出现在 connect 进行中（此时事件带 requestId，见 CoreEvent.sessionState），也可出现在已存在会话的重连过程中。
 */
export type SessionPhase = 'connecting' | 'awaitingApproval' | 'ready' | 'reconnecting' | 'closed';

/** incomingClosed 的原因 */
export type IncomingClosedReason =
  /** 待确认阶段结束且已同意：条目保留，pendingConfirm 变为 false，会话仍在进行（例如在托盘或别处点了同意） */
  | 'accepted'
  /** 被拒绝（本机用户，或别处代为处理） */
  | 'rejected'
  /** 主控方在等待确认期间取消了请求：前端撤掉该项并提示一次 */
  | 'cancelled'
  /** 已建立的会话结束（对方断开、本机断开、网络错误等） */
  | 'closed';

export interface ShellInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
}

export interface HostInfo {
  platform: string;
  arch: string;
  hostname: string;
  username: string;
  homeDir: string;
  shells: ShellInfo[];
  claudeAvailable: boolean;
  claudeVersion: string;
  maxFileSize: number;
}

/** 对端在 Hello 里声明的能力，未声明的功能界面上不显示 */
export const Features = {
  fileUpload: 'file.upload',
  termSubmit: 'term.submit',
  appActions: 'app.actions',
  appState: 'app.state',
  appCommands: 'app.commands',
} as const;

export type TermProfile = 'shell' | 'claude' | 'custom';

/** 对应 proto LaunchOptions（18.7）。空字符串表示不指定 */
export interface LaunchOptions {
  model: string;
  permissionMode: string;
  effort: string;
  /** '' | 'continue' | 'pick' */
  resume: string;
  sessionName: string;
}

export interface TermOpenParams {
  sessionId: SessionId;
  profile: TermProfile;
  /** 空 = 默认 shell */
  shellId?: string;
  /** 空 = 被控端用户主目录 */
  cwd?: string;
  cols: number;
  rows: number;
  /** profile = custom 时使用 */
  command?: string;
  /** profile = claude 时使用 */
  launch?: LaunchOptions;
}

export interface TermOpened {
  termId: TermId;
  title: string;
  shell: string;
}

export interface TermInfo {
  termId: TermId;
  title: string;
  profile: TermProfile;
  shell: string;
  /** 后端提供时：该终端正被另一个设备使用（不可抢占）。界面显示为占用中，不附着 */
  attachedByOther?: boolean;
}

export interface TermAttachParams {
  sessionId: SessionId;
  termId: TermId;
  cols: number;
  rows: number;
  /** 前端已渲染到的流偏移（TermOutputFrame.seq + data.length），用于续传；全新附着传 0 */
  lastSeq: number;
}

/** 对应 Rust TermModes */
export interface TermModes {
  bracketedPaste: boolean;
  altScreen: boolean;
  appCursor: boolean;
  mouse: boolean;
  title: string;
}

/**
 * 终端输出帧。Rust 经 Channel 发送的原始字节格式（InvokeResponseBody::Raw）：
 *   [ 8 字节 u64 大端：该帧第一个字节在整个输出流里的偏移 seq ][ 终端输出的原始字节 ]
 * 重连时若缓冲区无法衔接，Rust 先发一帧内容为 ESC c (0x1b 0x63) 的帧，再发回放数据，seq 填真实偏移（会跳变）。
 * 前端 ack 的 `consumed` = 最近一帧渲染完成后的 seq + data.length。
 */
export interface TermOutputFrame {
  seq: number;
  data: Uint8Array;
}
export type OutputHandler = (frame: TermOutputFrame) => void;

// ———————————————————— 上传 ————————————————————

export interface UploadStarted {
  fileId: FileId;
  name: string;
  size: number;
}

export interface UploadBytesParams {
  sessionId: SessionId;
  name: string;
  mime: string;
  /**
   * 剪贴板图片的 PNG 字节。
   * Tauri 实现走 invoke 的原始请求体（`invoke('upload_bytes', uint8array, { headers })`），
   * 元数据放在请求头：`x-session-id`、`x-name`（encodeURIComponent）、`x-mime`。
   * Rust 侧用 `tauri::ipc::Request` 读取 `InvokeBody::Raw`。
   */
  data: Uint8Array;
}

// ———————————————————— 动作目录（对应 proto ActionCatalog，18.10）————————————————————

export type ActionPlacement = 'toolbar' | 'menu' | 'palette_only';
export type ActionKind = 'submit' | 'keys' | 'interactive';
export type ActionEnabledWhen = '' | 'busy' | 'idle';
export type ParamType = 'enum' | 'text' | 'path';

export interface ActionParam {
  name: string;
  label: string;
  type: ParamType;
  /** 引用 ActionCatalog.options 的键 */
  optionsRef: string;
  allowCustom: boolean;
  required: boolean;
  defaultValue: string;
  /** 可选扩展：自定义值的校验正则；缺省用前端默认规则 */
  pattern?: string;
}

export interface ActionDef {
  id: string;
  title: string;
  group: string;
  placement: ActionPlacement;
  kind: ActionKind;
  params: ActionParam[];
  /** 非空表示执行前要确认，内容是提示语 */
  confirm: string;
  note: string;
  enabledWhen: ActionEnabledWhen;
}

export interface ParamOption {
  value: string;
  label: string;
}

export interface ActionCatalog {
  catalogVer: string;
  app: string;
  actions: ActionDef[];
  options: Record<string, ParamOption[]>;
}

/** term_action 的返回（对应 TermActionResult，仅 ok 时返回，失败抛 CommandError） */
export interface ActionOutcome {
  /** interactive 动作：主控端进入临时直通 */
  passthrough: boolean;
  returnKeys: string[];
}

// ———————————————————— 状态回传（proto AppState / AppNotice / CommandList）————————————————————

export type Activity = 'idle' | 'busy' | 'waiting_permission';

export interface AppState {
  /** "claude"；空表示该终端里没有运行已知应用 */
  app: string;
  running: boolean;
  /** 是否有状态回传；false 时下面的字段无意义 */
  stateful: boolean;
  version: string;
  activity: Activity;
  model: string;
  modelId: string;
  effort: string;
  fastMode: boolean;
  thinking: boolean;
  /** 0-100，hasContext 为 false 时无意义 */
  contextUsedPct: number;
  hasContext: boolean;
  cwd: string;
  sessionId: string;
  sessionName: string;
  costUsd: number;
}

export type NoticeKind = 'permission' | 'done' | 'error' | 'need_input';

/**
 * 注意：终端级错误也经 AppNotice 通道到达：kind = 'error'，title 为错误码
 * （TERM_BUSY / TERM_DETACHED / TERM_NOT_FOUND），text 可为空。前端据此切换标签状态，不发系统通知。
 */
export interface AppNotice {
  kind: NoticeKind;
  title: string;
  text: string;
  noticeId: string;
  toolName: string;
  toolSummary: string;
  /** true 表示之前的同 id 通知已失效，撤掉卡片 */
  resolved: boolean;
}

export interface CustomCommand {
  /** 不含斜杠 */
  name: string;
  description: string;
  argumentHint: string;
  /** user | project */
  source: string;
}

export interface CommandList {
  commands: CustomCommand[];
}

// ———————————————————— 事件 ————————————————————

export type CoreEvent =
  | { type: 'signalState'; online: boolean }
  | ({ type: 'incomingSession' } & IncomingSession)
  | { type: 'incomingClosed'; sessionId: SessionId; reason: IncomingClosedReason }
  | {
      type: 'sessionState';
      /** connect 进行中（尚未返回 sessionId）时为空字符串，前端用 requestId 对应 */
      sessionId: SessionId;
      /**
       * 仅 connect 进行中的状态事件带上：即 connect 命令传入的 requestId。
       * 目前只有 awaitingApproval 需要发（connecting / 握手完成不必发，connect 返回即代表 Ready）。
       */
      requestId?: string;
      state: SessionPhase;
      /** state = closed 时的原因（中文短句） */
      reason?: string;
      /** state = closed 时的错误码，如 PASSWORD_WRONG（此时前端要求重新输入密码） */
      reasonCode?: string;
      /** state = reconnecting 时：第几次重试（从 1 开始） */
      attempt?: number;
      /** state = reconnecting 时：距下次重试的毫秒数 */
      retryInMs?: number;
    }
  /** 往返延迟，Rust 侧由 Ping/Pong 测得，建议每 5 秒上报 */
  | { type: 'latency'; sessionId: SessionId; ms: number }
  | { type: 'hostInfo'; sessionId: SessionId; info: HostInfo; features: string[] }
  | { type: 'termState'; sessionId: SessionId; termId: TermId; state: TermModes }
  | { type: 'termExit'; sessionId: SessionId; termId: TermId; code: number }
  | { type: 'uploadProgress'; sessionId: SessionId; fileId: FileId; sent: number; total: number }
  | { type: 'uploadDone'; sessionId: SessionId; fileId: FileId; remotePath: string }
  | { type: 'uploadFailed'; sessionId: SessionId; fileId: FileId; reason: string }
  | { type: 'actionCatalog'; sessionId: SessionId; catalog: ActionCatalog }
  | { type: 'appState'; sessionId: SessionId; termId: TermId; state: AppState }
  | { type: 'appNotice'; sessionId: SessionId; termId: TermId; notice: AppNotice }
  | { type: 'commandList'; sessionId: SessionId; termId: TermId; list: CommandList }
  /** 托盘菜单（暂停被控/断开全部）等 Rust 侧改动了设置 */
  | { type: 'settingsChanged'; settings: Settings }
  /** 临时密码自动刷新（锁定触发/会话结束后刷新）等 */
  | { type: 'localInfoChanged'; info: LocalInfo };

export type CoreEventType = CoreEvent['type'];

// ———————————————————— 拖放 / 更新 ————————————————————

export type DragDropEvent =
  | { type: 'enter' }
  | { type: 'leave' }
  /** paths 为本地绝对路径 */
  | { type: 'drop'; paths: string[] };

export interface UpdateInfo {
  version: string;
  notes: string;
}

export type Unsubscribe = () => void;
