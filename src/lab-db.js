import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function ensureLabTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_items (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('prototipos','apresentacoes','documentacoes')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      url TEXT DEFAULT '',
      file_name TEXT DEFAULT '',
      file_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      file_content TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

ensureLabTables().catch(e => console.log('lab-db init:', e.message));

export async function listItems(category) {
  const q = category && category !== 'all'
    ? 'SELECT id, category, title, description, url, file_name, file_type, file_size, created_by, created_at FROM lab_items WHERE category=$1 ORDER BY created_at DESC'
    : 'SELECT id, category, title, description, url, file_name, file_type, file_size, created_by, created_at FROM lab_items ORDER BY created_at DESC';
  const params = category && category !== 'all' ? [category] : [];
  const r = await pool.query(q, params);
  return r.rows;
}

export async function createItem({ category, title, description, url, file_name, file_type, file_size, file_content, created_by }) {
  const r = await pool.query(
    `INSERT INTO lab_items (category, title, description, url, file_name, file_type, file_size, file_content, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [category, title, description||'', url||'', file_name||'', file_type||'', file_size||0, file_content||'', created_by||'']
  );
  return r.rows[0];
}

export async function deleteItem(id) {
  await pool.query('DELETE FROM lab_items WHERE id=$1', [id]);
}

export async function getItemContent(id) {
  const r = await pool.query('SELECT * FROM lab_items WHERE id=$1', [id]);
  return r.rows[0] || null;
}
