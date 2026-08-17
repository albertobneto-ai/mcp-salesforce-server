// Transcrições de reunião (Ever i9) — persistência server-side (Postgres)
// Módulo isolado: cria sua própria tabela, não toca em nada existente.
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcricoes (
      id          SERIAL PRIMARY KEY,
      titulo      TEXT DEFAULT '',
      idioma      TEXT DEFAULT 'pt-BR',
      iniciado_em TIMESTAMPTZ NOT NULL,
      duracao_s   INTEGER DEFAULT 0,
      palavras    INTEGER DEFAULT 0,
      texto       TEXT NOT NULL,
      traducao    TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE transcricoes ADD COLUMN IF NOT EXISTS traducao TEXT DEFAULT ''`);
}
ensureTable().catch(e => console.log('[transcricoes] init:', e.message));

export function registerTranscricoesRoutes(app) {
  // Lista (sem o texto completo) — mais recentes primeiro
  app.get('/api/transcricoes', async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query(
        `SELECT id, titulo, idioma, iniciado_em, duracao_s, palavras, LEFT(texto, 160) AS preview, (traducao<>'') AS tem_traducao, created_at
           FROM transcricoes ORDER BY iniciado_em DESC LIMIT 200`);
      res.json({ ok: true, data: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Detalhe (texto completo)
  app.get('/api/transcricoes/:id', async (req, res) => {
    try {
      await ensureTable();
      const r = await pool.query('SELECT * FROM transcricoes WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: 'não encontrada' });
      res.json({ ok: true, data: r.rows[0] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Salva nova transcrição
  app.post('/api/transcricoes', async (req, res) => {
    try {
      await ensureTable();
      const b = req.body || {};
      const texto = (b.texto || '').toString().trim();
      if (!texto) return res.status(400).json({ ok: false, error: 'texto vazio' });
      const iniciado = b.iniciado_em ? new Date(b.iniciado_em) : new Date();
      const r = await pool.query(
        `INSERT INTO transcricoes (titulo, idioma, iniciado_em, duracao_s, palavras, texto, traducao)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, iniciado_em, created_at`,
        [(b.titulo || '').toString().slice(0, 200), (b.idioma || 'pt-BR').toString().slice(0, 10),
         isNaN(iniciado) ? new Date() : iniciado, parseInt(b.duracao_s) || 0,
         parseInt(b.palavras) || texto.split(/\s+/).length, texto, (b.traducao || '').toString()]);
      res.json({ ok: true, ...r.rows[0] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Renomeia título
  app.patch('/api/transcricoes/:id', async (req, res) => {
    try {
      await ensureTable();
      const titulo = ((req.body || {}).titulo || '').toString().slice(0, 200);
      await pool.query('UPDATE transcricoes SET titulo=$1 WHERE id=$2', [titulo, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Exclui
  app.delete('/api/transcricoes/:id', async (req, res) => {
    try {
      await ensureTable();
      await pool.query('DELETE FROM transcricoes WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log('[transcricoes] Mounted at /api/transcricoes');
}
