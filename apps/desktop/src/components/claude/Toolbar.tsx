import { useState, type ReactNode } from 'react';
import type { ActionCatalog, ActionDef, AppState } from '../../backend/types';
import { SPECIAL_ACTION, findAction, needsParamInput, type ActionModel, type ToolbarItem } from '../../lib/actions';
import { Icon, IconButton } from '../common';
import { ActionMenu } from './ActionMenu';
import { ParamDialog } from './ParamDialog';

const ACTIVITY_TEXT = { idle: '空闲', busy: '工作中', waiting_permission: '等待确认' } as const;

/** Claude Code 工具条：完全由动作目录生成 */
export function ClaudeToolbar({
  model,
  catalog,
  app,
  onRun,
  onOpenPalette,
  trailing,
}: {
  model: ActionModel;
  catalog: ActionCatalog;
  app: AppState | null;
  onRun: (def: ActionDef, args: Record<string, string>) => void;
  onOpenPalette: () => void;
  trailing?: ReactNode;
}) {
  const [dialog, setDialog] = useState<{ def: ActionDef; preset?: Record<string, string>; customFor?: string } | null>(null);
  const stateful = !!app?.stateful;
  const pick = (def: ActionDef) => (needsParamInput(def) ? setDialog({ def }) : onRun(def, {}));

  const selects = model.toolbar.filter((t) => t.control !== 'button');
  const buttons = model.toolbar.filter((t) => t.control === 'button');
  const ctxAction = findAction(catalog, SPECIAL_ACTION.contextShow);

  return (
    <div className="claude-toolbar">
      {stateful && (
        <span className={`activity ${app!.activity}`} title={ACTIVITY_TEXT[app!.activity]}>
          <span className="activity-dot" />
          {ACTIVITY_TEXT[app!.activity]}
        </span>
      )}

      {selects.map((t) => (
        <ToolbarControl key={t.def.id} item={t} onRun={onRun} onDialog={(def, preset, customFor) => setDialog({ def, preset, customFor })} />
      ))}

      {stateful && app!.hasContext && (
        <button
          type="button"
          className={`ctx${app!.contextUsedPct >= 80 ? ' hot' : ''}`}
          title="查看上下文用量详情"
          disabled={!ctxAction}
          onClick={() => ctxAction && onRun(ctxAction, {})}
        >
          上下文 {app!.contextUsedPct}%
        </button>
      )}

      <span className="spacer" />

      {buttons.map((t) =>
        t.def.id === 'interrupt' || t.def.enabledWhen === 'busy' ? (
          <button key={t.def.id} type="button" className="btn small stop" disabled={!t.enabled} title={t.def.note || t.def.title} onClick={() => onRun(t.def, {})}>
            <Icon name="stop" size={12} />
            {t.def.title}
          </button>
        ) : (
          <button key={t.def.id} type="button" className="btn small" disabled={!t.enabled} title={t.def.note || undefined} onClick={() => onRun(t.def, {})}>
            {t.def.title}
          </button>
        ),
      )}

      <ActionMenu groups={model.menu} onPick={pick} />
      <IconButton icon="search" title="命令面板 (Ctrl+K)" onClick={onOpenPalette} />
      {trailing}

      {dialog && (
        <ParamDialog
          def={dialog.def}
          catalog={catalog}
          preset={dialog.preset}
          customFor={dialog.customFor}
          onRun={(args) => onRun(dialog.def, args)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function ToolbarControl({
  item,
  onRun,
  onDialog,
}: {
  item: ToolbarItem;
  onRun: (def: ActionDef, args: Record<string, string>) => void;
  onDialog: (def: ActionDef, preset?: Record<string, string>, customFor?: string) => void;
}) {
  const { def, param } = item;
  if (item.control === 'dialog' || !param) {
    return (
      <button type="button" className="btn small" disabled={!item.enabled} title={def.note || undefined} onClick={() => onDialog(def)}>
        {def.title}
      </button>
    );
  }
  const known = item.options.some((o) => o.value === item.current);
  return (
    <label className="tb-select" title={def.note || def.title}>
      <span className="tb-label">{param.label}</span>
      <select
        value={item.current}
        disabled={!item.enabled}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') return onDialog(def, { [param.name]: '' }, param.name);
          if (v) onRun(def, { [param.name]: v });
        }}
      >
        {!item.current && <option value="">{'—'}</option>}
        {item.current && !known && <option value={item.current}>{item.current}</option>}
        {item.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {param.allowCustom && <option value="__custom__">自定义…</option>}
      </select>
    </label>
  );
}
