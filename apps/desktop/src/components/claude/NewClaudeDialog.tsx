import { useState } from 'react';
import type { ActionCatalog, LaunchOptions, ParamOption } from '../../backend/types';
import { DEFAULT_CUSTOM_PATTERN } from '../../lib/actions';
import { Modal } from '../common';
import { EnumField } from './ParamForm';

const PERMISSION_MODES: ParamOption[] = [
  { value: 'default', label: '默认（每次询问）' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: '计划模式' },
  { value: 'auto', label: '自动' },
];
const PERMISSION_LABELS: Record<string, string> = Object.fromEntries(PERMISSION_MODES.map((o) => [o.value, o.label]));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 取目录里的选项表；缺失时用内置兜底（不含跳过权限检查的模式） */
function optionsOf(catalog: ActionCatalog | undefined, key: string): ParamOption[] | null {
  return catalog?.options[key] ?? null;
}

export function NewClaudeDialog({
  catalog,
  homeDir,
  onSubmit,
  onClose,
}: {
  catalog: ActionCatalog | undefined;
  homeDir: string;
  onSubmit: (cwd: string, launch: LaunchOptions) => void;
  onClose: () => void;
}) {
  const models = optionsOf(catalog, 'models') ?? [];
  const efforts = (optionsOf(catalog, 'efforts') ?? EFFORTS.map((v) => ({ value: v, label: v }))).filter((o) => o.value !== 'auto');
  const modes = (optionsOf(catalog, 'permission_modes') ?? PERMISSION_MODES).map((o) => ({
    value: o.value,
    label: PERMISSION_LABELS[o.value] ?? o.label,
  }));

  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [effort, setEffort] = useState('');
  const [resume, setResume] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const errs: Record<string, string> = {};
    // eslint-disable-next-line no-control-regex
    const ctrl = /[\u0000-\u001f\u007f]/;
    if (ctrl.test(cwd)) errs.cwd = '不能包含换行或控制字符';
    if (model && !models.some((o) => o.value === model) && !new RegExp(DEFAULT_CUSTOM_PATTERN).test(model)) errs.model = '格式不合法（不能含空格或特殊符号）';
    if (ctrl.test(name) || name.length > 80) errs.name = '不能含控制字符，且不超过 80 字';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(cwd.trim(), { model, permissionMode: mode, effort, resume, sessionName: name.trim() });
    onClose();
  };

  return (
    <Modal
      title="新建 Claude Code"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            新建
          </button>
        </>
      }
    >
      <div className="param-form">
        <label className="field">
          <span className="field-label">工作目录</span>
          <div className="field-col">
            <input
              className={`input mono${errors.cwd ? ' invalid' : ''}`}
              value={cwd}
              placeholder={homeDir || '被控端主目录'}
              autoFocus
              onChange={(e) => setCwd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && submit()}
            />
            {errors.cwd && <div className="form-error">{errors.cwd}</div>}
          </div>
        </label>
        <label className="field">
          <span className="field-label">模型</span>
          <EnumField value={model} onChange={setModel} options={models} allowCustom placeholder="默认" error={errors.model} />
        </label>
        <label className="field">
          <span className="field-label">权限模式</span>
          <EnumField value={mode} onChange={setMode} options={modes} allowCustom={false} placeholder="默认" />
        </label>
        <label className="field">
          <span className="field-label">思考强度</span>
          <EnumField value={effort} onChange={setEffort} options={efforts} allowCustom={false} placeholder="默认" />
        </label>
        <div className="field">
          <span className="field-label">会话</span>
          <div className="segmented">
            {[
              ['', '新会话'],
              ['continue', '继续上次'],
              ['pick', '选择历史'],
            ].map(([v, label]) => (
              <button key={v} type="button" className={resume === v ? 'on' : ''} onClick={() => setResume(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">
            名称<em>可选</em>
          </span>
          <div className="field-col">
            <input className={`input${errors.name ? ' invalid' : ''}`} value={name} onChange={(e) => setName(e.target.value)} />
            {errors.name && <div className="form-error">{errors.name}</div>}
          </div>
        </label>
      </div>
    </Modal>
  );
}
