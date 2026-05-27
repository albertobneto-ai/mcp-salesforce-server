// src/services/claude.js — Anthropic API (Claude Sonnet)
const API_URL = 'https://api.anthropic.com/v1/messages';

export async function call(systemPrompt, messages, maxTokens = 16384) {
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
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

export async function stream(systemPrompt, messages, maxTokens = 16384) {
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
  if (!res.ok) throw new Error(`Claude stream ${res.status}: ${await res.text()}`);
  return res.body;
}
