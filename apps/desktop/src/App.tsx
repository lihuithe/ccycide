import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller } from './app/controller';
import { ControllerContext, useCompact, useController, useModel, useVisualViewport } from './app/hooks';
import { buildActionModel } from './lib/actions';
import { ConfirmHost, FixedPasswordDialog, IncomingRequests, SafetyNotice, SettingsDialog, Toasts, UpdateBar } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { TermPane } from './components/TermPane';
import { CommandPalette } from './components/claude/CommandPalette';
import { NewClaudeDialog } from './components/claude/NewClaudeDialog';
import { Icon } from './components/common';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function App() {
  const [controller, setController] = useState<Controller | null>(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');

  useEffect(() => {
    let c: Controller | null = null;
    let cancelled = false;
    Controller.create().then(
      (created) => {
        if (cancelled) return created.dispose();
        c = created;
        setController(created);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
        setErrorCode(String((e as { code?: string })?.code ?? ''));
      },
    );
    return () => {
      cancelled = true;
      c?.dispose();
    };
  }, []);

  if (error) {
    return (
      <div className="boot error">
        {errorCode === 'ACTIVE_ELSEWHERE' ? '' : '启动失败：'}
        {error}
        {errorCode === 'ACTIVE_ELSEWHERE' && (
          <div style={{ marginTop: 16 }}>
            <button type="button" className="btn primary" onClick={() => void import('./backend/web/web').then((m) => m.takeOverActiveTab())}>
              接管（原标签页会被关闭）
            </button>
          </div>
        )}
      </div>
    );
  }
  if (!controller) return <div className="boot">加载中…</div>;
  return (
    <ControllerContext.Provider value={controller}>
      <Shell />
    </ControllerContext.Provider>
  );
}

function Shell() {
  const c = useController();
  const model = useModel();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fixedOpen, setFixedOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 手机：侧栏是抽屉。没有任何会话时直接铺满显示连接表单；连上之后自动收起，点标签栏左边的菜单再打开
  const compact = useCompact();
  useVisualViewport(compact);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sessionCount = model.sessionOrder.length;
  const prevSessions = useRef(sessionCount);
  useEffect(() => {
    if (sessionCount > prevSessions.current) setDrawerOpen(false);
    prevSessions.current = sessionCount;
  }, [sessionCount]);
  const solo = compact && sessionCount === 0;
  const drawerVisible = compact && (drawerOpen || solo);

  const activeSession = model.activeSessionId ? model.sessions[model.activeSessionId] : undefined;
  const activeTab = model.activeKey ? model.terms[model.activeKey] : undefined;
  const tabSession = activeTab ? model.sessions[activeTab.sessionId] : undefined;

  // 全局快捷键（捕获阶段，先于输入框和 xterm）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      const st = c.store.getState();
      if (mod && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 't') {
        e.preventDefault();
        e.stopPropagation();
        if (st.activeSessionId) c.newTerm(st.activeSessionId, 'shell');
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'w') {
        e.preventDefault();
        e.stopPropagation();
        if (st.activeKey) void c.closeTerm(st.activeKey);
      } else if (e.ctrlKey && (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        e.stopPropagation();
        c.cycleTab(e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [c]);

  // 命令面板的数据：针对当前标签
  const palette = useMemo(
    () =>
      activeTab && tabSession
        ? buildActionModel(
            tabSession.catalog,
            { sessionReady: tabSession.phase === 'ready', features: new Set(tabSession.features), app: activeTab.app },
            activeTab.commands,
          ).palette
        : [],
    [activeTab, tabSession],
  );

  const home = activeSession?.info?.homeDir ?? '';

  return (
    <div className="app">
      <UpdateBar model={model} />
      <div className="body">
        <Sidebar
          model={model}
          onSettings={() => setSettingsOpen(true)}
          onFixedPassword={() => setFixedOpen(true)}
          drawer={compact ? { open: drawerVisible, solo, onClose: () => setDrawerOpen(false) } : undefined}
        />
        {compact && drawerVisible && !solo && <div className="drawer-mask" onClick={() => setDrawerOpen(false)} />}
        <main className="main">
          <TabBar model={model} onNewClaude={() => setClaudeOpen(true)} onMenu={compact ? () => setDrawerOpen(true) : undefined} />
          <div className="stack">
            {model.tabOrder.map((key) => (
              <TermPane
                key={key}
                tab={model.terms[key]}
                session={model.sessions[model.terms[key].sessionId]}
                active={model.activeKey === key}
                uploads={model.uploads}
                dragging={model.dragging}
                onOpenPalette={() => setPaletteOpen(true)}
              />
            ))}
            {model.tabOrder.length === 0 && <EmptyState model={model} onNewClaude={() => setClaudeOpen(true)} />}
            {model.dragging && (
              <div className="drop-overlay">
                <Icon name="attach" size={28} />
                <span>松开添加附件</span>
              </div>
            )}
          </div>
          <StatusBar model={model} />
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          items={palette}
          catalog={tabSession?.catalog}
          hasTarget={!!activeTab}
          onRunAction={(def, args) => activeTab && void c.runAction(activeTab.key, def, args)}
          onCommand={(cmd) => {
            if (!activeTab) return;
            if (cmd.argumentHint) c.fillComposer(activeTab.key, `/${cmd.name} `);
            else void c.submitCommand(activeTab.key, `/${cmd.name}`);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {claudeOpen && activeSession && (
        <NewClaudeDialog
          catalog={activeSession.catalog}
          homeDir={home}
          onSubmit={(cwd, launch) => c.newTerm(activeSession.id, 'claude', { cwd, launch })}
          onClose={() => setClaudeOpen(false)}
        />
      )}
      {settingsOpen && model.settings && <SettingsDialog settings={model.settings} onClose={() => setSettingsOpen(false)} />}
      {fixedOpen && <FixedPasswordDialog isSet={!!model.local?.fixedPasswordSet} onClose={() => setFixedOpen(false)} />}
      <IncomingRequests model={model} />
      {model.ready && model.settings && !model.settings.app.safetyNoticeAcked && <SafetyNotice />}
      <ConfirmHost />
      <Toasts model={model} />
    </div>
  );
}

function EmptyState({ model, onNewClaude }: { model: ReturnType<typeof useModel>; onNewClaude: () => void }) {
  const c = useController();
  const s = model.activeSessionId ? model.sessions[model.activeSessionId] : undefined;
  const ready = s?.phase === 'ready';
  return (
    <div className="empty">
      <div className="empty-logo">RTerm</div>
      {ready && s ? (
        <div className="empty-actions">
          <button type="button" className="btn" onClick={() => c.newTerm(s.id, 'shell')}>
            <Icon name="terminal" /> 新建终端
          </button>
          <button type="button" className="btn" disabled={!s.info?.claudeAvailable} onClick={onNewClaude}>
            <Icon name="sparkle" /> Claude Code
          </button>
        </div>
      ) : null}
    </div>
  );
}
