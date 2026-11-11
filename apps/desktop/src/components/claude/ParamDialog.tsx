import { useState } from 'react';
import type { ActionCatalog, ActionDef } from '../../backend/types';
import { initialArgs, validateArgs } from '../../lib/actions';
import { Modal } from '../common';
import { ParamForm } from './ParamForm';

/** 需要输入参数的动作：弹出对话框，确认后执行 */
export function ParamDialog({
  def,
  catalog,
  preset,
  customFor,
  onRun,
  onClose,
}: {
  def: ActionDef;
  catalog: ActionCatalog;
  preset?: Record<string, string>;
  customFor?: string;
  onRun: (args: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [args, setArgs] = useState<Record<string, string>>({ ...initialArgs(def), ...preset });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = () => {
    const errs = validateArgs(def, args, catalog);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onRun(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v.trim()])));
    onClose();
  };

  return (
    <Modal
      title={def.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={run}>
            执行
          </button>
        </>
      }
    >
      <ParamForm def={def} catalog={catalog} args={args} setArgs={setArgs} errors={errors} onEnter={run} customFor={customFor} />
    </Modal>
  );
}
