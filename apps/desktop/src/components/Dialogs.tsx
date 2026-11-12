import { useState, type ReactNode } from 'react';
import { useConfirmRequest, useController, useNow } from '../app/hooks';
import { resolveConfirm } from '../app/ui';
import type { Settings, TempPasswordPolicy, ThemeChoice } from '../backend/types';
import { formatDeviceCode, formatDuration, platformLabel } from '../lib/format';
import { pendingQueue, waitedMs } from '../lib/incoming';
import { FIXED_PASSWORD_MIN, validateFixedPassword } from '../lib/password';
import type { AppModel } from '../state/store';
import { Modal, Switch } from './common';

// ———————————————————— 确认框 ————————————————————

export function ConfirmHost() {
  const req = useConfirmRequest();
  if (!req) return null;
  return (
    <Modal
      title={req.title}
      onClose={() => resolveConfirm(false)}
      width={380}
      footer={
        <>
          <button type="button" className="btn" onClick={() => resolveConfirm(false)}>
            取消
          </button>
          <button type="button" autoFocus className="btn primary" onClick={() => resolveConfirm(true)}>
            {req.okText ?? '确定'}
          </button>
        </>
      }
    >
      {req.message && <p className="modal-text">{req.message}</p>}
    </Modal>
  );
}

// ———————————————————— 提示 ————————————————————

export function Toasts({ model }: { model: AppModel }) {
  return (
    <div className="toasts">
      {model.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ———————————————————— 首次启动安全须知 ————————————————————

export function SafetyNotice() {
  const c = useController();
  return (
    <Modal
      title="使用须知"
      width={400}
      footer={
        <button type="button" autoFocus className="btn primary" onClick={() => void c.dismissSafetyNotice()}>
          我知道了
        </button>
      }
    >
      <p className="modal-text">不要把设备码和密码告诉不认识的人。拿到它们的人可以在本机上执行任何命令。</p>
      <p className="modal-text">有人连入时托盘图标会变色，可以随时在侧栏一键断开。</p>
    </Modal>
  );
}

// ———————————————————— 来访连接确认 ————————————————————

/** 待确认的来访请求：排队显示，没有超时，一直等到用户同意/拒绝或对方取消 */
export function IncomingRequests({ model }: { model: AppModel }) {
  const c = useController();
  const queue = pendingQueue(model.incoming);
  const now = useNow(queue.length > 0);
  if (queue.length === 0) return null;
  return (
    <div className="incoming-requests" role="alertdialog" aria-label="连接请求">
      {queue.map((i) => (
        <div key={i.sessionId} className="request-card">
          <div className="request-main">
            <span className="device-code small">{formatDeviceCode(i.fromCode)}</span>
            <span className="muted small">
              {platformLabel(i.platform)} · 已等待 {formatDuration(waitedMs(i, now))}
            </span>
          </div>
          <button type="button" className="btn small" onClick={() => void c.rejectIncoming(i.sessionId)}>
            拒绝
          </button>
          <button type="button" className="btn small primary" onClick={() => void c.acceptIncoming(i.sessionId)}>
            同意
          </button>
        </div>
      ))}
    </div>
  );
}

// ———————————————————— 固定密码 ————————————————————

export function FixedPasswordDialog({ isSet, onClose }: { isSet: boolean; onClose: () => void }) {
  const c = useController();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    const e = validateFixedPassword(pw);
    if (e) return setError(e);
    try {
      await c.setFixedPassword(pw);
      c.toast('固定密码已设置');
      onClose();
    } catch (err) {
      setError(c.errorText(err));
    }
  };
  const clear = async () => {
    try {
      await c.setFixedPassword(null);
      c.toast('固定密码已清除');
      onClose();
    } catch (err) {
      setError(c.errorText(err));
    }
  };

  return (
    <Modal
      title="固定密码"
      onClose={onClose}
      width={380}
      footer={
        <>
          {isSet && (
            <button type="button" className="btn danger" onClick={() => void clear()}>
              清除
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">新密码</span>
        <div className="field-col">
          <input
            className={`input mono${error ? ' invalid' : ''}`}
            type="password"
            autoFocus
            placeholder={`至少 ${FIXED_PASSWORD_MIN} 位`}
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              setError('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void save()}
          />
          {error && <div className="form-error">{error}</div>}
        </div>
      </label>
    </Modal>
  );
}

// ———————————————————— 设置 ————————————————————

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const c = useController();
  // 每次修改立即保存
  const update = (f: (s: Settings) => Settings) => {
    void c.saveSettings(f(structuredClone(settings))).catch((e) => c.toast(c.errorText(e), 'error'));
  };
  const h = settings.host;
  const ctl = settings.controller;
  const app = settings.app;

  return (
    <Modal title="设置" onClose={onClose} width={480} footer={<button type="button" className="btn primary" onClick={onClose}>完成</button>}>
      <div className="settings">
        <div className="settings-group">被控</div>
        <Row label="允许被远程连接">
          <Switch checked={h.enabled} onChange={(v) => update((s) => ((s.host.enabled = v), s))} />
        </Row>
        <Row label="每次连接需要我确认">
          <Switch checked={h.requireConfirm} onChange={(v) => update((s) => ((s.host.requireConfirm = v), s))} />
        </Row>
        <Row label="临时密码刷新">
          <select
            className="input small"
            value={h.tempPasswordPolicy}
            onChange={(e) => update((s) => ((s.host.tempPasswordPolicy = e.target.value as TempPasswordPolicy), s))}
          >
            <option value="on_start">每次启动</option>
            <option value="after_session">每次会话结束后</option>
            <option value="manual">不过期（仅手动刷新）</option>
          </select>
        </Row>
        <Row label="终端隔离">
          <Switch checked={h.isolateTerminals} onChange={(v) => update((s) => ((s.host.isolateTerminals = v), s))} />
        </Row>
        <Row label="接收文件">
          <Switch checked={h.fileReceive} onChange={(v) => update((s) => ((s.host.fileReceive = v), s))} />
        </Row>
        <Row label="有人连入时通知">
          <Switch checked={h.notifyOnConnect} onChange={(v) => update((s) => ((s.host.notifyOnConnect = v), s))} />
        </Row>
        <Row label="连接期间阻止睡眠">
          <Switch checked={h.preventSleepWhenConnected} onChange={(v) => update((s) => ((s.host.preventSleepWhenConnected = v), s))} />
        </Row>
        <Row label="Claude Code 集成">
          <Switch checked={h.claudeIntegration} onChange={(v) => update((s) => ((s.host.claudeIntegration = v), s))} />
        </Row>
        <Row label="上下文用量与费用">
          <Switch checked={h.claudeStatusline} disabled={!h.claudeIntegration} onChange={(v) => update((s) => ((s.host.claudeStatusline = v), s))} />
        </Row>

        <div className="settings-group">主控</div>
        <Row label="主题">
          <select className="input small" value={ctl.theme} onChange={(e) => update((s) => ((s.controller.theme = e.target.value as ThemeChoice), s))}>
            <option value="auto">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Row>
        <Row label="终端字号">
          <input
            className="input small num"
            type="number"
            min={10}
            max={24}
            value={ctl.fontSize}
            onChange={(e) => {
              const n = Math.min(24, Math.max(10, Number(e.target.value) || 14));
              update((s) => ((s.controller.fontSize = n), s));
            }}
          />
        </Row>
        <Row label="任务完成时通知">
          <Switch checked={ctl.notifyOnDone} onChange={(v) => update((s) => ((s.controller.notifyOnDone = v), s))} />
        </Row>
        <Row label="需要确认时通知">
          <Switch checked={ctl.notifyOnPermission} onChange={(v) => update((s) => ((s.controller.notifyOnPermission = v), s))} />
        </Row>

        <div className="settings-group">应用</div>
        <Row label="关闭窗口时最小化到托盘">
          <Switch checked={app.closeToTray} onChange={(v) => update((s) => ((s.app.closeToTray = v), s))} />
        </Row>
        <Row label="开机自启">
          <Switch checked={app.autostart} onChange={(v) => update((s) => ((s.app.autostart = v), s))} />
        </Row>
        <Row label="使用系统证书库">
          <Switch checked={settings.server.useSystemCerts} onChange={(v) => update((s) => ((s.server.useSystemCerts = v), s))} />
        </Row>
        <Row label="崩溃上报">
          <Switch checked={app.crashReport} onChange={(v) => update((s) => ((s.app.crashReport = v), s))} />
        </Row>
        <Row label="更新通道">
          <select className="input small" value={app.updateChannel} onChange={(e) => update((s) => ((s.app.updateChannel = e.target.value as 'stable' | 'beta'), s))}>
            <option value="stable">稳定版</option>
            <option value="beta">测试版</option>
          </select>
        </Row>
        <Row label="版本">
          <span className="setting-actions">
            <span className="muted">{c.store.getState().local?.appVersion}</span>
            <button type="button" className="btn small" onClick={() => void c.checkUpdate(false)}>
              检查更新
            </button>
          </span>
        </Row>
      </div>
    </Modal>
  );
}

// ———————————————————— 更新提示条 ————————————————————

export function UpdateBar({ model }: { model: AppModel }) {
  const c = useController();
  const [hidden, setHidden] = useState(false);
  const u = model.update;
  if (!u || hidden) return null;
  const busy = u.progress !== null;
  return (
    <div className="update-bar">
      <span>
        新版本 <b>{u.info.version}</b> 可用
        {u.info.notes ? <span className="muted"> · {u.info.notes}</span> : null}
      </span>
      <span className="spacer" />
      {u.error && <span className="form-error">{u.error}</span>}
      {busy ? (
        <span className="update-progress">
          <i style={{ width: `${Math.round((u.progress ?? 0) * 100)}%` }} />
        </span>
      ) : (
        <>
          <button type="button" className="btn small primary" onClick={() => void c.installUpdate()}>
            立即更新
          </button>
          <button type="button" className="btn small" onClick={() => setHidden(true)}>
            稍后
          </button>
        </>
      )}
    </div>
  );
}
