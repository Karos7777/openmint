import {
  encodeMintPublic,
  fromQuantity,
  hexToBytes,
  keccak256Hex,
  padAddress,
  selector,
  toQuantity,
} from "./keccak";
import { addressFromPrivateKey, encodeRawForBroadcast, normalizePrivateKey, signEip1559Tx, signLegacyTx } from "./tx";

export const COLLECTION = "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929";
export const OPENSEA_URL =
  "https://opensea.io/collection/0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929/overview";
export const SEADROP = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
export const FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
export const QUANTITY = 1n;
export const NAME_SELECTOR = "0x06fdde03";

const RPC_CANDIDATES = [
  "https://4663.rpc.thirdweb.com",
  "https://rpc.ankr.com/robinhood",
  "https://rpc.robinhood.com",
  "https://rpc.mainnet.robinhood.com",
  "https://rpc.robinhood.xyz",
  "https://rpc-mainnet.robinhood.xyz",
  "https://mainnet.robinhood.xyz",
  "https://robinhood-mainnet.rpc.thirdweb.com",
  "https://rpc.robinhoodchain.com",
  "https://1rpc.io/robinhood",
  "https://robinhood.gateway.tenderly.co",
  "https://endpoints.omniatech.io/v1/robinhood/mainnet/public",
  "https://rpc.hood.network",
  "https://rpc.hoodscan.io",
  "https://hood-mainnet.g.alchemy.com/public",
  "https://rpc.hoodscan.com",
  "https://robinhood.drpc.org",
];

export type PublicDrop = {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxPerWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
};

export type ChainLink = {
  rpcUrl: string;
  chainId: bigint;
  chainIdHex: string;
  nftHasCode: boolean;
  seadropHasCode: boolean;
};

export type CollectionSnap = {
  name: string;
  image: string | null;
  slug: string;
  chain: string;
  source: string;
};

export type MintStats = {
  mintedByWallet: bigint;
  totalSupply: bigint;
  maxSupply: bigint;
};

export type TargetLock = {
  collection: string;
  url: string;
  name: string;
  nftHasCode: boolean;
  seadropHasCode: boolean;
  publicDrop: boolean;
  mintFn: string;
  quantity: number;
  chainId: string;
  rpcUrl: string;
  calldataContainsCollection: boolean;
};

type RpcOk = { result: string | Record<string, unknown> | null; error?: { message?: string } };

export function getPublicDropCalldata(nft = COLLECTION): string {
  return selector("getPublicDrop(address)") + padAddress(nft);
}

export function mintSelector(): string {
  return selector("mintPublic(address,address,address,uint256)");
}

export async function rpc<T = string>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 3500,
): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`rpc ${res.status} ${url}: ${text.slice(0, 180)}`);
    const json = JSON.parse(text) as RpcOk;
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}

function hasCode(raw: string | null | undefined): boolean {
  return !!raw && raw !== "0x" && raw !== "0x0" && raw.length > 4;
}

async function probeRpc(url: string): Promise<ChainLink> {
  const id = await rpc<string>(url, "eth_chainId", [], 2500);
  const chainId = fromQuantity(id);
  if (chainId === 0n) throw new Error("chainId 0");
  const nftCode = await rpc<string>(url, "eth_getCode", [COLLECTION, "latest"], 3000);
  const seadropCode = await rpc<string>(url, "eth_getCode", [SEADROP, "latest"], 3000);
  await rpc<string>(url, "eth_call", [{ to: COLLECTION, data: NAME_SELECTOR }, "latest"], 3000);
  return {
    rpcUrl: url,
    chainId,
    chainIdHex: toQuantity(chainId),
    nftHasCode: hasCode(nftCode),
    seadropHasCode: hasCode(seadropCode),
  };
}

export async function resolveChain(preferred?: string): Promise<ChainLink> {
  const urls = [...new Set([preferred, ...RPC_CANDIDATES].filter((u): u is string => !!u))];
  const errors: string[] = [];
  let fallback: ChainLink | null = null;
  const pending = urls.map(async (url) => {
    try {
      return await probeRpc(url);
    } catch (e) {
      errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  });
  for (const row of pending) {
    try {
      const hit = await row;
      if (hit.nftHasCode) return hit;
      if (!fallback) fallback = hit;
    } catch {
      /* keep scanning */
    }
  }
  if (fallback) return fallback;
  throw new Error(
    "Robinhood RPC: нет eth_call по коллекции 0xc211…c929. Поставь RPC_URL в Env. " +
      errors.slice(0, 4).join(" | "),
  );
}

export function decodePublicDrop(raw: string | null | undefined): PublicDrop | null {
  if (!raw || raw === "0x" || raw === "0x0") return null;
  const hex = raw.slice(2).padStart(64 * 6, "0");
  if (hex.length < 64 * 6) return null;
  const word = (i: number) => BigInt("0x" + hex.slice(i * 64, i * 64 + 64));
  const startTime = Number(word(1));
  const endTime = Number(word(2));
  if (startTime === 0 && endTime === 0 && word(0) === 0n) return null;
  return {
    mintPrice: word(0),
    startTime,
    endTime,
    maxPerWallet: Number(word(3)),
    feeBps: Number(word(4)),
    restrictFeeRecipients: word(5) !== 0n,
  };
}

export function decodeAbiString(raw: string | null | undefined): string {
  if (!raw || raw === "0x" || raw.length < 130) return "";
  try {
    const hex = raw.slice(2);
    const offset = Number(BigInt("0x" + hex.slice(0, 64)));
    const start = offset * 2;
    const len = Number(BigInt("0x" + hex.slice(start, start + 64)));
    if (!Number.isFinite(len) || len < 0 || len > 256) return "";
    const data = hex.slice(start + 64, start + 64 + len * 2);
    return new TextDecoder().decode(hexToBytes("0x" + data)).replace(/\0/g, "");
  } catch {
    return "";
  }
}

export async function readPublicDrop(rpcUrl: string, nft = COLLECTION, seadrop = SEADROP): Promise<PublicDrop | null> {
  const raw = await rpc<string>(rpcUrl, "eth_call", [{ to: seadrop, data: getPublicDropCalldata(nft) }, "latest"]);
  return decodePublicDrop(raw);
}

export async function readMintStats(
  rpcUrl: string,
  minter: string,
  nft = COLLECTION,
): Promise<MintStats | null> {
  try {
    const data = selector("getMintStats(address)") + padAddress(minter);
    const raw = await rpc<string>(rpcUrl, "eth_call", [{ to: nft, data }, "latest"]);
    if (!raw || raw === "0x") return null;
    const hex = raw.slice(2).padStart(64 * 3, "0");
    const word = (i: number) => BigInt("0x" + hex.slice(i * 64, i * 64 + 64));
    return { mintedByWallet: word(0), totalSupply: word(1), maxSupply: word(2) };
  } catch {
    return null;
  }
}

export async function readSupply(rpcUrl: string, nft = COLLECTION): Promise<{ total: bigint; max: bigint | null }> {
  const totalSel = selector("totalSupply()");
  const maxSel = selector("maxSupply()");
  let total = 0n;
  let max: bigint | null = null;
  try {
    total = fromQuantity(await rpc<string>(rpcUrl, "eth_call", [{ to: nft, data: totalSel }, "latest"]));
  } catch {
    total = 0n;
  }
  try {
    max = fromQuantity(await rpc<string>(rpcUrl, "eth_call", [{ to: nft, data: maxSel }, "latest"]));
  } catch {
    max = null;
  }
  return { total, max };
}

export async function readName(rpcUrl: string, nft = COLLECTION): Promise<string> {
  try {
    const raw = await rpc<string>(rpcUrl, "eth_call", [{ to: nft, data: NAME_SELECTOR }, "latest"]);
    return decodeAbiString(raw);
  } catch {
    return "";
  }
}

export async function readBlockNumber(rpcUrl: string): Promise<bigint> {
  return fromQuantity(await rpc<string>(rpcUrl, "eth_blockNumber", []));
}

export function dropPhase(drop: PublicDrop | null, nowSec: number): "unknown" | "unscheduled" | "countdown" | "live" | "ended" {
  if (!drop) return "unknown";
  if (!drop.startTime) return "unscheduled";
  if (nowSec < drop.startTime) return "countdown";
  if (drop.endTime && nowSec >= drop.endTime) return "ended";
  return "live";
}

export type BuiltMint = {
  to: string;
  data: string;
  value: string;
  valueWei: string;
  chainId: string;
  chainIdHex: string;
  nft: string;
  feeRecipient: string;
  quantity: number;
};

export function buildMint(minter: string, mintPrice: bigint, chainId: bigint): BuiltMint {
  const data = encodeMintPublic(COLLECTION, FEE_RECIPIENT, minter, QUANTITY);
  const value = mintPrice * QUANTITY;
  return {
    to: SEADROP,
    data,
    value: toQuantity(value),
    valueWei: value.toString(),
    chainId: chainId.toString(),
    chainIdHex: toQuantity(chainId),
    nft: COLLECTION,
    feeRecipient: FEE_RECIPIENT,
    quantity: 1,
  };
}

export function calldataTargetsCollection(data: string): boolean {
  return data.toLowerCase().includes(COLLECTION.slice(2).toLowerCase());
}

export async function sendMint(opts: {
  rpcUrl: string;
  chainId: bigint;
  privateKey: string;
  minter: string;
  mintPrice: bigint;
}): Promise<{ hash: string; from: string; latencyMs: number }> {
  const pk = normalizePrivateKey(opts.privateKey);
  const from = addressFromPrivateKey(pk);
  const built = buildMint(opts.minter || from, opts.mintPrice, opts.chainId);
  if (built.to.toLowerCase() !== SEADROP.toLowerCase() || !calldataTargetsCollection(built.data)) {
    throw new Error("mint calldata miss: not this collection");
  }
  const t0 = Date.now();
  const nonceHex = await rpc<string>(opts.rpcUrl, "eth_getTransactionCount", [from, "pending"]);
  const nonce = fromQuantity(nonceHex);
  let gasLimit = 280000n;
  try {
    const est = await rpc<string>(opts.rpcUrl, "eth_estimateGas", [
      { from, to: built.to, data: built.data, value: built.value },
    ]);
    const g = fromQuantity(est);
    gasLimit = g + g / 5n;
  } catch {
    gasLimit = 320000n;
  }

  let raw: string;
  try {
    const block = await rpc<{ baseFeePerGas?: string }>(opts.rpcUrl, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    const base = fromQuantity(block?.baseFeePerGas);
    let tip = 1_000_000_000n;
    try {
      tip = fromQuantity(await rpc<string>(opts.rpcUrl, "eth_maxPriorityFeePerGas", []));
    } catch {
      tip = 1_000_000_000n;
    }
    if (tip === 0n) tip = 100_000_000n;
    const maxFee = base * 2n + tip;
    raw = signEip1559Tx({
      privateKey: pk,
      chainId: opts.chainId,
      nonce,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFee === 0n ? tip * 2n : maxFee,
      gasLimit,
      to: built.to,
      value: BigInt(built.valueWei),
      data: built.data,
    });
  } catch {
    let gasPrice = fromQuantity(await rpc<string>(opts.rpcUrl, "eth_gasPrice", []));
    if (gasPrice === 0n) gasPrice = 1_000_000_000n;
    raw = signLegacyTx({
      privateKey: pk,
      chainId: opts.chainId,
      nonce,
      gasPrice,
      gasLimit,
      to: built.to,
      value: BigInt(built.valueWei),
      data: built.data,
    });
  }

  const hash = await rpc<string>(opts.rpcUrl, "eth_sendRawTransaction", [encodeRawForBroadcast(raw)], 12000);
  return { hash, from, latencyMs: Date.now() - t0 };
}

export function classifyMintError(message: string): "retry" | "sold_out" | "not_started" | "ended" | "already" | "fatal" {
  const m = message.toLowerCase();
  if (/sold.?out|maxsupply|exceeds max|insufficient supply|minted out/.test(m)) return "sold_out";
  if (/not started|before start|starttime|inactive/.test(m)) return "not_started";
  if (/ended|after end|endtime|drop is over/.test(m)) return "ended";
  if (/already minted|max.*wallet|exceeds wallet|mint limit/.test(m)) return "already";
  if (/insufficient funds|nonce too low|replacement|underpriced/.test(m)) return "retry";
  if (/execution reverted/.test(m)) return "retry";
  return "retry";
}

export async function fetchCollection(): Promise<CollectionSnap> {
  const fallback: CollectionSnap = {
    name: "Goat Street",
    image: null,
    slug: "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929",
    chain: "robinhood",
    source: "fallback",
  };
  const chains = ["robinhood", "robinhood_chain", "rh", "hood", "ethereum"];
  for (const chain of chains) {
    try {
      const res = await fetch(
        `https://api.opensea.io/api/v2/chain/${chain}/contract/${COLLECTION}`,
        { headers: { accept: "application/json" } },
      );
      const text = await res.text();
      if (!res.ok) continue;
      const json = JSON.parse(text) as {
        name?: string;
        collection?: string;
        image_url?: string;
        contract?: string;
      };
      if (json.contract && json.contract.toLowerCase() !== COLLECTION) continue;
      if (json.name || json.collection) {
        return {
          name: json.name || json.collection || fallback.name,
          image: json.image_url || null,
          slug: json.collection || fallback.slug,
          chain,
          source: "opensea-v2",
        };
      }
    } catch {
      continue;
    }
  }
  try {
    const res = await fetch(
      `https://api.opensea.io/api/v2/collections/${COLLECTION}`,
      { headers: { accept: "application/json" } },
    );
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text) as {
        name?: string;
        image_url?: string;
        collection?: string;
        contracts?: Array<{ address?: string; chain?: string }>;
      };
      const hit = json.contracts?.find((c) => c.address?.toLowerCase() === COLLECTION);
      if (json.name) {
        return {
          name: json.name,
          image: json.image_url || null,
          slug: json.collection || fallback.slug,
          chain: hit?.chain || "robinhood",
          source: "opensea-collection",
        };
      }
    }
  } catch {
    /* keep fallback */
  }
  return fallback;
}

export function formatEther(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const s = frac ? `${whole}.${frac.slice(0, 6)}` : whole.toString();
  return (neg ? "-" : "") + s;
}

export { keccak256Hex, addressFromPrivateKey, normalizePrivateKey };
