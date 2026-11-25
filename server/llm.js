// Translation with a text LLM on Volcengine Ark (Doubao or DeepSeek), streamed.
// Ark's chat API is OpenAI-compatible.
const ARK_CHAT_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const LANG = { zh: 'Simplified Chinese', en: 'English' };

function systemPrompt({ from, to, topic, history }) {
  const recent = history.slice(-8).map((h) => `${h.speaker}: ${h.src}  =>  ${h.tr}`).join('\n');
  return [
    `You are a professional live interpreter in a face-to-face conversation.`,
    `Translate the latest utterance from ${LANG[from]} into natural, spoken ${LANG[to]}.`,
    `The text comes from speech recognition of accented speech, so it may contain`,
    `misheard words or homophones. Use the conversation context to infer what was really meant.`,
    `Keep the speaker's tone (polite, casual, angry, joking). Keep names and numbers exact.`,
    `Output ONLY the translation - no notes, no quotes, no explanations.`,
    topic ? `Conversation topic: ${topic}` : '',
    recent ? `Recent conversation (for context only):\n${recent}` : '',
  ].filter(Boolean).join('\n');
}

export async function translate({ text, from, to, topic, history, model, onDelta }) {
  const body = {
    model,
    stream: true,
    temperature: 0.2,
    thinking: { type: 'disabled' }, // speed matters more than reasoning here
    messages: [
      { role: 'system', content: systemPrompt({ from, to, topic, history }) },
      { role: 'user', content: text },
    ],
  };

  let res = await post(body);
  if (res.status === 400) {
    // Some models do not accept the "thinking" switch - retry without it.
    delete body.thinking;
    res = await post(body);
  }
  if (!res.ok) throw new Error(`Translation failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);

  let out = '';
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) { out += delta; onDelta(out); }
      } catch { /* ignore keep-alive / partial lines */ }
    }
  }
  return out.trim();
}

function post(body) {
  return fetch(ARK_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ARK_API_KEY}` },
    body: JSON.stringify(body),
  });
}
