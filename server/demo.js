// Demo route: no API keys needed. Detects when you speak and pause, then shows a
// fixed sample sentence - used to test the phone, microphone, HTTPS and voice output.
import { Segments } from './segments.js';

const SAMPLES = {
  'zh-en': [['你好，很高兴认识你。', 'Hello, nice to meet you.'], ['这个多少钱？', 'How much is this?'], ['我们明天下午三点见面吧。', "Let's meet tomorrow at 3 p.m."]],
  'en-zh': [['Hello, nice to meet you.', '你好，很高兴认识你。'], ['Where is the train station?', '火车站在哪里？']],
};

export function createDemoStream({ stream, from, to, send }) {
  const segs = new Segments(stream, send);
  const samples = SAMPLES[`${from}-${to}`];
  let voiced = 0;
  let silent = 0;
  let n = 0;
  let ended = false;
  send({ type: 'status', stream, state: 'live' });

  function fire() {
    const [src, tr] = samples[n++ % samples.length];
    const seg = segs.create();
    seg.src = `(demo) ${src}`;
    seg.srcFinal = true;
    segs.emit(seg);
    let i = 0;
    const words = tr.split(' ');
    const timer = setInterval(() => {
      seg.tr = from === 'en' ? tr.slice(0, ++i * 2) : words.slice(0, ++i).join(' ');
      if (seg.tr.length >= tr.length) { seg.tr = tr; seg.trFinal = true; clearInterval(timer); }
      segs.emit(seg);
    }, 120);
  }

  return {
    push(pcm) {
      if (ended) return;
      let sum = 0;
      for (let i = 0; i < pcm.length - 1; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; }
      const rms = Math.sqrt(sum / (pcm.length / 2));
      if (rms > 700) { voiced++; silent = 0; } else silent++;
      if (voiced >= 4 && silent >= 7) { voiced = 0; fire(); }
    },
    end() {
      if (!ended && voiced >= 3) fire();
      ended = true;
      send({ type: 'status', stream, state: 'closed' });
    },
    close() { ended = true; },
  };
}
