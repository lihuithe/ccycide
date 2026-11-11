/** 输入框 `/` 本地补全（v1.1，T42）：内置命令 + 被控端扫描到的自定义命令和技能 */
import type { CustomCommand } from '../backend/types';

export interface CompletionItem {
  name: string;
  description: string;
  argumentHint: string;
  source: 'builtin' | 'user' | 'project';
}

/** Claude Code 常用内置斜杠命令（补全用，不是动作；目录里没有的命令也可以直接输入提交） */
const BUILTIN: [string, string, string][] = [
  ['model', '切换模型', '[模型]'],
  ['effort', '设置思考强度', '[low|medium|high|xhigh|max|auto]'],
  ['clear', '清空对话', ''],
  ['compact', '压缩上下文', '[说明]'],
  ['context', '查看上下文用量', ''],
  ['resume', '恢复历史会话', ''],
  ['rewind', '回退到检查点', ''],
  ['rename', '重命名会话', '<名称>'],
  ['add-dir', '添加工作目录', '<路径>'],
  ['cd', '切换工作目录', '<路径>'],
  ['usage', '用量和额度', ''],
  ['code-review', '代码审查', ''],
  ['diff', '查看改动', ''],
  ['init', '初始化项目说明', ''],
  ['export', '导出对话', '[文件名]'],
  ['permissions', '权限规则', ''],
  ['mcp', 'MCP 服务', ''],
  ['config', '设置', ''],
  ['memory', '记忆文件', ''],
  ['tasks', '后台任务', ''],
  ['fast', '快速模式', '[on|off]'],
  ['plan', '进入计划模式', '[描述]'],
  ['login', '登录', ''],
  ['help', '帮助', ''],
  ['exit', '退出', ''],
];

export function allCompletionItems(custom: CustomCommand[]): CompletionItem[] {
  const map = new Map<string, CompletionItem>();
  for (const [name, description, argumentHint] of BUILTIN) {
    map.set(name, { name, description, argumentHint, source: 'builtin' });
  }
  // 自定义（项目级优先于用户级）覆盖同名内置
  const ordered = [...custom].sort((a, b) => (a.source === 'project' ? 1 : 0) - (b.source === 'project' ? 1 : 0));
  for (const c of ordered) {
    map.set(c.name, {
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      source: c.source === 'project' ? 'project' : 'user',
    });
  }
  return [...map.values()];
}

/** 输入以 `/` 开头且还没有空格时才触发补全；返回查询词（不含斜杠），否则 null */
export function completionQuery(input: string): string | null {
  if (!input.startsWith('/')) return null;
  const rest = input.slice(1);
  return /\s/.test(rest) ? null : rest;
}

export function filterCompletions(items: CompletionItem[], query: string, limit = 8): CompletionItem[] {
  const q = query.toLowerCase();
  const prefix = items.filter((i) => i.name.toLowerCase().startsWith(q));
  const contains = items.filter((i) => !i.name.toLowerCase().startsWith(q) && i.name.toLowerCase().includes(q));
  return [...prefix, ...contains].slice(0, limit);
}

/** 选中后填入输入框的文本：命令名加一个空格，等待继续写参数 */
export function completionInsertText(item: CompletionItem): string {
  return `/${item.name} `;
}
