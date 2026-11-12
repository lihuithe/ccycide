/**
 * 协议编解码：用 protobufjs 从 proto/rterm.proto 静态生成的代码（rterm.pb.js，不使用 eval，页面可以用严格 CSP），
 * 协议文件本身不改。重新生成：`npm run proto:web`。
 */
import { rterm } from './rterm.pb.js';

const FrameType = rterm.v1.Frame;
const HandshakeType = rterm.v1.Handshake;

/** 解码选项：uint64 转 number（偏移、文件大小都小于 2^53），oneof 名放在 `body` 上 */
const OPTS = { longs: Number, defaults: true, oneofs: true, arrays: true, objects: true } as const;

/** 一条 Frame：channel 与 body 分支名 + 该分支的内容（字段为 camelCase） */
export interface Frame {
  channel: number;
  /** 分支名，如 'termOutput'；不认识的分支为 undefined（按协议约定忽略） */
  body?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [branch: string]: any;
}

/** 编码：branch 是分支名（camelCase），value 是该分支的消息内容 */
export function encodeFrame(channel: number, branch: string, value: object): Uint8Array {
  const msg = FrameType.fromObject({ channel, [branch]: value });
  return FrameType.encode(msg).finish();
}

export function decodeFrame(bytes: Uint8Array): Frame {
  const msg = FrameType.decode(bytes);
  return FrameType.toObject(msg, OPTS) as Frame;
}

export type HandshakeBody = { init: object } | { resp: object } | { confirm: object };

export function encodeHandshake(body: HandshakeBody): Uint8Array {
  return HandshakeType.encode(HandshakeType.fromObject(body)).finish();
}

export interface PakeInit {
  protoVer: number;
  spakeMsg: Uint8Array;
  publicKey: Uint8Array;
  nonce: Uint8Array;
  passwordKind: number;
}
export interface PakeResp {
  spakeMsg: Uint8Array;
  publicKey: Uint8Array;
  nonce: Uint8Array;
}
export interface PakeConfirm {
  mac: Uint8Array;
  signature: Uint8Array;
}

export function decodeHandshake(bytes: Uint8Array): { body?: 'init' | 'resp' | 'confirm'; resp?: PakeResp; confirm?: PakeConfirm; init?: PakeInit } {
  const msg = HandshakeType.decode(bytes);
  return HandshakeType.toObject(msg, OPTS) as never;
}

/** Profile 枚举值 */
export const Profile = { shell: 0, claude: 1, custom: 2 } as const;
