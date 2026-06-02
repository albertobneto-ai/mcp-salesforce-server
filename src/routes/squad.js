// src/routes/squad.js — API do Squad Agentes SF
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as sq from '../services/squad-db.js';

const router = express.Router();

const squadAuth = (req, res, next) => {
  if (!req.user?.role) return res.status(403).json({ erro: 'Autenticação necessária.' });
  next();
};

// ── STAGES (config) ──
router.get('/stages', authMiddleware, squadAuth, (req, res) => {
  res.json({ stages: sq.STAGES });
});

// ── EXTRACT TEXT (de arquivos .txt/.docx/.pdf/.xlsx) ──
router.post('/extract-text', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { file_name, content_base64 } = req.body;
    if (!file_name || !content_base64) return res.status(400).json({ erro: 'file_name e content_base64 obrigatórios' });
    const buffer = Buffer.from(content_base64, 'base64');
    const ext = file_name.toLowerCase().split('.').pop();
    let text = '';

    if (ext === 'txt' || ext === 'md' || ext === 'csv') {
      text = buffer.toString('utf-8');
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.default.extractRawText({ buffer });
      text = result.value || '';
    } else if (ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      text = result.text || '';
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.default.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const csv = XLSX.default.utils.sheet_to_csv(sheet);
        if (csv.trim()) parts.push(`[Aba: ${sheetName}]\n${csv}`);
      }
      text = parts.join('\n\n');
    } else {
      return res.status(400).json({ erro: 'Formato não suportado. Use .txt, .docx, .pdf, .xlsx ou .csv' });
    }

    res.json({ text, chars: text.length, file_name });
  } catch (e) {
    console.error('[Squad extract-text]', e.message);
    res.status(500).json({ erro: 'Erro ao extrair texto: ' + e.message });
  }
});

// ── CARDS ──
router.get('/cards', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ cards: await sq.getCards() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/cards/:id', authMiddleware, squadAuth, async (req, res) => {
  try {
    const card = await sq.getCard(Number(req.params.id));
    if (!card) return res.status(404).json({ erro: 'Card não encontrado' });
    const artifacts = await sq.getArtifacts(card.id);
    const runs = await sq.getAgentRuns(card.id);
    const attachments = await sq.getAttachments(card.id);
    res.json({ card, artifacts, runs, attachments });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/cards', authMiddleware, squadAuth, async (req, res) => {
  try {
    const data = { ...req.body, created_by: req.user?.name || req.user?.email || '' };
    res.json({ card: await sq.createCard(data) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.patch('/cards/:id', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ card: await sq.updateCard(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/cards/:id', authMiddleware, squadAuth, async (req, res) => {
  try { await sq.deleteCard(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MOVE (drag & drop — SEM disparar agente) ──
router.post('/cards/:id/move', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ erro: 'stage é obrigatório' });
    const card = await sq.moveCard(Number(req.params.id), stage);
    if (!card) return res.status(404).json({ erro: 'Card não encontrado' });
    const stageConfig = sq.STAGES.find(s => s.key === stage);
    res.json({ card, agentAvailable: stageConfig?.hasAgent || false, stage: stageConfig });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PREVIEW do agente (o que será executado antes de confirmar) ──
router.get('/cards/:id/agent-preview', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { stage } = req.query;
    if (!stage) return res.status(400).json({ erro: 'stage query param obrigatório' });

    const card = await sq.getCard(Number(req.params.id));
    if (!card) return res.status(404).json({ erro: 'Card não encontrado' });

    // Import dinâmico do agent map
    const { AGENT_MAP } = await import('../services/squad-agent.js');
    const agent = AGENT_MAP[stage];
    if (!agent) return res.json({ agentAvailable: false });

    // Verifica se tem artefato anterior necessário
    const artifacts = await sq.getArtifacts(card.id);
    const prevMap = { spec: 'hf', dev: 'spec' };
    const needsPrev = prevMap[stage];
    const hasPrev = needsPrev ? artifacts.some(a => a.stage === needsPrev) : true;

    // Para HF: usa description + attachments como input
    const attachments = await sq.getAttachments(card.id);
    let inputPreview = '';
    if (stage === 'hf') {
      const fullInput = await sq.getFullCardInput(card.id);
      inputPreview = fullInput ? fullInput.slice(0, 500) + (fullInput.length > 500 ? '...' : '') : '(sem conteúdo)';
    } else if (hasPrev && needsPrev) {
      const prevArt = artifacts.find(a => a.stage === needsPrev);
      inputPreview = prevArt ? prevArt.content.slice(0, 500) + '...' : '';
    } else {
      inputPreview = (card.description || card.title).slice(0, 500);
    }

    res.json({
      agentAvailable: true,
      agent: { label: agent.label, model: agent.model, description: agent.desc },
      card: { id: card.id, title: card.title, description: card.description, story_number: card.story_number },
      hasPreviousArtifact: hasPrev,
      missingArtifact: !hasPrev ? `Artefato do estágio "${needsPrev}" necessário` : null,
      attachments: attachments.length,
      inputPreview,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── EXECUTAR AGENTE (após confirmação do modal) ──
router.post('/cards/:id/run-agent', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ erro: 'stage é obrigatório' });

    const card = await sq.getCard(Number(req.params.id));
    if (!card) return res.status(404).json({ erro: 'Card não encontrado' });

    // Keep-alive para evitar H12 timeout do Heroku
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write(' ');
    const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

    try {
      const { executeAgent } = await import('../services/squad-agent.js');
      const result = await executeAgent(card.id, stage);

      clearInterval(keepAlive);
      res.end(JSON.stringify({
        success: true,
        artifact: result.artifact,
        model: result.model,
        card_id: card.id,
        stage,
      }));
    } catch (err) {
      clearInterval(keepAlive);
      res.end(JSON.stringify({
        success: false,
        erro: err.message,
        card_id: card.id,
        stage,
      }));
    }
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ARTIFACTS ──
router.get('/cards/:id/artifacts', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ artifacts: await sq.getArtifacts(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── DOWNLOAD artefato como .docx Dark theme ──
router.get('/artifacts/:id/download', async (req, res) => {
  // Auth flexível: Bearer header OU ?token= query param (window.open)
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    const jwt = (await import('jsonwebtoken')).default;
    const SECRET = process.env.JWT_SECRET || 'everi9-dev-secret';
    jwt.verify(token, SECRET);
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
  try {
    const { rows } = await (await import('../config/db.js')).default.query(
      'SELECT * FROM squad_artifacts WHERE id = $1', [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Artefato não encontrado' });
    const art = rows[0];

    // JSON puro: download como .json
    if (art.artifact_type === 'manifest_json' || art.file_name?.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${art.file_name || 'manifest.json'}"`);
      return res.send(art.content || '');
    }

    // Demais artefatos: gera .docx com tema Dark
    const { generateDocxBuffer } = await import('./download.js');
    const docxName = (art.file_name || 'Documento').replace(/\.\w+$/, '');
    const buffer = await generateDocxBuffer(art.content || '', art.artifact_type || art.stage, docxName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${docxName}.docx"`);
    res.send(buffer);
  } catch (e) {
    console.error('[Squad download error]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── AGENT RUNS (log) ──
router.get('/cards/:id/runs', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ runs: await sq.getAgentRuns(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ATTACHMENTS (arquivos anexados ao card) ──
router.get('/cards/:id/attachments', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ attachments: await sq.getAttachments(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/cards/:id/attachments', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { file_name, content_base64 } = req.body;
    if (!file_name || !content_base64) return res.status(400).json({ erro: 'file_name e content_base64 obrigatórios' });

    // Extrair texto do arquivo
    const buffer = Buffer.from(content_base64, 'base64');
    const ext = file_name.toLowerCase().split('.').pop();
    let text = '';

    if (ext === 'txt' || ext === 'md' || ext === 'csv') {
      text = buffer.toString('utf-8');
    } else if (ext === 'docx') {
      const mammoth = await import('mammoth');
      text = (await mammoth.default.extractRawText({ buffer })).value || '';
    } else if (ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      text = (await pdfParse(buffer)).text || '';
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.default.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const s of wb.SheetNames) {
        const csv = XLSX.default.utils.sheet_to_csv(wb.Sheets[s]);
        if (csv.trim()) parts.push(`[Aba: ${s}]\n${csv}`);
      }
      text = parts.join('\n\n');
    } else {
      return res.status(400).json({ erro: 'Formato não suportado (.txt, .docx, .pdf, .xlsx, .csv)' });
    }

    const att = await sq.addAttachment({
      card_id: Number(req.params.id),
      file_name, file_type: ext,
      extracted_text: text,
      file_size: buffer.length,
    });
    res.json({ attachment: att, extracted_chars: text.length });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/cards/:id/attachments/:attId', authMiddleware, squadAuth, async (req, res) => {
  try { await sq.deleteAttachment(Number(req.params.attId)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/cards/:id/attachments', authMiddleware, squadAuth, async (req, res) => {
  try { await sq.deleteAllAttachments(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── STATS ──
router.get('/stats', authMiddleware, squadAuth, async (req, res) => {
  try { res.json(await sq.getStats()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;
