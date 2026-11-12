/** 全局输入历史：每次提交的内容都记下来，跨标签共享，localStorage 持久化 */
const STORAGE_KEY = 'rterm.inputHistory';
export const INPUT_HISTORY_LIMIT = 200;

type Listener = () => void;

let items: string[] = load();
const listeners = new Set<Listener>();

function load(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string').slice(-INPUT_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // 存储不可用：只保留内存里的
  }
}

function emit(): void {
  listeners.forEach((l) => l());
}

/** 记一条；空白不记，同样内容移到最新 */
export function pushInputHistory(text: string): void {
  if (!text.trim()) return;
  items = [...items.filter((x) => x !== text), text].slice(-INPUT_HISTORY_LIMIT);
  save();
  emit();
}

export function removeInputHistory(text: string): void {
  items = items.filter((x) => x !== text);
  save();
  emit();
}

export function clearInputHistory(): void {
  items = [];
  save();
  emit();
}

/** useSyncExternalStore 用：内容不变时返回同一个数组引用 */
export function getInputHistory(): readonly string[] {
  return items;
}

export function subscribeInputHistory(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
