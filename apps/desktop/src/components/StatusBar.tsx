import { useNow } from '../app/hooks';
import { formatCost } from '../lib/format';
import { statusText } from '../lib/session';
import type { AppModel } from '../state/store';

export function StatusBar({ model }: { model: AppModel }) {
  const session = model.activeSessionId ? model.sessions[model.activeSessionId] : undefined;
  const tab = model.activeKey ? model.terms[model.activeKey] : undefined;
  const now = useNow(session?.phase === 'reconnecting');
  const app = tab?.app;

  return (
    <footer className="statusbar">
      {session ? (
        <>
          <span className={`dot ${session.phase === 'ready' ? 'ok' : session.phase === 'closed' ? 'off' : 'warn'}`} />
          <span>{statusText(session, now)}</span>
          {session.phase === 'ready' && session.latencyMs !== undefined && <span className="muted">延迟 {session.latencyMs} ms</span>}
        </>
      ) : (
        <span className="muted">未连接</span>
      )}
      <span className="spacer" />
      {!model.online && <span className="warn-text">信令离线</span>}
      {app?.stateful && app.running && (
        <>
          {app.version && <span className="muted">Claude Code {app.version}</span>}
          {app.costUsd > 0 && <span title="本次会话费用">{formatCost(app.costUsd)}</span>}
        </>
      )}
    </footer>
  );
}
