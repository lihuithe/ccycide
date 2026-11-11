export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** 返回 UTC 日期字符串 YYYY-MM-DD */
export function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 带 unref 的 setInterval，不阻止进程退出 */
export function every(ms: number, fn: () => void): NodeJS.Timeout {
  const t = setInterval(fn, ms);
  t.unref();
  return t;
}

/**
 * 给 Promise 加超时：数据库/网络对端“卡住”（连接还在但不回包）时，调用方不能无限等。
 * 超时只是不再等待，底层操作可能仍在进行，所以只用于读操作或幂等写操作。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超过 ${ms}ms 没有响应`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
