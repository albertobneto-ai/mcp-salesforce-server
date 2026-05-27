// src/services/claude.js — Anthropic API (Claude Sonnet)
const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Chamada padrão (aguarda resposta completa)
 */
async function call(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

/**
 * Streaming SSE — retorna ReadableStream
 */
async function stream(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      stream: true,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude stream ${res.status}: ${err}`);
  }

  return res.body;
}

module.exports = { call, stream };
