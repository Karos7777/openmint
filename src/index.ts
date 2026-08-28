import { DurableObject } from "cloudflare:workers";
import {
  COLLECTION,
  FEE_RECIPIENT,
  OPENSEA_URL,
  QUANTITY,
  SEADROP,
  addressFromPrivateKey,
  buildMint,
  calldataTargetsCollection,
  classifyMintError,
  decodePublicDrop,
  dropPhase,
  fetchCollection,
  formatEther,
  getPublicDropCalldata,
  mintSelector,
  normalizePrivateKey,
  readBlockNumber,
  readMintStats,
  readName,
  readPublicDrop,
  readSupply,
  resolveChain,
  sendMint,
  type BuiltMint,
  type ChainLink,
  type CollectionSnap,
  type PublicDrop,
} from "./chain";
import { runMigrations } from "./migrations";

type Env = {
  WALLET_PRIVATE_KEY?: string;
  RPC_URL?: string;
  OPENSEA_API_KEY?: string;
};

type Phase = "unknown" | "unscheduled" | "countdown" | "live" | "ended";

type AttemptRow = {
  id: number;
  ts: number;
  kind: string;
  message: string;
  latency_ms: number | null;
  tx_hash: string | null;
};

export class App extends DurableObject<Env> {
  private tickRunning = false;
  private minting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    try {
      runMigrations(ctx.storage);
    } catch (e) {
      this.ctx.storage.kv.put("boot_error", e instanceof Error ? e.message : String(e));
    }
    void this.ensureAlarm(800);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch (e) {
      const message = e instanceof Error ? e.stack || e.message : String(e);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = apiPath(url.pathname);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      void this.push(pair[1]);
      void this.ensureAlarm(200);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/api/status" && request.method === "GET") {
      await this.refresh(false);
      return Response.json(await this.status());
    }
    if (path === "/api/attempts" && request.method === "GET") {
      return Response.json({ attempts: this.attempts(80) });
    }
    if (path === "/api/arm" && request.method === "POST") {
      const body = await safeJson(request);
      if (body.minter && !isAddress(body.minter)) {
        return Response.json({ error: "некорректный адрес" }, { status: 400 });
      }
      if (body.minter) this.ctx.storage.kv.put("minter", body.minter);
      this.ctx.storage.kv.put("armed", true);
      this.ctx.storage.kv.put("stop_reason", "");
      this.ctx.storage.kv.put("success_tx", "");
      this.log("arm", `консоль вооружена · 1 NFT · ${short(this.minter() || "кошелёк не задан")}`);
      void this.tick("arm");
      this.broadcast();
      return Response.json(await this.status());
    }
    if (path === "/api/disarm" && request.method === "POST") {
      this.ctx.storage.kv.put("armed", false);
      this.log("disarm", "консоль снята с боевого режима");
      this.broadcast();
      return Response.json(await this.status());
    }
    if (path === "/api/minter" && request.method === "POST") {
      const body = await safeJson(request);
      if (!isAddress(body.minter || "")) {
        return Response.json({ error: "подключи кошелёк" }, { status: 400 });
      }
      this.ctx.storage.kv.put("minter", body.minter);
      this.log("wallet", `минтер ${short(body.minter)}`);
      this.broadcast();
      return Response.json(await this.status());
    }
    if (path === "/api/probe" && request.method === "POST") {
      const body = await safeJson(request);
      this.ingestProbe(body);
      this.broadcast();
      return Response.json(await this.status());
    }
    if (path === "/api/prepare" && request.method === "POST") {
      const body = await safeJson(request);
      const minter = body.minter || this.minter();
      if (!isAddress(minter || "")) {
        return Response.json({ error: "нет адреса минта" }, { status: 400 });
      }
      const snap = await this.refresh(true);
      const price = snap.drop?.mintPrice ?? 0n;
      const built = buildMint(minter!, price, snap.chain?.chainId ?? 4663n);
      return Response.json({
        tx: built,
        drop: serializeDrop(snap.drop),
        phase: snap.phase,
        lock: this.lock(built),
      });
    }
    if (path === "/api/mint" && request.method === "POST") {
      const body = await safeJson(request);
      if (body.minter && isAddress(body.minter)) this.ctx.storage.kv.put("minter", body.minter);
      const result = await this.fire("manual");
      this.broadcast();
      return Response.json(result, { status: result.ok || result.retry ? 200 : 409 });
    }
    if (path === "/api/tx" && request.method === "POST") {
      const body = await safeJson(request);
      if (body.hash && /^0x[0-9a-fA-F]{64}$/.test(body.hash)) {
        this.ctx.storage.kv.put("success_tx", body.hash);
        this.ctx.storage.kv.put("armed", false);
        this.ctx.storage.kv.put("stop_reason", "minted");
        this.log("ok", `клиентский минт прошёл ${short(body.hash)}`, null, body.hash);
        this.broadcast();
      } else if (body.error) {
        const kind = classifyMintError(String(body.error));
        this.log(kind === "retry" ? "retry" : kind, String(body.error).slice(0, 280));
        if (kind === "sold_out" || kind === "ended" || kind === "already") {
          this.ctx.storage.kv.put("armed", false);
          this.ctx.storage.kv.put("stop_reason", kind);
        }
        this.broadcast();
      }
      return Response.json(await this.status());
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.tick("alarm");
    const armed = !!this.ctx.storage.kv.get<boolean>("armed");
    const phase = (this.ctx.storage.kv.get<Phase>("phase") || "unknown") as Phase;
    const start = this.ctx.storage.kv.get<number>("start_time") || 0;
    const now = Date.now();
    let wait = 4000;
    if (armed && phase === "live") wait = 250;
    else if (armed && phase === "countdown" && start) {
      const left = start * 1000 - now;
      if (left <= 4000) wait = 200;
      else if (left <= 20000) wait = 400;
      else if (left <= 120000) wait = 1000;
      else wait = 2000;
    } else if (this.ctx.getWebSockets().length) wait = 2500;
    else wait = 8000;
    await this.ensureAlarm(wait);
  }

  private async ensureAlarm(ms: number) {
    const when = Date.now() + Math.max(200, ms);
    const existing = await this.ctx.storage.getAlarm();
    if (existing && existing < when + 50) return;
    await this.ctx.storage.setAlarm(when);
  }

  private async tick(reason: string) {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const snap = await this.refresh(false);
      const armed = !!this.ctx.storage.kv.get<boolean>("armed");
      if (armed && snap.phase === "live" && !this.minting && this.signerReady()) {
        const stop = this.ctx.storage.kv.get<string>("stop_reason") || "";
        if (!stop) {
          this.log("trigger", `дроп LIVE · ${reason} · стреляю 1 NFT`);
          await this.fire("auto");
        }
      }
      this.broadcast();
    } catch (e) {
      this.log("error", e instanceof Error ? e.message : String(e));
      this.broadcast();
    } finally {
      this.tickRunning = false;
    }
  }

  private async refresh(force: boolean) {
    const now = Date.now();
    const last = this.ctx.storage.kv.get<number>("refreshed_at") || 0;
    if (!force && now - last < 180) {
      return this.cachedSnap();
    }

    let chain: ChainLink | null = null;
    let chainError = "";
    try {
      chain = await resolveChain(this.env.RPC_URL);
      this.ctx.storage.kv.put("rpc_url", chain.rpcUrl);
      this.ctx.storage.kv.put("chain_id", chain.chainId.toString());
    } catch (e) {
      chainError = e instanceof Error ? e.message : String(e);
      this.ctx.storage.kv.put("chain_error", chainError);
    }

    let drop: PublicDrop | null = null;
    let supply = { total: 0n, max: null as bigint | null };
    let stats = null as Awaited<ReturnType<typeof readMintStats>>;
    let block = 0n;
    if (chain) {
      this.ctx.storage.kv.put("nft_code", chain.nftHasCode);
      this.ctx.storage.kv.put("seadrop_code", chain.seadropHasCode);
      try {
        drop = await readPublicDrop(chain.rpcUrl);
        if (drop) this.ctx.storage.kv.put("drop_error", "");
      } catch (e) {
        this.ctx.storage.kv.put(
          "drop_error",
          e instanceof Error ? e.message : String(e),
        );
      }
      try {
        supply = await readSupply(chain.rpcUrl);
      } catch {
        /* keep zeros */
      }
      const minter = this.minter();
      if (minter) {
        try {
          stats = await readMintStats(chain.rpcUrl, minter);
        } catch {
          stats = null;
        }
      }
      try {
        block = await readBlockNumber(chain.rpcUrl);
      } catch {
        block = 0n;
      }
      try {
        const onchainName = await readName(chain.rpcUrl);
        if (onchainName) this.ctx.storage.kv.put("onchain_name", onchainName);
      } catch {
        /* ignore */
      }
    }

    if (!drop) drop = this.walletDrop();

    if (!this.ctx.storage.kv.get<CollectionSnap>("collection") || now - last > 30000) {
      try {
        const col = await fetchCollection();
        this.ctx.storage.kv.put("collection", col);
      } catch {
        /* keep previous */
      }
    }

    const phase = dropPhase(drop, Math.floor(now / 1000));
    this.ctx.storage.kv.put("phase", phase);
    this.ctx.storage.kv.put("start_time", drop?.startTime || 0);
    this.ctx.storage.kv.put("end_time", drop?.endTime || 0);
    this.ctx.storage.kv.put("mint_price", drop ? drop.mintPrice.toString() : "");
    this.ctx.storage.kv.put("max_per_wallet", drop?.maxPerWallet ?? 0);
    this.ctx.storage.kv.put("total_supply", supply.total.toString());
    this.ctx.storage.kv.put("max_supply", supply.max === null ? "" : supply.max.toString());
    this.ctx.storage.kv.put("block", block.toString());
    this.ctx.storage.kv.put("refreshed_at", now);
    if (chain) this.ctx.storage.kv.put("chain_error", "");
    if (stats) {
      this.ctx.storage.kv.put("minted_wallet", stats.mintedByWallet.toString());
      if (stats.mintedByWallet >= QUANTITY && !!this.ctx.storage.kv.get<boolean>("armed")) {
        this.ctx.storage.kv.put("armed", false);
        this.ctx.storage.kv.put("stop_reason", "already");
        this.log("already", `кошелёк уже забрал ${stats.mintedByWallet.toString()} NFT`);
      }
    }
    if (phase === "ended" && !!this.ctx.storage.kv.get<boolean>("armed")) {
      this.ctx.storage.kv.put("armed", false);
      this.ctx.storage.kv.put("stop_reason", "ended");
      this.log("ended", "окно дропа закрыто");
    }
    if (supply.max && supply.total >= supply.max && !!this.ctx.storage.kv.get<boolean>("armed")) {
      this.ctx.storage.kv.put("armed", false);
      this.ctx.storage.kv.put("stop_reason", "sold_out");
      this.log("sold_out", `sold out ${supply.total.toString()}/${supply.max.toString()}`);
    }

    return { chain, drop, phase, supply, stats, block, chainError };
  }

  private cachedSnap() {
    const cid = this.ctx.storage.kv.get<string>("chain_id");
    const rpc = this.ctx.storage.kv.get<string>("rpc_url");
    const price = this.ctx.storage.kv.get<string>("mint_price");
    const start = this.ctx.storage.kv.get<number>("start_time") || 0;
    const end = this.ctx.storage.kv.get<number>("end_time") || 0;
    const drop: PublicDrop | null =
      price === "" || price === undefined
        ? null
        : {
            mintPrice: BigInt(price || "0"),
            startTime: start,
            endTime: end,
            maxPerWallet: this.ctx.storage.kv.get<number>("max_per_wallet") || 0,
            feeBps: 0,
            restrictFeeRecipients: true,
          };
    const chain: ChainLink | null =
      cid && rpc
        ? {
            rpcUrl: rpc,
            chainId: BigInt(cid),
            chainIdHex: "0x" + BigInt(cid).toString(16),
            nftHasCode: !!this.ctx.storage.kv.get<boolean>("nft_code"),
            seadropHasCode: !!this.ctx.storage.kv.get<boolean>("seadrop_code"),
          }
        : null;
    const maxS = this.ctx.storage.kv.get<string>("max_supply") || "";
    return {
      chain,
      drop,
      phase: (this.ctx.storage.kv.get<Phase>("phase") || "unknown") as Phase,
      supply: {
        total: BigInt(this.ctx.storage.kv.get<string>("total_supply") || "0"),
        max: maxS ? BigInt(maxS) : null,
      },
      stats: null,
      block: BigInt(this.ctx.storage.kv.get<string>("block") || "0"),
      chainError: this.ctx.storage.kv.get<string>("chain_error") || "",
    };
  }

  private async fire(origin: string): Promise<{
    ok: boolean;
    retry: boolean;
    kind: string;
    message: string;
    hash?: string;
    tx?: BuiltMint;
  }> {
    if (this.minting) {
      return { ok: false, retry: true, kind: "busy", message: "предыдущий выстрел ещё в полёте" };
    }
    this.minting = true;
    const t0 = Date.now();
    try {
      const key = this.env.WALLET_PRIVATE_KEY?.trim();
      const snap = await this.refresh(true);
      const minter = this.minter() || (key ? addressFromPrivateKey(normalizePrivateKey(key)) : "");
      if (!minter) {
        const msg = "нет кошелька: подключи MetaMask или поставь WALLET_PRIVATE_KEY в Env";
        this.log("error", msg);
        return { ok: false, retry: false, kind: "fatal", message: msg };
      }
      if (!this.ctx.storage.kv.get<string>("minter") && minter) {
        this.ctx.storage.kv.put("minter", minter);
      }
      const drop = snap.drop || this.walletDrop();
      const price = drop?.mintPrice ?? 0n;
      const tx = buildMint(minter, price, snap.chain?.chainId ?? 4663n);
      if (tx.nft.toLowerCase() !== COLLECTION || !calldataTargetsCollection(tx.data)) {
        const msg = "минт не в эту коллекцию — стоп";
        this.log("fatal", msg);
        return { ok: false, retry: false, kind: "fatal", message: msg };
      }
      if (!drop) {
        const msg = snap.chainError || this.ctx.storage.kv.get<string>("drop_error") || "SeaDrop ещё не отдал окно — ретрай";
        this.log("retry", msg, Date.now() - t0);
        return { ok: false, retry: true, kind: "retry", message: msg, tx };
      }
      if (snap.phase === "countdown") {
        const left = drop.startTime * 1000 - Date.now();
        const msg = `ещё рано · T−${Math.max(0, Math.ceil(left / 1000))}s`;
        this.log("not_started", msg, Date.now() - t0);
        return { ok: false, retry: true, kind: "not_started", message: msg, tx };
      }
      if (snap.phase === "ended") {
        this.ctx.storage.kv.put("armed", false);
        this.ctx.storage.kv.put("stop_reason", "ended");
        this.log("ended", "дроп закончился", Date.now() - t0);
        return { ok: false, retry: false, kind: "ended", message: "дроп закончился", tx };
      }

      if (!key) {
        this.log(
          "handoff",
          `сервер без ключа · клиент должен подписать SeaDrop ${short(SEADROP)}`,
          Date.now() - t0,
        );
        return {
          ok: false,
          retry: true,
          kind: "sign",
          message: "подпиши минт в кошельке — 1 NFT через OpenSea SeaDrop",
          tx,
        };
      }
      if (!snap.chain) {
        const msg = snap.chainError || "нет RPC Robinhood";
        this.log("retry", msg, Date.now() - t0);
        return { ok: false, retry: true, kind: "retry", message: msg, tx };
      }

      try {
        const sent = await sendMint({
          rpcUrl: snap.chain.rpcUrl,
          chainId: snap.chain.chainId,
          privateKey: key,
          minter,
          mintPrice: snap.drop.mintPrice,
        });
        this.ctx.storage.kv.put("success_tx", sent.hash);
        this.ctx.storage.kv.put("armed", false);
        this.ctx.storage.kv.put("stop_reason", "minted");
        this.log("ok", `${origin} · tx ${short(sent.hash)} · ${sent.latencyMs}ms`, sent.latencyMs, sent.hash);
        return { ok: true, retry: false, kind: "ok", message: sent.hash, hash: sent.hash, tx };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const kind = classifyMintError(message);
        this.log(kind === "retry" || kind === "not_started" ? "retry" : kind, message.slice(0, 320), Date.now() - t0);
        if (kind === "sold_out" || kind === "ended" || kind === "already") {
          this.ctx.storage.kv.put("armed", false);
          this.ctx.storage.kv.put("stop_reason", kind);
          return { ok: false, retry: false, kind, message, tx };
        }
        return { ok: false, retry: true, kind, message, tx };
      }
    } finally {
      this.minting = false;
    }
  }

  private minter(): string {
    const stored = this.ctx.storage.kv.get<string>("minter") || "";
    if (stored) return stored;
    const key = this.env.WALLET_PRIVATE_KEY?.trim();
    if (!key) return "";
    try {
      const addr = addressFromPrivateKey(normalizePrivateKey(key));
      this.ctx.storage.kv.put("minter", addr);
      return addr;
    } catch {
      return "";
    }
  }

  private signerReady(): boolean {
    const key = this.env.WALLET_PRIVATE_KEY?.trim();
    if (!key) return false;
    try {
      normalizePrivateKey(key);
      return true;
    } catch {
      return false;
    }
  }

  private log(kind: string, message: string, latency: number | null = null, tx: string | null = null) {
    this.ctx.storage.sql.exec(
      `INSERT INTO attempts (ts, kind, message, latency_ms, tx_hash) VALUES (?, ?, ?, ?, ?)`,
      Date.now(),
      kind,
      message.slice(0, 500),
      latency,
      tx,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM attempts WHERE id NOT IN (SELECT id FROM attempts ORDER BY id DESC LIMIT 400)`,
    );
  }

  private attempts(limit = 60): AttemptRow[] {
    return this.ctx.storage.sql
      .exec(
        `SELECT id, ts, kind, message, latency_ms, tx_hash FROM attempts ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .toArray() as AttemptRow[];
  }

  private async status() {
    const snap = this.cachedSnap();
    const col = this.ctx.storage.kv.get<CollectionSnap>("collection") || {
      name: "OpenSea · Robinhood",
      image: null,
      slug: COLLECTION,
      chain: "robinhood",
      source: "local",
    };
    const minter = this.minter();
    const price = snap.drop?.mintPrice ?? 0n;
    return {
      collection: {
        address: COLLECTION,
        name: col.name,
        image: col.image,
        slug: col.slug,
        url: OPENSEA_URL,
        seadrop: SEADROP,
        feeRecipient: FEE_RECIPIENT,
        quantity: 1,
        chainName: "Robinhood Mainnet",
      },
      phase: snap.phase,
      drop: serializeDrop(snap.drop),
      supply: {
        total: snap.supply.total.toString(),
        max: snap.supply.max === null ? null : snap.supply.max.toString(),
      },
      block: snap.block.toString(),
      chain: snap.chain
        ? {
            rpcUrl: snap.chain.rpcUrl,
            chainId: snap.chain.chainId.toString(),
            chainIdHex: snap.chain.chainIdHex,
            native: { name: "Ether", symbol: "ETH", decimals: 18 },
          }
        : null,
      chainError: snap.chainError || this.ctx.storage.kv.get<string>("chain_error") || "",
      dropError: this.ctx.storage.kv.get<string>("drop_error") || "",
      armed: !!this.ctx.storage.kv.get<boolean>("armed"),
      stopReason: this.ctx.storage.kv.get<string>("stop_reason") || "",
      successTx: this.ctx.storage.kv.get<string>("success_tx") || "",
      minter,
      signerReady: this.signerReady(),
      priceEth: formatEther(price),
      now: Date.now(),
      attempts: this.attempts(80),
      lock: this.lock(minter ? buildMint(minter, price, snap.chain?.chainId ?? 4663n) : null),
      probe: {
        nft: COLLECTION,
        seadrop: SEADROP,
        getPublicDrop: { to: SEADROP, data: getPublicDropCalldata() },
        name: { to: COLLECTION, data: "0x06fdde03" },
        totalSupply: { to: COLLECTION, data: "0x18160ddd" },
        maxSupply: { to: COLLECTION, data: "0xd5abeb01" },
      },
    };
  }

  private walletDrop(): PublicDrop | null {
    const raw = this.ctx.storage.kv.get<string>("wallet_drop_raw") || "";
    return decodePublicDrop(raw);
  }

  private ingestProbe(body: Record<string, string>) {
    if (body.dropRaw) {
      const drop = decodePublicDrop(body.dropRaw);
      if (drop) {
        this.ctx.storage.kv.put("wallet_drop_raw", body.dropRaw);
        this.ctx.storage.kv.put("mint_price", drop.mintPrice.toString());
        this.ctx.storage.kv.put("start_time", drop.startTime);
        this.ctx.storage.kv.put("end_time", drop.endTime);
        this.ctx.storage.kv.put("max_per_wallet", drop.maxPerWallet);
        this.ctx.storage.kv.put("phase", dropPhase(drop, Math.floor(Date.now() / 1000)));
        this.ctx.storage.kv.put("drop_error", "");
        this.log("lock", `кошелёк прочитал SeaDrop · старт ${drop.startTime} · цена ${formatEther(drop.mintPrice)} ETH`);
      }
    }
    if (body.name) this.ctx.storage.kv.put("onchain_name", body.name.slice(0, 80));
    if (body.totalSupply) this.ctx.storage.kv.put("total_supply", BigInt(body.totalSupply).toString());
    if (body.maxSupply) this.ctx.storage.kv.put("max_supply", BigInt(body.maxSupply).toString());
    if (body.nftCode === "1") this.ctx.storage.kv.put("nft_code", true);
    if (body.seadropCode === "1") this.ctx.storage.kv.put("seadrop_code", true);
    if (body.block) this.ctx.storage.kv.put("block", body.block);
    if (body.chainId) this.ctx.storage.kv.put("chain_id", BigInt(body.chainId).toString());
  }

  private lock(tx: BuiltMint | null) {
    const name = this.ctx.storage.kv.get<string>("onchain_name") || this.ctx.storage.kv.get<CollectionSnap>("collection")?.name || "Goat Street";
    const drop = this.cachedSnap().drop;
    return {
      collection: COLLECTION,
      url: OPENSEA_URL,
      name,
      nftHasCode: !!this.ctx.storage.kv.get<boolean>("nft_code"),
      seadropHasCode: !!this.ctx.storage.kv.get<boolean>("seadrop_code"),
      publicDrop: !!drop,
      mintFn: "mintPublic(address,address,address,uint256)",
      selector: mintSelector(),
      quantity: 1,
      chainId: this.ctx.storage.kv.get<string>("chain_id") || "4663",
      rpcUrl: this.ctx.storage.kv.get<string>("rpc_url") || "",
      calldataContainsCollection: tx ? calldataTargetsCollection(tx.data) : true,
      toSeaDrop: !tx || tx.to.toLowerCase() === SEADROP.toLowerCase(),
      nftArg: tx?.nft || COLLECTION,
      match: (!tx || (tx.nft.toLowerCase() === COLLECTION && calldataTargetsCollection(tx.data) && tx.to.toLowerCase() === SEADROP.toLowerCase())),
    };
  }

  private async push(ws: WebSocket) {
    try {
      ws.send(JSON.stringify({ type: "state", state: await this.status() }));
    } catch {
      /* closed */
    }
  }

  private broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    void this.status().then((state) => {
      const payload = JSON.stringify({ type: "state", state });
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          /* ignore */
        }
      }
    });
  }

  webSocketClose() {
    /* noop */
  }
}

function apiPath(pathname: string): string {
  const i = pathname.lastIndexOf("/api/");
  return i >= 0 ? pathname.slice(i) : pathname;
}

function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

function short(v: string): string {
  if (v.length < 12) return v;
  return v.slice(0, 6) + "…" + v.slice(-4);
}

function serializeDrop(drop: PublicDrop | null) {
  if (!drop) return null;
  return {
    mintPrice: drop.mintPrice.toString(),
    startTime: drop.startTime,
    endTime: drop.endTime,
    maxPerWallet: drop.maxPerWallet,
    feeBps: drop.feeBps,
  };
}

async function safeJson(request: Request): Promise<Record<string, string>> {
  try {
    const body = (await request.json()) as Record<string, string>;
    return body || {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = ctx.durableObjects.get("App").idFromName("mint");
    const stub = ctx.durableObjects.get(id);
    return stub.fetch(request);
  }
};
