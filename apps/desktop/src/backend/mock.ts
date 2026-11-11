/**
 * 纯浏览器假后端：在没有 Tauri 的环境里演示全部界面。
 * 内置演示指令（在假终端的 shell 里输入）：
 *   help | ls | color | flood | vim | claude | net-drop | term-busy | clear | exit
 * 设备码 333333333 → 对方设置了连接确认，20 秒后才同意（等待期间可取消）；设备码 000000000 → 不在线；111111111 → 被拒绝；222222222 → 被锁定；密码填 wrong → 密码错误。
 */
import { toCommandError, type Backend } from './index';
import { defaultSettings, demoCatalog } from './mockData';
import { TEMP_PASSWORD_CHARSET } from '../lib/password';
import type {
  ActionCatalog,
  ActionDef,
  ActionOutcome,
  Activity,
  AppState,
  CommandError,
  CoreEvent,
  FileId,
  HostInfo,
  KnownHost,
  LocalInfo,
  OutputHandler,
  SessionId,
  Settings,
  TermAttachParams,
  TermId,
  TermInfo,
  TermModes,
  TermOpened,
  TermOpenParams,
  TermProfile,
  UploadBytesParams,
  UploadStarted,
} from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const err = (code: string, message: string): CommandError => ({ code, message });

// ———————————————————— 文本工具 ————————————————————

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  orange: '\x1b[38;5;208m',
  gray: '\x1b[90m',
};

/** 终端显示宽度：CJK 与全角符号占 2 列 */
function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return w;
}

function box(lines: string[], width = 54): string {
  const body = lines.map((l) => `${C.orange}│${C.reset} ${l}${' '.repeat(Math.max(0, width - 2 - cellWidth(strip(l))))} ${C.orange}│${C.reset}`);
  return [`${C.orange}╭${'─'.repeat(width)}╮${C.reset}`, ...body, `${C.orange}╰${'─'.repeat(width)}╯${C.reset}`].join('\r\n') + '\r\n';
}

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function randomTempPassword(): string {
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return [...a].map((n) => TEMP_PASSWORD_CHARSET[n % TEMP_PASSWORD_CHARSET.length]).join('');
}

// ———————————————————— 假终端 ————————————————————

type TermMode = 'shell' | 'claude' | 'vim' | 'menu';

interface PendingPermission {
  noticeId: string;
  resolve: (allowed: boolean) => void;
}

class MockTerm {
  seq = 0;
  mode: TermMode;
  lineBuf = '';
  modes: TermModes = { bracketedPaste: true, altScreen: false, appCursor: false, mouse: false, title: '' };
  app: AppState;
  timers: ReturnType<typeof setTimeout>[] = [];
  permission: PendingPermission | null = null;
  menu: { items: string[]; index: number; title: string } | null = null;
  workToken = 0;
  closed = false;
  noticeSeq = 1;

  constructor(
    readonly sessionId: SessionId,
    readonly termId: TermId,
    readonly profile: TermProfile,
    public onOutput: OutputHandler,
    readonly host: MockHost,
    launch?: TermOpenParams['launch'],
  ) {
    this.mode = profile === 'claude' ? 'claude' : 'shell';
    this.app = this.emptyApp();
    this.modes.title = profile === 'claude' ? 'Claude Code' : 'PowerShell';
    if (profile === 'claude') {
      this.app = {
        ...this.emptyApp(),
        app: 'claude',
        running: true,
        stateful: true,
        version: '2.1.322',
        model: modelLabel(launch?.model || 'default'),
        modelId: launch?.model || 'default',
        effort: launch?.effort || 'auto',
        hasContext: true,
        contextUsedPct: 3,
        cwd: 'C:\\Users\\demo\\project',
        sessionId: 'sess-' + this.termId,
        sessionName: launch?.sessionName || '',
      };
      this.write(this.claudeBanner());
      if (launch?.resume === 'pick') this.openMenu('恢复历史会话', ['修复登录页样式（2 小时前）', '重构终端组件（昨天）', '写发布说明（3 天前）']);
    } else {
      this.write(`${C.cyan}RTerm 演示终端${C.reset}（浏览器模式，输入 ${C.yellow}help${C.reset} 查看指令）\r\n`);
      this.prompt();
    }
  }

  emptyApp(): AppState {
    return {
      app: '', running: false, stateful: false, version: '', activity: 'idle', model: '', modelId: '', effort: '',
      fastMode: false, thinking: false, contextUsedPct: 0, hasContext: false, cwd: '', sessionId: '', sessionName: '', costUsd: 0,
    };
  }

  // —— 输出 ——
  write(s: string) {
    if (this.closed) return;
    const data = enc.encode(s);
    this.onOutput({ seq: this.seq, data });
    this.seq += data.length;
  }

  later(ms: number, fn: () => void) {
    this.timers.push(setTimeout(() => !this.closed && fn(), ms));
  }

  dispose() {
    this.closed = true;
    this.timers.forEach(clearTimeout);
  }

  pushApp(patch?: Partial<AppState>) {
    this.app = { ...this.app, ...patch };
    this.host.emit({ type: 'appState', sessionId: this.sessionId, termId: this.termId, state: { ...this.app } });
  }

  setModes(patch: Partial<TermModes>) {
    this.modes = { ...this.modes, ...patch };
    this.host.emit({ type: 'termState', sessionId: this.sessionId, termId: this.termId, state: { ...this.modes } });
  }

  prompt() {
    this.write(`${C.green}PS C:\\Users\\demo>${C.reset} `);
  }

  claudeBanner(): string {
    return (
      '\r\n' +
      box([
        `${C.orange}✻${C.reset} ${C.bold}欢迎使用 Claude Code${C.reset}（演示）`,
        `  ${C.gray}/help 查看帮助 · cwd: C:\\Users\\demo\\project${C.reset}`,
      ]) +
      '\r\n' +
      `${C.gray}  提示：在下方输入框写好消息后回车提交${C.reset}\r\n\r\n`
    );
  }

  // —— 输入框提交 ——
  submit(text: string, attachments: string[]) {
    const tail = attachments.length ? ` ${C.gray}[附件 ${attachments.length}]${C.reset}` : '';
    if (this.mode === 'shell') {
      this.write(text.replace(/\n/g, '\r\n') + tail + '\r\n');
      this.runShell(text.trim());
    } else if (this.mode === 'claude') {
      this.write(`${C.dim}>${C.reset} ${text.replace(/\n/g, '\r\n  ')}${tail}\r\n`);
      if (text.trim().startsWith('/')) {
        this.write(`${C.gray}  ⎿ 已执行 ${text.trim().split(/\s+/)[0]}${C.reset}\r\n\r\n`);
      } else {
        this.startWork(text);
      }
    }
  }

  // —— 直通输入 ——
  input(data: string) {
    if (this.mode === 'menu' && this.menu) return this.menuKey(data);
    if (this.mode === 'vim') {
      if (data === 'q' || data === ':q\r' || data === '\x1b') this.exitVim();
      return;
    }
    if (this.profile === 'claude' && this.app.running) {
      if (this.permission && (data === '\r' || data === '\x1b')) {
        this.permission.resolve(data === '\r');
        return;
      }
      if (data === '\x1b' && this.app.activity === 'busy') return this.interrupt();
    }
    // 回显 + 行编辑
    for (const ch of data) {
      if (ch === '\r') {
        this.write('\r\n');
        const line = this.lineBuf;
        this.lineBuf = '';
        if (this.mode === 'shell') this.runShell(line.trim());
      } else if (ch === '\x7f') {
        if (this.lineBuf.length) {
          this.lineBuf = this.lineBuf.slice(0, -1);
          this.write('\b \b');
        }
      } else if (ch === '\x03') {
        this.write('^C\r\n');
        this.lineBuf = '';
        if (this.mode === 'shell') this.prompt();
      } else if (ch === '\x0c') {
        this.write('\x1b[2J\x1b[H');
        if (this.mode === 'shell') this.prompt();
      } else if (ch >= ' ' && !ch.startsWith('\x1b')) {
        this.lineBuf += ch;
        this.write(ch);
      }
    }
  }

  // —— shell ——
  runShell(cmd: string) {
    const [name, ...rest] = cmd.split(/\s+/);
    switch (name) {
      case '':
        break;
      case 'help':
        this.write(
          [
            `${C.bold}演示指令${C.reset}`,
            `  ${C.yellow}ls${C.reset}       彩色目录列表（含中文文件名）`,
            `  ${C.yellow}color${C.reset}    256 色色板`,
            `  ${C.yellow}flood${C.reset}    高速输出 2 万行（测试流控）`,
            `  ${C.yellow}vim${C.reset}      进入备用屏幕（shell 标签自动切换直通）`,
            `  ${C.yellow}claude${C.reset}   在 shell 里启动 Claude Code（无状态回传，工具条降级）`,
            `  ${C.yellow}net-drop${C.reset} 模拟断网，约 7 秒后自动重连`,
            `  ${C.yellow}term-busy${C.reset} 模拟本终端被其他设备占用（TERM_BUSY）`,
            `  ${C.yellow}clear${C.reset}    清屏`,
            '',
          ].join('\r\n'),
        );
        break;
      case 'ls':
        this.write(
          `${C.blue}src${C.reset}  ${C.blue}文档${C.reset}  ${C.blue}node_modules${C.reset}  package.json  ${C.green}build.sh${C.reset}  README.md  ${C.red}日志归档.zip${C.reset}\r\n`,
        );
        break;
      case 'color': {
        let s = '';
        for (let i = 0; i < 256; i++) {
          s += `\x1b[48;5;${i}m  ${C.reset}`;
          if ((i + 1) % 32 === 0) s += '\r\n';
        }
        this.write(s + '\r\n中文 emoji 🙂 宽度 │ 表格 ┌──┬──┐\r\n');
        break;
      }
      case 'flood': {
        const total = 20000;
        let i = 0;
        const step = () => {
          if (this.closed) return;
          let chunk = '';
          for (let k = 0; k < 400 && i < total; k++, i++) {
            chunk += `\x1b[3${1 + (i % 6)}m第 ${i} 行${C.reset} ${'█'.repeat(i % 40)} 流控测试\r\n`;
          }
          this.write(chunk);
          if (i < total) this.later(4, step);
          else this.prompt();
        };
        step();
        return;
      }
      case 'vim':
        this.mode = 'vim';
        this.setModes({ altScreen: true });
        this.write('\x1b[?1049h\x1b[2J\x1b[H');
        for (let r = 1; r <= 12; r++) this.write(`${C.blue}~${C.reset}\r\n`);
        this.write(`\x1b[2;3H${C.bold}演示 vim${C.reset}：按 q 退出\x1b[H`);
        return;
      case 'claude':
        this.mode = 'claude';
        this.write(this.claudeBanner());
        this.app = { ...this.emptyApp(), app: 'claude', running: true, stateful: false, version: '2.1.322' };
        this.pushApp();
        return;
      case 'net-drop':
        this.write(`${C.yellow}即将模拟断网…${C.reset}\r\n`);
        this.host.simulateDrop(this.sessionId);
        this.prompt();
        return;
      case 'clear':
        this.write('\x1b[2J\x1b[H');
        break;
      case 'exit':
        this.write('exit\r\n');
        this.host.emit({ type: 'termExit', sessionId: this.sessionId, termId: this.termId, code: 0 });
        return;
      default:
        this.write(`${name} : 无法识别的命令 "${[name, ...rest].join(' ')}"\r\n`);
    }
    this.prompt();
  }

  exitVim() {
    this.write('\x1b[?1049l');
    this.mode = 'shell';
    this.setModes({ altScreen: false });
    this.prompt();
  }

  // —— Claude 模拟 ——
  startWork(text: string) {
    const token = ++this.workToken;
    this.pushApp({ activity: 'busy' });
    const lines = [
      `${C.orange}✻${C.reset} 正在思考…`,
      `${C.dim}● 读取 src/components/Terminal.tsx${C.reset}`,
      `${C.dim}● 分析 ${text.slice(0, 20).replace(/\s+/g, ' ')} 相关代码${C.reset}`,
    ];
    let i = 0;
    const needPerm = /构建|build|rm |删除/i.test(text);
    const step = async () => {
      if (token !== this.workToken) return;
      if (i < lines.length) {
        this.write(`  ${lines[i++]}\r\n`);
        return this.later(700, step);
      }
      if (needPerm && !this.permission) {
        const noticeId = String(this.noticeSeq++);
        this.pushApp({ activity: 'waiting_permission' });
        this.write(`\r\n${C.yellow}╭ 需要确认 ─────────────────────╮${C.reset}\r\n${C.yellow}│${C.reset} Bash: npm run build\r\n${C.yellow}│${C.reset} ${C.green}❯ 1. 允许${C.reset}  2. 拒绝\r\n${C.yellow}╰────────────────────────────────╯${C.reset}\r\n`);
        this.host.emit({
          type: 'appNotice', sessionId: this.sessionId, termId: this.termId,
          notice: { kind: 'permission', title: '需要你确认', text: '', noticeId, toolName: 'Bash', toolSummary: 'npm run build', resolved: false },
        });
        const allowed = await new Promise<boolean>((resolve) => {
          this.permission = { noticeId, resolve };
        });
        this.permission = null;
        if (token !== this.workToken) return;
        this.host.emit({
          type: 'appNotice', sessionId: this.sessionId, termId: this.termId,
          notice: { kind: 'permission', title: '', text: '', noticeId, toolName: '', toolSummary: '', resolved: true },
        });
        this.pushApp({ activity: 'busy' });
        this.write(allowed ? `  ${C.green}✔ 已允许，构建完成${C.reset}\r\n` : `  ${C.red}✘ 已拒绝${C.reset}\r\n`);
        await sleep(600);
        if (token !== this.workToken) return;
      }
      this.write(
        `\r\n${C.orange}●${C.reset} 完成。已根据你的描述检查了相关文件，没有发现问题。\r\n  这是演示输出，包含中文、${C.cyan}彩色${C.reset}与框线：\r\n`,
      );
      this.write(`  ┌──────────┬────────┐\r\n  │ 文件     │ 状态   │\r\n  ├──────────┼────────┤\r\n  │ 终端组件 │ ${C.green}正常${C.reset}   │\r\n  └──────────┴────────┘\r\n\r\n`);
      this.pushApp({
        activity: 'idle',
        contextUsedPct: Math.min(99, this.app.contextUsedPct + 17),
        costUsd: Math.round((this.app.costUsd + 0.0731) * 10000) / 10000,
      });
      this.host.emit({
        type: 'appNotice', sessionId: this.sessionId, termId: this.termId,
        notice: { kind: 'done', title: '任务完成', text: '', noticeId: '', toolName: '', toolSummary: '', resolved: false },
      });
    };
    this.later(500, step);
  }

  interrupt() {
    this.workToken++;
    this.permission = null;
    this.write(`\r\n  ${C.red}⎿ 已中断${C.reset}\r\n\r\n`);
    this.pushApp({ activity: 'idle' });
  }

  // —— 交互菜单 ——
  openMenu(title: string, items: string[]) {
    this.mode = 'menu';
    this.menu = { items, index: 0, title };
    this.setModes({ appCursor: true });
    this.write(`\r\n${C.bold}${title}${C.reset}${C.gray}（↑↓ 选择，Enter 确认，Esc 取消）${C.reset}\r\n`);
    this.drawMenu(false);
  }

  drawMenu(redraw: boolean) {
    if (!this.menu) return;
    const { items, index } = this.menu;
    let s = redraw ? `\x1b[${items.length}A\r\x1b[J` : '';
    s += items.map((it, i) => (i === index ? `${C.cyan}❯ ${it}${C.reset}` : `  ${it}`)).join('\r\n') + '\r\n';
    this.write(s);
  }

  menuKey(data: string) {
    const m = this.menu;
    if (!m) return;
    if (data === '\x1b[A' || data === '\x1bOA') m.index = (m.index + m.items.length - 1) % m.items.length;
    else if (data === '\x1b[B' || data === '\x1bOB') m.index = (m.index + 1) % m.items.length;
    else if (data === '\r' || data === '\x1b') {
      const pick = data === '\r' ? `${C.green}已选择：${m.items[m.index]}${C.reset}` : `${C.gray}已取消${C.reset}`;
      this.menu = null;
      this.mode = this.profile === 'claude' || this.app.app === 'claude' ? 'claude' : 'shell';
      this.setModes({ appCursor: false });
      this.write(`${pick}\r\n\r\n`);
      return;
    } else return;
    this.drawMenu(true);
  }

  // —— 动作 ——
  runAction(def: ActionDef, args: Record<string, string>): ActionOutcome {
    if (!this.app.running || this.app.app !== 'claude') throw err('APP_NOT_RUNNING', '这个终端里没有在运行 Claude Code');
    for (const p of def.params) {
      if (p.required && !args[p.name]) throw err('BAD_REQUEST', `缺少参数：${p.label}`);
    }
    switch (def.id) {
      case 'permission.allow':
      case 'permission.deny': {
        if (!this.permission || this.permission.noticeId !== args.notice_id) throw err('BAD_REQUEST', '该请求已失效');
        this.permission.resolve(def.id === 'permission.allow');
        return { passthrough: false, returnKeys: [] };
      }
      case 'interrupt':
        this.interrupt();
        return { passthrough: false, returnKeys: [] };
      case 'model.set':
        this.write(`${C.dim}>${C.reset} /model ${args.model}\r\n  ${C.gray}⎿ 模型已切换为 ${args.model}${C.reset}\r\n\r\n`);
        this.pushApp({ modelId: args.model, model: modelLabel(args.model) });
        break;
      case 'effort.set':
        this.write(`${C.dim}>${C.reset} /effort ${args.level}\r\n  ${C.gray}⎿ 思考强度：${args.level}${C.reset}\r\n\r\n`);
        this.pushApp({ effort: args.level });
        break;
      case 'session.clear':
        this.write('\x1b[2J\x1b[H' + this.claudeBanner());
        this.pushApp({ contextUsedPct: 0 });
        break;
      case 'exit':
        this.write(`${C.dim}>${C.reset} /exit\r\n再见！\r\n`);
        this.pushApp({ app: '', running: false, stateful: false });
        this.mode = 'shell';
        this.prompt();
        break;
      default:
        if (def.kind === 'interactive') {
          this.openMenu(def.title, ['第一项（演示）', '第二项（演示）', '第三项（演示）']);
          return { passthrough: true, returnKeys: ['enter', 'esc'] };
        }
        this.write(
          def.kind === 'keys'
            ? `  ${C.gray}⎿ [按键] ${def.title}${C.reset}\r\n`
            : `${C.dim}>${C.reset} /${def.id} ${Object.values(args).join(' ')}\r\n  ${C.gray}⎿ 已执行${C.reset}\r\n\r\n`,
        );
    }
    return { passthrough: false, returnKeys: [] };
  }
}

function modelLabel(id: string): string {
  const m = demoCatalog().options.models.find((o) => o.value === id);
  return m ? m.label : id;
}

// ———————————————————— 假会话 ————————————————————

interface MockSessionData {
  id: SessionId;
  code: string;
  password: string;
  phase: 'connecting' | 'ready' | 'reconnecting' | 'closed';
  terms: Map<TermId, MockTerm>;
}

interface MockHost {
  emit(e: CoreEvent): void;
  simulateDrop(sessionId: SessionId): void;
  /** 模拟另一个设备占用了终端：向该终端发 TERM_BUSY 通知，之后别的设备的终端也显示为占用中 */
  simulateBusy(sessionId: SessionId, termId: TermId): void;
}

const HOST_INFO: HostInfo = {
  platform: 'windows',
  arch: 'x86_64',
  hostname: 'DEMO-PC',
  username: 'demo',
  homeDir: 'C:\\Users\\demo',
  shells: [
    { id: 'pwsh', name: 'PowerShell', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', isDefault: true },
    { id: 'cmd', name: '命令提示符', path: 'C:\\Windows\\System32\\cmd.exe', isDefault: false },
  ],
  claudeAvailable: true,
  claudeVersion: '2.1.322',
  maxFileSize: 200 * 1024 * 1024,
};

const LS_SETTINGS = 'rterm.mock.settings';
const LS_HOSTS = 'rterm.mock.knownHosts';

export function createMockBackend(): Backend {
  const listeners = new Set<(e: CoreEvent) => void>();
  const dragListeners = new Set<(e: import('./types').DragDropEvent) => void>();
  const sessions = new Map<SessionId, MockSessionData>();
  const uploads = new Map<FileId, ReturnType<typeof setInterval>>();
  /** 等待对方确认中的 connect：requestId → 取消函数 */
  const connectCancels = new Map<string, () => void>();
  const catalog: ActionCatalog = demoCatalog();
  let seq = 1;
  const nextId = (p: string) => `${p}${seq++}`;

  let settings: Settings = (() => {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      const d = defaultSettings();
      if (!raw) return d;
      const saved = JSON.parse(raw) as Partial<Settings>;
      // 按分组合并，旧版本存档里缺的新字段（如 isolateTerminals）取默认值
      return { host: { ...d.host, ...saved.host }, controller: { ...d.controller, ...saved.controller }, server: { ...d.server, ...saved.server }, app: { ...d.app, ...saved.app } };
    } catch {
      return defaultSettings();
    }
  })();
  let knownHosts: KnownHost[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_HOSTS) ?? '[]') as KnownHost[];
    } catch {
      return [];
    }
  })();
  const local: LocalInfo = {
    deviceCode: '482913675',
    tempPassword: randomTempPassword(),
    online: true,
    fixedPasswordSet: false,
    appVersion: '0.1.0-mock',
    platform: 'windows',
  };
  let incomingSeq = 1;
  const incoming = new Map<SessionId, { pending: boolean }>();

  const emit = (e: CoreEvent) => {
    // 异步派发，模拟 IPC 的时序
    setTimeout(() => listeners.forEach((l) => l(e)), 0);
  };

  const getSession = (id: SessionId): MockSessionData => {
    const s = sessions.get(id);
    if (!s || s.phase === 'closed') throw err('NOT_READY', '会话已关闭');
    return s;
  };
  const getReady = (id: SessionId): MockSessionData => {
    const s = getSession(id);
    if (s.phase !== 'ready') throw err('NOT_READY', '重连中，暂时无法发送');
    return s;
  };
  const getTerm = (sid: SessionId, tid: TermId): MockTerm => {
    const t = getSession(sid).terms.get(tid);
    if (!t) throw err('TERM_NOT_FOUND', '终端不存在');
    return t;
  };

  function simulateDrop(sessionId: SessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.phase !== 'ready') return;
    s.phase = 'reconnecting';
    const delays = [1000, 2000, 4000];
    // 依次上报 1、2、4 秒的重试，全部结束后恢复
    let t = 0;
    delays.forEach((d, i) => {
      setTimeout(() => {
        if (s.phase !== 'reconnecting') return;
        emit({ type: 'sessionState', sessionId, state: 'reconnecting', attempt: i + 1, retryInMs: d });
      }, t);
      t += d;
    });
    setTimeout(() => {
      if (s.phase !== 'reconnecting') return;
      s.phase = 'ready';
      emit({ type: 'sessionState', sessionId, state: 'ready' });
      s.terms.forEach((term) => {
        emit({ type: 'appState', sessionId, termId: term.termId, state: { ...term.app } });
        term.write(`\r\n${C.green}[已重新连接]${C.reset}\r\n`);
      });
    }, t + 300);
  }

  /** 演示：另一台设备开的终端（终端隔离关闭时才可见）；foreignBusy 时被占用 */
  const FOREIGN = 'tx-other';
  let foreignBusy = false;
  const host: MockHost = {
    emit,
    simulateDrop,
    simulateBusy(sessionId, termId) {
      foreignBusy = true;
      emit({
        type: 'appNotice', sessionId, termId,
        notice: { kind: 'error', title: 'TERM_BUSY', text: '', noticeId: '', toolName: '', toolSummary: '', resolved: false },
      });
    },
  };

  function startLatency(s: MockSessionData) {
    const iv = setInterval(() => {
      if (s.phase === 'closed') return clearInterval(iv);
      if (s.phase === 'ready') emit({ type: 'latency', sessionId: s.id, ms: 28 + Math.round(Math.random() * 30) });
    }, 3000);
  }

  function startUpload(sessionId: SessionId, name: string, size: number): UploadStarted {
    const s = getReady(sessionId);
    if (!settings.host.fileReceive) throw err('FILE_DISABLED', '对方已关闭文件接收');
    if (size > HOST_INFO.maxFileSize) throw err('FILE_TOO_LARGE', '文件超过对方限制');
    const fileId = nextId('f');
    let sent = 0;
    const total = Math.max(size, 1);
    const iv = setInterval(() => {
      sent = Math.min(total, sent + Math.ceil(total / 8));
      if (/fail/i.test(name) && sent > total / 2) {
        clearInterval(iv);
        uploads.delete(fileId);
        return emit({ type: 'uploadFailed', sessionId: s.id, fileId, reason: '网络中断' });
      }
      emit({ type: 'uploadProgress', sessionId: s.id, fileId, sent, total });
      if (sent >= total) {
        clearInterval(iv);
        uploads.delete(fileId);
        emit({ type: 'uploadDone', sessionId: s.id, fileId, remotePath: `C:\\Users\\demo\\.rterm\\uploads\\${name}` });
      }
    }, 180);
    uploads.set(fileId, iv);
    return { fileId, name, size };
  }

  // 浏览器下的拖放：用 DOM 事件模拟 Tauri 的 drag-drop 事件
  if (typeof window !== 'undefined') {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types.includes('Files')) dragListeners.forEach((l) => l({ type: 'enter' }));
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) dragListeners.forEach((l) => l({ type: 'leave' }));
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const items = [...(e.dataTransfer?.items ?? [])];
      const paths = items
        .filter((i) => i.kind === 'file')
        .map((i) => {
          const f = i.getAsFile();
          const isDir = i.webkitGetAsEntry?.()?.isDirectory;
          return `C:\\Users\\demo\\Downloads\\${f?.name ?? 'file'}${isDir ? '\\' : ''}`;
        });
      dragListeners.forEach((l) => l({ type: 'drop', paths }));
    });
  }

  // 演示：几秒后有人连入本机
  setTimeout(() => {
    if (!settings.host.enabled) return;
    const sessionId = `in${incomingSeq++}`;
    incoming.set(sessionId, { pending: settings.host.requireConfirm });
    emit({ type: 'incomingSession', sessionId, fromCode: '731204588', platform: 'macos', startedAt: Date.now(), pendingConfirm: settings.host.requireConfirm });
  }, 6000);

  const backend: Backend = {
    kind: 'mock',

    async localInfo() {
      return { ...local };
    },
    async refreshTempPassword() {
      local.tempPassword = randomTempPassword();
      return local.tempPassword;
    },
    async setFixedPassword(password) {
      local.fixedPasswordSet = password !== null;
    },
    async acceptIncoming(sessionId) {
      const i = incoming.get(sessionId);
      if (i) i.pending = false;
    },
    async rejectIncoming(sessionId) {
      incoming.delete(sessionId);
      emit({ type: 'incomingClosed', sessionId, reason: 'rejected' });
    },
    async disconnectIncoming(sessionId) {
      incoming.delete(sessionId);
      emit({ type: 'incomingClosed', sessionId, reason: 'closed' });
    },
    async disconnectAllIncoming() {
      for (const id of [...incoming.keys()]) {
        incoming.delete(id);
        emit({ type: 'incomingClosed', sessionId: id, reason: incoming.get(id)?.pending ? 'rejected' : 'closed' });
      }
    },
    async listKnownHosts() {
      return [...knownHosts];
    },
    async removeKnownHost(deviceCode) {
      knownHosts = knownHosts.filter((h) => h.deviceCode !== deviceCode);
      localStorage.setItem(LS_HOSTS, JSON.stringify(knownHosts));
    },

    async getSettings() {
      return structuredClone(settings);
    },
    async setSettings(s) {
      settings = structuredClone(s);
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
      return structuredClone(settings);
    },

    async connect(deviceCode, password, requestId) {
      await sleep(700);
      if (deviceCode === '000000000') throw err('UNAVAILABLE', '设备不在线或设备码有误');
      if (deviceCode === '111111111') throw err('REJECTED', '对方拒绝了连接');
      if (deviceCode === '222222222') throw err('LOCKED', '对方设备已临时锁定');
      if (password === 'wrong') throw err('PASSWORD_WRONG', '密码错误');
      if (deviceCode === '333333333') {
        // 对方设置了连接确认：20 秒后才同意，期间可取消；没有超时
        emit({ type: 'sessionState', sessionId: '', requestId, state: 'awaitingApproval' });
        const cancelled = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            connectCancels.delete(requestId);
            resolve(false);
          }, 20_000);
          connectCancels.set(requestId, () => {
            clearTimeout(t);
            connectCancels.delete(requestId);
            resolve(true);
          });
        });
        if (cancelled) throw err('CANCELLED', '已取消');
      }
      const id = nextId('s');
      const s: MockSessionData = { id, code: deviceCode, password, phase: 'ready', terms: new Map() };
      sessions.set(id, s);
      knownHosts = [{ deviceCode, lastConnected: new Date().toISOString() }, ...knownHosts.filter((h) => h.deviceCode !== deviceCode)].slice(0, 8);
      localStorage.setItem(LS_HOSTS, JSON.stringify(knownHosts));
      emit({ type: 'sessionState', sessionId: id, state: 'ready' });
      emit({
        type: 'hostInfo', sessionId: id, info: { ...HOST_INFO },
        features: ['file.upload', 'term.submit', 'app.actions', 'app.state', 'app.commands'],
      });
      emit({ type: 'actionCatalog', sessionId: id, catalog });
      startLatency(s);
      return id;
    },
    async cancelConnect(requestId) {
      connectCancels.get(requestId)?.();
    },
    async disconnect(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.phase = 'closed';
      s.terms.forEach((t) => t.dispose());
      emit({ type: 'sessionState', sessionId, state: 'closed', reason: '已断开连接' });
    },

    async openTerm(p: TermOpenParams, onOutput) {
      const s = getReady(p.sessionId);
      await sleep(120);
      const termId = nextId('t');
      const term = new MockTerm(s.id, termId, p.profile, onOutput, host, p.launch);
      s.terms.set(termId, term);
      if (p.profile === 'claude') {
        emit({ type: 'appState', sessionId: s.id, termId, state: { ...term.app } });
        emit({
          type: 'commandList', sessionId: s.id, termId,
          list: {
            commands: [
              { name: 'deploy', description: '部署到测试环境', argumentHint: '[环境]', source: 'project' },
              { name: 'review-pr', description: '审查指定 PR', argumentHint: '<编号>', source: 'user' },
            ],
          },
        });
      }
      const title = p.profile === 'claude' ? 'Claude Code' : 'PowerShell';
      return { termId, title, shell: p.shellId || 'pwsh' } satisfies TermOpened;
    },
    async listTerms(sessionId): Promise<TermInfo[]> {
      const s = getSession(sessionId);
      if (!settings.host.isolateTerminals && !s.terms.has(FOREIGN)) {
        s.terms.set(FOREIGN, new MockTerm(sessionId, FOREIGN, 'shell', () => {}, host));
      }
      return [...s.terms.values()]
        .filter((t) => t.termId !== FOREIGN || !settings.host.isolateTerminals)
        .map((t) => ({
          termId: t.termId,
          title: t.termId === FOREIGN ? '731 204 588 的终端' : t.modes.title,
          profile: t.profile,
          shell: 'pwsh',
          attachedByOther: t.termId === FOREIGN && foreignBusy,
        }));
    },
    async attachTerm(p: TermAttachParams, onOutput) {
      if (p.termId === FOREIGN) {
        if (settings.host.isolateTerminals) throw err('TERM_NOT_FOUND', '终端不存在');
        if (foreignBusy) throw err('TERM_BUSY', '该终端正被其他设备使用');
      }
      const t = getTerm(p.sessionId, p.termId);
      t.onOutput = onOutput;
      if (p.termId === FOREIGN) t.prompt();
    },
    async termInput(sessionId, termId, data) {
      getReady(sessionId);
      getTerm(sessionId, termId).input(dec.decode(data));
    },
    async termSubmit(sessionId, termId, text, attachments) {
      getReady(sessionId);
      getTerm(sessionId, termId).submit(text, attachments);
    },
    async termResize() {},
    async termAck() {},
    async closeTerm(sessionId, termId) {
      const s = sessions.get(sessionId);
      s?.terms.get(termId)?.dispose();
      s?.terms.delete(termId);
    },

    async uploadPath(sessionId, path) {
      if (/[\\/]$/.test(path)) throw err('IS_DIRECTORY', '不能上传文件夹，请先压缩');
      const name = path.split(/[\\/]/).pop() || path;
      return startUpload(sessionId, name, 3 * 1024 * 1024);
    },
    async uploadBytes(p: UploadBytesParams) {
      return startUpload(p.sessionId, p.name, p.data.length);
    },
    async cancelUpload(sessionId, fileId) {
      const iv = uploads.get(fileId);
      if (iv) clearInterval(iv);
      uploads.delete(fileId);
      emit({ type: 'uploadFailed', sessionId, fileId, reason: '已取消' });
    },
    async readClipboardFiles() {
      throw err('CLIPBOARD_UNAVAILABLE', '浏览器演示模式无法读取剪贴板里的文件');
    },
    async termAction(sessionId, termId, actionId, args) {
      getReady(sessionId);
      const t = getTerm(sessionId, termId);
      const def = catalog.actions.find((a) => a.id === actionId);
      if (!def) throw err('UNSUPPORTED', '被控端不支持这个操作');
      await sleep(150);
      return t.runAction(def, args);
    },
    async commandListReq() {},

    async onEvent(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    async onDragDrop(h) {
      dragListeners.add(h);
      return () => dragListeners.delete(h);
    },

    pickFiles() {
      return new Promise<string[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => resolve([...(input.files ?? [])].map((f) => `C:\\Users\\demo\\Downloads\\${f.name}`));
        input.oncancel = () => resolve([]);
        input.click();
      });
    },
    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        throw toCommandError(e);
      }
    },
    async openUrl(url) {
      window.open(url, '_blank', 'noopener');
    },
    async notify(title, body) {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body });
    },
    async isAutostartEnabled() {
      return settings.app.autostart;
    },
    async setAutostart() {},
    async checkUpdate() {
      await sleep(2500);
      return { version: '0.2.0', notes: '终端渲染优化，修复重连后的画面错位' };
    },
    async installUpdate(onProgress) {
      for (let i = 1; i <= 10; i++) {
        await sleep(200);
        onProgress(i / 10);
      }
    },
  };

  // 便于在浏览器控制台手动触发
  (window as unknown as { __mock?: unknown }).__mock = {
    drop: () => [...sessions.keys()].forEach(simulateDrop),
    /** 模拟主控方取消了最早一个待确认的来访请求 */
    cancelIncoming: () => {
      const id = [...incoming.entries()].find(([, v]) => v.pending)?.[0];
      if (!id) return;
      incoming.delete(id);
      emit({ type: 'incomingClosed', sessionId: id, reason: 'cancelled' });
    },
    incoming: () => {
      const sessionId = `in${incomingSeq++}`;
      incoming.set(sessionId, { pending: settings.host.requireConfirm });
      emit({ type: 'incomingSession', sessionId, fromCode: '731204588', platform: 'linux', startedAt: Date.now(), pendingConfirm: settings.host.requireConfirm });
    },
    setActivity: (a: Activity) => sessions.forEach((s) => s.terms.forEach((t) => t.pushApp({ activity: a }))),
  };

  return backend;
}
