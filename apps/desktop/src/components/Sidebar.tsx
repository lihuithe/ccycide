import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { isWebTarget } from '../backend';
import type { CommandError } from '../backend/types';
import { newRequestId } from '../app/controller';
import { useController, useNow } from '../app/hooks';
import type { AppModel } from '../state/store';
import { formatDeviceCode, formatDuration, parseDeviceCode, platformLabel } from '../lib/format';
import { connectErrorText, statusText } from '../lib/session';
import { IconButton, Icon } from './common';

const WEB = isWebTarget();

export interface DrawerProps {
  open: boolean;
  /** 没有任何会话：铺满整个屏幕 */
  solo: boolean;
  onClose: () => void;
}

export function Sidebar({ model, onSettings, onFixedPassword, drawer }: { model: AppModel; onSettings: () => void; onFixedPassword: () => void; drawer?: DrawerProps }) {
  const c = useController();
  const [code, setCode] = useState('');
  const [showPw, setShowPw] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const { local, settings, incoming } = model;
  const now = useNow(incoming.length > 0);
  const hostEnabled = settings?.host.enabled ?? true;

  const togglePause = () => {
    if (!settings) return;
    void c.saveSettings({ ...settings, host: { ...settings.host, enabled: !hostEnabled } }).catch((e) => c.toast(c.errorText(e), 'error'));
  };

  return (
    <aside
      className={`sidebar${drawer ? ' drawer' : ''}${drawer?.open ? ' open' : ''}${drawer?.solo ? ' solo' : ''}`}
      // 手机上点了“已连接”里的某台设备：切过去并收起抽屉
      onClick={(e) => drawer && !drawer.solo && (e.target as HTMLElement).closest('.session-row') && drawer.onClose()}
    >
      <section className="card">
        <div className="card-head">
          <span className="card-title">{WEB ? '本设备（网页）' : '本机'}</span>
          <span className={`dot ${model.online ? 'ok' : 'off'}`} title={model.online ? '信令在线' : '信令离线'} />
          <span className="spacer" />
          {!WEB && <IconButton icon={hostEnabled ? 'pause' : 'play'} title={hostEnabled ? '暂停被控' : '恢复被控'} onClick={togglePause} active={!hostEnabled} />}
          <IconButton icon="gear" title="设置" onClick={onSettings} />
        </div>
        {local ? (
          <>
            <div className="code-row">
              <span className="device-code">{formatDeviceCode(local.deviceCode)}</span>
              <IconButton icon="copy" title="复制设备码" onClick={() => void c.copy(local.deviceCode)} />
            </div>
            {WEB && <div className="note-line">网页版只能连接别的设备。设备身份保存在本浏览器里，清除站点数据后会变成新设备。</div>}
            {!WEB && <div className="pw-row">
              <span className="pw-label">密码</span>
              <span className="pw-value">{showPw ? local.tempPassword : '••••••••'}</span>
              <IconButton icon={showPw ? 'eyeOff' : 'eye'} title={showPw ? '隐藏密码' : '显示密码'} onClick={() => setShowPw((v) => !v)} />
              <IconButton icon="copy" title="复制密码" onClick={() => void c.copy(local.tempPassword)} />
              <IconButton icon="refresh" title="刷新临时密码" onClick={() => void c.refreshPassword()} />
              <IconButton icon="key" title={local.fixedPasswordSet ? '固定密码（已设置）' : '设置固定密码'} onClick={onFixedPassword} active={local.fixedPasswordSet} />
            </div>}
            {!WEB && !hostEnabled && <div className="note-line warn">已暂停，他人无法连接</div>}
          </>
        ) : (
          <div className="muted">加载中…</div>
        )}

        {incoming.length > 0 && (
          <div className="incoming">
            <div className="incoming-head">
              <span>{incoming.length} 个连入</span>
              <span className="spacer" />
              <button type="button" className="link-btn danger" onClick={() => void c.disconnectAllIncoming()}>
                全部断开
              </button>
            </div>
            {incoming.map((i) => (
              <div key={i.sessionId} className="incoming-row">
                <div className="incoming-main">
                  <span className="mono">{formatDeviceCode(i.fromCode)}</span>
                  <span className="muted">
                    {platformLabel(i.platform)} · {i.pendingConfirm ? `等待确认 ${formatDuration(now - i.startedAt)}` : formatDuration(now - i.startedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => void (i.pendingConfirm ? c.rejectIncoming(i.sessionId) : c.disconnectIncoming(i.sessionId))}
                >
                  {i.pendingConfirm ? '拒绝' : '断开'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConnectForm code={code} setCode={setCode} pwRef={pwRef} model={model} />
      <SessionList model={model} />
      <RecentList
        model={model}
        onPick={(v) => {
          setCode(parseDeviceCode(v));
          pwRef.current?.focus();
        }}
      />
    </aside>
  );
}

function ConnectForm({
  code,
  setCode,
  pwRef,
  model,
}: {
  code: string;
  setCode: (v: string) => void;
  pwRef: RefObject<HTMLInputElement | null>;
  model: AppModel;
}) {
  const c = useController();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState('');
  const awaiting = busy && model.connecting[requestId] === 'awaitingApproval';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!code) return setError('请输入设备码');
    if (!pw) return setError('请输入密码');
    const rid = newRequestId();
    setRequestId(rid);
    setBusy(true);
    setError('');
    try {
      const id = await c.connect(code, pw, rid);
      setPw('');
      // 连上后直接开一个终端，减少一步操作
      const s = c.store.getState().sessions[id];
      if (s && c.store.getState().tabOrder.every((k) => c.store.getState().terms[k].sessionId !== id)) {
        c.newTerm(id, 'shell');
      }
    } catch (err) {
      const ce = err as CommandError;
      // 用户自己取消的，不算错误
      if (ce.code !== 'CANCELLED') setError(connectErrorText(ce.code, ce.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">连接远程设备</span>
      </div>
      <form className="connect-form" onSubmit={(e) => void submit(e)}>
        <input
          className="input mono"
          placeholder="设备码"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={formatDeviceCode(code)}
          onChange={(e) => setCode(parseDeviceCode(e.target.value))}
        />
        <input
          ref={pwRef}
          className="input mono"
          placeholder="密码"
          type="password"
          autoComplete="off"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {awaiting ? (
          <div className="awaiting">
            <span className="spinner" />
            <span>等待对方确认…</span>
            <button type="button" className="btn small" onClick={() => void c.cancelConnect(requestId)}>
              取消
            </button>
          </div>
        ) : (
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? '连接中' : '连接'}
          </button>
        )}
        {error && <div className="form-error">{error}</div>}
      </form>
    </section>
  );
}

function SessionList({ model }: { model: AppModel }) {
  const c = useController();
  const now = useNow(model.sessionOrder.some((id) => model.sessions[id].phase === 'reconnecting'));
  if (model.sessionOrder.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">已连接</span>
      </div>
      {model.sessionOrder.map((id) => {
        const s = model.sessions[id];
        const active = model.activeSessionId === id;
        return (
          <div key={id} className={`session-row${active ? ' active' : ''}`} onClick={() => c.store.dispatch({ type: 'activateSession', id })}>
            <span className={`dot ${s.phase === 'ready' ? 'ok' : s.phase === 'closed' ? 'off' : 'warn'}`} />
            <div className="session-main">
              <span className="session-name">{s.info?.hostname || formatDeviceCode(s.deviceCode)}</span>
              <span className="muted small">{s.phase === 'ready' ? (s.latencyMs !== undefined ? `${s.latencyMs} ms` : '已连接') : statusText(s, now)}</span>
            </div>
            <IconButton
              icon="close"
              title="断开"
              onClick={() => {
                void c.disconnect(id);
              }}
            />
          </div>
        );
      })}
    </section>
  );
}

function RecentList({ model, onPick }: { model: AppModel; onPick: (code: string) => void }) {
  const c = useController();
  if (model.knownHosts.length === 0) return null;
  return (
    <section className="card grow">
      <div className="card-head">
        <span className="card-title">最近连接</span>
      </div>
      {model.knownHosts.map((h) => (
        <div
          key={h.deviceCode}
          className="recent-row"
          onClick={() => onPick(h.deviceCode)}
        >
          <Icon name="terminal" size={14} />
          <span className="mono">{formatDeviceCode(h.deviceCode)}</span>
          {h.alias && <span className="muted small">{h.alias}</span>}
          <span className="spacer" />
          <span className="recent-remove">
            <IconButton
              icon="close"
              title="移除"
              onClick={() => {
                void c.removeKnownHost(h.deviceCode);
              }}
            />
          </span>
        </div>
      ))}
    </section>
  );
}
