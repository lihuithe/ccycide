import { describe, expect, it } from 'vitest';
import { demoCatalog } from '../backend/mockData';
import type { AppState } from '../backend/types';
import {
  actionErrorText,
  buildActionModel,
  currentValueFor,
  filterPalette,
  findAction,
  isActionEnabled,
  isInternalAction,
  validateArgs,
  validateParam,
  type ActionGate,
} from './actions';

const catalog = demoCatalog();
const ALL = new Set(['app.actions', 'app.state', 'app.commands']);

function appState(p: Partial<AppState> = {}): AppState {
  return {
    app: 'claude', running: true, stateful: true, version: '2.1', activity: 'idle', model: 'Opus', modelId: 'opus',
    effort: 'high', fastMode: false, thinking: false, contextUsedPct: 40, hasContext: true, cwd: '', sessionId: '',
    sessionName: '', costUsd: 0, ...p,
  };
}
const gate = (p: Partial<ActionGate> = {}): ActionGate => ({ sessionReady: true, features: ALL, app: appState(), ...p });

describe('buildActionModel', () => {
  it('工具条按 placement 与参数形态渲染：无参按钮、单枚举下拉', () => {
    const m = buildActionModel(catalog, gate());
    const byId = Object.fromEntries(m.toolbar.map((t) => [t.def.id, t]));
    expect(m.toolbar.map((t) => t.def.id)).toEqual(['model.set', 'effort.set', 'mode.cycle', 'interrupt']);
    expect(byId['model.set'].control).toBe('select');
    expect(byId['model.set'].options.length).toBeGreaterThan(3);
    expect(byId['mode.cycle'].control).toBe('button');
  });

  it('下拉的当前值来自状态回传，无回传时为空', () => {
    const m = buildActionModel(catalog, gate());
    expect(m.toolbar.find((t) => t.def.id === 'model.set')!.current).toBe('opus');
    expect(m.toolbar.find((t) => t.def.id === 'effort.set')!.current).toBe('high');
    const m2 = buildActionModel(catalog, gate({ app: appState({ stateful: false }) }));
    expect(m2.toolbar.find((t) => t.def.id === 'model.set')!.current).toBe('');
  });

  it('更多菜单按分组，不含工具条动作、palette_only 与权限内部动作', () => {
    const m = buildActionModel(catalog, gate());
    const ids = m.menu.flatMap((g) => g.items.map((i) => i.def.id));
    expect(ids).toContain('session.clear');
    expect(ids).not.toContain('model.set');
    expect(ids).not.toContain('context.show');
    expect(ids).not.toContain('permission.allow');
    expect(m.menu.map((g) => g.group)).toContain('会话');
  });

  it('命令面板包含全部非内部动作，含 palette_only', () => {
    const m = buildActionModel(catalog, gate());
    const ids = m.palette.map((p) => p.def?.id);
    expect(ids).toContain('context.show');
    expect(ids).toContain('model.set');
    expect(ids).not.toContain('permission.deny');
  });

  it('未声明 app.actions 时整套动作隐藏，只剩自定义命令', () => {
    const cmds = [{ name: 'deploy', description: '部署', argumentHint: '', source: 'project' }];
    const m = buildActionModel(catalog, gate({ features: new Set(['app.commands']) }), cmds);
    expect(m.available).toBe(false);
    expect(m.toolbar).toEqual([]);
    expect(m.menu).toEqual([]);
    expect(m.palette.map((p) => p.title)).toEqual(['/deploy']);
  });

  it('未声明 app.commands 时不出现自定义命令', () => {
    const cmds = [{ name: 'deploy', description: '部署', argumentHint: '', source: 'project' }];
    const m = buildActionModel(catalog, gate({ features: new Set(['app.actions']) }), cmds);
    expect(m.palette.some((p) => p.kind === 'command')).toBe(false);
  });

  it('没有目录时不可用', () => {
    expect(buildActionModel(null, gate()).available).toBe(false);
  });
});

describe('enabled_when 与会话状态', () => {
  const stop = findAction(catalog, 'interrupt')!;
  it('停止：工作中可点，空闲置灰', () => {
    expect(isActionEnabled(stop, gate({ app: appState({ activity: 'busy' }) }))).toBe(true);
    expect(isActionEnabled(stop, gate({ app: appState({ activity: 'idle' }) }))).toBe(false);
    expect(isActionEnabled(stop, gate({ app: appState({ activity: 'waiting_permission' }) }))).toBe(false);
  });

  it('没有状态回传时始终可点', () => {
    expect(isActionEnabled(stop, gate({ app: null }))).toBe(true);
    expect(isActionEnabled(stop, gate({ app: appState({ stateful: false }) }))).toBe(true);
  });

  it('会话未就绪时全部不可点', () => {
    expect(isActionEnabled(findAction(catalog, 'mode.cycle')!, gate({ sessionReady: false }))).toBe(false);
  });

  it('currentValueFor 对无参动作为空', () => {
    expect(currentValueFor(stop, appState())).toBe('');
  });
});

describe('参数校验', () => {
  const model = findAction(catalog, 'model.set')!;
  const p = model.params[0];
  const opts = catalog.options.models;

  it('选项内的值通过', () => {
    expect(validateParam(p, 'opus', opts)).toBeNull();
  });

  it('自定义完整模型名通过；含空格或分号被拒', () => {
    expect(validateParam(p, 'claude-opus-4-1', opts)).toBeNull();
    expect(validateParam(p, 'opus[1m]', opts)).toBeNull();
    expect(validateParam(p, 'my model', opts)).not.toBeNull();
    expect(validateParam(p, 'a;rm -rf', opts)).not.toBeNull();
  });

  it('必填缺失', () => {
    expect(validateParam(p, '  ', opts)).toContain('模型');
  });

  it('不允许自定义的枚举必须在列表里', () => {
    const effort = findAction(catalog, 'effort.set')!.params[0];
    expect(validateParam(effort, 'high', catalog.options.efforts)).toBeNull();
    expect(validateParam(effort, 'ultra', catalog.options.efforts)).not.toBeNull();
  });

  it('文本：换行/控制字符拒绝，过长拒绝，可选为空通过', () => {
    const t = findAction(catalog, 'session.compact')!.params[0];
    expect(validateParam(t, '', [])).toBeNull();
    expect(validateParam(t, 'a\nb', [])).not.toBeNull();
    expect(validateParam(t, 'x'.repeat(2001), [])).not.toBeNull();
    expect(validateParam(t, '只保留代码改动', [])).toBeNull();
  });

  it('validateArgs 汇总各参数错误', () => {
    expect(validateArgs(model, { model: 'bad value' }, catalog)).toHaveProperty('model');
    expect(validateArgs(model, { model: 'sonnet' }, catalog)).toEqual({});
  });
});

describe('命令面板过滤', () => {
  const items = buildActionModel(catalog, gate()).palette;
  it('按标题匹配', () => {
    const r = filterPalette(items, '压缩');
    expect(r[0].def?.id).toBe('session.compact');
  });
  it('按 id 匹配', () => {
    expect(filterPalette(items, 'session.clear')[0].def?.id).toBe('session.clear');
  });
  it('子序列模糊匹配', () => {
    expect(filterPalette(items, 'qkdh').length).toBe(0);
    expect(filterPalette(items, 'ssr').some((i) => i.def?.id === 'session.rewind' || i.def?.id === 'session.resume')).toBe(true);
  });
  it('空查询返回全部', () => {
    expect(filterPalette(items, '')).toHaveLength(items.length);
  });
});

describe('其它', () => {
  it('权限内部动作识别', () => {
    expect(isInternalAction(findAction(catalog, 'permission.allow')!)).toBe(true);
    expect(isInternalAction(findAction(catalog, 'model.set')!)).toBe(false);
  });
  it('错误码文案', () => {
    expect(actionErrorText({ code: 'APP_NOT_RUNNING', message: '' })).toBe('这个终端里没有在运行 Claude Code');
    expect(actionErrorText({ code: 'X', message: '自定义' })).toBe('自定义');
  });
});
