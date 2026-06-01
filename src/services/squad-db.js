// src/services/squad-db.js — Banco de dados do Squad Agentes SF
import pool from '../config/db.js';

export async function ensureSquadSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS squad_cards (
      id           SERIAL PRIMARY KEY,
      title        VARCHAR(500)  NOT NULL,
      description  TEXT          DEFAULT '',
      stage        VARCHAR(30)   DEFAULT 'analise',
      mode         VARCHAR(10)   DEFAULT 'manual',
      priority     VARCHAR(10)   DEFAULT 'medium',
      assignee     VARCHAR(100)  DEFAULT '',
      created_by   VARCHAR(100)  DEFAULT '',
      created_at   TIMESTAMPTZ   DEFAULT NOW(),
      updated_at   TIMESTAMPTZ   DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS squad_artifacts (
      id           SERIAL PRIMARY KEY,
      card_id      INTEGER       NOT NULL REFERENCES squad_cards(id) ON DELETE CASCADE,
      stage        VARCHAR(30)   NOT NULL,
      artifact_type VARCHAR(20)  NOT NULL,
      content      TEXT          DEFAULT '',
      file_name    VARCHAR(255)  DEFAULT '',
      file_path    VARCHAR(500)  DEFAULT '',
      tokens_in    INTEGER       DEFAULT 0,
      tokens_out   INTEGER       DEFAULT 0,
      model_used   VARCHAR(100)  DEFAULT '',
      created_at   TIMESTAMPTZ   DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS squad_agent_runs (
      id           SERIAL PRIMARY KEY,
      card_id      INTEGER       NOT NULL REFERENCES squad_cards(id) ON DELETE CASCADE,
      stage        VARCHAR(30)   NOT NULL,
      status       VARCHAR(20)   DEFAULT 'pending',
      model_used   VARCHAR(100)  DEFAULT '',
      tokens_in    INTEGER       DEFAULT 0,
      tokens_out   INTEGER       DEFAULT 0,
      error_msg    TEXT          DEFAULT '',
      started_at   TIMESTAMPTZ   DEFAULT NOW(),
      finished_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_squad_artifacts_card ON squad_artifacts(card_id);
    CREATE INDEX IF NOT EXISTS idx_squad_runs_card ON squad_agent_runs(card_id);
    CREATE TABLE IF NOT EXISTS squad_attachments (
      id              SERIAL PRIMARY KEY,
      card_id         INTEGER       NOT NULL REFERENCES squad_cards(id) ON DELETE CASCADE,
      file_name       VARCHAR(255)  NOT NULL,
      file_type       VARCHAR(20)   DEFAULT '',
      extracted_text  TEXT          DEFAULT '',
      file_size       INTEGER       DEFAULT 0,
      created_at      TIMESTAMPTZ   DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_squad_attachments_card ON squad_attachments(card_id);
  `);
}

// ── STAGES (ordem fixa da esteira) ──
export const STAGES = [
  { key: 'analise',      label: 'ANÁLISE REQUISITO',     color: '#94a3b8', hasAgent: false },
  { key: 'hf',           label: 'HISTÓRIA FUNCIONAL',    color: '#22c55e', hasAgent: true  },
  { key: 'spec',         label: 'ESPECIFICAÇÃO TÉCNICA', color: '#8b5cf6', hasAgent: true  },
  { key: 'dev',          label: 'DESENVOLVIMENTO',       color: '#3b82f6', hasAgent: true  },
  { key: 'refinamento',  label: 'REFINAMENTO TÉCNICO',   color: '#f97316', hasAgent: true  },
  { key: 'done',         label: 'CONCLUÍDO',             color: '#15803d', hasAgent: false },
];

// ── Cards CRUD ──
export async function getCards() {
  await ensureSquadSchema();
  const r = await pool.query(`
    SELECT c.*,
      COALESCE(a.cnt, 0)::int AS artifact_count,
      COALESCE(a.last_type, '') AS last_artifact_type
    FROM squad_cards c
    LEFT JOIN (
      SELECT card_id, COUNT(*) AS cnt, MAX(artifact_type) AS last_type
      FROM squad_artifacts GROUP BY card_id
    ) a ON a.card_id = c.id
    ORDER BY c.updated_at DESC
  `);
  return r.rows;
}

export async function getCard(id) {
  await ensureSquadSchema();
  const r = await pool.query('SELECT * FROM squad_cards WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function createCard(data) {
  await ensureSquadSchema();
  const { title, description = '', mode = 'manual', priority = 'medium', assignee = '', created_by = '' } = data;
  const r = await pool.query(
    `INSERT INTO squad_cards (title, description, stage, mode, priority, assignee, created_by)
     VALUES ($1, $2, 'analise', $3, $4, $5, $6) RETURNING *`,
    [title, description, mode, priority, assignee, created_by]
  );
  return r.rows[0];
}

export async function updateCard(id, fields) {
  await ensureSquadSchema();
  const allowed = ['title', 'description', 'stage', 'mode', 'priority', 'assignee'];
  const sets = []; const vals = [];
  Object.entries(fields).forEach(([k, v]) => {
    if (allowed.includes(k)) { sets.push(`${k} = $${sets.length + 1}`); vals.push(v); }
  });
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  vals.push(id);
  const r = await pool.query(
    `UPDATE squad_cards SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
  );
  return r.rows[0];
}

export async function moveCard(id, targetStage) {
  await ensureSquadSchema();
  const valid = STAGES.map(s => s.key);
  if (!valid.includes(targetStage)) throw new Error(`Stage inválido: ${targetStage}`);
  const r = await pool.query(
    `UPDATE squad_cards SET stage = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [targetStage, id]
  );
  return r.rows[0];
}

export async function deleteCard(id) {
  await ensureSquadSchema();
  // Cascata via FK ON DELETE CASCADE cuida de artifacts e runs
  await pool.query('DELETE FROM squad_cards WHERE id = $1', [id]);
}

// ── Artifacts ──
export async function getArtifacts(cardId) {
  await ensureSquadSchema();
  const r = await pool.query(
    'SELECT * FROM squad_artifacts WHERE card_id = $1 ORDER BY created_at DESC', [cardId]
  );
  return r.rows;
}

export async function createArtifact(data) {
  await ensureSquadSchema();
  const { card_id, stage, artifact_type, content = '', file_name = '', file_path = '', tokens_in = 0, tokens_out = 0, model_used = '' } = data;
  const r = await pool.query(
    `INSERT INTO squad_artifacts (card_id, stage, artifact_type, content, file_name, file_path, tokens_in, tokens_out, model_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [card_id, stage, artifact_type, content, file_name, file_path, tokens_in, tokens_out, model_used]
  );
  return r.rows[0];
}

// ── Agent Runs ──
export async function getAgentRuns(cardId) {
  await ensureSquadSchema();
  const r = await pool.query(
    'SELECT * FROM squad_agent_runs WHERE card_id = $1 ORDER BY started_at DESC', [cardId]
  );
  return r.rows;
}

export async function createAgentRun(data) {
  await ensureSquadSchema();
  const { card_id, stage, model_used = '' } = data;
  const r = await pool.query(
    `INSERT INTO squad_agent_runs (card_id, stage, status, model_used)
     VALUES ($1,$2,'running',$3) RETURNING *`,
    [card_id, stage, model_used]
  );
  return r.rows[0];
}

export async function finishAgentRun(id, { status, tokens_in = 0, tokens_out = 0, error_msg = '' }) {
  const r = await pool.query(
    `UPDATE squad_agent_runs SET status=$1, tokens_in=$2, tokens_out=$3, error_msg=$4, finished_at=NOW()
     WHERE id=$5 RETURNING *`,
    [status, tokens_in, tokens_out, error_msg, id]
  );
  return r.rows[0];
}

// ── Stats ──
export async function getStats() {
  await ensureSquadSchema();
  const r = await pool.query(`
    SELECT stage, COUNT(*)::int AS count FROM squad_cards GROUP BY stage
  `);
  const total = await pool.query('SELECT COUNT(*)::int AS total FROM squad_cards');
  const artifacts = await pool.query('SELECT COUNT(*)::int AS total FROM squad_artifacts');
  return {
    by_stage: r.rows,
    total_cards: total.rows[0]?.total || 0,
    total_artifacts: artifacts.rows[0]?.total || 0,
  };
}

// ── Attachments ──
export async function getAttachments(cardId) {
  await ensureSquadSchema();
  const r = await pool.query(
    'SELECT id, card_id, file_name, file_type, file_size, length(extracted_text) as text_length, created_at FROM squad_attachments WHERE card_id = $1 ORDER BY created_at',
    [cardId]
  );
  return r.rows;
}

export async function getAttachmentFull(id) {
  await ensureSquadSchema();
  const r = await pool.query('SELECT * FROM squad_attachments WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function addAttachment({ card_id, file_name, file_type, extracted_text, file_size }) {
  await ensureSquadSchema();
  const r = await pool.query(
    `INSERT INTO squad_attachments (card_id, file_name, file_type, extracted_text, file_size)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, card_id, file_name, file_type, file_size, created_at`,
    [card_id, file_name, file_type || '', extracted_text || '', file_size || 0]
  );
  return r.rows[0];
}

export async function deleteAttachment(id) {
  await ensureSquadSchema();
  await pool.query('DELETE FROM squad_attachments WHERE id = $1', [id]);
}

export async function deleteAllAttachments(cardId) {
  await ensureSquadSchema();
  await pool.query('DELETE FROM squad_attachments WHERE card_id = $1', [cardId]);
}

// Retorna todo o texto combinado (description + attachments) para input do agente
export async function getFullCardInput(cardId) {
  await ensureSquadSchema();
  const card = await getCard(cardId);
  if (!card) return '';
  const attachments = await pool.query(
    'SELECT file_name, extracted_text FROM squad_attachments WHERE card_id = $1 ORDER BY created_at',
    [cardId]
  );
  let parts = [];
  if (card.description?.trim()) parts.push(card.description.trim());
  for (const att of attachments.rows) {
    if (att.extracted_text?.trim()) {
      parts.push(`\n--- ARQUIVO ANEXO: ${att.file_name} ---\n${att.extracted_text.trim()}\n--- FIM ARQUIVO ---`);
    }
  }
  return parts.join('\n\n');
}
