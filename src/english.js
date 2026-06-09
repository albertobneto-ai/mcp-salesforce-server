// src/english.js — rebuild-v2 — TechEnglish conversation simulator
import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const router = express.Router();

// Simple token auth (no express-session needed)
const tokens = new Set();

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const SCENARIOS = {
  interview: {
    label: 'Technical Interview', icon: '🎯',
    description: 'Senior Salesforce Architect position at a global company',
    systemPrompt: `You are a senior technical interviewer at a global technology company conducting a Salesforce Architect interview. 
Your role:
- Ask ONE focused question at a time about Salesforce architecture, design decisions, or technical leadership
- Listen to the candidate's response and follow up naturally based on what they said
- Cover topics like: Sales Cloud, Service Cloud, Data Cloud, Agentforce, Revenue Cloud, integration patterns, scalability, data modeling, governance
- Be professional but conversational — this is a real interview, not an interrogation
- After each response, either ask a follow-up OR move to a new topic naturally
Interview flow:
1. Start with a warm greeting and ONE opening question
2. Follow the conversation naturally for 10-15 minutes
3. When the user types "feedback" or the session ends, provide structured feedback
Feedback format (only when requested):
**What worked well:** [2-3 specific points]
**Areas to strengthen:** [1-2 specific points with example of better phrasing]
**Key vocabulary to practice:** [3-5 words/phrases they struggled with or could have used]
**Overall:** [1 sentence assessment]
IMPORTANT: Speak only English. Ask only ONE question at a time. Keep your turns concise. If the candidate struggles, don't switch to Portuguese — wait, ask if they want to rephrase. Start now with a greeting and your first question.`
  },
  stakeholder: {
    label: 'Stakeholder Meeting', icon: '📊',
    description: 'Presenting architecture decisions to business stakeholders',
    systemPrompt: `You are a VP of Sales Operations at a large enterprise. You have a meeting with a Salesforce Architect (the user) who will present and discuss technical decisions that affect your business.
Your role:
- Ask business-focused questions: "What's the impact on my team?", "How long will this take?", "What are the risks?"
- Push back when something sounds too technical or too expensive
- Ask for clarification when you don't understand something
- Be professional but direct — you care about business outcomes, not technical elegance
Topics to explore: Agentforce ROI, Data Cloud reporting, Revenue Cloud/CPQ timelines, Service Cloud automation, legacy integrations.
When user types "feedback", provide:
**Communication clarity:** [how well they explained tech to business audience]
**Vocabulary strengths:** [business English they used well]
**Phrases to add:** [3-4 phrases that would have helped]
**Overall:** [1 sentence]
IMPORTANT: English only. One question/reaction at a time. Be realistic — sometimes confused, sometimes satisfied, sometimes skeptical. Start now with your opening.`
  },
  technical: {
    label: 'Tech Team Meeting', icon: '⚙️',
    description: 'Sprint refinement and architecture discussion with your dev team',
    systemPrompt: `You are a senior Salesforce developer in a refinement/architecture discussion with the team's architect (the user).
Your role:
- Ask technical questions about implementation details, design decisions, edge cases
- Challenge assumptions: "What happens when...?", "Have you considered...?", "How does that handle...?"
- Be collaborative — you want to understand and improve the solution
- Use real Salesforce dev vocabulary: governor limits, bulkification, trigger frameworks, LWC lifecycle, SOQL optimization
Topics: story refinement, Apex patterns, Flow vs Apex tradeoffs, integration error handling, test coverage, tech debt.
When user types "feedback", provide:
**Technical English strengths:** [what they expressed well]
**Vocabulary gaps:** [terms they avoided or misphrased]
**Dev team phrases to practice:** [4-5 natural phrases from real dev discussions]
**Overall:** [1 sentence]
IMPORTANT: English only. One question/comment at a time. Use real dev jargon. Start now.`
  }
};

async function callOpenRouter(systemPrompt, messages, maxTk) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENROUTER_KEY}` },
    body: JSON.stringify({ model: 'deepseek/deepseek-chat-v3-0324', max_tokens: maxTk || 800, messages: [{ role: 'system', content: systemPrompt }, ...messages] })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// Auth
router.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ENGLISH_PASSWORD || 'english2026')) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.add(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});
router.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  tokens.delete(token);
  res.json({ ok: true });
});
router.get('/api/auth/check', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  res.json({ authenticated: tokens.has(token) });
});

// Scenarios
router.get('/api/chat/scenarios', authMiddleware, (req, res) => {
  res.json(Object.entries(SCENARIOS).map(([k, v]) => ({ id: k, label: v.label, icon: v.icon, description: v.description })));
});

// Chat
router.post('/api/chat/message', authMiddleware, async (req, res) => {
  const { scenario, messages, customPrompt, max_tokens } = req.body;
  let sysPrompt;
  if (customPrompt) {
    sysPrompt = customPrompt;
  } else if (SCENARIOS[scenario]) {
    sysPrompt = SCENARIOS[scenario].systemPrompt;
  } else {
    return res.status(400).json({ error: 'Invalid scenario' });
  }
  try {
    const reply = await callOpenRouter(sysPrompt, messages, max_tokens);
    res.json({ reply });
  } catch (err) {
    console.error('[english] Error:', err.message);
    res.status(500).json({ error: 'Failed to get response' });
  }
});

// Sessions
router.post('/api/sessions/save', authMiddleware, async (req, res) => {
  const { scenario, messages, feedback, duration_seconds } = req.body;
  try {
    const r = await pool.query(
      'INSERT INTO english_sessions (scenario, messages, feedback, duration_seconds) VALUES ($1, $2, $3, $4) RETURNING id',
      [scenario, JSON.stringify(messages), feedback || null, duration_seconds || null]
    );
    res.json({ id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: 'Failed to save' }); }
});

router.get('/api/sessions/history', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, scenario, feedback, duration_seconds, created_at, jsonb_array_length(messages) as message_count
       FROM english_sessions ORDER BY created_at DESC LIMIT 30`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch' }); }
});

// Init
export async function initEnglish() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS english_sessions (
      id SERIAL PRIMARY KEY, scenario VARCHAR(50) NOT NULL,
      messages JSONB NOT NULL DEFAULT '[]', feedback TEXT,
      duration_seconds INTEGER, created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[english] DB ready');
  } catch (e) { console.error('[english] DB init error:', e.message); }
}

export { router as englishRouter };
