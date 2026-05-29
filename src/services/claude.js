// src/services/claude.js — Anthropic API com Prompt Caching
import { pushUsage } from './usage-context.js';
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
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  pushUsage('claude-sonnet-4-6', data.usage);
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
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude stream ${res.status}: ${await res.text()}`);
  return res.body;
}
