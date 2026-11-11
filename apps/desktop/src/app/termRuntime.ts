/**
 * 一个终端标签对应的 xterm.js 运行时：创建、插件、流控 ack、尺寸同步、直通输入。
 * 不进 React 状态；切换标签时只隐藏，不销毁（保留画面和回滚）。
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { Backend, TermOutputFrame } from '../backend';
import type { Settings } from '../backend/types';
import type { TermTab } from '../state/store';
import { AckBatcher, ACK_INTERVAL_MS } from '../lib/flow';
import { dataHitsReturnKey, isTogglePassthrough } from '../lib/keys';
import { xtermTheme } from './theme';

export interface RuntimeDeps {
  backend: Backend;
  getTab(): TermTab | undefined;
  getSettings(): Settings | null;
  isDark(): boolean;
  /** Ctrl+Shift+P */
  onTogglePassthrough(): void;
  /** 临时直通中按下了 returnKeys：该键已发给远端，现在退出临时直通 */
  onReturnKey(): void;
  /** 非直通模式下在终端区域按下可打印字符：焦点回输入框并带入这个字符 */
  onPrintable(ch: string): void;
  onError(msg: string): void;
}

const FONT_FAMILY =
  '"Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei", "PingFang SC", monospace';

const isLinux = () => /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

const encoder = new TextEncoder();

export class TermRuntime {
  term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private search: SearchAddon | null = null;
  private el: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private ackTimer: ReturnType<typeof setInterval> | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeRaf = 0;
  private lastCols = 0;
  private lastRows = 0;
  private lastErrAt = 0;
  private batcher: AckBatcher;
  /** 当前渲染器 */
  renderer: 'webgl' | 'dom' = 'dom';

  constructor(private readonly deps: RuntimeDeps) {
    this.batcher = new AckBatcher((consumed) => {
      const t = deps.getTab();
      if (t?.remoteId) void deps.backend.termAck(t.sessionId, t.remoteId, consumed).catch(() => {});
    });
  }

  get mounted(): boolean {
    return this.term !== null;
  }

  /** 已渲染到的流偏移（重连续传用） */
  get renderedOffset(): number {
    return this.batcher.renderedOffset;
  }

  mount(el: HTMLElement): void {
    if (this.term) return; // 幂等
    this.el = el;
    const settings = this.deps.getSettings();
    const term = new Terminal({
      allowProposedApi: true, // Unicode11 插件需要
      scrollback: 10000,
      fontFamily: FONT_FAMILY,
      fontSize: settings?.controller.fontSize ?? 14,
      cursorBlink: false, // 光标由远端程序控制
      theme: xtermTheme(this.deps.isDark()),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => void this.deps.backend.openUrl(uri).catch(() => {})));
    term.open(el);

    // WebGL 优先；创建失败或上下文丢失时退回 DOM 渲染器。Linux 的 WebKitGTK 直接用 DOM
    if (!isLinux()) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.renderer = 'dom';
        });
        term.loadAddon(webgl);
        this.renderer = 'webgl';
      } catch {
        this.renderer = 'dom';
      }
    }

    this.term = term;
    this.fit = fit;
    this.search = search;

    term.attachCustomKeyEventHandler((ev) => this.onKey(ev));
    term.onData((s) => this.onData(s));
    // 选中文本后复制到本机剪贴板
    term.onSelectionChange(() => {
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        const sel = term.getSelection();
        if (sel) void this.deps.backend.copyText(sel).catch(() => {});
      }, 150);
    });

    this.ro = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => this.syncSize());
    });
    this.ro.observe(el);
    this.ackTimer = setInterval(() => this.batcher.tick(Date.now()), ACK_INTERVAL_MS);
    this.syncSize(false);
  }

  /** 当前尺寸；未挂载或隐藏时给默认值 */
  size(): { cols: number; rows: number } {
    this.fitIfVisible();
    return { cols: this.term?.cols ?? 120, rows: this.term?.rows ?? 30 };
  }

  private visible(): boolean {
    return !!this.el && this.el.clientWidth > 0 && this.el.clientHeight > 0;
  }

  private fitIfVisible(): void {
    if (this.fit && this.visible()) {
      try {
        this.fit.fit();
      } catch {
        /* 尺寸暂不可用 */
      }
    }
  }

  /** 适配容器并把变化的尺寸通知远端 */
  syncSize(notify = true): void {
    if (!this.term || !this.visible()) return;
    this.fitIfVisible();
    const { cols, rows } = this.term;
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    const t = this.deps.getTab();
    if (notify && t?.remoteId) void this.deps.backend.termResize(t.sessionId, t.remoteId, cols, rows).catch(() => {});
  }

  /** 强制重发一次尺寸（附着完成后触发远端重绘） */
  forceResize(): void {
    this.lastCols = 0;
    this.syncSize();
  }

  /** 后端输出帧 */
  readonly onOutput = (frame: TermOutputFrame): void => {
    const term = this.term;
    if (!term) return;
    const end = frame.seq + frame.data.length;
    term.write(frame.data, () => this.batcher.onRendered(end, Date.now()));
  };

  /** 写入本地提示（不经过远端），如“进程已退出” */
  writeLocal(text: string): void {
    this.term?.write(text);
  }

  focus(): void {
    this.term?.focus();
  }

  hasSelection(): boolean {
    return !!this.term?.hasSelection();
  }

  setTheme(dark: boolean): void {
    if (this.term) this.term.options.theme = xtermTheme(dark);
  }

  setFontSize(px: number): void {
    if (this.term && this.term.options.fontSize !== px) {
      this.term.options.fontSize = px;
      this.syncSize();
    }
  }

  findNext(q: string): boolean {
    return this.search?.findNext(q, { incremental: true }) ?? false;
  }

  findPrev(q: string): boolean {
    return this.search?.findPrevious(q) ?? false;
  }

  clearSearch(): void {
    this.search?.clearDecorations();
  }

  dispose(): void {
    if (this.ackTimer) clearInterval(this.ackTimer);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    cancelAnimationFrame(this.resizeRaf);
    this.ro?.disconnect();
    this.term?.dispose();
    this.term = null;
  }

  // —— 键盘 ——

  private onKey(ev: KeyboardEvent): boolean {
    if (ev.type !== 'keydown') return true;
    if (isTogglePassthrough(ev)) {
      ev.preventDefault();
      this.deps.onTogglePassthrough();
      return false;
    }
    const tab = this.deps.getTab();
    if (!tab || tab.passthrough === 'off') {
      // 非直通：可打印字符把焦点交回输入框并带入该字符；其它键不处理
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        this.deps.onPrintable(ev.key);
      }
      return false;
    }
    return true;
  }

  /** xterm 编码好的按键（直通模式）发给远端 */
  private onData(s: string): void {
    const tab = this.deps.getTab();
    if (!tab || tab.passthrough === 'off' || !tab.remoteId) return;
    void this.deps.backend
      .termInput(tab.sessionId, tab.remoteId, encoder.encode(s))
      .catch((e: { message?: string }) => this.reportError(e.message || '尚未连接，输入未发送'));
    // 先把这个键照常发给远端，再退出临时直通
    if (tab.passthrough === 'temp' && dataHitsReturnKey(s, tab.returnKeys)) this.deps.onReturnKey();
  }

  private reportError(msg: string): void {
    const now = Date.now();
    if (now - this.lastErrAt < 2000) return;
    this.lastErrAt = now;
    this.deps.onError(msg);
  }
}
