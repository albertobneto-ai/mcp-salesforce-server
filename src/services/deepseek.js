// src/services/deepseek.js — DeepSeek API direta (OpenAI-compatible)
// Suporta deepseek-chat e deepseek-reasoner, com call() e stream()
import { pushUsage } from './usage-context.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
const getKey = () => process.env.DEEPSEEK_KEY || '';

export async function call(systemPrompt, messages, maxTokens = 8192, model = 'deepseek-chat') {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (data.usage) {
    pushUsage(model, {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
    });
  }
  return text;
}

// Stream SSE — retorna ReadableStream (Node fetch body)
export async function stream(systemPrompt, messages, maxTokens = 8192, model = 'deepseek-chat') {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek stream ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.body;
}
