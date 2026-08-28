const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  minter: "",
  firing: false,
  armedLocal: false,
};

function api(path, opts) {
  return fetch("./api" + path.replace(/^\/api/, ""), {
    headers: { "content-type": "application/json" },
    ...opts,
  });
}

function short(v) {
  if (!v) return "—";
  return v.length > 14 ? v.slice(0, 6) + "…" + v.slice(-4) : v;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function phaseCopy(phase) {
  return {
    unknown: "STANDBY",
    unscheduled: "NO WINDOW",
    countdown: "COUNTDOWN",
    live: "LIVE DROP",
    ended: "ENDED",
  }[phase] || phase.toUpperCase();
}

function render(data) {
  state.data = data;
  if (data.minter && !state.minter) state.minter = data.minter;

  $("col-name").textContent = data.lock?.name || data.collection.name || "Goat Street";
  $("col-link").href = data.collection.url;
  $("col-link").textContent = "opensea.io/collection/0xc211…c929";
  $("col-addr").textContent = data.collection.address;
  if (data.collection.image) $("thumb").style.backgroundImage = `url("${data.collection.image}")`;
  const lock = $("lock-line");
  if (data.lock?.match && data.lock.publicDrop) {
    lock.className = "lock ok";
    lock.textContent = "ЗАМОК OK · Goat Street · SeaDrop mintPublic · qty 1";
  } else if (data.lock?.match) {
    lock.className = "lock";
    lock.textContent = "ЦЕЛЬ 0xc211…c929 · ждём окно SeaDrop";
  } else {
    lock.className = "lock bad";
    lock.textContent = "МИМО ЦЕЛИ";
  }

  $("stat-price").textContent = data.priceEth ? data.priceEth + " ETH" : "—";
  const max = data.supply.max ?? "∞";
  $("stat-supply").textContent = `${data.supply.total} / ${max}`;
  $("stat-cap").textContent = String(data.drop?.maxPerWallet || 1);
  $("stat-chain").textContent = data.chain ? `ID ${data.chain.chainId}` : "ROBINHOOD";
  $("block-chip").textContent = data.block && data.block !== "0" ? "BLK " + data.block : "BLK —";
  $("link-chip").textContent = data.chain ? "RPC OK" : data.chainError ? "RPC FAIL" : "RPC —";
  $("link-chip").style.color = data.chain ? "var(--acid)" : "var(--blood)";

  $("wallet-addr").textContent = state.minter || data.minter || "кошелёк не подключён";
  $("signer-hint").textContent = data.signerReady
    ? "сервер подпишет сам · ключ в Env"
    : "сервер без ключа — подпись в MetaMask";

  const armed = data.armed;
  const stop = data.stopReason;
  const btn = $("arm-btn");
  btn.disabled = stop === "minted" || stop === "sold_out" || stop === "ended" || stop === "already";
  btn.textContent = armed ? "СНЯТЬ С БОЕВОГО" : stop === "minted" ? "ЗАБРАЛ" : "ВООРУЖИТЬ";
  btn.classList.toggle("hot", armed);

  const reticle = $("reticle");
  reticle.className = "reticle " + (stop === "minted" ? "ok" : data.phase);
  $("phase-label").textContent = stop === "minted" ? "HIT" : phaseCopy(data.phase);
  tickTimer();

  const log = $("log");
  log.innerHTML = "";
  for (const row of data.attempts || []) {
    const li = document.createElement("li");
    li.className = row.kind;
    const t = new Date(row.ts);
    const time = document.createElement("span");
    time.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = row.kind;
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = row.message;
    li.append(time, kind, msg);
    log.appendChild(li);
  }
  $("log-count").textContent = String((data.attempts || []).length);
}

function tickTimer() {
  const data = state.data;
  const now = Date.now();
  $("clock-chip").textContent = new Date(now).toISOString().slice(11, 19) + "Z";
  if (!data) return;
  if (data.stopReason === "minted") {
    $("timer").textContent = "1 / 1";
    $("timer-sub").textContent = data.successTx ? "tx " + short(data.successTx) : "минт закрыт";
    return;
  }
  const start = (data.drop?.startTime || 0) * 1000;
  const end = (data.drop?.endTime || 0) * 1000;
  if (data.phase === "countdown" && start) {
    $("timer").textContent = fmtClock(start - now);
    $("timer-sub").textContent = "до открытия дропа";
  } else if (data.phase === "live") {
    $("timer").textContent = end ? fmtClock(end - now) : "LIVE";
    $("timer-sub").textContent = "окно открыто · 1 NFT";
  } else if (data.phase === "ended") {
    $("timer").textContent = "00:00:00";
    $("timer-sub").textContent = "окно закрыто";
  } else {
    $("timer").textContent = "--:--:--";
    $("timer-sub").textContent = data.chainError || data.dropError || "ждём SeaDrop";
  }
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) {
    alert("нужен MetaMask / Rabby");
    return;
  }
  const acc = await eth.request({ method: "eth_requestAccounts" });
  state.minter = acc[0];
  await ensureChain();
  await api("/api/minter", { method: "POST", body: JSON.stringify({ minter: state.minter }) });
  await probeWallet();
}

async function ensureChain() {
  const eth = window.ethereum;
  if (!eth) return;
  const chainIdHex = state.data?.chain?.chainIdHex || "0x1237";
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (e) {
    if (e?.code === 4902 || /unrecognized/i.test(String(e?.message || ""))) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: chainIdHex,
          chainName: "Robinhood Mainnet",
          nativeCurrency: state.data?.chain?.native || { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [state.data?.chain?.rpcUrl || "https://4663.rpc.thirdweb.com"],
          blockExplorerUrls: ["https://opensea.io"],
        }],
      });
    }
  }
}

async function probeWallet() {
  const eth = window.ethereum;
  const probe = state.data?.probe;
  if (!eth || !probe) return;
  const payload = {};
  try {
    payload.chainId = await eth.request({ method: "eth_chainId" });
  } catch { /* ignore */ }
  try {
    payload.dropRaw = await eth.request({
      method: "eth_call",
      params: [probe.getPublicDrop, "latest"],
    });
  } catch { /* public rpc may work later */ }
  try {
    const nameRaw = await eth.request({ method: "eth_call", params: [probe.name, "latest"] });
    payload.name = decodeName(nameRaw);
  } catch { /* ignore */ }
  try {
    payload.totalSupply = String(BigInt(await eth.request({ method: "eth_call", params: [probe.totalSupply, "latest"] })));
  } catch { /* ignore */ }
  try {
    payload.maxSupply = String(BigInt(await eth.request({ method: "eth_call", params: [probe.maxSupply, "latest"] })));
  } catch { /* ignore */ }
  try {
    const nftCode = await eth.request({ method: "eth_getCode", params: [probe.nft, "latest"] });
    payload.nftCode = nftCode && nftCode !== "0x" ? "1" : "0";
  } catch { /* ignore */ }
  try {
    const sd = await eth.request({ method: "eth_getCode", params: [probe.seadrop, "latest"] });
    payload.seadropCode = sd && sd !== "0x" ? "1" : "0";
  } catch { /* ignore */ }
  if (Object.keys(payload).length) {
    await api("/api/probe", { method: "POST", body: JSON.stringify(payload) });
  }
}

function decodeName(raw) {
  if (!raw || raw === "0x" || raw.length < 130) return "";
  try {
    const hex = raw.slice(2);
    const offset = Number(BigInt("0x" + hex.slice(0, 64)));
    const start = offset * 2;
    const len = Number(BigInt("0x" + hex.slice(start, start + 64)));
    const data = hex.slice(start + 64, start + 64 + len * 2);
    const bytes = [];
    for (let i = 0; i < data.length; i += 2) bytes.push(parseInt(data.slice(i, i + 2), 16));
    return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0/g, "");
  } catch {
    return "";
  }
}

async function armToggle() {
  if (!state.minter && !state.data?.minter && window.ethereum) await connect();
  if (state.data?.armed) {
    state.armedLocal = false;
    await api("/api/disarm", { method: "POST", body: "{}" });
    return;
  }
  state.armedLocal = true;
  await api("/api/arm", {
    method: "POST",
    body: JSON.stringify({ minter: state.minter || state.data?.minter || "" }),
  });
  void hunt();
}

async function hunt() {
  if (state.firing) return;
  const data = state.data;
  if (!data?.armed && !state.armedLocal) return;
  if (data?.stopReason === "minted" || data?.stopReason === "sold_out" || data?.stopReason === "ended") return;
  if (window.ethereum && !data?.drop) void probeWallet();
  if (data?.phase === "countdown") {
    const left = (data.drop?.startTime || 0) * 1000 - Date.now();
    if (left > 250) return;
    await fire();
    return;
  }
  if (data?.phase === "live") await fire();
}

async function fire() {
  if (state.firing) return;
  if (state.data?.stopReason === "minted") return;
  state.firing = true;
  try {
    const res = await api("/api/mint", {
      method: "POST",
      body: JSON.stringify({ minter: state.minter || state.data?.minter || "" }),
    });
    const json = await res.json();
    if (json.hash || json.ok) return;
    if (json.tx && window.ethereum && (json.kind === "sign" || !state.data?.signerReady)) {
      await sendFromWallet(json.tx);
      return;
    }
    if (json.retry !== false && (state.data?.armed || state.armedLocal)) {
      setTimeout(() => { state.firing = false; void hunt(); }, 80);
      return;
    }
  } catch (e) {
    await api("/api/tx", { method: "POST", body: JSON.stringify({ error: String(e.message || e) }) });
    if (state.data?.armed || state.armedLocal) {
      setTimeout(() => { state.firing = false; void hunt(); }, 80);
      return;
    }
  } finally {
    state.firing = false;
  }
}

async function sendFromWallet(tx) {
  const eth = window.ethereum;
  if (!eth) throw new Error("нет кошелька");
  const nft = "0xc21159f412c294ca2c38f2a9ecaaccf9d93ec929";
  const seadrop = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
  if (tx.to.toLowerCase() !== seadrop || !String(tx.data).toLowerCase().includes(nft.slice(2))) {
    throw new Error("tx не в Goat Street / 0xc211…c929");
  }
  await ensureChain();
  if (!state.minter) {
    const acc = await eth.request({ method: "eth_requestAccounts" });
    state.minter = acc[0];
  }
  try {
    const hash = await eth.request({
      method: "eth_sendTransaction",
      params: [{
        from: state.minter,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      }],
    });
    await api("/api/tx", { method: "POST", body: JSON.stringify({ hash }) });
  } catch (e) {
    const msg = e?.message || String(e);
    await api("/api/tx", { method: "POST", body: JSON.stringify({ error: msg }) });
    if (!/reject|denied|user/i.test(msg) && (state.data?.armed || state.armedLocal)) {
      setTimeout(() => void hunt(), 60);
    }
  }
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(proto + "//" + location.host + location.pathname.replace(/\/?$/, "/") + "ws");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") {
        render(msg.state);
        void hunt();
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 800);
}

async function boot() {
  let data = null;
  for (let i = 0; i < 8 && !data; i++) {
    try {
      const res = await api("/api/status");
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 160));
      data = JSON.parse(text);
    } catch {
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  if (data) render(data);
  connectSocket();
  $("connect-btn").onclick = () => void connect();
  $("arm-btn").onclick = () => void armToggle();
  $("fire-btn").onclick = () => void fire();
  setInterval(tickTimer, 200);
  setInterval(() => { if (state.data?.armed) void probeWallet(); }, 1500);
  if (window.ethereum) {
    window.ethereum.request({ method: "eth_accounts" }).then((acc) => {
      if (acc?.[0]) {
        state.minter = acc[0];
        api("/api/minter", { method: "POST", body: JSON.stringify({ minter: acc[0] }) }).then(() => probeWallet());
      }
    }).catch(() => {});
  }
}

boot();
