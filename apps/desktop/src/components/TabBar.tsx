import { useState } from 'react';
import { useController } from '../app/hooks';
import type { AppModel } from '../state/store';
import { isBlocked } from '../lib/termErrors';
import { Icon, Popover } from './common';

export function TabBar({ model, onNewClaude }: { model: AppModel; onNewClaude: () => void }) {
  const c = useController();
  const [menu, setMenu] = useState(false);
  const session = model.activeSessionId ? model.sessions[model.activeSessionId] : undefined;
  const multi = model.sessionOrder.length > 1;
  const shells = session?.info?.shells ?? [];
  const claudeOk = session?.info?.claudeAvailable ?? false;
  const canNew = session?.phase === 'ready';

  return (
    <div className="tabbar">
      <div className="tabs" role="tablist">
        {model.tabOrder.map((key) => {
          const t = model.terms[key];
          const s = model.sessions[t.sessionId];
          const stateful = t.app?.stateful && t.app.running;
          return (
            <div
              key={key}
              role="tab"
              aria-selected={model.activeKey === key}
              className={`tab${model.activeKey === key ? ' active' : ''}${(s && s.phase !== 'ready') || isBlocked(t.status) ? ' offline' : ''}`}
              onClick={() => c.activate(key)}
              onAuxClick={(e) => e.button === 1 && void c.closeTerm(key)}
              title={s?.info ? `${s.info.hostname} · ${t.title}` : t.title}
            >
              {isBlocked(t.status) ? (
                <Icon name="lock" size={13} />
              ) : stateful ? (
                <span className={`activity-dot ${t.app!.activity}`} />
              ) : (
                <Icon name={t.profile === 'claude' ? 'sparkle' : 'terminal'} size={13} />
              )}
              <span className="tab-title">
                {multi && s?.info && <em>{s.info.hostname}</em>}
                {t.title}
              </span>
              {t.badge && <span className="badge" />}
              <button
                type="button"
                className="tab-close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  void c.closeTerm(key);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        <div className="menu-anchor">
          <button type="button" className="icon-btn" title="新建 (Ctrl+Shift+T)" disabled={!canNew} onClick={() => setMenu((m) => !m)}>
            <Icon name="plus" />
          </button>
          {menu && session && (
            <Popover onClose={() => setMenu(false)} className="new-menu">
              {(shells.length > 0 ? shells : [{ id: '', name: '终端', path: '', isDefault: true }]).map((sh) => (
                <button
                  key={sh.id}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setMenu(false);
                    c.newTerm(session.id, 'shell', { shellId: sh.id });
                  }}
                >
                  <Icon name="terminal" size={14} />
                  <span>{sh.name}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                disabled={!claudeOk}
                title={claudeOk ? undefined : '对方未安装 Claude Code'}
                onClick={() => {
                  setMenu(false);
                  onNewClaude();
                }}
              >
                <Icon name="sparkle" size={14} />
                <span>Claude Code{claudeOk ? '…' : '（未安装）'}</span>
              </button>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}
