// Triagem de Bugs Partner - persistencia server-side (Postgres)
// Modulo isolado: cria sua propria tabela, nao toca em nada existente.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function ensureTriagemTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS triagem_state (
      bug_key    TEXT PRIMARY KEY,
      status     TEXT DEFAULT 'aberto',
      anotacoes  TEXT DEFAULT '',
      evidencias TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureTriagemTable().catch(e => console.log('[triagem] init:', e.message));

export function registerTriagemRoutes(app) {
  // Carrega todos os estados de uma vez -> { bug_key: {status, anotacoes, evidencias, updated_at} }
  app.get('/api/triagem', async (req, res) => {
    try {
      await ensureTriagemTable();
      const r = await pool.query('SELECT bug_key, status, anotacoes, evidencias, updated_at FROM triagem_state');
      const out = {};
      for (const row of r.rows) {
        out[row.bug_key] = {
          status: row.status,
          anotacoes: row.anotacoes || '',
          evidencias: row.evidencias || '',
          updated_at: row.updated_at
        };
      }
      res.json({ ok: true, data: out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Salva/atualiza um bug (upsert)
  app.post('/api/triagem/:key', async (req, res) => {
    try {
      await ensureTriagemTable();
      const key = req.params.key;
      const { status = 'aberto', anotacoes = '', evidencias = '' } = req.body || {};
      await pool.query(
        `INSERT INTO triagem_state (bug_key, status, anotacoes, evidencias, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (bug_key) DO UPDATE
           SET status=$2, anotacoes=$3, evidencias=$4, updated_at=NOW()`,
        [key, status, anotacoes, evidencias]
      );
      res.json({ ok: true, bug_key: key, updated_at: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('[triagem] Mounted at /api/triagem');
}
