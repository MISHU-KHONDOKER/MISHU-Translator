// MISHU Translator server.
// - HTTPS: serves the iPhone web app and the /ws WebSocket that carries mic audio + results
// - HTTP:  a setup page to download the certificate the iPhone needs to trust once
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { createSiStream } from './si.js';
import { createAsrStream } from './asr.js';
import { createDemoStream } from './demo.js';
import { handleTutorApi, addVoiceUsage } from './tutor.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// Prefix every log line with the time, so phone problems can be matched to the moment they happened,
// and also save it to logs/server-YYYY-MM-DD.log for later diagnosis.
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });
const rawLog = console.log;
console.log = (...args) => {
  const now = new Date();
  const line = [now.toLocaleTimeString('en-GB'), ...args].join(' ');
  rawLog(line);
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  try { fs.appendFileSync(path.join(LOGS, `server-${day}.log`), `${line}\n`); } catch { /* disk full etc. */ }
};
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
// Optional private access keys (comma-separated). When set, only phones that know a key can
// open a translation session, so strangers who find the server cannot spend the Doubao credit.
const ACCESS_KEYS = (process.env.ACCESS_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
const keyOk = (key) => !ACCESS_KEYS.length || ACCESS_KEYS.includes(key);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/api/routes') return json(res, availableRoutes());
  if (url.pathname === '/api/check') return json(res, { ok: keyOk(url.searchParams.get('key')) });
  if (url.pathname.startsWith('/api/tutor/')) return handleTutorApi(req, res, url, keyOk, json);
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return notFound(res);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return notFound(res);
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const notFound = (res) => { res.writeHead(404); res.end('Not found'); };

function availableRoutes() {
  const e = process.env;
  const speech = !!(e.SPEECH_API_KEY || (e.SPEECH_APP_ID && e.SPEECH_ACCESS_TOKEN));
  return {
    si: speech || !!(e.SI_APP_ID && e.SI_ACCESS_TOKEN),
    'asr-doubao': !!(speech && e.ARK_API_KEY && e.ARK_DOUBAO_MODEL),
    'asr-deepseek': !!(speech && e.ARK_API_KEY && e.ARK_DEEPSEEK_MODEL),
    demo: true,
  };
}

function lanIps() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

// ---------------------------------------------------------------- WebSocket sessions

function makeStream(ctx, stream, dir, send) {
  // 'auto' = hands-free two-way: Doubao interpretation detects zh or en per sentence and translates
  // the other way. Only the interpretation route supports it; the others fall back to zh -> en.
  const auto = dir === 'auto' && ctx.route === 'si';
  const [from, to] = auto ? ['zhen', 'zhen'] : dir === 'en-zh' ? ['en', 'zh'] : ['zh', 'en'];
  const opts = { stream, from, to, send, ctx, hotWords: ctx.hotWords };
  // Tutor: the learner speaks Chinese; only the recognised Chinese text is used. The word being
  // practised is passed as a hot word so it is recognised reliably.
  if (stream === 'tutor') {
    const tutorOpts = { ...opts, from: 'zh', to: 'en', hotWords: ctx.tutorWords || [] };
    return ctx.route === 'demo' ? createDemoStream(tutorOpts) : createSiStream(tutorOpts);
  }
  switch (ctx.route) {
    case 'si': return createSiStream(opts);
    case 'asr-doubao': return createAsrStream({ ...opts, llm: 'doubao' });
    case 'asr-deepseek': return createAsrStream({ ...opts, llm: 'deepseek' });
    default: return createDemoStream(opts);
  }
}

function handleClient(ws, req) {
  const ctx = { route: 'demo', topic: '', hotWords: [], history: [] };
  const streams = {};
  let healthTicks = 0;
  const logged = new Set();
  const key = new URL(req.url, 'https://x').searchParams.get('key') || '';
  const send = (msg) => {
    if (msg.type === 'usage' && msg.stream === 'tutor') addVoiceUsage(key, msg.items);
    if (msg.type === 'error') console.log(`  ! ${msg.stream || ''} ${msg.message}`);
    else if (msg.type === 'status' && msg.state === 'closed') console.log(`  ${msg.stream} upstream closed`);
    else if (msg.type === 'seg' && msg.trFinal && !logged.has(msg.id)) {
      logged.add(msg.id);
      console.log(`  ✓ ${msg.stream}: ${msg.src} => ${msg.tr}`);
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const ip = req.socket.remoteAddress;
  console.log(`Phone connected from ${ip}`);

  // The phone pings every 3 s, so a long silence while its screen is on = Wi-Fi stall.
  let lastPhoneMsg = Date.now();
  let phoneVisible = true;
  let phoneStallSince = 0;
  const stallWatch = setInterval(() => {
    if (!phoneStallSince && phoneVisible && Date.now() - lastPhoneMsg > 7000) {
      phoneStallSince = lastPhoneMsg;
      console.log('  ⚠ nothing received from phone for 7 s (Wi-Fi stall?)');
    }
    // The phone opens a fresh connection by itself; drop this dead one (and its Doubao session).
    if (Date.now() - lastPhoneMsg > 20000) {
      console.log('  ⚠ phone silent for 20 s - closing its old connection');
      ws.terminate();
    }
  }, 1000);

  ws.on('message', (data, isBinary) => {
    if (phoneStallSince) {
      console.log(`  phone data arriving again after ${Math.round((Date.now() - phoneStallSince) / 1000)} s`);
      phoneStallSince = 0;
    }
    lastPhoneMsg = Date.now();
    if (isBinary) {
      // First byte = stream (0 = listening to them, 1 = me talking, 2 = tutor practice), rest = 16 kHz PCM16 audio.
      const stream = streams[['listen', 'talk', 'tutor'][data[0]] || 'listen'];
      stream?.push(data.subarray(1));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'config') {
      if (msg.route) ctx.route = msg.route;
      if (typeof msg.topic === 'string') ctx.topic = msg.topic.slice(0, 200);
      if (Array.isArray(msg.hotWords)) ctx.hotWords = msg.hotWords.slice(0, 100);
      if (Array.isArray(msg.tutorWords)) ctx.tutorWords = msg.tutorWords.slice(0, 10).map(String);
    } else if (msg.type === 'start') {
      streams[msg.stream]?.close();
      streams[msg.stream] = makeStream(ctx, msg.stream, msg.dir, send);
      console.log(`  ${msg.stream} started (${ctx.route}, ${msg.dir})`);
    } else if (msg.type === 'end') {
      streams[msg.stream]?.end();
    } else if (msg.type === 'ping') {
      send({ type: 'pong' });
    } else if (msg.type === 'voices') {
      console.log(`  phone voices: ${msg.count} voices; Bangla: ${msg.bangla?.length ? msg.bangla.join(', ') : 'NONE'}; languages: ${(msg.langs || []).join(' ')}`);
    } else if (msg.type === 'health') {
      phoneVisible = msg.visible === 'visible';
      // Phone health: log anything unusual, and a normal "tick" once a minute.
      const bad = msg.event !== 'tick' || msg.ctx !== 'running' || msg.track !== 'live' || (msg.frames < 100 && (msg.listening || msg.talking));
      if (bad || ++healthTicks % 1 === 0) {
        console.log(`  ${bad ? '⚠' : '·'} phone ${msg.event}: listening=${msg.listening} talking=${msg.talking} frames=${msg.frames} audio=${msg.ctx} mic=${msg.track} speaking=${msg.speaking} screen=${msg.visible} wakeLock=${msg.wakeLock} micRestarts=${msg.micRestarts}`);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(stallWatch);
    for (const s of Object.values(streams)) s.close();
    console.log(`Phone disconnected (${ip})`);
  });
}

// ---------------------------------------------------------------- start servers

const keyFile = path.join(CERTS, 'server.key');
const certFile = path.join(CERTS, 'server.crt');
if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
  console.error('No HTTPS certificate yet. Run:  npm run cert');
  process.exit(1);
}

const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, serveStatic);
const verifyClient = ({ req }) => {
  if (keyOk(new URL(req.url, 'https://x').searchParams.get('key'))) return true;
  console.log(`Refused connection without a valid access key from ${req.socket.remoteAddress}`);
  return false;
};
new WebSocketServer({ server, path: '/ws', verifyClient }).on('connection', handleClient);
server.listen(HTTPS_PORT, '0.0.0.0');

// Plain HTTP setup page (certificate download), because the phone does not trust HTTPS yet.
http.createServer((req, res) => {
  if (req.url === '/ca.crt') {
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="MISHU-CA.crt"' });
    return fs.createReadStream(path.join(CERTS, 'ca.crt')).pipe(res);
  }
  const host = (req.headers.host || '').split(':')[0];
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(PUBLIC, 'setup.html'), 'utf8').replaceAll('{{APP_URL}}', `https://${host}:${HTTPS_PORT}/`));
}).listen(HTTP_PORT, '0.0.0.0');

const routes = availableRoutes();
console.log('\nMISHU Translator is running.');
console.log('Routes ready:', Object.entries(routes).filter(([, ok]) => ok).map(([r]) => r).join(', '));
console.log(ACCESS_KEYS.length ? `Access keys required (${ACCESS_KEYS.length} set).` : 'No access key required (ACCESS_KEYS not set).');
for (const ip of lanIps()) {
  console.log(`  iPhone first-time setup: http://${ip}:${HTTP_PORT}/`);
  console.log(`  iPhone app:              https://${ip}:${HTTPS_PORT}/`);
}
