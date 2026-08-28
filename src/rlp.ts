function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}

export function rlpInt(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative rlp int");
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function rlpBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  if (bytes.length <= 55) return concat([u8(0x80 + bytes.length), bytes]);
  const len = rlpInt(BigInt(bytes.length));
  return concat([u8(0xb7 + len.length), len, bytes]);
}

export function rlpList(items: Uint8Array[]): Uint8Array {
  const body = concat(items);
  if (body.length <= 55) return concat([u8(0xc0 + body.length), body]);
  const len = rlpInt(BigInt(body.length));
  return concat([u8(0xf7 + len.length), len, body]);
}

export function rlpHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!h) return new Uint8Array(0);
  const padded = h.length % 2 ? "0" + h : h;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return rlpBytes(out);
}
