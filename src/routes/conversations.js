// src/routes/conversations.js — Persistência de conversas
import express from 'express';
import pg from 'pg';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

function getPool() {
  return new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// GET /api/conversations — lista conversas do usuário
router.get('/', authMiddleware, async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// GET /api/conversations/:id — carrega uma conversa
router.get('/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  try {
    const result = await pool.query(
      'SELECT id, title, messages, updated_at FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Conversa nao encontrada' });
    res.json({ conversation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// POST /api/conversations — cria nova conversa
router.post('/', authMiddleware, async (req, res) => {
  const pool = getPool();
  try {
    const { title, messages } = req.body;
    const result = await pool.query(
      'INSERT INTO conversations (user_id, title, messages) VALUES ($1, $2, $3) RETURNING id, title, updated_at',
      [req.user.id, (title || 'Nova conversa').slice(0, 250), JSON.stringify(messages || [])]
    );
    res.json({ conversation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// PUT /api/conversations/:id — atualiza conversa (mensagens + título)
router.put('/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  try {
    const { title, messages } = req.body;
    const result = await pool.query(
      'UPDATE conversations SET title = COALESCE($1, title), messages = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING id',
      [title ? title.slice(0, 250) : null, JSON.stringify(messages || []), req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Conversa nao encontrada' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

// DELETE /api/conversations/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  try {
    await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await pool.end();
  }
});

export default router;
