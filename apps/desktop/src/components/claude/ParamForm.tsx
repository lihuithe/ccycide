import { useState } from 'react';
import type { ActionCatalog, ActionDef, ActionParam, ParamOption } from '../../backend/types';
import { paramOptions } from '../../lib/actions';

const CUSTOM = '__custom__';

/** 枚举字段：下拉；允许自定义时底部有“自定义…”，切换成文本输入 */
export function EnumField({
  value,
  onChange,
  options,
  allowCustom,
  placeholder,
  error,
  autoFocus,
  initialCustom,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ParamOption[];
  allowCustom: boolean;
  placeholder?: string;
  error?: string;
  autoFocus?: boolean;
  initialCustom?: boolean;
}) {
  const inList = options.some((o) => o.value === value);
  const [custom, setCustom] = useState(!!initialCustom || (!!value && !inList));
  return (
    <div className="field-col">
      {custom ? (
        <div className="custom-row">
          <input
            className={`input mono${error ? ' invalid' : ''}`}
            value={value}
            placeholder="完整模型名"
            autoFocus
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setCustom(false);
              onChange('');
            }}
          >
            选择
          </button>
        </div>
      ) : (
        <select
          className={`input${error ? ' invalid' : ''}`}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              onChange('');
            } else onChange(e.target.value);
          }}
        >
          <option value="">{placeholder ?? '请选择'}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {allowCustom && <option value={CUSTOM}>自定义…</option>}
        </select>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

/** 按动作的参数定义渲染表单；用在参数对话框和命令面板里 */
export function ParamForm({
  def,
  catalog,
  args,
  setArgs,
  errors,
  onEnter,
  customFor,
}: {
  def: ActionDef;
  catalog: ActionCatalog;
  args: Record<string, string>;
  setArgs: (a: Record<string, string>) => void;
  errors: Record<string, string>;
  onEnter?: () => void;
  /** 该参数一开始就进入自定义输入 */
  customFor?: string;
}) {
  const set = (name: string, v: string) => setArgs({ ...args, [name]: v });
  return (
    <div className="param-form">
      {def.params.map((p: ActionParam, i) => (
        <label key={p.name} className="field">
          <span className="field-label">
            {p.label}
            {!p.required && <em>可选</em>}
          </span>
          {p.type === 'enum' ? (
            <EnumField
              value={args[p.name] ?? ''}
              onChange={(v) => set(p.name, v)}
              options={paramOptions(catalog, p)}
              allowCustom={p.allowCustom}
              error={errors[p.name]}
              autoFocus={i === 0}
              initialCustom={p.name === customFor}
            />
          ) : (
            <div className="field-col">
              <input
                className={`input${p.type === 'path' ? ' mono' : ''}${errors[p.name] ? ' invalid' : ''}`}
                value={args[p.name] ?? ''}
                autoFocus={i === 0}
                onChange={(e) => set(p.name, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault();
                    onEnter?.();
                  }
                }}
              />
              {errors[p.name] && <div className="form-error">{errors[p.name]}</div>}
            </div>
          )}
        </label>
      ))}
      {def.note && <div className="note-line">{def.note}</div>}
    </div>
  );
}
