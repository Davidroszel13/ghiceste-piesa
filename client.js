// Ghicește Piesa — clientul. Gazda (cine creează camera) rulează regulile din logic.js
// în browser și trimite fiecăruia starea lui printr-un releu MQTT. Audio se redă local.

import * as logic from "./logic.js";

const PW_HASH = "f9b458c1711b34a5dd6507b316ac0518d99325803d96e955ef504bf47c0cf6f8";
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const COLORS = ["#1fdf6f", "#f2c94c", "#ff8a3d", "#b26bff", "#4cc9f0", "#ff5d8f", "#a3e635", "#f472b6", "#38bdf8", "#fbbf24"];
const fmtS = (s) => (s < 1 ? s.toFixed(1) : String(s)) + "s";
const pos = (s) => Math.sqrt(Math.max(0, s) / 15) * 100; // scară neliniară, ca primele secunde să se vadă
const START_TAIL = 16;

let PID = "";
function playerId() {
  // un id per tab (sessionStorage), ca două tab-uri din același browser să fie jucători diferiți
  if (PID) return PID;
  try { PID = sessionStorage.getItem("gp:pid") || ""; } catch {}
  if (!PID) { PID = Math.random().toString(36).slice(2, 12); try { sessionStorage.setItem("gp:pid", PID); } catch {} }
  return PID;
}
async function sha256(t) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
let toastT = 0;
function toast(msg) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 3200);
}
function show(id) {
  for (const s of document.querySelectorAll("section")) s.hidden = s.id !== "s-" + id;
}
function randCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ"; let c = "";
  const r = crypto.getRandomValues(new Uint32Array(5));
  for (const n of r) c += a[n % a.length];
  return c;
}
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

// ── stare client ────────────────────────────────────────────────────────────
let pw = store.get("gp:pw");
let room = cleanCode(new URLSearchParams(location.search).get("room") || location.hash.slice(1));
let leaving = false;
let V = null, you = null, helloSent = false, creating = false;
const names = () => Object.fromEntries((V?.players || []).map((p, i) => [p.id, { name: p.name, i }]));
const nameOf = (id) => names()[id]?.name || "?";
const colorOf = (id) => COLORS[(names()[id]?.i ?? 0) % COLORS.length];

// ── conexiune (releu MQTT) ──────────────────────────────────────────────────
// Toate mesajele trec printr-un broker MQTT public (prin internet, fără conexiune
// directă între dispozitive), așa că merge indiferent de rețea: Wi-Fi, date mobile etc.
const BROKER = window.GP_BROKER || "wss://broker.emqx.io:8084/mqtt";
const TOPIC = (r) => "ghiceste-piesa/v3/" + r;
const net = { mode: null, client: null, joinT: 0, hbT: 0, misses: 0, seq: 0, ver: 0, myVer: -1, hostAlive: 0, lastSeen: {}, lastSeq: {} };
let H = null; // doar la gazdă: { state }
let online = [];
const hostKey = (r) => "gp:host:" + r;
function connStatus(txt) { $("#conn").hidden = !txt; if (txt) $("#conn").textContent = txt; }
function pub(topic, obj, qos = 1) { try { if (net.client?.connected) net.client.publish(topic, JSON.stringify(obj), { qos }); } catch {} }
function mqttConnect(onReady, onMsg) {
  const c = mqtt.connect(BROKER, {
    clientId: "gp_" + playerId() + "_" + Math.random().toString(36).slice(2, 7),
    clean: true, reconnectPeriod: 2000, connectTimeout: 10000, keepalive: 30,
  });
  net.client = c;
  c.on("connect", () => { connStatus(""); onReady(c); });
  c.on("reconnect", () => { if (!leaving) connStatus("reconectare…"); });
  c.on("offline", () => { if (!leaving) connStatus("fără internet, reîncerc…"); });
  c.on("error", () => {});
  c.on("message", (topic, payload) => { let m; try { m = JSON.parse(payload.toString()); } catch { return; } if (m && typeof m === "object") onMsg(topic, m); });
  return c;
}

// ---- gazda: ține starea și o trimite fiecăruia
function startHost(restored) {
  net.mode = "host"; leaving = false; helloSent = false;
  if (creating) { try { for (const k of Object.keys(localStorage)) if (k.startsWith("gp:host:")) localStorage.removeItem(k); } catch {} }
  H = { state: restored || logic.setup([playerId()]) };
  net.lastSeen = {}; net.lastSeq = {};
  mqttConnect((c) => {
    c.subscribe(TOPIC(room) + "/h", { qos: 1 });
    setUrl(); hostSync();
  }, (topic, m) => { if (topic === TOPIC(room) + "/h") onHostData(m); });
  clearInterval(net.hbT);
  net.hbT = setInterval(() => { const before = online.join(); computeOnline(); if (online.join() !== before) hostSync(); }, 5000);
}
function computeOnline() {
  const now = Date.now();
  online = [playerId(), ...Object.keys(net.lastSeen).filter((p) => now - net.lastSeen[p] < 25000)];
}
function hostApply(pid, action) {
  const v = logic.validateAction(H.state, pid, action);
  if (!v.ok) return v;
  H.state = logic.applyAction(H.state, pid, action);
  store.set(hostKey(room), JSON.stringify(H.state));
  hostSync();
  return v;
}
function sendStateTo(pid) {
  pub(TOPIC(room) + "/p/" + pid, { type: "state", you: pid, online, ver: net.ver, view: logic.viewFor(H.state, pid) });
}
function hostSync() {
  if (!H) return;
  const me = playerId();
  net.ver++; computeOnline();
  const targets = new Set([...H.state.order, ...Object.keys(net.lastSeen)]);
  targets.delete(me);
  for (const pid of targets) sendStateTo(pid);
  onState({ you: me, online, view: logic.viewFor(H.state, me) });
}
function onHostData(m) {
  const pid = String(m.pid ?? "").slice(0, 64);
  if (!pid || pid === playerId()) return;
  const fresh = !net.lastSeen[pid] || Date.now() - net.lastSeen[pid] > 25000;
  net.lastSeen[pid] = Date.now();
  if (m.type === "join" || m.type === "hb") {
    if (fresh) hostSync();
    else if (m.ver !== net.ver) sendStateTo(pid);
    else pub(TOPIC(room) + "/p/" + pid, { type: "pong" }, 0);
  } else if (m.type === "action") {
    const seq = Number(m.seq) || 0;
    if (seq <= (net.lastSeq[pid] || 0)) return; // duplicat
    net.lastSeq[pid] = seq;
    let size = 0; try { size = JSON.stringify(m.action).length; } catch { return; }
    if (size > 6000) return;
    if (fresh) computeOnline();
    const r = hostApply(pid, m.action);
    if (!r.ok) pub(TOPIC(room) + "/p/" + pid, { type: "error", error: r.error || "acțiune invalidă" });
  }
}

// ---- invitatul: trimite acțiuni, primește starea lui
function startGuest() {
  net.mode = "guest"; leaving = false; helloSent = false; net.misses = 0; net.hostAlive = 0; net.myVer = -1;
  net.seq = Date.now();
  $("#homeErr").style.color = "var(--mut)"; $("#homeErr").textContent = "Mă conectez la camera " + room + "…";
  const myTopic = TOPIC(room) + "/p/" + playerId();
  const sendJoin = () => pub(TOPIC(room) + "/h", { type: "join", pid: playerId(), ver: -1 });
  mqttConnect((c) => { c.subscribe(myTopic, { qos: 1 }, () => sendJoin()); }, (topic, m) => {
    if (topic !== myTopic) return;
    net.hostAlive = Date.now();
    if (V) connStatus("");
    if (m.type === "state") { net.myVer = m.ver; onState(m); }
    else if (m.type === "error") onError(m.error);
    else if (m.type === "closed") leave("Gazda a închis camera.");
  });
  clearInterval(net.joinT);
  net.joinT = setInterval(() => {
    if (V || leaving || net.mode !== "guest") { clearInterval(net.joinT); return; }
    net.misses++;
    if (net.misses >= 2) $("#homeErr").textContent = "Camera " + room + " nu e deschisă acum. Gazda trebuie să aibă jocul deschis pe ecran. Mai încerc…";
    if (net.misses > 12) { leave("Nu găsesc camera " + room + ". Verifică codul și ca gazda să aibă pagina jocului deschisă."); return; }
    sendJoin();
  }, 3000);
  clearInterval(net.hbT);
  net.hbT = setInterval(() => {
    if (!V || leaving) return;
    pub(TOPIC(room) + "/h", { type: "hb", pid: playerId(), ver: net.myVer }, 0);
    if (Date.now() - net.hostAlive > 25000) connStatus("Gazda e offline, aștept…");
  }, 8000);
}
function send(action) {
  if (net.mode === "host" && H) {
    const r = hostApply(playerId(), action);
    if (!r.ok) onError(r.error || "acțiune invalidă");
  } else if (net.client?.connected) {
    net.seq += 1;
    pub(TOPIC(room) + "/h", { type: "action", pid: playerId(), seq: net.seq, action });
  } else toast("Nu ești conectat. Încerc din nou…");
}
function leave(msg) {
  leaving = true;
  if (net.mode === "host" && H) {
    for (const pid of new Set([...H.state.order, ...Object.keys(net.lastSeen)])) if (pid !== playerId()) pub(TOPIC(room) + "/p/" + pid, { type: "closed" }, 0);
    if (!msg) store.del(hostKey(room));
  }
  const c = net.client;
  setTimeout(() => { try { c?.end(true); } catch {} }, 400);
  clearInterval(net.joinT); clearInterval(net.hbT);
  net.client = null; net.mode = null; H = null;
  V = null; room = ""; creating = false; connStatus("");
  history.replaceState(null, "", location.pathname);
  stopSnippet(); try { media.yt?.stopVideo(); } catch {} try { media.sp?.pause(); } catch {}
  goHome(msg);
}
function onState(msg) {
  you = msg.you; const view = msg.view;
  if (Array.isArray(msg.online)) online = msg.online;
  if (!view) return;
  if (!view.joined) {
    if (!helloSent) { helloSent = true; send({ type: "hello", name: store.get("gp:name"), pw }); }
    return;
  }
  creating = false; clearInterval(net.joinT); V = view; render();
}
function onError(err) {
  if (!V) { // eroare la intrare
    if (/Parol/.test(err)) { store.del("gp:pw"); pw = ""; leave(); show("gate"); $("#gateErr").textContent = "Parolă greșită."; return; }
    leave(err); return;
  }
  toast(err);
}
function setUrl() { history.replaceState(null, "", location.pathname + "?room=" + room); }

// ── ecrane: parolă + acasă ──────────────────────────────────────────────────
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#gatePw").value.trim();
  if ((await sha256(v)) !== PW_HASH) { $("#gateErr").textContent = "Parolă greșită."; return; }
  pw = v; store.set("gp:pw", v); $("#gateErr").textContent = ""; goHome();
});
function goHome(err) {
  show("home");
  $("#homeName").value = store.get("gp:name");
  $("#homeErr").textContent = err || ""; $("#homeErr").style.color = "";
  const linked = !!room;
  $("#homeLinkJoin").hidden = !linked; $("#homeChoices").hidden = linked;
  $("#homeLinkCode").textContent = room;
  let mine = false;
  try { const sv = JSON.parse(store.get(hostKey(room)) || "null"); mine = !!(sv && sv.players && sv.players[playerId()]); } catch {}
  $("#joinLinkBtn").firstChild.textContent = mine ? "Revino în camera " : "Intră în camera ";
}
function needName() {
  const n = $("#homeName").value.replace(/\s+/g, " ").trim().slice(0, 18);
  if (!n) { $("#homeErr").textContent = "Scrie-ți numele mai întâi."; $("#homeName").focus(); return null; }
  store.set("gp:name", n); return n;
}
$("#createBtn").onclick = () => { if (!needName()) return; room = randCode(); creating = true; startHost(null); };
$("#joinBtn").onclick = () => {
  if (!needName()) return;
  const c = cleanCode($("#homeCode").value);
  if (c.length < 4) { $("#homeErr").textContent = "Codul are 5 litere."; return; }
  room = c; creating = false; setUrl(); joinRoom();
};
$("#homeCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#joinBtn").click(); });
$("#joinLinkBtn").onclick = () => { if (!needName()) return; creating = false; joinRoom(); };
function joinRoom() {
  let saved = null;
  try { saved = JSON.parse(store.get(hostKey(room)) || "null"); } catch {}
  if (saved && saved.players && saved.players[playerId()]) startHost(saved); // ești gazda acestei camere (ex. după reîncărcare)
  else startGuest();
}
$("#homeOther").onclick = () => { room = ""; history.replaceState(null, "", location.pathname); goHome(); };

// ── randare ─────────────────────────────────────────────────────────────────
function render() {
  if (!V) return;
  const ph = V.phase;
  if (ph === "lobby") { show("lobby"); renderLobby(); }
  else if (ph === "setup") { show("setup"); renderSetup(); }
  else if (ph === "play" || ph === "reveal") { show("round"); renderRound(); }
  else if (ph === "end") { show("end"); renderEnd(); }
  if (ph !== "play" && ph !== "reveal") {
    stopSnippet();
    if (lastRoundKey) { try { media.yt?.stopVideo(); } catch {} try { media.sp?.pause(); } catch {} }
    lastRoundKey = "";
  }
  if (ph !== "setup") rowsBuilt = false;
}
const isHost = () => V && V.host === you;
const avatar = (id) => `<span class="av" style="background:${colorOf(id)}">${esc(nameOf(id).slice(0, 1).toUpperCase())}</span>`;

// lobby
function renderLobby() {
  $("#lCode").textContent = room;
  $("#lLink").value = location.origin + location.pathname + "?room=" + room;
  const n = V.players.length, max = V.cfg.max;
  $("#lCount").textContent = `${n} / ${max}`;
  let html = V.players.map((p) => `<li class="${online.includes(p.id) ? "" : "off"}">${avatar(p.id)}<span>${esc(p.name)}${p.id === you ? " (tu)" : ""}</span><span class="tag">${p.id === V.host ? "gazdă" : online.includes(p.id) ? "" : "offline"}</span></li>`).join("");
  for (let i = n; i < max; i++) html += `<li class="empty"><span class="av" style="background:var(--s3)"></span>Aștept un jucător…</li>`;
  $("#lPlayers").innerHTML = html;
  const host = isHost();
  $("#lHost").hidden = !host; $("#lGuest").hidden = host;
  const modeTxt = V.cfg.mode === "easy" ? "Easy: alegi piesa dintr-o listă de 5." : "Hard: scrii numele piesei.";
  if (host) {
    $("#lNums").innerHTML = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => `<button data-n="${k}" class="${k === max ? "on" : ""}" ${k < n ? "disabled" : ""}>${k}</button>`).join("");
    for (const b of document.querySelectorAll("#lModes .pill")) b.classList.toggle("on", b.dataset.mode === V.cfg.mode);
    $("#lModeHint").textContent = modeTxt;
    const ready = n === max && n >= 2;
    $("#lStart").disabled = !ready;
    $("#lStart").textContent = ready ? "Începe jocul" : `Aștept jucătorii (${n}/${max})`;
  } else {
    $("#lGuest").innerHTML = `<b>Aștept gazda să pornească</b><span class="hint">${max} jucători · ${V.cfg.mode === "easy" ? "Easy" : "Hard"} · ${esc(modeTxt)}</span>`;
  }
}
$("#lNums").addEventListener("click", (e) => { const b = e.target.closest("button[data-n]"); if (b && !b.disabled) send({ type: "config", max: +b.dataset.n, mode: V.cfg.mode }); });
$("#lModes").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) send({ type: "config", max: V.cfg.max, mode: b.dataset.mode }); });
$("#lStart").onclick = () => send({ type: "start", salt: crypto.getRandomValues(new Uint32Array(1))[0] });
$("#lCopy").onclick = async () => {
  const v = $("#lLink").value;
  try { await navigator.clipboard.writeText(v); } catch { $("#lLink").select(); try { document.execCommand("copy"); } catch {} }
  $("#lCopy").textContent = "Copiat ✓"; setTimeout(() => ($("#lCopy").textContent = "Copiază"), 1500);
};
$("#lLeave").onclick = () => leave();
$("#endLeave").onclick = () => leave();

// ── piese (setup) ───────────────────────────────────────────────────────────
const songs = Array.from({ length: 5 }, () => ({ url: "", s: null, id: null, t: "", d: 0, st: "empty", err: "", edited: false }));
let rowsBuilt = false;
function parseLink(url) {
  url = url.trim(); let m;
  if ((m = url.match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/))) return { s: "sp", id: m[1] };
  if (/^[\w-]{11}$/.test(url)) return { s: "yt", id: url };
  if ((m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/|\/v\/)([\w-]{11})/))) return { s: "yt", id: m[1] };
  if (/spotify\.link|spoti\.fi/.test(url)) return { err: "Pune linkul complet (open.spotify.com/track/…)" };
  if (/spotify\.com\/(album|playlist|artist|episode|show)/.test(url)) return { err: "Pune linkul unei piese, nu album/playlist" };
  return { err: "Link YouTube sau Spotify invalid" };
}
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[([][^)\]]*(official|video|audio|lyric|visuali[sz]er|\bhd\b|\bhq\b|4k|remaster|videoclip|clip|music video|live)[^)\]]*[)\]]/gi, "")
    .replace(/\s+[|•].*$/, "").replace(/\s{2,}/g, " ").trim();
}
function buildRows() {
  if (V.mySongs && songs.every((s) => s.st === "empty")) {
    V.mySongs.forEach((m, i) => Object.assign(songs[i], { url: m.s === "yt" ? "https://youtu.be/" + m.id : "https://open.spotify.com/track/" + m.id, s: m.s, id: m.id, t: m.t, d: m.d, st: "ok", edited: true }));
  }
  $("#songRows").innerHTML = songs.map((s, i) => `
    <div class="srow" data-i="${i}"><span class="n">${i + 1}</span><div class="f">
      <input type="text" class="sl" id="sl${i}" placeholder="Link YouTube sau Spotify" autocomplete="off">
      <input type="text" class="stt" id="st${i}" placeholder="Artist – Titlu piesă" maxlength="100" autocomplete="off">
      <span class="sstat"></span></div></div>`).join("");
  document.querySelectorAll(".srow").forEach((row) => {
    const i = +row.dataset.i, s = songs[i], li = row.querySelector(".sl"), ti = row.querySelector(".stt");
    li.value = s.url; ti.value = s.t;
    const onLink = () => { if (li.value.trim() !== s.url) setLink(i, li.value.trim()); };
    li.addEventListener("change", onLink);
    li.addEventListener("paste", () => setTimeout(onLink, 30));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") { onLink(); ti.focus(); } });
    ti.addEventListener("input", () => { s.t = ti.value; s.edited = true; });
  });
  rowsBuilt = true;
}
function paintRows() {
  const ready = V.players.find((p) => p.id === you)?.ready;
  document.querySelectorAll(".srow").forEach((row) => {
    const s = songs[+row.dataset.i], st = row.querySelector(".sstat"), ti = row.querySelector(".stt");
    row.querySelector(".sl").disabled = ti.disabled = !!ready;
    if (document.activeElement !== ti && ti.value !== s.t) ti.value = s.t;
    st.className = "sstat";
    if (s.st === "load") { st.classList.add("load"); st.textContent = "Verific linkul…"; }
    else if (s.st === "bad") { st.classList.add("bad"); st.textContent = "✕ " + s.err; }
    else if (s.st === "ok") { st.classList.add("ok"); st.textContent = "✓ " + (s.s === "yt" ? "YouTube" + (s.d ? " · " + Math.floor(s.d / 60) + ":" + String(s.d % 60).padStart(2, "0") : "") : "Spotify") + (s.t ? "" : " · scrie titlul"); }
    else st.textContent = "";
  });
}
async function setLink(i, url) {
  const s = songs[i];
  Object.assign(s, { url, s: null, id: null, d: 0, err: "" });
  if (!s.edited) s.t = "";
  if (!url) { s.st = "empty"; return paintRows(); }
  const p = parseLink(url);
  if (p.err) { s.st = "bad"; s.err = p.err; return paintRows(); }
  s.s = p.s; s.id = p.id; s.st = "load"; paintRows();
  const myId = s.id;
  if (p.s === "yt") {
    const r = await checkYT(p.id);
    if (s.id !== myId) return;
    if (r.ok) { s.d = Math.round(r.d); if (!s.edited || !s.t) { s.t = cleanTitle(r.t); s.edited = false; } s.st = "ok"; }
    else if (r.code === 101 || r.code === 150) { s.st = "bad"; s.err = "Clipul ăsta nu poate fi redat în alte site-uri. Pune altă variantă (lyrics / audio)."; }
    else if (r.code === 100 || r.code === 2) { s.st = "bad"; s.err = "Video inexistent sau privat"; }
    else { s.st = "ok"; if (!s.t) { const t = await titleFromNoembed(url); if (t && s.id === myId && !s.edited) s.t = cleanTitle(t); } }
  } else {
    const t = await titleSpotify(p.id);
    if (s.id !== myId) return;
    if (t && (!s.edited || !s.t)) { s.t = t; s.edited = false; }
    s.st = "ok";
  }
  paintRows();
}
async function titleSpotify(id) {
  const u = "https://open.spotify.com/track/" + id;
  for (const api of ["https://open.spotify.com/oembed?url=", "https://noembed.com/embed?url="]) {
    try {
      const r = await fetch(api + encodeURIComponent(u)); if (!r.ok) continue;
      const j = await r.json(); if (!j.title) continue;
      const artist = j.author_name && !/spotify/i.test(j.author_name) ? j.author_name : "";
      return artist && !j.title.includes(artist) ? `${artist} - ${j.title}` : j.title;
    } catch {}
  }
  return "";
}
async function titleFromNoembed(url) {
  try { const r = await fetch("https://noembed.com/embed?url=" + encodeURIComponent(url)); const j = await r.json(); return j.title || ""; } catch { return ""; }
}
function renderSetup() {
  if (!rowsBuilt) buildRows();
  paintRows();
  const ready = V.players.find((p) => p.id === you)?.ready;
  $("#readyBtn").hidden = !!ready; $("#editBtn").hidden = !ready;
  $("#readyChips").innerHTML = V.players.map((p) => `<span class="chip ${p.ready ? "ok" : ""} ${p.id === you ? "me" : ""}">${p.ready ? "✓" : "…"} ${esc(p.name)}</span>`).join("");
}
$("#readyBtn").onclick = () => {
  document.querySelectorAll(".srow").forEach((row) => { const i = +row.dataset.i, li = row.querySelector(".sl"); if (li.value.trim() !== songs[i].url) setLink(i, li.value.trim()); });
  const err = (m) => ($("#setupErr").textContent = m);
  if (songs.some((s) => s.st === "load")) return err("Aștept puțin, încă verific linkurile…");
  const missing = songs.filter((s) => s.st !== "ok").length;
  if (missing) return err(`Mai ai nevoie de ${missing} ${missing === 1 ? "piesă validă" : "piese valide"}.`);
  if (songs.some((s) => !s.t.trim())) return err("Fiecare piesă are nevoie de titlu (Artist – Titlu).");
  if (new Set(songs.map((s) => s.s + s.id)).size !== 5) return err("Ai pus aceeași piesă de două ori.");
  err("");
  send({ type: "songs", songs: songs.map((s) => ({ s: s.s, id: s.id, t: s.t.trim(), d: s.d || 0 })) });
};
$("#editBtn").onclick = () => send({ type: "unready" });

// verificarea linkurilor YouTube cu un player ascuns
let checker = null, checkerReady = false, checkQ = [], checking = null;
function ensureChecker() {
  if (checker || !window.__yt) return;
  checker = new YT.Player("checkerPlayer", { width: 240, height: 160, playerVars: { mute: 1, controls: 0, playsinline: 1, origin: location.origin },
    events: { onReady: () => { checkerReady = true; checker.mute(); pump(); }, onStateChange: onCheckState, onError: (e) => finishCheck({ ok: false, code: e.data }) } });
}
function checkYT(id) {
  return new Promise((res) => { checkQ.push({ id, res }); ensureChecker(); pump(); });
}
function pump() {
  if (checking || !checkerReady || !checkQ.length) return;
  checking = checkQ.shift();
  checking.timer = setTimeout(() => finishCheck({ ok: false, code: "timeout" }), 12000);
  checker.mute(); checker.loadVideoById(checking.id);
}
function onCheckState(e) {
  if (!checking || e.data !== 1) return;
  const job = checking;
  let n = 12;
  const read = () => {
    if (checking !== job) return;
    const d = checker.getDuration(), t = checker.getVideoData()?.title;
    if ((d > 0 && t) || --n <= 0) finishCheck({ ok: true, d, t: t || "" }); else setTimeout(read, 150);
  };
  read();
}
function finishCheck(r) {
  const job = checking; if (!job) return;
  clearTimeout(job.timer); checking = null;
  try { checker.stopVideo(); } catch {}
  job.res(r); setTimeout(pump, 120);
}
window.addEventListener("yt-ready", () => { if (V?.phase === "setup") ensureChecker(); ensureYT(); });

// ── media: YouTube + Spotify ────────────────────────────────────────────────
const media = { yt: null, ytReady: false, ytQ: [], sp: null, spCreating: false, cur: null, timer: 0, timer2: 0, raf: 0, want: null, playing: false };
let volume = 85;
function ensureYT(cb) {
  if (cb) media.ytQ.push(cb);
  if (media.ytReady) { const q = media.ytQ.splice(0); q.forEach((f) => f()); return; }
  if (media.yt || !window.__yt || $("#s-round").hidden) return;
  media.yt = new YT.Player("ytPlayer", { width: "100%", height: "100%",
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, origin: location.origin },
    events: { onReady: () => { media.ytReady = true; media.yt.setVolume(volume); ensureYT(); }, onError: (e) => onMediaError(e.data) } });
}
function ensureSP(id, cb) {
  if (media.sp) return cb && cb();
  if (!window.__sp) { window.addEventListener("sp-ready", () => ensureSP(id, cb), { once: true }); return; }
  if (media.spCreating) { setTimeout(() => ensureSP(id, cb), 300); return; }
  media.spCreating = true;
  window.__sp.createController($("#spPlayer"), { uri: "spotify:track:" + id, width: "100%", height: 152 }, (ctl) => {
    media.sp = ctl; media.spCreating = false;
    ctl.addListener("playback_update", onSpUpdate);
    cb && cb(true);
  });
}
function startOf(d, f) {
  let st = d * f;
  if (st + START_TAIL > d) st = Math.max(0, d - START_TAIL);
  return Math.floor(st * 10) / 10;
}
function prepareMedia(r) {
  stopSnippet();
  media.cur = { src: r.src, id: r.id, f: r.f, d: r.d || 0, spDur: 0, spStarted: false, start: null };
  $("#media").classList.remove("open", "yt", "sp"); $("#media").classList.add(r.src);
  $("#ytWrap").hidden = r.src !== "yt"; $("#spWrap").hidden = r.src !== "sp";
  setCover(true, "Piesa e ascunsă");
  if (r.src === "yt") {
    try { media.sp?.pause(); } catch {}
    ensureYT(() => { if (media.cur?.id !== r.id) return; const st = media.cur.d ? startOf(media.cur.d, r.f) : 0; media.yt.cueVideoById({ videoId: r.id, startSeconds: st }); });
  } else {
    try { media.yt?.stopVideo(); } catch {}
    ensureSP(r.id, (fresh) => { if (!fresh && media.cur?.id === r.id) media.sp.loadUri("spotify:track:" + r.id); });
  }
}
function setCover(on, txt) {
  $("#cover").hidden = !on;
  if (txt) $("#coverTxt").textContent = txt;
}
function setPlaying(on) {
  media.playing = on;
  $("#playBtn").classList.toggle("on", on);
  $("#cover").classList.toggle("on", on);
  $("#playIco").innerHTML = on ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M6 3.5v17a1 1 0 0 0 1.5.86l14-8.5a1 1 0 0 0 0-1.72l-14-8.5A1 1 0 0 0 6 3.5z"/>';
  if (!on) { cancelAnimationFrame(media.raf); $("#barProg").style.width = "0"; }
}
function animate(len, already = 0) {
  const t0 = performance.now() - already * 1000;
  cancelAnimationFrame(media.raf);
  const step = () => {
    const el = Math.min(len, (performance.now() - t0) / 1000);
    $("#barProg").style.width = pos(el) + "%";
    if (el < len && media.playing) media.raf = requestAnimationFrame(step);
  };
  step();
}
function stopSnippet() {
  clearInterval(media.timer); clearTimeout(media.timer2); media.want = null;
  if (media.playing && V?.phase !== "reveal") {
    try { if (media.cur?.src === "yt") { media.yt.mute(); media.yt.pauseVideo(); } else media.sp?.pause(); } catch {}
  }
  setPlaying(false);
}
function playSnippet(len) {
  const c = media.cur; if (!c) return;
  if (media.playing) { stopSnippet(); return; }
  if (c.src === "yt") playYT(len); else playSP(len);
}
function playYT(len) {
  const p = media.yt, c = media.cur;
  if (!media.ytReady) { toast("Playerul se încarcă, mai apasă o dată."); ensureYT(); return; }
  const d = c.d || p.getDuration() || 0;
  setPlaying(true);
  if (!d) { // durata necunoscută: pornim pe mut ca s-o aflăm
    p.mute(); p.playVideo();
    let n = 0;
    media.timer = setInterval(() => {
      const dd = p.getDuration();
      if (dd > 0 || ++n > 200) { clearInterval(media.timer); p.pauseVideo(); setPlaying(false); if (dd > 0) { c.d = dd; playYT(len); } else toast("Nu pot porni piesa."); }
    }, 25);
    return;
  }
  const start = startOf(d, c.f); c.start = start;
  const before = p.getCurrentTime(); const tCmd = performance.now();
  p.mute(); p.seekTo(start, true); p.playVideo();
  let began = false, t0 = 0;
  media.timer = setInterval(() => {
    const st = p.getPlayerState(), t = p.getCurrentTime();
    if (!began) {
      const fresh = Math.abs(t - before) > 0.05 || performance.now() - tCmd > 450;
      if (st === 1 && fresh && t >= start - 0.4 && t < start + 1.5) {
        began = true; p.unMute(); p.setVolume(volume); t0 = performance.now(); animate(len);
      }
      return;
    }
    const wall = (performance.now() - t0) / 1000;
    if (len < 2 ? wall >= len : t - start >= len || wall >= len + 3) { p.mute(); p.pauseVideo(); stopSnippet(); }
  }, 12);
}
function playSP(len) {
  const ctl = media.sp, c = media.cur;
  if (!ctl) { toast("Playerul Spotify se încarcă, mai apasă o dată."); return; }
  setPlaying(true);
  media.want = { len, seeked: false, started: false };
  if (c.spDur > 0 && c.spStarted) { c.start = startOf(c.spDur / 1000, c.f); media.want.seeked = true; ctl.seek(c.start); ctl.resume(); }
  else { c.spStarted = true; ctl.play(); }
  media.timer2 = setTimeout(() => { if (media.want && !media.want.started) { stopSnippet(); toast("Spotify nu pornește. Apasă play în player o dată, apoi încearcă iar."); setCover(false); } }, 7000);
}
function onSpUpdate(e) {
  const d = e?.data || {}, c = media.cur;
  if (!c || c.src !== "sp") return;
  if (d.duration > 0) c.spDur = d.duration;
  const w = media.want; if (!w) return;
  if (!w.seeked) {
    if (c.spDur > 0 && !d.isPaused) { c.start = startOf(c.spDur / 1000, c.f); w.seeked = true; media.sp.seek(c.start); }
    return;
  }
  if (!w.started && !d.isPaused && !d.isBuffering && Math.abs(d.position / 1000 - c.start) < 1.6) {
    w.started = true; clearTimeout(media.timer2);
    const el = Math.max(0, d.position / 1000 - c.start);
    animate(w.len, el);
    media.timer2 = setTimeout(() => { try { media.sp.pause(); } catch {} stopSnippet(); }, Math.max(0, (w.len - el) * 1000));
  }
}
function revealPlay() {
  stopSnippet(); setCover(false);
  $("#media").classList.add("open");
  const c = media.cur; if (!c) return;
  if (c.src === "yt" && media.ytReady) {
    const d = c.d || media.yt.getDuration() || 0;
    media.yt.unMute(); media.yt.setVolume(volume); media.yt.seekTo(d ? startOf(d, c.f) : 0, true); media.yt.playVideo();
  } else if (c.src === "sp" && media.sp) {
    try { if (c.spDur > 0 && c.spStarted) { media.sp.seek(startOf(c.spDur / 1000, c.f)); media.sp.resume(); } else { c.spStarted = true; media.sp.play(); } } catch {}
  }
}
function onMediaError(code) {
  if (V?.phase === "reveal") return;
  stopSnippet();
  setCover(true, code === 101 || code === 150 ? "Piesa nu poate fi redată aici. Apasă „Renunț”." : "Eroare la redare. Apasă „Renunț”.");
}
$("#vol").addEventListener("input", (e) => { volume = +e.target.value; try { if (media.ytReady && !media.yt.isMuted()) media.yt.setVolume(volume); } catch {} });

// ── rundă ───────────────────────────────────────────────────────────────────
let lastRoundKey = "", lastStage = -1, revealed = false;
function renderRound() {
  const r = V.round, me = V.me, reveal = V.phase === "reveal", st = V.stages, LAST = st.length - 1;
  const key = V.ri + "|" + r.src + r.id + "|" + V.total + "|" + r.f;
  if (key !== lastRoundKey) {
    lastRoundKey = key; lastStage = me ? me.stage : -1; revealed = false;
    $("#guessInput").value = "";
    prepareMedia(r);
  }
  ensureYT();
  $("#rRoom").textContent = "Camera " + room;
  $("#rOwner").textContent = r.isOwner ? "Piesa ta" : "Piesa lui " + nameOf(r.owner);
  $("#rCount").textContent = `${V.ri + 1} / ${V.total}`;
  for (const p of document.querySelectorAll("#rModes .pill")) p.classList.toggle("on", p.classList.contains(V.cfg.mode));

  const stage = me ? me.stage : LAST;
  const len = st[stage];
  $("#barUnl").style.width = pos(len) + "%";
  $("#bar").querySelectorAll(".tk").forEach((t) => t.remove());
  st.slice(0, -1).forEach((s) => { const t = document.createElement("div"); t.className = "tk"; t.style.left = pos(s) + "%"; $("#bar").append(t); });
  $("#barMk").textContent = fmtS(len); $("#barMk").style.left = Math.min(96, Math.max(4, pos(len))) + "%";
  $("#timeLbl").textContent = fmtS(len);
  $("#playBtn").disabled = reveal;
  for (const el of [$(".playrow"), $("#bar"), $(".mk"), $("#rModes")]) el.hidden = reveal;

  const guessing = !reveal && me && !me.done;
  $("#gHard").hidden = !(guessing && V.cfg.mode === "hard");
  $("#gEasy").hidden = !(guessing && V.cfg.mode === "easy");
  $("#gGive").hidden = !guessing;
  $("#skipBtn").disabled = $("#skipBtn2").disabled = false;
  for (const b of [$("#skipBtn"), $("#skipBtn2")]) b.lastChild.textContent = stage >= LAST ? "Renunț" : "Skip";
  if (guessing && V.cfg.mode === "easy") {
    $("#opts").innerHTML = me.opts.map((o) => `<button class="opt ${me.wrong.includes(o.k) ? "wrong" : ""}" data-k="${esc(o.k)}" ${me.wrong.includes(o.k) ? "disabled" : ""}>${esc(o.t)}</button>`).join("");
  }
  $("#myGuesses").innerHTML = me && !reveal ? me.guesses.filter((g) => !g.ok).map((g) => `<div><span class="x">✕ ${esc(g.t)}</span><span>la ${fmtS(st[g.st])}</span></div>`).join("") : "";

  // auto-play când se deblochează o secvență mai lungă (skip sau răspuns greșit)
  if (me && !reveal && !me.done && me.stage > lastStage && lastStage >= 0) { lastStage = me.stage; setTimeout(() => { stopSnippet(); playSnippet(st[me.stage]); }, 60); }
  if (me) lastStage = me.stage;

  const waitingFor = V.others.filter((o) => !o.done).map((o) => nameOf(o.id));
  $("#doneBox").hidden = !(me && me.done && !reveal);
  if (me && me.done && !reveal) {
    $("#doneBox").className = "note" + (me.ok ? " win" : "");
    $("#doneBox").innerHTML = (me.ok ? `<b>Ai ghicit! +${me.pts}</b>` : `<b>Nu ai ghicit</b>`) + `<span class="hint">Aștept: ${esc(waitingFor.join(", ") || "…")}</span>`;
  }

  $("#ownerBox").hidden = !(r.isOwner && !reveal);
  if (r.isOwner && !reveal) {
    $("#ownerBox").innerHTML = `<div class="hint">Piesa ta, ceilalți ghicesc acum:</div><div class="t">${esc(r.title)}</div>` +
      `<div class="res">${V.others.map((o) => resultRow(o, true)).join("")}</div>`;
  }

  $("#revealHead").hidden = !reveal; $("#revealBox").hidden = !reveal;
  if (reveal) {
    if (!revealed) { revealed = true; revealPlay(); }
    $("#rvTitle").textContent = r.title;
    $("#rvOwner").textContent = r.isOwner ? "Piesa ta" : "Piesa aleasă de " + nameOf(r.owner);
    $("#rvRes").innerHTML = V.others.map((o) => resultRow(o, r.isOwner)).join("");
    const iNext = V.next.includes(you);
    $("#nextBtn").disabled = iNext;
    $("#nextBtn").textContent = (V.ri + 1 >= V.total ? "Vezi clasamentul" : "Următoarea") + ` (${V.next.length}/${V.players.length})`;
  }
  $("#forceBtn").hidden = !isHost();
  $("#forceBtn").textContent = reveal ? "Treci mai departe fără ceilalți" : "Arată răspunsul acum (pentru toți)";

  $("#rScoreHint").textContent = "puncte";
  $("#who").innerHTML = V.players.map((p) => {
    const o = V.others.find((x) => x.id === p.id);
    const cls = p.id === r.owner ? "" : o?.done ? (o.ok ? "ok" : "bad") : "";
    const tag = p.id === r.owner ? "♪" : o?.done ? (o.ok ? "✓" : "✕") : "…";
    return `<span class="chip ${cls} ${p.id === you ? "me" : ""} ${online.includes(p.id) ? "" : "off"}">${tag} ${esc(p.name)} · ${p.score}</span>`;
  }).join("");
}
function resultRow(o, canAccept) {
  const st = V.stages;
  const right = o.ok ? `<span class="s v">✓ ${fmtS(st[o.stage])} · +${o.pts}</span>` : o.done ? `<span class="s x">✕</span>` : `<span class="s">ghicește · ${fmtS(st[o.stage])}</span>`;
  let gq = "";
  if (o.guesses && o.guesses.length) {
    gq = `<div class="gq">${o.guesses.map((g, gi) => `<span>${g.ok ? "✓" : "✕"} ${esc(g.t)}</span>${!g.ok && !o.ok && canAccept ? `<button class="acc" data-pid="${esc(o.id)}" data-gi="${gi}">E corect</button>` : ""}`).join("")}</div>`;
  }
  return `<div class="r">${avatar(o.id)}<span>${esc(nameOf(o.id))}</span>${right}</div>${gq}`;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest(".acc"); if (a) send({ type: "override", pid: a.dataset.pid, gi: +a.dataset.gi });
  const o = e.target.closest(".opt"); if (o && !o.disabled) send({ type: "pick", key: o.dataset.k });
});
$("#playBtn").onclick = () => { if (!V?.round) return; const me = V.me; playSnippet(V.stages[me ? me.stage : V.stages.length - 1]); };
$("#skipBtn").onclick = $("#skipBtn2").onclick = () => send({ type: "skip" });
$("#giveBtn").onclick = () => send({ type: "giveup" });
$("#guessForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("#guessInput").value.trim(); if (!t) return;
  send({ type: "guess", text: t }); $("#guessInput").value = "";
});
$("#nextBtn").onclick = () => send({ type: "next" });
$("#forceBtn").onclick = () => send({ type: "force" });
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || $("#s-round").hidden || /INPUT|BUTTON/.test(document.activeElement?.tagName || "")) return;
  e.preventDefault(); $("#playBtn").click();
});

// ── final ───────────────────────────────────────────────────────────────────
function renderEnd() {
  const ranked = [...V.players].sort((a, b) => b.score - a.score);
  const top = ranked[0], tie = ranked.length > 1 && ranked[1].score === top.score;
  $("#winT").innerHTML = tie ? "Egalitate!" : `<span>${esc(top.name)}</span> câștigă`;
  $("#winSub").textContent = `${V.total} piese ghicite · ${V.cfg.mode === "easy" ? "Easy" : "Hard"}`;
  $("#board").innerHTML = ranked.map((p, i) => `<div class="r ${i === 0 ? "first" : ""}"><span class="pl">${i + 1}</span>${avatar(p.id)}<span>${esc(p.name)}${p.id === you ? " (tu)" : ""}</span><span class="sc">${p.score}</span></div>`).join("");
  $("#endHost").hidden = !isHost();
  $("#endGuest").textContent = isHost() ? "" : "Gazda poate porni o revanșă sau un joc cu piese noi.";
  $("#recap").innerHTML = (V.hist || []).map((h) => {
    const got = Object.entries(h.res).filter(([, x]) => x.ok).map(([id, x]) => `${nameOf(id)} (${fmtS(V.stages[x.st])})`);
    return `<div><span>${esc(h.t)}<small>de la ${esc(nameOf(h.o))}</small></span><span class="g">${got.length ? "✓ " + esc(got.join(", ")) : "nimeni"}</span></div>`;
  }).join("");
}
$("#rematchBtn").onclick = () => send({ type: "rematch", salt: crypto.getRandomValues(new Uint32Array(1))[0] });
$("#newSongsBtn").onclick = () => { songs.forEach((s) => Object.assign(s, { url: "", s: null, id: null, t: "", d: 0, st: "empty", err: "", edited: false })); send({ type: "newsongs" }); };

// când revii în pagină (ex. după ce ai trimis codul pe WhatsApp), refacem conexiunea
document.addEventListener("visibilitychange", () => {
  if (document.hidden || leaving || !net.client) return;
  if (!net.client.connected) { try { net.client.reconnect(); } catch {} }
  else if (net.mode === "guest" && V) pub(TOPIC(room) + "/h", { type: "hb", pid: playerId(), ver: -2 }, 0);
});

// ── pornire ─────────────────────────────────────────────────────────────────
(async function boot() {
  if (!pw || (await sha256(pw)) !== PW_HASH) { show("gate"); setTimeout(() => $("#gatePw").focus(), 50); return; }
  goHome();
})();
