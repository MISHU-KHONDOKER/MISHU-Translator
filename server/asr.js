// Route 2: Doubao streaming speech recognition (binary WebSocket protocol)
// + a text LLM (Doubao or DeepSeek) for translation.
// Docs: https://docs.volcengine.com/docs/6561/1354869
import WebSocket from 'ws';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { Segments } from './segments.js';
import { translate } from './llm.js';

const ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

// 4-byte header: version 1 / header size 1 | message type | flags | serialization | compression
const FULL_REQUEST = [0x11, 0x10, 0x11, 0x00]; // full client request, JSON, gzip
const AUDIO = [0x11, 0x20, 0x01, 0x00]; // audio only, raw, gzip
const AUDIO_LAST = [0x11, 0x22, 0x01, 0x00]; // audio only, last packet

function frame(header, payload) {
  const body = zlib.gzipSync(payload);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from(header), size, body]);
}

function parse(buf) {
  const headerSize = (buf[0] & 0x0f) * 4;
  const type = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let off = headerSize;
  if (type === 0x0f) {
    const code = buf.readUInt32BE(off);
    const len = buf.readUInt32BE(off + 4);
    return { error: `${code}: ${buf.subarray(off + 8, off + 8 + len).toString()}` };
  }
  if (flags & 0x01) off += 4; // sequence number
  const len = buf.readUInt32BE(off);
  let payload = buf.subarray(off + 4, off + 4 + len);
  if (compression === 1) payload = zlib.gunzipSync(payload);
  return { last: !!(flags & 0x02), json: JSON.parse(payload.toString() || '{}') };
}

function authHeaders() {
  const h = { 'X-Api-Resource-Id': process.env.ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration', 'X-Api-Connect-Id': randomUUID() };
  if (process.env.SPEECH_API_KEY) h['X-Api-Key'] = process.env.SPEECH_API_KEY;
  else {
    h['X-Api-App-Key'] = process.env.SPEECH_APP_ID;
    h['X-Api-Access-Key'] = process.env.SPEECH_ACCESS_TOKEN;
  }
  return h;
}

export function createAsrStream({ stream, from, to, llm, ctx, send }) {
  const segs = new Segments(stream, send);
  const model = llm === 'deepseek' ? process.env.ARK_DEEPSEEK_MODEL : process.env.ARK_DOUBAO_MODEL;
  let ws = null;
  let open = false;
  let ended = false;
  let queue = [];
  let cur = null;
  let lastConnect = 0;
  const done = new Set();

  function connect() {
    const missing = [];
    if (!process.env.SPEECH_API_KEY && !(process.env.SPEECH_APP_ID && process.env.SPEECH_ACCESS_TOKEN)) missing.push('SPEECH_API_KEY (or SPEECH_APP_ID + SPEECH_ACCESS_TOKEN)');
    if (!process.env.ARK_API_KEY) missing.push('ARK_API_KEY');
    if (!model) missing.push(llm === 'deepseek' ? 'ARK_DEEPSEEK_MODEL' : 'ARK_DOUBAO_MODEL');
    if (missing.length) {
      send({ type: 'error', stream, message: `Missing in .env: ${missing.join(', ')}` });
      ended = true;
      return;
    }
    lastConnect = Date.now();
    open = false;
    send({ type: 'status', stream, state: 'connecting' });
    ws = new WebSocket(ASR_URL, { headers: authHeaders(), handshakeTimeout: 6000 });

    ws.on('open', () => {
      ws.send(frame(FULL_REQUEST, JSON.stringify({
        user: { uid: 'mishu-translator' },
        audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          result_type: 'single',
          enable_nonstream: true, // second pass re-recognizes each finished sentence: better accuracy
          end_window_size: 600, // ms of silence that ends a sentence
        },
      })));
      open = true;
      send({ type: 'status', stream, state: 'live' });
      for (const chunk of queue) ws.send(frame(AUDIO, chunk));
      queue = [];
      if (ended) ws.send(frame(AUDIO_LAST, Buffer.alloc(0)));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = parse(raw); } catch (e) { return send({ type: 'error', stream, message: `ASR parse: ${e.message}` }); }
      if (msg.error) return send({ type: 'error', stream, message: `Speech recognition error ${msg.error}` });
      onResult(msg.json);
      if (msg.last) ws?.close();
    });

    ws.on('unexpected-response', (_req, res) => {
      send({ type: 'error', stream, message: `Speech recognition rejected (HTTP ${res.statusCode}) - check SPEECH keys / ASR_RESOURCE_ID` });
    });
    ws.on('error', (err) => send({ type: 'error', stream, message: `Speech recognition connection: ${err.message}` }));
    ws.on('close', () => {
      ws = null;
      open = false;
      if (cur && cur.src) finishSentence(cur.src);
      send({ type: 'status', stream, state: 'closed' });
    });
  }

  function onResult(json) {
    const utterances = json.result?.utterances || [];
    for (const u of utterances) {
      const text = (u.text || '').trim();
      if (!text) continue;
      if (u.definite) {
        const key = `${u.start_time}`;
        if (done.has(key)) continue;
        done.add(key);
        finishSentence(text);
      } else {
        cur ??= segs.create();
        cur.src = text;
        segs.emit(cur);
      }
    }
  }

  function finishSentence(text) {
    const seg = cur ?? segs.create();
    cur = null;
    seg.src = text;
    seg.srcFinal = true;
    segs.emit(seg);
    translate({
      text, from, to, topic: ctx.topic, history: ctx.history, model,
      onDelta: (t) => { seg.tr = t; segs.emit(seg); },
    }).then((tr) => {
      seg.tr = tr;
      ctx.history.push({ speaker: stream === 'talk' ? 'Me' : 'Them', src: text, tr });
      if (ctx.history.length > 20) ctx.history.shift();
    }).catch((err) => {
      send({ type: 'error', stream, message: err.message });
    }).finally(() => {
      seg.trFinal = true;
      segs.emit(seg);
    });
  }

  connect();

  return {
    push(pcm) {
      if (ended) return;
      if (!ws && Date.now() - lastConnect > 3000) connect();
      if (open) ws.send(frame(AUDIO, pcm));
      else if (queue.length < 100) queue.push(pcm);
    },
    end() {
      if (ended) return;
      ended = true;
      if (open) ws.send(frame(AUDIO_LAST, Buffer.alloc(0)));
      setTimeout(() => ws?.close(), 8000);
    },
    close() {
      ended = true;
      ws?.close();
    },
  };
}
