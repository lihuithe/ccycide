/** 确认框：命令式调用，由 ConfirmHost 渲染 */

export interface ConfirmRequest {
  title: string;
  message?: string;
  okText?: string;
}

interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();

export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  // 已有未处理的确认框时，先把它按取消处理
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { ...req, resolve };
    listeners.forEach((l) => l());
  });
}

export function currentConfirm(): Pending | null {
  return pending;
}

export function resolveConfirm(ok: boolean): void {
  const p = pending;
  pending = null;
  listeners.forEach((l) => l());
  p?.resolve(ok);
}

export function subscribeConfirm(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
