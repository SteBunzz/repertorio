import { firebaseConfig } from "./firebase-config.js";

/* ---------- state ---------- */
const prefs = loadPrefs();
const S = {
  songs: [], playlists: [],
  view: "library", prevView: "library",
  songId: null, editId: null, playlistId: null,
  play: null,               // {playlistId, index}
  f: { q: "", genre: "", artist: "", type: "" },
  sort: "title",
  transpose: 0,
  font: prefs.font || 15,
  speed: prefs.speed || 3,
  scrolling: false,
  mode: "loading",          // config | login | loading | ready | error
  pendingSongs: false, pendingPl: false, authError: "", members: [], bandName: "", legacy: null,
  readOnly: false,
  stale: false,
  loaded: { songs: false, playlists: false }
};

function loadPrefs(){ try { return JSON.parse(localStorage.getItem("repertorio-prefs") || "{}"); } catch { return {}; } }
function savePrefs(){ try { localStorage.setItem("repertorio-prefs", JSON.stringify({ font: S.font, speed: S.speed })); } catch {} }

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
function renderSheet(text, st){
  const lines = cleanContent(text).split("\n");
  let hasChords = false;
  const html = lines.map(line => {
    if (isChordLine(line)){
      hasChords = true;
      return transposeLine(line, st).replace(/\S+/g, t => CHORD_RE.test(t) ? `<span class="ch">${esc(t)}</span>` : esc(t));
    }
    if (SECTION_RE.test(line)) return `<span class="sec">${esc(line)}</span>`;
    return esc(line);
  }).join("\n");
  return { html, hasChords };
}
function cleanContent(t){ return String(t || "").replace(/\r\n?/g, "\n").replace(/\[\/?(ch|tab)\]/g, ""); }
function songHasChords(s){ return cleanContent(s.content).split("\n").some(isChordLine); }

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
  const arr = coll === "songs" ? S.songs : S.playlists;
  const i = arr.findIndex(x => x.id === clean.id);
  if (i >= 0) arr[i] = clean; else arr.push(clean);
  FB.fs.setDoc(docRef(coll, clean.id), clean).catch(handleWriteError);
  return true;
}
function remove(coll, id){
  if (coll === "songs") S.songs = S.songs.filter(x => x.id !== id); else S.playlists = S.playlists.filter(x => x.id !== id);
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
    try { db = fs.initializeFirestore(fapp, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
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
  unsubs.push(FB.fs.onSnapshot(bandRef(), d => { const m = d.exists() ? d.data().members : []; S.members = Array.isArray(m) ? m : []; S.bandName = d.exists() ? d.data().name || "" : ""; }, () => {}));
  let gotSongs = false, gotPl = false;
  const ready = () => { if (gotSongs && gotPl && S.mode === "loading"){ S.mode = "ready"; render(); } };
  unsubs.push(FB.fs.onSnapshot(colRef("songs"), opts, snap => {
    S.songs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    S.pendingSongs = snap.metadata.hasPendingWrites;
    gotSongs = true; ready(); if (S.mode === "ready") render(true);
  }, e => { handleWriteError(e); gotSongs = true; ready(); }));
  unsubs.push(FB.fs.onSnapshot(colRef("playlists"), opts, snap => {
    S.playlists = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    S.pendingPl = snap.metadata.hasPendingWrites;
    gotPl = true; ready(); if (S.mode === "ready") render(true);
  }, e => { handleWriteError(e); gotPl = true; ready(); }));
}
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
  app.innerHTML = html;
  if (v === "library") { renderLibraryList(); renderLibraryChrome(); }
  if (v === "edit") setupEditor();
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

function banner(){
  if (S.legacy) return `<div class="banner" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:200px">Hai <b>${S.legacy.songs.length} brani</b> salvati prima, nel tuo repertorio personale. Spostali nel repertorio della band così li vedono tutti.</span><button class="btn primary" data-a="move-legacy">Sposta nella band</button></div>`;
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
    (!q || norm(`${s.title} ${s.artist} ${s.genre} ${s.notes}`).includes(q))
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
      <input id="q" type="search" placeholder="Cerca titolo, artista, note…" value="${esc(S.f.q)}" aria-label="Cerca" autocomplete="off"></div>
    <div class="chips" id="chips" role="group" aria-label="Genere"></div>
    <div class="filters">
      <select id="f-artist" aria-label="Artista"></select>
      <select id="f-type" aria-label="Tipo">
        <option value="">Accordi e tab</option>
        <option value="chords" ${S.f.type==="chords"?"selected":""}>Solo accordi</option>
        <option value="tabs" ${S.f.type==="tabs"?"selected":""}>Solo tablature</option>
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
  const active = S.f.q || S.f.genre || S.f.artist || S.f.type;
  $("#count").textContent = active ? `${list.length} di ${S.songs.length}` : `${S.songs.length} ${S.songs.length === 1 ? "brano" : "brani"}`;
  $("#fa").innerHTML = active ? `<button class="link-btn" data-a="clear-f">Azzera filtri</button>${list.length && !S.readOnly ? `<button class="link-btn" data-a="filter-to-pl">Crea playlist con questi ${list.length} brani</button>` : ""}` : "";
  if (!S.songs.length){
    el.innerHTML = `<div class="empty"><h3>Il repertorio è vuoto</h3>Copia tab o accordi da un sito, tocca <b>Aggiungi brano</b> e incollali.<br>Puoi segnare capotasto, accordatura e le tue note.</div>`;
    return;
  }
  if (!list.length){ el.innerHTML = `<div class="empty"><h3>Nessun brano trovato</h3>Prova a cambiare i filtri.</div>`; return; }
  el.innerHTML = list.map(songRow).join("");
}
function songBadges(s){
  const b = [];
  if (+s.capo) b.push(`<span class="badge capo">CAPO ${+s.capo}</span>`);
  if (s.tuning && !/^standard$/i.test(s.tuning)) b.push(`<span class="badge tun">${esc(s.tuning)}</span>`);
  b.push(`<span class="badge">${s.type === "tabs" ? "TAB" : s.type === "both" ? "ACC+TAB" : "ACC"}</span>`);
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
  const { html, hasChords } = renderSheet(s.content, S.transpose);
  const meta = [];
  if (+s.capo) meta.push(`<span class="capo-big">CAPO AL ${+s.capo}° TASTO</span>`);
  if (s.tuning && !/^standard$/i.test(s.tuning)) meta.push(`<span class="pill tun">Accordatura: ${esc(s.tuning)}</span>`);
  if (s.key) meta.push(`<span class="pill">Tonalità: ${esc(s.key)}</span>`);
  if (s.bpm) meta.push(`<span class="pill">${esc(s.bpm)} BPM</span>`);
  meta.push(`<span class="pill">${TYPE_LABEL[s.type] || "Accordi"}</span>`);
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
      ${S.readOnly ? "" : `<button class="icon-btn" data-a="add-to-pl" data-id="${esc(s.id)}">+ Playlist</button>
      <button class="icon-btn" data-a="edit-song" data-id="${esc(s.id)}">Modifica</button>`}
    </div>
    ${ctx}
    <div class="song-head">
      <h1>${esc(s.title)}</h1>
      <div class="by">${[s.artist, s.genre].filter(Boolean).map(esc).join(" · ")}</div>
      ${s.updatedBy ? `<div class="by" style="font-size:13px">Ultima modifica di ${esc(s.updatedBy)}</div>` : ""}
      <div class="meta">${meta.join("")}</div>
    </div>
    ${s.notes ? `<div class="notes"><span class="lbl">Le mie note</span>${esc(s.notes)}</div>` : ""}
    <div class="sheet"><pre id="sheet" style="font-size:${S.font}px">${html || '<span style="color:var(--muted)">Nessun contenuto. Tocca Modifica per incollare tab o accordi.</span>'}</pre></div>
    ${s.source ? `<p class="src">Fonte: ${/^https?:\/\//i.test(s.source) ? `<a href="${esc(s.source)}" target="_blank" rel="noopener">${esc(s.source)}</a>` : esc(s.source)}</p>` : ""}
    <div class="song-pad"></div>
  </main>
  <div class="controls"><div class="wrap">
    ${S.play ? `<div class="ctl"><button data-a="prev" ${S.play.index <= 0 ? "disabled" : ""} aria-label="Brano precedente">‹</button><span class="val">${S.play.index + 1}/${plLen}</span><button data-a="next" ${S.play.index >= plLen - 1 ? "disabled" : ""} aria-label="Brano successivo">›</button></div>` : ""}
    <div class="ctl" title="Dimensione testo"><button data-a="font-dec" aria-label="Testo più piccolo">A−</button><span class="val">${S.font}px</span><button data-a="font-inc" aria-label="Testo più grande">A+</button></div>
    ${hasChords ? `<div class="ctl" title="Trasponi accordi"><button data-a="tr-dec" aria-label="Abbassa di un semitono">♭</button><button class="val" data-a="tr-reset" style="min-width:52px" aria-label="Azzera trasposizione">${S.transpose > 0 ? "+" : ""}${S.transpose} st</button><button data-a="tr-inc" aria-label="Alza di un semitono">♯</button></div>` : ""}
    <div class="ctl" title="Scorrimento automatico"><button data-a="scroll" class="${S.scrolling ? "on" : ""}" aria-label="${S.scrolling ? "Ferma scorrimento" : "Avvia scorrimento"}" style="min-width:44px">${S.scrolling ? "❚❚" : "▶"}</button><button data-a="speed-dec" aria-label="Più lento">−</button><span class="val">vel ${S.speed}</span><button data-a="speed-inc" aria-label="Più veloce">+</button></div>
  </div></div>`;
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
      <div class="field full"><label for="e-notes">Le mie note</label><textarea id="e-notes" name="notes" rows="3" placeholder="Es. Intro solo con la chitarra acustica, il ritornello si ripete 2 volte, rallentare sul finale">${esc(v.notes)}</textarea></div>
      <div class="field full"><label for="e-content">Tab o accordi</label>
        <textarea id="e-content" name="content" class="code" spellcheck="false" placeholder="Incolla qui tablatura o accordi copiati da internet.&#10;&#10;[Intro]&#10;G        D/F#     Em&#10;e|-----3-----2-----0-----|&#10;B|---3-----3-----0-------|">${esc(v.content)}</textarea>
        <span class="hint">Gli spazi vengono mantenuti, quindi gli accordi restano allineati sopra il testo. Le righe di soli accordi vengono evidenziate e si possono trasporre.</span></div>
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
      source: String(fd.get("source") || "").trim(),
      createdAt: old ? old.createdAt || now : now,
      updatedAt: now,
      createdBy: old ? old.createdBy || "" : FB.name,
      updatedBy: FB.name
    };
    if (!song.title){ $("#e-title").focus(); return; }
    if (new Blob([JSON.stringify(song)]).size > 250000){ toast("Il testo è troppo lungo: prova a togliere le parti ripetute"); return; }
    $("#save-btn").disabled = true;
    const ok = await write("songs", song);
    if (ok){
      S.songId = song.id; S.view = "song"; S.transpose = 0; S.editId = null;
      toast(old ? "Modifiche salvate" : "Brano aggiunto");
      render(); window.scrollTo(0, 0);
    } else { const b = $("#save-btn"); if (b) b.disabled = false; }
  });
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
    <div class="lib-head"><h1>${esc(p.name)}</h1><span class="count">${items.length} ${items.length === 1 ? "brano" : "brani"}</span></div>
    <div class="pl-actions">
      <button class="btn primary" data-a="pl-play" ${items.length ? "" : "disabled"}>▶ Inizia dal primo</button>
      ${ro ? "" : `<button class="btn" data-a="pl-add">+ Aggiungi brani</button>`}
    </div>
    <div class="list">
      ${items.length ? items.map((x, n) => `<div class="pl-item">
        <span class="pl-num">${n + 1}</span>
        <button class="grow" data-a="pl-open-song" data-idx="${n}"><span class="t">${esc(x.s.title)}</span><br><span class="s">${[x.s.artist, +x.s.capo ? "Capo " + x.s.capo : "", x.s.tuning && !/^standard$/i.test(x.s.tuning) ? x.s.tuning : ""].filter(Boolean).map(esc).join(" · ")}</span></button>
        ${ro ? "" : `<span class="mini"><button data-a="pl-up" data-idx="${x.i}" aria-label="Sposta su" ${n === 0 ? "disabled" : ""}>↑</button><button data-a="pl-down" data-idx="${x.i}" aria-label="Sposta giù" ${n === items.length - 1 ? "disabled" : ""}>↓</button><button data-a="pl-remove" data-idx="${x.i}" aria-label="Togli dalla playlist">✕</button></span>`}
      </div>`).join("") : `<div class="empty"><h3>Playlist vuota</h3>Aggiungi i brani che vuoi suonare.</div>`}
    </div>
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

/* ---------- navigation ---------- */
function go(view, extra = {}){
  if (S.scrolling) setScroll(false);
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
    confirmBox("Eliminare il brano?", `"${s.title}" verrà tolto dal repertorio e da tutte le playlist.`, "Elimina", async () => {
      const ok = await remove("songs", id);
      if (!ok) return;
      for (const p of S.playlists.filter(p => (p.songIds || []).includes(id))) await updatePl(p, { songIds: p.songIds.filter(x => x !== id) });
      toast("Brano eliminato"); go("library", { editId: null, songId: null });
    });
  },
  "genre": (_, el) => { S.f.genre = el.dataset.v; S.f.artist = ""; renderLibraryChrome(); renderLibraryList(); },
  "clear-f": () => { S.f = { q: "", genre: "", artist: "", type: "" }; render(); },
  "filter-to-pl": () => {
    const list = filteredSongs();
    const name = [S.f.genre, S.f.artist].filter(Boolean).join(" · ") || "Selezione";
    promptBox("Nuova playlist", "Nome della playlist", name, "Crea playlist", n => newPlaylist(n, list.map(s => s.id)));
  },
  "font-dec": () => { S.font = Math.max(10, S.font - 1); savePrefs(); updateSongDisplay(); },
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
  const pre = $("#sheet"); if (!pre) return;
  pre.style.fontSize = S.font + "px";
  pre.innerHTML = renderSheet(s.content, S.transpose).html;
  const fv = document.querySelector('[data-a="font-dec"] + .val'); if (fv) fv.textContent = S.font + "px";
  const tv = document.querySelector('[data-a="tr-reset"]'); if (tv) tv.textContent = (S.transpose > 0 ? "+" : "") + S.transpose + " st";
}

function setupMembers(el){
  const box = $("#m-members", el), input = $("#m-email", el);
  const draw = () => {
    box.innerHTML = S.members.map(m => `<div class="check" style="cursor:default"><span style="flex:1;word-break:break-all">${esc(m)}${m === OWNER_EMAIL ? ' <span class="s">(tu)</span>' : ""}</span>${m === OWNER_EMAIL ? "" : `<button class="icon-btn ghost" data-rm="${esc(m)}" aria-label="Togli ${esc(m)}">✕</button>`}</div>`).join("");
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => saveMembers(S.members.filter(x => x !== b.dataset.rm)).then(draw));
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
  FB.fs.setDoc(bandRef(), { name: S.bandName || "La band", members }).catch(handleWriteError);
}
function backupDialog(){
  const data = JSON.stringify({ app: "repertorio", version: 1, exportedAt: new Date().toISOString(), songs: S.songs, playlists: S.playlists }, null, 1);
  const membersHtml = isOwner() ? `<hr style="border:0;border-top:1px solid var(--line);width:100%;margin:4px 0">
      <h3 style="font-size:17px">Membri della band</h3>
      <p style="margin:0;color:var(--muted);font-size:14px">Chi è in questo elenco può vedere, aggiungere e modificare tutti i brani e le playlist. Usa l'email del loro account Google.</p>
      <div id="m-members" style="display:flex;flex-direction:column;gap:6px"></div>
      <div style="display:flex;gap:8px"><input type="text" id="m-email" placeholder="email@gmail.com" aria-label="Email del nuovo membro" inputmode="email" autocomplete="off"><button class="btn primary" id="m-add">Aggiungi</button></div>` : "";
  modal({ title: "Band, account e backup",
    body: `<div class="acct"><span style="flex:1">Accesso come <b>${esc(FB.email)}</b></span><button class="btn" id="m-logout">Esci</button></div>${membersHtml}
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
        const all = [...songs.map(s => ["songs", { ...s, content: cleanContent(s.content) }]), ...pls.map(p => ["playlists", { ...p, songIds: Array.isArray(p.songIds) ? p.songIds : [] }])];
        try {
          for (let i = 0; i < all.length; i += 400){
            const batch = FB.fs.writeBatch(FB.db);
            for (const [c, o] of all.slice(i, i + 400)) batch.set(docRef(c, String(o.id)), JSON.parse(JSON.stringify(o)));
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
document.addEventListener("input", e => {
  if (e.target.id === "q"){ S.f.q = e.target.value; renderLibraryList(); }
});
document.addEventListener("change", e => {
  if (e.target.id === "f-artist"){ S.f.artist = e.target.value; renderLibraryList(); }
  if (e.target.id === "f-type"){ S.f.type = e.target.value; renderLibraryList(); }
  if (e.target.id === "f-sort"){ S.sort = e.target.value; renderLibraryList(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#modal-root").innerHTML){ closeModal(); return; }
  if (S.view !== "song" || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || $("#modal-root").innerHTML) return;
  if (e.key === " "){ e.preventDefault(); setScroll(!S.scrolling); }
  else if (e.key === "ArrowRight" && S.play){ A.next(); }
  else if (e.key === "ArrowLeft" && S.play){ A.prev(); }
  else if (e.key === "+" || e.key === "="){ A["font-inc"](); }
  else if (e.key === "-"){ A["font-dec"](); }
});
// tapping the sheet pauses autoscroll
document.addEventListener("pointerdown", e => { if (S.scrolling && e.target.closest(".sheet")) setScroll(false); });

init();
