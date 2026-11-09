const $ = (id) => document.getElementById(id);
const v = $('v');
let session, ws, library = [], current, offset = 0, quietUntil = 0;

// localStorage can throw (private windows etc.), so every use is guarded.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch {} },
  set(k, x) { try { localStorage.setItem(k, x); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const setStatus = (t) => { $('status').textContent = t; $('status').dataset.ok = String(t === 'connected'); };

// ---------- login ----------
$('login').onsubmit = async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }),
    });
    if (!r.ok) { $('err').textContent = r.status === 401 ? 'Wrong password' : `Login failed (${r.status})`; return; }
    start(await r.json(), true);
  } catch { $('err').textContent = 'Network error'; }
};

function logout() {
  const old = ws;
  session = null;
  store.del('session');
  old?.close();
  $('app').hidden = true;
  $('login').hidden = false;
}

async function start(s, fresh) {
  session = s;
  store.set('session', JSON.stringify(s));
  $('login').hidden = true;
  $('app').hidden = false;
  const r = await fetch('/videos/library.json', { cache: 'no-store' });
  if (r.status === 403 && !fresh) return logout(); // cookie expired
  if (r.ok) {
    library = await r.json();
    renderLibrary();
    const last = library.find((x) => x.video === store.get('last'));
    if (last) open(last); // reopen what we were watching, paused at the saved position
  } else {
    setStatus('Could not load videos/library.json – has it been uploaded?');
  }
  connect();
}

// ---------- library (list) + player ----------
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });

function renderLibrary() {
  $('cards').replaceChildren(...library.map((e, i) => {
    const b = el('button', 'item');
    b.dataset.video = e.video;
    b.append(el('span', 'n', String(i + 1).padStart(2, '0')));
    if (e.poster) { // optional "poster" in library.json
      const th = el('span', 'thumb');
      th.style.backgroundImage = `url("/videos/${encodeURI(e.poster)}")`;
      b.append(th);
    }
    b.append(el('span', 't', e.title), el('span', 's', 'Now playing'));
    b.onclick = () => {
      if (e.video === current) return;
      open(e);
      send({ type: 'load', video: e.video });
      scrollTo({ top: 0, behavior: 'smooth' });
    };
    return b;
  }));
  if (!library.length) $('cards').replaceChildren(el('p', 'empty', 'No videos yet. Add some to videos/library.json and run upload.ps1.'));
  markCurrent();
}
const markCurrent = () => {
  for (const b of $('cards').children) b.setAttribute('aria-pressed', String(b.dataset.video === current));
};

function open(e) {
  const resume = Number(store.get('pos:' + e.video)) || 0; // read before the src change resets the player
  current = e.video;
  markCurrent();
  $('nowtitle').textContent = e.title;
  $('player').hidden = false;
  quiet();
  v.replaceChildren();
  v.src = '/videos/' + encodeURI(e.video);
  v.addEventListener('loadedmetadata', () => {
    if (resume > 5 && resume < v.duration - 10) { quiet(); v.currentTime = resume; } // skip if near the start or the end
  }, { once: true });
  offset = Number(store.get('off:' + e.video)) || 0;
  showOffset();
  (e.subs || []).forEach((s, i) => {
    const t = document.createElement('track');
    Object.assign(t, { kind: 'subtitles', src: '/videos/' + encodeURI(s.file), srclang: s.lang, label: s.label, default: i === 0 });
    t.addEventListener('load', shift); // cues exist only after the track loads
    v.append(t);
  });
}

// ---------- subtitle timing (per viewer) ----------
function shift() {
  for (const t of v.textTracks) {
    for (const c of t.cues || []) {
      c.o ??= [c.startTime, c.endTime]; // remember the original times
      c.startTime = Math.max(0, c.o[0] + offset);
      c.endTime = Math.max(0, c.o[1] + offset);
      if (sub.line == null) { c.snapToLines = true; c.line = 'auto'; c.lineAlign = 'start'; } // browser decides
      else { c.snapToLines = false; c.line = sub.line; c.lineAlign = 'end'; } // fixed: % from the top, bottom edge of the text
    }
  }
}
const showOffset = () => { $('off').textContent = (offset > 0 ? '+' : '') + offset.toFixed(1) + 's'; };
const nudge = (d) => {
  offset = Math.round((offset + d) * 10) / 10;
  if (current) store.set('off:' + current, offset);
  showOffset();
  shift();
};
$('earlier').onclick = () => nudge(-0.5);
$('later').onclick = () => nudge(0.5);

// ---------- subtitle look (per viewer, saved) ----------
const EDGES = ['None', 'Thin', 'Medium', 'Thick', 'Heavy'];
const sub = { size: 100, color: '#ffffff', border: 2, line: null }; // line null = automatic position
try { Object.assign(sub, JSON.parse(store.get('sub') || '{}')); } catch {}
if (!/^#[0-9a-f]{6}$/i.test(sub.color)) sub.color = '#ffffff';
sub.size = Math.min(300, Math.max(60, Number(sub.size) || 100));
const edge = Math.round(Number(sub.border));
sub.border = Number.isFinite(edge) ? Math.min(4, Math.max(0, edge)) : 2;
sub.line = sub.line == null ? null : Math.min(95, Math.max(10, Number(sub.line) || 90));

function applyCueStyle() {
  const w = sub.border; // outline = a dark shadow repeated in 16 directions
  const outline = w
    ? Array.from({ length: 16 }, (_, i) => {
      const a = (i * Math.PI) / 8;
      return `${(w * Math.cos(a)).toFixed(1)}px ${(w * Math.sin(a)).toFixed(1)}px 1px #000`;
    }).join(',')
    : 'none';
  $('cue').textContent = `video::cue{background:transparent;color:${sub.color};font-size:${sub.size}%;` +
    `font-weight:600;font-family:system-ui,sans-serif;text-shadow:${outline}}`;

  // the preview mimics the real thing: default cue text is about 2.8% of the video width
  const s = $('sample').style;
  s.color = sub.color;
  s.textShadow = outline;
  s.fontSize = `${(2.8 * sub.size) / 100}cqw`;
  s.bottom = sub.line == null ? '6%' : 100 - sub.line + '%';

  $('size').textContent = sub.size + '%';
  $('edge').textContent = EDGES[sub.border];
  $('pos').textContent = sub.line == null ? 'Auto' : 100 - sub.line + '%'; // custom = height from the bottom
  $('sizeR').value = sub.size;
  $('borderR').value = sub.border;
  if (sub.line != null) $('posR').value = 100 - sub.line;
  $('auto').checked = sub.line == null;
  $('color').value = sub.color;
  for (const b of document.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.color === sub.color.toLowerCase()));
  store.set('sub', JSON.stringify(sub));
}
$('sizeR').oninput = (e) => { sub.size = Number(e.target.value); applyCueStyle(); };
$('borderR').oninput = (e) => { sub.border = Number(e.target.value); applyCueStyle(); };
$('posR').oninput = (e) => { sub.line = 100 - Number(e.target.value); applyCueStyle(); shift(); }; // moving it ends "Auto"
$('auto').onchange = (e) => { sub.line = e.target.checked ? null : 100 - Number($('posR').value); applyCueStyle(); shift(); };
$('color').oninput = (e) => { sub.color = e.target.value; applyCueStyle(); };
for (const b of document.querySelectorAll('.swatch')) b.onclick = () => { sub.color = b.dataset.color; applyCueStyle(); };
$('posR').value = 10; // where the slider starts when switching from Auto
applyCueStyle();

// ---------- sync ----------
// Applying a remote command fires our own play/pause/seeked events; ignore those briefly.
const quiet = () => { quietUntil = Date.now() + 600; };
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

for (const [ev, type] of [['play', 'play'], ['pause', 'pause'], ['seeked', 'seek']]) {
  v.addEventListener(ev, () => { if (Date.now() > quietUntil) send({ type, time: v.currentTime }); });
}

// ---------- remember where we left off (per device) ----------
let lastSave = 0;
const savePos = () => {
  if (!current || v.readyState < 1) return; // not loaded yet: currentTime would be 0
  store.set('pos:' + current, v.currentTime);
  store.set('last', current);
};
v.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 5000) { lastSave = Date.now(); savePos(); } });
v.addEventListener('pause', savePos);
addEventListener('pagehide', savePos);

const ready = (fn) => {
  const run = () => { quiet(); fn(); };
  if (v.readyState >= 1) run(); else v.addEventListener('loadedmetadata', run, { once: true });
};
const setTime = (t) => { if (Math.abs(v.currentTime - t) > 0.5) v.currentTime = t; };
const play = () => v.play().catch(() => setStatus('Press play (browser blocked autoplay)'));

function onMessage(m) {
  quiet();
  const entry = library.find((x) => x.video === m.video);
  if (m.type === 'load') { if (entry) open(entry); return; }
  if (m.type === 'state-request') {
    if (current) send({ type: 'state', video: current, time: v.currentTime, playing: !v.paused });
    return;
  }
  if (m.type === 'state' && entry && m.video !== current) open(entry);
  if (!current || typeof m.time !== 'number') return;
  ready(() => {
    setTime(m.time);
    if (m.type === 'pause' || (m.type === 'state' && !m.playing)) v.pause();
    else if (m.type === 'play' || m.type === 'state') play();
  });
}

$('match').onclick = () => send({ type: 'state-request' });

function connect() {
  if (!session || (ws && ws.readyState < 2)) return;
  if (session.exp < Date.now() / 1000) return logout();
  ws = new WebSocket(session.wsUrl + '?token=' + encodeURIComponent(session.token));
  ws.onopen = () => { setStatus('connected'); send({ type: 'state-request' }); };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { if (session) { setStatus('reconnecting…'); setTimeout(connect, 3000); } };
}
// API Gateway drops idle sockets after 10 min; a ping keeps it alive while paused.
setInterval(() => send({ type: 'ping' }), 240000);

// ---------- resume a previous login ----------
try {
  const saved = JSON.parse(store.get('session') || 'null');
  if (saved && saved.exp > Date.now() / 1000) start(saved, false);
} catch {}
