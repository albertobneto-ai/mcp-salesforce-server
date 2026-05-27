// src/setup.js — Endpoint de setup (executa uma vez)
import express from 'express';
import bcrypt from 'bcrypt';

const router = express.Router();

// GET /api/setup/status — verifica o que falta configurar
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

// GET /api/setup/init-db — cria tabelas no Postgres
router.get('/init-db', async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'DATABASE_URL nao configurado. Adicione Heroku Postgres primeiro.' });
  }
  try {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        name          VARCHAR(100) NOT NULL,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         SERIAL PRIMARY KEY,
        user_id    INT REFERENCES users(id) ON DELETE CASCADE,
        title      VARCHAR(255),
        messages   JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC)');

    // Verificar se admin ja existe
    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    let adminCreated = false;

    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('Nicework@2027', 10);
      await pool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)",
        ['Alberto Bottaro', 'admin@everi9.com', hash]
      );
      adminCreated = true;
    }

    await pool.end();
    res.json({
      status: 'ok',
      tables_created: ['users', 'conversations'],
      admin_created: adminCreated,
      admin_email: 'admin@everi9.com',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
