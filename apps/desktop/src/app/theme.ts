/** 深浅色主题：CSS 变量由 styles.css 提供，这里只负责决定当前是深色还是浅色，以及 xterm 的配色 */
import type { ITheme } from '@xterm/xterm';
import type { ThemeChoice } from '../backend/types';

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveDark(choice: ThemeChoice): boolean {
  return choice === 'auto' ? systemPrefersDark() : choice === 'dark';
}

/** 在根节点设置 data-theme，CSS 里用它覆盖 prefers-color-scheme */
export function applyThemeAttr(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

const DARK: ITheme = {
  background: '#15171b',
  foreground: '#d7dbe0',
  cursor: '#d7dbe0',
  cursorAccent: '#15171b',
  selectionBackground: '#3b4a63',
  black: '#2b2f36',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dbe0',
  brightBlack: '#6b7280',
  brightRed: '#ef8891',
  brightGreen: '#aedb92',
  brightYellow: '#f0d08f',
  brightBlue: '#7cc0ff',
  brightMagenta: '#d98ff0',
  brightCyan: '#73cdd8',
  brightWhite: '#ffffff',
};

const LIGHT: ITheme = {
  background: '#fbfbfc',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#fbfbfc',
  selectionBackground: '#bcd4f5',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export function xtermTheme(dark: boolean): ITheme {
  return dark ? DARK : LIGHT;
}
