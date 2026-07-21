// src/cofre-db.js — Cofre do Org Explorer com persistência em Postgres.
// Guarda documentações e arquivos .md do projeto. Base64 no banco (Heroku
// tem filesystem efêmero — arquivo em disco some a cada deploy).
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const MAX_FILE = 8 * 1024 * 1024; // 8 MB por arquivo (documentos/PDF/md)

async function ensureCofreTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cofre_files (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT DEFAULT 'application/octet-stream',
      size INTEGER DEFAULT 0,
      content TEXT NOT NULL,          -- data URL base64 (data:<mime>;base64,....)
      created_by TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureCofreTable().catch(e => console.log('[cofre-db] init:', e.message));

export function registerCofreRoutes(app) {
  // Lista (metadados apenas — nunca devolve o conteúdo aqui)
  app.get('/api/cofre/list', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, name, mime, size, created_by, created_at FROM cofre_files ORDER BY created_at DESC'
      );
      const totalBytes = r.rows.reduce((s, f) => s + (f.size || 0), 0);
      res.json({ files: r.rows, count: r.rows.length, totalBytes });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Upload — body: { name, mime, size, content(dataURL base64), created_by }
  app.post('/api/cofre/upload', async (req, res) => {
    try {
      const { name, mime, size, content, created_by } = req.body || {};
      if (!name || !content) return res.status(400).json({ error: 'name e content são obrigatórios' });
      const realSize = Number(size) || 0;
      if (realSize > MAX_FILE) return res.status(413).json({ error: 'Arquivo excede 8 MB' });
      const r = await pool.query(
        `INSERT INTO cofre_files (name, mime, size, content, created_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, mime, size, created_by, created_at`,
        [name, mime || 'application/octet-stream', realSize, content, created_by || '']
      );
      res.json({ ok: true, file: r.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download — devolve o conteúdo (dataURL) de um arquivo
  app.get('/api/cofre/file/:id', async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT id, name, mime, size, content, created_at FROM cofre_files WHERE id=$1',
        [req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Arquivo não encontrado' });
      res.json({ file: r.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete
  app.delete('/api/cofre/file/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM cofre_files WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('[cofre-db] Mounted at /api/cofre');
}
