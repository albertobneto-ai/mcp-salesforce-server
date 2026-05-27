// src/routes/chat.js — Router de chat (substitui proxy.php)
const express  = require('express');
const claude   = require('../services/claude');
const grok     = require('../services/grok');
const { authMiddleware } = require('../middleware/auth');
const pool     = require('../config/db');
const alias    = require('../config/alias-map');

const router = express.Router();

// System prompts (carregados dos arquivos)
const specPrompt = require('../prompts/spec');
const hfPrompt   = require('../prompts/hf');
const ataPrompt  = require('../prompts/ata');

// ── Detectar comando no conteudo ──
function detectCommand(messages) {
  const lastMsg = messages[messages.length - 1]?.content || '';
  const lower = lastMsg.toLowerCase();

  // SPEC deve ser checado ANTES de HF (bug historico do proxy.php)
  if (lower.startsWith('/spec') || lower.includes('gere a spec'))
    return 'spec';
  if (lower.startsWith('/hf') || lower.includes('historia funcional'))
    return 'hf';
  if (lower.startsWith('/ata') || lower.includes('ata de reuniao'))
    return 'ata';
  if (lower.startsWith('/describe'))
    return 'describe';
  if (lower.startsWith('/status'))
    return 'status';
  if (lower.startsWith('/deploy'))
    return 'deploy';

  return 'chat';
}

// ── POST /api/chat — Resposta completa (sem streaming) ──
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'messages obrigatorio' });
    }

    const command = detectCommand(messages);
    let response, modelUsed, modelLabel;

    switch (command) {
      case 'spec':
        response   = await claude.call(specPrompt, messages);
        modelUsed  = 'claude-sonnet-4-6';
        modelLabel = 'Claude Sonnet 4.6';
        break;

      case 'hf':
        response   = await grok.call(hfPrompt, messages);
        modelUsed  = 'grok-4.20';
        modelLabel = 'Grok 4.20';
        break;

      case 'ata':
        response   = await grok.call(ataPrompt, messages);
        modelUsed  = 'grok-4.20';
        modelLabel = 'Grok 4.20';
        break;

      case 'describe': {
        const obj = messages[messages.length - 1].content
          .replace(/\/describe\s*/i, '').trim();
        const apiName = alias.resolve(obj);
        const descRes = await fetch(
          `${process.env.MCP_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/api/describe/${apiName}`
        );
        response   = JSON.stringify(await descRes.json(), null, 2);
        modelUsed  = 'mcp-server';
        modelLabel = 'MCP Server';
        break;
      }

      case 'status': {
        const stRes = await fetch(
          `${process.env.MCP_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}/test-connection`
        );
        response   = JSON.stringify(await stRes.json(), null, 2);
        modelUsed  = 'mcp-server';
        modelLabel = 'MCP Server';
        break;
      }

      default:
        response   = await grok.call('Voce e um assistente Salesforce.', messages);
        modelUsed  = 'grok-4.20';
        modelLabel = 'Grok 4.20';
    }

    // Salvar no historico (async, nao bloqueia resposta)
    if (req.user?.id) {
      pool.query(
        `INSERT INTO conversations (user_id, title, messages, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE SET messages = $3, updated_at = NOW()`,
        [req.user.id, command, JSON.stringify(messages)]
      ).catch(err => console.error('DB save error:', err));
    }

    res.json({
      choices: [{ message: { content: response } }],
      modelo_usado: modelUsed,
      modelo_label: modelLabel,
      tipo: command,
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(503).json({ erro: `Erro: ${err.message}` });
  }
});

// ── GET /api/chat/stream — SSE Streaming ──
router.get('/stream', authMiddleware, async (req, res) => {
  try {
    const messages = JSON.parse(req.query.messages || '[]');
    const command  = detectCommand(messages);

    // Headers SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Model', command === 'spec' ? 'claude-sonnet-4-6' : 'grok-4.20');

    let readableStream;
    if (command === 'spec') {
      readableStream = await claude.stream(specPrompt, messages);
    } else if (command === 'hf') {
      readableStream = await grok.stream(hfPrompt, messages);
    } else if (command === 'ata') {
      readableStream = await grok.stream(ataPrompt, messages);
    } else {
      readableStream = await grok.stream('Voce e um assistente Salesforce.', messages);
    }

    // Pipe do stream da API para o cliente via SSE
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Cada linha do stream da API e um "data: {...}"
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const raw = line.replace('data: ', '');
        if (raw === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(raw);
          // Claude format
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text || '';
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
          // OpenAI/Grok format
          if (parsed.choices?.[0]?.delta?.content) {
            const text = parsed.choices[0].delta.content;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch {
          // Chunk parcial, ignorar
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

module.exports = router;
