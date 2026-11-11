import { createConnection, createServer, type Server, type Socket } from 'node:net';

/**
 * 可控的 TCP 代理，用来在测试里模拟 Redis/MySQL 的网络故障：
 *  - cut()：关闭监听并断开所有连接（对端表现为连接被拒绝/被重置，等同服务停止）
 *  - freeze()：连接保持但不再转发任何数据（对端表现为“卡死”，等同网络黑洞或进程被挂起）
 *  - restore()：恢复正常
 */
export class TcpProxy {
  private server: Server | null = null;
  private socks = new Set<Socket>();
  private frozen = false;
  port = 0;

  constructor(
    private targetHost: string,
    private targetPort: number,
  ) {}

  async start(): Promise<void> {
    await this.listen(this.port);
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((client) => {
        const up = createConnection({ host: this.targetHost, port: this.targetPort });
        for (const s of [client, up]) {
          this.socks.add(s);
          s.on('error', () => s.destroy());
          s.on('close', () => {
            this.socks.delete(s);
            (s === client ? up : client).destroy();
          });
        }
        client.on('data', (d) => {
          if (!this.frozen && up.writable) up.write(d);
        });
        up.on('data', (d) => {
          if (!this.frozen && client.writable) client.write(d);
        });
      });
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        this.port = (srv.address() as { port: number }).port;
        this.server = srv;
        resolve();
      });
    });
  }

  get url(): string {
    return `127.0.0.1:${this.port}`;
  }

  async cut(): Promise<void> {
    this.frozen = false;
    const srv = this.server;
    this.server = null;
    for (const s of this.socks) s.destroy();
    this.socks.clear();
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }

  freeze(): void {
    this.frozen = true;
  }

  async restore(): Promise<void> {
    if (this.frozen) {
      // 冻结期间丢掉的数据补不回来，旧连接已经不可用，直接断开让客户端重连
      for (const s of this.socks) s.destroy();
      this.socks.clear();
    }
    this.frozen = false;
    if (!this.server) await this.listen(this.port);
  }

  async stop(): Promise<void> {
    await this.cut();
  }
}
