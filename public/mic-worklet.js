// Runs on the audio thread: converts the microphone (usually 48 kHz float) to
// 16 kHz mono 16-bit PCM, and posts one 100 ms frame (1600 samples) at a time.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.sum = 0;
    this.cnt = 0;
    this.buf = new Int16Array(1600);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Averaging the input samples in each output slot doubles as a simple low-pass filter.
      this.sum += ch[i];
      this.cnt++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        let s = this.sum / this.cnt;
        this.sum = 0;
        this.cnt = 0;
        s = Math.max(-1, Math.min(1, s));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
