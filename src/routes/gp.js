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

// ── INSIGHTS (Agente IA) ──
router.get('/insights', authMiddleware, gpAuth, async (req, res) => {
  try {
    const { stories, cadences, sprints } = await gp.getReportData();
    const allActions = await gp.getAllActions();
    const WS = { ws1:'Lead', ws2:'Oportunidade', ws3:'Cotação', ws4:'Contas e Contatos', ws5:'Governança', ws6:'Migração de Dados', ws7:'Catálogo' };
    // Compilar métricas
    const metrics = {};
    let totalDone=0, totalDoing=0, totalBlocked=0, totalTodo=0, totalCells=0;
    stories.forEach(s => {
      const w = s.workstream;
      if (!metrics[w]) metrics[w] = { done:0, doing:0, blocked:0, todo:0, total:0, stories:0, points:0, pointsDone:0 };
      metrics[w].stories++;
      metrics[w].points += (s.story_points||0);
      ['rf_status','hf_status','spec_status','rt_status','plan_status'].forEach(f => {
        if (!s[f]) return;
        metrics[w].total++; totalCells++;
        if (s[f]==='done') { metrics[w].done++; totalDone++; metrics[w].pointsDone += (s.story_points||0)/5; }
        else if (s[f]==='doing') { metrics[w].doing++; totalDoing++; }
        else if (s[f]==='blocked') { metrics[w].blocked++; totalBlocked++; }
        else if (s[f]==='todo') { metrics[w].todo++; totalTodo++; }
      });
    });
    const overdue = allActions.filter(a => a.status!=='done' && a.due_date && new Date(a.due_date) < new Date());
    const pending = allActions.filter(a => a.status==='pending');
    const ctx = `# Dados do Projeto CRM B2B Algar Telecom\n\n## Métricas Gerais\n- Total: ${totalCells} atividades | ${totalDone} concluídas (${totalCells?Math.round(totalDone/totalCells*100):0}%) | ${totalDoing} em andamento | ${totalBlocked} bloqueadas | ${totalTodo} a fazer\n- ${stories.length} histórias | ${allActions.length} action items (${overdue.length} vencidos, ${pending.length} pendentes)\n\n## Por Workstream\n` +
      Object.entries(metrics).map(([w,m]) => {
        const pct = m.total ? Math.round(m.done/m.total*100) : 0;
        const rag = m.blocked>0?'🔴':pct>=70?'🟢':pct>=30?'🟡':'⚪';
        return `### ${rag} ${WS[w]||w} — ${pct}%\n- ${m.stories} histórias, ${m.points} pontos\n- Concluído: ${m.done} | Andamento: ${m.doing} | Bloqueado: ${m.blocked} | A fazer: ${m.todo}`;
      }).join('\n') +
      `\n\n## Action Items Vencidos (${overdue.length})\n` +
      overdue.map(a => `- ${a.description} (resp: ${a.assignee||'?'}, venceu: ${a.due_date?.slice(0,10)})`).join('\n') +
      `\n\n## Cadências Definidas: ${cadences.length}`;
    const { call: dsCall } = await import('../services/deepseek.js');
    const insights = await dsCall(
      `Voce e um agente de inteligencia do projeto. Analise os dados e gere INSIGHTS ACIONAVEIS em portugues do Brasil. Formato:\n\n## 🎯 Resumo Executivo (3 linhas)\n## ⚠️ Alertas Criticos (itens bloqueados, vencidos, riscos)\n## 📊 Analise por Workstream (foque nos que precisam de atencao)\n## 💡 Recomendacoes (acoes concretas para o GP)\n## 📈 Projecao (ritmo atual vs entrega)\n\nSeja direto, factual e acionavel. Use emojis para RAG (🟢🟡🔴).`,
      [{ role:'user', content: ctx }], 4096
    );
    res.json({ insights, metrics, overdue: overdue.length, pending: pending.length, totalPct: totalCells?Math.round(totalDone/totalCells*100):0 });
  } catch (e) { res.json({ insights: 'Erro ao gerar insights: ' + e.message, metrics:{}, overdue:0, pending:0, totalPct:0 }); }
});
