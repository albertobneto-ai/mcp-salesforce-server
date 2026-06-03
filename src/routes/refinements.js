// src/routes/refinements.js — Rotas da Agenda de Refinamento
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as refDb from '../services/refinement-db.js';

const router = express.Router();

const gpAuth = (req, res, next) => {
  if (!req.user?.role) return res.status(403).json({ erro: 'Autenticação necessária.' });
  next();
};

// GET /api/gp/refinements — Lista todos
router.get('/', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ refinements: await refDb.getRefinements() }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/gp/refinements/stats — Estatísticas
router.get('/stats', authMiddleware, gpAuth, async (req, res) => {
  try { res.json(await refDb.getRefinementStats()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/gp/refinements — Cria um refinamento
router.post('/', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ refinement: await refDb.createRefinement(req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// PATCH /api/gp/refinements/:id — Atualiza (deadlines, status, docs)
router.patch('/:id', authMiddleware, gpAuth, async (req, res) => {
  try { res.json({ refinement: await refDb.updateRefinement(Number(req.params.id), req.body) }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/gp/refinements/:id — Remove
router.delete('/:id', authMiddleware, gpAuth, async (req, res) => {
  try { await refDb.deleteRefinement(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/gp/refinements/seed — Carrega agenda inicial
router.post('/seed', authMiddleware, gpAuth, async (req, res) => {
  try {
    const SEED_DATA = [
      { ref_code:"REF-001", module:"CONTAS", epic:"Gestão de Carteira + Parceiros", resp:"Alberto/Van", session_date:"2026-06-02", session_time:"10:00",
        stories:"Gestão de Carteira (modelo, distribuição, Account Teams) + Parceiros",
        objective:"Refinar itens 1,2,4 de Carteira; definir escopo de Parceiros para Fase 1",
        participants:["PO","Analista Comercial","Dev Lead"],
        us_write_deadline:"2026-06-03", us_approve_deadline:"2026-06-08", et_write_deadline:"2026-06-10", et_approve_deadline:"2026-06-11", ref_order:1 },
      { ref_code:"REF-002", module:"TRANSVERSAL", epic:"Autenticação + Acessos", resp:"José", session_date:"2026-06-03", session_time:"15:00",
        stories:"Autenticação (MFA+SSO), Arquitetura de Acessos, Permission Sets",
        objective:"Definir modelo de acessos e priorizar infraestrutura de segurança",
        participants:["PO","Arquiteto SF","Segurança TI"],
        us_write_deadline:"2026-06-05", us_approve_deadline:"2026-06-09", et_write_deadline:"2026-06-11", et_approve_deadline:"2026-06-12", ref_order:2 },
      { ref_code:"REF-003", module:"TRANSVERSAL", epic:"Licenças + Regionais", resp:"José", session_date:"2026-06-08", session_time:"15:30",
        stories:"Gestão de Licenças, Regionais e Controle de Localidades",
        objective:"Mapear licenças contratadas e definir modelo de regionais",
        participants:["PO","Gerente TI","Analista Negócio"],
        us_write_deadline:"2026-06-09", us_approve_deadline:"2026-06-11", et_write_deadline:"2026-06-15", et_approve_deadline:"2026-06-17", ref_order:3 },
      { ref_code:"REF-004", module:"CONTATOS", epic:"Contato + LGPD", resp:"Alberto/Van", session_date:"2026-06-09", session_time:"10:00",
        stories:"Criação de Contato (dados, validação, duplicidade) + LGPD / Consentimento",
        objective:"Refinar US dos módulos não iniciados – Contatos e LGPD",
        participants:["PO","Analista Negócio","Jurídico"],
        us_write_deadline:"2026-06-10", us_approve_deadline:"2026-06-12", et_write_deadline:"2026-06-16", et_approve_deadline:"2026-06-18", ref_order:4 },
      { ref_code:"REF-005", module:"TRANSVERSAL", epic:"Integração Snowflake + Visibilidade", resp:"José", session_date:"2026-06-09", session_time:"10:00",
        stories:"Integração Snowflake + Roles e Visibilidade de Dados + Interface do Partner",
        objective:"Definir arquitetura de integração e modelo de visibilidade de dados",
        participants:["PO","Arquiteto Dados","Dev MuleSoft"],
        us_write_deadline:"2026-06-11", us_approve_deadline:"2026-06-15", et_write_deadline:"2026-06-17", et_approve_deadline:"2026-06-19", ref_order:5 },
      { ref_code:"REF-006", module:"CONTAS", epic:"Entrada Manual + Serasa + API", resp:"Alberto/Van", session_date:"2026-06-11", session_time:"15:30",
        stories:"[CONTA] Entrada Manual, Integração Serasa (CRMB2B-50,83,84,85), API criação (CRMB2B-94)",
        objective:"Desbloquear histórias Em ET e definir critérios de aceite para contas",
        participants:["PO","Dev MuleSoft","Analista","Arquiteto"],
        us_write_deadline:"2026-06-12", us_approve_deadline:"2026-06-16", et_write_deadline:"2026-06-18", et_approve_deadline:"2026-06-19", ref_order:6 },
      { ref_code:"REF-007", module:"CONTAS", epic:"Relacionamentos + Hierarquia + Tier", resp:"Alberto/Van", session_date:"2026-06-15", session_time:"15:30",
        stories:"Relacionamentos (Matriz/Filial, Hierarquia, Grupo Econômico) + Classificações Tier",
        objective:"Moises apresenta modelo de Grupo Econômico; definir itens 1,2,3",
        participants:["PO","Moises (Arq)","Analista"],
        us_write_deadline:"2026-06-16", us_approve_deadline:"2026-06-18", et_write_deadline:"2026-06-22", et_approve_deadline:"2026-06-24", ref_order:7 },
      { ref_code:"REF-008", module:"LEAD", epic:"Integrações + Agentforce Lead", resp:"Alberto/Van", session_date:"2026-06-16", session_time:"10:00",
        stories:"Integrações: Salesforce+Outlook (Teams), CRMB2B-93 + AgentForce Lead (MVP)",
        objective:"Refinar integração de agendamento e definir escopo mínimo do Agentforce",
        participants:["PO","Dev SF","Dev MuleSoft"],
        us_write_deadline:"2026-06-17", us_approve_deadline:"2026-06-19", et_write_deadline:"2026-06-23", et_approve_deadline:"2026-06-25", ref_order:8 },
      { ref_code:"REF-009", module:"CONTATOS", epic:"Gestão Contato + Multi-Conta", resp:"Alberto/Van", session_date:"2026-06-17", session_time:"15:30",
        stories:"Gestão do Registro de Contato (edição, influência, relacionamentos) + Múltiplas Contas",
        objective:"Completar backlog de histórias de Contatos para iniciar dev",
        participants:["PO","Analista","Dev SF"],
        us_write_deadline:"2026-06-18", us_approve_deadline:"2026-06-22", et_write_deadline:"2026-06-24", et_approve_deadline:"2026-06-25", ref_order:9 },
      { ref_code:"REF-010", module:"SALES MAP", epic:"Lead Explorer + Mapa de Rede", resp:"Alberto/Van", session_date:"2026-06-18", session_time:"15:30",
        stories:"Lead Explorer (CRMB2B-76) + Mapa de Rede (CRMB2B-75)",
        objective:"Refinar funcionais do Sales Map e preparar para dev na Sprint 3",
        participants:["PO","Analista","GIS/Geo Dev"],
        us_write_deadline:"2026-06-19", us_approve_deadline:"2026-06-23", et_write_deadline:"2026-06-24", et_approve_deadline:"2026-06-25", ref_order:10 },
      { ref_code:"REF-011", module:"CONTAS", epic:"Visão 360 + Agentforce Contas", resp:"Alberto/Van", session_date:"2026-06-22", session_time:"15:30",
        stories:"Visão 360° da Conta + Métricas e Relatórios + Agentforce Contas",
        objective:"Definir layout 360° e escopo do Agentforce para contas",
        participants:["PO","UX Designer","Analista"],
        us_write_deadline:"2026-06-23", us_approve_deadline:"2026-06-25", et_write_deadline:"2026-06-29", et_approve_deadline:"2026-07-01", ref_order:11 },
      { ref_code:"REF-012", module:"CONTAS / LEAD", epic:"Governança Contas + Lead", resp:"Alberto/Van", session_date:"2026-06-23", session_time:"15:30",
        stories:"Usuários e Governança – Contas + Governança Lead (CRMB2B-21,79,80,81,133)",
        objective:"Fechar todas as ETs de governança; homologar regras de permissão",
        participants:["PO","Arquiteto SF","Analista"],
        us_write_deadline:"2026-06-24", us_approve_deadline:"2026-06-26", et_write_deadline:"2026-06-30", et_approve_deadline:"2026-07-02", ref_order:12 },
      { ref_code:"REF-013", module:"TODOS", epic:"Revisão Geral de Backlog", resp:"—", session_date:"2026-07-02", session_time:"15:30",
        stories:"Revisão geral: histórias em A Refinar ou Em ET",
        objective:"Garantir 100% das US refinadas para entrega Jul; identificar riscos",
        participants:["PO","Dev Leads","Analistas","QA"],
        us_write_deadline:"2026-07-06", us_approve_deadline:"2026-07-08", et_write_deadline:"2026-07-10", et_approve_deadline:"2026-07-14", ref_order:13 },
      { ref_code:"REF-014", module:"TODOS", epic:"Demo + Estabilização Jul", resp:"—", session_date:"2026-07-06", session_time:"15:30",
        stories:"Demo / Planejamento de estabilização Jul",
        objective:"Apresentar incremento e planejar UAT e go-live",
        participants:["Time completo","Stakeholders Algar"],
        us_write_deadline:"2026-07-07", us_approve_deadline:"2026-07-09", et_write_deadline:"2026-07-13", et_approve_deadline:"2026-07-15", ref_order:14 },
    ];
    const count = await refDb.seedRefinements(SEED_DATA);
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;
