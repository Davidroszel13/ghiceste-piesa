/**
 * Ghicește Piesa — regulile jocului. Rulează în browserul gazdei, care ține starea camerei.
 *
 * Flux: lobby → setup (fiecare își pune 5 piese) → play / reveal (o piesă pe rundă,
 * toți ceilalți ghicesc în paralel) → end.
 *
 * Pur și determinist: fără Date.now(), fără Math.random(). Aleatorul vine dintr-un
 * seed ținut în stare (amestecat cu un "salt" trimis de client la start).
 */

export const meta = { game: "Ghicește Piesa", minPlayers: 1, maxPlayers: 24 };

const PW_HASH = 1429083844; // hash-ul parolei, nu parola în clar
const SONGS = 5;
const MAX_PLAYERS = 10;
const STAGES = [0.1, 0.5, 1, 2, 4, 7, 11, 15];
const POINTS = [100, 85, 70, 55, 40, 30, 20, 10];
const LAST = STAGES.length - 1;

// ── utilitare ───────────────────────────────────────────────────────────────

const ok = () => ({ ok: true });
const bad = (error) => ({ ok: false, error });
const clone = (x) => JSON.parse(JSON.stringify(x));

function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRand(seed) {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get seed() {
      return s;
    },
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand.next() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function cleanName(n) {
  return String(n ?? "").replace(/\s+/g, " ").trim().slice(0, 18);
}

function cleanSongs(list) {
  if (!Array.isArray(list) || list.length !== SONGS) return null;
  const out = [];
  const seen = {};
  for (const s of list) {
    if (!s || typeof s !== "object") return null;
    const src = s.s === "sp" ? "sp" : s.s === "yt" ? "yt" : null;
    if (!src) return null;
    const id = String(s.id ?? "");
    if (src === "yt" && !/^[\w-]{11}$/.test(id)) return null;
    if (src === "sp" && !/^[A-Za-z0-9]{22}$/.test(id)) return null;
    const t = String(s.t ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!t) return null;
    const d = src === "yt" ? Math.max(0, Math.min(36000, Math.round(Number(s.d) || 0))) : 0;
    if (seen[src + id]) return null;
    seen[src + id] = true;
    out.push({ s: src, id, t, d });
  }
  return out;
}

// ── potrivirea răspunsului scris (Hard) ─────────────────────────────────────

function norm(t) {
  return String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/\b(feat|ft|featuring)\b.*$/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[n];
}

function close(g, c) {
  if (!c) return false;
  if (g === c) return true;
  const ratio = 1 - lev(g, c) / Math.max(g.length, c.length);
  if (c.length >= 3 && ratio >= 0.8) return true;
  if (c.length >= 4 && (" " + g + " ").includes(" " + c + " ")) return true;
  if (g.length >= 4 && c.includes(g) && g.length >= c.length * 0.7) return true;
  return false;
}

function matches(guess, title) {
  const g = norm(guess);
  if (g.length < 2) return false;
  const raw = String(title ?? "").split(/\s+[|/]\s+/)[0];
  const parts = raw.split(/\s+[-–—]\s+/);
  const cands = [norm(raw)];
  if (parts.length >= 2) {
    cands.push(norm(parts.slice(1).join(" "))); // titlul fără artist
    cands.push(norm(parts[parts.length - 1]));
  }
  return cands.some((c) => close(g, c));
}

// ── rundă ───────────────────────────────────────────────────────────────────

const keyOf = (s, owner, i) => s.order.indexOf(owner) + "-" + i;

function songByKey(s, key) {
  const [oi, i] = String(key).split("-").map(Number);
  const owner = s.order[oi];
  const p = owner ? s.players[owner] : null;
  const song = p && p.songs ? p.songs[i] : null;
  return song ? { owner, i, song } : null;
}

function newCur(s) {
  const r = s.rounds[s.ri];
  const rand = makeRand(s.seed);
  const correct = keyOf(s, r.o, r.i);
  const gs = {};
  for (const pid of s.order) {
    if (pid === r.o) continue;
    let opts = null;
    if (s.cfg.mode === "easy") {
      const pool = [];
      for (const oid of s.order) {
        if (oid === pid) continue;
        for (let i = 0; i < SONGS; i++) {
          const k = keyOf(s, oid, i);
          if (k !== correct) pool.push(k);
        }
      }
      opts = shuffle(shuffle(pool, rand).slice(0, 4).concat([correct]), rand);
    }
    gs[pid] = { stage: 0, done: false, ok: false, pts: 0, guesses: [], wrong: [], opts };
  }
  s.seed = rand.seed;
  s.cur = { gs, next: [] };
}

function buildRounds(s) {
  const rand = makeRand(s.seed);
  const owners = shuffle(s.order, rand);
  const perm = {};
  for (const o of owners) perm[o] = shuffle([0, 1, 2, 3, 4], rand);
  const rounds = [];
  for (let i = 0; i < SONGS; i++) {
    for (const o of owners) rounds.push({ o, i: perm[o][i], f: Math.round((0.42 + rand.next() * 0.16) * 1000) / 1000 });
  }
  s.seed = rand.seed;
  s.rounds = rounds;
  s.ri = 0;
  s.hist = [];
  for (const pid of s.order) s.players[pid].score = 0;
  s.phase = "play";
  newCur(s);
}

function maybeReveal(s) {
  if (s.phase === "play" && Object.values(s.cur.gs).every((g) => g.done)) s.phase = "reveal";
}

function advance(s) {
  const r = s.rounds[s.ri];
  const res = {};
  for (const [pid, g] of Object.entries(s.cur.gs)) res[pid] = { ok: g.ok, pts: g.pts, st: g.stage };
  s.hist.push({ o: r.o, i: r.i, res });
  s.ri += 1;
  if (s.ri >= s.rounds.length) {
    s.phase = "end";
    s.cur = null;
  } else {
    s.phase = "play";
    newCur(s);
  }
}

function wrongAnswer(g, text) {
  g.guesses.push({ t: text, ok: false, st: g.stage });
  if (g.stage >= LAST) g.done = true;
  else g.stage += 1;
}

// ── contractul ──────────────────────────────────────────────────────────────

export function setup(players) {
  return {
    v: 1,
    seed: hash((players || []).join(",")),
    host: null,
    phase: "lobby",
    cfg: { max: 2, mode: "easy" },
    players: {},
    order: [],
    rounds: [],
    ri: 0,
    cur: null,
    hist: [],
  };
}

export function validateAction(state, pid, a) {
  if (!a || typeof a !== "object" || typeof a.type !== "string") return bad("acțiune invalidă");
  const me = state.players[pid];

  if (a.type === "hello") {
    if (hash(String(a.pw ?? "")) !== PW_HASH) return bad("Parolă greșită");
    if (!cleanName(a.name)) return bad("Scrie-ți numele");
    if (!me) {
      if (state.phase !== "lobby") return bad("Jocul a început deja în camera asta");
      if (state.order.length >= state.cfg.max) return bad("Camera e plină");
    }
    return ok();
  }
  if (!me) return bad("Intră în joc mai întâi");

  const isHost = state.host === pid;
  const r = state.rounds[state.ri];
  const g = state.cur && state.cur.gs[pid];

  switch (a.type) {
    case "config": {
      if (!isHost) return bad("Doar gazda schimbă setările");
      if (state.phase !== "lobby") return bad("Jocul a început deja");
      const max = Number(a.max);
      if (!Number.isInteger(max) || max < 2 || max > MAX_PLAYERS) return bad("Între 2 și 10 jucători");
      if (max < state.order.length) return bad("Sunt deja mai mulți jucători în cameră");
      if (a.mode !== "easy" && a.mode !== "hard") return bad("Dificultate invalidă");
      return ok();
    }
    case "start":
      if (!isHost) return bad("Doar gazda pornește jocul");
      if (state.phase !== "lobby") return bad("Jocul a început deja");
      if (state.order.length < 2 || state.order.length !== state.cfg.max) return bad("Așteaptă să intre toți jucătorii");
      return ok();
    case "songs":
      if (state.phase !== "setup") return bad("Nu e momentul pentru piese");
      if (!cleanSongs(a.songs)) return bad("Ai nevoie de 5 piese valide, fiecare cu titlu");
      return ok();
    case "unready":
      return state.phase === "setup" ? ok() : bad("Nu e momentul");
    case "skip":
    case "giveup":
      if (state.phase !== "play" || !g) return bad("Nu ghicești acum");
      if (g.done) return bad("Ai terminat runda asta");
      return ok();
    case "guess": {
      if (state.phase !== "play" || !g) return bad("Nu ghicești acum");
      if (g.done) return bad("Ai terminat runda asta");
      if (state.cfg.mode !== "hard") return bad("Pe Easy alegi din listă");
      const t = String(a.text ?? "").trim();
      if (!t || t.length > 80) return bad("Scrie numele piesei");
      return ok();
    }
    case "pick":
      if (state.phase !== "play" || !g) return bad("Nu ghicești acum");
      if (g.done) return bad("Ai terminat runda asta");
      if (state.cfg.mode !== "easy") return bad("Pe Hard scrii numele");
      if (!g.opts || !g.opts.includes(a.key) || g.wrong.includes(a.key)) return bad("Variantă invalidă");
      return ok();
    case "override": {
      if (state.phase !== "play" && state.phase !== "reveal") return bad("Nu e momentul");
      if (!r || r.o !== pid) return bad("Doar cel care a ales piesa poate accepta un răspuns");
      const tg = state.cur.gs[a.pid];
      if (!tg || tg.ok) return bad("Nimic de acceptat");
      const gi = Number(a.gi);
      if (!Number.isInteger(gi) || !tg.guesses[gi] || tg.guesses[gi].ok) return bad("Răspuns invalid");
      return ok();
    }
    case "force":
      if (!isHost) return bad("Doar gazda poate grăbi runda");
      if (state.phase !== "play" && state.phase !== "reveal") return bad("Nu e momentul");
      return ok();
    case "next":
      return state.phase === "reveal" ? ok() : bad("Runda nu s-a terminat");
    case "rematch":
    case "newsongs":
      if (!isHost) return bad("Doar gazda poate porni un joc nou");
      return state.phase === "end" ? ok() : bad("Jocul nu s-a terminat");
    default:
      return bad("acțiune necunoscută");
  }
}

export function applyAction(state, pid, a) {
  const s = clone(state);
  const me = s.players[pid];
  const r = s.rounds[s.ri];
  const g = s.cur && s.cur.gs[pid];

  switch (a.type) {
    case "hello": {
      const name = cleanName(a.name);
      if (!me) {
        s.players[pid] = { name, ready: false, songs: null, score: 0 };
        s.order.push(pid);
        if (!s.host) s.host = pid;
      } else me.name = name;
      break;
    }
    case "config":
      s.cfg = { max: Number(a.max), mode: a.mode };
      break;
    case "start":
      s.seed = (s.seed ^ hash(String(a.salt ?? ""))) >>> 0;
      s.phase = "setup";
      for (const id of s.order) s.players[id].ready = false;
      break;
    case "songs":
      me.songs = cleanSongs(a.songs);
      me.ready = true;
      if (s.order.every((id) => s.players[id].ready)) buildRounds(s);
      break;
    case "unready":
      me.ready = false;
      break;
    case "skip":
      if (g.stage >= LAST) g.done = true;
      else g.stage += 1;
      break;
    case "giveup":
      g.done = true;
      break;
    case "guess": {
      const song = s.players[r.o].songs[r.i];
      const text = String(a.text).trim().slice(0, 80);
      if (matches(text, song.t)) {
        g.guesses.push({ t: text, ok: true, st: g.stage });
        g.done = true;
        g.ok = true;
        g.pts = POINTS[g.stage];
        me.score += g.pts;
      } else wrongAnswer(g, text);
      break;
    }
    case "pick": {
      const correct = keyOf(s, r.o, r.i);
      const picked = songByKey(s, a.key);
      if (a.key === correct) {
        g.guesses.push({ t: picked.song.t, ok: true, st: g.stage });
        g.done = true;
        g.ok = true;
        g.pts = POINTS[g.stage];
        me.score += g.pts;
      } else {
        g.wrong.push(a.key);
        wrongAnswer(g, picked ? picked.song.t : "?");
      }
      break;
    }
    case "override": {
      const tg = s.cur.gs[a.pid];
      const gu = tg.guesses[Number(a.gi)];
      gu.ok = true;
      tg.ok = true;
      tg.done = true;
      tg.pts = POINTS[gu.st];
      tg.stage = gu.st;
      s.players[a.pid].score += tg.pts;
      break;
    }
    case "force":
      if (s.phase === "play") {
        for (const x of Object.values(s.cur.gs)) x.done = true;
      } else advance(s);
      break;
    case "next":
      if (!s.cur.next.includes(pid)) s.cur.next.push(pid);
      if (s.order.every((id) => s.cur.next.includes(id))) advance(s);
      break;
    case "rematch":
      s.seed = (s.seed ^ hash(String(a.salt ?? ""))) >>> 0;
      buildRounds(s);
      break;
    case "newsongs":
      s.phase = "setup";
      s.rounds = [];
      s.ri = 0;
      s.cur = null;
      s.hist = [];
      for (const id of s.order) Object.assign(s.players[id], { ready: false, songs: null, score: 0 });
      break;
  }
  maybeReveal(s);
  return s;
}

export function isGameOver() {
  // Jocul nu se "închide" niciodată la nivel de cameră: finalul e faza "end",
  // ca gazda să poată porni o revanșă în aceeași cameră.
  return { over: false };
}

export function viewFor(state, pid) {
  const me = state.players[pid];
  const view = {
    phase: state.phase,
    cfg: state.cfg,
    host: state.host,
    joined: !!me,
    players: state.order.map((id) => ({
      id,
      name: state.players[id].name,
      score: state.players[id].score,
      ready: state.players[id].ready,
    })),
    total: state.rounds.length,
    ri: state.ri,
    stages: STAGES,
    points: POINTS,
  };
  if (!me) return view;

  if (state.phase === "setup") view.mySongs = me.songs;

  if ((state.phase === "play" || state.phase === "reveal") && state.cur) {
    const r = state.rounds[state.ri];
    const song = state.players[r.o].songs[r.i];
    const isOwner = r.o === pid;
    const open = isOwner || state.phase === "reveal";
    view.round = { owner: r.o, f: r.f, src: song.s, id: song.id, d: song.d, title: open ? song.t : null, isOwner };
    const g = state.cur.gs[pid];
    view.me = g
      ? {
          stage: g.stage,
          done: g.done,
          ok: g.ok,
          pts: g.pts,
          guesses: g.guesses,
          wrong: g.wrong,
          opts: g.opts ? g.opts.map((k) => ({ k, t: (songByKey(state, k) || { song: { t: "?" } }).song.t })) : null,
        }
      : null;
    view.others = Object.entries(state.cur.gs).map(([id, x]) =>
      open
        ? { id, done: x.done, ok: x.ok, pts: x.pts, stage: x.stage, guesses: x.guesses }
        : { id, done: x.done, ok: x.ok, stage: x.stage, n: x.guesses.length },
    );
    view.next = state.cur.next;
  }

  if (state.phase === "end") {
    view.hist = state.hist.map((h) => {
      const song = state.players[h.o].songs[h.i];
      return { o: h.o, t: song.t, src: song.s, id: song.id, res: h.res };
    });
  }
  return view;
}
