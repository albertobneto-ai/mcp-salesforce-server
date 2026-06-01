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
    res.json({ card, artifacts, runs });
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

    res.json({
      agentAvailable: true,
      agent: {
        label: agent.label,
        model: agent.model,
        description: agent.desc,
      },
      card: { id: card.id, title: card.title, description: card.description },
      hasPreviousArtifact: hasPrev,
      missingArtifact: !hasPrev ? `Artefato do estágio "${needsPrev}" necessário` : null,
      inputPreview: hasPrev && needsPrev
        ? (artifacts.find(a => a.stage === needsPrev)?.content || '').slice(0, 500) + '...'
        : (card.description || card.title).slice(0, 500),
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

// ── DOWNLOAD artefato como texto ──
router.get('/artifacts/:id/download', async (req, res) => {
  // Auth: aceita Bearer header OU ?token= query param (para download via window.open)
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    const jwt = await import('jsonwebtoken');
    const SECRET = process.env.JWT_SECRET || 'everi9-dev-secret';
    jwt.default.verify(token, SECRET);
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
  // Auth OK — segue para o download
  {
  try {
    const { rows } = await (await import('../config/db.js')).default.query(
      'SELECT * FROM squad_artifacts WHERE id = $1', [Number(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Artefato não encontrado' });
    const art = rows[0];
    const ext = art.file_name?.endsWith('.json') ? 'json' : 'md';
    res.setHeader('Content-Type', ext === 'json' ? 'application/json' : 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${art.file_name || 'artifact.' + ext}"`);
    res.send(art.content || '');
  } catch (e) { res.status(500).json({ erro: e.message }); }
  }
});

// ── AGENT RUNS (log) ──
router.get('/cards/:id/runs', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ runs: await sq.getAgentRuns(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── STATS ──
router.get('/stats', authMiddleware, squadAuth, async (req, res) => {
  try { res.json(await sq.getStats()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;
