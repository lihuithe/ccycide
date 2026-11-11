/** Tauri 实现：invoke / listen / Channel 与官方插件。命令清单见 index.ts 顶部注释。 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toCommandError, type Backend } from './index';
import type {
  ActionOutcome,
  CoreEvent,
  KnownHost,
  LocalInfo,
  OutputHandler,
  Settings,
  TermInfo,
  TermOpened,
  UpdateInfo,
  UploadStarted,
} from './types';

/** 调用命令，错误统一成 CommandError */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toCommandError(e);
  }
}

/** 解析 Channel 里的原始帧：前 8 字节大端 seq，其余为数据 */
export function parseOutputFrame(raw: ArrayBuffer | ArrayLike<number>): { seq: number; data: Uint8Array } {
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seq = Number(view.getBigUint64(0, false));
  return { seq, data: bytes.subarray(8) };
}

function makeChannel(onOutput: OutputHandler): Channel<ArrayBuffer> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (raw) => onOutput(parseOutputFrame(raw));
  return ch;
}

export function createTauriBackend(): Backend {
  let pendingUpdate: Update | null = null;

  return {
    kind: 'tauri',

    localInfo: () => call<LocalInfo>('local_info'),
    refreshTempPassword: () => call<string>('refresh_temp_password'),
    setFixedPassword: (password) => call<void>('set_fixed_password', { password }),
    acceptIncoming: (sessionId) => call<void>('accept_incoming', { sessionId }),
    rejectIncoming: (sessionId) => call<void>('reject_incoming', { sessionId }),
    disconnectIncoming: (sessionId) => call<void>('disconnect_incoming', { sessionId }),
    disconnectAllIncoming: () => call<void>('disconnect_all_incoming'),
    listKnownHosts: () => call<KnownHost[]>('list_known_hosts'),
    removeKnownHost: (deviceCode) => call<void>('remove_known_host', { deviceCode }),

    getSettings: () => call<Settings>('get_settings'),
    setSettings: (settings) => call<Settings>('set_settings', { settings }),

    connect: (deviceCode, password, requestId) => call<string>('connect', { deviceCode, password, requestId }),
    cancelConnect: (requestId) => call<void>('cancel_connect', { requestId }),
    disconnect: (sessionId) => call<void>('disconnect', { sessionId }),
    openTerm: (p, onOutput) =>
      call<TermOpened>('open_term', {
        sessionId: p.sessionId,
        profile: p.profile,
        shellId: p.shellId ?? '',
        cwd: p.cwd ?? '',
        cols: p.cols,
        rows: p.rows,
        command: p.command ?? '',
        launch: p.launch ?? null,
        onOutput: makeChannel(onOutput),
      }),
    listTerms: (sessionId) => call<TermInfo[]>('list_terms', { sessionId }),
    attachTerm: (p, onOutput) =>
      call<void>('attach_term', {
        sessionId: p.sessionId,
        termId: p.termId,
        cols: p.cols,
        rows: p.rows,
        lastSeq: p.lastSeq,
        onOutput: makeChannel(onOutput),
      }),
    termInput: (sessionId, termId, data) => call<void>('term_input', { sessionId, termId, data: Array.from(data) }),
    termSubmit: (sessionId, termId, text, attachments) =>
      call<void>('term_submit', { sessionId, termId, text, attachments }),
    termResize: (sessionId, termId, cols, rows) => call<void>('term_resize', { sessionId, termId, cols, rows }),
    termAck: (sessionId, termId, consumed) => call<void>('term_ack', { sessionId, termId, consumed }),
    closeTerm: (sessionId, termId) => call<void>('close_term', { sessionId, termId }),
    uploadPath: (sessionId, path) => call<UploadStarted>('upload_path', { sessionId, path }),
    uploadBytes: async (p) => {
      try {
        // 原始请求体：不经 JSON，大图也不会膨胀
        return await invoke<UploadStarted>('upload_bytes', p.data, {
          headers: {
            'x-session-id': p.sessionId,
            'x-name': encodeURIComponent(p.name),
            'x-mime': p.mime,
          },
        });
      } catch (e) {
        throw toCommandError(e);
      }
    },
    cancelUpload: (sessionId, fileId) => call<void>('cancel_upload', { sessionId, fileId }),
    readClipboardFiles: () => call<string[]>('read_clipboard_files'),
    termAction: (sessionId, termId, actionId, args) =>
      call<ActionOutcome>('term_action', { sessionId, termId, actionId, args }),
    commandListReq: (sessionId, termId) => call<void>('command_list_req', { sessionId, termId }),

    onEvent: (handler) => listen<CoreEvent>('core-event', (e) => handler(e.payload)),
    onDragDrop: (handler) =>
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'enter') handler({ type: 'enter' });
        else if (p.type === 'leave') handler({ type: 'leave' });
        else if (p.type === 'drop') handler({ type: 'drop', paths: p.paths });
      }),

    pickFiles: async () => {
      const r = await openDialog({ multiple: true, directory: false });
      if (!r) return [];
      return Array.isArray(r) ? r : [r];
    },
    copyText: (text) => writeText(text),
    openUrl: (url) => openUrl(url),
    notify: async (title, body) => {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (granted) sendNotification({ title, body });
    },
    isAutostartEnabled: () => isEnabled(),
    setAutostart: async (enabled) => {
      if (enabled) await enable();
      else await disable();
    },
    checkUpdate: async (): Promise<UpdateInfo | null> => {
      pendingUpdate = await check();
      return pendingUpdate ? { version: pendingUpdate.version, notes: pendingUpdate.body ?? '' } : null;
    },
    installUpdate: async (onProgress) => {
      if (!pendingUpdate) throw { code: 'UNKNOWN', message: '没有可安装的更新' };
      let total = 0;
      let done = 0;
      await pendingUpdate.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        else if (ev.event === 'Progress') {
          done += ev.data.chunkLength;
          if (total > 0) onProgress(Math.min(1, done / total));
        } else if (ev.event === 'Finished') onProgress(1);
      });
      await relaunch();
    },
  };
}
