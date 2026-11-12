import { describe, expect, it } from 'vitest';
import { Sealer, Spake2A, concat, confirmMac, deriveKeys, equalBytes, passwordKindOf, publicKeyOf, randomBytes, signMessage, transcript, verifyMac, verifySignature } from './crypto';

const enc = new TextEncoder();

describe('加密原语（与 Rust 的字节一致性由联调证明，这里覆盖边界）', () => {
  it('密码类别：恰好 8 位且全在临时字符集内为 0，否则为 1', () => {
    expect(passwordKindOf('abc23456')).toBe(0);
    expect(passwordKindOf('abcdefgi')).toBe(1); // 含被排除的易混淆字符
    expect(passwordKindOf('abc2345')).toBe(1);
    expect(passwordKindOf('ABC23456')).toBe(1);
  });

  it('记录层：1000 条按序往返；任意一个字节被改都解不开；类型字节必须是数据', () => {
    const key = new Uint8Array(32).fill(7);
    const tx = new Sealer(key);
    const rx = new Sealer(key);
    for (let i = 0; i < 1000; i++) {
      const plain = enc.encode(`消息 ${i}`.repeat((i % 7) + 1));
      const rec = tx.seal(plain);
      expect(rec[0]).toBe(0x02);
      expect(equalBytes(rx.open(rec), plain)).toBe(true);
    }
    const rec = new Sealer(key).seal(enc.encode('secret terminal output'));
    for (let i = 1; i < rec.length; i++) {
      const bad = rec.slice();
      bad[i] ^= 1;
      expect(() => new Sealer(key).open(bad)).toThrow();
    }
    const wrong = rec.slice();
    wrong[0] = 0x01;
    expect(() => new Sealer(key).open(wrong)).toThrow();
  });

  it('transcript 绑定每个字段；密钥互不相同；确认 MAC 区分角色', () => {
    const base = {
      protoVer: 1,
      sessionId: 'S1',
      controllerCode: '111111111',
      hostCode: '222222222',
      spakeMsgA: new Uint8Array(33).fill(1),
      spakeMsgB: new Uint8Array(33).fill(2),
      controllerPubkey: new Uint8Array(32).fill(3),
      hostPubkey: new Uint8Array(32).fill(4),
      nonceC: new Uint8Array(16).fill(5),
      nonceH: new Uint8Array(16).fill(6),
    };
    const a = transcript(base);
    expect(equalBytes(a, transcript(base))).toBe(true);
    expect(equalBytes(a, transcript({ ...base, sessionId: 'S2' }))).toBe(false);
    expect(equalBytes(a, transcript({ ...base, nonceH: new Uint8Array(16).fill(7) }))).toBe(false);
    const k = deriveKeys(enc.encode('shared secret'), a);
    expect(equalBytes(k.c2h, k.h2c)).toBe(false);
    expect(equalBytes(k.c2h, k.confirm)).toBe(false);
    const m = confirmMac(k.confirm, 'c', a);
    expect(verifyMac(k.confirm, 'c', a, m)).toBe(true);
    expect(verifyMac(k.confirm, 'h', a, m)).toBe(false); // 防反射
    expect(verifyMac(k.confirm, 'c', a, m.slice(0, 31))).toBe(false);
  });

  it('Ed25519：正常签名通过；小阶公钥（单位元）即使“签名”匹配也被拒绝', () => {
    const seed = randomBytes(32);
    const sig = signMessage(seed, enc.encode('hello'));
    expect(verifySignature(publicKeyOf(seed), enc.encode('hello'), sig)).toBe(true);
    expect(verifySignature(publicKeyOf(seed), enc.encode('hellO'), sig)).toBe(false);
    const pk = new Uint8Array(32);
    pk[0] = 1;
    const weak = new Uint8Array(64);
    weak[0] = 1;
    expect(verifySignature(pk, enc.encode('anything'), weak)).toBe(false);
  });

  it('SPAKE2（A 侧）：固定 x 时消息确定；口令不同消息不同；方向标记错误被拒绝', () => {
    const pw = randomBytes(32);
    const ids = [enc.encode('111111111'), enc.encode('222222222')] as const;
    const a1 = Spake2A.start(pw, ids[0], ids[1], 5n);
    const a2 = Spake2A.start(pw, ids[0], ids[1], 5n);
    expect(equalBytes(a1.message, a2.message)).toBe(true);
    expect(a1.message.length).toBe(33);
    expect(a1.message[0]).toBe(0x41);
    const a3 = Spake2A.start(randomBytes(32), ids[0], ids[1], 5n);
    expect(equalBytes(a1.message, a3.message)).toBe(false);
    expect(() => a1.state.finish(concat(Uint8Array.of(0x41), new Uint8Array(32)))).toThrow();
  });
});
