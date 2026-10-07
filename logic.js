/**
 * Ghicește Piesa — regulile jocului. Rulează în browserul gazdei, care ține starea camerei.
 *
 * Două moduri (cfg.src):
 *   "mine" — fiecare pune 5 piese, ceilalți le ghicesc (lobby → setup → play/reveal → end);
 *   "pl"   — gazda încarcă un playlist Spotify, toți ghicesc aceeași piesă aleasă la
 *            întâmplare (lobby → play/reveal → end).
 *
 * Pur și determinist: fără Date.now(), fără Math.random(). Aleatorul vine dintr-un
 * seed ținut în stare (amestecat cu un "salt" trimis de client la start).
 */

export const meta = { game: "Ghicește Piesa", minPlayers: 1, maxPlayers: 24 };

const PW_HASH = 1429083844; // hash-ul parolei, nu parola în clar
const SONGS = 5;
const MAX_PLAYERS = 10;
const ROUND_CHOICES = [5, 10, 15, 20, 30];
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

function cleanCover(c) {
  const v = String(c ?? "");
  return /^https:\/\/[^\s"'<>]{1,300}$/.test(v) ? v : "";
}

function cleanSong(s) {
  if (!s || typeof s !== "object") return null;
  const src = s.s === "sp" ? "sp" : s.s === "yt" ? "yt" : null;
  if (!src) return null;
  const id = String(s.id ?? "");
  if (src === "yt" && !/^[\w-]{11}$/.test(id)) return null;
  if (src === "sp" && !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  const t = String(s.t ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!t) return null;
  const d = Math.max(0, Math.min(36000, Math.round(Number(s.d) || 0)));
  const isrc = /^[A-Za-z0-9]{8,15}$/.test(String(s.isrc ?? "")) ? String(s.isrc).toUpperCase() : "";
  const pv = /^https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9]{10,80}$/.test(String(s.pv ?? "")) ? String(s.pv) : "";
  return { s: src, id, t, d, c: cleanCover(s.c), isrc, pv };
}

function cleanSongs(list) {
  if (!Array.isArray(list) || list.length !== SONGS) return null;
  const out = [];
  const seen = {};
  for (const raw of list) {
    const s = cleanSong(raw);
    if (!s || seen[s.s + s.id]) return null;
    seen[s.s + s.id] = true;
    out.push(s);
  }
  return out;
}

function cleanPool(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = {};
  for (const raw of list.slice(0, 400)) {
    const s = cleanSong(raw);
    if (!s || s.s !== "sp" || seen[s.id]) continue;
    seen[s.id] = true;
    out.push(s);
  }
  return out.length >= SONGS ? out : null;
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

// ── piese și runde ──────────────────────────────────────────────────────────

const keyOfRound = (s, r) => (r.o ? s.order.indexOf(r.o) + "-" + r.i : "p" + r.p);

function songByKey(s, key) {
  const k = String(key);
  if (k[0] === "p") {
    const song = s.pool[Number(k.slice(1))];
    return song ? { owner: null, song } : null;
  }
  const [oi, i] = k.split("-").map(Number);
  const owner = s.order[oi];
  const p = owner ? s.players[owner] : null;
  const song = p && p.songs ? p.songs[i] : null;
  return song ? { owner, song } : null;
}

const songOfRound = (s, r) => (r.o ? s.players[r.o].songs[r.i] : s.pool[r.p]);

function newCur(s) {
  const r = s.rounds[s.ri];
  const rand = makeRand(s.seed);
  const correct = keyOfRound(s, r);
  const gs = {};
  for (const pid of s.order) {
    if (pid === r.o) continue;
    let opts = null;
    if (s.cfg.mode === "easy") {
      const pool = [];
      if (s.cfg.src === "pl") {
        for (let i = 0; i < s.pool.length; i++) if ("p" + i !== correct) pool.push("p" + i);
      } else {
        for (const oid of s.order) {
          if (oid === pid) continue;
          for (let i = 0; i < SONGS; i++) {
            const k = s.order.indexOf(oid) + "-" + i;
            if (k !== correct) pool.push(k);
          }
        }
      }
      opts = shuffle(shuffle(pool, rand).slice(0, 4).concat([correct]), rand);
    }
    gs[pid] = { stage: 0, done: false, ok: false, pts: 0, rank: 0, guesses: [], wrong: [], opts };
  }
  s.seed = rand.seed;
  s.cur = { gs, next: [], okN: 0 };
}

function buildRounds(s) {
  const rand = makeRand(s.seed);
  const rounds = [];
  const f = () => Math.round((0.42 + rand.next() * 0.16) * 1000) / 1000;
  if (s.cfg.src === "pl") {
    const idx = shuffle(s.pool.map((_, i) => i), rand).slice(0, Math.min(s.cfg.rounds, s.pool.length));
    for (const p of idx) rounds.push({ o: null, i: 0, p, f: f() });
  } else {
    const owners = shuffle(s.order, rand);
    const perm = {};
    for (const o of owners) perm[o] = shuffle([0, 1, 2, 3, 4], rand);
    for (let i = 0; i < SONGS; i++) {
      for (const o of owners) rounds.push({ o, i: perm[o][i], p: -1, f: f() });
    }
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
  for (const [pid, g] of Object.entries(s.cur.gs)) res[pid] = { ok: g.ok, pts: g.pts, st: g.stage, rank: g.rank };
  s.hist.push({ o: r.o, i: r.i, p: r.p, res });
  s.ri += 1;
  if (s.ri >= s.rounds.length) {
    s.phase = "end";
    s.cur = null;
  } else {
    s.phase = "play";
    newCur(s);
  }
}

function markCorrect(s, pid, g, stage) {
  g.done = true;
  g.ok = true;
  g.stage = stage;
  g.pts = POINTS[stage];
  s.cur.okN += 1;
  g.rank = s.cur.okN;
  s.players[pid].score += g.pts;
}

function wrongAnswer(g, text) {
  g.guesses.push({ t: text, ok: false, st: g.stage });
  if (g.stage >= LAST) g.done = true;
  else g.stage += 1;
}

// ── contractul ──────────────────────────────────────────────────────────────

export function setup(players) {
  return {
    v: 2,
    seed: hash((players || []).join(",")),
    host: null,
    phase: "lobby",
    cfg: { max: 2, mode: "easy", src: "mine", rounds: 10 },
    pool: [],
    poolName: "",
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
      if (a.src !== undefined && a.src !== "mine" && a.src !== "pl") return bad("Sursă invalidă");
      if (a.rounds !== undefined && !ROUND_CHOICES.includes(Number(a.rounds))) return bad("Număr de runde invalid");
      return ok();
    }
    case "pool":
      if (!isHost) return bad("Doar gazda alege playlistul");
      if (state.phase !== "lobby") return bad("Jocul a început deja");
      if (!cleanPool(a.tracks)) return bad("Playlistul trebuie să aibă cel puțin 5 piese");
      return ok();
    case "start":
      if (!isHost) return bad("Doar gazda pornește jocul");
      if (state.phase !== "lobby") return bad("Jocul a început deja");
      if (state.order.length < 2 || state.order.length !== state.cfg.max) return bad("Așteaptă să intre toți jucătorii");
      if (state.cfg.src === "pl" && state.pool.length < SONGS) return bad("Încarcă mai întâi un playlist");
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
      const judge = r && (r.o ? r.o === pid : isHost);
      if (!judge) return bad(r && r.o ? "Doar cel care a ales piesa poate accepta un răspuns" : "Doar gazda poate accepta un răspuns");
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
  if (!s.pool) s.pool = [];
  if (!s.cfg.src) s.cfg.src = "mine";
  if (!s.cfg.rounds) s.cfg.rounds = 10;
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
      s.cfg = {
        max: Number(a.max),
        mode: a.mode,
        src: a.src === "pl" ? "pl" : a.src === "mine" ? "mine" : s.cfg.src,
        rounds: a.rounds !== undefined ? Number(a.rounds) : s.cfg.rounds,
      };
      break;
    case "pool":
      s.pool = cleanPool(a.tracks);
      s.poolName = String(a.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      break;
    case "start":
      s.seed = (s.seed ^ hash(String(a.salt ?? ""))) >>> 0;
      for (const id of s.order) s.players[id].ready = false;
      if (s.cfg.src === "pl") buildRounds(s);
      else s.phase = "setup";
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
      const song = songOfRound(s, r);
      const text = String(a.text).trim().slice(0, 80);
      if (matches(text, song.t)) {
        g.guesses.push({ t: text, ok: true, st: g.stage });
        markCorrect(s, pid, g, g.stage);
      } else wrongAnswer(g, text);
      break;
    }
    case "pick": {
      const correct = keyOfRound(s, r);
      const picked = songByKey(s, a.key);
      if (a.key === correct) {
        g.guesses.push({ t: picked.song.t, ok: true, st: g.stage });
        markCorrect(s, pid, g, g.stage);
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
      markCorrect(s, a.pid, tg, gu.st);
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
      s.rounds = [];
      s.ri = 0;
      s.cur = null;
      s.hist = [];
      for (const id of s.order) Object.assign(s.players[id], { ready: false, songs: null, score: 0 });
      s.phase = s.cfg.src === "pl" ? "lobby" : "setup";
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
  const pool = state.pool || [];
  const view = {
    phase: state.phase,
    cfg: { src: "mine", rounds: 10, ...state.cfg },
    host: state.host,
    joined: !!me,
    players: state.order.map((id) => ({
      id,
      name: state.players[id].name,
      score: state.players[id].score,
      ready: state.players[id].ready,
    })),
    pl: { n: pool.length, name: state.poolName || "" },
    total: state.rounds.length,
    ri: state.ri,
    stages: STAGES,
    points: POINTS,
  };
  if (!me) return view;

  if (state.phase === "setup") view.mySongs = me.songs;

  if ((state.phase === "play" || state.phase === "reveal") && state.cur) {
    const r = state.rounds[state.ri];
    const song = songOfRound(state, r);
    const g = state.cur.gs[pid];
    const isOwner = r.o === pid;
    const open = isOwner || state.phase === "reveal";
    const mineOpen = open || (g && g.done);
    view.round = {
      owner: r.o,
      f: r.f,
      src: song.s,
      id: song.id,
      d: song.d,
      isrc: song.isrc || "",
      pv: song.pv || "",
      title: mineOpen ? song.t : null,
      cover: mineOpen ? song.c || "" : "",
      isOwner,
    };
    view.me = g
      ? {
          stage: g.stage,
          done: g.done,
          ok: g.ok,
          pts: g.pts,
          rank: g.rank,
          guesses: g.guesses,
          wrong: g.wrong,
          opts: g.opts
            ? g.opts.map((k) => {
                const x = songByKey(state, k);
                return { k, t: x ? x.song.t : "?", c: x ? x.song.c || "" : "" };
              })
            : null,
        }
      : null;
    view.others = Object.entries(state.cur.gs).map(([id, x]) =>
      open
        ? { id, done: x.done, ok: x.ok, pts: x.pts, rank: x.rank, stage: x.stage, guesses: x.guesses }
        : { id, done: x.done, ok: x.ok, rank: x.rank, stage: x.stage, n: x.guesses.length },
    );
    view.next = state.cur.next;
  }

  if (state.phase === "end") {
    view.hist = state.hist.map((h) => {
      const song = h.o ? state.players[h.o].songs[h.i] : pool[h.p];
      return { o: h.o, t: song.t, c: song.c || "", src: song.s, id: song.id, res: h.res };
    });
  }
  return view;
}
