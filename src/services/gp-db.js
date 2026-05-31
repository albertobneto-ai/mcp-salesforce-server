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

// ── Task Detail (comentários + % manual + notificações) ──
export async function ensureTaskDetailSchema() {
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE gp_story_tasks ADD COLUMN IF NOT EXISTS percentage INTEGER DEFAULT 0;
      ALTER TABLE gp_story_tasks ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    EXCEPTION WHEN others THEN NULL;
    END $$;
    CREATE TABLE IF NOT EXISTS gp_task_comments (
      id         SERIAL PRIMARY KEY,
      task_id    INTEGER NOT NULL,
      author     VARCHAR(100) DEFAULT '',
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gp_notifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      user_email VARCHAR(200) DEFAULT '',
      user_name  VARCHAR(200) DEFAULT '',
      type       VARCHAR(50) DEFAULT 'task_assigned',
      title      VARCHAR(300) NOT NULL,
      body       TEXT DEFAULT '',
      ref_type   VARCHAR(50) DEFAULT '',
      ref_id     INTEGER,
      story_id   INTEGER,
      is_read    BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
export async function getTaskDetail(taskId) {
  await ensureTaskDetailSchema();
  const task = (await pool.query(`SELECT t.*, s.title as story_title, s.workstream, s.epic FROM gp_story_tasks t LEFT JOIN gp_stories s ON s.id = t.story_id WHERE t.id = $1`, [taskId])).rows[0];
  const comments = (await pool.query(`SELECT * FROM gp_task_comments WHERE task_id = $1 ORDER BY created_at`, [taskId])).rows;
  return { task, comments };
}
export async function addTaskComment(taskId, author, content) {
  await ensureTaskDetailSchema();
  return (await pool.query(`INSERT INTO gp_task_comments (task_id,author,content) VALUES ($1,$2,$3) RETURNING *`, [taskId, author, content])).rows[0];
}
export async function updateTaskPercentage(taskId, percentage) {
  await ensureTaskDetailSchema();
  return (await pool.query(`UPDATE gp_story_tasks SET percentage = $1 WHERE id = $2 RETURNING *`, [percentage, taskId])).rows[0];
}
export async function createNotification(data) {
  await ensureTaskDetailSchema();
  const { user_id=null, user_email='', user_name='', type='task_assigned', title, body='', ref_type='', ref_id=null, story_id=null } = data;
  return (await pool.query(`INSERT INTO gp_notifications (user_id,user_email,user_name,type,title,body,ref_type,ref_id,story_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [user_id, user_email, user_name, type, title, body, ref_type, ref_id, story_id])).rows[0];
}
export async function getNotifications(userEmail, userName, userId) {
  await ensureTaskDetailSchema();
  const r = await pool.query(`SELECT * FROM gp_notifications WHERE user_id = $3 OR user_email = $1 OR user_name = $2 ORDER BY created_at DESC LIMIT 30`, [userEmail||'', userName||'', userId||0]);
  return r.rows;
}
export async function getUnreadCount(userEmail, userName, userId) {
  await ensureTaskDetailSchema();
  const r = await pool.query(`SELECT COUNT(*) as cnt FROM gp_notifications WHERE (user_id = $3 OR user_email = $1 OR user_name = $2) AND is_read = FALSE`, [userEmail||'', userName||'', userId||0]);
  return Number(r.rows[0]?.cnt || 0);
}
export async function markRead(notifId) {
  await ensureTaskDetailSchema();
  await pool.query(`UPDATE gp_notifications SET is_read = TRUE WHERE id = $1`, [notifId]);
}
export async function markAllRead(userEmail, userName, userId) {
  await ensureTaskDetailSchema();
  await pool.query(`UPDATE gp_notifications SET is_read = TRUE WHERE user_id = $3 OR user_email = $1 OR user_name = $2`, [userEmail||'', userName||'', userId||0]);
}

// ── Planning per activity (sprint individual por atividade) ──
export async function ensurePlanningCols() {
  const cols = ['rf_sprint','hf_sprint','spec_sprint','rt_sprint','plan_sprint'];
  for (const c of cols) {
    try { await pool.query(`ALTER TABLE gp_stories ADD COLUMN IF NOT EXISTS ${c} VARCHAR(20) DEFAULT ''`); } catch {}
  }
}
export async function setPlanningCell(storyId, activity, sprint) {
  await ensurePlanningCols();
  const col = activity + '_sprint'; // rf_sprint, hf_sprint, etc.
  const allowed = ['rf_sprint','hf_sprint','spec_sprint','rt_sprint','plan_sprint'];
  if (!allowed.includes(col)) return null;
  // Toggle: se já está nessa sprint, limpa; senão, seta
  const cur = (await pool.query(`SELECT ${col} FROM gp_stories WHERE id = $1`, [storyId])).rows[0]?.[col];
  const newVal = cur === sprint ? '' : sprint;
  await pool.query(`UPDATE gp_stories SET ${col} = $1, updated_at = NOW() WHERE id = $2`, [newVal, storyId]);
  return newVal;
}

// ── Workstreams dinâmicos ──
export async function ensureWsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gp_workstreams (
      id       SERIAL PRIMARY KEY,
      ws_key   VARCHAR(20) NOT NULL UNIQUE,
      name     VARCHAR(200) NOT NULL,
      abbr     VARCHAR(4) NOT NULL,
      color    VARCHAR(10) DEFAULT '#6366f1',
      ws_order INTEGER DEFAULT 0,
      active   BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Seed se vazio
  const cnt = (await pool.query(`SELECT COUNT(*) as c FROM gp_workstreams`)).rows[0].c;
  if (Number(cnt) === 0) {
    const seeds = [
      ['ws1','Lead','LD','#6366f1',1],['ws2','Oportunidade','OP','#0ea5e9',2],['ws3','Cotação','CT','#10b981',3],
      ['ws4','Contas e Contatos','CC','#f59e0b',4],['ws5','Governança','GV','#8b5cf6',5],
      ['ws6','Migração de Dados','MD','#ec4899',6],['ws7','Catálogo','CA','#14b8a6',7]
    ];
    for (const [k,n,a,c,o] of seeds) {
      await pool.query(`INSERT INTO gp_workstreams (ws_key,name,abbr,color,ws_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [k,n,a,c,o]);
    }
  }
}
export async function getWorkstreams() {
  await ensureWsSchema();
  return (await pool.query(`SELECT * FROM gp_workstreams WHERE active = TRUE ORDER BY ws_order, id`)).rows;
}
export async function createWorkstream(data) {
  await ensureWsSchema();
  const { name, abbr, color = '#6366f1' } = data;
  const maxOrder = (await pool.query(`SELECT COALESCE(MAX(ws_order),0)+1 as n FROM gp_workstreams`)).rows[0].n;
  const key = 'ws' + maxOrder;
  return (await pool.query(`INSERT INTO gp_workstreams (ws_key,name,abbr,color,ws_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [key, name, abbr, color, maxOrder])).rows[0];
}
export async function updateWorkstream(id, fields) {
  await ensureWsSchema();
  const allowed = ['name','abbr','color','ws_order','active'];
  const sets=[]; const vals=[];
  Object.entries(fields).forEach(([k,v]) => { if (allowed.includes(k)) { sets.push(`${k} = $${sets.length+1}`); vals.push(v); } });
  if (!sets.length) return null;
  vals.push(id);
  return (await pool.query(`UPDATE gp_workstreams SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];
}
export async function deleteWorkstream(id) {
  await ensureWsSchema();
  await pool.query(`UPDATE gp_workstreams SET active = FALSE WHERE id = $1`, [id]);
}

// ── Task levels ──
export async function ensureTaskLevelCols() {
  try { await pool.query(`ALTER TABLE gp_story_tasks ADD COLUMN IF NOT EXISTS level VARCHAR(20) DEFAULT 'informativo'`); } catch {}
  try { await pool.query(`ALTER TABLE gp_stories ADD COLUMN IF NOT EXISTS prev_kanban_stage VARCHAR(20) DEFAULT ''`); } catch {}
}

// ── Sub-tasks ──
export async function ensureSubtaskCol() {
  try { await pool.query(`ALTER TABLE gp_story_tasks ADD COLUMN IF NOT EXISTS parent_task_id INTEGER DEFAULT NULL`); } catch {}
}
export async function getSubtasks(taskId) {
  await ensureSubtaskCol();
  return (await pool.query(`SELECT * FROM gp_story_tasks WHERE parent_task_id = $1 ORDER BY id`, [taskId])).rows;
}
export async function createSubtask(parentTaskId, title, assignee, level) {
  await ensureSubtaskCol();
  const parent = (await pool.query(`SELECT story_id FROM gp_story_tasks WHERE id = $1`, [parentTaskId])).rows[0];
  if (!parent) return null;
  const r = await pool.query(
    `INSERT INTO gp_story_tasks (story_id, title, assignee, level, parent_task_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [parent.story_id, title, assignee||'', level||'informativo', parentTaskId]
  );
  return r.rows[0];
}

// ── Track quem criou a task ──
export async function ensureCreatedByCol() {
  try { await pool.query(`ALTER TABLE gp_story_tasks ADD COLUMN IF NOT EXISTS created_by VARCHAR(100) DEFAULT ''`); } catch {}
}

// ── Gantt: datas por atividade ──
export async function ensureGanttCols() {
  const acts = ['rf','hf','spec','rt','plan'];
  for (const a of acts) {
    try { await pool.query(`ALTER TABLE gp_stories ADD COLUMN IF NOT EXISTS ${a}_start DATE`); } catch {}
    try { await pool.query(`ALTER TABLE gp_stories ADD COLUMN IF NOT EXISTS ${a}_end DATE`); } catch {}
  }
}
export async function setActivityDates(storyId, activity, startDate, endDate) {
  await ensureGanttCols();
  const allowed = ['rf','hf','spec','rt','plan'];
  if (!allowed.includes(activity)) return null;
  await pool.query(
    `UPDATE gp_stories SET ${activity}_start = $1, ${activity}_end = $2, updated_at = NOW() WHERE id = $3`,
    [startDate || null, endDate || null, storyId]
  );
  return { activity, start: startDate, end: endDate };
}
export async function clearActivityDates(storyId, activity) {
  await ensureGanttCols();
  const allowed = ['rf','hf','spec','rt','plan'];
  if (!allowed.includes(activity)) return null;
  await pool.query(
    `UPDATE gp_stories SET ${activity}_start = NULL, ${activity}_end = NULL, updated_at = NOW() WHERE id = $1`,
    [storyId]
  );
}
