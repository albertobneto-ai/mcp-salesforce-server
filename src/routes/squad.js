// src/routes/squad.js — API do Squad Agentes SF
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as sq from '../services/squad-db.js';

const router = express.Router();

// Qualquer perfil autenticado acessa o Squad
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

// ── MOVE (drag & drop) ──
router.post('/cards/:id/move', authMiddleware, squadAuth, async (req, res) => {
  try {
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ erro: 'stage é obrigatório' });

    const card = await sq.moveCard(Number(req.params.id), stage);
    if (!card) return res.status(404).json({ erro: 'Card não encontrado' });

    // Verifica se stage tem agente (Entrega 2 ativará a execução)
    const stageConfig = sq.STAGES.find(s => s.key === stage);
    const agentAvailable = stageConfig?.hasAgent || false;

    res.json({ card, agentAvailable, stage: stageConfig });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ARTIFACTS ──
router.get('/cards/:id/artifacts', authMiddleware, squadAuth, async (req, res) => {
  try { res.json({ artifacts: await sq.getArtifacts(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
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
