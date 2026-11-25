// MISHU Translator - iPhone web app.
// Mic -> 16 kHz PCM frames -> server (WebSocket) -> sentence segments back -> subtitles + voice.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- settings

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`mishu.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`mishu.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const settings = {
  route: store.get('route', null),
  output: store.get('output', 'ear'),
  rate: store.get('rate', 1.05),
  font: store.get('font', 22),
  topic: store.get('topic', ''),
  hotWords: store.get('hotWords', ''),
  saveCost: store.get('saveCost', true),
  twoWay: store.get('twoWay', false),
};

// Two-way auto: Listen translates both ways (needs the Doubao interpretation engine).
const twoWayOn = () => settings.twoWay && settings.route === 'si';
const listenDir = () => (twoWayOn() ? 'auto' : 'zh-en');
const hasZh = (text) => /[㐀-鿿]/.test(text || '');
// "Mine" = I spoke English, so the result is Chinese for them (shown on my side, spoken in Chinese).
const isMine = (m) => m.stream === 'talk' || (twoWayOn() && (m.tr ? hasZh(m.tr) : !!m.src && !hasZh(m.src)));
const voiceLang = (m) => (isMine(m) ? 'zh' : 'en');

const ROUTE_NAMES = { si: 'Doubao interpretation', 'asr-doubao': 'ASR + Doubao', 'asr-deepseek': 'ASR + DeepSeek', demo: 'Demo' };
const OUTPUTS = { ear: ['🎧', 'Earphones'], speaker: ['🔊', 'Speaker'], off: ['🔇', 'Text only'] };
let routesReady = { demo: true };

function saveSetting(key, value) {
  settings[key] = value;
  store.set(key, value);
  applySettings();
}

function applySettings() {
  document.documentElement.style.setProperty('--font', `${settings.font}px`);
  $('routeBtn').textContent = ROUTE_NAMES[settings.route] || 'Demo';
  const [icon, label] = OUTPUTS[settings.output];
  $('outputBtn').innerHTML = `${icon}<small>${label}</small>`;
  $('route').value = settings.route;
  $('output').value = settings.output;
  $('rate').value = settings.rate;
  $('rateVal').textContent = `${Number(settings.rate).toFixed(2)}×`;
  $('font').value = settings.font;
  $('fontVal').textContent = `${settings.font}px`;
  $('topic').value = settings.topic;
  $('hotWords').value = settings.hotWords;
  $('saveCost').checked = settings.saveCost;
  $('twoWay').checked = settings.twoWay;
  $('twoWayHint').textContent = settings.twoWay && settings.route !== 'si' ? 'Two-way works only with Doubao interpretation.' : '';
  $('listenBtn').querySelector('small').textContent = twoWayOn() ? '中文 ⇄ English' : '中文 → English';
  $('routeHint').textContent = routesReady[settings.route] ? '' : 'Keys for this engine are not in .env on the PC yet.';
}

// ---------------------------------------------------------------- server connection

let ws = null;
let wsOk = false;
let netProblem = null;
let netProblemSince = 0;
let netBarTimer;
const streamState = { listen: 'closed', talk: 'closed' };

let lastPong = Date.now();

// Private access key: asked once, then remembered on this phone. A link with ?key=... also works.
let accessKey = store.get('accessKey', '');

async function ensureAccessKey() {
  const fromLink = new URLSearchParams(location.search).get('key');
  if (fromLink) {
    accessKey = fromLink;
    history.replaceState(null, '', location.pathname);
  }
  for (;;) {
    try {
      const { ok } = await (await fetch(`/api/check?key=${encodeURIComponent(accessKey)}`)).json();
      if (ok) break;
    } catch {
      break; // offline: try with the saved key, the server checks again
    }
    const typed = prompt(accessKey ? 'That access key is not valid. Please enter your MISHU access key:' : 'Please enter your MISHU access key:');
    if (typed == null) return false;
    accessKey = typed.trim();
  }
  store.set('accessKey', accessKey);
  return true;
}

function connectWs() {
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?key=${encodeURIComponent(accessKey)}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    wsOk = true;
    lastPong = Date.now();
    if (netProblem === 'pc') setNetProblem(null);
    sendConfig();
    reportVoices();
    if (listening) sendJson({ type: 'start', stream: 'listen', dir: listenDir() });
    updateStatus();
  };
  sock.onmessage = (e) => {
    lastPong = Date.now();
    if (netProblem === 'pc') setNetProblem(null);
    try { onServer(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // an older socket we already replaced
    wsOk = false;
    setNetProblem('pc');
    updateStatus();
    setTimeout(connectWs, 1500);
  };
}

// After the phone sleeps (or Wi-Fi freezes), a socket can look open but be dead. Ping every 3 s:
// no answer for 6 s = show "connection lost"; no answer for 12 s = replace the connection.
function checkConnection() {
  const silentMs = Date.now() - lastPong;
  if (wsOk && silentMs > 6000) setNetProblem('pc');
  if (wsOk && silentMs > 12000) {
    const dead = ws;
    wsOk = false;
    ws = null;
    try { dead.close(); } catch { /* already closed */ }
    connectWs();
  }
}

function sendJson(msg) {
  if (wsOk) ws.send(JSON.stringify(msg));
}

function sendConfig() {
  const hotWords = settings.hotWords.split(/[,，、]/).map((w) => w.trim()).filter(Boolean);
  sendJson({ type: 'config', route: settings.route, topic: settings.topic, hotWords });
}

function sendAudio(streamId, pcm) {
  if (!wsOk || ws.bufferedAmount > 64000) return; // drop audio rather than build up delay
  const packet = new Uint8Array(1 + pcm.byteLength);
  packet[0] = streamId;
  packet.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  ws.send(packet);
}

function onServer(msg) {
  if (msg.stream === 'tutor') return tutorBridge.onMessage?.(msg); // tutor practice: handled by tutor.js
  if (msg.type === 'seg') {
    renderSeg(msg);
    speakSeg(msg);
  } else if (msg.type === 'status') {
    streamState[msg.stream] = msg.state;
    if (msg.state === 'reconnecting') setNetProblem('service');
    else if (msg.state === 'live' && netProblem === 'service') setNetProblem(null);
    updateStatus();
  } else if (msg.type === 'error') {
    showError(msg.message);
  } else if (msg.type === 'usage') {
    addUsage(msg);
  }
}

// ---------------------------------------------------------------- usage / cost counter

// Doubao interpretation prices (yuan per token), from the Volcengine console.
const PRICE = { input_audio_tokens: 0.00008, output_text_tokens: 0.00008, output_audio_tokens: 0.0003 };
const usage = store.get('usage', { tokens: 0, yuan: 0, seconds: 0, since: new Date().toISOString().slice(0, 10) });

function addUsage(msg) {
  for (const item of msg.items || []) {
    usage.tokens += item.quantity;
    usage.yuan += item.quantity * (PRICE[item.unit] || 0);
  }
  usage.seconds += (msg.durationMs || 0) / 1000;
  store.set('usage', usage);
  showUsage();
}

function showUsage() {
  const minutes = Math.round(usage.seconds / 60);
  $('usageText').textContent =
    `${Math.round(usage.tokens).toLocaleString()} tokens · ${minutes} min of speech · ≈ ¥${usage.yuan.toFixed(2)} since ${usage.since}` +
    ' (first 1,000,000 tokens are free)';
}

setInterval(() => sendJson({ type: 'ping' }), 3000);
setInterval(checkConnection, 1000);

// ---------------------------------------------------------------- status & errors

function updateStatus() {
  const dot = $('dot');
  let text;
  let cls = '';
  if (netProblem && !(listening || talking)) { netProblem = null; $('netBar').hidden = true; }
  if (!wsOk) text = 'Connecting to PC…';
  else if (talking) { text = streamState.talk === 'live' ? 'Speak English now…' : streamState.talk === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'; cls = 'live'; }
  else if (listening) { text = streamState.listen === 'live' ? (twoWayOn() ? 'Listening both ways…' : 'Listening for Chinese…') : streamState.listen === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'; cls = 'live'; }
  else { text = 'Ready'; cls = 'ok'; }
  $('statusText').textContent = text;
  dot.className = `dot ${cls}`;
}

let errorTimer;
function showError(message) {
  const bar = $('errorBar');
  bar.textContent = message;
  bar.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (bar.hidden = true), 10000);
}
$('errorBar').onclick = () => ($('errorBar').hidden = true);

// Network trouble message: 'pc' = no answer from the PC (Wi-Fi), 'service' = PC lost Doubao (internet).
// Only shown while listening/talking with the app on screen; a short "Reconnected" follows.
function setNetProblem(kind) {
  if (kind === netProblem) return;
  const bar = $('netBar');
  clearTimeout(netBarTimer);
  if (kind) {
    if (!(listening || talking) || document.visibilityState !== 'visible') return;
    if (!netProblem) netProblemSince = Date.now();
    netProblem = kind;
    bar.className = 'net-bar';
    bar.textContent = kind === 'pc'
      ? '📶 Connection to PC lost (Wi-Fi). Reconnecting…'
      : '📶 Translation service not answering (PC internet). Reconnecting…';
    bar.hidden = false;
  } else {
    const secs = Math.round((Date.now() - netProblemSince) / 1000);
    report(`net-restored:${netProblem}:${secs}s`);
    netProblem = null;
    bar.className = 'net-bar ok';
    bar.textContent = `✓ Reconnected (was interrupted ${secs} s)`;
    netBarTimer = setTimeout(() => (bar.hidden = true), 4000);
  }
}

// ---------------------------------------------------------------- transcript

const segEls = new Map();
const segData = new Map();

function renderSeg(m) {
  segData.set(m.id, m);
  let el = segEls.get(m.id);
  const box = $('transcript');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (!el) {
    $('empty')?.remove();
    el = document.createElement('div');
    // Chat layout: the other person on the left ("TA" badge), the user on the right (tutor avatar).
    el.className = `seg${m.stream === 'talk' ? ' me' : ''}`;
    el.innerHTML = '<span class="ava" aria-hidden="true"><b>TA</b></span><div class="bub"><button class="replay" type="button" aria-label="Replay">🔈</button><div class="src"></div><div class="tr"></div></div>';
    el.querySelector('.replay').onclick = () => {
      const d = segData.get(m.id);
      if (d?.tr) speak(d.tr, voiceLang(d), true);
    };
    box.append(el);
    segEls.set(m.id, el);
    while (segEls.size > 200) {
      const [oldId, oldEl] = segEls.entries().next().value;
      oldEl.remove();
      segEls.delete(oldId);
      segData.delete(oldId);
    }
  }
  el.querySelector('.src').textContent = m.src;
  el.querySelector('.tr').textContent = m.tr;
  el.classList.toggle('partial', !m.srcFinal);
  el.classList.toggle('me', isMine(m));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

$('clearBtn').onclick = () => {
  for (const el of segEls.values()) el.remove();
  segEls.clear();
  segData.clear();
  spokenUpTo.clear();
};

// ---------------------------------------------------------------- voice output

const spokenUpTo = new Map();
const idleTimers = new Map();
let pending = 0;
let pendingZh = 0;
let voices = [];

function loadVoices() {
  voices = speechSynthesis.getVoices();
  reportVoices();
}

// Tell the PC which spoken languages this iPhone has (to plan language support, e.g. Bangla).
let voicesReported = false;
function reportVoices() {
  if (voicesReported || !wsOk || !voices.length) return;
  voicesReported = true;
  const langs = [...new Set(voices.map((v) => v.lang.replace('_', '-')))].sort();
  const bangla = voices.filter((v) => /^bn/i.test(v.lang)).map((v) => `${v.name} (${v.lang})`);
  sendJson({ type: 'voices', count: voices.length, langs, bangla });
}
loadVoices();
speechSynthesis.onvoiceschanged = loadVoices;

function pickVoice(lang) {
  const want = lang === 'zh' ? 'zh-CN' : 'en-US';
  const prefix = lang === 'zh' ? 'zh' : 'en';
  const norm = (v) => v.lang.replace('_', '-');
  const exact = voices.filter((v) => norm(v) === want);
  return exact.find((v) => /premium|enhanced/i.test(v.name)) || exact[0] || voices.find((v) => norm(v).startsWith(prefix)) || null;
}

function speak(text, lang, force = false) {
  if (!text || (settings.output === 'off' && !force)) return;
  // Never let the voice fall far behind the conversation (and keep the mic muted that long):
  // if more than 2 sentences are waiting, drop them and continue with the newest one.
  if (pending > 2) {
    speechSynthesis.cancel();
    pending = 0;
    pendingZh = 0;
    report('speech-skip-backlog');
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = Number(settings.rate);
  pending++;
  if (lang === 'zh') pendingZh++;
  let finished = false;
  let stuckTimer;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(stuckTimer);
    pending = Math.max(0, pending - 1);
    if (lang === 'zh') pendingZh = Math.max(0, pendingZh - 1);
  };
  // iOS speech sometimes hangs and never fires onend, which would keep the mic muted forever.
  // If an utterance takes far longer than it should, reset the speech engine.
  const reset = () => {
    if (finished) return;
    speechSynthesis.cancel();
    pending = 0;
    pendingZh = 0;
    finished = true;
    report('speech-reset');
  };
  // Time limit counts from when this sentence starts speaking (not while it waits in the queue),
  // with a generous fallback in case it never starts at all.
  const expectedMs = 5000 + (text.length * (lang === 'zh' ? 450 : 150)) / Number(settings.rate);
  stuckTimer = setTimeout(reset, 30000);
  u.onstart = () => {
    clearTimeout(stuckTimer);
    stuckTimer = setTimeout(reset, expectedMs);
  };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

// iOS sometimes never fires onend - resynchronise the counters.
setInterval(() => {
  if (!speechSynthesis.speaking && !speechSynthesis.pending) { pending = 0; pendingZh = 0; }
}, 1000);

// Speak each finished sentence as soon as it is complete, without waiting for the whole segment.
function speakSeg(m) {
  const lang = voiceLang(m);
  const text = m.tr || '';
  const done = spokenUpTo.get(m.id) || 0;
  clearTimeout(idleTimers.get(m.id));
  if (text.length <= done) return;

  let upto = -1;
  if (m.trFinal) upto = text.length;
  else {
    const re = /[。！？!?.…；;]["'”’)]?(?=\s|$)/g;
    let match;
    while ((match = re.exec(text.slice(done)))) upto = done + match.index + match[0].length;
  }
  if (upto > done) {
    spokenUpTo.set(m.id, upto);
    speak(text.slice(done, upto).trim(), lang);
  }
  // If the text stops growing for a moment, speak whatever is left.
  if (!m.trFinal) {
    idleTimers.set(m.id, setTimeout(() => {
      const latest = segData.get(m.id);
      if (latest?.srcFinal) speakSeg({ ...latest, trFinal: true });
    }, 1400));
  }
}

let speechUnlocked = false;
function unlockSpeech() {
  // iOS only allows speech after a user tap; speaking an empty utterance unlocks it.
  if (speechUnlocked) return;
  speechUnlocked = true;
  speechSynthesis.speak(new SpeechSynthesisUtterance(''));
}

// ---------------------------------------------------------------- microphone

// One AudioContext + worklet for the whole page (iOS allows only a few per page, so we never
// create more). Only the microphone stream is re-opened when iOS kills it.
let audioCtx = null;
let micNode = null;
let micSource = null;
let micStream = null;
let listening = false;
let talking = false;
let lastFrameAt = 0;
let framesSinceReport = 0;
let micRestarts = 0;
let autoRepairUsed = false;
let micBusy = null;

const micTrack = () => micStream?.getAudioTracks()[0];
const micAlive = () => micTrack()?.readyState === 'live' && !micTrack()?.muted;
// resume() can hang forever on iOS without a tap: never wait more than 1.5 s.
const resumeAudio = () => Promise.race([audioCtx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);

async function setupAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('mic-worklet.js');
  micNode = new AudioWorkletNode(audioCtx, 'mic-processor');
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  micNode.connect(silent).connect(audioCtx.destination);
  micNode.port.onmessage = (e) => onFrame(new Int16Array(e.data));
  audioCtx.onstatechange = () => report(`audio:${audioCtx.state}`);
}

async function openMic() {
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { micSource?.disconnect(); } catch { /* ignore */ }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  micSource = audioCtx.createMediaStreamSource(micStream);
  micSource.connect(micNode);
  lastFrameAt = Date.now();
  const track = micTrack();
  // iOS ends or mutes the mic on interruptions (notification sounds, calls, Siri, other apps).
  track?.addEventListener('ended', () => report('mic-ended'));
  track?.addEventListener('mute', () => report('mic-muted'));
  track?.addEventListener('unmute', () => report('mic-unmuted'));
}

// Make sure the mic is running. forceReopen = also re-open a mic that looks alive.
// Best called from a tap (iOS allows audio restarts reliably only after a user gesture).
function ensureMic(forceReopen = false) {
  micBusy ??= (async () => {
    await setupAudio();
    if (forceReopen || !micAlive()) await openMic();
    if (audioCtx.state !== 'running') await resumeAudio();
  })().finally(() => { micBusy = null; });
  return micBusy;
}

async function repairMic(reason, fromTap) {
  micRestarts++;
  report(`mic-repair:${reason}`);
  try {
    await ensureMic(true);
  } catch (err) {
    showError(`Microphone: ${err.message}`);
  }
  lastFrameAt = Date.now();
  if (fromTap) $('resumeBar').hidden = true;
}

// Watchdog: while listening/talking with the app on screen, mic frames must arrive every 100 ms.
// If none for 3 s: one quiet automatic repair; if still silent, ask for a tap (always works).
setInterval(() => {
  if (!(listening || talking) || !audioCtx || micBusy) return;
  if (document.visibilityState !== 'visible') return; // iOS gives no mic in background anyway
  if (Date.now() - lastFrameAt < 3000) {
    autoRepairUsed = false;
    return;
  }
  if (!autoRepairUsed) {
    autoRepairUsed = true;
    repairMic(`no-audio(${audioCtx.state},${micTrack()?.readyState},muted=${micTrack()?.muted})`, false);
  } else if ($('resumeBar').hidden) {
    $('resumeBar').hidden = false;
    report('ask-tap');
  }
}, 1000);

$('resumeBar').onclick = () => {
  gestureKick();
  repairMic('tap', true);
};

// Health report to the PC log every 15 s, so problems on the phone can be diagnosed there.
function report(event) {
  sendJson({
    type: 'health', event,
    frames: framesSinceReport, listening, talking,
    ctx: audioCtx?.state || 'none',
    track: micTrack() ? `${micTrack().readyState}${micTrack().muted ? '/muted' : ''}` : 'none',
    speaking: pending, visible: document.visibilityState, wakeLock: !!wakeLock, micRestarts,
  });
  framesSinceReport = 0;
}
setInterval(() => { if (listening || talking) report('tick'); }, 15000);

// Mic is muted while our own voice plays from the loudspeaker, so the app does not translate itself.
// Chinese output (for them) always mutes it, because it is meant to be heard by the room.
const micGated = () => pending > 0 && (settings.output === 'speaker' || pendingZh > 0);

let preroll = [];
let hangover = 0;
let noiseFloor = 300;

function rms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function onFrame(pcm) {
  lastFrameAt = Date.now();
  framesSinceReport++;
  if (tutorRec) return sendAudio(2, pcm);
  if (talking) return sendAudio(1, pcm);
  if (!listening) return;
  if (micGated()) { preroll = []; return; }
  if (!settings.saveCost) return sendAudio(0, pcm);

  // Simple voice detector: only send audio around speech (plus a little before and after).
  const level = rms(pcm);
  const loud = level > Math.max(250, noiseFloor * 2.5);
  if (!loud) noiseFloor = noiseFloor * 0.95 + level * 0.05;
  if (loud) {
    // The interpretation model needs more trailing audio to finish its last sentence.
    hangover = settings.route === 'si' ? 40 : 15;
    for (const p of preroll) sendAudio(0, p);
    preroll = [];
  }
  if (hangover > 0) {
    hangover--;
    sendAudio(0, pcm);
  } else {
    preroll.push(pcm);
    if (preroll.length > 3) preroll.shift();
  }
}

// ---------------------------------------------------------------- screen wake lock

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch { /* not supported */ }
}

document.addEventListener('visibilitychange', () => {
  report(`visibility:${document.visibilityState}`);
  if (document.visibilityState !== 'visible') return;
  checkConnection();
  if (listening) {
    keepAwake(true);
    // Coming back from background: the mic is usually dead. Give the watchdog a fresh
    // 3 s window, then it repairs once and asks for a tap if needed.
    lastFrameAt = Date.now();
    autoRepairUsed = false;
    if (audioCtx && audioCtx.state !== 'running') resumeAudio();
  }
});

// ---------------------------------------------------------------- buttons

// Inside a tap, iOS allows audio to (re)start: wake everything up immediately.
function gestureKick() {
  unlockSpeech();
  audioCtx?.resume().catch(() => {});
}

$('listenBtn').onclick = async () => {
  gestureKick();
  if (listening) {
    listening = false;
    sendJson({ type: 'end', stream: 'listen' });
    keepAwake(false);
  } else {
    // Re-open the mic if it has been silent recently (e.g. after an interruption).
    const stale = !micAlive() || Date.now() - lastFrameAt > 3000;
    try { await ensureMic(stale); } catch (err) { return showError(`Microphone: ${err.message}`); }
    lastFrameAt = Date.now();
    autoRepairUsed = false;
    $('resumeBar').hidden = true;
    listening = true;
    sendJson({ type: 'start', stream: 'listen', dir: listenDir() });
    keepAwake(true);
  }
  $('listenBtn').classList.toggle('on', listening);
  $('listenBtn').querySelector('.listen-label').textContent = listening ? 'Stop' : 'Listen';
  updateStatus();
};

const talkBtn = $('talkBtn');
talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
talkBtn.addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  gestureKick();
  talkBtn.setPointerCapture?.(e.pointerId);
  talking = true;
  talkBtn.classList.add('on');
  speechSynthesis.cancel(); // stop reading their last sentence while I speak
  sendJson({ type: 'start', stream: 'talk', dir: 'en-zh' });
  updateStatus();
  try { await ensureMic(); } catch (err) { stopTalking(); showError(`Microphone: ${err.message}`); }
});
const stopTalking = () => {
  if (!talking) return;
  talking = false;
  talkBtn.classList.remove('on');
  sendJson({ type: 'end', stream: 'talk' });
  updateStatus();
};
talkBtn.addEventListener('pointerup', stopTalking);
talkBtn.addEventListener('pointercancel', stopTalking);

$('outputBtn').onclick = () => {
  const order = ['ear', 'speaker', 'off'];
  saveSetting('output', order[(order.indexOf(settings.output) + 1) % order.length]);
  if (settings.output === 'off') speechSynthesis.cancel();
};

$('resetUsageBtn').onclick = () => {
  Object.assign(usage, { tokens: 0, yuan: 0, seconds: 0, since: new Date().toISOString().slice(0, 10) });
  store.set('usage', usage);
  showUsage();
};

$('settingsBtn').onclick = () => $('settings').showModal();
$('routeBtn').onclick = () => $('settings').showModal();

$('route').onchange = (e) => {
  saveSetting('route', e.target.value);
  sendConfig();
  if (listening) sendJson({ type: 'start', stream: 'listen', dir: listenDir() }); // restart with the new engine
};
$('output').onchange = (e) => saveSetting('output', e.target.value);
$('rate').oninput = (e) => saveSetting('rate', Number(e.target.value));
$('font').oninput = (e) => saveSetting('font', Number(e.target.value));
$('saveCost').onchange = (e) => saveSetting('saveCost', e.target.checked);
$('twoWay').onchange = (e) => {
  saveSetting('twoWay', e.target.checked);
  if (listening) sendJson({ type: 'start', stream: 'listen', dir: listenDir() }); // restart in the new mode
  updateStatus();
};
$('topic').onchange = (e) => { saveSetting('topic', e.target.value.trim()); sendConfig(); };
$('hotWords').onchange = (e) => { saveSetting('hotWords', e.target.value.trim()); sendConfig(); };

// ---------------------------------------------------------------- tutor bridge

// tutor.js (the Tutor tab) uses this page's server connection, microphone and speech unlock.
let tutorRec = false;
let resolveKeyReady;
const tutorBridge = {
  onMessage: null,
  keyReady: new Promise((r) => (resolveKeyReady = r)),
  key: () => accessKey,
  connected: () => wsOk,
  send: (msg) => sendJson(msg),
  gesture: () => gestureKick(),
  async startRec(words) {
    sendJson({ type: 'config', tutorWords: words });
    sendJson({ type: 'start', stream: 'tutor', dir: 'zh-en' });
    await ensureMic(!micAlive() || Date.now() - lastFrameAt > 3000);
    lastFrameAt = Date.now();
    tutorRec = true;
  },
  stopRec() {
    if (!tutorRec) return;
    tutorRec = false;
    sendJson({ type: 'end', stream: 'tutor' });
  },
  // Leaving the translator for the tutor: stop listening so the two never share the mic.
  stopTranslator() {
    if (listening) $('listenBtn').click();
  },
};
window.mishuBridge = tutorBridge;

// Any script error on the phone goes to the server log (as a phone health line), so problems
// that only happen on the iPhone can be diagnosed from the server.
function reportError(text) {
  report(`js-error: ${String(text).slice(0, 300)}`);
}
addEventListener('error', (e) => reportError(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => reportError(e.reason?.stack || e.reason));
tutorBridge.reportError = reportError;

// ---------------------------------------------------------------- start

(async () => {
  try {
    routesReady = await (await fetch('/api/routes')).json();
  } catch { /* offline */ }
  if (!settings.route || !(settings.route in ROUTE_NAMES)) {
    settings.route = ['si', 'asr-deepseek', 'asr-doubao'].find((r) => routesReady[r]) || 'demo';
  }
  applySettings();
  showUsage();
  const keyOk = await ensureAccessKey();
  resolveKeyReady(keyOk);
  if (keyOk) connectWs(); // cancelled: stay offline until the app is reopened
})();
