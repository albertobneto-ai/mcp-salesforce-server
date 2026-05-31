// src/routes/gp.js — API do Painel GP
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as gp from '../services/gp-db.js';

const router = express.Router();

// Apenas admin e gp acessam o painel
const gpAuth = (req, res, next) => {
  if (!['admin', 'gp'].includes(req.user?.role)) return res.status(403).json({ erro: 'Acesso restrito ao perfil GP ou Admin.' });
  next();
};

// ── STORIES ──
router.get('/stories', authMiddleware, gpAuth, async (req, res) => {
  try {
    const ws = req.query.workstream || null;
    res.json({ stories: await gp.getStories(ws) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/stories', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ story: await gp.createStory(req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.patch('/stories/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ story: await gp.updateStory(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/stories/:id', authMiddleware, gpAuth, async (req, res) => {
  try { await gp.deleteStory(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── CADENCES (Sync + Steering) ──
router.get('/cadences', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ cadences: await gp.getCadences() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/cadences', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ cadence: await gp.createCadence(req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.patch('/cadences/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ cadence: await gp.updateCadence(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/cadences/:id', authMiddleware, gpAuth, async (req, res) => {
  try { await gp.deleteCadence(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── SPRINTS ──
router.get('/sprints', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ sprints: await gp.getSprints() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/sprints', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ sprint: await gp.createSprint(req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── RELATÓRIO ──
router.get('/report', authMiddleware, gpAuth, async (req, res) => {
  try {
    const { stories, cadences, sprints } = await gp.getReportData();

    // Agrupa por workstream e calcula status
    const WS_NAMES = {
      ws1:'Lead', ws2:'Oportunidade', ws3:'Cotação', ws4:'Contas e Contatos',
      ws5:'Governança', ws6:'Migração de Dados', ws7:'Catálogo'
    };
    const byWs = {};
    stories.forEach(s => {
      if (!byWs[s.workstream]) byWs[s.workstream] = { stories: [], done: 0, doing: 0, blocked: 0, total: 0 };
      byWs[s.workstream].stories.push(s);
      ['rf_status','hf_status','spec_status','rt_status','plan_status'].forEach(f => {
        if (!s[f] || s[f] === '') return;
        byWs[s.workstream].total++;
        if (s[f] === 'done') byWs[s.workstream].done++;
        else if (s[f] === 'doing') byWs[s.workstream].doing++;
        else if (s[f] === 'blocked') byWs[s.workstream].blocked++;
      });
    });

    const ctx = `# Status do Projeto CRM B2B Algar Telecom\n\n` +
      Object.entries(byWs).map(([ws, d]) => {
        const pct = d.total ? Math.round((d.done/d.total)*100) : 0;
        const rag = d.blocked > 0 ? '🔴' : pct >= 70 ? '🟢' : pct >= 30 ? '🟡' : '⚪';
        const stories = d.stories.map(s =>
          `  - ${s.title} [Dev:${s.dev_assignee||'—'} | Pts:${s.story_points||'?'} | Sprint:${s.sprint||'?'}]`
        ).join('\n');
        return `## ${rag} ${WS_NAMES[ws]||ws} — ${pct}% concluído\n` +
          `Atividades: ${d.done} concluídas / ${d.doing} em andamento / ${d.blocked} bloqueadas de ${d.total}\n` +
          `Histórias:\n${stories}`;
      }).join('\n\n') +
      `\n\n## Cadências\n` +
      cadences.map(c => `- **${c.title}** (${c.type}): ${c.frequency}, ${c.weekday} ${c.time_of_day}, ${c.duration_min}min | Próxima: ${c.next_date||'—'}`).join('\n');

    // Gera relatório via DeepSeek (economia)
    const prompt = `Voce e um especialista em gestao de projetos Agile. Gere um relatorio executivo de status do projeto abaixo, em portugues do Brasil. Inclua: resumo executivo, status por workstream (RAG), riscos e impedimentos, proximos passos criticos. Formato profissional em Markdown.`;
    let report = '';
    try {
      const { call: dsCall } = await import('../services/deepseek.js');
      report = await dsCall(prompt, [{ role: 'user', content: ctx }], 8192);
    } catch {
      report = ctx; // fallback: retorna os dados brutos
    }

    res.json({ report, raw: ctx });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;

// ── REUNIÕES ──
const ATA_SYSTEM = `Voce e um especialista em gestao de projetos Agile. Gere uma ATA (Ata de Reuniao) profissional e estruturada em portugues do Brasil com base na transcricao/notas fornecidas. Estrutura obrigatoria em Markdown:

## Informacoes da Reuniao
## Pauta
## Pontos Discutidos
## Decisoes Tomadas
## Proximos Passos (com responsavel e prazo)
## Proxima Reuniao

Seja objetivo, factual e formal.`;

const EXTRACT_SYSTEM = `Extraia TODOS os proximos passos e action items do texto abaixo. Retorne APENAS um JSON array valido, sem texto extra, sem markdown, sem backticks: [{"descricao":"acao concreta","responsavel":"nome ou cargo","prazo":"YYYY-MM-DD ou null","workstream":"ws1|ws2|ws3|ws4|ws5|ws6|ws7 ou null"}]. workstream: ws1=Lead ws2=Oportunidade ws3=Cotacao ws4=Contas ws5=Governanca ws6=Migracao ws7=Catalogo.`;

router.get('/meetings', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ meetings: await gp.getMeetings() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meetings/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json(await gp.getMeeting(Number(req.params.id))); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/meetings', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ meeting: await gp.createMeeting({ ...req.body, created_by: req.user?.name || req.user?.email || '' }) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.patch('/meetings/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ meeting: await gp.updateMeeting(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/meetings/:id', authMiddleware, gpAuth, async (req, res) => {
  try { await gp.deleteMeeting(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/meetings/:id/generate-ata', authMiddleware, gpAuth, async (req, res) => {
  try {
    const { meeting } = await gp.getMeeting(Number(req.params.id));
    if (!meeting) return res.status(404).json({ erro: 'Reuniao nao encontrada' });
    const { call: dsCall } = await import('../services/deepseek.js');
    // 1) Gerar ATA
    const input = `Reuniao: ${meeting.title}\nData: ${meeting.meeting_date||'nao informada'}\nParticipantes: ${meeting.participants||'nao informados'}\nWorkstream: ${meeting.workstream||'geral'}\n\nTranscricao/Notas:\n${meeting.transcription}`;
    const ata = await dsCall(ATA_SYSTEM, [{ role:'user', content: input }], 8192);
    await gp.updateMeeting(meeting.id, { ata_content: ata });
    // 2) Extrair action items
    let actions = [];
    try {
      const raw = await dsCall(EXTRACT_SYSTEM, [{ role:'user', content: ata }], 2048);
      const clean = raw.replace(/```json|```/g, '').trim();
      actions = JSON.parse(clean);
    } catch { actions = []; }
    await gp.saveActions(meeting.id, actions);
    const { actions: saved } = await gp.getMeeting(meeting.id);
    res.json({ ata, actions: saved });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ACTION ITEMS ──
router.get('/action-items', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ actions: await gp.getAllActions() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

router.patch('/action-items/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ action: await gp.updateAction(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
