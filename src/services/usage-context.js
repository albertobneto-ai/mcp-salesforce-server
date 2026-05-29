// src/services/usage-context.js — Captura passiva de consumo de tokens por requisicao
import { AsyncLocalStorage } from 'async_hooks';

export const usageALS = new AsyncLocalStorage();

// Chamado pelos servicos de IA (claude/grok) apos cada resposta.
// Normaliza o formato de usage do Claude e do Grok.
export function pushUsage(model, usage) {
  if (!usage) return;
  const store = usageALS.getStore();
  if (!store) return;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  store.pending.push({ model, input, output, cacheRead, cacheWrite });
}
