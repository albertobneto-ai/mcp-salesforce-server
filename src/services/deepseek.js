// src/services/deepseek.js — DeepSeek API direta (OpenAI-compatible)
// Fallback entre modelos gratuitos e Claude Haiku
import { pushUsage } from './usage-context.js';

const API_URL = 'https://api.deepseek.com/chat/completions';
// TODO: mover para config var DEEPSEEK_KEY no Heroku e remover fallback hardcoded
const getKey = () => process.env.DEEPSEEK_KEY || 'sk-9981c7ebedee497f8fbbfa9a0184b725';

export async function call(systemPrompt, messages, maxTokens = 8192) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (data.usage) {
    pushUsage('deepseek-chat', {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
    });
  }
  return text;
}
