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
  try { await pool.query(`SELECT 1 FROM gp_story_attachments LIMIT 0`); } catch { await ensureAttachmentsSchema(); }
  const q = workstream
    ? `SELECT s.*, COALESCE(ac.cnt,0)::int as attachment_count FROM gp_stories s LEFT JOIN (SELECT story_id, COUNT(*) as cnt FROM gp_story_attachments GROUP BY story_id) ac ON ac.story_id = s.id WHERE s.workstream = $1 ORDER BY s.epic, s.story_order, s.id`
    : `SELECT s.*, COALESCE(ac.cnt,0)::int as attachment_count FROM gp_stories s LEFT JOIN (SELECT story_id, COUNT(*) as cnt FROM gp_story_attachments GROUP BY story_id) ac ON ac.story_id = s.id ORDER BY s.workstream, s.epic, s.story_order, s.id`;
  const r = workstream ? await pool.query(q, [workstream]) : await pool.query(q);
  return r.rows;
}
export async function createStory(data) {
  await ensureGpSchema();
  const { workstream, epic, title, sprint = '', dev_assignee = '', story_points = 0, deadline = null, notes = '',
          rf_status = '', hf_status = '', spec_status = '', rt_status = '', plan_status = '' } = data;
  const r = await pool.query(
    `INSERT INTO gp_stories (workstream,epic,title,sprint,dev_assignee,story_points,deadline,notes,rf_status,hf_status,spec_status,rt_status,plan_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [workstream, epic, title, sprint, dev_assignee, story_points, deadline, notes, rf_status, hf_status, spec_status, rt_status, plan_status]
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

// ── Reuniões ──
export async function ensureMeetingsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_meetings (
      id           SERIAL PRIMARY KEY,
      type         VARCHAR(20) NOT NULL DEFAULT 'sync',
      title        VARCHAR(300) NOT NULL,
      meeting_date DATE,
      workstream   VARCHAR(50) DEFAULT '',
      participants TEXT DEFAULT '',
      transcription TEXT DEFAULT '',
      ata_content  TEXT DEFAULT '',
      created_by   VARCHAR(100) DEFAULT '',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gp_action_items (
      id          SERIAL PRIMARY KEY,
      meeting_id  INTEGER REFERENCES gp_meetings(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      assignee    VARCHAR(100) DEFAULT '',
      due_date    DATE,
      workstream  VARCHAR(50) DEFAULT '',
      story_id    INTEGER,
      status      VARCHAR(20) DEFAULT 'pending',
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
export async function getMeetings() {
  await ensureMeetingsSchema();
  const r = await pool.query(`SELECT m.*, COUNT(a.id) as action_count, COUNT(CASE WHEN a.status='done' THEN 1 END) as action_done FROM gp_meetings m LEFT JOIN gp_action_items a ON a.meeting_id = m.id GROUP BY m.id ORDER BY m.meeting_date DESC, m.created_at DESC`);
  return r.rows;
}
export async function getMeeting(id) {
  await ensureMeetingsSchema();
  const m = await pool.query(`SELECT * FROM gp_meetings WHERE id = $1`, [id]);
  const a = await pool.query(`SELECT * FROM gp_action_items WHERE meeting_id = $1 ORDER BY id`, [id]);
  return { meeting: m.rows[0], actions: a.rows };
}
export async function createMeeting(data) {
  await ensureMeetingsSchema();
  const { type='sync', title, meeting_date=null, workstream='', participants='', transcription='', created_by='' } = data;
  const r = await pool.query(`INSERT INTO gp_meetings (type,title,meeting_date,workstream,participants,transcription,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [type, title, meeting_date, workstream, participants, transcription, created_by]);
  return r.rows[0];
}
export async function updateMeeting(id, fields) {
  await ensureMeetingsSchema();
  const allowed = ['title','type','meeting_date','workstream','participants','transcription','ata_content'];
  const sets=[]; const vals=[];
  Object.entries(fields).forEach(([k,v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`); vals.push(id);
  const r = await pool.query(`UPDATE gp_meetings SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  return r.rows[0];
}
export async function deleteMeeting(id) {
  await ensureMeetingsSchema();
  await pool.query(`DELETE FROM gp_meetings WHERE id = $1`, [id]);
}
export async function saveActions(meetingId, actions) {
  await ensureMeetingsSchema();
  await pool.query(`DELETE FROM gp_action_items WHERE meeting_id = $1`, [meetingId]);
  for (const a of actions) {
    await pool.query(`INSERT INTO gp_action_items (meeting_id,description,assignee,due_date,workstream,status) VALUES ($1,$2,$3,$4,$5,'pending')`,
      [meetingId, a.descricao||a.description||'', a.responsavel||a.assignee||'', a.prazo||a.due_date||null, a.workstream||'']);
  }
}
export async function updateAction(id, fields) {
  await ensureMeetingsSchema();
  const allowed = ['status','assignee','due_date','workstream','story_id','notes','description'];
  const sets=[]; const vals=[];
  Object.entries(fields).forEach(([k,v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`); vals.push(id);
  const r = await pool.query(`UPDATE gp_action_items SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  return r.rows[0];
}
export async function getAllActions() {
  await ensureMeetingsSchema();
  const r = await pool.query(`SELECT a.*, m.title as meeting_title, m.meeting_date FROM gp_action_items a LEFT JOIN gp_meetings m ON m.id = a.meeting_id ORDER BY a.due_date NULLS LAST, a.id`);
  return r.rows;
}

// ── Story Attachments (Jira concept) ──
export async function ensureAttachmentsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_story_attachments (
      id          SERIAL PRIMARY KEY,
      story_id    INTEGER NOT NULL,
      stage       VARCHAR(20) NOT NULL,
      file_name   VARCHAR(300) NOT NULL,
      file_type   VARCHAR(100) DEFAULT '',
      file_size   INTEGER DEFAULT 0,
      content     TEXT DEFAULT '',
      link        VARCHAR(500) DEFAULT '',
      uploaded_by VARCHAR(100) DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gp_story_comments (
      id          SERIAL PRIMARY KEY,
      story_id    INTEGER NOT NULL,
      author      VARCHAR(100) DEFAULT '',
      content     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
export async function getAttachments(storyId) {
  await ensureAttachmentsSchema();
  const r = await pool.query(`SELECT id, story_id, stage, file_name, file_type, file_size, link, uploaded_by, created_at FROM gp_story_attachments WHERE story_id = $1 ORDER BY stage, created_at`, [storyId]);
  return r.rows;
}
export async function getAttachmentContent(id) {
  await ensureAttachmentsSchema();
  const r = await pool.query(`SELECT * FROM gp_story_attachments WHERE id = $1`, [id]);
  return r.rows[0];
}
export async function addAttachment(data) {
  await ensureAttachmentsSchema();
  const { story_id, stage, file_name, file_type='', file_size=0, content='', link='', uploaded_by='' } = data;
  const r = await pool.query(
    `INSERT INTO gp_story_attachments (story_id,stage,file_name,file_type,file_size,content,link,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,story_id,stage,file_name,file_type,file_size,link,uploaded_by,created_at`,
    [story_id, stage, file_name, file_type, file_size, content, link, uploaded_by]
  );
  return r.rows[0];
}
export async function deleteAttachment(id) {
  await ensureAttachmentsSchema();
  await pool.query(`DELETE FROM gp_story_attachments WHERE id = $1`, [id]);
}
export async function getComments(storyId) {
  await ensureAttachmentsSchema();
  const r = await pool.query(`SELECT * FROM gp_story_comments WHERE story_id = $1 ORDER BY created_at`, [storyId]);
  return r.rows;
}
export async function addComment(storyId, author, content) {
  await ensureAttachmentsSchema();
  const r = await pool.query(`INSERT INTO gp_story_comments (story_id,author,content) VALUES ($1,$2,$3) RETURNING *`, [storyId, author, content]);
  return r.rows[0];
}

// ── Story Tasks (sub-tarefas / checklist Jira) ──
export async function ensureTasksSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_story_tasks (
      id         SERIAL PRIMARY KEY,
      story_id   INTEGER NOT NULL,
      title      VARCHAR(300) NOT NULL,
      assignee   VARCHAR(100) DEFAULT '',
      status     VARCHAR(20) DEFAULT 'todo',
      task_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
export async function getTasks(storyId) {
  await ensureTasksSchema();
  return (await pool.query(`SELECT * FROM gp_story_tasks WHERE story_id = $1 ORDER BY task_order, id`, [storyId])).rows;
}
export async function getTaskCounts() {
  await ensureTasksSchema();
  return (await pool.query(`SELECT story_id, COUNT(*) as total, COUNT(CASE WHEN status='done' THEN 1 END) as done FROM gp_story_tasks GROUP BY story_id`)).rows;
}
export async function createTask(storyId, title, assignee) {
  await ensureTasksSchema();
  return (await pool.query(`INSERT INTO gp_story_tasks (story_id,title,assignee) VALUES ($1,$2,$3) RETURNING *`, [storyId, title, assignee||''])).rows[0];
}
export async function updateTask(id, fields) {
  await ensureTasksSchema();
  const allowed = ['title','assignee','status','task_order'];
  const sets=[]; const vals=[];
  Object.entries(fields).forEach(([k,v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  vals.push(id);
  return (await pool.query(`UPDATE gp_story_tasks SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
}
export async function deleteTask(id) {
  await ensureTasksSchema();
  await pool.query(`DELETE FROM gp_story_tasks WHERE id = $1`, [id]);
}
