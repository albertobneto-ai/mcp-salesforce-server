// src/setup.js — Endpoints de setup + admin do banco
import express from 'express';
import bcrypt from 'bcrypt';

const router = express.Router();

// GET /api/setup/status
router.get('/status', (req, res) => {
  res.json({
    DATABASE_URL: !!process.env.DATABASE_URL,
    ANTHROPIC_KEY: !!process.env.ANTHROPIC_KEY,
    JWT_SECRET: !!process.env.JWT_SECRET,
    GROK_KEY: !!process.env.GROK_KEY,
    GH_TOKEN: !!process.env.GH_TOKEN,
    SF_USERNAME: !!process.env.SF_USERNAME,
    all_ready: !!(process.env.DATABASE_URL && process.env.ANTHROPIC_KEY && process.env.JWT_SECRET),
  });
});

// GET /api/setup/init-db
router.get('/init-db', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'DATABASE_URL nao configurado' });
  }
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255), messages JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC)');

    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    let adminCreated = false;
    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('Nicework@2027', 10);
      await pool.query("INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)",
        ['Alberto Bottaro', 'admin@everi9.com', hash]);
      adminCreated = true;
    }
    await pool.end();
    res.json({ status: 'ok', tables_created: ['users', 'conversations'], admin_created: adminCreated, admin_email: 'admin@everi9.com' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════
// ADMIN — Gerenciamento do banco
// ════════════════════════════════════════════

// GET /api/setup/users — Lista todos os usuarios
router.get('/users', async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY id');
    await pool.end();
    res.json({ total: result.rows.length, users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/users — Cria novo usuario
router.post('/users', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password obrigatorios' });
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) { await pool.end(); return res.status(409).json({ error: 'Email ja cadastrado' }); }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [name, email, hash]);
    await pool.end();
    res.status(201).json({ status: 'created', user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/setup/users/:id — Remove usuario
router.delete('/users/:id', async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await pool.end();
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/users/:id/reset-password — Reset de senha
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password obrigatorio' });
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    await pool.end();
    res.json({ status: 'password_updated', id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setup/conversations — Lista conversas
router.get('/conversations', async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query(`
      SELECT c.id, c.title, c.created_at, c.updated_at, u.name as user_name, u.email
      FROM conversations c JOIN users u ON c.user_id = u.id
      ORDER BY c.updated_at DESC LIMIT 50
    `);
    await pool.end();
    res.json({ total: result.rows.length, conversations: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setup/stats — Estatisticas do banco
router.get('/stats', async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const users = await pool.query('SELECT COUNT(*) as total FROM users');
    const convs = await pool.query('SELECT COUNT(*) as total FROM conversations');
    const dbSize = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");
    await pool.end();
    res.json({
      users: parseInt(users.rows[0].total),
      conversations: parseInt(convs.rows[0].total),
      db_size: dbSize.rows[0].size,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
