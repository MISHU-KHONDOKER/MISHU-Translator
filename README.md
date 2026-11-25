# MISHU Translator

<p align="center">
  <img src="public/tutor-face.jpg" alt="MISHU tutor avatar" width="220"><br>
  <sub>The tutor avatar, generated with the Doubao Seedream AI image model.</sub>
</p>

A real-time **Chinese ⇄ English interpreter** and an **AI Chinese tutor** in one iPhone web app.
It's built for real conversations in China: point the phone at the person, and both sides get subtitles and a voice.

The iPhone runs a Progressive Web App (Safari → Add to Home Screen). A small Node.js server runs on a cloud
VPS (or a home PC), keeps all API keys private, and streams audio to Volcengine / Doubao AI models over WebSockets.

## Features

### 🗣️ Live translator
- **Listen mode:** the other person speaks Chinese, and you get live English subtitles plus voice.
- **Hold to speak:** your English is shown large in Chinese and spoken aloud for them.
- **Two-way auto mode:** one hands-free session detects the language of every sentence and translates it the other way.
- **Several engines:** Doubao simultaneous interpretation, or streaming speech-to-text + Doubao / DeepSeek LLM translation, plus a key-free demo mode.
- Output modes for earphones, loudspeaker (the mic pauses while the phone talks, so it doesn't hear itself) or text only.
- Topic hints and custom names/terms to improve accuracy.

### 📚 AI Chinese tutor (New HSK 3.0, levels 1–9, ~11,000 words)
- **Word lessons:** an LLM writes 10 example sentences per word (medium → hardest) with situation, feeling and usage tips. Each lesson is generated once and cached for every user.
- **Tutor-led practice** in a "video call" layout. The tutor speaks, then you repeat, and pronunciation is scored live. A score of 80+ moves you on.
- **Spaced-repetition review quizzes** and "your turn" tasks graded by AI.
- **Story mode:** listening stories that grow from 45 s to 6 min as you improve, with HSK-style questions, then repeat and retell.
- Natural Chinese voice (Doubao TTS 2.0) with an audio cache, and a per-user cost counter.

## Tech stack

| Layer | What |
|---|---|
| Client | Vanilla JS PWA, Web Audio API + `AudioWorklet` for 16 kHz mic streaming, Web Speech fallback |
| Server | Node.js 22 (ES modules), only one dependency (`ws`), HTTPS + WebSocket |
| AI | Volcengine Ark: Doubao simultaneous interpretation, Doubao streaming ASR, Doubao-Seed & DeepSeek LLMs, Doubao TTS 2.0, Seedream (avatar) |
| Protocols | Custom binary framing for the Doubao speech APIs (`server/pb.js`, `server/asr.js`, `server/si.js`) |
| Security | Own local CA + HTTPS certificates (needed for iPhone mic access), access keys per user, keys only on the server |
| Hosting | Ubuntu 24.04 VPS (systemd service) |

```
iPhone (PWA)  ──HTTPS / WebSocket (mic audio, results)──▶  Node server  ──▶  Volcengine / Doubao APIs
                                                           (keys in .env)      ASR · interpretation · LLM · TTS
```

## Project layout

```
server/   index.js (HTTPS + WS), si.js / asr.js / pb.js (speech protocols), llm.js, tutor.js, hsk3.json
public/   index.html, app.js (translator), tutor.js (tutor), style.css, mic-worklet.js, manifest
scripts/  make-cert.js (local CA + server certificate)
data/     cached lessons and TTS audio
design/   HTML design mockups
```

## Run it

```bash
cp .env.example .env   # add your Volcengine keys
npm install
npm run cert           # creates a local CA + HTTPS certificate for this machine's IP
npm start
```

On the iPhone, open `http://<server-ip>:8080/` in Safari once and install/trust the certificate.
Then open `https://<server-ip>:8443/` → Share → **Add to Home Screen**.
Without keys, choose the **Demo** engine to try the interface.

## Built with AI

This project was designed and built with the help of LLMs; Doubao powers the lessons,
voice and the avatar image.

## Credits

HSK 3.0 word list: [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) by drkameleon (MIT).

## License

[MIT](LICENSE) © 2026 MISHU-KHONDOKER
