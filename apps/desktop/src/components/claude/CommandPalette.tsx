import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionCatalog, ActionDef, CustomCommand } from '../../backend/types';
import { filterPalette, initialArgs, needsParamInput, validateArgs, type PaletteItem } from '../../lib/actions';
import { ParamForm } from './ParamForm';

/** Ctrl+K 命令面板：搜索全部动作和自定义命令；需要参数的动作在面板内直接填写 */
export function CommandPalette({
  items,
  catalog,
  hasTarget,
  onRunAction,
  onCommand,
  onClose,
}: {
  items: PaletteItem[];
  catalog: ActionCatalog | undefined;
  hasTarget: boolean;
  onRunAction: (def: ActionDef, args: Record<string, string>) => void;
  onCommand: (cmd: CustomCommand) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [param, setParam] = useState<{ def: ActionDef; args: Record<string, string>; errors: Record<string, string> } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => filterPalette(items, query), [items, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [index, filtered]);

  const choose = (it: PaletteItem | undefined) => {
    if (!it || !it.enabled) return;
    if (it.kind === 'command' && it.command) {
      onCommand(it.command);
      onClose();
    } else if (it.def) {
      if (needsParamInput(it.def) && catalog) setParam({ def: it.def, args: initialArgs(it.def), errors: {} });
      else {
        onRunAction(it.def, {});
        onClose();
      }
    }
  };

  const runParam = () => {
    if (!param || !catalog) return;
    const errors = validateArgs(param.def, param.args, catalog);
    if (Object.keys(errors).length > 0) return setParam({ ...param, errors });
    onRunAction(param.def, Object.fromEntries(Object.entries(param.args).map(([k, v]) => [k, v.trim()])));
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (param) setParam(null);
      else onClose();
    } else if (param) {
      if (e.key === 'Enter' && e.target instanceof HTMLSelectElement) {
        e.preventDefault();
        runParam();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[index]);
    }
  };

  return (
    <div className="palette-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" onKeyDown={onKeyDown}>
        {param && catalog ? (
          <div className="palette-param">
            <div className="palette-param-title">{param.def.title}</div>
            <ParamForm
              def={param.def}
              catalog={catalog}
              args={param.args}
              setArgs={(args) => setParam({ ...param, args })}
              errors={param.errors}
              onEnter={runParam}
            />
            <div className="palette-param-actions">
              <button type="button" className="btn small" onClick={() => setParam(null)}>
                返回
              </button>
              <button type="button" className="btn small primary" onClick={runParam}>
                执行
              </button>
            </div>
          </div>
        ) : (
          <>
            <input className="palette-input" autoFocus placeholder="搜索动作" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="palette-list" ref={listRef}>
              {!hasTarget && <div className="palette-empty">没有打开的终端</div>}
              {hasTarget && filtered.length === 0 && <div className="palette-empty">无匹配</div>}
              {filtered.map((it, i) => (
                <div
                  key={it.key}
                  className={`palette-item${i === index ? ' sel' : ''}${it.enabled ? '' : ' disabled'}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(it)}
                >
                  <span className="palette-title">{it.title}</span>
                  <span className="palette-hint">{it.hint}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
