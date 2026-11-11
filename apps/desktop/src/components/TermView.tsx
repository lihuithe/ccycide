import { useEffect, useRef, useState } from 'react';
import { useController } from '../app/hooks';
import { IconButton } from './common';

/** xterm 容器 + 搜索条。切换标签只隐藏，不销毁 */
export function TermView({ tabKey, active, searchOpen, onSearchClose }: { tabKey: string; active: boolean; searchOpen: boolean; onSearchClose: () => void }) {
  const c = useController();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const rt = c.runtime(tabKey);
    rt.mount(el);
    void c.startTerm(tabKey);
  }, [c, tabKey]);

  // 从隐藏变为显示后重新 fit
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => c.runtime(tabKey).syncSize());
    return () => cancelAnimationFrame(id);
  }, [active, c, tabKey]);

  return (
    <div className="term-wrap">
      <div className="term-host" ref={hostRef} />
      {searchOpen && <SearchBar tabKey={tabKey} onClose={onSearchClose} />}
    </div>
  );
}

function SearchBar({ tabKey, onClose }: { tabKey: string; onClose: () => void }) {
  const c = useController();
  const [q, setQ] = useState('');
  const [miss, setMiss] = useState(false);
  const rt = c.runtime(tabKey);

  const close = () => {
    rt.clearSearch();
    onClose();
    rt.focus();
  };

  return (
    <div className="search-bar">
      <input
        autoFocus
        className={`input small${miss ? ' invalid' : ''}`}
        placeholder="搜索"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setMiss(e.target.value ? !rt.findNext(e.target.value) : false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            setMiss(q ? !(e.shiftKey ? rt.findPrev(q) : rt.findNext(q)) : false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      <IconButton icon="up" title="上一个" onClick={() => setMiss(!rt.findPrev(q))} />
      <IconButton icon="down" title="下一个" onClick={() => setMiss(!rt.findNext(q))} />
      <IconButton icon="close" title="关闭" onClick={close} />
    </div>
  );
}
