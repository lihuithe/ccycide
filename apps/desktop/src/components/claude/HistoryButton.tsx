import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useController } from '../../app/hooks';
import { getInputHistory, subscribeInputHistory } from '../../lib/inputHistory';

/** 历史按钮：弹出以往的输入，可填入输入框（不提交）或复制 */
export function HistoryButton({ tabKey }: { tabKey: string }) {
  const c = useController();
  const items = useSyncExternalStore(subscribeInputHistory, getInputHistory);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, bottom: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // 点到弹层外面或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 368)), bottom: window.innerHeight - r.top + 4 });
    setOpen((v) => !v);
  };

  const copy = async (text: string) => {
    try {
      await c.backend.copyText(text);
      c.toast('已复制', 'info');
    } catch (e) {
      c.toast(c.errorText(e), 'error');
    }
  };

  const list = [...items].reverse();

  return (
    <>
      <button ref={btnRef} type="button" className="btn small" title="输入历史" onClick={toggle}>
        历史
      </button>
      {open && (
        <div ref={popRef} className="history-pop" style={{ left: pos.left, bottom: pos.bottom }}>
          {list.length === 0 && <div className="history-empty muted">暂无历史</div>}
          {list.map((text) => (
            <div key={text} className="history-item">
              <span className="history-text" title={text}>
                {text}
              </span>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  c.fillComposer(tabKey, text);
                  setOpen(false);
                }}
              >
                到输入框
              </button>
              <button type="button" className="btn small" onClick={() => void copy(text)}>
                复制
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
