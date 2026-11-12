const express = require('express');
const app = express();
app.use(express.json({ limit: '50kb' }));

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.MODEL || 'gemini-3.8-flash';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const limited = (req) => {
  const ip = req.ip || 'x';
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > 20;
};

const MODES = {
  Explain: 'Explain clearly with a simple analogy, then ask one quick check question.',
  Quiz: 'Act as a quiz master: ask ONE question at a time, wait for the answer, grade it, explain, then continue.',
  Solve: 'Solve step by step with numbered steps and a clear final answer.',
  Summarize: 'Summarise as short bullet points plus key terms.',
  Plan: 'Create a practical day-by-day study plan; first ask for goal, exam date and daily time if missing.'
};
const LEN = { Short: 'keep it under 80 words', Balanced: 'moderate length', Detailed: 'thorough, with worked examples' };
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
const clean = (s, d, max = 30) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max).replace(/[\r\n]/g, ' ') : d);

function systemPrompt(b) {
  const mode = pick(b.mode, Object.keys(MODES), 'Explain');
  const len = pick(b.len, Object.keys(LEN), 'Balanced');
  return `You are StudyChat AI, a patient, encouraging expert tutor. Subject: ${clean(b.subj, 'General')}. Student level: ${pick(b.lv, ['School', 'High school', 'University'], 'School')}. Mode: ${mode}. Tone: ${clean(b.tone, 'Friendly')}. Length: ${LEN[len]}. Reply in ${clean(b.lang, 'English')}. ${MODES[mode]} Keep answers focused and well organised using short paragraphs; use **bold** for key terms and "-" bullets for lists; use plain text for maths (e.g. x^2, sqrt(x)). Never just give away an answer when the student is practising: guide them. If you are unsure, say so. The student's name is ${clean(b.name, 'there')}.`;
}

app.get('/', (_req, res) => res.send('StudyChat server is running.'));

app.post('/chat', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'Server is missing its API key.' });
  if (limited(req)) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  const b = req.body || {};
  let msgs = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
  msgs = msgs
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Send at least one user message.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(b) }] },
        contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 1000 }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Gemini error', r.status, JSON.stringify(data));
      return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'Too many questions right now. Please wait a moment.' : 'The AI service had a problem. Please try again.' });
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    res.json({ text: text || 'I could not produce an answer. Please try rephrasing your question.' });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the AI service.' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('StudyChat server listening'));
app.get('/test', async (_req, res) => {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY || '' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hello to a student in five words.' }] }] })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
