/** 默认设置与演示用的动作目录（对应方案 18.5.5）。Rust 侧的内置目录应与此保持同样的 id。 */
import type { ActionCatalog, ActionDef, ActionParam, ParamOption, Settings } from './types';

export function defaultSettings(): Settings {
  return {
    host: {
      enabled: true,
      requireConfirm: false,
      tempPasswordPolicy: 'on_start',
      fileReceive: true,
      notifyOnConnect: true,
      preventSleepWhenConnected: false,
      isolateTerminals: true,
      claudeIntegration: true,
      claudeStatusline: true,
      claudeIntegrationAll: false,
    },
    controller: { fontSize: 14, theme: 'auto', notifyOnDone: true, notifyOnPermission: true },
    server: { useSystemCerts: false },
    app: { autostart: false, closeToTray: true, updateChannel: 'stable', crashReport: false, safetyNoticeAcked: false },
  };
}

function param(p: Partial<ActionParam> & { name: string; label: string }): ActionParam {
  return {
    type: 'text',
    optionsRef: '',
    allowCustom: false,
    required: false,
    defaultValue: '',
    ...p,
  };
}

function action(a: Partial<ActionDef> & { id: string; title: string }): ActionDef {
  return {
    group: '',
    placement: 'menu',
    kind: 'submit',
    params: [],
    confirm: '',
    note: '',
    enabledWhen: '',
    ...a,
  };
}

const opt = (value: string, label = value): ParamOption => ({ value, label });

export function demoCatalog(): ActionCatalog {
  return {
    catalogVer: '2026-11-11',
    app: 'claude',
    options: {
      models: [
        opt('default', '默认'),
        opt('opus', 'Opus'),
        opt('sonnet', 'Sonnet'),
        opt('haiku', 'Haiku'),
        opt('fable', 'Fable'),
        opt('opus[1m]', 'Opus（1M 上下文）'),
        opt('sonnet[1m]', 'Sonnet（1M 上下文）'),
        opt('opusplan', '计划用 Opus，执行用 Sonnet'),
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'].map((v) => opt(v)),
      permission_modes: [opt('default', '默认'), opt('acceptEdits', '自动接受编辑'), opt('plan', '计划模式'), opt('auto', '自动')],
      onoff: [opt('on', '开'), opt('off', '关')],
    },
    actions: [
      action({
        id: 'model.set',
        title: '切换模型',
        group: '模型',
        placement: 'toolbar',
        params: [
          param({ name: 'model', label: '模型', type: 'enum', optionsRef: 'models', allowCustom: true, required: true }),
        ],
        note: '会同时保存为默认模型；只想本次生效请用“模型选择菜单”并按 s',
      }),
      action({
        id: 'effort.set',
        title: '思考强度',
        group: '模型',
        placement: 'toolbar',
        params: [param({ name: 'level', label: '强度', type: 'enum', optionsRef: 'efforts', required: true })],
      }),
      action({ id: 'mode.cycle', title: '切换权限模式', group: '模型', placement: 'toolbar', kind: 'keys' }),
      action({ id: 'interrupt', title: '停止', placement: 'toolbar', kind: 'keys', enabledWhen: 'busy' }),

      action({
        id: 'fast.set',
        title: '快速模式',
        group: '模型',
        params: [param({ name: 'state', label: '状态', type: 'enum', optionsRef: 'onoff', required: true })],
      }),
      action({ id: 'thinking.toggle', title: '思考 开/关', group: '模型', kind: 'keys' }),
      action({
        id: 'plan.enter',
        title: '进入计划模式',
        group: '模型',
        params: [param({ name: 'description', label: '描述（可空）' })],
      }),
      action({ id: 'model.menu', title: '模型选择菜单', group: '模型', kind: 'interactive' }),

      action({
        id: 'session.clear',
        title: '清空对话',
        group: '会话',
        confirm: '清空后当前对话的上下文将丢失',
      }),
      action({
        id: 'session.compact',
        title: '压缩上下文',
        group: '会话',
        params: [param({ name: 'instructions', label: '压缩说明（可空）' })],
      }),
      action({ id: 'context.show', title: '上下文用量详情', group: '会话', placement: 'palette_only' }),
      action({ id: 'session.resume', title: '恢复历史会话', group: '会话', kind: 'interactive' }),
      action({ id: 'session.rewind', title: '回退到检查点', group: '会话', kind: 'interactive' }),
      action({
        id: 'session.rename',
        title: '重命名会话',
        group: '会话',
        params: [param({ name: 'name', label: '名称', required: true })],
      }),
      action({
        id: 'dir.add',
        title: '添加工作目录',
        group: '目录',
        params: [param({ name: 'path', label: '路径', type: 'path', required: true })],
      }),
      action({
        id: 'dir.cd',
        title: '切换工作目录',
        group: '目录',
        params: [param({ name: 'path', label: '路径', type: 'path', required: true })],
      }),
      action({ id: 'usage', title: '用量和额度', group: '信息', kind: 'interactive' }),
      action({ id: 'review', title: '代码审查', group: '工具' }),
      action({ id: 'diff', title: '查看改动', group: '工具', kind: 'interactive' }),
      action({ id: 'init', title: '初始化项目说明', group: '工具' }),
      action({
        id: 'export',
        title: '导出对话',
        group: '工具',
        params: [param({ name: 'filename', label: '文件名', required: true })],
      }),
      action({ id: 'permissions', title: '权限规则', group: '设置', kind: 'interactive' }),
      action({ id: 'mcp', title: 'MCP 服务', group: '设置', kind: 'interactive' }),
      action({ id: 'config', title: '设置', group: '设置', kind: 'interactive' }),
      action({ id: 'memory', title: '记忆文件', group: '设置', kind: 'interactive' }),
      action({ id: 'verbose.toggle', title: '详细输出 开/关', group: '视图', kind: 'keys' }),
      action({ id: 'background', title: '转入后台运行', group: '视图', kind: 'keys' }),
      action({ id: 'tasks.list', title: '任务列表', group: '视图', kind: 'keys' }),
      action({ id: 'tasks.bg', title: '后台任务', group: '视图', kind: 'interactive' }),
      action({ id: 'login', title: '登录', group: '账号', kind: 'interactive' }),
      action({ id: 'exit', title: '退出 Claude Code', group: '账号', confirm: '将结束当前 Claude Code 会话' }),

      // 权限卡片按钮对应的动作，参数 notice_id 为内部参数
      action({
        id: 'permission.allow',
        title: '允许',
        placement: 'palette_only',
        kind: 'keys',
        params: [param({ name: 'notice_id', label: '通知', required: true })],
      }),
      action({
        id: 'permission.deny',
        title: '拒绝',
        placement: 'palette_only',
        kind: 'keys',
        params: [param({ name: 'notice_id', label: '通知', required: true })],
      }),
    ],
  };
}
