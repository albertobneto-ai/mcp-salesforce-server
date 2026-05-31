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
      overdue.map(a => `- ${a.description} (resp: ${a.assignee||'?'}, venceu: ${a.due_date ? new Date(a.due_date).toISOString().slice(0,10) : '?'})`).join('\n') +
      `\n\n## Cadências Definidas: ${cadences.length}`;
    const { call: dsCall } = await import('../services/deepseek.js');
    const insights = await dsCall(
      `Voce e um agente de inteligencia do projeto. Analise os dados e gere INSIGHTS ACIONAVEIS em portugues do Brasil. Formato:\n\n## 🎯 Resumo Executivo (3 linhas)\n## ⚠️ Alertas Criticos (itens bloqueados, vencidos, riscos)\n## 📊 Analise por Workstream (foque nos que precisam de atencao)\n## 💡 Recomendacoes (acoes concretas para o GP)\n## 📈 Projecao (ritmo atual vs entrega)\n\nSeja direto, factual e acionavel. Use emojis para RAG (🟢🟡🔴).`,
      [{ role:'user', content: ctx }], 4096
    );
    res.json({ insights, metrics, overdue: overdue.length, pending: pending.length, totalPct: totalCells?Math.round(totalDone/totalCells*100):0 });
  } catch (e) { res.json({ insights: 'Erro ao gerar insights: ' + e.message, metrics:{}, overdue:0, pending:0, totalPct:0 }); }
});

// ── DOWNLOAD WORD (dark template) ──
router.get('/report/download', authMiddleware, gpAuth, async (req, res) => {
  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      Header, Footer, AlignmentType, LevelFormat, BorderStyle, WidthType,
      ShadingType, PageBreak, TabStopType, TabStopPosition, SimpleField,
      BookmarkStart, BookmarkEnd, InternalHyperlink } = await import('docx');

    const { stories, cadences } = await gp.getReportData();
    const allActions = await gp.getAllActions();
    const WS = { ws1:'Lead', ws2:'Oportunidade', ws3:'Cotação', ws4:'Contas e Contatos', ws5:'Governança', ws6:'Migração de Dados', ws7:'Catálogo' };

    // Métricas
    const metrics = {};
    let totalDone=0, totalCells=0;
    stories.forEach(s => {
      const w = s.workstream;
      if (!metrics[w]) metrics[w] = { done:0, doing:0, blocked:0, todo:0, total:0, stories:0, points:0 };
      metrics[w].stories++;
      metrics[w].points += (s.story_points||0);
      ['rf_status','hf_status','spec_status','rt_status','plan_status'].forEach(f => {
        if (!s[f]) return;
        metrics[w].total++; totalCells++;
        if (s[f]==='done') { metrics[w].done++; totalDone++; }
        else if (s[f]==='doing') metrics[w].doing++;
        else if (s[f]==='blocked') metrics[w].blocked++;
        else if (s[f]==='todo') metrics[w].todo++;
      });
    });
    const totalPct = totalCells ? Math.round(totalDone/totalCells*100) : 0;
    const overdue = allActions.filter(a => a.status!=='done' && a.due_date && new Date(a.due_date) < new Date());
    const pending = allActions.filter(a => a.status==='pending');

    // Gerar insights via IA
    let insightsText = '';
    try {
      const ctx = Object.entries(metrics).map(([w,m]) => {
        const pct = m.total?Math.round(m.done/m.total*100):0;
        return `${WS[w]||w}: ${pct}% (${m.done}/${m.total}) ${m.blocked?'BLOQUEADO':''}`;
      }).join('; ');
      const { call: dsCall } = await import('../services/deepseek.js');
      insightsText = await dsCall(
        'Gere um resumo executivo em 3 paragrafos curtos sobre o projeto abaixo. Riscos, destaques positivos e recomendacoes. Sem markdown, sem titulos, texto corrido.',
        [{ role:'user', content: `Projeto CRM B2B Algar: ${totalPct}% concluido, ${stories.length} historias. WS: ${ctx}. ${overdue.length} items vencidos, ${pending.length} pendentes.` }], 2048
      );
    } catch { insightsText = `Projeto com ${totalPct}% de conclusão geral. ${stories.length} histórias em 7 workstreams.`; }

    // Dark palette
    const BK='0A0A0A', WH='FFFFFF', AC='E0E0E0', BT='1A1A1A', GB='F0F0F0', GL='CCCCCC', RA='F7F7F7';
    const tb = { style: BorderStyle.SINGLE, size: 1, color: GL };
    const brd = { top:tb, bottom:tb, left:tb, right:tb };
    const nb = { style: BorderStyle.NONE, size:0, color:WH };
    const nbs = { top:nb, bottom:nb, left:nb, right:nb };

    const hc = (t,w) => new TableCell({ borders:brd, width:{size:w,type:WidthType.DXA}, shading:{fill:BK,type:ShadingType.CLEAR}, margins:{top:100,bottom:100,left:140,right:140},
      children:[new Paragraph({children:[new TextRun({text:t,bold:true,color:WH,font:'Arial',size:18,allCaps:true})]})] });
    const dc = (t,w,o={}) => new TableCell({ borders:brd, width:{size:w,type:WidthType.DXA}, shading:o.bg?{fill:o.bg,type:ShadingType.CLEAR}:undefined, margins:{top:100,bottom:100,left:140,right:140},
      children:[new Paragraph({children:[new TextRun({text:String(t),font:'Arial',size:18,bold:o.bold||false,color:o.color||BT})]})] });
    const sh = (n,t,bk) => new Paragraph({ spacing:{before:300,after:100}, border:{bottom:{style:BorderStyle.SINGLE,size:8,color:BK,space:4}},
      children:[new BookmarkStart({id:bk,name:bk}), new TextRun({text:n+'  ',font:'Arial',size:28,bold:true,color:'AAAAAA'}), new TextRun({text:t,font:'Arial',size:28,bold:true,color:BK}), new BookmarkEnd({id:bk})] });
    const bt2 = (t) => new Paragraph({ spacing:{after:120}, children:[new TextRun({text:t,font:'Arial',size:20,color:BT})] });
    const sp = (s) => new Paragraph({ spacing:{before:s,after:0}, children:[] });
    const te = (n,t,bk) => new Paragraph({ spacing:{before:60,after:60}, tabStops:[{type:TabStopType.RIGHT,position:9360,leader:'dot'}],
      children:[ new InternalHyperlink({ anchor:bk, children:[new TextRun({text:n+'  '+t,font:'Arial',size:20,color:BK}), new TextRun({children:['\t'],font:'Arial',size:20})] }) ] });
    const today = new Date().toISOString().slice(0,10);

    // Seções do doc
    const sections = [
      { num:'01', title:'Resumo Executivo', id:'sec01' },
      { num:'02', title:'Status por Workstream', id:'sec02' },
      { num:'03', title:'Detalhamento de Histórias', id:'sec03' },
      { num:'04', title:'Action Items', id:'sec04' },
      { num:'05', title:'Cadências de Reunião', id:'sec05' },
      { num:'06', title:'Análise e Recomendações', id:'sec06' },
    ];

    // Status por WS table rows
    const wsRows = Object.entries(metrics).map(([w,m],i) => {
      const pct = m.total?Math.round(m.done/m.total*100):0;
      const rag = m.blocked>0?'BLOQUEADO':pct>=70?'VERDE':pct>=30?'AMARELO':'VERMELHO';
      return new TableRow({ children:[
        dc(WS[w]||w, 2800, { bg:i%2?RA:WH, bold:true }),
        dc(`${pct}%`, 1200, { bg:i%2?RA:WH, bold:true, color: m.blocked>0?'CC0000':pct>=70?'228B22':'CC8800' }),
        dc(String(m.done), 1000, { bg:i%2?RA:WH }),
        dc(String(m.doing), 1200, { bg:i%2?RA:WH }),
        dc(String(m.blocked), 1200, { bg:i%2?RA:WH, color: m.blocked>0?'CC0000':BT }),
        dc(rag, 1960, { bg:i%2?RA:WH, bold:true, color: m.blocked>0?'CC0000':pct>=70?'228B22':'CC8800' }),
      ] });
    });

    // Stories detail
    const storyContent = [];
    const wsKeys = [...new Set(stories.map(s=>s.workstream))];
    wsKeys.forEach(w => {
      storyContent.push(new Paragraph({ spacing:{before:200,after:100}, children:[new TextRun({text:WS[w]||w,font:'Arial',size:22,bold:true,color:BK})] }));
      const ws = stories.filter(s=>s.workstream===w);
      const rows = [new TableRow({ children:[ hc('História',3500), hc('Dev',1200), hc('Pts',600), hc('Sprint',1100), hc('RF',560), hc('HF',560), hc('Spec',600), hc('RT',560), hc('Plan',680) ] })];
      ws.forEach((s,i) => {
        const st = v => v==='done'?'✓':v==='doing'?'◐':v==='blocked'?'✕':v==='todo'?'○':'–';
        const sc = v => v==='done'?'228B22':v==='doing'?'CC8800':v==='blocked'?'CC0000':BT;
        rows.push(new TableRow({ children:[
          dc(s.title,3500,{bg:i%2?RA:WH}), dc(s.dev_assignee||'—',1200,{bg:i%2?RA:WH}),
          dc(String(s.story_points||'—'),600,{bg:i%2?RA:WH}), dc(s.sprint||'—',1100,{bg:i%2?RA:WH}),
          dc(st(s.rf_status),560,{bg:i%2?RA:WH,color:sc(s.rf_status)}), dc(st(s.hf_status),560,{bg:i%2?RA:WH,color:sc(s.hf_status)}),
          dc(st(s.spec_status),600,{bg:i%2?RA:WH,color:sc(s.spec_status)}), dc(st(s.rt_status),560,{bg:i%2?RA:WH,color:sc(s.rt_status)}),
          dc(st(s.plan_status),680,{bg:i%2?RA:WH,color:sc(s.plan_status)}),
        ] }));
      });
      storyContent.push(new Table({ width:{size:9360,type:WidthType.DXA}, rows }));
    });

    // Action items
    const aiRows = [new TableRow({ children:[ hc('Descrição',4000), hc('Responsável',1500), hc('Prazo',1360), hc('Status',1100), hc('WS',1400) ] })];
    allActions.slice(0,20).forEach((a,i) => {
      aiRows.push(new TableRow({ children:[
        dc(a.description,4000,{bg:i%2?RA:WH}), dc(a.assignee||'—',1500,{bg:i%2?RA:WH}),
        dc(a.due_date?new Date(a.due_date).toISOString().slice(0,10):'—',1360,{bg:i%2?RA:WH}),
        dc(a.status==='done'?'Concluído':a.status==='doing'?'Em andamento':'Pendente',1100,{bg:i%2?RA:WH}),
        dc(WS[a.workstream]||'—',1400,{bg:i%2?RA:WH}),
      ] }));
    });

    const doc = new Document({
      numbering:{ config:[{ reference:'bullets', levels:[{level:0,format:LevelFormat.BULLET,text:'\u2022',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}}}}] }] },
      sections: [
        // CAPA
        { properties:{ page:{ size:{width:12240,height:15840}, margin:{top:0,right:0,bottom:0,left:0} } },
          children:[
            new Table({ width:{size:12240,type:WidthType.DXA}, columnWidths:[12240], rows:[new TableRow({ children:[new TableCell({
              borders:nbs, width:{size:12240,type:WidthType.DXA}, shading:{fill:BK,type:ShadingType.CLEAR}, margins:{top:4000,bottom:600,left:1440,right:1440},
              children:[
                new Paragraph({spacing:{after:200},children:[new TextRun({text:'PROJETO CRM B2B',font:'Arial',size:18,color:'888888',allCaps:true})]}),
                new Paragraph({spacing:{after:0},children:[new TextRun({text:'RELATÓRIO DE',font:'Arial',size:56,bold:true,color:WH})]}),
                new Paragraph({spacing:{after:300},children:[new TextRun({text:'ANDAMENTO',font:'Arial',size:56,bold:true,color:WH})]}),
                new Paragraph({spacing:{after:600},children:[new TextRun({text:'Algar Telecom — Status do Projeto',font:'Arial',size:24,color:AC})]}),
                sp(400),
                new Table({ width:{size:9360,type:WidthType.DXA}, columnWidths:[2800,6560], rows:[
                  ...[ ['PROJETO','CRM B2B Algar Telecom'], ['DATA',today], ['PROGRESSO',`${totalPct}% concluído`], ['HISTÓRIAS',`${stories.length} histórias em 7 workstreams`], ['GERADO POR','Ever i9 — Painel GP'] ].map(([l,v]) =>
                    new TableRow({ children:[
                      new TableCell({ borders:{top:{style:BorderStyle.SINGLE,size:1,color:'333333'},bottom:nb,left:nb,right:nb}, width:{size:2800,type:WidthType.DXA}, shading:{fill:BK,type:ShadingType.CLEAR}, margins:{top:120,bottom:120,left:0,right:140},
                        children:[new Paragraph({children:[new TextRun({text:l,font:'Arial',size:18,color:'888888',allCaps:true})]})] }),
                      new TableCell({ borders:{top:{style:BorderStyle.SINGLE,size:1,color:'333333'},bottom:nb,left:nb,right:nb}, width:{size:6560,type:WidthType.DXA}, shading:{fill:BK,type:ShadingType.CLEAR}, margins:{top:120,bottom:120,left:0,right:140},
                        children:[new Paragraph({children:[new TextRun({text:v,font:'Arial',size:18,color:WH,bold:true})]})] }),
                    ] })
                  )
                ] }),
              ]
            })] })] })
          ]
        },
        // CORPO
        { properties:{ page:{ size:{width:12240,height:15840}, margin:{top:1440,right:1440,bottom:1440,left:1440} } },
          headers:{ default: new Header({ children:[new Paragraph({ border:{bottom:{style:BorderStyle.SINGLE,size:4,color:BK,space:4}}, tabStops:[{type:TabStopType.RIGHT,position:TabStopPosition.MAX}],
            children:[ new TextRun({text:'RELATÓRIO',font:'Arial',size:16,color:'888888'}), new TextRun({text:' / ',font:'Arial',size:16,color:'888888'}), new TextRun({text:'Andamento Projeto Algar',font:'Arial',size:16,color:BK,bold:true}) ] })] }) },
          footers:{ default: new Footer({ children:[new Paragraph({ border:{top:{style:BorderStyle.SINGLE,size:4,color:BK,space:4}}, tabStops:[{type:TabStopType.RIGHT,position:TabStopPosition.MAX}],
            children:[ new TextRun({text:'Ever i9 — Confidencial',font:'Arial',size:16,color:'888888'}), new TextRun({children:['\t'],font:'Arial',size:16}), new SimpleField('PAGE') ] })] }) },
          children:[
            // Sumário
            new Paragraph({spacing:{after:200},children:[new TextRun({text:'SUMÁRIO',font:'Arial',size:28,bold:true,color:BK})]}),
            new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:8,color:BK,space:4}},spacing:{after:300},children:[]}),
            ...sections.map(s => te(s.num,s.title,s.id)),
            new Paragraph({children:[new PageBreak()]}),
            // 01 Resumo
            sh('01','Resumo Executivo','sec01'),
            ...insightsText.split('\n').filter(l=>l.trim()).map(l => bt2(l)),
            // 02 Status por WS
            sh('02','Status por Workstream','sec02'),
            bt2(`Progresso geral: ${totalPct}% • ${stories.length} histórias • ${allActions.length} action items (${overdue.length} vencidos)`),
            sp(100),
            new Table({ width:{size:9360,type:WidthType.DXA}, rows:[
              new TableRow({ children:[ hc('Workstream',2800), hc('%',1200), hc('Feito',1000), hc('Andamento',1200), hc('Bloqueado',1200), hc('RAG',1960) ] }),
              ...wsRows
            ] }),
            // 03 Detalhamento
            sh('03','Detalhamento de Histórias','sec03'),
            ...storyContent,
            // 04 Action Items
            sh('04','Action Items','sec04'),
            bt2(`${allActions.length} itens registrados • ${overdue.length} vencidos • ${pending.length} pendentes`),
            sp(100),
            new Table({ width:{size:9360,type:WidthType.DXA}, rows: aiRows }),
            // 05 Cadências
            sh('05','Cadências de Reunião','sec05'),
            ...cadences.map(c => bt2(`• ${c.title} (${c.type}) — ${c.frequency}, ${c.weekday} ${c.time_of_day}, ${c.duration_min}min. Participantes: ${c.participants||'—'}`)),
            cadences.length===0 ? bt2('Nenhuma cadência definida.') : sp(1),
            // 06 Análise
            sh('06','Análise e Recomendações','sec06'),
            ...insightsText.split('\n').filter(l=>l.trim()).map(l => bt2(l)),
          ]
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Relatorio_Andamento_Algar_${today}.docx"`);
    res.send(Buffer.from(buffer));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── STORY DETAIL (Jira concept) ──
router.get('/stories/:id/detail', authMiddleware, gpAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const stories = await gp.getStories();
    const story = stories.find(s => s.id === id);
    if (!story) return res.status(404).json({ erro: 'Historia nao encontrada' });
    const attachments = await gp.getAttachments(id);
    const comments = await gp.getComments(id);
    res.json({ story, attachments, comments });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── ATTACHMENTS ──
router.post('/stories/:id/attachments', authMiddleware, gpAuth, async (req, res) => {
  try {
    const att = await gp.addAttachment({
      ...req.body,
      story_id: Number(req.params.id),
      uploaded_by: req.user?.name || req.user?.email || ''
    });
    res.json({ attachment: att });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/attachments/:id/download', authMiddleware, gpAuth, async (req, res) => {
  try {
    const att = await gp.getAttachmentContent(Number(req.params.id));
    if (!att) return res.status(404).json({ erro: 'Arquivo nao encontrado' });
    if (att.link) return res.redirect(att.link);
    const buf = Buffer.from(att.content, 'base64');
    res.setHeader('Content-Type', att.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${att.file_name}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/attachments/:id', authMiddleware, gpAuth, async (req, res) => {
  try { await gp.deleteAttachment(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── COMMENTS ──
router.post('/stories/:id/comments', authMiddleware, gpAuth, async (req, res) => {
  try {
    const c = await gp.addComment(Number(req.params.id), req.user?.name || req.user?.email || '', req.body.content);
    res.json({ comment: c });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
