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
        discovery_notes TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_hf_sessions_user ON hf_sessions(user_id)`);
    // Migrate: add discovery_notes if missing
    try { await pool.query(`ALTER TABLE hf_sessions ADD COLUMN IF NOT EXISTS discovery_notes TEXT DEFAULT ''`); } catch {}
  } catch (e) { console.error('[HF-Studio] Tabela nao criada:', e.message); }
})();

// ── GET /sessions — listar sessões do usuário ──
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, phase, discovery_notes, created_at, updated_at FROM hf_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50',
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

// ── PATCH /sessions/:id — atualizar título e/ou discovery_notes ──
router.patch('/sessions/:id', authMiddleware, async (req, res) => {
  const { title, discovery_notes } = req.body;
  try {
    const sets = []; const vals = []; let n = 1;
    if (title !== undefined) { sets.push(`title = $${n++}`); vals.push(title); }
    if (discovery_notes !== undefined) { sets.push(`discovery_notes = $${n++}`); vals.push(discovery_notes); }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id, req.user.id);
    const { rows } = await pool.query(
      `UPDATE hf_sessions SET ${sets.join(', ')} WHERE id = $${n++} AND user_id = $${n} RETURNING id, title, discovery_notes, phase, updated_at`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /optimize — estrutura o texto de Discovery com DeepSeek ──
router.post('/optimize', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text obrigatório' });
  try {
    const prompt = `Você é um Business Analyst sênior especializado em Salesforce. Receberá um texto bruto de Discovery — pode ser digitado, ditado por voz, ou uma mistura de ambos, possivelmente desorganizado, com repetições ou linguagem informal.

Sua tarefa é ORGANIZAR e ESTRUTURAR este texto mantendo 100% das informações originais, sem inventar nada. Transforme em um Discovery bem estruturado com as seguintes seções (use apenas as que tiverem conteúdo):

**Contexto e Objetivo**
O que o usuário quer resolver e por quê.

**Processo Atual (As-Is)**
Como funciona hoje.

**Necessidade / Problema**
A dor ou gap identificado.

**Resultado Esperado (To-Be)**
O que deveria funcionar após a solução.

**Personas Envolvidas**
Quem usa, quem aprova, quem é afetado.

**Regras e Restrições**
Condições, exceções, validações mencionadas.

**Informações Adicionais**
Volumes, integrações, dependências ou qualquer outro dado relevante.

REGRAS:
- Não invente informações — use APENAS o que está no texto
- Mantenha linguagem funcional (sem termos técnicos Salesforce)
- Se uma seção não tiver conteúdo, omita-a
- Responda APENAS com o Discovery estruturado, sem comentários antes ou depois
- Responda em português do Brasil`;

    const messages = [{ role: 'user', content: `Texto bruto do Discovery:\n\n${text}` }];
    const response = await deepseek.call(prompt, messages, 4096);
    res.json({ optimized: response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /analyze — analisar trecho selecionado com DeepSeek ──
router.post('/analyze', authMiddleware, async (req, res) => {
  const { text, context } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text obrigatório' });
  try {
    const prompt = `Você é um Business Analyst sênior Salesforce. O usuário selecionou um trecho de texto dentro de um documento de Discovery / História Funcional e quer sua análise.

Analise o trecho abaixo e responda em português do Brasil com:
1. **O que isso significa**: Interprete o trecho em termos de negócio
2. **Pontos de atenção**: Riscos, ambiguidades ou lacunas
3. **Sugestão funcional**: Como isso poderia ser melhor descrito ou detalhado

Seja objetivo e direto. Máximo 300 palavras.`;

    const messages = [{ role: 'user', content: `Trecho selecionado:\n\n"${text}"\n\n${context ? 'Contexto adicional: ' + context : ''}` }];
    const response = await deepseek.call(prompt, messages, 2048);
    res.json({ analysis: response });
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
    const hfMsg = [...messages].reverse().find(m =>
      m.role === 'assistant' && (m.content.includes('## 01. User Story') || m.content.includes('# HISTÓRIA FUNCIONAL'))
    );
    if (!hfMsg) return res.status(400).json({ error: 'Nenhuma HF gerada nesta sessão.' });

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
            PageBreak, BorderStyle, Table, TableRow, TableCell, WidthType,
            ShadingType, Header, Footer, TabStopType, TabStopPosition,
            BookmarkStart, BookmarkEnd, InternalHyperlink, LevelFormat } = await import('docx');

    // ── Paleta Dark ──
    const BLACK = '0A0A0A', ACCENT = 'E0E0E0', BODY_TEXT = '1A1A1A';
    const GRAY_BG = 'F0F0F0', WHITE = 'FFFFFF', GRAY_LINE = 'CCCCCC', ROW_ALT = 'F7F7F7';
    const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: GRAY_LINE };
    const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
    const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
    const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

    // ── Helpers ──
    function parseInline(text) {
      const runs = [];
      const re = /\*\*(.+?)\*\*/g;
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: 'Arial', size: 20, color: BODY_TEXT }));
        runs.push(new TextRun({ text: m[1], font: 'Arial', size: 20, color: BODY_TEXT, bold: true }));
        last = re.lastIndex;
      }
      if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: 'Arial', size: 20, color: BODY_TEXT }));
      return runs.length ? runs : [new TextRun({ text, font: 'Arial', size: 20, color: BODY_TEXT })];
    }

    function headerCell(text, width) {
      return new TableCell({
        borders, width: { size: width, type: WidthType.DXA },
        shading: { fill: BLACK, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: text.toUpperCase(), bold: true, color: WHITE, font: 'Arial', size: 18 })] })]
      });
    }

    function dataCell(text, width, rowIdx) {
      return new TableCell({
        borders, width: { size: width, type: WidthType.DXA },
        shading: rowIdx % 2 === 0 ? { fill: ROW_ALT, type: ShadingType.CLEAR } : undefined,
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({ children: parseInline(text) })]
      });
    }

    function buildTable(headers, dataRows) {
      const colW = Math.floor(9000 / (headers.length || 1));
      const tRows = [];
      tRows.push(new TableRow({ children: headers.map(h => headerCell(h, colW)) }));
      dataRows.forEach((cells, ri) => {
        tRows.push(new TableRow({ children: cells.map(c => dataCell(c, colW, ri)) }));
      });
      return new Table({ rows: tRows, width: { size: 9000, type: WidthType.DXA } });
    }

    // ── Strip preamble (antes de # HISTÓRIA) e postamble (após seção 14) ──
    let content = hfMsg.content;
    const hfStart = content.indexOf('# HISTÓRIA FUNCIONAL');
    if (hfStart > 0) content = content.slice(hfStart);
    // Cortar qualquer lixo após seção 14 (emoji, sugestões, etc.)
    const postMarkers = ['✅', 'Deseja que eu gere', 'Posso gerar', 'História Funcional gerada'];
    for (const marker of postMarkers) {
      const idx = content.lastIndexOf(marker);
      if (idx > 0) {
        // Só cortar se o marker está FORA de uma seção (após ## 14)
        const sec14 = content.lastIndexOf('## 12');
        if (sec14 < 0) { const s14b = content.lastIndexOf('## 14'); if (s14b > 0 && idx > s14b + 100) content = content.slice(0, idx).trimEnd(); }
        else if (idx > sec14 + 100) { content = content.slice(0, idx).trimEnd(); }
      }
    }

    // ── Parse markdown → docx children ──
    const lines = content.split('\n');
    const docChildren = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Tabela markdown: acumular linhas que começam com |
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
          const row = lines[i].trim().split('|').slice(1, -1).map(c => c.trim());
          // Pular linha separadora (---)
          if (!row.every(c => /^[-:]+$/.test(c))) tableLines.push(row);
          i++;
        }
        if (tableLines.length >= 2) {
          // Limpar colunas vazias/lixo (apenas "-", "—", "" em TODAS as linhas)
          const colCount = tableLines[0].length;
          const keepCols = [];
          for (let ci = 0; ci < colCount; ci++) {
            const allEmpty = tableLines.every(row => {
              const val = (row[ci] || '').trim();
              return !val || val === '-' || val === '—' || val === '–';
            });
            if (!allEmpty) keepCols.push(ci);
          }
          const cleaned = tableLines.map(row => keepCols.map(ci => row[ci] || ''));
          if (cleaned.length >= 2 && cleaned[0].length > 0) {
            docChildren.push(buildTable(cleaned[0], cleaned.slice(1)));
            docChildren.push(new Paragraph({ text: '', spacing: { after: 120 } }));
          }
        } else if (tableLines.length === 1) {
          docChildren.push(new Paragraph({ children: parseInline(tableLines[0].join(' | ')), spacing: { before: 60 } }));
        }
        continue;
      }

      // Heading 1
      if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
        const txt = trimmed.slice(2);
        docChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLACK, space: 4 } },
          children: [new TextRun({ text: txt, bold: true, size: 28, color: BLACK, font: 'Arial' })]
        }));
        i++; continue;
      }

      // Heading 2 (## 01. User Story)
      if (trimmed.startsWith('## ')) {
        const txt = trimmed.slice(3);
        const numMatch = txt.match(/^(\d{2})\.\s*(.*)/);
        const children = numMatch
          ? [new TextRun({ text: numMatch[1] + '  ', font: 'Arial', size: 28, bold: true, color: 'AAAAAA' }),
             new TextRun({ text: numMatch[2], font: 'Arial', size: 28, bold: true, color: BLACK })]
          : [new TextRun({ text: txt, font: 'Arial', size: 26, bold: true, color: BLACK })];
        docChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLACK, space: 4 } },
          children
        }));
        i++; continue;
      }

      // Heading 3 (### 02.1 Situação)
      if (trimmed.startsWith('### ')) {
        docChildren.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: trimmed.slice(4), font: 'Arial', size: 22, bold: true, color: BLACK })]
        }));
        i++; continue;
      }

      // HR
      if (trimmed === '---' || trimmed === '***') { i++; continue; }

      // Checkbox
      if (trimmed.startsWith('- [ ]') || trimmed.startsWith('- [x]')) {
        const checked = trimmed.startsWith('- [x]');
        docChildren.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          indent: { left: 720 },
          children: [new TextRun({ text: (checked ? '☑ ' : '☐ '), font: 'Arial', size: 20, color: checked ? '22c55e' : '888888' }),
                     ...parseInline(trimmed.slice(5).trim())]
        }));
        i++; continue;
      }

      // Bullet (- or *)
      if (/^[-*]\s/.test(trimmed)) {
        docChildren.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          indent: { left: 720, hanging: 360 },
          children: [new TextRun({ text: '•  ', font: 'Arial', size: 20, color: '888888' }),
                     ...parseInline(trimmed.slice(2))]
        }));
        i++; continue;
      }

      // Numbered list (1. 2. etc)
      if (/^\d+[.)]\s/.test(trimmed)) {
        const numEnd = trimmed.indexOf(' ');
        const num = trimmed.slice(0, numEnd);
        docChildren.push(new Paragraph({
          spacing: { before: 40, after: 40 },
          indent: { left: 720, hanging: 360 },
          children: [new TextRun({ text: num + ' ', font: 'Arial', size: 20, color: '888888', bold: true }),
                     ...parseInline(trimmed.slice(numEnd + 1))]
        }));
        i++; continue;
      }

      // Blockquote
      if (trimmed.startsWith('> ')) {
        docChildren.push(new Paragraph({
          spacing: { before: 60, after: 60 },
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 6, color: '6c44a0', space: 8 } },
          children: [new TextRun({ text: trimmed.slice(2), font: 'Arial', size: 20, color: '555555', italics: true })]
        }));
        i++; continue;
      }

      // Empty line
      if (!trimmed) { i++; continue; }

      // Body text with inline bold
      docChildren.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        children: parseInline(trimmed)
      }));
      i++;
    }

    // ── Capa Dark Corporativa ──
    const title = rows[0].title || 'História Funcional';
    const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    const subtleBorder = { style: BorderStyle.SINGLE, size: 1, color: '333333' };

    const coverCell = new TableCell({
      borders: noBorders,
      shading: { fill: BLACK, type: ShadingType.CLEAR },
      margins: { top: 1200, bottom: 600, left: 1000, right: 1000 },
      children: [
        // Spacer
        new Paragraph({ spacing: { after: 1600 }, children: [] }),
        // Eyebrow
        new Paragraph({
          spacing: { after: 300 },
          children: [new TextRun({ text: 'SALESFORCE PLATFORM  /  EVER I9', font: 'Arial', size: 18, color: '666666', characterSpacing: 80 })]
        }),
        // Accent line
        new Paragraph({
          spacing: { after: 300 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '6c44a0', space: 0 } },
          children: [new TextRun({ text: ' ', font: 'Arial', size: 4 })]
        }),
        // Title
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: 'HISTÓRIA', font: 'Arial', size: 60, bold: true, color: WHITE })]
        }),
        new Paragraph({
          spacing: { after: 300 },
          children: [new TextRun({ text: 'FUNCIONAL', font: 'Arial', size: 60, bold: true, color: WHITE })]
        }),
        // Subtitle
        new Paragraph({
          spacing: { after: 800 },
          children: [new TextRun({ text: title, font: 'Arial', size: 26, color: ACCENT })]
        }),
        // Separator
        new Paragraph({
          spacing: { after: 300 },
          border: { top: { style: BorderStyle.SINGLE, size: 1, color: '444444', space: 8 } },
          children: [new TextRun({ text: ' ', font: 'Arial', size: 4 })]
        }),
        // Metadata
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'PROJETO    ', font: 'Arial', size: 16, color: '666666' }),
            new TextRun({ text: 'CRM B2B Algar Telecom', font: 'Arial', size: 16, color: WHITE, bold: true })
          ]
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'GERADO     ', font: 'Arial', size: 16, color: '666666' }),
            new TextRun({ text: 'Ever i9 — HF Studio (DeepSeek)', font: 'Arial', size: 16, color: WHITE, bold: true })
          ]
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'DATA       ', font: 'Arial', size: 16, color: '666666' }),
            new TextRun({ text: today, font: 'Arial', size: 16, color: WHITE, bold: true })
          ]
        }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: 'STATUS     ', font: 'Arial', size: 16, color: '666666' }),
            new TextRun({ text: 'Draft', font: 'Arial', size: 16, color: WHITE, bold: true })
          ]
        }),
      ]
    });

    const doc = new Document({
      sections: [
        // Capa
        {
          properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
          children: [
            new Table({ rows: [new TableRow({ children: [coverCell] })], width: { size: 12240, type: WidthType.DXA } }),
          ]
        },
        // Corpo
        {
          properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
          headers: {
            default: new Header({ children: [new Paragraph({
              border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
              children: [
                new TextRun({ text: 'EVER I9', font: 'Arial', size: 16, color: '888888' }),
                new TextRun({ text: '  —  HISTÓRIA FUNCIONAL', font: 'Arial', size: 16, color: BLACK, bold: true }),
              ]
            })] })
          },
          footers: {
            default: new Footer({ children: [new Paragraph({
              border: { top: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: 'Confidencial — Uso Interno', font: 'Arial', size: 14, color: '888888' })]
            })] })
          },
          children: docChildren,
        }
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const filename = `HF_${title.replace(/[^a-zA-Z0-9À-ÿ]/g, '_').slice(0, 50)}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    console.error('[HF-Studio] Export erro:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
