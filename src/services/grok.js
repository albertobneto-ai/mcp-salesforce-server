// src/services/grok.js — xAI API (Grok) com Web Search via Tools API
const API_URL = 'https://api.x.ai/v1/chat/completions';

export async function call(systemPrompt, messages, maxTokens = 16384, options = {}) {
  const body = {
    model: process.env.GROK_MODEL || 'grok-3-mini-fast',
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };

  // Ativar busca web via Tools API
  if (options.search) {
    body.tools = [{ type: 'web_search' }];
    body.tool_choice = 'auto';
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

export async function stream(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROK_MODEL || 'grok-3-mini-fast',
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`Grok stream ${res.status}: ${await res.text()}`);
  return res.body;
}
