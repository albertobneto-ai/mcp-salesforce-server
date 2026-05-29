// src/services/kb-db.js — Base de Conhecimento (RAG via full-text search nativo do Postgres)
// Zero custo de IA na busca. Zero contato com org. Apenas Postgres.
import pool from '../config/db.js';

export async function ensureKbSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT DEFAULT 'upload',
      command_scope TEXT DEFAULT 'all',
      chunk_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      document_id INT REFERENCES kb_documents(id) ON DELETE CASCADE,
      chunk_index INT,
      content TEXT NOT NULL,
      tsv tsvector,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx ON kb_chunks USING GIN(tsv)`);
}

// Fatia o texto em pedaços de ~2000 chars (~500 tokens) com sobreposicao leve
function chunkText(text, maxChars = 2000, overlap = 200) {
  const clean = (text || '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + maxChars, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const brk = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
      if (brk > maxChars * 0.5) end = i + brk + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(c => c.length > 20);
}

export async function addDocument(title, text, sourceType = 'upload', commandScope = 'all') {
  await ensureKbSchema();
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('Documento sem texto utilizavel');
  const doc = await pool.query(
    `INSERT INTO kb_documents (title, source_type, command_scope, chunk_count) VALUES ($1,$2,$3,$4) RETURNING id`,
    [title, sourceType, commandScope, chunks.length]
  );
  const docId = doc.rows[0].id;
  for (let idx = 0; idx < chunks.length; idx++) {
    await pool.query(
      `INSERT INTO kb_chunks (document_id, chunk_index, content, tsv)
       VALUES ($1,$2,$3, to_tsvector('portuguese', $3))`,
      [docId, idx, chunks[idx]]
    );
  }
  return { id: docId, chunks: chunks.length };
}

export async function listDocuments() {
  await ensureKbSchema();
  const r = await pool.query(
    `SELECT id, title, source_type, command_scope, chunk_count, created_at
     FROM kb_documents ORDER BY created_at DESC`
  );
  return r.rows;
}

export async function deleteDocument(id) {
  await ensureKbSchema();
  await pool.query(`DELETE FROM kb_documents WHERE id = $1`, [id]); // cascade apaga chunks
}

// Busca full-text: top N chunks mais relevantes. commandScope filtra docs por escopo (ex: 'hf').
export async function searchChunks(query, limit = 6, commandScope = null) {
  await ensureKbSchema();
  if (!query || !query.trim()) return [];
  const params = [query, limit];
  let scopeClause = '';
  if (commandScope) {
    scopeClause = `AND (d.command_scope = 'all' OR d.command_scope = $3)`;
    params.push(commandScope);
  }
  try {
    const r = await pool.query(
      `SELECT c.content, d.title, ts_rank(c.tsv, plainto_tsquery('portuguese', $1)) AS rank
       FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
       WHERE c.tsv @@ plainto_tsquery('portuguese', $1) ${scopeClause}
       ORDER BY rank DESC LIMIT $2`,
      params
    );
    return r.rows;
  } catch (err) {
    console.error('searchChunks failed:', err.message);
    return [];
  }
}
