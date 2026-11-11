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
