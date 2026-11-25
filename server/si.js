// Route 1: Doubao simultaneous interpretation 2.0 (豆包同声传译), speech console API.
// Speech in -> source transcript + translation out, in a single model.
// Protocol: WebSocket, one protobuf TranslateRequest / TranslateResponse per frame.
// Docs: https://docs.volcengine.com/docs/6561/1756902
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { encode, decode, str, num } from './pb.js';
import { Segments } from './segments.js';

const AST_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';
const RESOURCE_ID = 'volc.service_type.10053';

const EV = {
  StartSession: 100, FinishSession: 102, TaskRequest: 200,
  SessionStarted: 150, SessionFinished: 152, SessionFailed: 153, UsageResponse: 154,
  SourceStart: 650, SourceResponse: 651, SourceEnd: 652,
  TranslationStart: 653, TranslationResponse: 654, TranslationEnd: 655,
};

function authHeaders() {
  const h = { 'X-Api-Resource-Id': RESOURCE_ID, 'X-Api-Connect-Id': randomUUID() };
  // The free interpretation trial lives in the old speech console app (App ID + Access Token).
  if (process.env.SI_APP_ID && process.env.SI_ACCESS_TOKEN) {
    h['X-Api-App-Id'] = process.env.SI_APP_ID;
    h['X-Api-Access-Key'] = process.env.SI_ACCESS_TOKEN;
  } else if (process.env.SPEECH_API_KEY) h['X-Api-Key'] = process.env.SPEECH_API_KEY;
  else {
    h['X-Api-App-Id'] = process.env.SPEECH_APP_ID;
    h['X-Api-Access-Key'] = process.env.SPEECH_ACCESS_TOKEN;
  }
  return h;
}

// Streamed text pieces may be deltas or the full text so far; handle both.
const merge = (current, incoming) => (incoming.startsWith(current) ? incoming : current + incoming);

export function createSiStream({ stream, from, to, hotWords, send }) {
  const segs = new Segments(stream, send);
  let ws = null;
  let sessionId = null;
  let ready = false;
  let ended = false;
  let queue = [];
  let lastConnect = 0;
  let curSrc = null; // segment receiving source text
  let curTr = null; // segment receiving translation text
  let failures = 0; // consecutive connections that never started
  let failLogged = false; // Doubao already said why it closed (SessionFailed)
  let lastPongAt = 0; // last WebSocket pong from Doubao (0 = it never answered a ping)
  let stallSince = 0; // when the PC -> Doubao link stopped answering
  let rejected = false; // Doubao refused the login (bad key etc.): retrying will not help

  // Doubao needs a steady real-time stream: it ends the session after ~8 s without packets and
  // also when packets arrive slower than real time. So we pace the stream ourselves: every 100 ms
  // send the next phone frame, or 100 ms of silence when the phone sent none (it skips silence
  // to save data, and pauses the mic while our own voice is playing).
  const SILENCE = Buffer.alloc(3200);
  const keepAlive = setInterval(() => {
    if (!ready || ended) return;
    watchLink();
    if (queue.length > 50) queue.splice(0, queue.length - 20); // > 5 s behind: drop oldest audio
    sendAudio(queue.shift() ?? SILENCE);
    if (queue.length > 3) sendAudio(queue.shift()); // catch up after a network hiccup
  }, 100);

  // Ping Doubao every 2 s; no pong for 4 s means the PC's internet has frozen (logged on the PC).
  let lastPingAt = 0;
  function watchLink() {
    const now = Date.now();
    if (now - lastPingAt >= 2000) { lastPingAt = now; try { ws.ping(); } catch { /* closing */ } }
    if (!lastPongAt) return;
    if (!stallSince && now - lastPongAt > 4000) {
      stallSince = lastPongAt;
      console.log(`  ⚠ ${stream}: PC -> Doubao link not answering for 4 s (PC internet / Wi-Fi frozen?)`);
    }
    // A link that froze often never closes by itself: drop it after 8 s so we reconnect.
    if (now - lastPongAt > 8000) {
      console.log(`  ⚠ ${stream}: PC -> Doubao link dead for 8 s - reconnecting`);
      failLogged = true;
      lastPongAt = 0;
      ws.terminate();
    }
  }
  function onPong() {
    const now = Date.now();
    if (stallSince) {
      console.log(`  ${stream}: PC -> Doubao link answering again after ${Math.round((now - stallSince) / 1000)} s`);
      stallSince = 0;
    }
    lastPongAt = now;
  }

  const meta = () => [[6, sessionId]];
  const sendPb = (fields) => ws?.readyState === WebSocket.OPEN && ws.send(encode(fields));

  function connect() {
    const e = process.env;
    if (!(e.SI_APP_ID && e.SI_ACCESS_TOKEN) && !e.SPEECH_API_KEY && !(e.SPEECH_APP_ID && e.SPEECH_ACCESS_TOKEN)) {
      send({ type: 'error', stream, message: 'Missing SI_APP_ID + SI_ACCESS_TOKEN (or SPEECH_API_KEY) in .env' });
      ended = true;
      return;
    }
    lastConnect = Date.now();
    ready = false;
    sessionId = randomUUID();
    send({ type: 'status', stream, state: 'connecting' });
    // Without a handshake timeout, a connect attempt during a network freeze can hang for good.
    ws = new WebSocket(AST_URL, { headers: authHeaders(), handshakeTimeout: 6000 });

    ws.on('open', () => {
      sendPb([
        [1, meta()],
        [2, EV.StartSession],
        [3, [[1, 'mishu-translator']]],
        [4, [[4, 'wav'], [5, 'raw'], [7, 16000], [8, 16], [9, 1]]],
        [5, [[4, 'pcm'], [7, 16000]]],
        [6, [[1, 's2t'], [2, from], [3, to], [100, (hotWords || []).map((w) => [9, w])]]],
      ]);
    });

    ws.on('message', (raw) => {
      let m;
      try { m = decode(Buffer.from(raw)); } catch (e) { return send({ type: 'error', stream, message: `Interpretation decode: ${e.message}` }); }
      const event = num(m, 2);
      const text = str(m, 4);
      const metaFields = m[1]?.[0] ? decode(m[1][0]) : {};
      switch (event) {
        case EV.SessionStarted:
          ready = true;
          failures = 0;
          send({ type: 'status', stream, state: 'live' });
          // Audio queued while connecting is sent by the 100 ms pacer.
          if (ended) finish();
          break;
        case EV.SourceStart:
          curSrc = segs.create({ start: num(m, 5) });
          break;
        case EV.SourceResponse:
          curSrc ??= segs.create({ start: num(m, 5) });
          curSrc.src = merge(curSrc.src, text);
          segs.emit(curSrc);
          break;
        case EV.SourceEnd:
          curSrc ??= segs.create({ start: num(m, 5) });
          if (text) curSrc.src = text;
          curSrc.srcFinal = true;
          segs.emit(curSrc);
          curSrc = null;
          break;
        case EV.TranslationStart: {
          // Match the translation to the sentence that started at the same audio time.
          const start = num(m, 5);
          curTr = [...segs.list].reverse().find((s) => !s.trFinal && (s.start ?? 0) <= start + 50)
            ?? segs.list.find((s) => !s.trFinal) ?? segs.create({ start });
          break;
        }
        case EV.TranslationResponse:
          curTr ??= segs.list.find((s) => !s.trFinal) ?? segs.create();
          curTr.tr = merge(curTr.tr, text);
          segs.emit(curTr);
          break;
        case EV.TranslationEnd:
          curTr ??= segs.list.find((s) => !s.trFinal) ?? segs.create();
          if (text) curTr.tr = text;
          curTr.trFinal = true;
          segs.emit(curTr);
          curTr = null;
          break;
        case EV.UsageResponse:
          send({ type: 'usage', stream, ...usageFrom(metaFields) });
          break;
        case EV.SessionFailed:
          // Timeouts / transient server errors: reconnect quietly (logged on the PC only).
          if (failures >= 2) {
            send({ type: 'error', stream, message: `Interpretation failed: ${num(metaFields, 3)} ${str(metaFields, 4)}` });
          } else {
            console.log(`  (${stream} session ended: ${num(metaFields, 3)} ${str(metaFields, 4)} - reconnecting)`);
          }
          failLogged = true;
          ws?.close();
          break;
        case EV.SessionFinished:
          ws?.close();
          break;
        default:
          if (num(metaFields, 3) && num(metaFields, 3) !== 20000000) {
            send({ type: 'error', stream, message: `Interpretation: ${num(metaFields, 3)} ${str(metaFields, 4)}` });
          }
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => send({ type: 'error', stream, message: `Interpretation rejected (HTTP ${res.statusCode}): ${body.slice(0, 300)}` }));
      if (res.statusCode === 401 || res.statusCode === 403) rejected = true;
    });
    // Network errors while reconnecting: log on the PC; the phone shows "Reconnecting…".
    ws.on('error', (err) => console.log(`  (${stream} Doubao connection: ${err.message})`));
    ws.on('pong', onPong);
    ws.on('close', () => {
      if (!ready) failures++;
      if (!ended && ready && !failLogged) console.log(`  (${stream} connection to Doubao dropped - reconnecting)`);
      failLogged = false;
      lastPongAt = 0;
      stallSince = 0;
      ws = null;
      ready = false;
      segs.finalizeAll();
      if (ended) {
        clearInterval(keepAlive);
        send({ type: 'status', stream, state: 'closed' });
      } else if (rejected) {
        clearInterval(keepAlive);
        send({ type: 'status', stream, state: 'closed' });
      } else {
        // Still listening: keep reconnecting by itself (quickly at first, then every 3 s)
        // until it works or Stop is pressed - never wait for the user to restart.
        send({ type: 'status', stream, state: 'reconnecting' });
        if (failures === 3) send({ type: 'error', stream, message: 'Translation service unreachable (PC internet?). Still retrying…' });
        setTimeout(() => { if (!ended && !ws) connect(); }, failures < 3 ? 500 * failures : 3000);
      }
    });
  }

  function sendAudio(pcm) {
    sendPb([[1, meta()], [2, EV.TaskRequest], [4, [[14, pcm]]]]);
  }

  // Flush the remaining queued audio at real-time pace, then tell Doubao we are done.
  function finish() {
    const flush = setInterval(() => {
      if (!ready) return clearInterval(flush);
      if (queue.length) return sendAudio(queue.shift());
      clearInterval(flush);
      sendPb([[1, meta()], [2, EV.FinishSession]]);
    }, 100);
  }

  connect();

  return {
    push(pcm) {
      if (ended) return;
      if (queue.length < 100) queue.push(pcm);
    },
    end() {
      if (ended) return;
      ended = true;
      clearInterval(keepAlive);
      if (ready) finish();
      setTimeout(() => ws?.close(), 10000);
    },
    close() {
      ended = true;
      clearInterval(keepAlive);
      ws?.close();
    },
  };
}

// ResponseMeta.Billing (field 5): Items (1: unit, quantity), DurationMsec (2)
function usageFrom(metaFields) {
  const billing = metaFields[5]?.[0] ? decode(metaFields[5][0]) : {};
  const items = (billing[1] || []).map((b) => {
    const item = decode(b);
    return { unit: str(item, 1), quantity: item[2]?.[0] ?? 0 };
  });
  return { items, durationMs: num(billing, 2) };
}
