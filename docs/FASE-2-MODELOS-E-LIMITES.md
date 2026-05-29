# Ever i9 — Sistema de Tokens, Limites e Modelos Gratuitos (Fase 1 + Fase 2)

Documento de referência do mecanismo de medição de consumo, limite por usuário e
fallback para modelos gratuitos do OpenRouter. Não é carregado nos prompts de IA
(fica fora da knowledge base para não consumir tokens à toa).

---

## 1. Visão geral

O Ever i9 mede o consumo de tokens de IA por usuário, permite definir um limite
mensal individual, e oferece modelos gratuitos do OpenRouter como alternativa.
A medição é **passiva** (não altera a lógica dos comandos) e os handlers que
tocam a org (deploy, delete, describe, list, discovery, arch) **não foram alterados**.

Princípio de segurança: modelos gratuitos **nunca** executam ações ou leitura de org.
Só servem para `/hf`, `/ata` e chat.

---

## 2. Banco de dados

Tabela e coluna criadas via `GET /api/setup/init-db`:

- **`users.token_limit`** (BIGINT, default NULL) — limite mensal de tokens do usuário.
  NULL ou 0 = ilimitado.
- **Tabela `token_usage`** — uma linha por chamada de IA:
  `user_id, command, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at`.
  Índice `idx_token_usage_user_date (user_id, created_at)`.

O consumo do mês é `SUM(input_tokens + output_tokens)` desde `date_trunc('month', now())`.
O cache-read não é contado (conservador, a favor do usuário).

---

## 3. Captura de consumo (Fase 1)

Medição passiva via **AsyncLocalStorage** (contexto por requisição, à prova de concorrência):

- `src/services/usage-context.js` — ALS + `pushUsage(model, usage)` (normaliza Claude vs Grok)
- `src/services/usage-db.js` — `recordUsage`, `getMonthlyUsage`, `getUsageBreakdown`
- Um middleware (`usageContext`) envolve o handler POST `/api/chat` sem tocar no corpo;
  grava o consumo no evento `res.on('finish')`.
- `claude.js` e `grok.js` chamam `pushUsage` após cada resposta (aditivo).
- O streaming (`/spec`) tem a captura dentro do `collectStream` (eventos `message_start`/`message_delta`).

Chamada que **falha** não registra tokens (correto — não houve consumo).

Consulta do próprio consumo: `GET /api/chat/usage` → `{ month_used, token_limit, breakdown }`.

---

## 4. Modelos gratuitos (OpenRouter)

Config var no Heroku: **`OPENROUTER_KEY`**. API compatível com OpenAI.

3 modelos (verificados em 2026 — IDs `:free` podem mudar, conferir em openrouter.ai/models):

| Label | ID |
|---|---|
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash:free` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct:free` |
| Qwen3 Next 80B | `qwen/qwen3-next-80b-a3b-instruct:free` |

Serviço: `src/services/openrouter.js` → `callWithFallback(prompt, messages, modeloPreferido)`.
Tenta o modelo escolhido; se falhar (429/5xx/indisponível), cai para os outros da lista.

**Limitação do tier grátis:** ~20 req/min, ~200 req/dia, e os modelos podem ficar
indisponíveis ("temporarily rate-limited upstream"). Para disponibilidade melhor,
considerar um pequeno saldo de créditos na conta OpenRouter. Quando todos falham,
o sistema mostra mensagem amigável (sem erro 503).

---

## 5. Seleção de modelo e roteamento (Fase 2)

O frontend envia o header **`x-model`**:
- `auto` (padrão) → modelos modernos (Claude/Grok), roteados por comando.
- ID `:free` → modelo gratuito escolhido pelo usuário.

Gate no início do `/api/chat` (após detectar o comando), em `src/routes/chat.js`:

```
Categorias:
  FREE_ALLOWED     = [hf, ata, chat]                         (grátis pode rodar)
  MODERN_REQUIRED  = [spec, deploy, delete, arch, discovery, prototipo]  (só moderno)
  MCP_ONLY         = [describe, status, list, org, scratch, mock]  (sem IA, não afetado)

Lógica (pula tudo isso em follow-up de confirmação de deploy/delete: 1/2/seguir/cancelar):
  (a) modelo grátis + comando MODERN_REQUIRED  → bloqueio ROXO, não executa
  (b) modo auto + comando de IA + limite estourado:
        - comando FREE_ALLOWED     → vermelho + 3 botões de modelo grátis
        - comando MODERN_REQUIRED  → vermelho, exige moderno (sem botões)
  modelo grátis + FREE_ALLOWED → roda no grátis (com fallback) + alerta laranja
```

O limite é lido do **JWT** (gravado no login) → muda valem na **próxima sessão**
do usuário. Combine com "Encerrar sessão" para aplicar imediatamente.

---

## 6. Mensagens visuais (marcadores → caixas no frontend)

O backend emite marcadores; o `renderMd` do frontend renderiza as caixas:

| Marcador | Caixa | Quando |
|---|---|---|
| `[[BLOCK-MODERN]]...[[/BLOCK-MODERN]]` | 🟣 Roxo/lilás | Grátis tentando spec/deploy/delete |
| `[[LIMIT-EXCEEDED]]...[[/LIMIT-EXCEEDED]]` | 🔴 Vermelho | Limite mensal estourado |
| `[[FREE-BUTTONS]]` | 3 botões grátis | Dentro do vermelho (só FREE_ALLOWED) |
| `[[ALERT-FREE:Label]]` | ⚠️ Laranja/amarelo | Resposta gerada por modelo grátis |

Botão grátis reenvia o último comando do usuário com o modelo escolhido
(`window.__everi9SendModel(id)`).

---

## 7. Operação pelo administrador

No painel admin, por usuário:
- **🎟️ Limite de tokens/mês** — define o `token_limit` (vazio = ilimitado).
  Sugestão: 1.500.000. Vale na próxima sessão do usuário.
- **🚪 Encerrar sessão** — força novo login (aplica limite/perfil novos imediatamente).

Endpoints (admin):
- `PATCH /api/setup/users/:id/token-limit`  body `{ "limit": 1500000 }` (null/0 = ilimitado)
- `POST  /api/setup/users/:id/end-session`
- `GET   /api/chat/usage` (consumo do próprio usuário logado)

---

## 8. Estimativa de consumo (medido)

| Documento | Tokens/doc (medido) |
|---|---|
| HF (Grok) | ~4.000 |
| Ata (Grok) | ~3.300 |
| Spec (Claude, com prompt caching) | ~16.400 |

Uso típico (3 HF + 2 spec + 2 ata/dia): ~51.400/dia → ~1,13 milhão/mês (22 dias úteis).
Limite sugerido por usuário: **1,5 a 2 milhões de tokens/mês**.

Observação: o `/spec` bate o teto de output (`max_tokens` = 16.384) e pode truncar.
Aumentar o `max_tokens` deixa a spec completa, porém consome mais.

---

## 9. Arquivos envolvidos

| Arquivo | Papel |
|---|---|
| `src/services/usage-context.js` | ALS + pushUsage (novo) |
| `src/services/usage-db.js` | recordUsage / getMonthlyUsage / breakdown (novo) |
| `src/services/openrouter.js` | modelos grátis + fallback (novo) |
| `src/services/claude.js` | + pushUsage (aditivo) |
| `src/services/grok.js` | + pushUsage (aditivo) |
| `src/routes/chat.js` | middleware ALS + gate + roteamento grátis em hf/ata/chat |
| `src/middleware/auth.js` | token_limit no JWT |
| `src/setup.js` | tabela token_usage, coluna token_limit, endpoint token-limit |
| `client` (App.jsx) | seletor de modelos, caixas (renderMd), campo de limite no admin |

---

## 10. Regras invioláveis

- Modelos gratuitos **nunca** tocam a org nem executam spec/deploy/delete.
- A medição é passiva: não altera a lógica dos comandos existentes.
- Limite lido do JWT = muda valem na próxima sessão (use Encerrar sessão para aplicar já).
- Testes/deploys/deletes sempre na **Dev Org** (padrão), nunca na Sandbox, salvo pedido explícito.
