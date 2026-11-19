import { firebaseConfig } from "./firebase-config.js";

// Cambia questo numero a ogni aggiornamento: l'app lo usa per avvisare che c'è una versione nuova.
const APP_VERSION = "2026.11.19-b";

/* ---------- state ---------- */
const prefs = loadPrefs();
const S = {
  songs: [], playlists: [],
  view: "library", prevView: "library",
  songId: null, editId: null, playlistId: null,
  play: null,               // {playlistId, index}
  f: { q: "", genre: "", artist: "", type: "", status: "" },
  sort: "title",
  transpose: 0,
  font: prefs.font || 15,
  part: prefs.part || "both",   // lyrics | chords | both
  instr: prefs.instr || "guitar", // guitar | uke | bass
  speed: prefs.speed || 3,
  scrolling: false,
  mode: "loading",          // config | login | loading | ready | error
  pendingSongs: false, pendingPl: false, authError: "", members: [], viewers: [], bandName: "", legacy: null, images: {}, editImages: [], trash: [], status: {}, myNotes: {}, stage: false, metro: null,
  readOnly: false,
  stale: false,
  loaded: { songs: false, playlists: false }
};

function loadPrefs(){ try { return JSON.parse(localStorage.getItem("repertorio-prefs") || "{}"); } catch { return {}; } }
function savePrefs(){ try { localStorage.setItem("repertorio-prefs", JSON.stringify({ font: S.font, speed: S.speed, part: S.part, instr: S.instr })); } catch {} }

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const TYPE_LABEL = { chords: "Accordi", tabs: "Tablatura", both: "Accordi + tab" };
const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", "it", { sensitivity: "base" });
const songById = id => S.songs.find(s => s.id === id);
const plById = id => S.playlists.find(p => p.id === id);
const uniq = arr => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, "it", { sensitivity: "base" }));

function toast(msg){
  const t = document.createElement("div");
  t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------- chords ---------- */
const CHORD_RE = /^\(?[A-G][#b]?(?:maj|min|m|M|dim|aug|sus|add|°|ø|\+|-)?(?:\d+|maj\d*|sus\d*|add\d+|b\d+|#\d+|\+\d*|-\d*|m|dim|aug|\([^)]*\))*(?:\/[A-G][#b]?)?\)?\*?$/;
const IGNORE_RE = /^(\|+|-+|x\d+|\(x\d+\)|N\.?C\.?|%|\/|\.+|:\|\|?|\|\|?:|\d+x)$/i;
const SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FLAT  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
function noteIdx(n){ let i = SHARP.indexOf(n); if (i < 0) i = FLAT.indexOf(n); if (i < 0) i = ({ Cb: 11, Fb: 4, "E#": 5, "B#": 0 })[n] ?? -1; return i; }
function trNote(n, st, flat){ const i = noteIdx(n); if (i < 0) return n; return (flat ? FLAT : SHARP)[((i + st) % 12 + 12) % 12]; }
function trChord(tok, st){
  return tok.replace(/([A-G][#b]?)([^\/()\s]*(?:\([^)]*\))?[^\/\s)]*)(?:\/([A-G][#b]?))?/, (m, r, q, b) => {
    const flat = r.length > 1 && r[1] === "b" || (b && b.length > 1 && b[1] === "b");
    return trNote(r, st, flat) + q + (b ? "/" + trNote(b, st, flat) : "");
  });
}
function isChordLine(line){
  const t = line.trim().split(/\s+/).filter(Boolean);
  if (!t.length) return false;
  let c = 0;
  for (const x of t){ if (CHORD_RE.test(x)) c++; else if (!IGNORE_RE.test(x)) return false; }
  return c > 0;
}
function transposeLine(line, st){
  if (!st) return line;
  let out = ""; const re = /\S+/g; let m;
  while ((m = re.exec(line))){
    let tok = m[0];
    if (CHORD_RE.test(tok)) tok = trChord(tok, st);
    if (out.length < m.index) out += " ".repeat(m.index - out.length); else if (out.length) out += " ";
    out += tok;
  }
  return out;
}
const SECTION_RE = /^\s*(\[[^\]]{1,40}\]|(intro|verse|verso|strofa|chorus|ritornello|rit\.?|bridge|ponte|outro|solo|pre-?chorus|pre-?rit\w*|interlude|coda|riff|finale)\b[^a-z]{0,12}:?)\s*$/i;
const TAB_CHARS = "-0-9hpbrsxtv\\/\\\\~|.()^*=<>\\s";
const TAB_RE = new RegExp("^\\s*[A-Ga-g]?[#b]?\\s*[|:]?[" + TAB_CHARS + "]*-{2,}[" + TAB_CHARS + "]*$");
function isTabLine(l){ return l.trim().length > 4 && TAB_RE.test(l); }
function classify(line){
  if (!line.trim()) return "blank";
  if (isChordLine(line)) return "chord";
  if (isTabLine(line)) return "tab";
  if (SECTION_RE.test(line)) return "sec";
  return "lyric";
}
function collapseBlanks(items){
  const out = [];
  for (const it of items){ if (it[0] === "blank" && (!out.length || out[out.length - 1][0] === "blank")) continue; out.push(it); }
  while (out.length && out[out.length - 1][0] === "blank") out.pop();
  return out;
}
// Analizza un brano: cosa contiene e qual è il testo (solo parole)
function songParts(s){
  const items = cleanContent(s.content).split("\n").map(l => [classify(l), l.replace(/\s+$/, "")]);
  const hasMusic = items.some(x => x[0] === "chord" || x[0] === "tab");
  let lyricItems;
  if (s.lyrics && s.lyrics.trim()) lyricItems = cleanContent(s.lyrics).split("\n").map(l => [!l.trim() ? "blank" : SECTION_RE.test(l) ? "sec" : "lyric", l.trim()]);
  else lyricItems = items.filter(x => x[0] === "lyric" || x[0] === "sec" || x[0] === "blank").map(x => [x[0], x[1].trim()]);
  // togli i titoli di sezione senza parole sotto (es. Intro solo strumentale)
  lyricItems = lyricItems.filter((x, i) => {
    if (x[0] !== "sec") return true;
    let j = i + 1; while (j < lyricItems.length && lyricItems[j][0] === "blank") j++;
    return j < lyricItems.length && lyricItems[j][0] === "lyric";
  });
  lyricItems = collapseBlanks(lyricItems);
  while (lyricItems.length && lyricItems[0][0] === "blank") lyricItems.shift();
  const hasLyrics = lyricItems.some(x => x[0] === "lyric");
  return { items, hasMusic, hasLyrics, lyricItems };
}
function availableParts(s){
  const p = songParts(s); const imgs = (S.images[s.id] || []).length > 0;
  const list = [];
  if (p.hasLyrics) list.push("lyrics");
  if (p.hasMusic || imgs) list.push("chords");
  if (p.hasLyrics && (p.hasMusic || imgs)) list.push("both");
  if (!list.length) list.push("both");
  return { list, parts: p, imgs };
}
const PART_LABEL = { lyrics: "Testo", chords: "Accordi", both: "Testo + accordi" };

// larghezza utile del foglio in pixel e misura di un carattere monospazio (~0.6 em)
function sheetWidth(){ const w = Math.min(window.innerWidth || 400, 860); return Math.max(200, w - 32 - 34); }
const CH_EM = 0.602;
function wrapWords(line, cols){
  const out = [];
  while (line.length > cols){
    let b = line.lastIndexOf(" ", cols);
    if (b < cols * 0.4) b = cols;
    out.push(line.slice(0, b).replace(/\s+$/, ""));
    line = line.slice(b).replace(/^ /, "");
  }
  out.push(line);
  return out;
}
function wrapPair(c, l, cols){
  const out = [];
  while (Math.max(c.length, l.length) > cols){
    let b = l.lastIndexOf(" ", cols);
    if (b < cols * 0.4) b = cols;
    // non spezzare un accordo a metà
    while (b > 0 && c[b] && c[b] !== " " && c[b - 1] && c[b - 1] !== " ") b--;
    if (b <= 0) b = cols;
    out.push(["chord", c.slice(0, b).replace(/\s+$/, "")], ["lyric", l.slice(0, b).replace(/\s+$/, "")]);
    c = c.slice(b); l = l.slice(b);
    if (l[0] === " "){ l = l.slice(1); if (c[0] === " ") c = c.slice(1); }
  }
  out.push(["chord", c], ["lyric", l]);
  return out;
}
function wrapTab(block, cols){
  const max = Math.max(...block.map(x => x.length));
  if (max <= cols) return block.map(x => ["tab", x]);
  const out = [];
  for (let i = 0; i < max; i += cols){
    if (i) out.push(["blank", ""]);
    for (const x of block) out.push(["tab", x.slice(i, i + cols)]);
  }
  return out;
}
// Restituisce {html, font} per la vista "chords" o "both", adattata alla larghezza
function renderMono(parts, st, mode){
  let items = parts.items.map(([t, l]) => [t, t === "chord" ? transposeLine(l, st) : l]);
  if (mode === "chords"){
    items = items.filter(x => x[0] !== "lyric").map(([t, l]) => [t, t === "chord" ? l.replace(/^\s+/, "").replace(/ {4,}/g, "    ") : l]);
    items = collapseBlanks(items);
  }
  const avail = sheetWidth();
  const maxLen = Math.max(1, ...items.map(x => x[1].length));
  const fit = Math.floor(avail / (maxLen * CH_EM) * 2) / 2;
  const font = Math.max(Math.min(S.font, 11), Math.min(S.font, fit));
  const cols = Math.max(20, Math.floor(avail / (font * CH_EM)));
  const out = [];
  for (let i = 0; i < items.length; i++){
    const [t, l] = items[i];
    if (t === "tab"){
      const block = [];
      while (i < items.length && items[i][0] === "tab"){ block.push(items[i][1]); i++; }
      i--; out.push(...wrapTab(block, cols)); continue;
    }
    if (t === "chord" && items[i + 1] && items[i + 1][0] === "lyric"){ out.push(...wrapPair(l, items[i + 1][1], cols)); i++; continue; }
    if (l.length > cols) wrapWords(l, cols).forEach(x => out.push([t, x]));
    else out.push([t, l]);
  }
  const html = out.map(([t, l]) => {
    if (t === "chord") return l.replace(/\S+/g, x => CHORD_RE.test(x) ? `<span class="ch" data-a="chord" data-c="${esc(x.replace(/[()*]/g, ""))}" role="button" tabindex="0">${esc(x)}</span>` : esc(x));
    if (t === "sec") return `<span class="sec">${esc(l)}</span>`;
    return esc(l);
  }).join("\n");
  return { html, font };
}
function renderLyrics(parts){
  return parts.lyricItems.map(([t, l]) => t === "blank" ? `<div class="ly-gap"></div>` : t === "sec" ? `<div class="ly-sec">${esc(l.replace(/^\[|\]$/g, ""))}</div>` : `<div class="ly-line">${esc(l)}</div>`).join("");
}
function partBody(s){
  const { list, parts } = availableParts(s);
  const part = list.includes(S.part) ? S.part : list[list.length - 1];
  const imgs = S.images[s.id] || [];
  const imgHtml = imgs.length && part !== "lyrics" ? `<div class="song-imgs">${imgs.map((im, i) => `<button class="song-img" data-a="view-img" data-idx="${i}" aria-label="Apri immagine ${i + 1} a schermo intero"><img src="${im.data}" alt="Immagine ${i + 1} di ${esc(s.title)}" loading="lazy"></button>`).join("")}</div>` : "";
  if (part === "lyrics"){
    return { part, list, html: `<div class="lyrics" style="font-size:${S.font + 4}px">${renderLyrics(parts)}</div>` };
  }
  const hasText = parts.items.some(x => x[0] !== "blank");
  let sheet = "";
  if (hasText){
    const r = renderMono(parts, S.transpose, part);
    if (r.html.trim()) sheet = `<div class="sheet"><pre id="sheet" style="font-size:${r.font}px">${r.html}</pre></div>`;
  } else if (!imgs.length){
    sheet = `<div class="sheet"><pre id="sheet"><span style="color:var(--muted)">Nessun contenuto. Tocca Modifica per incollare tab o accordi o aggiungere immagini.</span></pre></div>`;
  }
  return { part, list, html: imgHtml + sheet };
}
// compatibilità con il resto del codice
function renderSheet(text, st){ const p = songParts({ content: text }); return { html: renderMono(p, st, "both").html, hasChords: p.items.some(x => x[0] === "chord") }; }
function cleanContent(t){ return String(t || "").replace(/\r\n?/g, "\n").replace(/\[\/?(ch|tab)\]/g, ""); }
function songHasChords(s){ return cleanContent(s.content).split("\n").some(isChordLine); }


/* ---------- diagrammi accordi ---------- */
// Corde dalla 6ª (Mi basso) alla 1ª (Mi cantino). -1 = non suonare, 0 = a vuoto.
const OPEN_SHAPES = {
  "C": [-1,3,2,0,1,0], "C7": [-1,3,2,3,1,0], "Cmaj7": [-1,3,2,0,0,0], "Cadd9": [-1,3,2,0,3,0], "C/G": [3,3,2,0,1,0], "C/E": [0,3,2,0,1,0], "C/B": [-1,2,2,0,1,0],
  "D": [-1,-1,0,2,3,2], "Dm": [-1,-1,0,2,3,1], "D7": [-1,-1,0,2,1,2], "Dm7": [-1,-1,0,2,1,1], "Dmaj7": [-1,-1,0,2,2,2], "Dsus2": [-1,-1,0,2,3,0], "Dsus4": [-1,-1,0,2,3,3], "D/F#": [2,0,0,2,3,2], "D/A": [-1,0,0,2,3,2], "D6": [-1,-1,0,2,0,2], "Dadd9": [-1,-1,0,2,3,0],
  "E": [0,2,2,1,0,0], "Em": [0,2,2,0,0,0], "E7": [0,2,0,1,0,0], "Em7": [0,2,0,0,0,0], "Esus4": [0,2,2,2,0,0], "Emaj7": [0,2,1,1,0,0], "E5": [0,2,2,-1,-1,-1], "Em/D": [-1,-1,0,0,0,0], "Eadd9": [0,2,4,1,0,0],
  "F": [1,3,3,2,1,1], "Fmaj7": [-1,-1,3,2,1,0], "F/C": [-1,3,3,2,1,1], "Fadd9": [-1,-1,3,2,1,3],
  "G": [3,2,0,0,0,3], "G7": [3,2,0,0,0,1], "Gmaj7": [3,2,0,0,0,2], "G6": [3,2,0,0,0,0], "G/B": [-1,2,0,0,0,3], "G/D": [-1,-1,0,0,0,3], "Gsus4": [3,-1,0,0,1,3], "Gadd9": [3,0,0,2,0,3],
  "A": [-1,0,2,2,2,0], "Am": [-1,0,2,2,1,0], "A7": [-1,0,2,0,2,0], "Am7": [-1,0,2,0,1,0], "Amaj7": [-1,0,2,1,2,0], "Asus2": [-1,0,2,2,0,0], "Asus4": [-1,0,2,2,3,0], "A6": [-1,0,2,2,2,2], "Am/G": [3,0,2,2,1,0], "A7sus4": [-1,0,2,0,3,0], "Am6": [-1,0,2,2,1,2], "Aadd9": [-1,0,2,4,2,0],
  "B7": [-1,2,1,2,0,2], "Bm7": [-1,2,0,2,0,2]
};
// Forme mobili (barré): r = tasto della tonica sulla 6ª (E) o sulla 5ª (A) corda
const E_SHAPES = {
  "": [0,2,2,1,0,0], "m": [0,2,2,0,0,0], "7": [0,2,0,1,0,0], "m7": [0,2,0,0,0,0], "maj7": [0,-9,1,1,0,-9],
  "sus4": [0,2,2,2,0,0], "7sus4": [0,2,0,2,0,0], "5": [0,2,2,-9,-9,-9], "aug": [0,3,2,1,1,0], "add9": [0,2,4,1,0,0],
  "m7b5": [0,-9,0,0,-1,-9], "dim7": [0,-9,-1,0,-1,-9]
};
const A_SHAPES = {
  "": [-9,0,2,2,2,0], "m": [-9,0,2,2,1,0], "7": [-9,0,2,0,2,0], "m7": [-9,0,2,0,1,0], "maj7": [-9,0,2,1,2,0],
  "sus2": [-9,0,2,2,0,0], "sus4": [-9,0,2,2,3,0], "7sus4": [-9,0,2,0,3,0], "6": [-9,0,2,2,2,2], "m6": [-9,0,2,2,1,2],
  "9": [-9,0,-1,0,0,0], "add9": [-9,0,2,4,2,0], "dim": [-9,0,1,2,1,-9], "dim7": [-9,0,1,2,1,2], "m7b5": [-9,0,1,0,1,-9],
  "aug": [-9,0,3,2,2,1], "5": [-9,0,2,2,-9,-9]
};
const QUAL_ALIASES = [
  [/^(maj|M)?$/, ""], [/^(m|min|-)$/, "m"], [/^7$/, "7"], [/^(m7|min7|-7)$/, "m7"], [/^(maj7|M7|Δ7?|7M|ma7)$/, "maj7"],
  [/^sus2$/, "sus2"], [/^sus4?$/, "sus4"], [/^7sus4?$/, "7sus4"], [/^(dim|°|o)$/, "dim"], [/^(dim7|°7|o7)$/, "dim7"],
  [/^(m7b5|m7-5|ø7?|min7b5)$/, "m7b5"], [/^(aug|\+|\+5|#5)$/, "aug"], [/^6$/, "6"], [/^(m6|min6|-6)$/, "m6"],
  [/^9$/, "9"], [/^(add9|add2|2)$/, "add9"], [/^5$/, "5"]
];
function simplifyQual(q){
  for (const [re, v] of QUAL_ALIASES) if (re.test(q)) return { q: v, approx: false };
  // estensioni non presenti: usa la forma base più vicina
  if (/^(maj|M)(9|11|13)/.test(q)) return { q: "maj7", approx: true };
  if (/^(m|min|-)/.test(q) && !/^maj/.test(q)) return { q: /7|9|11|13/.test(q) ? "m7" : "m", approx: true };
  if (/7|9|11|13/.test(q)) return { q: "7", approx: true };
  if (/sus/.test(q)) return { q: "sus4", approx: true };
  return { q: "", approx: true };
}
function parseChord(name){
  const m = String(name).replace(/[()*]/g, "").match(/^([A-G])([#b]?)(.*?)(?:\/([A-G][#b]?))?$/);
  if (!m) return null;
  const root = m[1] + m[2];
  const { q, approx } = simplifyQual(m[3]);
  return { root, q, approx, bass: m[4] || "", raw: m[3] };
}
// nome con le note in diesis, per cercare le forme aperte
function sharpName(n){ const i = noteIdx(n); return i < 0 ? n : SHARP[i]; }
function flatName(n){ const i = noteIdx(n); return i < 0 ? n : FLAT[i]; }
function chordShapes(name){
  const c = parseChord(name); if (!c) return null;
  const out = [];
  const add = (frets, label, slash = false) => { if (!out.some(o => o.frets.join() === frets.join())) out.push({ frets, label, slash }); };
  const ri = noteIdx(c.root);
  for (const r of [c.root, sharpName(c.root), flatName(c.root)]){
    if (c.bass){ for (const b of [c.bass, sharpName(c.bass), flatName(c.bass)]){ const k = r + c.q + "/" + b; if (OPEN_SHAPES[k]) add(OPEN_SHAPES[k], "Aperto", true); } }
    if (OPEN_SHAPES[r + c.q]) add(OPEN_SHAPES[r + c.q], "Aperto");
  }
  const mobile = (tpl, base, label) => {
    if (!tpl) return;
    for (const r of [base, base + 12]){
      const f = tpl.map(v => v === -9 ? -1 : v + r);
      if (f.some(v => v < -1) || f.some((v, i) => tpl[i] !== -9 && v < 0)) continue;
      if (Math.max(...f) > 15) continue;
      add(f, label); break;
    }
  };
  const r6 = ((ri - 4) % 12 + 12) % 12, r5 = ((ri - 9) % 12 + 12) % 12;
  const shapes = [[E_SHAPES[c.q], r6, "Barré sulla 6ª corda"], [A_SHAPES[c.q], r5, "Barré sulla 5ª corda"]].sort((a, b) => a[1] - b[1]);
  for (const [tpl, r, label] of shapes) mobile(tpl, r, label);
  return { chord: c, shapes: out };
}
function chordSVG(frets, names = ["E","A","D","G","B","e"]){
  const played = frets.filter(f => f > 0);
  const maxF = played.length ? Math.max(...played) : 0, minF = played.length ? Math.min(...played) : 0;
  const base = maxF <= 5 ? 1 : minF;
  const n = frets.length, gap = n === 6 ? 17 : 25, x0 = n === 6 ? 22 : 27;
  const X = i => x0 + i * gap, Y = f => 34 + (f - base + 0.5) * 22;
  let s = `<svg viewBox="0 0 130 158" width="130" height="158" role="img" aria-label="Diagramma accordo">`;
  // tasti e corde
  for (let k = 0; k <= 5; k++) s += `<line x1="${X(0)}" x2="${X(n - 1)}" y1="${34 + k * 22}" y2="${34 + k * 22}" stroke="#6b5a49" stroke-width="${k === 0 && base === 1 ? 5 : 1.2}"/>`;
  for (let i = 0; i < n; i++) s += `<line x1="${X(i)}" x2="${X(i)}" y1="34" y2="144" stroke="#a8998a" stroke-width="${1 + (n - 1 - i) * 0.25}"/>`;
  if (base > 1) s += `<text x="${X(0) - 8}" y="${Y(base) + 4}" text-anchor="end" font-size="11" font-family="JetBrains Mono,monospace" fill="#f1e7da">${base}</text>`;
  // barré: stesso tasto minimo dalla prima corda suonata con quel tasto fino al cantino
  const firstMin = frets.findIndex(f => f === minF);
  const last = n - 1 - [...frets].reverse().findIndex(f => f === minF);
  if (minF > 0 && firstMin >= 0 && last - firstMin >= 2 && frets.slice(firstMin, last + 1).every(f => f >= minF)){
    s += `<rect x="${X(firstMin) - 7}" y="${Y(minF) - 7}" width="${X(last) - X(firstMin) + 14}" height="14" rx="7" fill="#f0a43c"/>`;
  }
  frets.forEach((f, i) => {
    if (f === -1) s += `<text x="${X(i)}" y="25" text-anchor="middle" font-size="12" font-weight="700" fill="#e8735f">✕</text>`;
    else if (f === 0) s += `<circle cx="${X(i)}" cy="21" r="4.5" fill="none" stroke="#6cc3b5" stroke-width="1.8"/>`;
    else s += `<circle cx="${X(i)}" cy="${Y(f)}" r="7" fill="#f0a43c"/>`;
  });
  names.forEach((n, i) => { s += `<text x="${X(i)}" y="156" text-anchor="middle" font-size="9" font-family="JetBrains Mono,monospace" fill="#a8998a">${n}</text>`; });
  return s + `</svg>`;
}
function instrShapes(name){
  if (S.instr === "uke") return { shapes: ukeShapes(name), names: ["G","C","E","A"], chord: parseChord(name) };
  if (S.instr === "bass") return { shapes: bassShapes(name), names: ["E","A","D","G"], chord: parseChord(name) };
  const r = chordShapes(name); return r ? { ...r, names: undefined } : null;
}
function chordCard(name, idx = 0){
  const r = instrShapes(name);
  if (!r || !r.shapes.length) return `<div class="chord-card"><div class="chord-name">${esc(name)}</div><p class="chord-note">Non conosco ancora questo accordo.</p></div>`;
  const sh = r.shapes[idx % r.shapes.length];
  if (S.instr !== "guitar") return `<div class="chord-card"><div class="chord-name">${esc(name)}</div>${chordSVG(sh.frets, r.names)}<div class="chord-note">${esc(sh.label)}${r.shapes.length > 1 ? ` · ${idx % r.shapes.length + 1}/${r.shapes.length}` : ""}</div>${S.instr === "bass" && r.chord && r.chord.bass ? `<div class="chord-note">Nota al basso dell'accordo ${esc(name)}</div>` : ""}</div>`;
  const notes = [];
  if (r.chord.approx) notes.push(`Forma semplificata di ${esc(r.chord.root + r.chord.q)}`);
  if (r.chord.bass && !sh.slash) notes.push(`Basso: ${esc(r.chord.bass)} sulla corda più grave`);
  return `<div class="chord-card"><div class="chord-name">${esc(name)}</div>${chordSVG(sh.frets)}
    <div class="chord-note">${esc(sh.label)}${r.shapes.length > 1 ? ` · ${idx % r.shapes.length + 1}/${r.shapes.length}` : ""}</div>
    ${notes.map(n => `<div class="chord-note">${n}</div>`).join("")}</div>`;
}
function songChords(s){
  const seen = new Set(), list = [];
  for (const [t, l] of songParts(s).items){
    if (t !== "chord") continue;
    for (const tok of transposeLine(l, S.transpose).split(/\s+/)){
      const c = tok.replace(/[()*]/g, "");
      if (c && CHORD_RE.test(c) && !seen.has(c)){ seen.add(c); list.push(c); }
    }
  }
  return list;
}
function showChord(name){
  let idx = 0;
  const s = songById(S.songId);
  const capo = s && +s.capo ? `<p class="chord-tip">Con il capotasto al ${+s.capo}° tasto i tasti si contano dal capotasto.</p>` : "";
  const draw = el => {
    $("#m-chord", el).innerHTML = chordCard(name, idx);
    const n = (instrShapes(name)?.shapes || []).length;
    $("#m-alt", el).style.display = n > 1 ? "" : "none";
  };
  modal({ title: "Accordo", body: `${instrPicker()}<div id="m-chord" style="display:flex;justify-content:center"></div>${capo}`,
    actions: `<button class="btn" id="m-alt">Altra posizione</button><button class="btn primary" data-close>Chiudi</button>`,
    onMount: el => { draw(el); $("#m-alt", el).onclick = () => { idx++; draw(el); }; bindInstr(el, () => { idx = 0; draw(el); }); } });
}
function showAllChords(){
  const s = songById(S.songId); if (!s) return;
  const list = songChords(s);
  modal({ title: "Accordi del brano", body: list.length ? `${instrPicker()}<div class="chord-grid">${list.map(c => `<button class="chord-cell" data-chord="${esc(c)}">${chordCard(c)}</button>`).join("")}</div><p class="chord-tip">Tocca un accordo per vedere altre posizioni.</p>` : `<p style="margin:0;color:var(--muted)">Non trovo accordi in questo brano.</p>`,
    onMount: el => { el.querySelectorAll("[data-chord]").forEach(b => b.onclick = () => showChord(b.dataset.chord)); bindInstr(el, () => showAllChords()); } });
}
function instrPicker(){
  return `<div class="seg-mini instr" role="group" aria-label="Strumento">${[["guitar","Chitarra"],["uke","Ukulele"],["bass","Basso"]].map(([k, l]) => `<button data-instr="${k}" aria-pressed="${S.instr === k}">${l}</button>`).join("")}</div>`;
}
function bindInstr(el, redraw){
  el.querySelectorAll("[data-instr]").forEach(b => b.onclick = () => {
    S.instr = b.dataset.instr; savePrefs();
    el.querySelectorAll("[data-instr]").forEach(x => x.setAttribute("aria-pressed", x.dataset.instr === S.instr));
    redraw();
  });
}

/* ---------- data layer (Firebase Firestore, cache offline persistente) ---------- */
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
let FB = null;          // { db, auth, uid, fs, au }
const CONFIG_OK = firebaseConfig && firebaseConfig.apiKey && !/INCOLLA/i.test(firebaseConfig.apiKey);

// Repertorio comune della band: brani e playlist sono condivisi tra i membri.
// Il proprietario (deve coincidere con l'email scritta nelle regole di Firestore) gestisce i membri.
const OWNER_EMAIL = "rizzi.bunzz.stefano@gmail.com";
const isOwner = () => FB && FB.email.toLowerCase() === OWNER_EMAIL;
function colRef(coll){ return FB.fs.collection(FB.db, coll); }
function docRef(coll, id){ return FB.fs.doc(FB.db, coll, id); }
const bandRef = () => FB.fs.doc(FB.db, "band", "info");

function handleWriteError(e){
  console.error(e);
  const code = e && e.code;
  if (code === "permission-denied"){ if (S.mode === "loading" || S.mode === "ready"){ S.mode = "notmember"; render(); } else toast("Permesso negato"); }
  else if (code === "resource-exhausted") toast("Limite del piano gratuito raggiunto per oggi");
  else toast("Salvataggio non riuscito: " + (code || "errore"));
}
// Offline, Firestore salva subito nella cache locale e invia al server appena torna la rete:
// per questo non aspettiamo la conferma del server.
function write(coll, obj){
  const clean = JSON.parse(JSON.stringify(obj));
  if (coll === "songs"){
    S.songs = S.songs.filter(x => x.id !== clean.id); S.trash = S.trash.filter(x => x.id !== clean.id);
    (clean.deleted ? S.trash : S.songs).push(clean);
  } else {
    const arr = S.playlists;
    const i = arr.findIndex(x => x.id === clean.id);
    if (i >= 0) arr[i] = clean; else arr.push(clean);
  }
  FB.fs.setDoc(docRef(coll, clean.id), clean).catch(handleWriteError);
  return true;
}
function remove(coll, id){
  if (coll === "songs"){ S.songs = S.songs.filter(x => x.id !== id); S.trash = S.trash.filter(x => x.id !== id); } else S.playlists = S.playlists.filter(x => x.id !== id);
  FB.fs.deleteDoc(docRef(coll, id)).catch(handleWriteError);
  render();
  return true;
}

async function init(){
  registerSW();
  if (!CONFIG_OK){ S.mode = "config"; render(); return; }
  try {
    const [app, au, fs] = await Promise.all([
      import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js")
    ]);
    const fapp = app.initializeApp(firebaseConfig);
    let db;
    try { db = fs.initializeFirestore(fapp, { localCache: fs.persistentLocalCache({ cacheSizeBytes: fs.CACHE_SIZE_UNLIMITED, tabManager: fs.persistentMultipleTabManager() }) }); }
    catch { db = fs.getFirestore(fapp); }
    const auth = au.getAuth(fapp);
    FB = { db, auth, fs, au, uid: null, email: "" };
    au.getRedirectResult(auth).catch(e => { if (e && e.code !== "auth/no-auth-event") S.authError = e.code; });
    au.onAuthStateChanged(auth, user => {
      if (user){ FB.uid = user.uid; FB.email = user.email || ""; FB.name = user.displayName || (user.email || "").split("@")[0]; S.mode = "loading"; render(); start(); }
      else { unsubscribeAll(); FB.uid = null; S.songs = []; S.playlists = []; S.members = []; S.legacy = null; S.mode = "login"; render(); }
    });
  } catch (e){
    console.error(e);
    S.mode = "error"; render();
  }
}
let unsubs = [];
function unsubscribeAll(){ unsubs.forEach(u => { try { u(); } catch {} }); unsubs = []; }
async function start(){
  // Il proprietario crea la scheda della band al primo accesso
  if (isOwner()){
    try {
      const snap = await FB.fs.getDoc(bandRef());
      if (!snap.exists()) await FB.fs.setDoc(bandRef(), { name: "La band", members: [OWNER_EMAIL] });
    } catch (e){ console.warn("band/info", e); }
    checkLegacy();
  }
  subscribe();
}
// Brani salvati con la versione precedente (repertorio personale): proponi di spostarli
async function checkLegacy(){
  try {
    const [ss, ps] = await Promise.all([
      FB.fs.getDocs(FB.fs.collection(FB.db, "users", FB.uid, "songs")),
      FB.fs.getDocs(FB.fs.collection(FB.db, "users", FB.uid, "playlists"))
    ]);
    if (ss.size || ps.size){ S.legacy = { songs: ss.docs.map(d => ({ ...d.data(), id: d.id })), playlists: ps.docs.map(d => ({ ...d.data(), id: d.id })) }; render(); }
  } catch {}
}
async function moveLegacy(){
  const L = S.legacy; if (!L) return;
  S.legacy = null;
  const batch = FB.fs.writeBatch(FB.db);
  for (const s of L.songs){ batch.set(docRef("songs", s.id), s); batch.delete(FB.fs.doc(FB.db, "users", FB.uid, "songs", s.id)); }
  for (const p of L.playlists){ batch.set(docRef("playlists", p.id), p); batch.delete(FB.fs.doc(FB.db, "users", FB.uid, "playlists", p.id)); }
  batch.commit().catch(handleWriteError);
  toast(`Spostati ${L.songs.length} brani nel repertorio della band`);
  render();
}
function subscribe(){
  unsubscribeAll();
  const opts = { includeMetadataChanges: true };
  unsubs.push(FB.fs.onSnapshot(bandRef(), d => {
    const data = d.exists() ? d.data() : {};
    S.members = Array.isArray(data.members) ? data.members : [];
    S.viewers = Array.isArray(data.viewers) ? data.viewers : [];
    S.bandName = data.name || "";
    const ro = !isOwner() && S.viewers.includes(FB.email.toLowerCase());
    if (ro !== S.readOnly){ S.readOnly = ro; if (S.mode === "ready" && S.view !== "edit") render(); }
  }, () => {}));
  unsubs.push(FB.fs.onSnapshot(colRef("status"), snap => {
    const m = {}; for (const d of snap.docs) m[d.id] = d.data(); S.status = m;
    if (S.mode === "ready" && S.view !== "edit") render(true);
  }, () => {}));
  unsubs.push(FB.fs.onSnapshot(FB.fs.collection(FB.db, "users", FB.uid, "notes"), snap => {
    const m = {}; for (const d of snap.docs) m[d.id] = d.data().text || ""; S.myNotes = m;
    if (S.mode === "ready" && S.view === "song" && !document.querySelector("#my-note-ta")) render(true);
  }, () => {}));
  let gotSongs = false, gotPl = false;
  const ready = () => { if (gotSongs && gotPl && S.mode === "loading"){ S.mode = "ready"; render(); } };
  unsubs.push(FB.fs.onSnapshot(colRef("songs"), opts, snap => {
    const all = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    S.songs = all.filter(x => !x.deleted); S.trash = all.filter(x => x.deleted);
    if (!snap.metadata.fromCache && !S.purged){ S.purged = true; purgeTrash(); }
    S.pendingSongs = snap.metadata.hasPendingWrites;
    gotSongs = true; ready(); if (S.mode === "ready") render(true);
  }, e => { handleWriteError(e); gotSongs = true; ready(); }));
  unsubs.push(FB.fs.onSnapshot(colRef("images"), opts, snap => {
    const map = {};
    for (const d of snap.docs){ const x = { ...d.data(), id: d.id }; if (!x.songId) continue; (map[x.songId] ||= []).push(x); }
    for (const k in map) map[k].sort((a, b) => (a.order || 0) - (b.order || 0));
    S.images = map;
    if (S.mode === "ready" && S.view !== "edit") render(true);
  }, () => {}));
  unsubs.push(FB.fs.onSnapshot(colRef("playlists"), opts, snap => {
    S.playlists = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    S.pendingPl = snap.metadata.hasPendingWrites;
    gotPl = true; ready(); if (S.mode === "ready") render(true);
  }, e => { handleWriteError(e); gotPl = true; ready(); }));
}
/* ---------- cestino ---------- */
const DAY = 86400000;
function trashSong(s){
  write("songs", { ...s, deleted: true, deletedAt: Date.now(), deletedBy: FB.name });
}
function restoreSong(s){
  const c = { ...s }; delete c.deleted; delete c.deletedAt; delete c.deletedBy;
  write("songs", c);
}
async function purgeSong(s){
  remove("songs", s.id);
  deleteSongImages(s.id);
  try {
    const q = FB.fs.query(colRef("history"), FB.fs.where("songId", "==", s.id));
    const snap = await FB.fs.getDocs(q);
    snap.docs.forEach(d => FB.fs.deleteDoc(d.ref).catch(() => {}));
  } catch {}
  FB.fs.deleteDoc(docRef("status", s.id)).catch(() => {});
}
function purgeTrash(){
  if (S.readOnly) return;
  for (const s of S.trash) if (Date.now() - (s.deletedAt || 0) > 30 * DAY) purgeSong(s);
}

/* ---------- cronologia delle versioni ---------- */
async function saveHistory(old){
  if (!old) return;
  const data = { ...old }; delete data.id;
  FB.fs.setDoc(docRef("history", uid("h")), { songId: old.id, savedAt: Date.now(), by: old.updatedBy || old.createdBy || "", data }).catch(() => {});
  // tieni solo le ultime 20 versioni
  try {
    const snap = await FB.fs.getDocs(FB.fs.query(colRef("history"), FB.fs.where("songId", "==", old.id)));
    const docs = snap.docs.sort((a, b) => (b.data().savedAt || 0) - (a.data().savedAt || 0));
    docs.slice(20).forEach(d => FB.fs.deleteDoc(d.ref).catch(() => {}));
  } catch {}
}
async function showHistory(songId){
  const s = songById(songId); if (!s) return;
  modal({ title: "Cronologia", body: `<p style="margin:0;color:var(--muted)">Carico le versioni…</p>` });
  let docs = [];
  try {
    const snap = await FB.fs.getDocs(FB.fs.query(colRef("history"), FB.fs.where("songId", "==", songId)));
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.savedAt - a.savedAt);
  } catch { toast("Non riesco a leggere la cronologia"); closeModal(); return; }
  const fmt = t => new Date(t).toLocaleString("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  modal({ title: "Cronologia di " + s.title,
    body: docs.length ? `<p style="margin:0;color:var(--muted);font-size:14px">Le versioni precedenti del brano, dalla più recente. Ripristinandone una, quella attuale viene salvata qui.</p>` + docs.map((h, i) => `<div class="hist">
        <div class="hist-head"><span><b>${fmt(h.savedAt)}</b>${h.by ? " · " + esc(h.by) : ""}</span><span class="spacer"></span>
        <button class="btn" data-h-view="${i}">Vedi</button>${S.readOnly ? "" : `<button class="btn primary" data-h-restore="${i}">Ripristina</button>`}</div>
        <pre class="hist-pre" id="hp-${i}" hidden>${esc([h.data.notes ? "Note: " + h.data.notes + "\n" : "", h.data.content || h.data.lyrics || "(vuoto)"].join(""))}</pre></div>`).join("")
      : `<p style="margin:0;color:var(--muted)">Nessuna versione precedente: la cronologia si crea dalla prossima modifica.</p>`,
    onMount: el => {
      el.querySelectorAll("[data-h-view]").forEach(b => b.onclick = () => { const pre = $("#hp-" + b.dataset.hView, el); pre.hidden = !pre.hidden; });
      el.querySelectorAll("[data-h-restore]").forEach(b => b.onclick = () => {
        const h = docs[+b.dataset.hRestore];
        const cur = songById(songId); saveHistory(cur);
        write("songs", { ...h.data, id: songId, updatedAt: Date.now(), updatedBy: FB.name });
        closeModal(); toast("Versione ripristinata"); render();
      });
    } });
}

/* ---------- stato del brano per ogni membro ---------- */
const STATUS = { learn: "Da imparare", almost: "Quasi", ready: "Pronto" };
function myStatus(songId){ const st = S.status[songId]; return st && st[FB.uid] ? st[FB.uid].s : ""; }
function setStatus(songId, v){
  const cur = myStatus(songId);
  const val = cur === v ? null : { s: v, n: FB.name, e: FB.email.toLowerCase(), at: Date.now() };
  const map = { ...(S.status[songId] || {}) };
  if (val) map[FB.uid] = val; else delete map[FB.uid];
  S.status = { ...S.status, [songId]: map };
  FB.fs.setDoc(docRef("status", songId), { [FB.uid]: val || FB.fs.deleteField() }, { merge: true }).catch(handleWriteError);
  render();
}
function editorEmails(){ return S.members.filter(m => !S.viewers.includes(m)); }
function readyForAll(songId){
  const st = Object.values(S.status[songId] || {});
  const emails = editorEmails();
  return emails.length > 0 && emails.every(e => st.some(x => x.e === e && x.s === "ready"));
}

/* ---------- note private ---------- */
function saveMyNote(songId, text){
  const t = text.trim();
  S.myNotes = { ...S.myNotes, [songId]: t };
  const ref = FB.fs.doc(FB.db, "users", FB.uid, "notes", songId);
  (t ? FB.fs.setDoc(ref, { text: t, at: Date.now() }) : FB.fs.deleteDoc(ref)).catch(handleWriteError);
}

/* ---------- aggiornamenti dell'app ---------- */
let lastUpdateCheck = 0;
async function checkUpdate(){
  if (location.protocol === "file:" || Date.now() - lastUpdateCheck < 5 * 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch("./app.js", { cache: "no-store" });
    const m = (await r.text()).match(/const APP_VERSION = "([^"]+)"/);
    if (m && m[1] !== APP_VERSION && !$("#upd-bar")){
      const bar = document.createElement("div");
      bar.id = "upd-bar"; bar.className = "upd-bar";
      bar.innerHTML = `<span>È disponibile una nuova versione dell'app</span><button class="btn primary" id="upd-go">Aggiorna</button>`;
      document.body.appendChild(bar);
      $("#upd-go").onclick = applyUpdate;
    }
  } catch {}
}
async function applyUpdate(){
  try { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); } catch {}
  try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch {}
  location.reload();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(); });
setTimeout(checkUpdate, 4000);

async function login(){
  const { au, auth } = FB;
  const provider = new au.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try { await au.signInWithPopup(auth, provider); }
  catch (e){
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)){
      try { await au.signInWithRedirect(auth, provider); } catch (e2){ S.authError = e2.code; render(); }
    } else if (e.code !== "auth/popup-closed-by-user"){ S.authError = e.code; render(); }
  }
}

/* ---------- service worker + installazione ---------- */
let installEvt = null;
function registerSW(){
  if ("serviceWorker" in navigator && location.protocol !== "file:"){
    navigator.serviceWorker.register("./sw.js").catch(e => console.warn("SW", e));
  }
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (S.view === "library") render(); });
  window.addEventListener("appinstalled", () => { installEvt = null; toast("App installata"); });
  window.addEventListener("online", updateSyncPill);
  window.addEventListener("offline", updateSyncPill);
}
function syncState(){
  if (!navigator.onLine) return { cls: "off", label: "Offline" };
  if (S.pendingSongs || S.pendingPl) return { cls: "pending", label: "Invio modifiche…" };
  return { cls: "", label: "Sincronizzato" };
}
function syncPill(){ const st = syncState(); return `<span class="sync ${st.cls}" id="sync" title="${st.label}"><i></i><span>${st.label}</span></span>`; }
function updateSyncPill(){ const el = document.getElementById("sync"); if (el) el.outerHTML = syncPill(); }

/* ---------- render ---------- */
function render(fromData){
  if (fromData) updateSyncPill();
  // keep focus/caret in the library search box when data updates arrive
  if (fromData && S.view === "library" && document.activeElement && document.activeElement.id === "q"){ renderLibraryList(); renderLibraryChrome(); return; }
  if (fromData && S.view === "edit") return; // don't wipe the form being written
  const app = $("#app");
  const v = S.view;
  let html = topbar();
  if (S.mode === "config" || S.mode === "login" || S.mode === "error" || S.mode === "notmember"){ app.innerHTML = gateView(); return; }
  if (S.mode === "loading") html += `<div class="wrap loading">Caricamento del repertorio…</div>`;
  else if (v === "library") html += libraryView();
  else if (v === "song") html += songView();
  else if (v === "edit") html += editView();
  else if (v === "playlists") html += playlistsView();
  else if (v === "playlist") html += playlistView();
  else if (v === "trash") html += trashView();
  app.innerHTML = html;
  if (v === "library") { renderLibraryList(); renderLibraryChrome(); }
  if (v === "edit") setupEditor();
  document.body.classList.toggle("stage", S.stage && v === "song");
  if (v === "song" && S.editingNote) setTimeout(() => $("#my-note-ta")?.focus(), 20);
}

function topbar(){
  const inLib = ["library","song","edit"].includes(S.view) && !(S.view === "song" && S.play);
  return `<header class="top"><div class="wrap">
    <div class="brand"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="2" y="5" width="22" height="16" rx="3" fill="none" stroke="#f0a43c" stroke-width="2"/><path d="M2 10h22M2 14h22M2 18h22" stroke="#6b5a49" stroke-width="1"/><circle cx="9" cy="12" r="2.4" fill="#f0a43c"/><circle cx="16" cy="16" r="2.4" fill="#6cc3b5"/></svg><span>Repertorio</span></div>
    <div class="spacer"></div>
    ${syncPill()}
    <nav class="tabs" aria-label="Sezioni">
      <button data-a="nav-library" aria-current="${inLib}">Brani</button>
      <button data-a="nav-playlists" aria-current="${!inLib}">Playlist</button>
    </nav>
    <button class="icon-btn ghost" data-a="backup" title="Account e backup" aria-label="Account e backup"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></button>
  </div></header>`;
}

function backupDue(){
  if (!isOwner() || !S.songs.length) return false;
  let last = 0; try { last = +localStorage.getItem("repertorio-lastBackup") || 0; } catch {}
  return Date.now() - last > 30 * DAY;
}
function banner(){
  if (S.legacy) return `<div class="banner" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px">Hai <b>${S.legacy.songs.length} brani</b> salvati prima, nel tuo repertorio personale. Spostali nel repertorio della band così li vedono tutti.</span><button class="btn primary" data-a="move-legacy">Sposta nella band</button></div>`;
  if (backupDue()) return `<div class="banner" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px"><b>È passato più di un mese dall'ultimo backup.</b> Scarica una copia del repertorio da tenere al sicuro.</span><button class="btn primary" data-a="backup">Fai il backup</button></div>`;
  if (installEvt) return `<div class="banner" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px"><b>Installa l'app</b> per aprirla dalla schermata Home e usarla anche offline.</span><button class="btn primary" data-a="install">Installa</button></div>`;
  return "";
}
function gateView(){
  if (S.mode === "notmember") return `<div class="gate"><div class="card">
    <h1>Non sei ancora nella band</h1>
    <p>Chiedi a Stefano di aggiungerti tra i membri con questa email:</p>
    <p><b style="color:var(--text);word-break:break-all">${esc(FB.email)}</b></p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn primary" onclick="location.reload()">Riprova</button><button class="btn" data-a="logout">Usa un altro account</button></div>
  </div></div>`;
  if (S.mode === "config") return `<div class="gate"><div class="card"><h1>Quasi pronto</h1><p>Manca la configurazione di Firebase. Apri il file <code>firebase-config.js</code> e incolla i dati del tuo progetto, come spiegato nella guida.</p></div></div>`;
  if (S.mode === "error") return `<div class="gate"><div class="card"><h1>Non riesco ad avviare l'app</h1><p>Al primo avvio serve la connessione a internet per scaricare l'app. Controlla la rete e ricarica la pagina.</p><button class="btn primary" onclick="location.reload()">Riprova</button></div></div>`;
  return `<div class="gate"><div class="card">
    <h1>Il mio repertorio</h1>
    <p>Accedi con Google per ritrovare i tuoi brani su PC e telefono. Dopo il primo accesso l'app funziona anche offline.</p>
    <button class="btn primary" data-a="login">Accedi con Google</button>
    ${S.authError ? `<p style="color:var(--danger);font-size:14px">Accesso non riuscito (${esc(S.authError)}). ${S.authError === "auth/unauthorized-domain" ? "Aggiungi questo dominio tra i domini autorizzati di Firebase (vedi guida)." : "Riprova."}</p>` : ""}
  </div></div>`;
}

/* library */
function filteredSongs(){
  const q = norm(S.f.q);
  let list = S.songs.filter(s =>
    (!S.f.genre || s.genre === S.f.genre) &&
    (!S.f.artist || s.artist === S.f.artist) &&
    (!S.f.type || s.type === S.f.type || (S.f.type !== "both" && s.type === "both")) &&
    (!q || norm(`${s.title} ${s.artist} ${s.genre} ${s.notes} ${s.lyrics || ""} ${s.content || ""}`).includes(q)) &&
    (!S.f.status || (S.f.status === "allready" ? readyForAll(s.id) : S.f.status === "none" ? !myStatus(s.id) : myStatus(s.id) === S.f.status))
  );
  if (S.sort === "title") list.sort(byTitle);
  else if (S.sort === "artist") list.sort((a, b) => (a.artist || "~").localeCompare(b.artist || "~", "it", { sensitivity: "base" }) || byTitle(a, b));
  else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}
function libraryView(){
  return `<main class="wrap">
    ${banner()}
    <div class="lib-head"><h1>Brani della band</h1><span class="count" id="count"></span></div>
    <div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a8998a" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Cerca titolo, artista o una frase del testo…" value="${esc(S.f.q)}" aria-label="Cerca" autocomplete="off"></div>
    <div class="chips" id="chips" role="group" aria-label="Genere"></div>
    <div class="filters">
      <select id="f-artist" aria-label="Artista"></select>
      <select id="f-type" aria-label="Tipo">
        <option value="">Accordi e tab</option>
        <option value="chords" ${S.f.type==="chords"?"selected":""}>Solo accordi</option>
        <option value="tabs" ${S.f.type==="tabs"?"selected":""}>Solo tablature</option>
      </select>
      <select id="f-status" aria-label="Stato">
        <option value="">Tutti gli stati</option>
        <option value="allready" ${S.f.status==="allready"?"selected":""}>Pronti per tutta la band</option>
        <option value="ready" ${S.f.status==="ready"?"selected":""}>Io: pronto</option>
        <option value="almost" ${S.f.status==="almost"?"selected":""}>Io: quasi</option>
        <option value="learn" ${S.f.status==="learn"?"selected":""}>Io: da imparare</option>
        <option value="none" ${S.f.status==="none"?"selected":""}>Io: non segnati</option>
      </select>
      <select id="f-sort" aria-label="Ordina">
        <option value="title" ${S.sort==="title"?"selected":""}>Ordina per titolo</option>
        <option value="artist" ${S.sort==="artist"?"selected":""}>Ordina per artista</option>
        <option value="recent" ${S.sort==="recent"?"selected":""}>Aggiunti di recente</option>
      </select>
    </div>
    <div class="filter-actions" id="fa"></div>
    <div class="list" id="list"></div>
  </main>
  ${S.readOnly ? "" : `<button class="fab" data-a="new-song"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Aggiungi brano</button>`}`;
}
function renderLibraryChrome(){
  const genres = uniq(S.songs.map(s => s.genre));
  const chips = $("#chips");
  if (chips) chips.innerHTML = genres.length ? [`<button class="chip" data-a="genre" data-v="" aria-pressed="${!S.f.genre}">Tutti i generi</button>`, ...genres.map(g => `<button class="chip" data-a="genre" data-v="${esc(g)}" aria-pressed="${S.f.genre===g}">${esc(g)}</button>`)].join("") : "";
  const artists = uniq(S.songs.filter(s => !S.f.genre || s.genre === S.f.genre).map(s => s.artist));
  const fa = $("#f-artist");
  if (fa) fa.innerHTML = `<option value="">Tutti gli artisti</option>` + artists.map(a => `<option ${S.f.artist===a?"selected":""}>${esc(a)}</option>`).join("");
}
function renderLibraryList(){
  const list = filteredSongs();
  const el = $("#list"); if (!el) return;
  const active = S.f.q || S.f.genre || S.f.artist || S.f.type || S.f.status;
  $("#count").textContent = active ? `${list.length} di ${S.songs.length}` : `${S.songs.length} ${S.songs.length === 1 ? "brano" : "brani"}`;
  $("#fa").innerHTML = active ? `<button class="link-btn" data-a="clear-f">Azzera filtri</button>${list.length && !S.readOnly ? `<button class="link-btn" data-a="filter-to-pl">Crea playlist con questi ${list.length} brani</button>` : ""}` : "";
  if (!S.songs.length){
    el.innerHTML = `<div class="empty"><h3>Il repertorio è vuoto</h3>Copia tab o accordi da un sito, tocca <b>Aggiungi brano</b> e incollali.<br>Puoi segnare capotasto, accordatura e le tue note.</div>`;
    return;
  }
  if (!list.length){ el.innerHTML = `<div class="empty"><h3>Nessun brano trovato</h3>Prova a cambiare i filtri.</div>`; return; }
  el.innerHTML = list.map(songRow).join("") + (S.trash.length ? `<button class="link-btn" style="margin:10px auto" data-a="trash">Cestino (${S.trash.length})</button>` : "");
}
function songBadges(s){
  const b = [];
  if (+s.capo) b.push(`<span class="badge capo">CAPO ${+s.capo}</span>`);
  if (s.tuning && !/^standard$/i.test(s.tuning)) b.push(`<span class="badge tun">${esc(s.tuning)}</span>`);
  const nImg = (S.images[s.id] || []).length;
  if (s.content && s.content.trim()) b.push(`<span class="badge">${s.type === "tabs" ? "TAB" : s.type === "both" ? "ACC+TAB" : "ACC"}</span>`);
  if (nImg) b.push(`<span class="badge">IMG ${nImg}</span>`);
  const ms = myStatus(s.id);
  if (ms) b.push(`<span class="badge st-${ms}">${STATUS[ms].toUpperCase()}</span>`);
  return b.join("");
}
function songRow(s){
  const sub = [s.artist, s.genre].filter(Boolean).map(esc).join(" · ") || "Artista non indicato";
  return `<button class="row" data-a="open-song" data-id="${esc(s.id)}"><span class="t">${esc(s.title)}</span><span class="badges">${songBadges(s)}</span><span class="s">${sub}</span></button>`;
}

/* song */
function songView(){
  const s = songById(S.songId);
  if (!s) return `<main class="wrap"><div class="empty"><h3>Brano non trovato</h3><button class="btn" data-a="nav-library">Torna ai brani</button></div></main>`;
  const pb = partBody(s);
  const hasChords = pb.part !== "lyrics" && songParts(s).items.some(x => x[0] === "chord");
  const meta = [];
  if (+s.capo) meta.push(`<span class="capo-big">CAPO AL ${+s.capo}° TASTO</span>`);
  if (s.tuning && !/^standard$/i.test(s.tuning)) meta.push(`<span class="pill tun">Accordatura: ${esc(s.tuning)}</span>`);
  if (s.key) meta.push(`<span class="pill">Tonalità: ${esc(s.key)}</span>`);
  if (s.bpm) meta.push(`<span class="pill">${esc(s.bpm)} BPM</span>`);
  if (s.duration) meta.push(`<span class="pill">${esc(s.duration)}</span>`);
  const imgs = S.images[s.id] || [];
  if (s.content && s.content.trim()) meta.push(`<span class="pill">${TYPE_LABEL[s.type] || "Accordi"}</span>`);
  if (imgs.length) meta.push(`<span class="pill">${imgs.length} ${imgs.length === 1 ? "immagine" : "immagini"}</span>`);
  let ctx = "";
  if (S.play){
    const p = plById(S.play.playlistId);
    if (p){
      const ids = p.songIds.filter(songById);
      const next = songById(ids[S.play.index + 1]);
      ctx = `<div class="pl-ctx"><span><b>${esc(p.name)}</b> · ${S.play.index + 1} di ${ids.length}</span><span class="spacer"></span><span>${next ? "Poi: " + esc(next.title) : "Ultimo brano"}</span></div>`;
    }
  }
  const pl = S.play ? plById(S.play.playlistId) : null;
  const plLen = pl ? pl.songIds.filter(songById).length : 0;
  return `<main class="wrap">
    <div style="display:flex;gap:8px;align-items:center;padding-top:12px">
      <button class="icon-btn" data-a="back" aria-label="Indietro"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>${S.play ? "Playlist" : "Brani"}</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-a="stage" title="Modalità palco: schermo intero">Palco</button>
      ${S.readOnly ? "" : `<button class="icon-btn" data-a="add-to-pl" data-id="${esc(s.id)}">+ Playlist</button>
      <button class="icon-btn" data-a="edit-song" data-id="${esc(s.id)}">Modifica</button>`}
    </div>
    ${ctx}
    <div class="song-head">
      <h1>${esc(s.title)}</h1>
      <div class="by">${[s.artist, s.genre].filter(Boolean).map(esc).join(" · ")}</div>
      ${s.updatedBy ? `<div class="by" style="font-size:13px">Ultima modifica di ${esc(s.updatedBy)}</div>` : ""}
      <div class="meta">${meta.join("")}</div>
      <div class="song-links">
        ${s.audio && /^https?:\/\//i.test(s.audio) ? `<a class="btn" href="${esc(s.audio)}" target="_blank" rel="noopener">▶ Ascolta</a>` : ""}
        <button class="btn" data-a="history" data-id="${esc(s.id)}">Cronologia</button>
      </div>
    </div>
    ${statusBlock(s)}
    ${s.notes ? `<div class="notes"><span class="lbl">Note della band</span>${esc(s.notes)}</div>` : ""}
    ${myNoteBlock(s)}
    ${pb.list.length > 1 ? `<div class="parts" role="tablist" aria-label="Cosa mostrare">${pb.list.map(k => `<button role="tab" aria-selected="${pb.part === k}" data-a="part" data-v="${k}">${PART_LABEL[k]}</button>`).join("")}</div>` : ""}
    ${pb.part !== "lyrics" && hasChords ? `<div class="chord-bar"><button class="link-btn" data-a="all-chords">Mostra le posizioni di tutti gli accordi</button><span class="hint">oppure tocca un accordo nel testo</span></div>` : ""}
    <div id="part-body">${pb.html}</div>
    ${s.source ? `<p class="src">Fonte: ${/^https?:\/\//i.test(s.source) ? `<a href="${esc(s.source)}" target="_blank" rel="noopener">${esc(s.source)}</a>` : esc(s.source)}</p>` : ""}
    <div class="song-pad"></div>
  </main>
  <div class="controls"><div class="wrap">
    ${S.play ? `<div class="ctl"><button data-a="prev" ${S.play.index <= 0 ? "disabled" : ""} aria-label="Brano precedente">‹</button><span class="val">${S.play.index + 1}/${plLen}</span><button data-a="next" ${S.play.index >= plLen - 1 ? "disabled" : ""} aria-label="Brano successivo">›</button></div>` : ""}
    <div class="ctl" title="Dimensione testo"><button data-a="font-dec" aria-label="Testo più piccolo">A−</button><span class="val">${S.font}px</span><button data-a="font-inc" aria-label="Testo più grande">A+</button></div>
    ${hasChords ? `<div class="ctl" title="Trasponi accordi"><button data-a="tr-dec" aria-label="Abbassa di un semitono">♭</button><button class="val" data-a="tr-reset" style="min-width:52px" aria-label="Azzera trasposizione">${S.transpose > 0 ? "+" : ""}${S.transpose} st</button><button data-a="tr-inc" aria-label="Alza di un semitono">♯</button></div>` : ""}
    <div class="ctl" title="Metronomo"><button data-a="metro" class="${S.metro ? "on" : ""}" aria-label="Metronomo" style="min-width:44px" id="metro-btn">♩</button><button data-a="metro-dec" aria-label="Più lento">−</button><span class="val" id="metro-val">${metroBpm(s)}</span><button data-a="metro-inc" aria-label="Più veloce">+</button></div>
    ${S.stage ? `<div class="ctl"><button data-a="stage" aria-label="Esci dalla modalità palco" style="min-width:60px">Esci</button></div>` : ""}
    <div class="ctl" title="Scorrimento automatico"><button data-a="scroll" class="${S.scrolling ? "on" : ""}" aria-label="${S.scrolling ? "Ferma scorrimento" : "Avvia scorrimento"}" style="min-width:44px">${S.scrolling ? "❚❚" : "▶"}</button><button data-a="speed-dec" aria-label="Più lento">−</button><span class="val">vel ${S.speed}</span><button data-a="speed-inc" aria-label="Più veloce">+</button></div>
  </div></div>`;
}

function statusBlock(s){
  const mine = myStatus(s.id);
  const others = Object.entries(S.status[s.id] || {}).filter(([k]) => k !== FB.uid).map(([, v]) => v).filter(v => v && v.s);
  return `<div class="status-row">
    <span class="lbl">Come la so</span>
    <div class="seg-mini" role="group" aria-label="Il mio stato per questo brano">${Object.entries(STATUS).map(([k, l]) => `<button data-a="set-status" data-v="${k}" aria-pressed="${mine === k}" class="st-${k}">${l}</button>`).join("")}</div>
    ${others.length ? `<div class="others">${others.map(v => `<span class="badge st-${v.s}">${esc(v.n || v.e)}: ${STATUS[v.s]}</span>`).join("")}</div>` : ""}
  </div>`;
}
function myNoteBlock(s){
  const t = S.myNotes[s.id] || "";
  if (S.editingNote === s.id) return `<div class="notes mine"><span class="lbl">Le mie note private · le vedi solo tu</span>
    <textarea id="my-note-ta" rows="3" aria-label="Le mie note private">${esc(t)}</textarea>
    <div class="row-actions" style="margin-top:8px"><button class="btn primary" data-a="note-save">Salva</button><button class="btn" data-a="note-cancel">Annulla</button></div></div>`;
  if (t) return `<div class="notes mine"><span class="lbl">Le mie note private · le vedi solo tu</span>${esc(t)}<button class="link-btn" style="display:block;margin-top:6px" data-a="note-edit">Modifica nota</button></div>`;
  return `<button class="link-btn" style="margin-top:10px" data-a="note-edit">+ Aggiungi una nota privata (la vedi solo tu)</button>`;
}

/* editor */
const TUNINGS = ["Standard", "Mezzo tono sotto (Eb)", "Un tono sotto (D)", "Drop D", "Drop C#", "Drop C", "Open G", "Open D", "Open E", "DADGAD"];
function editView(){
  const s = S.editId ? songById(S.editId) : null;
  const v = s || { title: "", artist: "", genre: "", type: "chords", capo: 0, tuning: "Standard", key: "", bpm: "", notes: "", content: "", source: "" };
  const genres = uniq(S.songs.map(x => x.genre));
  const artists = uniq(S.songs.map(x => x.artist));
  return `<main class="wrap">
    <div style="display:flex;gap:8px;align-items:center;padding-top:16px">
      <button class="icon-btn" data-a="cancel-edit" aria-label="Annulla"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Annulla</button>
      <h2 style="font-size:22px;margin-left:6px">${s ? "Modifica brano" : "Nuovo brano"}</h2>
    </div>
    <form class="form" id="song-form" autocomplete="off">
      <div class="field"><label for="e-title">Titolo *</label><input id="e-title" name="title" required value="${esc(v.title)}" placeholder="Es. Wish You Were Here"></div>
      <div class="field"><label for="e-artist">Artista</label><input id="e-artist" name="artist" list="dl-artists" value="${esc(v.artist)}" placeholder="Es. Pink Floyd"></div>
      <div class="field w2"><label for="e-genre">Genere</label><input id="e-genre" name="genre" list="dl-genres" value="${esc(v.genre)}" placeholder="Rock, Blues, Cantautori…"></div>
      <div class="field w2"><label for="e-capo">Capotasto</label><select id="e-capo" name="capo">${Array.from({ length: 13 }, (_, i) => `<option value="${i}" ${+v.capo === i ? "selected" : ""}>${i ? `Al ${i}° tasto` : "Nessuno"}</option>`).join("")}</select></div>
      <div class="field w2"><label for="e-tuning">Accordatura</label><input id="e-tuning" name="tuning" list="dl-tunings" value="${esc(v.tuning || "Standard")}"></div>
      <div class="field w2"><label>Contenuto</label><div class="seg" role="radiogroup" aria-label="Tipo di contenuto">
        ${["chords","tabs","both"].map(t => `<label><input type="radio" name="type" value="${t}" ${v.type === t ? "checked" : ""}><span>${t === "chords" ? "Accordi" : t === "tabs" ? "Tab" : "Entrambi"}</span></label>`).join("")}
      </div></div>
      <div class="field w2 half"><label for="e-key">Tonalità</label><input id="e-key" name="key" value="${esc(v.key)}" placeholder="Es. G"></div>
      <div class="field w2 half"><label for="e-bpm">BPM</label><input id="e-bpm" name="bpm" inputmode="numeric" value="${esc(v.bpm)}" placeholder="Es. 92"></div>
      <div class="field w2 half"><label for="e-duration">Durata</label><input id="e-duration" name="duration" value="${esc(v.duration || "")}" placeholder="Es. 3:45" inputmode="numeric"></div>
      <div class="field full"><label for="e-audio">Link per ascoltarlo</label><input id="e-audio" name="audio" value="${esc(v.audio || "")}" placeholder="Link YouTube o Spotify"></div>
      <div class="field full"><label for="e-notes">Note della band (le vedono tutti)</label><textarea id="e-notes" name="notes" rows="3" placeholder="Es. Intro solo con la chitarra acustica, il ritornello si ripete 2 volte, rallentare sul finale">${esc(v.notes)}</textarea></div>
      <h3 class="form-sec">Testo <span>per chi canta</span></h3>
      <div class="field full">
        <textarea id="e-lyrics" name="lyrics" class="lyr" rows="8" aria-label="Testo del brano" placeholder="Incolla qui solo le parole del brano.&#10;&#10;[Strofa 1]&#10;Prima riga del testo…&#10;&#10;[Ritornello]&#10;…">${esc(v.lyrics || "")}</textarea>
        <div class="row-actions"><button type="button" class="btn" data-a="lyr-from-chords">Ricava dagli accordi</button><span class="hint">Copia le righe di testo dal blocco Accordi e tab qui sotto, senza gli accordi.</span></div></div>
      <h3 class="form-sec">Accordi e tab <span>per chi suona</span></h3>
      <div class="field full">
        <textarea id="e-content" name="content" class="code" spellcheck="false" aria-label="Accordi e tablature" placeholder="Incolla qui tablatura o accordi copiati da internet, anche con il testo sotto.&#10;&#10;[Intro]&#10;G        D/F#     Em&#10;e|-----3-----2-----0-----|&#10;B|---3-----3-----0-------|">${esc(v.content)}</textarea>
        <span class="hint">Gli spazi vengono mantenuti, così gli accordi restano allineati sopra le parole. Le righe di soli accordi vengono evidenziate e si possono trasporre.</span></div>
      <h3 class="form-sec">Immagini <span>screenshot di accordi o spartiti</span></h3>
      <div class="field full">
        <div class="img-drop" id="img-drop">
          <div class="img-grid" id="img-grid"></div>
          <div class="img-actions"><label class="btn" for="img-input">+ Aggiungi immagini</label><input type="file" id="img-input" accept="image/*" multiple hidden></div>
          <span class="hint">Sul PC puoi anche incollarle con <b>Ctrl+V</b> o trascinarle qui. Vengono ridotte automaticamente per occupare poco spazio.</span>
        </div></div>
      <h3 class="form-sec">Altro</h3>
      <div class="field full"><label for="e-source">Link alla fonte</label><input id="e-source" name="source" value="${esc(v.source)}" placeholder="https://…"></div>
      <div class="form-actions">
        ${s ? `<button type="button" class="btn danger" data-a="delete-song" data-id="${esc(s.id)}">Elimina brano</button><span class="spacer"></span>` : ""}
        <button type="button" class="btn" data-a="cancel-edit">Annulla</button>
        <button type="submit" class="btn primary" id="save-btn">Salva brano</button>
      </div>
    </form>
    <datalist id="dl-genres">${genres.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <datalist id="dl-artists">${artists.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
    <datalist id="dl-tunings">${TUNINGS.map(g => `<option value="${esc(g)}">`).join("")}</datalist>
  </main>`;
}
function setupEditor(){
  const form = $("#song-form");
  S.editImages = (S.editId ? (S.images[S.editId] || []) : []).map(x => ({ id: x.id, data: x.data, prevOrder: x.order, isNew: false }));
  S.removedImages = [];
  drawEditImages();
  const input = $("#img-input");
  input.onchange = () => { addImageFiles([...input.files]); input.value = ""; };
  const drop = $("#img-drop");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addImageFiles([...e.dataTransfer.files]); });
  if (!S.editId) setTimeout(() => $("#e-title")?.focus(), 30);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const old = S.editId ? songById(S.editId) : null;
    const now = Date.now();
    const song = {
      id: old ? old.id : uid("s"),
      title: String(fd.get("title") || "").trim(),
      artist: String(fd.get("artist") || "").trim(),
      genre: String(fd.get("genre") || "").trim(),
      type: String(fd.get("type") || "chords"),
      capo: +fd.get("capo") || 0,
      tuning: String(fd.get("tuning") || "").trim() || "Standard",
      key: String(fd.get("key") || "").trim(),
      bpm: String(fd.get("bpm") || "").trim(),
      notes: String(fd.get("notes") || "").trim(),
      content: cleanContent(fd.get("content")).replace(/\s+$/, ""),
      lyrics: cleanContent(fd.get("lyrics")).replace(/\s+$/, ""),
      source: String(fd.get("source") || "").trim(),
      duration: normDuration(String(fd.get("duration") || "")),
      audio: String(fd.get("audio") || "").trim(),
      createdAt: old ? old.createdAt || now : now,
      updatedAt: now,
      createdBy: old ? old.createdBy || "" : FB.name,
      updatedBy: FB.name
    };
    if (!song.title){ $("#e-title").focus(); return; }
    if (S.imgBusy){ toast("Attendi: sto preparando le immagini"); return; }
    if (new Blob([JSON.stringify(song)]).size > 250000){ toast("Il testo è troppo lungo: prova a togliere le parti ripetute"); return; }
    $("#save-btn").disabled = true;
    if (old) saveHistory(old);
    const ok = await write("songs", song);
    if (ok) saveEditImages(song.id);
    if (ok){
      S.songId = song.id; S.view = "song"; S.transpose = 0; S.editId = null;
      toast(old ? "Modifiche salvate" : "Brano aggiunto");
      render(); window.scrollTo(0, 0);
    } else { const b = $("#save-btn"); if (b) b.disabled = false; }
  });
}

function normDuration(t){
  t = t.trim().replace(/[.,]/g, ":"); if (!t) return "";
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?$/); if (!m) return t;
  return m[2] === undefined ? `${+m[1]}:00` : `${+m[1]}:${m[2].length === 1 ? m[2] + "0" : m[2]}`;
}
function durSec(d){ const m = String(d || "").match(/^(\d+):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : 0; }
function fmtTotal(sec){ const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; }

/* ---------- immagini ---------- */
async function compressImage(file){
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let max = 1800, q = 0.78, out = "";
    for (let k = 0; k < 6; k++){
      const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL("image/jpeg", q);
      if (out.length < 650000) break;
      max = Math.round(max * 0.82); q = Math.max(0.5, q - 0.07);
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}
async function addImageFiles(files){
  const imgs = files.filter(f => f && /^image\//.test(f.type));
  if (!imgs.length){ if (files.length) toast("Puoi aggiungere solo immagini"); return; }
  S.imgBusy = true; drawEditImages();
  try {
    for (const f of imgs){
      try { const data = await compressImage(f); S.editImages.push({ id: uid("i"), data, isNew: true }); drawEditImages(); }
      catch { toast("Non riesco a leggere " + (f.name || "l'immagine")); }
    }
  } finally { S.imgBusy = false; drawEditImages(); }
}
function drawEditImages(){
  const g = $("#img-grid"); if (!g) return;
  const list = S.editImages;
  g.innerHTML = list.map((im, i) => `<div class="img-thumb"><img src="${im.data}" alt="Immagine ${i + 1}">
    <div class="img-tools">
      <button type="button" data-a="img-left" data-idx="${i}" aria-label="Sposta prima" ${i === 0 ? "disabled" : ""}>←</button>
      <button type="button" data-a="img-right" data-idx="${i}" aria-label="Sposta dopo" ${i === list.length - 1 ? "disabled" : ""}>→</button>
      <button type="button" data-a="img-del" data-idx="${i}" aria-label="Togli immagine">✕</button>
    </div></div>`).join("") + (S.imgBusy ? `<div class="img-thumb busy">Preparo…</div>` : "");
}
function saveEditImages(songId){
  for (const id of S.removedImages || []) FB.fs.deleteDoc(docRef("images", id)).catch(handleWriteError);
  const list = S.editImages.map((im, i) => ({ ...im, order: i }));
  const map = { ...S.images };
  map[songId] = list.map(im => ({ id: im.id, songId, data: im.data, order: im.order }));
  if (!list.length) delete map[songId];
  S.images = map;
  for (const im of list){
    if (im.isNew || im.order !== im.prevOrder) FB.fs.setDoc(docRef("images", im.id), { songId, data: im.data, order: im.order, createdBy: FB.name, createdAt: Date.now() }).catch(handleWriteError);
  }
  S.editImages = []; S.removedImages = [];
}
function deleteSongImages(songId){
  for (const im of S.images[songId] || []) FB.fs.deleteDoc(docRef("images", im.id)).catch(handleWriteError);
  const map = { ...S.images }; delete map[songId]; S.images = map;
}
function viewImage(idx){
  const imgs = S.images[S.songId] || [];
  let i = idx, zoom = 1;
  const root = $("#modal-root");
  const draw = () => {
    const im = imgs[i]; if (!im) return closeModal();
    root.innerHTML = `<div class="viewer" role="dialog" aria-modal="true" aria-label="Immagine ${i + 1} di ${imgs.length}">
      <div class="viewer-bar">
        <span>${i + 1} / ${imgs.length}</span><span class="spacer"></span>
        <button class="icon-btn" data-v="out" aria-label="Riduci">−</button>
        <button class="icon-btn" data-v="in" aria-label="Ingrandisci">+</button>
        ${imgs.length > 1 ? `<button class="icon-btn" data-v="prev" aria-label="Precedente" ${i === 0 ? "disabled" : ""}>‹</button><button class="icon-btn" data-v="next" aria-label="Successiva" ${i === imgs.length - 1 ? "disabled" : ""}>›</button>` : ""}
        <button class="icon-btn" data-v="close" aria-label="Chiudi">✕</button>
      </div>
      <div class="viewer-body"><img src="${im.data}" alt="Immagine ${i + 1}" style="width:${zoom * 100}%"></div>
    </div>`;
    root.querySelector(".viewer-bar").onclick = e => {
      const b = e.target.closest("[data-v]"); if (!b || b.disabled) return;
      const v = b.dataset.v;
      if (v === "close") return closeModal();
      if (v === "in") zoom = Math.min(4, zoom + 0.5);
      if (v === "out") zoom = Math.max(1, zoom - 0.5);
      if (v === "prev") { i--; zoom = 1; }
      if (v === "next") { i++; zoom = 1; }
      draw();
    };
  };
  draw();
}

/* playlists */
function playlistsView(){
  const list = [...S.playlists].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return `<main class="wrap">
    ${banner()}
    <div class="lib-head"><h1>Playlist</h1><span class="count">${list.length} ${list.length === 1 ? "playlist" : "playlist"}</span></div>
    <div class="list" style="padding-top:0">
      ${list.length ? list.map(p => {
        const songs = (p.songIds || []).map(songById).filter(Boolean);
        const genres = uniq(songs.map(s => s.genre)).slice(0, 3).join(", ");
        return `<button class="pl-row" data-a="open-pl" data-id="${esc(p.id)}"><span class="grow"><span class="t">${esc(p.name)}</span><br><span class="s">${songs.length} ${songs.length === 1 ? "brano" : "brani"}${genres ? " · " + esc(genres) : ""}</span></span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a8998a" stroke-width="2.4" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>`;
      }).join("") : `<div class="empty"><h3>Nessuna playlist</h3>Crea una scaletta per la sala prove, oppure filtra i brani per genere o artista e salvali come playlist.</div>`}
    </div>
  </main>
  ${S.readOnly ? "" : `<button class="fab" data-a="pl-new"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Nuova playlist</button>`}`;
}
function playlistView(){
  const p = plById(S.playlistId);
  if (!p) return `<main class="wrap"><div class="empty"><h3>Playlist non trovata</h3><button class="btn" data-a="nav-playlists">Torna alle playlist</button></div></main>`;
  const items = (p.songIds || []).map((id, i) => ({ id, i, s: songById(id) })).filter(x => x.s);
  const ro = S.readOnly;
  return `<main class="wrap">
    <div style="display:flex;gap:8px;align-items:center;padding-top:12px">
      <button class="icon-btn" data-a="nav-playlists" aria-label="Indietro"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Playlist</button>
      <span class="spacer"></span>
      ${ro ? "" : `<button class="icon-btn" data-a="pl-rename">Rinomina</button><button class="icon-btn" data-a="pl-delete" style="color:var(--danger)">Elimina</button>`}
    </div>
    <div class="lib-head"><h1>${esc(p.name)}</h1><span class="count">${items.length} ${items.length === 1 ? "brano" : "brani"}${(() => { const t = items.reduce((a, x) => a + durSec(x.s.duration), 0); const miss = items.filter(x => !durSec(x.s.duration)).length; return t ? ` · ${fmtTotal(t)}${miss ? ` (+${miss} senza durata)` : ""}` : ""; })()}</span></div>
    <div class="pl-actions">
      <button class="btn primary" data-a="pl-play" ${items.length ? "" : "disabled"}>▶ Inizia dal primo</button>
      ${ro ? "" : `<button class="btn" data-a="pl-add">+ Aggiungi brani</button>`}
    </div>
    <div class="list">
      ${items.length ? items.map((x, n) => `<div class="pl-item">
        <span class="pl-num">${n + 1}</span>
        <button class="grow" data-a="pl-open-song" data-idx="${n}"><span class="t">${esc(x.s.title)}</span>${readyForAll(x.s.id) ? ' <span class="badge st-ready">PRONTO</span>' : ""}<br><span class="s">${[x.s.artist, x.s.duration, +x.s.capo ? "Capo " + x.s.capo : "", x.s.tuning && !/^standard$/i.test(x.s.tuning) ? x.s.tuning : ""].filter(Boolean).map(esc).join(" · ")}</span></button>
        ${ro ? "" : `<span class="mini"><button data-a="pl-up" data-idx="${x.i}" aria-label="Sposta su" ${n === 0 ? "disabled" : ""}>↑</button><button data-a="pl-down" data-idx="${x.i}" aria-label="Sposta giù" ${n === items.length - 1 ? "disabled" : ""}>↓</button><button data-a="pl-remove" data-idx="${x.i}" aria-label="Togli dalla playlist">✕</button></span>`}
      </div>`).join("") : `<div class="empty"><h3>Playlist vuota</h3>Aggiungi i brani che vuoi suonare.</div>`}
    </div>
    ${logBlock(p)}
  </main>`;
}
function logBlock(p){
  const log = [...(p.log || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.at || 0) - (a.at || 0));
  const today = new Date().toISOString().slice(0, 10);
  const fmt = d => { try { return new Date(d + "T12:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "long", year: "numeric" }); } catch { return d; } };
  return `<section class="log">
    <h2>Diario delle prove</h2>
    ${S.readOnly ? "" : `<div class="log-form"><input type="date" id="log-date" value="${today}" aria-label="Data della prova"><textarea id="log-text" rows="2" placeholder="Com'è andata? Cosa sistemare la prossima volta…" aria-label="Note sulla prova"></textarea><button class="btn primary" data-a="log-add">Aggiungi</button></div>`}
    ${log.length ? log.map(e => `<div class="log-item"><div class="log-head"><b>${esc(fmt(e.date))}</b>${e.by ? ` · ${esc(e.by)}` : ""}<span class="spacer"></span>${S.readOnly ? "" : `<button class="icon-btn ghost" data-a="log-del" data-id="${esc(e.id)}" aria-label="Elimina nota">✕</button>`}</div><div class="log-text">${esc(e.text)}</div></div>`).join("") : `<p class="hint">Nessuna nota ancora. Dopo ogni prova scrivi cosa è andato bene e cosa sistemare.</p>`}
  </section>`;
}
function trashView(){
  const list = [...S.trash].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  const left = s => Math.max(0, 30 - Math.floor((Date.now() - (s.deletedAt || 0)) / DAY));
  return `<main class="wrap">
    <div style="display:flex;gap:8px;align-items:center;padding-top:12px"><button class="icon-btn" data-a="nav-library"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Brani</button></div>
    <div class="lib-head"><h1>Cestino</h1><span class="count">${list.length} ${list.length === 1 ? "brano" : "brani"}</span></div>
    <p class="hint" style="margin:0 0 10px">I brani restano qui 30 giorni, poi vengono eliminati per sempre.</p>
    <div class="list">${list.length ? list.map(s => `<div class="pl-item"><div class="grow" style="text-align:left"><span class="t">${esc(s.title)}</span><br><span class="s">${[s.artist, s.deletedBy ? "eliminato da " + s.deletedBy : "", `ancora ${left(s)} giorni`].filter(Boolean).map(esc).join(" · ")}</span></div>
      ${S.readOnly ? "" : `<button class="btn" data-a="trash-restore" data-id="${esc(s.id)}">Ripristina</button><button class="btn danger" data-a="trash-purge" data-id="${esc(s.id)}">Elimina</button>`}</div>`).join("") : `<div class="empty"><h3>Il cestino è vuoto</h3></div>`}</div>
  </main>`;
}

/* ---------- modal ---------- */
function modal({ title, body, actions, onMount }){
  const root = $("#modal-root");
  root.innerHTML = `<div class="scrim" data-scrim><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="icon-btn ghost" data-close aria-label="Chiudi">✕</button></header>
    <div class="body">${body}</div>
    ${actions ? `<footer>${actions}</footer>` : ""}
  </div></div>`;
  const scrim = root.firstElementChild;
  scrim.addEventListener("click", e => { if (e.target === scrim || e.target.closest("[data-close]")) closeModal(); });
  onMount && onMount(scrim);
}
function closeModal(){ $("#modal-root").innerHTML = ""; }
function confirmBox(title, text, okLabel, onOk){
  modal({ title, body: `<p style="margin:0;color:var(--muted)">${esc(text)}</p>`,
    actions: `<button class="btn" data-close>Annulla</button><button class="btn primary" id="m-ok" style="background:var(--danger);border-color:var(--danger)">${esc(okLabel)}</button>`,
    onMount: el => $("#m-ok", el).onclick = () => { closeModal(); onOk(); } });
}
function promptBox(title, label, value, okLabel, onOk){
  modal({ title, body: `<label for="m-in" style="font-size:13px;font-weight:700;color:var(--muted)">${esc(label)}</label><input type="text" id="m-in" value="${esc(value)}" placeholder="Es. Prove del giovedì">`,
    actions: `<button class="btn" data-close>Annulla</button><button class="btn primary" id="m-ok">${esc(okLabel)}</button>`,
    onMount: el => { const i = $("#m-in", el); setTimeout(() => { i.focus(); i.select(); }, 30);
      const go = () => { const v = i.value.trim(); if (!v){ i.focus(); return; } closeModal(); onOk(v); };
      $("#m-ok", el).onclick = go; i.onkeydown = e => { if (e.key === "Enter") go(); }; } });
}
function songPicker(title, preselected, okLabel, onOk){
  const sorted = [...S.songs].sort(byTitle);
  modal({ title,
    body: `<input type="text" id="m-search" placeholder="Cerca…" aria-label="Cerca brani"><div id="m-list" style="display:flex;flex-direction:column;gap:6px">${sorted.map(s => `<label class="check" data-text="${esc(norm(s.title + " " + s.artist + " " + s.genre))}"><input type="checkbox" value="${esc(s.id)}" ${preselected.has(s.id) ? "checked" : ""}><span><b>${esc(s.title)}</b><br><span class="s">${[s.artist, s.genre].filter(Boolean).map(esc).join(" · ")}</span></span></label>`).join("") || '<p style="color:var(--muted)">Non hai ancora brani nel repertorio.</p>'}</div>`,
    actions: `<button class="btn" data-close>Annulla</button><button class="btn primary" id="m-ok">${esc(okLabel)}</button>`,
    onMount: el => {
      $("#m-search", el).oninput = e => { const q = norm(e.target.value); el.querySelectorAll(".check").forEach(c => c.style.display = c.dataset.text.includes(q) ? "" : "none"); };
      $("#m-ok", el).onclick = () => { const ids = [...el.querySelectorAll("input[type=checkbox]:checked")].map(i => i.value); closeModal(); onOk(ids); };
    } });
}

/* ---------- autoscroll ---------- */
let raf = 0, last = 0, acc = 0, wake = null;
function tick(t){
  if (!S.scrolling) return;
  if (last){
    acc += (t - last) / 1000 * S.speed * 9;
    const px = Math.floor(acc);
    if (px){ window.scrollBy(0, px); acc -= px; }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2){ setScroll(false); return; }
  }
  last = t; raf = requestAnimationFrame(tick);
}
async function setScroll(on){
  S.scrolling = on; last = 0; acc = 0; cancelAnimationFrame(raf);
  if (on){ raf = requestAnimationFrame(tick); try { wake = await navigator.wakeLock?.request("screen"); } catch {} }
  else { try { await wake?.release(); } catch {} wake = null; }
  const b = document.querySelector('[data-a="scroll"]');
  if (b){ b.classList.toggle("on", on); b.textContent = on ? "❚❚" : "▶"; b.setAttribute("aria-label", on ? "Ferma scorrimento" : "Avvia scorrimento"); }
}

/* ---------- modalità palco ---------- */
let stageWake = null;
async function setStage(on, silent){
  S.stage = on;
  document.body.classList.toggle("stage", on);
  try {
    if (on){ await document.documentElement.requestFullscreen?.(); stageWake = await navigator.wakeLock?.request("screen"); }
    else { if (document.fullscreenElement) await document.exitFullscreen?.(); await stageWake?.release(); stageWake = null; }
  } catch {}
  if (!silent) render();
}
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && S.stage) setStage(false); });
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && S.stage && !stageWake){ try { stageWake = await navigator.wakeLock?.request("screen"); } catch {} } });
let touchX = 0, touchY = 0;
document.addEventListener("touchstart", e => { if (e.touches.length === 1){ touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } }, { passive: true });
document.addEventListener("touchend", e => {
  if (!S.stage || !S.play || S.view !== "song") return;
  const t = e.changedTouches[0]; const dx = t.clientX - touchX, dy = t.clientY - touchY;
  if (Math.abs(dx) > 90 && Math.abs(dy) < 60) (dx < 0 ? A.next : A.prev)();
}, { passive: true });

/* ---------- metronomo ---------- */
let audioCtx = null, metroTimer = 0, metroBeat = 0;
function metroBpm(s){ return S.metroBpm || +String(s && s.bpm || "").replace(/[^\d]/g, "") || 100; }
function click(accent){
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(accent ? 0.9 : 0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.07);
  const b = $("#metro-btn"); if (b){ b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 90); }
}
function startMetro(){
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); } catch { toast("Il metronomo non è supportato su questo dispositivo"); return; }
  stopMetro(true);
  const bpm = metroBpm(songById(S.songId));
  metroBeat = 0; S.metro = true;
  const beat = () => { click(metroBeat % 4 === 0); metroBeat++; };
  beat(); metroTimer = setInterval(beat, 60000 / bpm);
  $("#metro-btn")?.classList.add("on");
}
function stopMetro(keep){ clearInterval(metroTimer); metroTimer = 0; if (!keep){ S.metro = null; $("#metro-btn")?.classList.remove("on"); } }
function changeMetro(d){
  S.metroBpm = Math.max(30, Math.min(260, metroBpm(songById(S.songId)) + d));
  const v = $("#metro-val"); if (v) v.textContent = S.metroBpm;
  if (S.metro) startMetro();
}

/* ---------- ukulele e basso ---------- */
const INTERVALS = { "": [0,4,7], m: [0,3,7], "7": [0,4,7,10], m7: [0,3,7,10], maj7: [0,4,7,11], sus2: [0,2,7], sus4: [0,5,7], "7sus4": [0,5,7,10], "6": [0,4,7,9], m6: [0,3,7,9], "9": [0,4,10,2,7], add9: [0,4,7,2], dim: [0,3,6], dim7: [0,3,6,9], m7b5: [0,3,6,10], aug: [0,4,8], "5": [0,7] };
const UKE_OPEN = [7, 0, 4, 9]; // G C E A
function ukeShapes(name){
  const c = parseChord(name); if (!c) return [];
  const root = noteIdx(c.root); const iv = INTERVALS[c.q] || [0,4,7];
  const tones = iv.map(i => (root + i) % 12);
  const req = (iv.length > 4 ? iv.filter(i => i !== 7) : iv).map(i => (root + i) % 12);
  const found = [];
  for (let b = 0; b <= 9; b++){
    const cand = UKE_OPEN.map(o => { const fs = []; if (tones.includes(o % 12)) fs.push(0); for (let f = Math.max(1, b); f <= b + 3; f++) if (tones.includes((o + f) % 12)) fs.push(f); return fs; });
    if (cand.some(x => !x.length)) continue;
    let best = null;
    for (const a of cand[0]) for (const b2 of cand[1]) for (const c2 of cand[2]) for (const d of cand[3]){
      const fr = [a, b2, c2, d]; const notes = new Set(fr.map((f, i) => (UKE_OPEN[i] + f) % 12));
      if (!req.every(t => notes.has(t))) continue;
      const pos = fr.filter(f => f > 0); const span = pos.length ? Math.max(...pos) - Math.min(...pos) : 0;
      if (span > 3) continue;
      const score = Math.max(0, ...fr) * 2 + span - fr.filter(f => f === 0).length * 0.5 + pos.length * 0.2;
      if (!best || score < best.score) best = { fr, score };
    }
    if (best && !found.some(x => x.fr.join() === best.fr.join())) found.push(best);
  }
  return found.sort((a, b) => a.score - b.score).slice(0, 4).map(x => ({ frets: x.fr, label: Math.max(...x.fr) <= 4 ? "Prima posizione" : "Più in alto sul manico" }));
}
function bassShapes(name){
  const c = parseChord(name); if (!c) return [];
  const n = noteIdx(c.bass || c.root);
  return [[4, 0], [9, 1], [2, 2]].map(([open, i]) => { const f = ((n - open) % 12 + 12) % 12; const fr = [-1, -1, -1, -1]; fr[i] = f; return { frets: fr, label: `${c.bass || c.root} sulla corda ${["Mi", "La", "Re"][i]}` }; });
}

/* ---------- navigation ---------- */
function go(view, extra = {}){
  if (S.scrolling) setScroll(false);
  if (S.metro && !(view === "song" && S.stage)) stopMetro();
  if (view !== "song" && S.stage) setStage(false, true);
  S.editingNote = null;
  Object.assign(S, extra); S.prevView = S.view; S.view = view;
  render(); window.scrollTo(0, 0);
}
function playAt(playlistId, index){
  const p = plById(playlistId); if (!p) return;
  const ids = p.songIds.filter(songById);
  if (!ids[index]) return;
  go("song", { play: { playlistId, index }, songId: ids[index], transpose: 0 });
}
async function updatePl(p, changes){
  const np = { ...p, ...changes, updatedAt: Date.now() };
  const ok = write("playlists", np); render(); return ok;
}
async function newPlaylist(name, songIds){
  const p = { id: uid("p"), name, songIds: songIds || [], createdAt: Date.now(), updatedAt: Date.now() };
  const ok = await write("playlists", p);
  if (ok){ go("playlist", { playlistId: p.id }); }
}

/* ---------- actions ---------- */
const A = {
  "nav-library": () => go("library", { play: null }),
  "nav-playlists": () => go("playlists", { play: null }),
  "open-song": id => go("song", { songId: id, play: null, transpose: 0 }),
  "back": () => S.play ? go("playlist", { playlistId: S.play.playlistId, play: null }) : go("library"),
  "new-song": () => go("edit", { editId: null }),
  "edit-song": id => go("edit", { editId: id }),
  "cancel-edit": () => S.editId ? go("song", { songId: S.editId, editId: null }) : go("library", { editId: null }),
  "delete-song": id => {
    const s = songById(id); if (!s) return;
    confirmBox("Spostare il brano nel cestino?", `"${s.title}" finisce nel cestino: chiunque nella band può ripristinarlo entro 30 giorni.`, "Sposta nel cestino", () => {
      trashSong(s);
      toast("Brano spostato nel cestino"); go("library", { editId: null, songId: null });
    });
  },
  "genre": (_, el) => { S.f.genre = el.dataset.v; S.f.artist = ""; renderLibraryChrome(); renderLibraryList(); },
  "clear-f": () => { S.f = { q: "", genre: "", artist: "", type: "", status: "" }; render(); },
  "filter-to-pl": () => {
    const list = filteredSongs();
    const name = [S.f.genre, S.f.artist].filter(Boolean).join(" · ") || "Selezione";
    promptBox("Nuova playlist", "Nome della playlist", name, "Crea playlist", n => newPlaylist(n, list.map(s => s.id)));
  },
  "font-dec": () => { S.font = Math.max(8, S.font - 1); savePrefs(); updateSongDisplay(); },
  "font-inc": () => { S.font = Math.min(28, S.font + 1); savePrefs(); updateSongDisplay(); },
  "tr-dec": () => { S.transpose = S.transpose <= -11 ? 0 : S.transpose - 1; updateSongDisplay(); },
  "tr-inc": () => { S.transpose = S.transpose >= 11 ? 0 : S.transpose + 1; updateSongDisplay(); },
  "tr-reset": () => { S.transpose = 0; updateSongDisplay(); },
  "scroll": () => setScroll(!S.scrolling),
  "speed-dec": () => { S.speed = Math.max(1, S.speed - 1); savePrefs(); const v = document.querySelector('[data-a="speed-dec"] + .val'); if (v) v.textContent = "vel " + S.speed; },
  "speed-inc": () => { S.speed = Math.min(15, S.speed + 1); savePrefs(); const v = document.querySelector('[data-a="speed-dec"] + .val'); if (v) v.textContent = "vel " + S.speed; },
  "prev": () => S.play && playAt(S.play.playlistId, S.play.index - 1),
  "next": () => S.play && playAt(S.play.playlistId, S.play.index + 1),
  "add-to-pl": id => {
    const s = songById(id); if (!s) return;
    const pls = [...S.playlists].sort((a, b) => a.name.localeCompare(b.name, "it"));
    modal({ title: "Aggiungi a playlist",
      body: (pls.length ? pls.map(p => `<label class="check"><input type="checkbox" value="${esc(p.id)}" ${(p.songIds || []).includes(id) ? "checked" : ""}><span><b>${esc(p.name)}</b><br><span class="s">${(p.songIds || []).filter(songById).length} brani</span></span></label>`).join("") : `<p style="margin:0;color:var(--muted)">Non hai ancora playlist. Creane una qui sotto.</p>`) +
        `<div style="display:flex;gap:8px"><input type="text" id="m-newpl" placeholder="Nuova playlist…" aria-label="Nome nuova playlist"></div>`,
      actions: `<button class="btn" data-close>Annulla</button><button class="btn primary" id="m-ok">Salva</button>`,
      onMount: el => $("#m-ok", el).onclick = async () => {
        const checked = new Set([...el.querySelectorAll("input[type=checkbox]:checked")].map(i => i.value));
        const newName = $("#m-newpl", el).value.trim();
        closeModal();
        for (const p of pls){
          const has = (p.songIds || []).includes(id);
          if (checked.has(p.id) && !has) await updatePl(p, { songIds: [...(p.songIds || []), id] });
          if (!checked.has(p.id) && has) await updatePl(p, { songIds: p.songIds.filter(x => x !== id) });
        }
        if (newName){
          const p = { id: uid("p"), name: newName, songIds: [id], createdAt: Date.now(), updatedAt: Date.now() };
          write("playlists", p);
        }
        toast("Playlist aggiornate"); render();
      } });
  },
  "pl-new": () => promptBox("Nuova playlist", "Nome della playlist", "", "Crea playlist", n => newPlaylist(n, [])),
  "open-pl": id => go("playlist", { playlistId: id }),
  "pl-play": () => playAt(S.playlistId, 0),
  "pl-open-song": (_, el) => playAt(S.playlistId, +el.dataset.idx),
  "pl-add": () => {
    const p = plById(S.playlistId); if (!p) return;
    songPicker("Aggiungi brani", new Set(p.songIds || []), "Salva", ids => {
      const keep = (p.songIds || []).filter(x => ids.includes(x));
      const added = ids.filter(x => !keep.includes(x));
      updatePl(p, { songIds: [...keep, ...added] });
    });
  },
  "pl-up": (_, el) => movePl(+el.dataset.idx, -1),
  "pl-down": (_, el) => movePl(+el.dataset.idx, 1),
  "pl-remove": (_, el) => { const p = plById(S.playlistId); if (!p) return; const ids = [...p.songIds]; ids.splice(+el.dataset.idx, 1); updatePl(p, { songIds: ids }); },
  "pl-rename": () => { const p = plById(S.playlistId); if (p) promptBox("Rinomina playlist", "Nome della playlist", p.name, "Salva", n => updatePl(p, { name: n })); },
  "pl-delete": () => { const p = plById(S.playlistId); if (p) confirmBox("Eliminare la playlist?", `"${p.name}" verrà eliminata. I brani restano nel repertorio.`, "Elimina", async () => { if (await remove("playlists", p.id)){ toast("Playlist eliminata"); go("playlists"); } }); },
  "backup": () => backupDialog(),
  "login": () => login(),
  "logout": () => FB.au.signOut(FB.auth),
  "view-img": (_, el) => viewImage(+el.dataset.idx),
  "lyr-from-chords": () => {
    const ta = $("#e-lyrics"), src = $("#e-content");
    const p = songParts({ content: src.value, lyrics: "" });
    const txt = p.lyricItems.map(([t, l]) => t === "blank" ? "" : l).join("\n");
    if (!txt.trim()){ toast("Non trovo righe di testo negli accordi"); return; }
    if (ta.value.trim() && ta.value.trim() !== txt.trim()){
      confirmBox("Sostituire il testo?", "Il testo che hai scritto verrà sostituito con quello ricavato dagli accordi.", "Sostituisci", () => { ta.value = txt; toast("Testo ricavato dagli accordi"); });
      return;
    }
    ta.value = txt; toast("Testo ricavato dagli accordi");
  },
  "chord": (_, el) => showChord(el.dataset.c),
  "stage": () => setStage(!S.stage),
  "metro": () => S.metro ? stopMetro() : startMetro(),
  "metro-dec": () => changeMetro(-2),
  "metro-inc": () => changeMetro(2),
  "history": id => showHistory(id),
  "set-status": (_, el) => setStatus(S.songId, el.dataset.v),
  "note-edit": () => { S.editingNote = S.songId; render(); },
  "note-cancel": () => { S.editingNote = null; render(); },
  "note-save": () => { const t = $("#my-note-ta")?.value || ""; saveMyNote(S.songId, t); S.editingNote = null; toast(t.trim() ? "Nota salvata" : "Nota eliminata"); render(); },
  "trash": () => go("trash"),
  "trash-restore": id => { const s = S.trash.find(x => x.id === id); if (s){ restoreSong(s); toast("Brano ripristinato"); render(); } },
  "trash-purge": id => { const s = S.trash.find(x => x.id === id); if (s) confirmBox("Eliminare per sempre?", `"${s.title}" verrà cancellato definitivamente, con immagini e cronologia. Non si può annullare.`, "Elimina per sempre", () => { purgeSong(s); toast("Brano eliminato"); render(); }); },
  "log-add": () => {
    const p = plById(S.playlistId); if (!p) return;
    const text = ($("#log-text")?.value || "").trim(); const date = $("#log-date")?.value || new Date().toISOString().slice(0, 10);
    if (!text){ $("#log-text")?.focus(); return; }
    updatePl(p, { log: [...(p.log || []), { id: uid("l"), date, text, by: FB.name, at: Date.now() }] }); toast("Nota della prova aggiunta");
  },
  "log-del": id => { const p = plById(S.playlistId); if (p) confirmBox("Eliminare la nota?", "La nota della prova verrà eliminata.", "Elimina", () => updatePl(p, { log: (p.log || []).filter(e => e.id !== id) })); },
  "all-chords": () => showAllChords(),
  "part": (_, el) => { S.part = el.dataset.v; savePrefs(); render(); },
  "img-del": (_, el) => { const i = +el.dataset.idx; const [im] = S.editImages.splice(i, 1); if (im && !im.isNew) S.removedImages.push(im.id); drawEditImages(); },
  "img-left": (_, el) => { const i = +el.dataset.idx; if (i > 0){ const a = S.editImages; [a[i - 1], a[i]] = [a[i], a[i - 1]]; a[i - 1].moved = a[i].moved = true; drawEditImages(); } },
  "img-right": (_, el) => { const i = +el.dataset.idx; const a = S.editImages; if (i < a.length - 1){ [a[i + 1], a[i]] = [a[i], a[i + 1]]; a[i + 1].moved = a[i].moved = true; drawEditImages(); } },
  "move-legacy": () => moveLegacy(),
  "install": async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch {} installEvt = null; render(); }
};
function movePl(idx, dir){
  const p = plById(S.playlistId); if (!p) return;
  const ids = [...p.songIds];
  // skip over ids whose song no longer exists
  let j = idx + dir;
  while (j >= 0 && j < ids.length && !songById(ids[j])) j += dir;
  if (j < 0 || j >= ids.length) return;
  [ids[idx], ids[j]] = [ids[j], ids[idx]];
  updatePl(p, { songIds: ids });
}
function updateSongDisplay(){
  const s = songById(S.songId); if (!s) return;
  const body = $("#part-body"); if (!body) return;
  body.innerHTML = partBody(s).html;
  const fv = document.querySelector('[data-a="font-dec"] + .val'); if (fv) fv.textContent = S.font + "px";
  const tv = document.querySelector('[data-a="tr-reset"]'); if (tv) tv.textContent = (S.transpose > 0 ? "+" : "") + S.transpose + " st";
}

function setupMembers(el){
  const box = $("#m-members", el), input = $("#m-email", el);
  const draw = () => {
    box.innerHTML = S.members.map(m => `<div class="check" style="cursor:default;flex-wrap:wrap"><span style="flex:1;min-width:160px;word-break:break-all">${esc(m)}${m === OWNER_EMAIL ? ' <span class="s">(tu)</span>' : ""}</span>${m === OWNER_EMAIL ? "" : `<select data-role="${esc(m)}" aria-label="Permessi di ${esc(m)}"><option value="edit">Può modificare</option><option value="view" ${S.viewers.includes(m) ? "selected" : ""}>Solo lettura</option></select><button class="icon-btn ghost" data-rm="${esc(m)}" aria-label="Togli ${esc(m)}">✕</button>`}</div>`).join("");
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => saveMembers(S.members.filter(x => x !== b.dataset.rm)).then(draw));
    box.querySelectorAll("[data-role]").forEach(sel => sel.onchange = () => {
      const m = sel.dataset.role;
      S.viewers = sel.value === "view" ? [...new Set([...S.viewers, m])] : S.viewers.filter(x => x !== m);
      saveMembers(S.members); toast(sel.value === "view" ? "Ora può solo leggere" : "Ora può modificare");
    });
  };
  const add = async () => {
    const e = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)){ toast("Scrivi un'email valida"); input.focus(); return; }
    if (S.members.includes(e)){ toast("È già nella band"); return; }
    await saveMembers([...S.members, e]); input.value = ""; draw();
    toast("Aggiunto: ora può accedere con " + e);
  };
  $("#m-add", el).onclick = add;
  input.onkeydown = ev => { if (ev.key === "Enter") add(); };
  draw();
}
async function saveMembers(list){
  const members = [...new Set([OWNER_EMAIL, ...list.map(x => x.toLowerCase())])];
  S.members = members;
  S.viewers = S.viewers.filter(v => members.includes(v));
  FB.fs.setDoc(bandRef(), { name: S.bandName || "La band", members, viewers: S.viewers }).catch(handleWriteError);
}
function backupDialog(){
  const allImages = Object.values(S.images).flat();
  const data = JSON.stringify({ app: "repertorio", version: 2, exportedAt: new Date().toISOString(), songs: S.songs, playlists: S.playlists, images: allImages }, null, 1);
  const membersHtml = isOwner() ? `<hr style="border:0;border-top:1px solid var(--line);width:100%;margin:4px 0">
      <h3 style="font-size:17px">Membri della band</h3>
      <p style="margin:0;color:var(--muted);font-size:14px">Usa l'email del loro account Google. "Può modificare" aggiunge e cambia brani e playlist; "Solo lettura" li vede soltanto (utile per ospiti o turnisti).</p>
      <div id="m-members" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px"><input type="text" id="m-email" placeholder="email@gmail.com" aria-label="Email del nuovo membro" inputmode="email" autocomplete="off"><button class="btn primary" id="m-add">Aggiungi</button></div>` : "";
  modal({ title: "Band, account e backup",
    body: `<div class="acct"><span style="flex:1">Accesso come <b>${esc(FB.email)}</b>${S.readOnly ? " · solo lettura" : ""}<br><span style="font-size:12px">Versione app ${APP_VERSION}</span></span><button class="btn" id="m-logout">Esci</button></div>
      <button class="btn" data-a="trash" data-close>Cestino (${S.trash.length})</button>${membersHtml}
      <hr style="border:0;border-top:1px solid var(--line);width:100%;margin:4px 0">
      <p style="margin:0;color:var(--muted);font-size:14px">Scarica una copia di sicurezza con tutti i ${S.songs.length} brani e le ${S.playlists.length} playlist.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="m-dl">Scarica backup</button><button class="btn" id="m-copy">Copia negli appunti</button></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%;margin:4px 0">
      <p style="margin:0;color:var(--muted);font-size:14px">Per importare, scegli un file di backup o incolla il testo copiato dalla vecchia app. I brani già presenti vengono aggiornati, gli altri aggiunti.</p>
      <input type="file" id="m-file" accept=".json,.txt,application/json,text/plain" aria-label="File di backup">
      <textarea id="m-imp" placeholder="…oppure incolla qui il backup" aria-label="Incolla backup"></textarea>
      <button class="btn primary" id="m-import">Importa</button>`,
    onMount: el => {
      $("#m-logout", el).onclick = async () => { closeModal(); await FB.au.signOut(FB.auth); };
      if (isOwner()) setupMembers(el);
      $("#m-dl", el).onclick = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
        a.download = "repertorio-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        try { localStorage.setItem("repertorio-lastBackup", String(Date.now())); } catch {}
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
      $("#m-copy", el).onclick = async () => { try { await navigator.clipboard.writeText(data); toast("Backup copiato"); } catch { toast("Copia non riuscita, usa Scarica backup"); } };
      const f = $("#m-file", el); f.onchange = async () => { const file = f.files[0]; if (file) $("#m-imp", el).value = await file.text(); };
      const b = $("#m-import", el); b.onclick = async () => {
        let d; try { d = JSON.parse($("#m-imp", el).value); } catch { toast("Il testo non è un backup valido"); return; }
        const songs = (Array.isArray(d.songs) ? d.songs : []).filter(s => s && s.id && s.title);
        const pls = (Array.isArray(d.playlists) ? d.playlists : []).filter(p => p && p.id && p.name);
        if (!songs.length && !pls.length){ toast("Il backup non contiene brani"); return; }
        b.disabled = true;
        const imgsIn = (Array.isArray(d.images) ? d.images : []).filter(x => x && x.id && x.songId && typeof x.data === "string" && x.data.length < 900000);
        const all = [...songs.map(s => ["songs", { ...s, content: cleanContent(s.content) }]), ...pls.map(p => ["playlists", { ...p, songIds: Array.isArray(p.songIds) ? p.songIds : [] }]), ...imgsIn.map(x => ["images", x])];
        try {
          for (let i = 0; i < all.length; i += 12){
            const batch = FB.fs.writeBatch(FB.db);
            for (const [c, o] of all.slice(i, i + 12)) batch.set(docRef(c, String(o.id)), JSON.parse(JSON.stringify(o)));
            batch.commit().catch(handleWriteError);
          }
        } catch (e){ handleWriteError(e); b.disabled = false; return; }
        closeModal(); toast(`Importati ${songs.length} brani e ${pls.length} playlist`);
      };
    } });
}

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-a]");
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (fn){ e.preventDefault(); fn(el.dataset.id, el, e); }
});
document.addEventListener("paste", e => {
  if (S.view !== "edit" || !e.clipboardData) return;
  const files = [...e.clipboardData.items].filter(it => it.kind === "file" && /^image\//.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  addImageFiles(files);
  toast(files.length === 1 ? "Immagine incollata" : files.length + " immagini incollate");
});
(() => {
  const st = document.createElement("style");
  st.textContent = `
.upd-bar{position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top));z-index:80;max-width:560px;margin:0 auto;display:flex;align-items:center;gap:12px;background:var(--surface-2);border:1px solid var(--amber);border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.5);font-weight:600}
.upd-bar span{flex:1}
.song-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.song-links .btn{padding:7px 12px;font-size:14px;text-decoration:none;color:var(--text)}
.status-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:12px}
.status-row .lbl{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700}
.status-row .others{display:flex;gap:6px;flex-wrap:wrap;width:100%}
.seg-mini{display:inline-flex;gap:3px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:3px}
.seg-mini button{border:0;background:none;border-radius:7px;padding:6px 10px;font-weight:700;font-size:13px;color:var(--muted)}
.seg-mini button[aria-pressed="true"]{background:var(--surface-2);color:var(--text)}
.seg-mini button.st-learn[aria-pressed="true"]{background:#5b2f28;color:#ffd2c8}
.seg-mini button.st-almost[aria-pressed="true"]{background:#5a4320;color:#ffe1ad}
.seg-mini button.st-ready[aria-pressed="true"]{background:#1f4c45;color:#c4f1e8}
.instr{display:flex;width:100%}.instr button{flex:1}
.badge.st-learn{border-color:#e8735f;color:#e8735f}
.badge.st-almost{border-color:#f0a43c;color:#f0a43c}
.badge.st-ready{border-color:#6cc3b5;color:#6cc3b5}
.notes.mine{border-left-color:var(--teal)}
.notes.mine .lbl{color:var(--teal)}
.notes textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;font-weight:500}
.ctl button.flash{background:var(--teal)!important;color:var(--amber-ink)}
.hist{border:1px solid var(--line);border-radius:10px;padding:10px}
.hist-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px}
.hist-head .btn{padding:6px 10px;font-size:13px}
.hist-pre{margin:8px 0 0;font-family:var(--mono);font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--bg);border-radius:8px;padding:8px}
.log{margin:6px 0 120px;display:flex;flex-direction:column;gap:10px}
.log h2{font-size:20px;margin-top:10px}
.log-form{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:start}
.log-form input,.log-form textarea{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 10px}
@media (max-width:560px){.log-form{grid-template-columns:1fr}}
.log-item{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.log-head{display:flex;align-items:center;gap:6px;font-size:14px;color:var(--muted)}
.log-head b{color:var(--text)}
.log-text{white-space:pre-wrap;margin-top:4px}
body.stage .top, body.stage .song-head .by, body.stage .song-links, body.stage .status-row, body.stage .notes, body.stage .src, body.stage .chord-bar, body.stage main > div:first-child, body.stage .pl-ctx, body.stage main > .link-btn{display:none!important}
body.stage .song-head{padding-top:10px}
body.stage .song-head h1{font-size:20px}
body.stage .meta .pill{display:none}
body.stage .parts{margin-top:8px}
.sheet .ch{cursor:pointer;border-radius:4px}
.sheet .ch:hover{background:rgba(240,164,60,.15)}
.chord-bar{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-top:12px}
.chord-card{display:flex;flex-direction:column;align-items:center;gap:4px}
.chord-name{font-family:var(--display);font-weight:800;font-size:26px;color:var(--amber)}
.chord-note{font-size:13px;color:var(--muted);text-align:center}
.chord-tip{margin:8px 0 0;font-size:13px;color:var(--muted);text-align:center}
.chord-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.chord-cell{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:8px 4px}
.chord-cell .chord-name{font-size:18px}
.form-sec{grid-column:1 / -1;font-size:18px;margin-top:14px;padding-top:16px;border-top:1px solid var(--line);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.form-sec span{font-family:var(--body);font-size:13px;font-weight:600;color:var(--muted)}
.field textarea.lyr{font-size:16px;line-height:1.5;min-height:200px}
.row-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.parts{display:flex;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px;margin-top:14px}
.parts button{flex:1;border:0;background:none;border-radius:9px;padding:10px 6px;font-weight:700;color:var(--muted);font-size:15px}
.parts button[aria-selected="true"]{background:var(--amber);color:var(--amber-ink)}
.lyrics{margin-top:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 18px 22px;line-height:1.5;font-weight:500}
.ly-line{min-height:1em;overflow-wrap:anywhere}
.ly-gap{height:.9em}
.ly-sec{color:var(--teal);font-weight:700;font-size:.72em;letter-spacing:.08em;text-transform:uppercase;margin:.6em 0 .2em}
.ly-sec:first-child{margin-top:0}
.song-imgs{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.song-img{display:block;width:100%;padding:0;border:1px solid var(--line);border-radius:var(--r);background:#fff;overflow:hidden;cursor:zoom-in}
.song-img img{display:block;width:100%;height:auto}
.img-drop{display:flex;flex-direction:column;gap:10px;border:1px dashed var(--line);border-radius:var(--r);padding:12px}
.img-drop.over{border-color:var(--amber);background:var(--surface)}
.img-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.img-grid:empty{display:none}
.img-thumb{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;aspect-ratio:3/4}
.img-thumb img{width:100%;height:100%;object-fit:cover;object-position:top}
.img-thumb.busy{display:flex;align-items:center;justify-content:center;background:var(--surface);color:var(--muted);font-size:14px}
.img-tools{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;background:rgba(23,19,15,.85)}
.img-tools button{flex:1;border:0;background:none;height:32px;font-weight:700}
.img-tools button:disabled{opacity:.3}
.img-actions{display:flex;gap:8px}
.img-actions label.btn{cursor:pointer}
.viewer{position:fixed;inset:0;z-index:70;background:#000;display:flex;flex-direction:column}
.viewer-bar{display:flex;align-items:center;gap:6px;padding:8px 12px calc(8px);padding-top:calc(8px + env(safe-area-inset-top));background:var(--surface);color:var(--muted);font-family:var(--mono);font-size:13px}
.viewer-body{flex:1;overflow:auto;touch-action:pan-x pan-y pinch-zoom;-webkit-overflow-scrolling:touch}
.viewer-body img{display:block;margin:0 auto;max-width:none;height:auto;background:#fff}
`;
  document.head.appendChild(st);
})();
let resizeT = 0;
window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (S.view === "song") updateSongDisplay(); }, 150); });
document.addEventListener("input", e => {
  if (e.target.id === "q"){ S.f.q = e.target.value; renderLibraryList(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "f-artist"){ S.f.artist = e.target.value; renderLibraryList(); }
  if (e.target.id === "f-type"){ S.f.type = e.target.value; renderLibraryList(); }
  if (e.target.id === "f-status"){ S.f.status = e.target.value; renderLibraryList(); }
  if (e.target.id === "f-sort"){ S.sort = e.target.value; renderLibraryList(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#modal-root").innerHTML){ closeModal(); return; }
  if (S.view !== "song" || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || $("#modal-root").innerHTML) return;
  if (e.key === " "){ e.preventDefault(); setScroll(!S.scrolling); }
  else if (e.key === "PageDown" || (S.stage && e.key === "ArrowDown")){ e.preventDefault(); window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" }); }
  else if (e.key === "PageUp" || (S.stage && e.key === "ArrowUp")){ e.preventDefault(); window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "smooth" }); }
  else if (e.key === "Escape" && S.stage){ setStage(false); }
  else if (e.key === "ArrowRight" && S.play){ A.next(); }
  else if (e.key === "ArrowLeft" && S.play){ A.prev(); }
  else if (e.key === "+" || e.key === "="){ A["font-inc"](); }
  else if (e.key === "-"){ A["font-dec"](); }
});
// tapping the sheet pauses autoscroll
document.addEventListener("pointerdown", e => { if (S.scrolling && e.target.closest(".sheet")) setScroll(false); });

init();
