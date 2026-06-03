// src/services/refinement-db.js — Banco de dados Agenda de Refinamento
import pool from '../config/db.js';

export async function ensureRefinementSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_refinements (
      id SERIAL PRIMARY KEY,
      ref_code VARCHAR(20) NOT NULL,
      module VARCHAR(100) NOT NULL,
      epic VARCHAR(500) NOT NULL,
      stories TEXT DEFAULT '',
      objective TEXT DEFAULT '',
      participants TEXT DEFAULT '[]',
      resp VARCHAR(100) DEFAULT '',
      session_date DATE NOT NULL,
      session_time VARCHAR(10) DEFAULT '15:30',
      us_write_deadline DATE,
      us_approve_deadline DATE,
      et_write_deadline DATE,
      et_approve_deadline DATE,
      status VARCHAR(20) DEFAULT 'pending',
      hf_status VARCHAR(20) DEFAULT 'none',
      hf_file VARCHAR(500) DEFAULT '',
      hf_notes TEXT DEFAULT '',
      et_status VARCHAR(20) DEFAULT 'none',
      et_file VARCHAR(500) DEFAULT '',
      et_notes TEXT DEFAULT '',
      ref_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

export async function getRefinements() {
  await ensureRefinementSchema();
  const r = await pool.query(`SELECT * FROM gp_refinements ORDER BY session_date, session_time, id`);
  return r.rows.map(row => ({
    ...row,
    participants: safeJsonParse(row.participants, [])
  }));
}

export async function createRefinement(data) {
  await ensureRefinementSchema();
  const {
    ref_code, module, epic, stories = '', objective = '',
    participants = [], resp = '', session_date, session_time = '15:30',
    us_write_deadline = null, us_approve_deadline = null,
    et_write_deadline = null, et_approve_deadline = null,
    status = 'pending', ref_order = 0
  } = data;
  const r = await pool.query(
    `INSERT INTO gp_refinements
     (ref_code, module, epic, stories, objective, participants, resp,
      session_date, session_time, us_write_deadline, us_approve_deadline,
      et_write_deadline, et_approve_deadline, status, ref_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [ref_code, module, epic, stories, objective,
     JSON.stringify(participants), resp,
     session_date, session_time,
     us_write_deadline, us_approve_deadline,
     et_write_deadline, et_approve_deadline,
     status, ref_order]
  );
  return r.rows[0];
}

export async function updateRefinement(id, fields) {
  await ensureRefinementSchema();
  const allowed = [
    'ref_code','module','epic','stories','objective','participants','resp',
    'session_date','session_time',
    'us_write_deadline','us_approve_deadline','et_write_deadline','et_approve_deadline',
    'status','hf_status','hf_file','hf_notes','et_status','et_file','et_notes','ref_order'
  ];
  const sets = []; const vals = [];
  Object.entries(fields).forEach(([k, v]) => {
    if (allowed.includes(k)) {
      sets.push(`${k} = $${sets.length + 1}`);
      vals.push(k === 'participants' && Array.isArray(v) ? JSON.stringify(v) : v);
    }
  });
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const r = await pool.query(
    `UPDATE gp_refinements SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  return r.rows[0];
}

export async function deleteRefinement(id) {
  await ensureRefinementSchema();
  await pool.query(`DELETE FROM gp_refinements WHERE id = $1`, [id]);
}

export async function seedRefinements(items) {
  await ensureRefinementSchema();
  // Clear existing
  await pool.query(`DELETE FROM gp_refinements`);
  for (const item of items) {
    await createRefinement(item);
  }
  return items.length;
}

export async function getRefinementStats() {
  await ensureRefinementSchema();
  const r = await pool.query(`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE status = 'done')::int as done,
      COUNT(*) FILTER (WHERE status = 'scheduled')::int as scheduled,
      COUNT(*) FILTER (WHERE hf_status = 'approved')::int as hf_approved,
      COUNT(*) FILTER (WHERE et_status = 'approved')::int as et_approved,
      COUNT(*) FILTER (WHERE hf_status IN ('writing','review'))::int as hf_in_progress,
      COUNT(*) FILTER (WHERE et_status IN ('writing','review'))::int as et_in_progress
    FROM gp_refinements
  `);
  return r.rows[0];
}

function safeJsonParse(val, fallback) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
