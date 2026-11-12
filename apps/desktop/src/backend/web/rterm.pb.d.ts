/** rterm.pb.js（protobufjs 静态代码生成，不使用 eval）的最小类型声明。重新生成：npm run proto:web */
interface ProtoMessageType {
  fromObject(o: object): unknown;
  encode(m: unknown): { finish(): Uint8Array };
  decode(b: Uint8Array): unknown;
  toObject(m: unknown, o?: object): Record<string, unknown>;
}

export const rterm: { v1: { Frame: ProtoMessageType; Handshake: ProtoMessageType } };
