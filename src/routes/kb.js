// src/routes/kb.js — Endpoints da Base de Conhecimento
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as kbdb from '../services/kb-db.js';

const router = express.Router();

// Inicializa o schema (idempotente)
router.get('/init', async (req, res) => {
  try { await kbdb.ensureKbSchema(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Lista documentos (qualquer usuario autenticado)
router.get('/documents', authMiddleware, async (req, res) => {
  try { res.json({ documents: await kbdb.listDocuments() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Upload de documento (admin) — recebe texto ja extraido no cliente
router.post('/upload', authMiddleware, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ erro: 'Apenas admin pode gerenciar a base.' });
    const { title, text, sourceType, commandScope } = req.body || {};
    if (!title || !text) return res.status(400).json({ erro: 'title e text sao obrigatorios' });
    const result = await kbdb.addDocument(title, text, sourceType || 'upload', commandScope || 'all');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exclui documento (admin)
router.delete('/documents/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ erro: 'Apenas admin pode gerenciar a base.' });
    await kbdb.deleteDocument(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Busca (debug/uso interno) — retorna chunks relevantes
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const chunks = await kbdb.searchChunks(req.query.q || '', Number(req.query.limit) || 6, req.query.scope || null);
    res.json({ chunks });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;
