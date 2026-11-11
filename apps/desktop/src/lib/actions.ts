/**
 * 动作目录 → UI 模型（T38）。界面完全由目录生成，这里是纯函数：
 * 工具条（按钮/下拉/参数对话框）、更多菜单（按分组）、命令面板（全部可搜索项）。
 */
import { Features } from '../backend/types';
import type { ActionCatalog, ActionDef, ActionParam, AppState, CommandError, CustomCommand, ParamOption } from '../backend/types';

/** 前端约定的、会特殊处理的动作 id / 参数名（其余完全由目录决定） */
export const SPECIAL_ACTION = {
  contextShow: 'context.show',
  permissionAllow: 'permission.allow',
  permissionDeny: 'permission.deny',
} as const;
export const NOTICE_ID_PARAM = 'notice_id';

/** 枚举参数允许自定义值时的默认校验：不含空白、分号等 */
export const DEFAULT_CUSTOM_PATTERN = '^[A-Za-z0-9._:\\-\\[\\]/]{1,80}$';
export const TEXT_MAX_LEN = 2000;

export interface ActionGate {
  /** 会话是否 Ready（重连中/已关闭时动作不可用） */
  sessionReady: boolean;
  /** 对端 Hello 声明的能力 */
  features: ReadonlySet<string>;
  /** 终端的 AppState；没有状态回传时为 null 或 stateful=false */
  app: AppState | null;
}

export type ToolbarControl = 'button' | 'select' | 'dialog';

export interface ToolbarItem {
  def: ActionDef;
  control: ToolbarControl;
  /** select 时的唯一枚举参数 */
  param?: ActionParam;
  options: ParamOption[];
  /** select 当前值（来自状态回传），没有则为空 */
  current: string;
  enabled: boolean;
}

export interface MenuGroup {
  group: string;
  items: { def: ActionDef; enabled: boolean }[];
}

export interface PaletteItem {
  /** 目录动作或自定义命令 */
  kind: 'action' | 'command';
  key: string;
  title: string;
  hint: string;
  def?: ActionDef;
  command?: CustomCommand;
  enabled: boolean;
}

export interface ActionModel {
  /** 目录是否可用（声明了 app.actions 且有目录） */
  available: boolean;
  toolbar: ToolbarItem[];
  menu: MenuGroup[];
  palette: PaletteItem[];
}

/** 带 notice_id 参数的是权限卡片专用动作，不进菜单和面板 */
export function isInternalAction(def: ActionDef): boolean {
  return def.params.some((p) => p.name === NOTICE_ID_PARAM);
}

export function findAction(catalog: ActionCatalog | null | undefined, id: string): ActionDef | undefined {
  return catalog?.actions.find((a) => a.id === id);
}

export function paramOptions(catalog: ActionCatalog, p: ActionParam): ParamOption[] {
  return p.optionsRef ? (catalog.options[p.optionsRef] ?? []) : [];
}

/** 动作当前是否可点：会话就绪；enabled_when 为 busy/idle 时依状态回传（无回传则始终可点） */
export function isActionEnabled(def: ActionDef, gate: ActionGate): boolean {
  if (!gate.sessionReady) return false;
  const app = gate.app;
  if (!app || !app.stateful) return true;
  if (def.enabledWhen === 'busy') return app.activity === 'busy';
  if (def.enabledWhen === 'idle') return app.activity === 'idle';
  return true;
}

/** 当前值：依参数名从状态回传里取（model → 模型 id，level/effort → 强度） */
export function currentValueFor(def: ActionDef, app: AppState | null): string {
  if (!app || !app.stateful) return '';
  const p = def.params[0];
  if (!p) return '';
  switch (p.name) {
    case 'model':
      return app.modelId;
    case 'level':
    case 'effort':
      return app.effort;
    default:
      return '';
  }
}

export function buildActionModel(
  catalog: ActionCatalog | null | undefined,
  gate: ActionGate,
  commands: CustomCommand[] = [],
): ActionModel {
  const empty: ActionModel = { available: false, toolbar: [], menu: [], palette: [] };
  const actionsOn = gate.features.has(Features.appActions);
  const commandsOn = gate.features.has(Features.appCommands);
  const visible = actionsOn && catalog ? catalog.actions.filter((a) => !isInternalAction(a)) : [];

  const palette: PaletteItem[] = visible.map((def) => ({
    kind: 'action',
    key: 'a:' + def.id,
    title: def.title,
    hint: def.group,
    def,
    enabled: isActionEnabled(def, gate),
  }));
  if (commandsOn) {
    for (const c of commands) {
      palette.push({
        kind: 'command',
        key: 'c:' + c.name,
        title: '/' + c.name,
        hint: c.description || c.argumentHint,
        command: c,
        enabled: gate.sessionReady,
      });
    }
  }
  if (!catalog || !actionsOn) return { ...empty, palette };

  const toolbar: ToolbarItem[] = visible
    .filter((d) => d.placement === 'toolbar')
    .map((def) => {
      const enumParams = def.params.filter((p) => p.type === 'enum');
      const single = def.params.length === 1 && enumParams.length === 1 ? enumParams[0] : undefined;
      const control: ToolbarControl = def.params.length === 0 ? 'button' : single ? 'select' : 'dialog';
      return {
        def,
        control,
        param: single,
        options: single ? paramOptions(catalog, single) : [],
        current: single ? currentValueFor(def, gate.app) : '',
        enabled: isActionEnabled(def, gate),
      };
    });

  const groups = new Map<string, MenuGroup>();
  for (const def of visible.filter((d) => d.placement === 'menu')) {
    const g = def.group || '其他';
    if (!groups.has(g)) groups.set(g, { group: g, items: [] });
    groups.get(g)!.items.push({ def, enabled: isActionEnabled(def, gate) });
  }
  return { available: true, toolbar, menu: [...groups.values()], palette };
}

/** 参数缺省值：enum 取 defaultValue，其余为空 */
export function initialArgs(def: ActionDef): Record<string, string> {
  const args: Record<string, string> = {};
  for (const p of def.params) args[p.name] = p.defaultValue;
  return args;
}

/** 不需要参数对话框就能直接执行的动作 */
export function needsParamInput(def: ActionDef): boolean {
  return def.params.length > 0;
}

/** 校验一个参数值；通过返回 null */
export function validateParam(p: ActionParam, value: string, options: ParamOption[]): string | null {
  const v = value;
  if (!v.trim()) return p.required ? `请填写${p.label}` : null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return '不能包含换行或控制字符';
  if (p.type === 'enum') {
    if (options.some((o) => o.value === v)) return null;
    if (!p.allowCustom) return '不在可选项里';
    try {
      if (!new RegExp(p.pattern ?? DEFAULT_CUSTOM_PATTERN).test(v)) return '格式不合法（不能含空格或特殊符号）';
    } catch {
      return '格式不合法';
    }
    return null;
  }
  if (v.length > TEXT_MAX_LEN) return `不能超过 ${TEXT_MAX_LEN} 个字符`;
  return null;
}

export function validateArgs(def: ActionDef, args: Record<string, string>, catalog: ActionCatalog): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const p of def.params) {
    const e = validateParam(p, args[p.name] ?? '', paramOptions(catalog, p));
    if (e) errors[p.name] = e;
  }
  return errors;
}

/** 命令面板过滤：子序列匹配标题/分组/id，连续命中和靠前的得分更高；未匹配返回 -1 */
export function fuzzyScore(query: string, ...texts: string[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = -1;
  for (const t of texts) {
    const s = scoreOne(q, t.toLowerCase());
    if (s > best) best = s;
  }
  return best;
}

function scoreOne(q: string, t: string): number {
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx * 2 - (t.length - q.length);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 8);
    ti = found + 1;
  }
  return score;
}

export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  return items
    .map((it) => ({ it, s: fuzzyScore(query, it.title, it.def?.id ?? it.command?.name ?? '', it.hint) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}

/** 动作失败时的提示 */
export function actionErrorText(e: CommandError): string {
  switch (e.code) {
    case 'APP_NOT_RUNNING':
      return '这个终端里没有在运行 Claude Code';
    case 'UNSUPPORTED':
      return '被控端不支持这个操作';
    case 'BUSY':
      return '被控端操作队列已满，请稍后再试';
    case 'BAD_REQUEST':
      return e.message || '参数不合法或请求已失效';
    case 'TERM_NOT_FOUND':
      return '终端已不存在';
    case 'NOT_READY':
      return '尚未连接，暂不能执行';
    default:
      return e.message || '操作失败';
  }
}

/** 权限卡片能否显示“允许”：参数被截断（truncated）时远程看不全，只能拒绝或回终端处理 */
export function canAllowPermission(notice: { truncated: boolean }): boolean {
  return !notice.truncated;
}
