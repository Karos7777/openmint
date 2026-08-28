import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { etc, getPublicKey, sign } from "@noble/secp256k1";
import {
  bytesToHex,
  checksumAddress,
  hexToBytes,
  keccak256,
  strip0x,
  toQuantity,
} from "./keccak";
import { rlpHex, rlpInt, rlpList } from "./rlp";

etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, etc.concatBytes(...msgs));

export function addressFromPrivateKey(pk: string): string {
  const key = hexToBytes(pk);
  const pub = getPublicKey(key, false);
  const hash = keccak256(pub.slice(1));
  return checksumAddress(bytesToHex(hash.slice(-20)));
}

export function normalizePrivateKey(raw: string): string {
  const h = strip0x(raw.trim());
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("WALLET_PRIVATE_KEY must be 32-byte hex");
  return "0x" + h.toLowerCase();
}

function sigToRSV(hash: Uint8Array, pk: Uint8Array): { r: bigint; s: bigint; yParity: number } {
  const sig = sign(hash, pk);
  const compact = sig.toCompactRawBytes();
  const r = BigInt(bytesToHex(compact.slice(0, 32)));
  const s = BigInt(bytesToHex(compact.slice(32, 64)));
  const yParity = sig.recovery ?? 0;
  return { r, s, yParity };
}

export function signLegacyTx(params: {
  privateKey: string;
  chainId: bigint;
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
}): string {
  const pk = hexToBytes(params.privateKey);
  const unsigned = rlpList([
    rlpInt(params.nonce),
    rlpInt(params.gasPrice),
    rlpInt(params.gasLimit),
    rlpHex(params.to),
    rlpInt(params.value),
    rlpHex(params.data),
    rlpInt(params.chainId),
    rlpInt(0n),
    rlpInt(0n),
  ]);
  const hash = keccak256(unsigned);
  const { r, s, yParity } = sigToRSV(hash, pk);
  const v = BigInt(yParity) + 35n + 2n * params.chainId;
  const signed = rlpList([
    rlpInt(params.nonce),
    rlpInt(params.gasPrice),
    rlpInt(params.gasLimit),
    rlpHex(params.to),
    rlpInt(params.value),
    rlpHex(params.data),
    rlpInt(v),
    rlpInt(r),
    rlpInt(s),
  ]);
  return bytesToHex(signed);
}

export function signEip1559Tx(params: {
  privateKey: string;
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: string;
}): string {
  const pk = hexToBytes(params.privateKey);
  const access = rlpList([]);
  const fields = [
    rlpInt(params.chainId),
    rlpInt(params.nonce),
    rlpInt(params.maxPriorityFeePerGas),
    rlpInt(params.maxFeePerGas),
    rlpInt(params.gasLimit),
    rlpHex(params.to),
    rlpInt(params.value),
    rlpHex(params.data),
    access,
  ];
  const unsigned = new Uint8Array([0x02, ...rlpList(fields)]);
  const hash = keccak256(unsigned);
  const { r, s, yParity } = sigToRSV(hash, pk);
  const signed = new Uint8Array([
    0x02,
    ...rlpList([...fields, rlpInt(BigInt(yParity)), rlpInt(r), rlpInt(s)]),
  ]);
  return bytesToHex(signed);
}

export function encodeRawForBroadcast(raw: string): string {
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

export { toQuantity };
