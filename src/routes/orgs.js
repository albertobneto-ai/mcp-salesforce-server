// src/routes/orgs.js — CRUD de orgs + seletor
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

// GET /api/orgs — Lista orgs do usuario (admin ve todas)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query('SELECT id, name, login_url, username, org_type, created_at FROM orgs ORDER BY name');
    } else {
      result = await pool.query('SELECT id, name, login_url, username, org_type, created_at FROM orgs ORDER BY name');
    }
    res.json({ orgs: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orgs — Adicionar org (admin only)
router.post('/', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });
  try {
    const { name, login_url, username, password, security_token, org_type } = req.body;
    if (!name || !login_url || !username || !password) {
      return res.status(400).json({ error: 'name, login_url, username, password obrigatorios' });
    }

    // Testar conexão antes de salvar
    const test = await testConnection({ login_url, username, password, security_token });
    if (test.status !== 'connected') {
      return res.status(400).json({ error: 'Falha na conexao: ' + test.message });
    }

    const result = await pool.query(
      'INSERT INTO orgs (name, login_url, username, password, security_token, org_type, org_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, login_url, username, org_type',
      [name, login_url, username, password, security_token || '', org_type || 'sandbox', test.orgId]
    );
    res.status(201).json({ status: 'created', org: result.rows[0], connection: test });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/:id — Remover org (admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });
  try {
    await pool.query('DELETE FROM orgs WHERE id = $1', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/test — Testar conexão
router.get('/:id/test', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orgs WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Org nao encontrada' });
    const org = result.rows[0];
    const test = await testConnection(org);
    res.json(test);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
