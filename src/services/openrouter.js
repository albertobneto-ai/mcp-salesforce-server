// src/services/openrouter.js — Modelos gratuitos via OpenRouter (API compativel com OpenAI)
import { pushUsage } from './usage-context.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 3 modelos gratuitos confiaveis (verificados em 2026). IDs :free.
export const FREE_MODELS = [
  { id: 'deepseek/deepseek-v4-flash:free', label: 'DeepSeek V4 Flash' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B' },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B' },
];

export function isFreeModel(model) {
  return !!model && FREE_MODELS.some(m => m.id === model);
}

export function labelFor(model) {
  return FREE_MODELS.find(m => m.id === model)?.label || model;
}

async function callOne(systemPrompt, messages, model, maxTokens) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://everi9.albertobottaro.info',
      'X-Title': 'Ever i9',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter ${model}: resposta vazia`);
  pushUsage(model, data.usage);
  return text;
}

// Tenta o modelo escolhido; se falhar (429/5xx/indisponivel), cai para os outros gratuitos.
export async function callWithFallback(systemPrompt, messages, preferredModel, maxTokens = 8192) {
  const order = [preferredModel, ...FREE_MODELS.map(m => m.id).filter(id => id !== preferredModel)];
  let lastErr;
  for (const model of order) {
    try {
      const text = await callOne(systemPrompt, messages, model, maxTokens);
      return { text, model };
    } catch (err) {
      lastErr = err;
      console.error('OpenRouter fallback:', err.message);
    }
  }
  throw lastErr || new Error('Todos os modelos gratuitos falharam');
}
