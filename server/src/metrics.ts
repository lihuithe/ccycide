import { monitorEventLoopDelay } from 'node:perf_hooks';

type Labels = Record<string, string | number>;

function labelStr(l?: Labels): string {
  if (!l) return '';
  const parts = Object.entries(l).map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** 单个计数器的序列数上限：标签值来自外部输入时的最后一道保险，超出的合并到 overflow 序列（安全审查 M2） */
export const MAX_SERIES = 500;

export class Counter {
  private vals = new Map<string, { labels?: Labels; v: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels?: Labels, n = 1): void {
    let k = labelStr(labels);
    let e = this.vals.get(k);
    if (!e && this.vals.size >= MAX_SERIES) {
      labels = { overflow: 'true' };
      k = labelStr(labels);
      e = this.vals.get(k);
    }
    if (e) e.v += n;
    else this.vals.set(k, { labels, v: n });
  }


  get(labels?: Labels): number {
    return this.vals.get(labelStr(labels))?.v ?? 0;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.vals.size === 0) out.push(`${this.name} 0`);
    for (const [k, e] of this.vals) out.push(`${this.name}${k} ${e.v}`);
    return out;
  }
}

type GaugeValue = number | Array<{ labels?: Labels; value: number }>;

export class Gauge {
  private v = 0;
  constructor(
    readonly name: string,
    readonly help: string,
    private collect?: () => GaugeValue,
  ) {}

  set(n: number): void {
    this.v = n;
  }
  inc(n = 1): void {
    this.v += n;
  }
  dec(n = 1): void {
    this.v -= n;
  }
  get(): number {
    return this.v;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    const val = this.collect ? this.collect() : this.v;
    if (typeof val === 'number') out.push(`${this.name} ${val}`);
    else for (const e of val) out.push(`${this.name}${labelStr(e.labels)} ${e.value}`);
    return out;
  }
}

/** 只记录总和与次数的简化直方图（够算平均延迟） */
export class Summary {
  private vals = new Map<string, { labels?: Labels; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(labels: Labels | undefined, v: number): void {
    const k = labelStr(labels);
    const e = this.vals.get(k) ?? { labels, sum: 0, count: 0 };
    e.sum += v;
    e.count++;
    this.vals.set(k, e);
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    for (const [k, e] of this.vals) {
      out.push(`${this.name}_sum${k} ${e.sum}`);
      out.push(`${this.name}_count${k} ${e.count}`);
    }
    return out;
  }
}

/** 简单的 Prometheus 文本格式输出。不依赖第三方库。 */
export class Metrics {
  private items: Array<Counter | Gauge | Summary> = [];
  private loop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loop.enable();
    this.gauge('process_resident_memory_bytes', '常驻内存', () => process.memoryUsage().rss);
    this.gauge('nodejs_heap_used_bytes', '堆内存使用量', () => process.memoryUsage().heapUsed);
    this.gauge('nodejs_external_memory_bytes', '外部内存（Buffer 等）', () => process.memoryUsage().external);
    this.gauge('nodejs_eventloop_lag_p99_seconds', '事件循环延迟 p99', () => {
      const v = this.loop.percentile(99) / 1e9;
      this.loop.reset();
      return Number.isFinite(v) ? v : 0;
    });
    this.gauge('process_uptime_seconds', '进程运行时间', () => process.uptime());
  }

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.items.push(c);
    return c;
  }

  gauge(name: string, help: string, collect?: () => GaugeValue): Gauge {
    const g = new Gauge(name, help, collect);
    this.items.push(g);
    return g;
  }

  summary(name: string, help: string): Summary {
    const s = new Summary(name, help);
    this.items.push(s);
    return s;
  }

  render(): string {
    return this.items.flatMap((i) => i.render()).join('\n') + '\n';
  }

  stop(): void {
    this.loop.disable();
  }
}
