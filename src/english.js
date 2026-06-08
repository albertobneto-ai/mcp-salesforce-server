// src/english.js — TechEnglish routes mounted on /english
const express = require('express');
const router = express.Router();

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

Feedback format (only when requested or session ends):
**What worked well:** [2-3 specific points]
**Areas to strengthen:** [1-2 specific points with example of better phrasing]
**Key vocabulary to practice:** [3-5 words/phrases they struggled with or could have used]
**Overall:** [1 sentence assessment]

IMPORTANT: 
- Speak only English
- Ask only ONE question at a time
- Keep your turns concise — this is a conversation, not a lecture
- If the candidate seems to struggle, don't switch to Portuguese — wait for them, ask if they want to rephrase
- Start the session now with a greeting and your first question`
  },
  stakeholder: {
    label: 'Stakeholder Meeting', icon: '📊',
    description: 'Presenting architecture decisions to business stakeholders',
    systemPrompt: `You are a VP of Sales Operations at a large enterprise. You have a meeting with a Salesforce Architect (the user) who will present and discuss technical decisions that affect your business.

Your role:
- Ask business-focused questions about technical decisions: "What's the impact on my team?", "How long will this take?", "What are the risks?"
- Push back when something sounds too technical or too expensive
- Ask for clarification when you don't understand something
- Be professional but direct — you care about business outcomes, not technical elegance
- React realistically to what the architect says

Topics to explore:
- Agentforce implementation and ROI
- Data Cloud integration and what it means for reporting
- Revenue Cloud / CPQ rollout timelines
- Service Cloud automation impact on support team
- Integration with legacy systems

Session flow:
1. Start by setting the meeting context and your first concern or question
2. React naturally to responses — follow the conversation
3. When user types "feedback", provide session feedback

Feedback format:
**Communication clarity:** [how well they explained technical concepts to a business audience]
**Vocabulary strengths:** [business/stakeholder English they used well]
**Phrases to add:** [3-4 phrases that would have helped in specific moments]
**Overall:** [1 sentence]

IMPORTANT:
- Speak only English
- One question or reaction at a time
- Be realistic — sometimes confused, sometimes satisfied, sometimes skeptical
- Start now with your opening`
  },
  technical: {
    label: 'Tech Team Meeting', icon: '⚙️',
    description: 'Sprint refinement and architecture discussion with your dev team',
    systemPrompt: `You are a senior Salesforce developer on a team. You're in a refinement/architecture discussion with the team's architect (the user). 

Your role:
- Ask technical questions about implementation details, design decisions, edge cases
- Challenge assumptions with technical depth: "What happens when...?", "Have you considered...?", "How does that handle...?"
- Be collaborative, not adversarial — you want to understand and improve the solution
- Use real Salesforce dev vocabulary: governor limits, bulkification, trigger frameworks, LWC lifecycle, SOQL optimization, etc.

Topics to cover naturally:
- User story refinement and acceptance criteria
- Apex design decisions and patterns
- Flow vs Apex tradeoffs
- Integration error handling
- Test coverage strategy
- Technical debt discussion

Session flow:
1. Start with a brief context (we're in a refinement session) and your first technical question
2. Follow the conversation — push deeper on interesting points
3. When user types "feedback", provide feedback

Feedback format:
**Technical English strengths:** [what they expressed well]
**Vocabulary gaps noticed:** [specific terms they avoided or misphrased]
**Dev team phrases to practice:** [4-5 natural phrases used in real dev discussions]
**Overall:** [1 sentence]

IMPORTANT:
- English only
- One question/comment at a time  
- Use real dev jargon naturally — don't simplify
- Start now`
  }
};

async function callOpenRouter(systemPrompt, messages) {
  const openRouterMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      max_tokens: 1024,
      messages: openRouterMessages
    })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// Auth — simple password via session
router.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ENGLISH_PASSWORD || 'english2026')) {
    req.session.english_auth = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  req.session.english_auth = false;
  res.json({ ok: true });
});

router.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: !!req.session?.english_auth });
});

// Chat
router.get('/api/chat/scenarios', (req, res) => {
  if (!req.session?.english_auth) return res.status(401).json({ error: 'Unauthorized' });
  const list = Object.entries(SCENARIOS).map(([key, val]) => ({
    id: key, label: val.label, icon: val.icon, description: val.description
  }));
  res.json(list);
});

router.post('/api/chat/message', async (req, res) => {
  if (!req.session?.english_auth) return res.status(401).json({ error: 'Unauthorized' });
  const { scenario, messages } = req.body;
  if (!SCENARIOS[scenario]) return res.status(400).json({ error: 'Invalid scenario' });
  try {
    const reply = await callOpenRouter(SCENARIOS[scenario].systemPrompt, messages);
    res.json({ reply });
  } catch (err) {
    console.error('[english] OpenRouter error:', err.message);
    res.status(500).json({ error: 'Failed to get response' });
  }
});

// Sessions (uses app's existing pool)
router.post('/api/sessions/save', async (req, res) => {
  if (!req.session?.english_auth) return res.status(401).json({ error: 'Unauthorized' });
  const { scenario, messages, feedback, duration_seconds } = req.body;
  try {
    const pool = req.app.get('pool');
    const result = await pool.query(
      `INSERT INTO english_sessions (scenario, messages, feedback, duration_seconds)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [scenario, JSON.stringify(messages), feedback || null, duration_seconds || null]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    console.error('[english] DB error:', err.message);
    res.status(500).json({ error: 'Failed to save' });
  }
});

router.get('/api/sessions/history', async (req, res) => {
  if (!req.session?.english_auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const pool = req.app.get('pool');
    const result = await pool.query(
      `SELECT id, scenario, feedback, duration_seconds, created_at,
              jsonb_array_length(messages) as message_count
       FROM english_sessions ORDER BY created_at DESC LIMIT 30`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// DB init
async function initEnglishDB(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS english_sessions (
        id SERIAL PRIMARY KEY,
        scenario VARCHAR(50) NOT NULL,
        messages JSONB NOT NULL DEFAULT '[]',
        feedback TEXT,
        duration_seconds INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('[english] DB table ready');
  } catch (err) {
    console.error('[english] DB init error:', err.message);
  }
}

module.exports = { englishRouter: router, initEnglishDB };
