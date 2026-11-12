/**
 * 与真实 Rust 被控端（rterm-cli host）的联调测试。默认跳过，设置环境变量后运行：
 *   RTERM_WEB_LIVE_API=http://127.0.0.1:8080 RTERM_WEB_LIVE_CODE=<9位设备码> RTERM_WEB_LIVE_PW=<密码> npx vitest run live
 * 验证握手（SPAKE2/Argon2id/HKDF/Ed25519）、加密记录层、终端、上传与 Rust 端逐字节一致。
 */
import { describe, expect, it } from 'vitest';
import type { CoreEvent } from '../types';
import { derivePwKey, passwordKindOf } from './crypto';
import { APP_VERSION, fetchSignalUrl, loadOrCreateIdentity } from './identity';
import { ConnectError, Session, type ConnectSpec } from './session';
import { SignalClient } from './signal';
import { makeConnector } from './web';

declare const process: { env: Record<string, string | undefined>; platform: string };

const API = process.env.RTERM_WEB_LIVE_API;
const CODE = process.env.RTERM_WEB_LIVE_CODE ?? '';
const PW = process.env.RTERM_WEB_LIVE_PW ?? '';
const dec = new TextDecoder();
const enc = new TextEncoder();

async function until(f: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!API)('Web 控制端 ⇄ Rust 被控端（真实联调）', () => {
  it('握手、终端、上传、断开；密码错误被识别', async () => {
    const identity = await loadOrCreateIdentity(API!);
    const signal = new SignalClient(identity, () => fetchSignalUrl(API!), { onState: () => {}, onNotice: () => {}, onUnknownDevice: async () => null, onUpgradeRequired: () => {} });
    signal.start();
    expect(await signal.waitOnline(8000)).toBe(true);

    const events: CoreEvent[] = [];
    const out: Record<string, string> = {};
    const hooks = {
      emit: (e: CoreEvent) => void events.push(e),
      onOutput: (_s: string, term: string, _seq: number, data: Uint8Array) => {
        out[term] = (out[term] ?? '') + dec.decode(data);
      },
    };
    const mk = async (pw: string): Promise<ConnectSpec> => ({ hostCode: CODE, pwKey: await derivePwKey(pw, CODE), pwKind: passwordKindOf(pw), knownHostKey: null, acceptKeyChange: false });

    // 密码错误
    const bad = await Session.connect('bad', makeConnector(signal), await mk('wrongpw1'), hooks, APP_VERSION).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ConnectError);
    expect((bad as ConnectError).isBadPassword).toBe(true);

    // 正确密码
    const s = await Session.connect('s1', makeConnector(signal), await mk(PW), hooks, APP_VERSION);
    expect(s.state).toBe('ready');
    expect(s.host?.features.has('file.upload')).toBe(true);
    expect(events.some((e) => e.type === 'hostInfo')).toBe(true);

    const term = await s.openTerm({ profile: 0, shellId: '', cwd: '', cols: 100, rows: 30, command: '' });
    const echo = process.platform === 'win32' ? 'echo web-live-ok\r' : 'echo web-live-ok\n';
    await s.termInput(term, enc.encode(echo));
    await until(() => (out[term] ?? '').includes('web-live-ok'), 20_000, '终端回显');
    expect((await s.listTerms()).some((t) => t.termId === term)).toBe(true);
    await s.termResize(term, { cols: 120, rows: 40 });
    s.termAck(term, 1);

    // 断线重连：把链路弄断，应当自动重连、重新附着终端并按偏移续传（不丢、不重）
    const link = (s as unknown as { conn: { link: { abort(r: string): void } } }).conn.link;
    link.abort('测试：模拟断线');
    await until(() => s.state === 'reconnecting', 5000, '进入重连');
    await until(() => s.state === 'ready', 30_000, '重连成功');
    out[term] = '';
    await s.termInput(term, enc.encode(process.platform === 'win32' ? 'echo after-reconnect\r' : 'echo after-reconnect\n'));
    await until(() => (out[term] ?? '').includes('after-reconnect'), 20_000, '重连后终端仍可用');

    // 上传
    const data = new Uint8Array(200_000).map((_, i) => i % 251);
    const up = await s.upload({ name: 'live.bin', mime: 'application/octet-stream', data });
    await until(() => events.some((e) => e.type === 'uploadDone' && e.fileId === String(up.fileId)), 30_000, '上传完成');
    expect(events.some((e) => e.type === 'uploadFailed')).toBe(false);

    await s.disconnect();
    expect(s.state).toBe('closed');

    // 终端在被控端保活：新会话重新附着旧终端，应当从偏移 0 回放历史输出
    const s2 = await Session.connect('s2', makeConnector(signal), await mk(PW), hooks, APP_VERSION);
    expect((await s2.listTerms()).some((t) => t.termId === term)).toBe(true);
    out[term] = '';
    await s2.attachTerm(term, { cols: 100, rows: 30 }, 0);
    await until(() => (out[term] ?? '').includes('web-live-ok'), 15_000, '回放历史输出');
    await s2.disconnect();
    expect(events.some((e) => e.type === 'sessionState' && e.state === 'closed' && e.reasonCode === 'USER')).toBe(true);
    signal.stop();
  }, 90_000);
});
