import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Controller } from './controller';
import type { AppModel } from '../state/store';
import { currentConfirm, subscribeConfirm } from './ui';

export const ControllerContext = createContext<Controller | null>(null);

export function useController(): Controller {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('ControllerContext 缺失');
  return c;
}

export function useModel(): AppModel {
  const c = useController();
  return useSyncExternalStore(c.store.subscribe, c.store.getState);
}

export function useConfirmRequest() {
  return useSyncExternalStore(subscribeConfirm, currentConfirm);
}

/** 每秒刷新一次的当前时间（重连倒计时、来访时长） */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/** 手机 / 窄窗口：侧栏变抽屉、出现虚拟按键条等（与 styles.css 里的 @media 阈值保持一致） */
export const COMPACT_QUERY = '(max-width: 760px)';

export function useCompact(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(COMPACT_QUERY);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}

/**
 * 手机软键盘弹出时，布局视口不一定缩小（iOS Safari）：把 visualViewport 的高度和偏移写进 CSS 变量，
 * 紧凑布局下 .app 用它们定位，这样输入框始终在键盘上方。
 */
export function useVisualViewport(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    const sync = (): void => {
      root.style.setProperty('--app-h', `${vv.height}px`);
      root.style.setProperty('--app-top', `${vv.offsetTop}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      root.style.removeProperty('--app-h');
      root.style.removeProperty('--app-top');
    };
  }, [enabled]);
}
