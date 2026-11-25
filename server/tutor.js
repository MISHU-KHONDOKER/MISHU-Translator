// MISHU Tutor: vocabulary lessons, quiz grading and per-user progress.
// - Word lists: server/hsk3.json = New HSK (3.0, 2021 standard) levels 1-6 + "7" (= band 7-9),
//   each word [simplified, pinyin, short meaning], most frequent first.
//   Source: complete-hsk-vocabulary by drkameleon (MIT licence).
// - Lessons are written once per word by the Doubao chat model and cached in data/lessons/,
//   so every learner gets the same checked lesson instantly afterwards.
// - Progress is stored per access key in data/users/ (the key itself is never written to disk).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ARK_CHAT_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const LESSONS = path.join(DATA, 'lessons');
const USERS = path.join(DATA, 'users');
const USAGE = path.join(DATA, 'usage');
const AVATARS = path.join(DATA, 'avatars');
fs.mkdirSync(AVATARS, { recursive: true });
fs.mkdirSync(LESSONS, { recursive: true });
fs.mkdirSync(USERS, { recursive: true });
fs.mkdirSync(USAGE, { recursive: true });

// List prices in yuan per token (Volcengine console, noted 2026-11-11). Free trial tokens are
// counted at the same price, so the counter shows what the use is worth even while it is free.
const PRICES = {
  chatIn: 0.0008 / 1000, // Doubao-Seed-2.1-lite input
  chatOut: 0.0027 / 1000, // Doubao-Seed-2.1-lite output
  input_audio_tokens: 0.00008, // Doubao interpretation (voice check)
  output_text_tokens: 0.00008,
  output_audio_tokens: 0.0003,
};

const HSK = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'hsk3.json'), 'utf8'));
const LEVEL_NAMES = { 1: 'HSK 1', 2: 'HSK 2', 3: 'HSK 3', 4: 'HSK 4', 5: 'HSK 5', 6: 'HSK 6', 7: 'HSK 7-9' };
const model = () => process.env.ARK_TUTOR_MODEL || process.env.ARK_DOUBAO_MODEL;

export const tutorReady = () => !!(process.env.ARK_API_KEY && model());

// ---------------------------------------------------------------- lessons

const LESSON_PROMPT = (word, pinyin, level) => `You are a top professional Mandarin teacher from Beijing who trains foreigners to SPEAK like natives.
Your student is an adult foreigner living and working in mainland China, learning New HSK ${LEVEL_NAMES[level]}.
Write a speaking lesson for the word 「${word}」 (${pinyin}).

Goal: the student learns to use this word the way a native speaker really does - in real situations,
with the right person, the right feeling and the right hidden meaning (pragmatics), by repeating your sentences aloud.

Return ONLY one JSON object, no markdown, exactly this shape:
{
  "word": "${word}",
  "pinyin": "pinyin with tone marks",
  "meaning": "short natural English meaning (max 8 words)",
  "pos": "part of speech in English, e.g. verb / noun / adverb / measure word",
  "core": "1-2 sentences in English: the key idea of how natives use it, what learners usually get wrong",
  "collocations": [ { "zh": "common chunk with the word", "pinyin": "...", "en": "..." } ],
  "sentences": [
    {
      "difficulty": "medium | hard | hardest",
      "situation": "short label, e.g. 'At work · to your boss' or 'With a friend · joking'",
      "zh": "the sentence a native would really say",
      "pinyin": "pinyin with tone marks, words separated by spaces",
      "en": "natural English translation",
      "register": "casual | neutral | polite | formal",
      "feeling": "1-3 words: e.g. warm, annoyed, humble, teasing, firm",
      "why": "1-2 sentences in English: who says this to whom, when, and what it really means / implies",
      "tip": "optional short native tip (intonation, a softer/stronger version, what NOT to say) or empty string"
    }
  ],
  "quiz": [
    {
      "difficulty": "medium | hard | hardest",
      "prompt": "the task for the student (see rules)",
      "answer": "one natural model answer in Chinese that uses ${word}",
      "accept": ["2-3 other natural correct answers in Chinese"],
      "explain": "1 sentence in English: why this is the natural way"
    }
  ]
}

Rules:
- Exactly 10 sentences, each from a DIFFERENT perspective: mix work (boss, colleague, client), friends, family,
  shop/restaurant/taxi, phone or WeChat message, polite request, refusing, complaining, joking, comforting,
  formal/written. Cover the word's main different meanings and grammar patterns.
- Sentences must sound like real spoken Mandarin in mainland China today (no textbook stiffness, no rare idioms
  unless very common). Mostly use words at ${LEVEL_NAMES[level]} or below; at most 2 harder words per sentence.
  Simplified characters only.
- NO easy sentences. Difficulty climbs step by step: sentences 1-4 "medium" (natural real-life sentences,
  8-14 characters, never textbook-simple like 'this is my book'), 5-8 "hard" (longer, richer grammar, clear
  feeling/attitude, 12-20 characters), 9-10 "hardest" (fast natural native speech: spoken patterns, softeners,
  common colloquial phrases, the way people really talk at work or with friends, up to 24 characters).
- 3 to 5 collocations.
- Exactly 6 quiz items, in this order: 2 "medium", 2 "hard", 2 "hardest". The student must PRODUCE Chinese
  (speak or type) - never multiple choice.
  medium: a short real situation in English, student says the natural sentence using ${word}.
  hard: a situation with a specific person and feeling (e.g. politely refuse your boss), or make a softer/stronger
        version; prompt in English but with no hints in Chinese.
  hardest: prompt written in simple Chinese (a question someone asks the student, or a situation), student must
           answer naturally in Chinese using ${word}.
- Every pinyin must match its Chinese exactly. Double-check tones.
- Valid JSON only: never put a double quote character (") inside any text value. To quote words use 「」 in Chinese
  or single quotes in English.`;

// v2: sentences have difficulty labels (medium -> hard -> hardest). Older lessons are rewritten when opened.
const LESSON_VERSION = 2;
const building = new Map();
const lessonReady = (word) => {
  try { return JSON.parse(fs.readFileSync(lessonFile(word), 'utf8')).v >= LESSON_VERSION; } catch { return false; }
};

function lessonFile(word) {
  const safe = [...word].map((c) => c.codePointAt(0).toString(16)).join('-');
  return path.join(LESSONS, `${safe}.json`);
}

export function findWord(word) {
  for (const [level, list] of Object.entries(HSK)) {
    const w = list.find((x) => x[0] === word);
    if (w) return { level: Number(level), word: w[0], pinyin: w[1], gloss: w[2] };
  }
  return null;
}

export async function getLesson(word, key = '') {
  const file = lessonFile(word);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.v >= LESSON_VERSION) return cached;
  }
  if (building.has(word)) return building.get(word);
  const info = findWord(word);
  if (!info) throw new Error(`Not an HSK word: ${word}`);
  const job = (async () => {
    const started = Date.now();
    let lesson;
    for (let attempt = 1; ; attempt++) {
      try {
        const { json, usage } = await chatJson(LESSON_PROMPT(info.word, info.pinyin, info.level), 0.7);
        addChatUsage(key, 'lessons', usage);
        lesson = validateLesson(json, info);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`  tutor: lesson ${word} attempt ${attempt} failed (${err.message}) - retrying`);
      }
    }
    lesson.level = info.level;
    lesson.v = LESSON_VERSION;
    fs.mkdirSync(LESSONS, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(lesson, null, 1));
    console.log(`  tutor: lesson ready ${word} (${Math.round((Date.now() - started) / 1000)} s)`);
    return lesson;
  })().finally(() => building.delete(word));
  building.set(word, job);
  return job;
}

function validateLesson(l, info) {
  if (!l || !Array.isArray(l.sentences) || l.sentences.length < 8) throw new Error('lesson has too few sentences');
  if (!Array.isArray(l.quiz) || l.quiz.length < 4) throw new Error('lesson has too few quiz items');
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    word: info.word,
    pinyin: s(l.pinyin) || info.pinyin,
    meaning: s(l.meaning) || info.gloss,
    pos: s(l.pos),
    core: s(l.core),
    collocations: (l.collocations || []).filter((c) => c && s(c.zh)).slice(0, 5).map((c) => ({ zh: s(c.zh), pinyin: s(c.pinyin), en: s(c.en) })),
    sentences: l.sentences.filter((x) => x && s(x.zh)).slice(0, 10).map((x, i) => ({
      difficulty: ['medium', 'hard', 'hardest'].includes(s(x.difficulty)) ? s(x.difficulty) : i < 4 ? 'medium' : i < 8 ? 'hard' : 'hardest',
      situation: s(x.situation), zh: s(x.zh), pinyin: s(x.pinyin), en: s(x.en),
      register: s(x.register), feeling: s(x.feeling), why: s(x.why), tip: s(x.tip),
    })),
    quiz: l.quiz.filter((q) => q && s(q.prompt) && s(q.answer)).slice(0, 6).map((q) => ({
      difficulty: ['medium', 'hard', 'hardest'].includes(s(q.difficulty)) ? s(q.difficulty) : 'hard',
      prompt: s(q.prompt), answer: s(q.answer),
      accept: Array.isArray(q.accept) ? q.accept.map(s).filter(Boolean).slice(0, 4) : [],
      explain: s(q.explain),
    })),
  };
}

// Write lessons in the background (max 3 at a time) so the next words open instantly.
const queue = [];
let running = 0;
export function prefetch(words, key = '') {
  for (const w of words) if (!queue.some((q) => q.w === w) && !lessonReady(w) && findWord(w)) queue.push({ w, key });
  pump();
}
function pump() {
  while (running < 3 && queue.length) {
    const { w, key } = queue.shift();
    running++;
    getLesson(w, key).catch((err) => console.log(`  tutor: prefetch ${w} failed: ${err.message}`)).finally(() => { running--; pump(); });
  }
}

// ---------------------------------------------------------------- grading

export async function grade({ word, prompt, answer, accept, said }, key = '') {
  const sys = `You are a warm but demanding native Mandarin speaking coach. A foreign learner answered a speaking task.
Their answer may come from speech recognition, so ignore punctuation and obvious homophone recognition errors.
Judge whether a native speaker would find it natural and correct for the situation, and whether it uses 「${word}」 correctly.
Return ONLY JSON:
{"score": 0-100, "verdict": "great | good | almost | wrong",
 "feedback": "1-2 short sentences in English: what was good, what was wrong (grammar, word choice, politeness, naturalness)",
 "native": "the most natural way a native would say it in this situation, in Chinese (keep the learner's idea if it was valid)",
 "native_pinyin": "pinyin with tone marks for 'native'"}
Scoring: 90+ natural and correct; 70-89 correct but a bit unnatural; 40-69 understandable with errors; <40 wrong or does not use the word.`;
  const user = `Task: ${prompt}\nModel answer: ${answer}\nOther good answers: ${(accept || []).join(' / ')}\nLearner said: ${said}`;
  const { json: r, usage } = await chatJson(sys, 0.2, user);
  addChatUsage(key, 'grading', usage);
  return {
    score: Math.max(0, Math.min(100, Number(r.score) || 0)),
    verdict: ['great', 'good', 'almost', 'wrong'].includes(r.verdict) ? r.verdict : 'almost',
    feedback: String(r.feedback || ''), native: String(r.native || answer), native_pinyin: String(r.native_pinyin || ''),
  };
}

// ---------------------------------------------------------------- stories (listening + speaking)

// Story levels: the story grows with the learner's results (decided on the phone after each story).
export const STORY_TIERS = {
  1: { min: 120, max: 180, sentences: '8-10', time: 'about 45 seconds', questions: 3, newWords: 2 },
  2: { min: 220, max: 300, sentences: '13-16', time: 'about 1 minute', questions: 3, newWords: 2 },
  3: { min: 350, max: 450, sentences: '20-25', time: 'about 1.5-2 minutes', questions: 4, newWords: 3 },
  4: { min: 500, max: 650, sentences: '28-35', time: 'about 2.5 minutes', questions: 4, newWords: 4 },
  5: { min: 750, max: 950, sentences: '40-50', time: 'about 3.5-4 minutes', questions: 5, newWords: 5 },
  6: { min: 1100, max: 1400, sentences: '58-72', time: 'about 5-6 minutes', questions: 5, newWords: 6 },
};

const STORIES = path.join(DATA, 'stories');
const storyDir = (key) => path.join(STORIES, hashKey(key));

const STORY_PROMPT = (level, tier, words, all) => {
  const t = STORY_TIERS[tier];
  return `You are a top Mandarin teacher and a gifted storyteller from Beijing. Write a listening story for an adult
foreigner who lives and works in mainland China, learning New HSK ${LEVEL_NAMES[level]}. The story will be read aloud
by the tutor first (the learner only listens), then studied sentence by sentence and repeated aloud.

Story length: ${t.min}-${t.max} Chinese characters in total, in ${t.sentences} sentences (${t.time} when read aloud).
This length is important: do not write a shorter story. Develop the plot with details, dialogue and an ending.
${all ? `Use ALL of these words (a chapter the learner is studying), each at least once, naturally: ${words.join('、')}`
  : `Use these words the learner is studying, naturally (as many as fit, at least half of them): ${words.join('、')}`}
Mostly use vocabulary at ${LEVEL_NAMES[level]} or below; you may use at most ${t.newWords} new words above that level.

Make it a real story worth listening to, like the short stories in the HSK listening exam: modern life in China
(work, colleagues, WeChat, delivery, high-speed rail, neighbours, family), a funny misunderstanding, a small
surprise, or a story with a lesson (道理). Natural spoken narration, with some dialogue lines. A clear ending.
Split it into sentences of 8-30 characters (one sentence per entry).

Return ONLY one JSON object, no markdown:
{
  "title": "Chinese title",
  "title_en": "English title",
  "sentences": [ { "zh": "...", "pinyin": "pinyin with tone marks, words separated by spaces", "en": "natural English" } ],
  "new_words": [ { "word": "...", "pinyin": "...", "meaning": "short English" } ],
  "questions": [
    { "q": "question in simple Chinese, like the HSK listening exam", "q_en": "English",
      "options": ["A in Chinese", "B", "C", "D"], "correct": 0, "explain": "1 sentence in English" }
  ],
  "lesson": "1 sentence in English: the point or lesson of the story",
  "retell_hint": "1 sentence in English: what a good retelling should include"
}
Rules: exactly ${t.questions} questions: details first, then why/how, and the last one about the main idea or lesson.
Options must be short, plausible, and only one correct. Vary the position of the correct answer.
"new_words" lists only the words above ${LEVEL_NAMES[level]} that you used. Every pinyin must match its Chinese.
Valid JSON only: never put a double quote character (") inside any text value; use 「」 in Chinese for quotes.`;
};

function validateStory(st) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const sentences = (st?.sentences || []).filter((x) => x && str(x.zh)).map((x) => ({ zh: str(x.zh), pinyin: str(x.pinyin), en: str(x.en) }));
  if (sentences.length < 3) throw new Error('story too short');
  const questions = (st.questions || []).filter((q) => q && str(q.q) && Array.isArray(q.options) && q.options.length >= 3)
    .map((q) => ({ q: str(q.q), q_en: str(q.q_en), options: q.options.map((o) => str(o).replace(/^[A-Da-d]\s*[.、:：)）]?\s+|^[A-Da-d][.、:：)）]\s*/, '')).slice(0, 4), correct: Math.max(0, Math.min(3, Number(q.correct) || 0)), explain: str(q.explain) }));
  if (!questions.length) throw new Error('story has no questions');
  return {
    title: str(st.title) || '故事', title_en: str(st.title_en), sentences, questions,
    new_words: (st.new_words || []).filter((w) => w && str(w.word)).map((w) => ({ word: str(w.word), pinyin: str(w.pinyin), meaning: str(w.meaning) })).slice(0, 8),
    lesson: str(st.lesson), retell_hint: str(st.retell_hint),
  };
}

async function writeStory({ level, tier, words, all, chapter }, key) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const { json, usage } = await chatJson(STORY_PROMPT(level, tier, words, all), 0.8, 'Write the story now.', 12000);
      addChatUsage(key, 'stories', usage);
      const story = validateStory(json);
      // Models tend to write too little: reject clearly short stories (the last attempt is accepted).
      const total = story.sentences.reduce((n, x) => n + x.zh.length, 0);
      if (total < STORY_TIERS[tier].min * 0.8 && attempt < 3) throw new Error(`story too short (${total} characters)`);
      Object.assign(story, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, level, tier, words, chapter, created: new Date().toISOString(), v: 1 });
      if (all) story.missing = words.filter((w) => !story.sentences.some((x) => x.zh.includes(w)));
      if (all && story.missing.length > 2 && attempt < 3) throw new Error(`story missed chapter words: ${story.missing.join(" ")}`);
      const chars = story.sentences.reduce((n, x) => n + x.zh.length, 0);
      console.log(`  tutor: story ready (level ${tier}, ${chars} characters, ${Math.round((Date.now() - started) / 1000)} s)`);
      return story;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`  tutor: story attempt ${attempt} failed (${err.message}) - retrying`);
    }
  }
}

function saveStory(key, story) {
  fs.mkdirSync(storyDir(key), { recursive: true });
  fs.writeFileSync(path.join(storyDir(key), `${story.id}.json`), JSON.stringify(story));
}

// The next story is written in the background as soon as the learner finishes one, so it opens instantly.
const preparing = new Map();
const nextFile = (key) => path.join(storyDir(key), 'next.json');

export function prepareStory(req, key) {
  const k = hashKey(key);
  if (preparing.has(k)) return;
  const job = writeStory(req, key).then((story) => {
    fs.mkdirSync(storyDir(key), { recursive: true });
    fs.writeFileSync(nextFile(key), JSON.stringify(story));
  }).catch((err) => console.log(`  tutor: preparing story failed: ${err.message}`)).finally(() => preparing.delete(k));
  preparing.set(k, job);
}

export async function newStory(req, key) {
  const k = hashKey(key);
  if (preparing.has(k)) await preparing.get(k);
  try {
    const next = JSON.parse(fs.readFileSync(nextFile(key), 'utf8'));
    if (next.level === req.level && next.tier === req.tier && !req.chapter && !next.chapter) {
      fs.rmSync(nextFile(key), { force: true });
      saveStory(key, next);
      return next;
    }
  } catch { /* nothing prepared */ }
  const story = await writeStory(req, key);
  saveStory(key, story);
  return story;
}

export function loadStory(key, id) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error('bad story id');
  return JSON.parse(fs.readFileSync(path.join(storyDir(key), `${id}.json`), 'utf8'));
}

export async function gradeRetell({ story, said }, key) {
  const text = story.sentences.map((x) => x.zh).join('');
  const sys = `You are a warm but demanding native Mandarin speaking coach. A foreign learner (New HSK ${LEVEL_NAMES[story.level] || ''})
listened to a story and retold it in Chinese. Their retelling may come from speech recognition: ignore punctuation and obvious
homophone recognition errors. Judge content (main events, order, ending/lesson) and language (grammar, word choice, natural Chinese).
Return ONLY JSON:
{"score": 0-100, "content": "1 sentence in English: what they covered and what was missing",
 "language": "1-2 sentences in English: the most important grammar / word choice corrections",
 "native": "their retelling rewritten as a native speaker would say it (keep their content, same length or a bit longer), Chinese",
 "native_pinyin": "pinyin with tone marks for native"}
Scoring: 90+ complete and natural; 70-89 main events with small errors; 40-69 partial or many errors; under 40 very little.
Valid JSON only: no double quote characters inside text values.`;
  const user = [`Story: ${text}`, `A good retelling includes: ${story.retell_hint}`, `Learner's retelling: ${said}`].join('\n\n');
  const { json: r, usage } = await chatJson(sys, 0.2, user);
  addChatUsage(key, 'grading', usage);
  return {
    score: Math.max(0, Math.min(100, Number(r.score) || 0)),
    content: String(r.content || ''), language: String(r.language || ''),
    native: String(r.native || ''), native_pinyin: String(r.native_pinyin || ''),
  };
}

function storyRequest(b) {
  const level = HSK[b.level] ? Number(b.level) : 3;
  const tier = STORY_TIERS[b.tier] ? Number(b.tier) : 1;
  const words = (Array.isArray(b.words) ? b.words : []).map(String).filter((w) => w.length <= 8).slice(0, 25);
  // A chapter story: all 10 words of one chapter of one level.
  const chapter = Number(b.chapter) > 0 ? Math.floor(Number(b.chapter)) : 0;
  if (chapter) {
    const chWords = HSK[level].slice((chapter - 1) * 10, chapter * 10).map((w) => w[0]);
    if (chWords.length) return { level, tier, words: chWords, all: true, chapter };
  }
  return { level, tier, words: words.length ? words : HSK[level].slice(0, 15).map((w) => w[0]) };
}

// ---------------------------------------------------------------- tutor voice (Doubao speech synthesis 2.0)

// The tutor's native male voice. Each sentence is synthesised once and saved, so lessons shared by
// all learners are paid for only once. Price: ¥3 per 10,000 characters (post-paid, 2026-11).
const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const TTS_PRICE_PER_CHAR = 3 / 10000;
const TTS_DIR = path.join(DATA, 'tts');
const ttsVoice = () => process.env.TTS_VOICE || 'zh_male_yuanboxiaoshu_uranus_bigtts';
const ttsBuilding = new Map();

export async function tutorVoice(text, rate, key) {
  const id = createHash('sha1').update(`${ttsVoice()}|${rate}|${text}`).digest('hex');
  const file = path.join(TTS_DIR, id.slice(0, 2), `${id}.mp3`);
  if (fs.existsSync(file)) return file;
  if (ttsBuilding.has(id)) return ttsBuilding.get(id);
  const job = (async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Api-Resource-Id': 'seed-tts-2.0', 'X-Api-Request-Id': id };
    if (process.env.SPEECH_API_KEY) headers['X-Api-Key'] = process.env.SPEECH_API_KEY;
    else { headers['X-Api-App-Id'] = process.env.SPEECH_APP_ID; headers['X-Api-Access-Key'] = process.env.SPEECH_ACCESS_TOKEN; }
    const res = await fetch(TTS_URL, {
      method: 'POST', headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ user: { uid: 'mishu-tutor' }, req_params: { text, speaker: ttsVoice(), audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: rate } } }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`voice service HTTP ${res.status}: ${body.slice(0, 200)}`);
    const chunks = [];
    let last = '';
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
        if (j.code && j.code !== 20000000 && j.code !== 0) last = `${j.code} ${j.message || ''}`;
      } catch { /* partial line */ }
    }
    if (!chunks.length) throw new Error(`voice service returned no audio ${last}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(chunks));
    const chars = [...text].length;
    addUsage(key, 'voiceout', chars * TTS_PRICE_PER_CHAR, chars);
    return file;
  })().finally(() => ttsBuilding.delete(id));
  ttsBuilding.set(id, job);
  return job;
}

// ---------------------------------------------------------------- Ark chat (JSON answers)

async function chatJson(system, temperature, user = 'Write it now.', maxTokens = 8000) {
  const body = {
    model: model(),
    temperature,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  let res = await post(body);
  if (res.status === 400) {
    // Some models reject "thinking" or "response_format" - retry with a plain request.
    delete body.thinking;
    delete body.response_format;
    res = await post(body);
  }
  if (!res.ok) throw new Error(`Tutor model failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('tutor model returned no JSON');
  return { json: JSON.parse(text.slice(start, end + 1)), usage: data.usage || {} };
}

// One automatic retry when the network drops the request (e.g. a short internet hiccup).
async function post(body) {
  try { return await postOnce(body); } catch {
    await new Promise((r) => setTimeout(r, 800));
    return postOnce(body);
  }
}

function postOnce(body) {
  return fetch(ARK_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ARK_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
}

// ---------------------------------------------------------------- per-user progress

const userFile = (key) => path.join(USERS, `${hashKey(key)}.json`);

export function loadUser(key) {
  try { return JSON.parse(fs.readFileSync(userFile(key), 'utf8')); } catch { return null; }
}

export function saveUser(key, state) {
  const text = JSON.stringify(state);
  if (text.length > 2_000_000) throw new Error('progress too large');
  fs.mkdirSync(USERS, { recursive: true });
  fs.writeFileSync(userFile(key), text);
}

// ---------------------------------------------------------------- cost counter (exact tokens reported by Doubao)

const hashKey = (key) => createHash('sha256').update(`mishu:${key || 'local'}`).digest('hex').slice(0, 20);
const usageFile = (key) => path.join(USAGE, `${hashKey(key)}.json`);
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function addUsage(key, kind, yuan, tokens) {
  let u;
  try { u = JSON.parse(fs.readFileSync(usageFile(key), 'utf8')); } catch { u = { days: {} }; }
  const day = (u.days[localDay()] ??= {});
  const k = (day[kind] ??= { yuan: 0, tokens: 0, count: 0 });
  k.yuan += yuan;
  k.tokens += tokens;
  k.count++;
  const keys = Object.keys(u.days).sort();
  while (keys.length > 400) delete u.days[keys.shift()];
  try {
    fs.mkdirSync(USAGE, { recursive: true });
    fs.writeFileSync(usageFile(key), JSON.stringify(u));
  } catch { /* disk full */ }
}

function addChatUsage(key, kind, usage) {
  const inT = usage.prompt_tokens || 0;
  const outT = usage.completion_tokens || 0;
  addUsage(key, kind, inT * PRICES.chatIn + outT * PRICES.chatOut, inT + outT);
}

// Voice checks: the interpretation service reports billed items after each tutor recording.
export function addVoiceUsage(key, items) {
  let yuan = 0;
  let tokens = 0;
  for (const it of items || []) {
    yuan += (it.quantity || 0) * (PRICES[it.unit] || 0);
    tokens += it.quantity || 0;
  }
  if (tokens) addUsage(key, 'voice', yuan, tokens);
}

function usageSummary(key) {
  let u;
  try { u = JSON.parse(fs.readFileSync(usageFile(key), 'utf8')); } catch { u = { days: {} }; }
  const today = localDay();
  const month = today.slice(0, 7);
  const sum = (filter) => {
    const t = { voice: 0, voiceout: 0, grading: 0, lessons: 0, stories: 0, total: 0 };
    for (const [d, day] of Object.entries(u.days)) {
      if (!filter(d)) continue;
      for (const [kind, v] of Object.entries(day)) { t[kind] = (t[kind] || 0) + v.yuan; t.total += v.yuan; }
    }
    return t;
  };
  const recent = Object.keys(u.days).sort().slice(-7).reverse().map((d) => ({ day: d, ...u.days[d] }));
  return { today: sum((d) => d === today), month: sum((d) => d.startsWith(month)), all: sum(() => true), recent };
}

// ---------------------------------------------------------------- HTTP API

export async function handleTutorApi(req, res, url, keyOk, sendJson) {
  const key = url.searchParams.get('key') || '';
  if (!keyOk(key)) return sendJson(res, { error: 'access key needed' }, 401);
  const route = url.pathname.slice('/api/tutor/'.length);
  try {
    if (route === 'levels') {
      return sendJson(res, Object.fromEntries(Object.entries(HSK).map(([l, list]) => [l, { name: LEVEL_NAMES[l], count: list.length }])));
    }
    if (route === 'words') {
      const level = url.searchParams.get('level');
      if (!HSK[level]) return sendJson(res, { error: 'unknown level' }, 404);
      const ready = HSK[level].map((w) => (fs.existsSync(lessonFile(w[0])) ? 1 : 0));
      return sendJson(res, { level: Number(level), name: LEVEL_NAMES[level], words: HSK[level], ready });
    }
    if (route === 'lesson') {
      if (!tutorReady()) return sendJson(res, { error: 'Tutor model not set up on the server (ARK_API_KEY / ARK_DOUBAO_MODEL)' }, 503);
      const word = url.searchParams.get('word') || '';
      return sendJson(res, await getLesson(word, key));
    }
    if (route === 'prefetch' && req.method === 'POST') {
      const { words } = await readBody(req);
      if (tutorReady() && Array.isArray(words)) prefetch(words.slice(0, 20).map(String), key);
      return sendJson(res, { ok: true });
    }
    if (route === 'grade' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.said || !b.prompt) return sendJson(res, { error: 'nothing to grade' }, 400);
      const r = await grade({ word: String(b.word || '').slice(0, 20), prompt: String(b.prompt).slice(0, 500), answer: String(b.answer || '').slice(0, 200), accept: b.accept, said: String(b.said).slice(0, 300) }, key);
      console.log(`  tutor: graded ${b.word} "${String(b.said).slice(0, 40)}" → ${r.score}`);
      return sendJson(res, r);
    }
    if (route === 'usage') return sendJson(res, usageSummary(key));
    if (route === 'tts') {
      const text = (url.searchParams.get('text') || '').trim().slice(0, 300);
      if (!text) return sendJson(res, { error: 'no text' }, 400);
      const rate = Math.max(-50, Math.min(50, Math.round(Number(url.searchParams.get('rate')) || 0)));
      const file = await tutorVoice(text, rate, key);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=31536000' });
      return fs.createReadStream(file).pipe(res);
    }
    if (route === 'story-new' && req.method === 'POST') {
      if (!tutorReady()) return sendJson(res, { error: 'Tutor model not set up on the server' }, 503);
      return sendJson(res, await newStory(storyRequest(await readBody(req)), key));
    }
    if (route === 'story-prepare' && req.method === 'POST') {
      if (tutorReady()) prepareStory(storyRequest(await readBody(req)), key);
      return sendJson(res, { ok: true });
    }
    if (route === 'story') return sendJson(res, loadStory(key, url.searchParams.get('id') || ''));
    if (route === 'story-retell' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.said) return sendJson(res, { error: 'nothing to check' }, 400);
      const r = await gradeRetell({ story: loadStory(key, String(b.id || '')), said: String(b.said).slice(0, 3000) }, key);
      console.log(`  tutor: retell graded → ${r.score}`);
      return sendJson(res, r);
    }
    if (route === 'avatar') {
      // The learner's own photo, shown as the tutor's face (square JPEG made on the phone).
      const file = path.join(AVATARS, `${hashKey(key)}.jpg`);
      if (req.method === 'POST') {
        const { image, remove } = await readBody(req);
        if (remove) { fs.rmSync(file, { force: true }); return sendJson(res, { ok: true }); }
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
        const buf = m && Buffer.from(m[1], 'base64');
        if (!buf || buf.length > 600_000 || buf[0] !== 0xff || buf[1] !== 0xd8) return sendJson(res, { error: 'not a valid photo' }, 400);
        fs.mkdirSync(AVATARS, { recursive: true });
        fs.writeFileSync(file, buf);
        console.log(`  tutor: new tutor photo (${Math.round(buf.length / 1024)} KB)`);
        return sendJson(res, { ok: true });
      }
      if (!fs.existsSync(file)) return sendJson(res, { error: 'no photo' }, 404);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000' });
      return fs.createReadStream(file).pipe(res);
    }
    if (route === 'state') {
      if (req.method === 'POST') { saveUser(key, await readBody(req)); return sendJson(res, { ok: true }); }
      return sendJson(res, { state: loadUser(key) });
    }
    return sendJson(res, { error: 'not found' }, 404);
  } catch (err) {
    console.log(`  ! tutor ${route}: ${err.message}`);
    return sendJson(res, { error: err.message }, 500);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
