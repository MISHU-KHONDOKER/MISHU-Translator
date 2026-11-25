// A "segment" is one sentence of the conversation: source text + its translation.
// Every adapter (interpretation, ASR+LLM, demo) reports progress through this class so
// the phone receives one uniform message shape:
//   { type: 'seg', stream, id, src, tr, srcFinal, trFinal }

export class Segments {
  constructor(stream, send) {
    this.stream = stream;
    this.send = send;
    this.list = [];
    this.count = 0;
  }

  create(extra = {}) {
    const seg = { id: `${this.stream}-${Date.now()}-${++this.count}`, src: '', tr: '', srcFinal: false, trFinal: false, ...extra };
    this.list.push(seg);
    if (this.list.length > 30) this.list.shift();
    return seg;
  }

  emit(seg) {
    const { id, src, tr, srcFinal, trFinal } = seg;
    if (!src.trim() && !tr.trim()) return; // empty sentence (e.g. after a long silence)
    this.send({ type: 'seg', stream: this.stream, id, src, tr, srcFinal, trFinal });
  }

  finalizeAll() {
    for (const seg of this.list) {
      if (!seg.srcFinal || !seg.trFinal) {
        seg.srcFinal = seg.trFinal = true;
        this.emit(seg);
      }
    }
  }
}

// Joins streamed text pieces, adding a space between Latin words when the service
// sends English deltas without one.
export function joinText(a, b) {
  if (!a) return b;
  if (/[A-Za-z0-9,.!?;:'"]$/.test(a) && /^[A-Za-z0-9]/.test(b)) return `${a} ${b}`;
  return a + b;
}

export const SENTENCE_END = /[。！？!?.…]["'”’)]?\s*$/;
