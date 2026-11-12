import { memo, useEffect, useMemo, useState } from 'react';
import { useController, useNow } from '../app/hooks';
import { Features, type ActionDef, type CommandError } from '../backend/types';
import type { UploadState } from '../lib/attachments';
import { buildActionModel } from '../lib/actions';
import { needsPasswordAgain, remainingSeconds } from '../lib/session';
import { blockedText, isBlocked, type BlockedStatus } from '../lib/termErrors';
import type { SessionModel, TermTab } from '../state/store';
import { Composer, PassthroughBar } from './Composer';
import { MobileKeys } from './MobileKeys';
import { Icon } from './common';
import { TermView } from './TermView';
import { ClaudeToolbar } from './claude/Toolbar';
import { PermissionCard } from './claude/PermissionCard';

const NO_FEATURES: string[] = [];

interface Props {
  tab: TermTab;
  session: SessionModel | undefined;
  active: boolean;
  uploads: Record<string, UploadState>;
  dragging: boolean;
  onOpenPalette: () => void;
}

/** 一个标签的完整内容：横幅 + 工具条 + 终端 + 权限卡片 + 输入框。全部常驻（隐藏而不销毁），草稿和画面才不会丢 */
function TermPaneImpl({ tab, session, active, uploads, dragging, onOpenPalette }: Props) {
  const c = useController();
  const [searchOpen, setSearchOpen] = useState(false);
  // 操作区（Claude 工具条 + 输入框）折叠：折叠时进入直通，键盘直接输入终端；
  // 在别处退出直通（Ctrl+Shift+P 等）时自动视为展开
  const [opsCollapsedRaw, setOpsCollapsed] = useState(false);
  const opsCollapsed = opsCollapsedRaw && tab.passthrough === 'on';
  const phase = session?.phase;
  const ready = phase === 'ready';
  const features = session?.features ?? NO_FEATURES;

  // Ctrl+Shift+F 打开终端搜索（Ctrl+F 会被当作控制键发给远端）
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active]);

  const actionModel = useMemo(
    () =>
      buildActionModel(session?.catalog, { sessionReady: ready, features: new Set(features), app: tab.app }, tab.commands),
    [session?.catalog, ready, features, tab.app, tab.commands],
  );

  const showToolbar =
    actionModel.available && (tab.app ? tab.app.app === 'claude' && tab.app.running : tab.profile === 'claude') && tab.status === 'open';

  // 折叠按钮：有工具条时放在工具条最右端（其他按钮左移让位），否则浮在输入框右上角
  const canFold = tab.passthrough === 'off' && ready && tab.status === 'open';
  const toolbarShown = showToolbar && !opsCollapsed && !!session?.catalog;
  const foldButton = (
    <button
      type="button"
      className="ops-handle-btn"
      title="折叠操作区（键盘直接输入终端）"
      onClick={() => {
        setOpsCollapsed(true);
        c.setPassthrough(tab.key, 'on');
      }}
    >
      <Icon name="down" size={12} />
    </button>
  );

  const run = (def: ActionDef, args: Record<string, string>) => void c.runAction(tab.key, def, args);
  const card = tab.permissionCard && features.includes(Features.appState) ? tab.permissionCard : null;

  return (
    <div className={`pane${active ? ' active' : ''}`}>
      {session && phase !== 'ready' && <SessionBanner session={session} />}
      {tab.status === 'exited' && (
        <div className="banner">
          <span>进程已退出（代码 {tab.exitCode}）</span>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => void c.closeTerm(tab.key)}>
            关闭标签
          </button>
        </div>
      )}
      {isBlocked(tab.status) && (
        <div className="banner warn">
          <Icon name="lock" size={14} />
          <span>{blockedText(tab.status as BlockedStatus)}</span>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => void c.closeTerm(tab.key)}>
            关闭标签
          </button>
        </div>
      )}
      {tab.status === 'failed' && (
        <div className="banner error">
          <span>终端启动失败：{tab.failReason}</span>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={() => void c.closeTerm(tab.key)}>
            关闭标签
          </button>
        </div>
      )}

      <TermView tabKey={tab.key} active={active} searchOpen={searchOpen} onSearchClose={() => setSearchOpen(false)} />

      {showToolbar && !opsCollapsed && session?.catalog && (
        <ClaudeToolbar
          model={actionModel}
          catalog={session.catalog}
          app={tab.app}
          onRun={run}
          onOpenPalette={onOpenPalette}
          trailing={canFold ? foldButton : undefined}
        />
      )}
      {card && <PermissionCard notice={card} catalog={session?.catalog} enabled={ready} onRun={run} />}

      {tab.passthrough !== 'off' && (
        <PassthroughBar
          tab={tab}
          collapsed={opsCollapsed}
          onExit={() => {
            setOpsCollapsed(false);
            c.setPassthrough(tab.key, 'off');
          }}
        />
      )}
      {canFold && !toolbarShown && <div className="ops-handle">{foldButton}</div>}
      {tab.status === 'open' && ready && <MobileKeys tab={tab} />}
      <div className={tab.passthrough !== 'off' || tab.status === 'exited' || isBlocked(tab.status) ? 'composer-hidden' : ''}>
        <Composer
          tab={tab}
          sessionReady={ready}
          features={features}
          maxFileSize={session?.info?.maxFileSize}
          uploads={uploads}
          dragging={dragging}
          active={active}
        />
      </div>
    </div>
  );
}

export const TermPane = memo(TermPaneImpl);

/** 重连中 / 已断开 横幅：终端画面保留，输入框仍可编辑 */
function SessionBanner({ session }: { session: SessionModel }) {
  const c = useController();
  const now = useNow(session.phase === 'reconnecting');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (session.phase === 'connecting') {
    return (
      <div className="banner">
        <span className="spinner" />
        <span>连接中…</span>
      </div>
    );
  }
  if (session.phase === 'awaitingApproval') {
    return (
      <div className="banner warn">
        <span className="spinner" />
        <span>等待对方确认…</span>
      </div>
    );
  }
  if (session.phase === 'reconnecting') {
    const sec = remainingSeconds(session.retryAt, now);
    return (
      <div className="banner warn">
        <span className="spinner" />
        <span>
          重连中{session.attempt ? ` · 第 ${session.attempt} 次` : ''}
          {sec > 0 ? ` · ${sec} 秒后重试` : ''}
        </span>
      </div>
    );
  }
  const again = needsPasswordAgain(session);
  const reconnect = async () => {
    if (!pw) return setErr('请输入密码');
    setBusy(true);
    setErr('');
    try {
      await c.reconnectSession(session.id, pw);
    } catch (e) {
      setErr((e as CommandError).message || '连接失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner error">
      <Icon name="close" size={14} />
      <span>{again ? '密码错误，请重新输入' : `已断开${session.reason ? ` · ${session.reason}` : ''}`}</span>
      <span className="spacer" />
      <input
        className={`input small mono${err ? ' invalid' : ''}`}
        type="password"
        placeholder="密码"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void reconnect()}
      />
      <button type="button" className="btn small primary" disabled={busy} onClick={() => void reconnect()}>
        重新连接
      </button>
      {err && <span className="form-error">{err}</span>}
    </div>
  );
}
