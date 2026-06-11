// src/routes/hf-studio.js — HF Studio: Discovery interativo + Geração com DeepSeek
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as deepseek from '../services/deepseek.js';
import hfDiscoveryPrompt from '../prompts/hf-discovery.js';
import pool from '../config/db.js';
import * as kbdb from '../services/kb-db.js';

const router = express.Router();

// ── Ensure table ──
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hf_sessions (
        id          SERIAL PRIMARY KEY,
        user_id     INT REFERENCES users(id) ON DELETE CASCADE,
        title       VARCHAR(500) DEFAULT 'Nova HF',
        phase       VARCHAR(20) DEFAULT 'discovery',
        messages    JSONB DEFAULT '[]',
        hf_data     JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_hf_sessions_user ON hf_sessions(user_id)`);
  } catch (e) { console.error('[HF-Studio] Tabela nao criada:', e.message); }
})();

// ── GET /sessions — listar sessões do usuário ──
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, phase, created_at, updated_at FROM hf_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sessions — criar nova sessão ──
router.post('/sessions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO hf_sessions (user_id) VALUES ($1) RETURNING id, title, phase, created_at',
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /sessions/:id — deletar sessão ──
router.delete('/sessions/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM hf_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /sessions/:id — carregar sessão completa ──
router.get('/sessions/:id', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM hf_sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /chat — enviar mensagem e obter resposta do DeepSeek (streaming SSE) ──
router.post('/chat', authMiddleware, async (req, res) => {
  const { session_id, message } = req.body;
  if (!session_id || !message?.trim()) return res.status(400).json({ error: 'session_id e message obrigatórios' });

  try {
    // Carregar sessão
    const { rows } = await pool.query(
      'SELECT * FROM hf_sessions WHERE id = $1 AND user_id = $2',
      [session_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    const session = rows[0];
    const messages = session.messages || [];

    // Adicionar mensagem do usuário
    messages.push({ role: 'user', content: message });

    // Enriquecer prompt com KB
    let promptFinal = hfDiscoveryPrompt;
    try {
      const kbChunks = await kbdb.searchChunks(message, 4, null);
      if (kbChunks.length) {
        promptFinal += '\n\n---\nBASE DE CONHECIMENTO INTERNA:\n' +
          kbChunks.map(c => '[' + c.title + ']\n' + c.content).join('\n\n');
      }
    } catch {}

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let fullResponse = '';

    try {
      const readable = await deepseek.stream(promptFinal, messages, 16384);
      const decoder = new TextDecoder();

      for await (const chunk of readable) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullResponse += delta;
              res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
            }
          } catch {}
        }
      }
    } catch (streamErr) {
      // Fallback: non-streaming
      console.error('[HF-Studio] Stream falhou, fallback call():', streamErr.message);
      try {
        fullResponse = await deepseek.call(promptFinal, messages, 16384);
        res.write(`data: ${JSON.stringify({ content: fullResponse })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch (callErr) {
        res.write(`data: ${JSON.stringify({ error: callErr.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }

    // Salvar no banco
    messages.push({ role: 'assistant', content: fullResponse });

    // Detectar fase
    let phase = session.phase;
    if (fullResponse.includes('# HISTÓRIA FUNCIONAL') || fullResponse.includes('## 01. User Story')) {
      phase = 'generated';
    } else if (fullResponse.includes('Confirma?') || fullResponse.includes('RESUMO DO DISCOVERY')) {
      phase = 'confirmation';
    }

    // Auto-title da sessão
    let title = session.title;
    if (title === 'Nova HF' && messages.length <= 3) {
      const userMsg = messages.find(m => m.role === 'user')?.content || '';
      title = userMsg.slice(0, 80) || 'Nova HF';
    }

    await pool.query(
      'UPDATE hf_sessions SET messages = $1, phase = $2, title = $3, updated_at = NOW() WHERE id = $4',
      [JSON.stringify(messages), phase, title, session_id]
    );

    res.end();
  } catch (e) {
    console.error('[HF-Studio] Erro:', e);
    try { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.write('data: [DONE]\n\n'); } catch {}
    res.end();
  }
});

// ── POST /export-docx — gerar .docx a partir da última HF gerada na sessão ──
router.post('/export-docx', authMiddleware, async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id obrigatório' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM hf_sessions WHERE id = $1 AND user_id = $2',
      [session_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });

    const messages = rows[0].messages || [];
    // Encontrar a última mensagem do assistant que contém a HF
    const hfMsg = [...messages].reverse().find(m =>
      m.role === 'assistant' && (m.content.includes('## 01. User Story') || m.content.includes('# HISTÓRIA FUNCIONAL'))
    );
    if (!hfMsg) return res.status(400).json({ error: 'Nenhuma HF gerada nesta sessão. Continue o Discovery.' });

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
            PageBreak, BorderStyle, Table, TableRow, TableCell, WidthType,
            ShadingType, Header, Footer, TableOfContents } = await import('docx');

    const BLACK = '0A0A0A', WHITE = 'FFFFFF', GRAY_BG = 'F0F0F0', ROW_ALT = 'F7F7F7', ACCENT = 'E0E0E0';

    // Parse markdown sections
    const content = hfMsg.content;
    const lines = content.split('\n');
    const docChildren = [];
    let inTable = false, tableRows = [], tableHeaders = [];

    function flushTable() {
      if (!tableRows.length) return;
      const allRows = [tableHeaders, ...tableRows];
      const colCount = allRows[0]?.length || 1;
      const tRows = allRows.map((cells, ri) => new TableRow({
        children: cells.map(cell => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: cell, bold: ri === 0, color: ri === 0 ? WHITE : '1A1A1A', size: 18, font: 'Arial' })], alignment: AlignmentType.LEFT })],
          shading: { type: ShadingType.CLEAR, fill: ri === 0 ? BLACK : (ri % 2 === 0 ? ROW_ALT : WHITE) },
          width: { size: Math.floor(9000 / colCount), type: WidthType.DXA },
        })),
      }));
      docChildren.push(new Table({ rows: tRows, width: { size: 9000, type: WidthType.DXA } }));
      docChildren.push(new Paragraph({ text: '' }));
      tableRows = []; tableHeaders = []; inTable = false;
    }

    for (const line of lines) {
      const trimmed = line.trim();

      // Table row
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c))) continue; // separator
        if (!inTable) { inTable = true; tableHeaders = cells; }
        else { tableRows.push(cells); }
        continue;
      }
      if (inTable) flushTable();

      // Headings
      if (trimmed.startsWith('# ')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(2), bold: true, size: 32, color: BLACK, font: 'Arial' })], heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }));
      } else if (trimmed.startsWith('## ')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(3), bold: true, size: 26, color: BLACK, font: 'Arial' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 }, border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: BLACK } } }));
      } else if (trimmed.startsWith('### ')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(4), bold: true, size: 22, color: '444444', font: 'Arial' })], heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 } }));
      } else if (trimmed.startsWith('---')) {
        // skip hr
      } else if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')) {
        const checked = trimmed.startsWith('- [x]');
        const text = trimmed.slice(5).trim();
        docChildren.push(new Paragraph({ children: [new TextRun({ text: (checked ? '☑ ' : '☐ ') + text, size: 20, color: '1A1A1A', font: 'Arial' })], spacing: { before: 50 } }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: '  • ' + trimmed.slice(2), size: 20, color: '1A1A1A', font: 'Arial' })], spacing: { before: 50 } }));
      } else if (trimmed.startsWith('> ')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(2), italics: true, size: 20, color: '555555', font: 'Arial' })], indent: { left: 720 }, spacing: { before: 50 } }));
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**')) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed.slice(2, -2), bold: true, size: 20, color: '1A1A1A', font: 'Arial' })], spacing: { before: 100 } }));
      } else if (trimmed) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 20, color: '1A1A1A', font: 'Arial' })], spacing: { before: 50 } }));
      }
    }
    if (inTable) flushTable();

    const doc = new Document({
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 } } },
        headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: 'EVER I9 — HISTÓRIA FUNCIONAL', size: 16, color: '888888', font: 'Arial' })], alignment: AlignmentType.RIGHT })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: 'Confidencial — Uso Interno', size: 14, color: '888888', font: 'Arial' })], alignment: AlignmentType.CENTER })] }) },
        children: docChildren,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `HF_${rows[0].title.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    console.error('[HF-Studio] Export erro:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
