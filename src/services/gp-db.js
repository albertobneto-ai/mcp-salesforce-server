// src/services/gp-db.js — Banco de dados do Painel GP
import pool from '../config/db.js';

export async function ensureGpSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_stories (
      id SERIAL PRIMARY KEY,
      workstream   VARCHAR(50)  NOT NULL,
      epic         VARCHAR(200) NOT NULL,
      title        VARCHAR(500) NOT NULL,
      rf_status    VARCHAR(20)  DEFAULT '',
      hf_status    VARCHAR(20)  DEFAULT '',
      spec_status  VARCHAR(20)  DEFAULT '',
      rt_status    VARCHAR(20)  DEFAULT '',
      plan_status  VARCHAR(20)  DEFAULT '',
      sprint       VARCHAR(20)  DEFAULT '',
      dev_assignee VARCHAR(100) DEFAULT '',
      story_points INTEGER      DEFAULT 0,
      deadline     DATE,
      notes        TEXT         DEFAULT '',
      story_order  INTEGER      DEFAULT 0,
      created_at   TIMESTAMPTZ  DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gp_cadences (
      id           SERIAL PRIMARY KEY,
      type         VARCHAR(20)  NOT NULL,
      title        VARCHAR(200) NOT NULL,
      frequency    VARCHAR(50)  DEFAULT 'weekly',
      weekday      VARCHAR(20)  DEFAULT '',
      time_of_day  VARCHAR(10)  DEFAULT '09:00',
      duration_min INTEGER      DEFAULT 60,
      participants TEXT         DEFAULT '',
      description  TEXT         DEFAULT '',
      objectives   TEXT         DEFAULT '',
      next_date    DATE,
      active       BOOLEAN      DEFAULT TRUE,
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gp_sprints (
      id         SERIAL PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      start_date DATE NOT NULL,
      end_date   DATE NOT NULL,
      goal       TEXT DEFAULT '',
      status     VARCHAR(20) DEFAULT 'planned',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ── Stories ──
export async function getStories(workstream) {
  await ensureGpSchema();
  const q = workstream
    ? `SELECT * FROM gp_stories WHERE workstream = $1 ORDER BY epic, story_order, id`
    : `SELECT * FROM gp_stories ORDER BY workstream, epic, story_order, id`;
  const r = workstream ? await pool.query(q, [workstream]) : await pool.query(q);
  return r.rows;
}
export async function createStory(data) {
  await ensureGpSchema();
  const { workstream, epic, title, sprint = '', dev_assignee = '', story_points = 0, deadline = null, notes = '' } = data;
  const r = await pool.query(
    `INSERT INTO gp_stories (workstream,epic,title,sprint,dev_assignee,story_points,deadline,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [workstream, epic, title, sprint, dev_assignee, story_points, deadline, notes]
  );
  return r.rows[0];
}
export async function updateStory(id, fields) {
  await ensureGpSchema();
  const allowed = ['rf_status','hf_status','spec_status','rt_status','plan_status','sprint','dev_assignee','story_points','deadline','notes','epic','title'];
  const sets = []; const vals = [];
  Object.entries(fields).forEach(([k, v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  const r = await pool.query(`UPDATE gp_stories SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  return r.rows[0];
}
export async function deleteStory(id) {
  await ensureGpSchema();
  await pool.query(`DELETE FROM gp_stories WHERE id = $1`, [id]);
}

// ── Cadences ──
export async function getCadences() {
  await ensureGpSchema();
  const r = await pool.query(`SELECT * FROM gp_cadences WHERE active = TRUE ORDER BY type, id`);
  return r.rows;
}
export async function createCadence(data) {
  await ensureGpSchema();
  const { type, title, frequency, weekday = '', time_of_day = '09:00', duration_min = 60, participants = '', description = '', objectives = '', next_date = null } = data;
  const r = await pool.query(
    `INSERT INTO gp_cadences (type,title,frequency,weekday,time_of_day,duration_min,participants,description,objectives,next_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [type, title, frequency, weekday, time_of_day, duration_min, participants, description, objectives, next_date]
  );
  return r.rows[0];
}
export async function updateCadence(id, fields) {
  await ensureGpSchema();
  const allowed = ['title','frequency','weekday','time_of_day','duration_min','participants','description','objectives','next_date','active'];
  const sets = []; const vals = [];
  Object.entries(fields).forEach(([k, v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  vals.push(id);
  const r = await pool.query(`UPDATE gp_cadences SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  return r.rows[0];
}
export async function deleteCadence(id) {
  await ensureGpSchema();
  await pool.query(`UPDATE gp_cadences SET active = FALSE WHERE id = $1`, [id]);
}

// ── Sprints ──
export async function getSprints() {
  await ensureGpSchema();
  const r = await pool.query(`SELECT * FROM gp_sprints ORDER BY start_date`);
  return r.rows;
}
export async function createSprint(data) {
  await ensureGpSchema();
  const { name, start_date, end_date, goal = '' } = data;
  const r = await pool.query(
    `INSERT INTO gp_sprints (name,start_date,end_date,goal) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, start_date, end_date, goal]
  );
  return r.rows[0];
}

// ── Relatório ──
export async function getReportData() {
  await ensureGpSchema();
  const stories = (await pool.query(`SELECT * FROM gp_stories ORDER BY workstream, epic, story_order, id`)).rows;
  const cadences = (await pool.query(`SELECT * FROM gp_cadences WHERE active = TRUE ORDER BY type`)).rows;
  const sprints = (await pool.query(`SELECT * FROM gp_sprints ORDER BY start_date`)).rows;
  return { stories, cadences, sprints };
}
