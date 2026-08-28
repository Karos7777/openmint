import { keccak_256 } from "@noble/hashes/sha3";

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

export function keccak256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(keccak256(bytes));
}

export function selector(sig: string): string {
  return keccak256Hex(sig).slice(0, 10);
}

export function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function padUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export function encodeMintPublic(
  nft: string,
  feeRecipient: string,
  minter: string,
  quantity: bigint,
): string {
  return (
    selector("mintPublic(address,address,address,uint256)") +
    padAddress(nft) +
    padAddress(feeRecipient) +
    padAddress(minter) +
    padUint(quantity)
  );
}

export function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function toQuantity(value: bigint): string {
  if (value === 0n) return "0x0";
  return "0x" + value.toString(16);
}

export function fromQuantity(hex: string | null | undefined): bigint {
  if (!hex) return 0n;
  return BigInt(hex);
}

export function checksumAddress(addr: string): string {
  const lower = addr.toLowerCase().replace(/^0x/, "");
  const hash = strip0x(keccak256Hex(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}
