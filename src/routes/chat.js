// src/routes/chat.js — Router de chat com streaming para /spec
import express from 'express';
import * as claude from '../services/claude.js';
import * as grok from '../services/grok.js';
import { authMiddleware } from '../middleware/auth.js';
import { resolve as aliasResolve } from '../config/alias-map.js';
import specPrompt from '../prompts/spec.js';
import hfPrompt from '../prompts/hf.js';
import ataPrompt from '../prompts/ata.js';

const router = express.Router();

function detectCommand(messages) {
  const last = (messages[messages.length - 1]?.content || '').toLowerCase();
  if (last.startsWith('/spec') || last.includes('gere a spec')) return 'spec';
  if (last.startsWith('/hf') || last.includes('historia funcional')) return 'hf';
  if (last.startsWith('/ata') || last.includes('ata de reuniao')) return 'ata';
  if (last.startsWith('/describe')) return 'describe';
  if (last.startsWith('/status')) return 'status';
  if (last.startsWith('/deploy')) return 'deploy';
  return 'chat';
}

// ── Helper: parsear stream SSE da API e coletar texto completo ──
async function collectStream(readable, format) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const raw = line.replace('data: ', '').trim();
      if (raw === '[DONE]') continue;
      try {
        const p = JSON.parse(raw);
        // Claude format
        if (p.type === 'content_block_delta' && p.delta?.text) {
          full += p.delta.text;
        }
        // OpenAI/Grok format
        if (p.choices?.[0]?.delta?.content) {
          full += p.choices[0].delta.content;
        }
      } catch { /* partial */ }
    }
  }
  return full;
}

// POST /api/chat — com streaming interno pra evitar timeout de 30s do Heroku
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages obrigatorio' });

    const command = detectCommand(messages);
    let response, modelUsed, modelLabel;

    // Pra comandos que chamam modelos lentos (Claude), usar stream pra manter conexao viva
    if (command === 'spec') {
      // Iniciar resposta chunked imediatamente (evita timeout 30s do Heroku)
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' '); // byte de keep-alive

      const readable = await claude.stream(specPrompt, messages);
      // Manter conexao viva com pings
      const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      response = await collectStream(readable, 'claude');
      clearInterval(keepAlive);
      modelUsed = 'claude-sonnet-4-6';
      modelLabel = 'Claude Sonnet 4.6';

      res.end(JSON.stringify({
        choices: [{ message: { content: response } }],
        modelo_usado: modelUsed,
        modelo_label: modelLabel,
        tipo: command,
      }));
      return;
    }

    switch (command) {
      case 'hf':
        response = await grok.call(hfPrompt, messages);
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        break;
      case 'ata':
        response = await grok.call(ataPrompt, messages);
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        break;
      case 'describe': {
        const obj = messages[messages.length - 1].content.replace(/\/describe\s*/i, '').trim();
        const base = `http://localhost:${process.env.PORT || 3000}`;
        const r = await fetch(`${base}/api/describe/${aliasResolve(obj)}`);
        response = JSON.stringify(await r.json(), null, 2);
        modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
        break;
      }
      case 'status': {
        const base = `http://localhost:${process.env.PORT || 3000}`;
        const r = await fetch(`${base}/test-connection`);
        response = JSON.stringify(await r.json(), null, 2);
        modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
        break;
      }
      default:
        response = await grok.call('Voce e um assistente Salesforce.', messages);
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
    }

    res.json({
      choices: [{ message: { content: response } }],
      modelo_usado: modelUsed,
      modelo_label: modelLabel,
      tipo: command,
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    try { res.status(503).json({ erro: `Erro: ${err.message}` }); } catch {}
  }
});

// GET /api/chat/stream — SSE streaming puro
router.get('/stream', authMiddleware, async (req, res) => {
  try {
    const messages = JSON.parse(req.query.messages || '[]');
    const command = detectCommand(messages);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let readable;
    if (command === 'spec') readable = await claude.stream(specPrompt, messages);
    else if (command === 'hf') readable = await grok.stream(hfPrompt, messages);
    else if (command === 'ata') readable = await grok.stream(ataPrompt, messages);
    else readable = await grok.stream('Voce e um assistente Salesforce.', messages);

    const reader = readable.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const raw = line.replace('data: ', '');
        if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const p = JSON.parse(raw);
          const text = p.delta?.text || p.choices?.[0]?.delta?.content || '';
          if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
        } catch {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

export default router;
