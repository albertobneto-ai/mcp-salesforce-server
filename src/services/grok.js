// src/services/grok.js — xAI API (Grok)
const API_URL = 'https://api.x.ai/v1/chat/completions';

/**
 * Chamada padrao (resposta completa)
 */
async function call(systemPrompt, messages, maxTokens = 16384) {
  const body = {
    model: process.env.GROK_MODEL || 'grok-4.20-0309-non-reasoning',
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * Streaming SSE
 */
async function stream(systemPrompt, messages, maxTokens = 16384) {
  const body = {
    model: process.env.GROK_MODEL || 'grok-4.20-0309-non-reasoning',
    max_tokens: maxTokens,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok stream ${res.status}: ${err}`);
  }

  return res.body;
}

module.exports = { call, stream };
