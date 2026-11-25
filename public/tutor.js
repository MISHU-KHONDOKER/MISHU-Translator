// MISHU Tutor - vocabulary + speaking practice (the "Tutor" tab).
// Each word: meaning and core idea -> 10 native sentences from different situations, each explained
// (who / when / feeling / hidden meaning) and repeated aloud by the learner (checked by speech
// recognition) -> "your turn" tasks graded by the tutor -> spaced-repetition quiz reviews, always
// medium -> hard. Lessons and grading come from the server (/api/tutor/*).

const B = window.mishuBridge;
const view = document.getElementById('tutor');

// ---------------------------------------------------------------- helpers

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayStr(new Date());
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); };
const firstMeaning = (m) => String(m || '').split(';')[0].trim();

const local = {
  get(k, f) { try { const v = localStorage.getItem(`mishu.${k}`); return v == null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(`mishu.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

async function api(route, body) {
  await B.keyReady;
  const url = `/api/tutor/${route}${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(B.key())}`;
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

let toastTimer;
function toast(text) {
  let el = document.getElementById('tutorToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tutorToast';
    el.className = 't-toast';
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------------------------------------------------------------- progress (saved on the server)

const LEVELS = [
  [1, 'HSK 1', 'Absolute basics', 506], [2, 'HSK 2', 'Simple daily talk', 750], [3, 'HSK 3', 'Everyday life & work basics', 953],
  [4, 'HSK 4', 'Comfortable daily conversation', 972], [5, 'HSK 5', 'Work, news, opinions', 1059],
  [6, 'HSK 6', 'Fluent, nuanced speech', 1123], [7, 'HSK 7-9', 'Near-native, professional', 5606],
];
const levelName = (n) => LEVELS.find((l) => l[0] === n)?.[1] || `HSK ${n}`;
// Days until the next review, by box (box goes up with each correct answer).
const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120];

let state = null;
let saveTimer;

async function loadState() {
  const cached = local.get('tutorState', null);
  try {
    const { state: remote } = await api('state');
    state = remote && (!cached || (remote.saved || 0) >= (cached.saved || 0)) ? remote : cached;
  } catch {
    state = cached;
  }
}

function save() {
  state.saved = Date.now();
  local.set('tutorState', state);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('state', state).catch(() => {}), 800);
}

function activity(kind, n = 1) {
  const d = today();
  const day = (state.days[d] ??= { newWords: 0, sentences: 0, quiz: 0 });
  day[kind] = (day[kind] || 0) + n;
  if (state.streak.last !== d) {
    state.streak.count = state.streak.last === addDays(-1) ? state.streak.count + 1 : 1;
    state.streak.last = d;
  }
  // Keep only the last 400 days of history.
  const keys = Object.keys(state.days).sort();
  while (keys.length > 400) delete state.days[keys.shift()];
  save();
}

const learnedCount = () => Object.keys(state.words).length;
const knownCount = () => Object.values(state.words).filter((w) => w.box >= 4).length;
const dueWords = () => Object.entries(state.words).filter(([, w]) => w.due <= today()).sort((a, b) => a[1].due.localeCompare(b[1].due)).map(([k]) => k);
const streakNow = () => (state.streak.last === today() || state.streak.last === addDays(-1) ? state.streak.count : 0);

// ---------------------------------------------------------------- word lists & lessons

const levelCache = {};
async function levelWords(level) {
  levelCache[level] ??= api(`words?level=${level}`).then((r) => r.words);
  return levelCache[level];
}

const lessonCache = {};
function getLesson(word) {
  lessonCache[word] ??= api(`lesson?word=${encodeURIComponent(word)}`).catch((err) => { delete lessonCache[word]; throw err; });
  return lessonCache[word];
}

async function nextNewWords(n) {
  const list = await levelWords(state.level);
  return list.filter((w) => !state.words[w[0]]).slice(0, n);
}

// ---------------------------------------------------------------- voice (native Chinese)

let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => /^zh[-_]CN/i.test(v.lang));
  zhVoice = vs.find((v) => /premium|enhanced/i.test(v.name)) || vs.find((v) => /ting|婷/i.test(v.name)) || vs[0] || null;
}
pickVoice();
speechSynthesis.addEventListener?.('voiceschanged', pickVoice);

let sayTimer;
function phoneSay(text, slow = false, onEnd = null) {
  if (!text) return;
  // iOS Safari often drops an utterance spoken right after cancel(), so only cancel when
  // something is actually playing, and give the speech engine a moment before speaking.
  clearTimeout(sayTimer);
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    sayTimer = setTimeout(() => speakNow(text, slow, onEnd), 150);
  } else speakNow(text, slow, onEnd);
}

function speakNow(text, slow, onEnd) {
  if (!zhVoice) pickVoice(); // iOS may only list its voices after the first tap
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  if (zhVoice) u.voice = zhVoice;
  u.rate = slow ? 0.6 : prefs.rate;
  const face = () => view.querySelector('.t-face');
  u.onstart = () => face()?.classList.add('speaking');
  let ended = false;
  // onEnd(error): error is set when the phone refused to speak (e.g. 'not-allowed' without a recent tap).
  const finish = (error) => {
    if (ended) return;
    ended = true;
    face()?.classList.remove('speaking');
    onEnd?.(error);
  };
  u.onend = () => finish();
  u.onerror = (e) => finish(e.error || 'error');
  // iOS sometimes never fires onend: fall back to an estimate of the speaking time.
  setTimeout(() => finish(), 2500 + (text.length * 400) / (slow ? 0.6 : prefs.rate));
  speechSynthesis.speak(u);
}

const prefs = Object.assign({ pinyin: true, rate: 0.9, voice: 'doubao' }, local.get('tutorPrefs', {}));
const savePrefs = () => local.set('tutorPrefs', prefs);

// ---------------------------------------------------------------- tutor voice + lip movement

// The tutor speaks with the Doubao male voice (made once per sentence on the server and saved).
// Audio plays through Web Audio, and an analyser follows its loudness to switch the avatar's
// mouth between 4 positions. If the voice service fails, the phone's own voice is used instead.
let pctx = null;
let analyser = null;
let current = null; // the playing AudioBufferSourceNode
let playToken = 0;
const buffers = new Map(); // url -> Promise<AudioBuffer>

// Must run inside a tap: iOS only starts audio after a user gesture.
function audioUnlock() {
  try {
    if (!pctx) {
      pctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = pctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(pctx.destination);
    }
    if (pctx.state !== 'running') pctx.resume().catch(() => {});
  } catch { pctx = null; }
}

// Tutor speed setting -> Doubao speech_rate (-50..50); the 🐢 button is always clearly slower.
const voiceRate = (slow) => (slow ? -40 : prefs.rate <= 0.8 ? -25 : prefs.rate <= 0.95 ? -10 : 0);
const voiceUrl = (text, slow) => `/api/tutor/tts?text=${encodeURIComponent(text)}&rate=${voiceRate(slow)}&key=${encodeURIComponent(B.key())}`;

function loadVoice(text, slow = false) {
  if (!pctx || prefs.voice === 'phone' || !text) return null;
  const url = voiceUrl(text, slow);
  if (!buffers.has(url)) {
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`voice ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => new Promise((ok, bad) => pctx.decodeAudioData(ab, ok, bad)));
    p.catch(() => buffers.delete(url));
    buffers.set(url, p);
    while (buffers.size > 80) buffers.delete(buffers.keys().next().value);
  }
  return buffers.get(url);
}
// Fetch upcoming sentences early so they start without delay.
const preloadVoice = (...texts) => texts.forEach((t) => loadVoice(t)?.catch(() => {}));

function stopVoice() {
  playToken++;
  clearTimeout(sayTimer);
  if (current) {
    const c = current;
    current = null;
    c.onended = null;
    try { c.stop(); } catch { /* already stopped */ }
  }
  stopLips();
  faceState('speaking', false);
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
}

// onEnd(error): error = 'not-allowed' when the phone blocked audio (no recent tap).
function say(text, slow = false, onEnd = null) {
  if (!text) return;
  stopVoice();
  const token = playToken;
  const promise = loadVoice(text, slow);
  if (!promise) return phoneSay(text, slow, onEnd);
  promise.then(async (buf) => {
    if (token !== playToken) return;
    if (pctx.state !== 'running') {
      await Promise.race([pctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
      if (token !== playToken) return;
      if (pctx.state !== 'running') return onEnd?.('not-allowed');
    }
    const src = pctx.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    current = src;
    faceState('speaking', true);
    startLips();
    src.onended = () => {
      if (current !== src) return;
      current = null;
      stopLips();
      faceState('speaking', false);
      onEnd?.();
    };
    src.start();
  }).catch(() => {
    if (token === playToken) phoneSay(text, slow, onEnd); // voice service unavailable: phone voice
  });
}

// Preload the mouth layers so the first words already move the lips.
for (const n of ['small', 'open', 'round']) new Image().src = `mouth-${n}.jpg?v=1`;
let lipRaf = 0;

// The base picture shows the closed mouth. Three mouth layers (slightly open, open, round) fade in and
// out with a smoothed loudness envelope, so the lips blend between shapes like real speech instead of
// jumping. Loudness is measured relative to the voice's own recent peak.
// Switched off (2026-11-18): a mouth pasted on a still picture looked fake in close-up. Kept for later.
const LIPS_ON = false;

function startLips() {
  cancelAnimationFrame(lipRaf);
  if (!LIPS_ON) return;
  const data = new Uint8Array(analyser.fftSize);
  let peak = 0.05;
  let env = 0;
  let round = 0;
  let roundTarget = 0;
  let nextRound = 0;
  const tick = (t) => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const level = Math.sqrt(sum / data.length);
    peak = Math.max(level, peak * 0.99, 0.02);
    const target = level < 0.006 ? 0 : Math.min(1, Math.max(0, (level / peak - 0.15) / 0.75));
    env += (target - env) * (target > env ? 0.45 : 0.22); // open quickly, close a bit slower
    // Now and then the open mouth becomes round ("o", "u") for a moment.
    if (t > nextRound) { roundTarget = Math.random() < 0.3 ? 1 : 0; nextRound = t + 220 + Math.random() * 260; }
    round += (roundTarget - round) * 0.2;
    const small = Math.min(1, env / 0.45);
    const open = Math.max(0, Math.min(1, (env - 0.4) / 0.45));
    for (const box of view.querySelectorAll('.t-face.photo')) {
      box.style.setProperty('--m-small', small.toFixed(3));
      box.style.setProperty('--m-open', (open * (1 - round)).toFixed(3));
      box.style.setProperty('--m-round', (Math.max(open, small * 0.6) * round).toFixed(3));
    }
    lipRaf = requestAnimationFrame(tick);
  };
  lipRaf = requestAnimationFrame(tick);
}

function stopLips() {
  cancelAnimationFrame(lipRaf);
  for (const box of view.querySelectorAll('.t-face.photo')) {
    box.style.setProperty('--m-small', '0');
    box.style.setProperty('--m-open', '0');
    box.style.setProperty('--m-round', '0');
  }
}

// ---------------------------------------------------------------- recording (hold to speak)

let rec = null;
let recHandler = null; // what to do with the recognised text on the current screen
let recWords = [];

view.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-hold]');
  if (!btn) return;
  e.preventDefault();
  try { btn.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  startHold(btn);
});
view.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-hold]')) e.preventDefault(); });
// Releasing the finger ends a hold recording; a tap-to-talk recording (long retelling) ends with a second tap.
addEventListener('pointerup', () => { if (!rec?.toggle) stopHold(); });
addEventListener('pointercancel', () => { if (!rec?.toggle) stopHold(); });

async function startHold(btn) {
  if (rec || !recHandler) return;
  if (!B.connected()) return toast('Not connected to the server yet. Please wait a moment.');
  B.gesture();
  stopVoice();
  const toggle = btn.dataset.toggle === '1';
  rec = { btn, toggle, segs: new Map(), started: Date.now(), ending: false, handler: recHandler };
  btn.classList.add('on');
  btn.querySelector('span').textContent = toggle ? 'Listening… tap again when you finish' : 'Listening… release when done';
  faceState('listening', true);
  const heard = view.querySelector('.t-heard');
  if (heard) { heard.hidden = false; heard.innerHTML = '<span class="t-muted">…</span>'; }
  try {
    await B.startRec(recWords);
  } catch (err) {
    B.stopRec();
    resetRecButton(btn);
    rec = null;
    toast(`Microphone: ${err.message}`);
  }
}

function stopHold() {
  if (!rec || rec.ending) return;
  rec.ending = true;
  B.stopRec();
  if (Date.now() - rec.started < 500) {
    resetRecButton(rec.btn);
    rec = null;
    return toast('Hold the button while you speak, then release.');
  }
  rec.btn.classList.remove('on');
  rec.btn.classList.add('wait');
  rec.btn.querySelector('span').textContent = 'Checking…';
  rec.cap = setTimeout(finishRec, 7000);
  maybeFinish();
}

function resetRecButton(btn) {
  faceState('listening', false);
  btn.classList.remove('on', 'wait');
  btn.querySelector('span').textContent = btn.dataset.label;
}

const recText = () => [...rec.segs.values()].map((s) => s.src).join('');

B.onMessage = (msg) => {
  if (!rec) return;
  if (msg.type === 'seg') {
    rec.segs.set(msg.id, { src: msg.src.replace(/^\(demo\)\s*/, ''), final: msg.srcFinal });
    const heard = view.querySelector('.t-heard');
    if (heard) heard.innerHTML = `<span class="t-muted">You:</span> ${esc(recText())}`;
    if (rec.ending) maybeFinish();
  } else if (msg.type === 'status' && msg.state === 'closed' && rec.ending) {
    finishRec();
  } else if (msg.type === 'error') {
    toast(msg.message);
  }
};

function maybeFinish() {
  const all = [...rec.segs.values()];
  if (all.length && all.every((s) => s.final)) {
    clearTimeout(rec.idle);
    rec.idle = setTimeout(finishRec, 900);
  }
}

function finishRec() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearTimeout(r.cap);
  clearTimeout(r.idle);
  resetRecButton(r.btn);
  const text = [...r.segs.values()].map((s) => s.src).join('').trim();
  if (!text) {
    const heard = view.querySelector('.t-heard');
    if (heard) heard.innerHTML = '<span class="t-muted">I didn\'t hear anything. Hold the button and speak a bit louder.</span>';
    return;
  }
  r.handler(text);
}

const holdBtn = (label) => `<button type="button" class="t-hold" data-hold="1" data-label="${esc(label)}">🎙️ <span>${esc(label)}</span></button>`;

// ---------------------------------------------------------------- comparing what was said

const norm = (t) => [...String(t || '')].filter((c) => /[\p{L}\p{N}]/u.test(c));

function compare(target, said) {
  const a = norm(target);
  const b = norm(said);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const hit = new Array(a.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { hit[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  const score = a.length + b.length ? Math.round((200 * dp[0][0]) / (a.length + b.length)) : 0;
  return { score, hit };
}

// Target sentence with each character coloured: said correctly (green) or missed (red).
function markedSentence(target, hit) {
  let k = 0;
  return [...target].map((c) => (/[\p{L}\p{N}]/u.test(c) ? `<span class="${hit[k++] ? 'ok' : 'miss'}">${esc(c)}</span>` : esc(c))).join('');
}

// ---------------------------------------------------------------- screens

let screen = null;
// look: 'call' = full-screen "video call" layout (tutor picture behind the top of the screen),
// 'paper' = warm paper screens of the learning path (home, new word, word learned), '' = dark.
const show = (html, handler = null, words = [], look = '') => {
  recHandler = handler;
  recWords = words;
  view.classList.toggle('t-call', look === 'call');
  view.classList.toggle('t-paper', look === 'paper');
  view.innerHTML = html;
  view.scrollTop = 0;
};
// The tutor's face: the learner's own photo (if added in Tutor settings), else a gold 师 badge.
// One fixed tutor face for everyone (the owner's avatar, public/tutor-face.jpg). Personal photo upload is
// switched off for now; its server endpoint stays for later.
const TUTOR_FACE = 'tutor-face.jpg?v=1';
const hasPhoto = () => true;
const avatarUrl = () => TUTOR_FACE;
const face = (size = '') => `<div class="t-face ${size}${hasPhoto() ? ' photo' : ''}" aria-hidden="true">${hasPhoto() ? `<div class="t-face-in"><div class="t-zoom"><img class="t-base" src="${avatarUrl()}" alt=""><img class="t-mouth m-small" src="mouth-small.jpg?v=1" alt=""><img class="t-mouth m-open" src="mouth-open.jpg?v=1" alt=""><img class="t-mouth m-round" src="mouth-round.jpg?v=1" alt=""></div></div>` : '<span>师</span>'}<i class="t-mood"></i></div>`;

// Reactions: 'listening' while the learner speaks, 'great' / 'again' after a result.
function faceState(cls, on) {
  for (const el of view.querySelectorAll('.t-face')) el.classList.toggle(cls, on);
}
let moodTimer;
function mood(kind) {
  faceState('mood-great', kind === 'great');
  faceState('mood-again', kind === 'again');
  clearTimeout(moodTimer);
  moodTimer = setTimeout(() => { faceState('mood-great', false); faceState('mood-again', false); }, 2200);
}

async function savePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Square crop; for tall photos keep a little more of the top (where the face usually is).
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) * 0.3;
    const c = document.createElement('canvas');
    c.width = c.height = 480;
    c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, 480, 480);
    await api('avatar', { image: c.toDataURL('image/jpeg', 0.85) });
    state.avatarV = Date.now();
    save();
    toast('Your tutor has your face now.');
  } catch (err) {
    toast(`Could not use this photo: ${err.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

view.addEventListener('change', (e) => {
  if (e.target.id === 'tPhoto' && e.target.files[0]) savePhoto(e.target.files[0]).then(() => { if (screen === 'settings') renderSettings(); });
});
const topBar = (title, back = 'home') => `<div class="t-top"><button type="button" class="t-back" data-act="${back}" aria-label="Back">‹</button><div class="t-title">${title}</div></div>`;

view.addEventListener('pointerdown', audioUnlock, { capture: true });
view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  B.gesture();
  audioUnlock();
  try {
    await actions[el.dataset.act]?.(el.dataset, el);
  } catch (err) {
    toast(`Something went wrong: ${err.message}`);
    B.reportError?.(`tutor ${el.dataset.act}: ${err.stack || err.message}`);
  }
});

const actions = {
  home: () => renderHome(),
  words: () => renderWordList(state.level),
  vocabLevel: (d) => renderWordList(Number(d.level)),
  settings: () => renderSettings(),
  learnNext: async () => {
    const [w] = await nextNewWords(1);
    if (w) openLesson(w[0]); else toast('You have started every word of this level. Choose the next level in Tutor settings.');
  },
  open: (d) => openLesson(d.word),
  review: () => startReview(),
  play: (d) => say(d.text, d.slow === '1'),
  setLevel: (d) => { state.level = Number(d.level); save(); renderSettings(); },
  setGoal: (d) => { state.goal = Number(d.goal); save(); renderSettings(); },
  togglePinyin: (d, el) => {
    prefs.pinyin = !prefs.pinyin;
    savePrefs();
    view.classList.toggle('no-pinyin', !prefs.pinyin);
    if (el.dataset.pin) el.classList.toggle('on', prefs.pinyin);
    else if (el.tagName === 'BUTTON') el.textContent = `${prefs.pinyin ? 'Hide' : 'Show'} pinyin`;
  },
  setVoice: (d) => { prefs.voice = d.voice; savePrefs(); renderSettings(); say('你好，我是你的中文老师。'); },
  setRate: (d) => { prefs.rate = Number(d.rate); savePrefs(); renderSettings(); },
  startTutor: () => {
    state = { v: 1, level: pendingSetup.level, goal: pendingSetup.goal, words: {}, days: {}, streak: { count: 0, last: '' }, created: today() };
    save();
    renderHome();
  },
  removePhoto: async () => {
    try { await api('avatar', { remove: true }); } catch { /* already gone */ }
    delete state.avatarV;
    save();
    renderSettings();
  },
  pickLevel: (d) => { pendingSetup.level = Number(d.level); renderSetup(); },
  pickGoal: (d) => { pendingSetup.goal = Number(d.goal); renderSetup(); },
};

// ---------- first start

const pendingSetup = { level: 3, goal: 3 };

function renderSetup() {
  screen = 'setup';
  show(`
    <div class="t-hero">${face('big')}
      <h1>Welcome to MISHU Tutor</h1>
      <p>Learn every word the way native speakers really use it: 10 real-life sentences, why and when people say them, and you speak every one out loud.</p>
    </div>
    <h2 class="t-h2">Your level now</h2>
    <div class="t-levels">${LEVELS.map(([n, name, desc, count]) => `
      <button type="button" class="t-level ${pendingSetup.level === n ? 'sel' : ''}" data-act="pickLevel" data-level="${n}">
        <b>${name}</b><small>${desc} · ${count.toLocaleString()} words</small></button>`).join('')}
    </div>
    <h2 class="t-h2">New words per day</h2>
    <div class="t-goals">${[2, 3, 5, 8].map((g) => `
      <button type="button" class="t-goal ${pendingSetup.goal === g ? 'sel' : ''}" data-act="pickGoal" data-goal="${g}">
        <b>${g}</b><small>≈ ${g * 10} min</small></button>`).join('')}
    </div>
    <p class="t-note">Each word has 10 sentences to speak, so one word takes about 10 minutes. Reviews come on top. You can change this any time.</p>
    <button type="button" class="t-primary" data-act="startTutor">Start learning</button>`);
}

// ---------- home

const HOME_ICON = '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 5l8 6.5M6.5 10v9h4.5v-5h2v5h4.5v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- home: the learning path (journey) of the current chapter
// The level's words in order, 10 per chapter (same chapters as the Vocabulary screen). Learned words
// are green, the next word is big with START, later words are locked, a 🎁 chapter story ends the path.

const PATH_X = [50, 74, 80, 62, 36, 20, 26, 48, 72, 78]; // node positions across the screen (%)
const PATH_ROW = 96; // px per node
let J = null; // current path: { list, next, ch }
const avatarImg = (cls) => `<img class="${cls}" src="${avatarUrl()}" alt="">`;
const starsFor = (avg) => (avg >= 90 ? 3 : avg >= 80 ? 2 : 1);

async function renderHome() {
  screen = 'home';
  const d = state.days[today()] || { newWords: 0, sentences: 0, quiz: 0 };
  const due = dueWords().length;
  show(`
    <div class="j-head sticky">
      <button type="button" class="home-btn j-rb" data-mode="start" aria-label="Home">${HOME_ICON}</button>
      <div class="j-title"><b id="jTitle">${levelName(state.level)}</b><small id="jSub">Loading your path…</small></div>
      <button type="button" class="j-rb" data-act="settings" aria-label="Tutor settings">⚙︎</button>
    </div>
    <div class="j-pills"><span>🔥 ${streakNow()}</span><span>🎯 ${d.newWords}/${state.goal} today</span><span>⭐ ${knownCount()}</span></div>
    <div class="j-path" id="jPath"><div class="t-spinner"></div></div>
    <div class="j-foot">
      <button type="button" class="j-card" data-act="review" ${due ? '' : 'disabled'}><em>🧠</em>Review${due ? `<i class="j-badge">${due}</i>` : ''}<small>${due ? 'quiz due' : 'nothing due'}</small></button>
      <button type="button" class="j-card" data-act="story"><em>📖</em>Story<small>listen &amp; speak</small></button>
      <button type="button" class="j-card" data-act="words"><em>📚</em>Words<small>all HSK levels</small></button>
    </div>`, null, [], 'paper');
  let list;
  try {
    list = await levelWords(state.level);
  } catch (err) {
    document.getElementById('jPath').innerHTML = `<p class="j-msg">Could not load the word list: ${esc(err.message)}</p>`;
    return;
  }
  if (screen !== 'home') return;
  const next = list.findIndex((w) => !state.words[w[0]]);
  const at = next < 0 ? list.length - 1 : next;
  const ch = Math.floor(at / 10);
  J = { list, next, ch };
  const words = list.slice(ch * 10, ch * 10 + 10);
  const left = words.filter((w) => !state.words[w[0]]).length;
  document.getElementById('jTitle').textContent = `${levelName(state.level)} · Chapter ${ch + 1}`;
  document.getElementById('jSub').textContent = next < 0 ? `Level complete 🎉 · choose the next level in ⚙︎` : `Word ${next + 1} of ${list.length.toLocaleString()}`;

  const rows = words.map((w, k) => {
    const i = ch * 10 + k;
    const st = state.words[w[0]];
    const cls = st ? 'done' : i === next ? 'now' : 'lock';
    const x = PATH_X[k];
    const len = [...w[0]].length;
    return `<div class="j-row" style="--x:${x}%">
      <button type="button" class="j-node ${cls}${len > 2 ? ' long' : len > 1 ? ' two' : ''}" data-act="pathWord" data-i="${i}">${esc(w[0])}</button>
      ${cls === 'now' ? `<span class="j-start">START ▶</span>${avatarImg(`j-me ${x > 50 ? 'l' : 'r'}`)}` : ''}
      ${cls === 'done' ? `<small class="j-stars">${'★'.repeat(st.avg ? starsFor(st.avg) : 1)}</small>` : ''}
    </div>`;
  });
  rows.push(`<div class="j-row" style="--x:50%">
      <button type="button" class="j-node chest${left ? '' : ' open'}" data-act="pathChest" data-level="${state.level}" data-chapter="${ch + 1}" data-left="${left}">🎁</button>
      <small class="j-cap">${left ? `Chapter story · ${left} word${left > 1 ? 's' : ''} to go` : 'Chapter story is open!'}</small>
    </div>`);
  // Dotted line through the node centres.
  const pts = [...PATH_X.slice(0, words.length), 50].map((x, k) => [x, k * PATH_ROW + PATH_ROW / 2]);
  const h = pts.length * PATH_ROW;
  const dPath = pts.map(([x, y], k) => (k ? `C${pts[k - 1][0]} ${pts[k - 1][1] + PATH_ROW / 2},${x} ${y - PATH_ROW / 2},${x} ${y}` : `M${x} ${y}`)).join(' ');
  // The chapter just finished: its story waits in a banner until it is opened once.
  const prevKey = `${state.level}-${ch}`;
  const banner = ch > 0 && !(state.chapterStories || {})[prevKey]
    ? `<button type="button" class="j-banner" data-act="pathChest" data-level="${state.level}" data-chapter="${ch}" data-left="0">🎁 <span><b>Chapter ${ch} story is ready!</b> A short story with the 10 words you just learned ›</span></button>` : '';
  const box = document.getElementById('jPath');
  box.insertAdjacentHTML('beforebegin', banner);
  box.innerHTML = `<svg class="j-line" viewBox="0 0 100 ${h}" preserveAspectRatio="none" style="height:${h}px"><path d="${dPath}"/></svg>${rows.join('')}`;
  box.querySelector('.j-node.now')?.scrollIntoView({ block: 'center' });
  if (next >= 0) api('prefetch', { words: list.slice(next, next + 6).map((w) => w[0]) }).catch(() => {});
}

// Tap a word on the path: a sheet slides up (learned words can be practised again).
actions.pathWord = (d) => {
  const i = Number(d.i);
  const w = J.list[i];
  const st = state.words[w[0]];
  if (!st && i !== J.next) return toast(`Words open one by one: learn ${J.list[J.next][0]} first. (Any word can be opened from 📚 Words.)`);
  closeSheet();
  view.insertAdjacentHTML('beforeend', `<div class="j-dim" data-act="closeSheet"></div>
    <div class="j-sheet"><div class="j-grab"></div>
      <div class="j-sw"><div class="j-tile${[...w[0]].length > 1 ? ' small' : ''}">${esc(w[0])}</div><div><b>${esc(w[0])}</b> <span class="j-spy">${esc(w[1])}</span><p>${esc(firstMeaning(w[2]))}</p></div></div>
      <div class="j-steps"><span><em>👀</em>Meet the word</span><span><em>🗣️</em>10 sentences</span><span><em>✍️</em>2 tasks</span></div>
      <button type="button" class="j-red" data-act="open" data-word="${esc(w[0])}">${st ? 'Practise again' : 'Start lesson'} · about 8 min</button>
    </div>`);
  api('prefetch', { words: [w[0]] }).catch(() => {});
};
function closeSheet() {
  for (const el of view.querySelectorAll('.j-dim, .j-sheet')) el.remove();
}
actions.closeSheet = closeSheet;
actions.pathChest = (d) => {
  if (d.left === '0') {
    (state.chapterStories ??= {})[`${d.level}-${d.chapter}`] = today();
    save();
    return actions.chapterStory(d);
  }
  toast(`Learn all 10 words of chapter ${d.chapter} to open its story 🎁 (${d.left} to go).`);
};

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? '早上好！Ready to practise?' : h < 18 ? '下午好！Let\'s learn something useful.' : '晚上好！A few words before bed?';
}

// ---------- settings

const yuan = (v) => `¥${(v || 0) < 0.1 ? (v || 0).toFixed(3) : v.toFixed(2)}`;

function renderSettings() {
  screen = 'settings';
  show(`${topBar('Tutor settings')}
    <h2 class="t-h2">Level</h2>
    <div class="t-levels">${LEVELS.map(([n, name, desc]) => `
      <button type="button" class="t-level ${state.level === n ? 'sel' : ''}" data-act="setLevel" data-level="${n}"><b>${name}</b><small>${desc}</small></button>`).join('')}
    </div>
    <h2 class="t-h2">New words per day</h2>
    <div class="t-goals">${[2, 3, 5, 8, 10].map((g) => `
      <button type="button" class="t-goal ${state.goal === g ? 'sel' : ''}" data-act="setGoal" data-goal="${g}"><b>${g}</b></button>`).join('')}
    </div>
    <h2 class="t-h2">Tutor's speaking speed</h2>
    <div class="t-goals">${[[0.75, 'Slow'], [0.9, 'Clear'], [1.05, 'Natural']].map(([r, n]) => `
      <button type="button" class="t-goal ${prefs.rate === r ? 'sel' : ''}" data-act="setRate" data-rate="${r}"><b>${n}</b></button>`).join('')}
    </div>
    <h2 class="t-h2">Tutor's voice</h2>
    <div class="t-goals">${[['doubao', 'Native male (Doubao)'], ['phone', 'Phone voice (free)']].map(([v, n]) => `
      <button type="button" class="t-goal ${prefs.voice === v ? 'sel' : ''}" data-act="setVoice" data-voice="${v}"><b>${n}</b></button>`).join('')}
    </div>
    <label class="t-switch"><input type="checkbox" ${prefs.pinyin ? 'checked' : ''} data-act="togglePinyin"> Show pinyin</label>
    <h2 class="t-h2">Usage &amp; cost</h2>
    <div class="t-card" id="tUsage"><span class="t-muted">Loading…</span></div>`);
  api('usage').then((u) => {
    const el = document.getElementById('tUsage');
    if (!el) return;
    const row = (name, v) => `<div class="t-row"><span>${name}</span><b>${yuan(v)}</b></div>`;
    el.innerHTML = `
      ${row('Today', u.today.total)}${row('This month', u.month.total)}
      <div class="t-usage-split">
        ${row('· Voice checks (Doubao interpretation)', u.month.voice)}
        ${row('· Tutor voice (Doubao speech)', u.month.voiceout)}
        ${row('· Answer grading (Doubao chat)', u.month.grading)}
        ${row('· New lessons written (Doubao chat)', u.month.lessons)}
        ${row('· Stories written (Doubao chat)', u.month.stories)}
      </div>
      ${u.recent.length ? `<div class="t-usage-days">${u.recent.map((d) => row(d.day, Object.values(d).reduce((a, v) => a + (v.yuan || 0), 0))).join('')}</div>` : ''}
      <p class="t-note">Exact tokens reported by Doubao × list price. While your free trial tokens last, this is what the use is worth; you are not charged.</p>`;
  }).catch((err) => { const el = document.getElementById('tUsage'); if (el) el.textContent = `Could not load: ${err.message}`; });
}

// ---------- word list

// All words of one level (HSK 1-6, 7-9): level boxes, search, chapters of 10, all shown.
// Long lists are added in pages of 200 while scrolling, so even HSK 7-9 (5,606 words) stays fast.
let vocab = { level: 0, list: [], shown: [], filter: '' };
const plain = (t) => String(t || '').normalize('NFD').replace(/[\p{M}\s]/gu, '').toLowerCase();

async function renderWordList(level = vocab.level || state.level) {
  screen = 'words';
  vocab = { level, list: [], shown: [], filter: '' };
  show(`${topBar('Vocabulary')}
    <div class="t-levelbar">${LEVELS.map(([n, name, , count]) => `
      <button type="button" class="t-lvl ${n === level ? 'sel' : ''}" data-act="vocabLevel" data-level="${n}"><b>${name}</b><small>${count.toLocaleString()}</small></button>`).join('')}
    </div>
    <input id="tSearch" class="t-search" type="search" placeholder="Search: 汉字, pinyin (ma fan) or English" autocomplete="off">
    <p class="t-note" id="tVocabInfo">Loading…</p>
    <div id="tWordList"></div>
    <div id="tMore" class="t-loading"></div>`);
  document.getElementById('tSearch').addEventListener('input', (e) => { vocab.filter = e.target.value; filterVocab(); });
  try {
    const list = await levelWords(level);
    if (vocab.level !== level || screen !== 'words') return;
    vocab.list = list.map((w, i) => ({ w, i }));
    filterVocab();
  } catch (err) {
    document.getElementById('tVocabInfo').textContent = `Could not load the word list: ${err.message}`;
  }
}

function filterVocab() {
  const q = vocab.filter.trim();
  const pq = plain(q);
  vocab.shown = !q ? vocab.list : vocab.list.filter(({ w }) => w[0].includes(q) || plain(w[1]).includes(pq) || w[2].toLowerCase().includes(q.toLowerCase()));
  vocab.rendered = 0;
  const started = vocab.list.filter(({ w }) => state.words[w[0]]).length;
  document.getElementById('tVocabInfo').textContent = q
    ? `${vocab.shown.length} of ${vocab.list.length} words match.`
    : `${levelName(vocab.level)}: ${vocab.list.length.toLocaleString()} words, most useful first, in chapters of 10 · ${started} started. Tap a word to learn it.`;
  document.getElementById('tWordList').innerHTML = '';
  moreVocab();
}

function moreVocab() {
  const box = document.getElementById('tWordList');
  if (!box) return;
  const page = vocab.shown.slice(vocab.rendered, vocab.rendered + 200);
  let html = '';
  for (const { w, i } of page) {
    if (i % 10 === 0 && !vocab.filter.trim()) html += `<div class="t-chap-h"><span>Chapter ${i / 10 + 1}</span><button type="button" class="t-chip t-chap-story" data-act="chapterStory" data-level="${vocab.level}" data-chapter="${i / 10 + 1}">📖 Story</button></div>`;
    const st = state.words[w[0]];
    const tag = !st ? '' : st.box >= 4 ? '<i class="t-tag known">mastered</i>' : '<i class="t-tag learning">learning</i>';
    html += `<button type="button" class="t-word" data-act="open" data-word="${esc(w[0])}"><b>${esc(w[0])}</b><span>${esc(w[1])}</span><small>${esc(firstMeaning(w[2]))}</small>${tag}</button>`;
  }
  box.insertAdjacentHTML('beforeend', html);
  vocab.rendered += page.length;
  document.getElementById('tMore').textContent = vocab.rendered < vocab.shown.length ? 'Loading more…' : '';
}

// Add the next page when the list end comes into view.
view.addEventListener('scroll', () => {
  if (screen !== 'words' || vocab.rendered >= vocab.shown.length) return;
  if (view.scrollTop + view.clientHeight > view.scrollHeight - 800) moreVocab();
}, { passive: true });

// ---------- lesson

let L = null; // current lesson session

async function openLesson(word) {
  screen = 'lesson';
  show(`<div class="j-head"><button type="button" class="j-rb" data-act="home" aria-label="Back">‹</button><div class="j-title"><small class="j-kicker">PREPARING YOUR LESSON</small></div></div>
    <div class="t-preparing">${face('big')}<p><b>${esc(word)}</b></p><p class="t-muted"><span id="tPrepStep">Your tutor is writing this lesson…</span><br>The first time a word is opened this takes 30–60 seconds. <span id="tPrepSecs"></span></p><div class="t-spinner"></div></div>`, null, [], 'paper');
  // Live progress while the lesson is written, so the wait never looks frozen.
  const started = Date.now();
  const steps = [[0, 'Your tutor is writing this lesson…'], [8, 'Writing 10 real-life sentences…'], [20, 'Explaining when and why natives say them…'], [32, 'Preparing your speaking tasks…'], [45, 'Checking everything, almost done…']];
  const prepTimer = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    const step = steps.filter(([t]) => secs >= t).pop()[1];
    const a = document.getElementById('tPrepStep');
    const b = document.getElementById('tPrepSecs');
    if (!a) return clearInterval(prepTimer);
    a.textContent = step;
    b.textContent = `(${secs} s)`;
  }, 1000);
  try {
    const lesson = await getLesson(word).finally(() => clearInterval(prepTimer));
    if (screen !== 'lesson') return;
    L = { lesson, i: -1, scores: [], turn: 0 };
    preloadVoice(lesson.word, lesson.sentences[0]?.zh, lesson.sentences[1]?.zh);
    renderIntro();
    nextNewWords(4).then((n) => api('prefetch', { words: n.map((w) => w[0]).filter((w) => w !== word) })).catch(() => {});
  } catch (err) {
    if (screen === 'lesson') show(`${topBar('Lesson')}<div class="t-card">Sorry, the lesson could not be prepared: ${esc(err.message)}</div><button class="t-primary" data-act="open" data-word="${esc(word)}">Try again</button>`);
  }
}

const progress = (i, n) => `<div class="t-progress"><i style="width:${Math.round((i / n) * 100)}%"></i></div>`;

// "Meet the word" (warm paper): the character big on a seal tile, the tutor explains it in a speech
// bubble, common chunks as cards. Step dashes: this intro + the sentences + the 2 tasks.
const lessonSteps = (on) => `<div class="j-dashes">${Array.from({ length: L.lesson.sentences.length + 3 }, (_, k) => `<i class="${k <= on ? 'on' : ''}"></i>`).join('')}</div>`;

function renderIntro() {
  const l = L.lesson;
  const len = [...l.word].length;
  show(`<div class="j-head"><button type="button" class="j-rb" data-act="home" aria-label="Back">‹</button><div class="j-title"><small class="j-kicker">${levelName(l.level)} · NEW WORD</small></div></div>
    ${lessonSteps(0)}
    <div class="j-hero">
      <button type="button" class="j-big${len > 2 ? ' long' : len > 1 ? ' two' : ''}" data-act="play" data-text="${esc(l.word)}">${esc(l.word)}</button>
      <div class="j-hpy">${esc(l.pinyin)}</div>
      <div class="j-hm">${esc(l.meaning)} <small>${esc(l.pos)}</small></div>
      <div class="j-btns"><button type="button" class="j-chip" data-act="play" data-text="${esc(l.word)}">🔊 Listen</button><button type="button" class="j-chip" data-act="play" data-text="${esc(l.word)}" data-slow="1">🐢 Slow</button></div>
    </div>
    <div class="j-coach">${avatarImg('j-ava')}<div class="j-bub">${esc(l.core)}</div></div>
    ${l.collocations.length ? `<div class="j-h2">COMMON CHUNKS</div><div class="j-chunks">${l.collocations.map((c) => `
      <button type="button" class="j-card" data-act="play" data-text="${esc(c.zh)}"><b>${esc(c.zh)}</b><span>${esc(c.pinyin)}</span><small>${esc(c.en)}</small></button>`).join('')}</div>` : ''}
    <button type="button" class="j-red j-go" data-act="lessonNext">Start speaking · ${l.sentences.length} sentences</button>`, null, [], 'paper');
  setTimeout(() => say(l.word), 300);
}

actions.lessonNext = () => {
  L.i++;
  if (L.i < L.lesson.sentences.length) renderSentence();
  else renderTurn();
};
actions.lessonPrev = () => { if (L.i > 0) { L.i--; renderSentence(); } else { L.i = -1; renderIntro(); } };

const DIFF = { medium: 'Medium', hard: 'Hard', hardest: 'Hardest' };
const PASS = 80; // score needed to move on by itself
const MAX_TRIES = 3;
const PRAISE = ['很好！', '非常好！', '太棒了！', '说得真好！'];

// Tutor-led practice: the tutor says the sentence -> "your turn" -> the learner repeats ->
// a good score moves on automatically; otherwise the tutor repeats it slowly and asks again.
function renderSentence() {
  const l = L.lesson;
  const s = l.sentences[L.i];
  const n = l.sentences.length;
  const best = L.scores[L.i];
  const diff = s.difficulty || (L.i < 4 ? 'medium' : L.i < 8 ? 'hard' : 'hardest');
  L.tries = 0;
  const here = L.i;
  // "Video call" layout: the tutor fills the top of the screen, the sentence card sits on the chest,
  // call-style buttons at the bottom. (The lesson's "when & why" text is kept in the data, not shown here.)
  show(`${face('call')}
    <div class="t-callhead">${topBar(`${esc(l.word)} · ${L.i + 1} / ${n}`)}${progress(L.i, n + 1)}</div>
    <div class="t-callspace"></div>
    <div class="t-coachline" id="tCoach">🔊 Tutor speaking…</div>
    <div class="t-card t-sentence t-chest${[...s.zh].length > 14 ? ' long' : ''}">
      <div class="t-tags"><i class="t-tag diff-${diff}">${DIFF[diff]}</i>${s.register ? `<i class="t-tag">${esc(s.register)}</i>` : ''}${s.feeling ? `<i class="t-tag feel">${esc(s.feeling)}</i>` : ''}<button type="button" class="t-pin${prefs.pinyin ? ' on' : ''}" data-act="togglePinyin" data-pin="1">拼 Pinyin</button></div>
      <div class="t-sit">${esc(s.situation)}</div>
      <div class="t-zh" id="tZh">${goldWord(s.zh, l.word)}</div>
      <div class="t-py">${esc(s.pinyin)}</div>
      <div class="t-en">${esc(s.en)}</div>
      <div class="t-heard" hidden></div>
      <div class="t-result" id="tResult">${best != null ? scoreBadge(best) : ''}</div>
    </div>
    <div class="t-callbar">
      <button type="button" class="t-cb" data-act="lessonPrev"><i>‹</i>Back</button>
      <button type="button" class="t-cb" data-act="play" data-text="${esc(s.zh)}" data-slow="1"><i>🐢</i>Slow</button>
      <button type="button" class="t-hold t-mic" data-hold="1" data-label="Hold &amp; repeat"><i>🎙️</i><span>Hold &amp; repeat</span></button>
      <button type="button" class="t-cb" data-act="play" data-text="${esc(s.zh)}"><i>🔊</i>Again</button>
      <button type="button" class="t-cb${best != null ? ' ready' : ''}" id="tNextBtn" data-act="lessonNext"><i>›</i><span>${best != null ? 'Next' : 'Skip'}</span></button>
    </div>`, onShadow, [l.word], 'call');
  setTimeout(() => { if (L.i === here && screen === 'lesson') say(s.zh, false, () => yourTurn(here)); }, 350);
  preloadVoice(l.sentences[L.i + 1]?.zh, ...PRAISE);
}

// The sentence with the lesson word in gold.
function goldWord(zh, word) {
  const at = word ? zh.indexOf(word) : -1;
  return at < 0 ? esc(zh) : `${esc(zh.slice(0, at))}<em class="t-goldw">${esc(word)}</em>${esc(zh.slice(at + word.length))}`;
}

function coach(text, cls = '') {
  const el = document.getElementById('tCoach');
  if (el) { el.textContent = text; el.className = `t-coachline ${cls}`; }
}

function yourTurn(here) {
  if (L.i !== here || screen !== 'lesson') return;
  coach('🎙️ Your turn: hold the mic and repeat.', 'turn');
  view.querySelector('.t-hold')?.classList.add('pulse');
}

function scoreBadge(score) {
  const [cls, text] = score >= 90 ? ['great', 'Excellent! Just like a native.'] : score >= 70 ? ['good', 'Good. Listen once more and repeat for perfect.'] : ['again', 'Not quite. Listen (try 🐢 Slow) and try again.'];
  return `<div class="t-badge ${cls}"><b>${score}</b><span>${text}</span></div>`;
}

function onShadow(text) {
  const s = L.lesson.sentences[L.i];
  const here = L.i;
  const { score, hit } = compare(s.zh, text);
  const first = L.scores[L.i] == null;
  L.scores[L.i] = Math.max(L.scores[L.i] ?? 0, score);
  L.tries++;
  if (first) activity('sentences');
  view.querySelector('.t-hold')?.classList.remove('pulse');
  document.getElementById('tZh').innerHTML = markedSentence(s.zh, hit);
  document.getElementById('tResult').innerHTML = scoreBadge(score);
  const nextBtn = document.getElementById('tNextBtn');
  if (nextBtn) { nextBtn.classList.add('ready'); nextBtn.querySelector('span').textContent = 'Next'; }
  if (score >= PASS) {
    mood('great');
    const last = L.i === L.lesson.sentences.length - 1;
    coach(last ? '✓ Well done! Now your own sentences…' : '✓ Well done! Next sentence…', 'good');
    say(PRAISE[Math.floor(Math.random() * PRAISE.length)], false, () => {
      setTimeout(() => { if (L.i === here && screen === 'lesson') actions.lessonNext(); }, 600);
    });
  } else if (L.tries < MAX_TRIES) {
    mood('again');
    coach(`Listen again, slowly. Red = missed. Try ${L.tries + 1} of ${MAX_TRIES}.`, 'again');
    setTimeout(() => { if (L.i === here) say(s.zh, true, () => yourTurn(here)); }, 900);
  } else {
    mood('again');
    coach('Good effort! Keep this one in mind and move on when you are ready.', 'again');
  }
}

// "Your turn": the learner builds their own sentences (one medium task, one hard task).
function renderTurn() {
  const l = L.lesson;
  const tasks = [l.quiz.find((q) => q.difficulty === 'medium'), l.quiz.find((q) => q.difficulty === 'hard')].filter(Boolean);
  if (L.turn >= tasks.length) return finishLesson();
  const q = tasks[L.turn];
  renderTask({
    title: `${esc(l.word)} · your turn ${L.turn + 1} of ${tasks.length}`,
    prog: progress(l.sentences.length, l.sentences.length + 1),
    q, word: l.word,
    onNext: () => { L.turn++; renderTurn(); },
  });
}

// "Word learned" (warm paper): the word turns green with petals, stars from the average score,
// and the tutor points to the next word on the path and how far the chapter story is.
function finishLesson() {
  const l = L.lesson;
  const isNew = !state.words[l.word];
  if (isNew) {
    state.words[l.word] = { box: 1, due: addDays(1), level: l.level, learned: today(), right: 0, wrong: 0 };
    activity('newWords');
  }
  const done = L.scores.filter((x) => x != null);
  const avg = done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : null;
  if (avg != null) { state.words[l.word].avg = Math.max(state.words[l.word].avg || 0, avg); save(); }
  const stars = avg == null ? 1 : starsFor(avg);
  const d = state.days[today()] || { newWords: 0 };
  const len = [...l.word].length;
  screen = 'done';
  show(`<div class="j-done">
      <div class="j-burst"><i class="j-glow"></i><div class="j-node done big${len > 2 ? ' long' : len > 1 ? ' two' : ''}">${esc(l.word)}</div>
        <i class="j-petal" style="left:4%;top:22%;--r:30deg"></i><i class="j-petal" style="right:2%;top:12%;--r:-20deg"></i><i class="j-petal" style="left:14%;bottom:6%;--r:80deg"></i><i class="j-petal" style="right:10%;bottom:16%;--r:0deg"></i><i class="j-petal" style="left:44%;top:-4%;--r:140deg"></i></div>
      <h1>${isNew ? 'Word learned' : 'Practice done'} <span>✓</span></h1>
      <div class="j-starrow">${'★'.repeat(stars)}<i>${'★'.repeat(3 - stars)}</i></div>
      <div class="j-tiles"><div class="j-card"><b>${avg ?? '–'}</b><small>avg score</small></div><div class="j-card"><b>${done.length}/${l.sentences.length}</b><small>sentences</small></div><div class="j-card"><b>${d.newWords}/${state.goal}</b><small>today</small></div></div>
      <div class="j-coach">${avatarImg('j-ava')}<div class="j-bub" id="jNextSay">${PRAISE[0]} ${isNew ? 'I will quiz you on this word tomorrow.' : 'Your review schedule is unchanged.'}</div></div>
      <div class="j-actions"><button type="button" class="j-red" data-act="learnNext" id="jNextBtn">Next word ›</button><button type="button" class="j-ghost" data-act="home">Back to my path</button></div>
    </div>`, null, [], 'paper');
  levelWords(state.level).then((list) => {
    const next = list.findIndex((w) => !state.words[w[0]]);
    const btn = document.getElementById('jNextBtn');
    const bub = document.getElementById('jNextSay');
    if (!btn || screen !== 'done') return;
    if (next < 0) { btn.textContent = 'Level complete 🎉 · back to my path'; btn.dataset.act = 'home'; return; }
    const ch = Math.floor(next / 10);
    const left = list.slice(ch * 10, ch * 10 + 10).filter((w) => !state.words[w[0]]).length;
    btn.textContent = `Next word · ${list[next][0]} ›`;
    const chapterDone = left === list.slice(ch * 10, ch * 10 + 10).length && ch > 0;
    bub.innerHTML = `${esc(PRAISE[stars - 1] || PRAISE[0])} ${chapterDone ? `Chapter ${ch} is complete: its 🎁 story is waiting on your path. ` : ''}Next: <b>${esc(list[next][0])}</b>.${!chapterDone ? (left > 1 ? ` Only ${left} words to the 🎁 chapter story!` : ' One more word and the 🎁 chapter story opens!') : ''}`;
  }).catch(() => {});
}

// ---------- one task (your turn / review): the learner must produce the Chinese

function renderTask({ title, prog, q, word, onNext, onGraded }) {
  const zhPrompt = /[㐀-鿿]/.test(q.prompt);
  actions.taskNext = onNext;
  actions.typeCheck = () => {
    const val = document.getElementById('tType').value.trim();
    if (val) onAnswer(val);
  };
  const label = { medium: 'Medium', hard: 'Hard', hardest: 'Hardest' }[q.difficulty] || 'Task';
  show(`${topBar(title)}${prog}
    <div class="t-situation t-sit-stage">${face('stage')}<div><b>Say it in Chinese, using 「${esc(word)}」</b><div class="t-tags"><i class="t-tag diff-${esc(q.difficulty)}">${label}</i></div></div></div>
    <div class="t-card t-task"><p class="${zhPrompt ? 't-zh-prompt' : ''}">${esc(q.prompt)}</p>
      ${zhPrompt ? `<div class="t-btns"><button type="button" class="t-chip" data-act="play" data-text="${esc(q.prompt)}">🔊 Listen</button></div>` : ''}</div>
    <div class="t-heard" hidden></div>
    <div id="tGrade"></div>
    <div class="t-actions" id="tTaskActions">
      ${holdBtn('Hold & answer in Chinese')}
      <div class="t-type"><input id="tType" type="text" placeholder="…or type your answer" lang="zh-CN" enterkeyhint="done"><button type="button" class="t-chip" data-act="typeCheck">Check</button></div>
      <div class="t-nav"><button type="button" class="t-secondary" data-act="taskNext">Skip ›</button></div>
    </div>`, onAnswer, [word]);
  if (zhPrompt) setTimeout(() => say(q.prompt), 350);
  document.getElementById('tType').addEventListener('keydown', (e) => { if (e.key === 'Enter') actions.typeCheck(); });

  async function onAnswer(said) {
    const box = document.getElementById('tGrade');
    const heard = view.querySelector('.t-heard');
    heard.hidden = false;
    heard.innerHTML = `<span class="t-muted">You:</span> ${esc(said)}`;
    box.innerHTML = '<div class="t-card t-muted">Your tutor is checking…</div>';
    let r;
    try {
      r = await api('grade', { word, prompt: q.prompt, answer: q.answer, accept: q.accept, said });
    } catch (err) {
      box.innerHTML = `<div class="t-card">Could not check: ${esc(err.message)}</div>`;
      return;
    }
    activity('quiz');
    onGraded?.(r.score);
    mood(r.score >= 70 ? 'great' : 'again');
    const cls = { great: 'great', good: 'good', almost: 'again', wrong: 'bad' }[r.verdict];
    box.innerHTML = `
      <div class="t-badge ${cls}"><b>${r.score}</b><span>${esc(r.feedback)}</span></div>
      <div class="t-card t-native"><small>A native would say</small>
        <div class="t-zh">${esc(r.native)}</div><div class="t-py">${esc(r.native_pinyin)}</div>
        <div class="t-btns"><button type="button" class="t-chip" data-act="play" data-text="${esc(r.native)}">🔊 Listen</button><button type="button" class="t-chip" data-act="play" data-text="${esc(r.native)}" data-slow="1">🐢 Slow</button></div>
        ${q.explain ? `<p class="t-tip">💡 ${esc(q.explain)}</p>` : ''}
      </div>`;
    view.querySelector('#tTaskActions .t-nav').innerHTML = `<button type="button" class="t-primary" data-act="taskNext">Next ›</button>`;
    say(r.native);
  }
}

// ---------- review quiz (spaced repetition, medium -> hard)

let R = null;

async function startReview() {
  const words = dueWords().slice(0, 15);
  if (!words.length) return renderHome();
  screen = 'review';
  show(`${topBar('Review quiz')}<div class="t-preparing">${face('big')}<p class="t-muted">Preparing your quiz…</p><div class="t-spinner"></div></div>`);
  R = { queue: words.slice(), total: words.length, done: 0, right: 0, retried: new Set() };
  nextReview();
}

// Harder tasks as a word climbs the boxes: never easy, always medium -> hard -> hardest.
const difficultyFor = (box) => (box <= 1 ? 'medium' : box <= 3 ? 'hard' : 'hardest');

async function nextReview() {
  if (!R.queue.length) return finishReview();
  const word = R.queue.shift();
  let lesson;
  try { lesson = await getLesson(word); } catch (err) { toast(err.message); return nextReview(); }
  if (screen !== 'review') return;
  const w = state.words[word];
  const want = difficultyFor(w.box);
  const pool = lesson.quiz.filter((q) => q.difficulty === want);
  const q = (pool.length ? pool : lesson.quiz)[Math.floor(Math.random() * (pool.length || lesson.quiz.length))];
  let graded = false;
  renderTask({
    title: `Review · ${R.done + 1} of ${R.total}`,
    prog: progress(R.done, R.total),
    q, word,
    onGraded: (score) => {
      if (graded) return;
      graded = true;
      if (score >= 70) {
        w.box = Math.min(INTERVALS.length - 1, w.box + 1);
        w.due = addDays(INTERVALS[w.box]);
        w.right++;
        R.right++;
      } else {
        w.box = 1;
        w.due = addDays(1);
        w.wrong++;
        // A missed word comes back once more at the end of this quiz.
        if (!R.retried.has(word)) { R.retried.add(word); R.queue.push(word); R.total++; }
      }
      save();
    },
    onNext: () => { R.done++; nextReview(); }, // a skipped word keeps its review date
  });
}

function finishReview() {
  show(`${topBar('Review complete')}
    <div class="t-hero">${face('big')}<h1>Well done!</h1>
      <p>${R.right} correct answers out of ${R.done}.</p>
      <p class="t-muted">Words you got right come back later; missed words come back tomorrow.</p></div>
    <button type="button" class="t-primary" data-act="home">Home</button>`);
}

// ---------------------------------------------------------------- stories (listen -> questions -> text -> repeat -> retell)

// Story levels: each story's results decide the next one (longer and harder, the same, or shorter).
const STORY_TIERS = {
  1: 'about 45 seconds', 2: 'about 1 minute', 3: 'about 1.5–2 minutes',
  4: 'about 2.5 minutes', 5: 'about 3.5–4 minutes', 6: 'about 5–6 minutes',
};
// Some stories write the letter into the option text ("A 一盒饼干"); the letter is shown separately.
const OPTION_LETTER = /^[A-Da-d]\s*[.、:：)）]?\s+|^[A-Da-d][.、:：)）]\s*/;
const STORY_UP = 85; // overall score to get a longer story next time
const STORY_DOWN = 65; // below this the next story is shorter

let S = null; // current story session

function storyState() {
  state.story ??= { tier: Math.min(3, 1 + (state.level >= 4 ? 1 : 0) + (learnedCount() >= 50 ? 1 : 0)), history: [], unlockedAt: 0 };
  return state.story;
}
const storyUnlocked = () => learnedCount() >= (state.story?.unlockedAt || 0) + 10;

// Words for the next story: the most recently learned first (or the level's first words for a beginner).
async function storyWords() {
  const learned = Object.entries(state.words).sort((a, b) => (b[1].learned || '').localeCompare(a[1].learned || '')).map(([w]) => w);
  if (learned.length >= 8) return learned.slice(0, 20);
  const next = (await nextNewWords(12)).map((w) => w[0]);
  return [...learned, ...next].slice(0, 15);
}

async function storyRequest(tier) {
  return { level: state.level, tier, words: await storyWords() };
}

// Highlight words the learner has studied (tap = open its lesson).
function markWords(zh) {
  const known = [...new Set([...Object.keys(state.words), ...(S?.story?.chapter ? S.story.words : [])])].sort((a, b) => b.length - a.length);
  let out = '';
  for (let i = 0; i < zh.length;) {
    const w = known.find((k) => zh.startsWith(k, i));
    if (w) { out += `<button type="button" class="t-known" data-act="open" data-word="${esc(w)}">${esc(w)}</button>`; i += w.length; } else { out += esc(zh[i]); i++; }
  }
  return out;
}

// ---------- story home

function renderStoryHome() {
  screen = 'storyHome';
  reading++;
  stopVoice();
  const st = storyState();
  const hist = st.history.slice(-10).reverse();
  show(`${topBar('Story time')}
    <div class="t-hero">${face('hero')}
      <h1>听故事 · Story time</h1>
      <p>Listen to a story made with <b>your words</b>, answer questions like the HSK listening exam, repeat it, then tell it back in your own Chinese.</p>
    </div>
    <div class="t-card">
      <div class="t-row"><span>Your story level</span><b>Level ${st.tier} of 6</b></div>
      <div class="t-bar"><i style="width:${Math.round((st.tier / 6) * 100)}%"></i></div>
      <div class="t-small">Next story: ${STORY_TIERS[st.tier]}. Score ${STORY_UP}+ and your next story gets longer and harder; under ${STORY_DOWN} it gets shorter.</div>
    </div>
    <button type="button" class="t-primary" data-act="storyNew">▶ New story with my words</button>
    <div class="t-card t-chapter-pick">
      <b>Story from a chapter</b>
      <p class="t-note">A story that uses all 10 words of one chapter.</p>
      <div class="t-pick-row">
        <select id="tChLevel">${LEVELS.map(([n, name]) => `<option value="${n}" ${n === state.level ? 'selected' : ''}>${name}</option>`).join('')}</select>
        <label>Chapter <input id="tChNum" type="number" min="1" value="1" inputmode="numeric"></label>
        <button type="button" class="t-chip" data-act="chapterStoryPick">📖 Make story</button>
      </div>
    </div>
    ${hist.length ? `<h2 class="t-h2">Your stories</h2><div class="t-story-list">${hist.map((h) => `
      <button type="button" class="t-story-item" data-act="storyOpen" data-id="${esc(h.id)}">
        <b>${esc(h.title)}</b><small>${esc(h.title_en || '')}</small>
        <span>${h.chapter ? `${levelName(h.level)} · Chapter ${h.chapter} · ` : ''}Level ${h.tier} · ${h.date}${h.overall != null ? ` · <b>${h.overall}</b>` : ''}</span></button>`).join('')}</div>` : ''}`);
}

actions.story = () => renderStoryHome();
actions.storyNew = async () => {
  const st = storyState();
  st.unlockedAt = learnedCount();
  save();
  await loadStory(api('story-new', await storyRequest(st.tier)));
};
// A story from all 10 words of one chapter (from Vocabulary or the picker on Story home).
actions.chapterStory = (d) => loadStory(api('story-new', { level: Number(d.level), tier: storyState().tier, chapter: Number(d.chapter) }));
actions.chapterStoryPick = () => {
  const level = Number(document.getElementById('tChLevel').value);
  const max = Math.ceil((LEVELS.find((l) => l[0] === level)?.[3] || 10) / 10);
  const chapter = Number(document.getElementById('tChNum').value);
  if (!(chapter >= 1 && chapter <= max)) return toast(`${levelName(level)} has chapters 1 to ${max}.`);
  actions.chapterStory({ level, chapter });
};
actions.storyOpen = (d) => loadStory(api(`story?id=${encodeURIComponent(d.id)}`));

async function loadStory(promise) {
  screen = 'story';
  show(`${topBar('Story', 'story')}
    <div class="t-preparing">${face('big')}<p class="t-muted"><span id="tPrepStep">Your tutor is writing a story with your words…</span><br>Longer stories take up to a minute. <span id="tPrepSecs"></span></p><div class="t-spinner"></div></div>`);
  const started = Date.now();
  const timer = setInterval(() => {
    const el = document.getElementById('tPrepSecs');
    if (!el) return clearInterval(timer);
    el.textContent = `(${Math.round((Date.now() - started) / 1000)} s)`;
  }, 1000);
  try {
    const story = await promise.finally(() => clearInterval(timer));
    if (screen !== 'story') return;
    S = { story, listens: 0, answers: [], shadow: [], retell: null, i: 0 };
    preloadVoice(story.sentences[0]?.zh, story.sentences[1]?.zh);
    // Keep every opened story in the list, so it can be continued or replayed later.
    const st = storyState();
    if (!st.history.some((h) => h.id === story.id)) {
      st.history = [...st.history, { id: story.id, title: story.title, title_en: story.title_en, tier: story.tier, level: story.level, chapter: story.chapter || 0, date: today(), overall: null, open: true }].slice(-50);
      save();
    }
    renderListen();
  } catch (err) {
    if (screen === 'story') show(`${topBar('Story', 'story')}<div class="t-card">Sorry, the story could not be prepared: ${esc(err.message)}</div><button type="button" class="t-primary" data-act="storyNew">Try again</button>`);
  }
}

// ---------- 1. listen (text hidden, like the exam)

function renderListen() {
  const st = S.story;
  show(`${topBar(`Story · level ${st.tier}`, 'story')}
    <div class="t-hero">${face('hero')}
      <h1>${esc(st.title)}</h1>
      ${st.chapter ? `<p class="t-tagline">${levelName(st.level)} · Chapter ${st.chapter} · ${esc(st.words.join('、'))}</p>` : ''}
      <p class="t-muted">Step 1 of 5 · Listen carefully. Like the HSK exam, the text is hidden for now.</p>
    </div>
    <div class="t-card"><div class="t-row"><span id="tListenText">${S.listens ? 'Listened ' + S.listens + '×' : 'Ready'}</span><b id="tListenPos">0 / ${st.sentences.length}</b></div>
      <div class="t-bar"><i id="tListenBar" style="width:0%"></i></div></div>
    <button type="button" class="t-primary" data-act="storyPlay" id="tPlayBtn">▶ ${S.listens ? 'Listen again' : 'Start listening'}</button>
    <button type="button" class="t-secondary" data-act="storyQuestions" ${S.listens ? '' : 'disabled'} id="tToQuestions">Answer the questions ›</button>`);
}

let reading = 0; // increases to stop an older reading
actions.storyPlay = () => {
  const btn = document.getElementById('tPlayBtn');
  if (btn.dataset.playing === '1') { // pause
    reading++;
    stopVoice();
    btn.dataset.playing = '';
    btn.textContent = '▶ Continue';
    return;
  }
  btn.dataset.playing = '1';
  btn.textContent = '⏸ Pause';
  if (S.i >= S.story.sentences.length) S.i = 0;
  const token = ++reading;
  const sentences = S.story.sentences;
  const next = () => {
    if (token !== reading || screen !== 'story') return;
    const pos = document.getElementById('tListenPos');
    const bar = document.getElementById('tListenBar');
    if (pos) pos.textContent = `${S.i} / ${sentences.length}`;
    if (bar) bar.style.width = `${Math.round((S.i / sentences.length) * 100)}%`;
    if (S.i >= sentences.length) {
      S.listens++;
      btn.dataset.playing = '';
      btn.textContent = '▶ Listen again';
      document.getElementById('tListenText').textContent = `Listened ${S.listens}×`;
      document.getElementById('tToQuestions').disabled = false;
      return;
    }
    preloadVoice(sentences[S.i + 1]?.zh, sentences[S.i + 2]?.zh);
    say(sentences[S.i].zh, false, (error) => {
      if (error === 'not-allowed' || error === 'audio-busy' || error === 'synthesis-failed') {
        // The phone blocked the voice (no recent tap, or audio busy): stop here and ask for a tap.
        reading++;
        btn.dataset.playing = '';
        btn.textContent = '▶ Tap to continue listening';
        toast('The phone paused the voice. Tap ▶ to continue.');
        return;
      }
      S.i++;
      setTimeout(next, 250);
    });
  };
  next();
};

// ---------- 2. questions (HSK listening style, A-D)

actions.storyQuestions = () => { reading++; stopVoice(); S.q = 0; renderQuestion(); };

function renderQuestion() {
  const qs = S.story.questions;
  if (S.q >= qs.length) return renderStoryText();
  const q = qs[S.q];
  show(`${topBar(`Question ${S.q + 1} of ${qs.length}`, 'story')}${progress(S.q, qs.length)}
    <div class="t-situation t-sit-stage">${face('stage')}<div><b>Step 2 of 5 · Answer like the HSK listening exam</b><div class="t-tags"><i class="t-tag">听力</i></div></div></div>
    <div class="t-card t-task"><p class="t-zh-prompt">${esc(q.q)}</p><p class="t-en t-q-en" hidden>${esc(q.q_en)}</p>
      <div class="t-btns"><button type="button" class="t-chip" data-act="play" data-text="${esc(q.q)}">🔊 Listen</button><button type="button" class="t-chip" data-act="showQEn">English</button></div></div>
    <div class="t-options">${q.options.map((o, i) => `<button type="button" class="t-option" data-act="storyAnswer" data-i="${i}"><b>${'ABCD'[i]}</b><span>${esc(o.replace(OPTION_LETTER, ''))}</span></button>`).join('')}</div>
    <div id="tQResult"></div>`);
  setTimeout(() => say(q.q), 300);
}

actions.showQEn = () => { const el = view.querySelector('.t-q-en'); if (el) el.hidden = !el.hidden; };
actions.storyAnswer = (d) => {
  const q = S.story.questions[S.q];
  if (S.answers[S.q] != null) return;
  const pick = Number(d.i);
  const right = pick === q.correct;
  S.answers[S.q] = right;
  const opts = view.querySelectorAll('.t-option');
  opts.forEach((b, i) => { b.disabled = true; if (i === q.correct) b.classList.add('right'); else if (i === pick) b.classList.add('wrong'); });
  mood(right ? 'great' : 'again');
  activity('quiz');
  document.getElementById('tQResult').innerHTML = `
    <div class="t-badge ${right ? 'great' : 'bad'}"><b>${right ? '✓' : '✗'}</b><span>${right ? 'Correct!' : `The answer is ${'ABCD'[q.correct]}.`} ${esc(q.explain)}</span></div>
    <button type="button" class="t-primary" data-act="storyNextQ">${S.q + 1 < S.story.questions.length ? 'Next question ›' : 'See the story text ›'}</button>`;
};
actions.storyNextQ = () => { S.q++; renderQuestion(); };

// ---------- 3. the text

function renderStoryText() {
  const st = S.story;
  show(`${topBar(esc(st.title), 'story')}
    <p class="t-note">Step 3 of 5 · Read the story. <span class="t-known-key">Gold</span> = your words (tap to open the lesson). Tap 🔊 to hear a sentence.</p>
    <div class="t-btns t-left"><button type="button" class="t-chip" data-act="togglePinyin">${prefs.pinyin ? 'Hide' : 'Show'} pinyin</button><button type="button" class="t-chip" data-act="toggleEn">Show English</button></div>
    <div class="t-card t-storytext">${st.sentences.map((x) => `
      <div class="t-sline"><button type="button" class="t-say" data-act="play" data-text="${esc(x.zh)}" aria-label="Listen">🔊</button>
        <div><div class="t-zh-s">${markWords(x.zh)}</div><div class="t-py">${esc(x.pinyin)}</div><div class="t-en" hidden>${esc(x.en)}</div></div></div>`).join('')}
    </div>
    ${st.new_words.length ? `<h2 class="t-h2">New words in this story</h2><div class="t-chunks">${st.new_words.map((w) => `
      <button type="button" class="t-chunk" data-act="play" data-text="${esc(w.word)}"><b>${esc(w.word)}</b><span class="t-py">${esc(w.pinyin)}</span><small>${esc(w.meaning)}</small></button>`).join('')}</div>` : ''}
    ${st.lesson ? `<div class="t-card t-coach">${face('small')}<p>${esc(st.lesson)}</p></div>` : ''}
    <button type="button" class="t-primary" data-act="storyShadow">Practice speaking · repeat after me ›</button>`);
}

actions.toggleEn = (d, el) => {
  const hidden = !view.querySelector('.t-storytext .t-en')?.hidden;
  view.querySelectorAll('.t-storytext .t-en').forEach((e) => { e.hidden = hidden; });
  el.textContent = hidden ? 'Show English' : 'Hide English';
};

// ---------- 4. repeat after the tutor (same rules as word lessons)

actions.storyShadow = () => { S.s = 0; renderShadow(); };

function renderShadow() {
  const sents = S.story.sentences;
  if (S.s >= sents.length) return renderRetell();
  const x = sents[S.s];
  const here = S.s;
  S.tries = 0;
  show(`${topBar(`Repeat · sentence ${S.s + 1} of ${sents.length}`, 'story')}${progress(S.s, sents.length)}
    <div class="t-situation t-sit-stage">${face('stage')}<div><b>Step 4 of 5 · Repeat after your tutor</b><div class="t-tags"><i class="t-tag">${esc(S.story.title)}</i></div></div></div>
    <div class="t-coachline" id="tCoach">🔊 Listen to your tutor…</div>
    <div class="t-card t-sentence">
      <div class="t-zh" id="tZh">${esc(x.zh)}</div><div class="t-py">${esc(x.pinyin)}</div><div class="t-en">${esc(x.en)}</div>
      <div class="t-btns"><button type="button" class="t-chip" data-act="play" data-text="${esc(x.zh)}">🔊 Listen</button><button type="button" class="t-chip" data-act="play" data-text="${esc(x.zh)}" data-slow="1">🐢 Slow</button></div>
    </div>
    <div class="t-heard" hidden></div>
    <div class="t-result" id="tResult">${S.shadow[S.s] != null ? scoreBadge(S.shadow[S.s]) : ''}</div>
    <div class="t-actions">
      ${holdBtn('Hold & repeat after me')}
      <div class="t-nav"><button type="button" class="t-secondary" data-act="storyRetell">Finish ›</button><button type="button" class="t-primary" data-act="shadowNext">${S.shadow[S.s] != null ? 'Next ›' : 'Skip ›'}</button></div>
    </div>`, onStoryShadow, S.story.words || []);
  setTimeout(() => { if (S.s === here && screen === 'story') say(x.zh, false, () => storyTurn(here)); }, 350);
}

function storyTurn(here) {
  if (S.s !== here || screen !== 'story') return;
  coach('🎙️ Your turn: hold the purple button and repeat.', 'turn');
  view.querySelector('.t-hold')?.classList.add('pulse');
}

actions.shadowNext = () => { S.s++; renderShadow(); };

function onStoryShadow(text) {
  const x = S.story.sentences[S.s];
  const here = S.s;
  const { score, hit } = compare(x.zh, text);
  if (S.shadow[S.s] == null) activity('sentences');
  S.shadow[S.s] = Math.max(S.shadow[S.s] ?? 0, score);
  S.tries++;
  view.querySelector('.t-hold')?.classList.remove('pulse');
  document.getElementById('tZh').innerHTML = markedSentence(x.zh, hit);
  document.getElementById('tResult').innerHTML = scoreBadge(score);
  const nextBtn = view.querySelector('.t-nav .t-primary');
  if (nextBtn) nextBtn.textContent = 'Next ›';
  if (score >= PASS) {
    mood('great');
    coach('✓ Well done! Next sentence…', 'good');
    say(PRAISE[Math.floor(Math.random() * PRAISE.length)], false, () => {
      setTimeout(() => { if (S.s === here && screen === 'story') actions.shadowNext(); }, 600);
    });
  } else if (S.tries < MAX_TRIES) {
    mood('again');
    coach(`Listen again, slowly. Red = missed. Try ${S.tries + 1} of ${MAX_TRIES}.`, 'again');
    setTimeout(() => { if (S.s === here && screen === 'story') say(x.zh, true, () => storyTurn(here)); }, 900);
  } else {
    mood('again');
    coach('Good effort! Move on when you are ready.', 'again');
  }
}

// ---------- 5. retell in your own Chinese

actions.storyRetell = () => renderRetell();

function renderRetell() {
  const st = S.story;
  show(`${topBar('Retell the story', 'story')}
    <div class="t-situation t-sit-stage">${face('stage')}<div><b>Step 5 of 5 · Tell the story in your own Chinese</b><div class="t-tags"><i class="t-tag diff-hard">Speaking</i></div></div></div>
    <div class="t-card t-task"><p>${esc(st.retell_hint || 'Tell what happened, in order, and how it ended.')}</p>
      <p class="t-note">Tap the button, speak as long as you need, then tap again. Your words: ${esc((st.words || []).slice(0, 8).join('、'))}</p></div>
    <div class="t-heard" hidden></div>
    <div id="tGrade"></div>
    <div class="t-actions" id="tRetellActions">
      <button type="button" class="t-hold" data-act="recToggle" data-toggle="1" data-label="Tap to start telling the story">🎙️ <span>Tap to start telling the story</span></button>
      <div class="t-type"><input id="tType" type="text" placeholder="…or type your retelling" lang="zh-CN" enterkeyhint="done"><button type="button" class="t-chip" data-act="retellType">Check</button></div>
      <div class="t-nav"><button type="button" class="t-secondary" data-act="storyResult">Skip ›</button></div>
    </div>`, onRetell, st.words || []);
}

actions.recToggle = (d, el) => { if (rec) stopHold(); else startHold(el); };
actions.retellType = () => { const v = document.getElementById('tType').value.trim(); if (v) onRetell(v); };

async function onRetell(said) {
  const heard = view.querySelector('.t-heard');
  heard.hidden = false;
  heard.innerHTML = `<span class="t-muted">You:</span> ${esc(said)}`;
  const box = document.getElementById('tGrade');
  box.innerHTML = '<div class="t-card t-muted">Your tutor is checking your story…</div>';
  try {
    const r = await api('story-retell', { id: S.story.id, said });
    S.retell = Math.max(S.retell ?? 0, r.score);
    mood(r.score >= 70 ? 'great' : 'again');
    activity('quiz');
    box.innerHTML = `
      <div class="t-badge ${r.score >= 90 ? 'great' : r.score >= 70 ? 'good' : r.score >= 40 ? 'again' : 'bad'}"><b>${r.score}</b><span>${esc(r.content)}</span></div>
      ${r.language ? `<div class="t-card"><b class="t-gold">Language</b><p>${esc(r.language)}</p></div>` : ''}
      <div class="t-card t-native"><small>A native would tell it like this</small><div class="t-zh">${esc(r.native)}</div><div class="t-py">${esc(r.native_pinyin)}</div>
        <div class="t-btns"><button type="button" class="t-chip" data-act="play" data-text="${esc(r.native)}">🔊 Listen</button><button type="button" class="t-chip" data-act="play" data-text="${esc(r.native)}" data-slow="1">🐢 Slow</button></div></div>`;
    view.querySelector('#tRetellActions .t-nav').innerHTML = '<button type="button" class="t-primary" data-act="storyResult">See my results ›</button>';
  } catch (err) {
    box.innerHTML = `<div class="t-card">Could not check: ${esc(err.message)}</div>`;
  }
}

// ---------- results: decide the next story's length

actions.storyResult = () => {
  const st = storyState();
  const story = S.story;
  const qPct = Math.round((100 * S.answers.filter(Boolean).length) / story.questions.length);
  const sh = S.shadow.filter((x) => x != null);
  const shAvg = sh.length ? Math.round(sh.reduce((a, b) => a + b, 0) / sh.length) : null;
  // Weighted score of the parts that were done: questions 40 %, repeating 30 %, retelling 30 %.
  const parts = [[qPct, 0.4], [shAvg, 0.3], [S.retell, 0.3]].filter(([v]) => v != null);
  const overall = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0));
  const replay = st.history.some((h) => h.id === story.id && !h.open);
  let change = 0;
  if (!replay && story.tier === st.tier) {
    if (overall >= STORY_UP && st.tier < 6) change = 1;
    else if (overall < STORY_DOWN && st.tier > 1) change = -1;
    st.tier += change;
  }
  const entry = { id: story.id, title: story.title, title_en: story.title_en, tier: story.tier, level: story.level, chapter: story.chapter || 0, date: today(), q: qPct, shadow: shAvg, retell: S.retell, overall };
  st.history = [...st.history.filter((h) => h.id !== story.id), entry].slice(-50);
  save();
  // Write the next story now, so it is ready when the learner wants it.
  storyRequest(st.tier).then((r) => api('story-prepare', r)).catch(() => {});
  const msg = change > 0 ? `Excellent! Your next story will be longer and harder: level ${st.tier}, ${STORY_TIERS[st.tier]}.`
    : change < 0 ? `Your next story will be a bit shorter (level ${st.tier}, ${STORY_TIERS[st.tier]}) so you can build up again.`
      : replay ? 'Practice of an earlier story: your story level stays the same.'
        : `Your next story stays at level ${st.tier} (${STORY_TIERS[st.tier]}). Score ${STORY_UP}+ to move up.`;
  mood(overall >= 70 ? 'great' : 'again');
  show(`${topBar('Story results', 'story')}
    <div class="t-hero">${face('hero')}<h1>${overall}</h1><p>${esc(story.title)}</p></div>
    <div class="t-stats">
      <div><b>${qPct}%</b><small>questions</small></div>
      <div><b>${shAvg ?? '–'}</b><small>repeating</small></div>
      <div><b>${S.retell ?? '–'}</b><small>retelling</small></div>
    </div>
    <div class="t-card t-coach">${face('small')}<p>${msg}</p></div>
    <button type="button" class="t-primary" data-act="storyNew">▶ Next story</button>
    <button type="button" class="t-secondary" data-act="home">Home</button>`);
};

// ---------------------------------------------------------------- mode switch (Translate / Tutor)

let started = false;
async function enterTutor() {
  B.stopTranslator();
  if (started) return;
  started = true;
  view.classList.toggle('no-pinyin', !prefs.pinyin);
  show(`<div class="t-preparing">${face('big')}<div class="t-spinner"></div></div>`);
  await loadState();
  if (state) renderHome(); else renderSetup();
}

// mode: 'start' (choose screen, shown when the app opens), 'translate' or 'tutor'.
function setMode(mode) {
  document.body.classList.toggle('mode-start', mode === 'start');
  document.body.classList.toggle('mode-tutor', mode === 'tutor');
  document.body.classList.toggle('mode-translate', mode === 'translate');
  if (mode !== 'translate') B.stopTranslator();
  if (mode === 'tutor') enterTutor();
  else { stopVoice(); if (rec) stopHold(); }
}

// Start screen icons, the translator's home button and the tutor's home button (all carry data-mode).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  B.gesture();
  audioUnlock();
  setMode(b.dataset.mode);
});
setMode('start');
