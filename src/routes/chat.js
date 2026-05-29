// src/routes/chat.js — Router de chat com /deploy funcional
import express from 'express';
import * as claude from '../services/claude.js';
import * as grok from '../services/grok.js';
import { authMiddleware } from '../middleware/auth.js';
import { resolve as aliasResolve } from '../config/alias-map.js';
import specPrompt from '../prompts/spec.js';
import hfPrompt from '../prompts/hf.js';
import ataPrompt from '../prompts/ata.js';
import deployPrompt from '../prompts/deploy.js';
import prototipoPrompt from '../prompts/prototipo.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import pool from '../config/db.js';
import * as sfMulti from '../services/sf-multi.js';
import { knowledgeBase } from '../config/knowledge-base.js';
import { usageALS, pushUsage } from '../services/usage-context.js';
import { recordUsage, getMonthlyUsage, getUsageBreakdown } from '../services/usage-db.js';
import * as openrouter from '../services/openrouter.js';

const router = express.Router();

// Helper: executa SOQL na org selecionada ou default
async function execSoql(req, soql) {
  const selectedOrg = await getSelectedOrg(req);
  if (selectedOrg) {
    return await sfMulti.runSoql(selectedOrg, soql);
  }
  const base = 'http://localhost:' + (process.env.PORT || 3000);
  const enc = Buffer.from(soql).toString('base64');
  const r = await fetch(base + '/api/soql-b64/' + enc);
  return await r.json();
}

// Helper: describe na org selecionada ou default
async function execDescribe(req, objectName) {
  const selectedOrg = await getSelectedOrg(req);
  if (selectedOrg) {
    return await sfMulti.describeObject(selectedOrg, objectName);
  }
  const base = 'http://localhost:' + (process.env.PORT || 3000);
  const r = await fetch(base + '/api/describe/' + objectName);
  return await r.json();
}

// Helper: metadata-read na org selecionada ou default
async function execMetadataRead(req, type, fullName) {
  const selectedOrg = await getSelectedOrg(req);
  if (selectedOrg) {
    return await sfMulti.metadataRead(selectedOrg, type, fullName);
  }
  const base = 'http://localhost:' + (process.env.PORT || 3000);
  const r = await fetch(base + '/api/metadata-read/' + type + '/' + fullName);
  return await r.json();
}

// Helper: executa os steps de um plano de deploy e retorna resultados
async function runDeploySteps(smartDeploy, req) {
  const baseDeploy = 'http://localhost:' + (process.env.PORT || 3000);
  const org = await getSelectedOrg(req); // null = org padrao
  const deployResults = [];

  // Helpers que roteiam pra org selecionada (sfMulti) ou padrao (fetch interno)
  async function doCreate(type, body) {
    if (org) { try { const r = await sfMulti.metadataCreate(org, type, body); const i = Array.isArray(r) ? r[0] : r; return { success: i?.success, errors: i?.errors ? (Array.isArray(i.errors) ? i.errors : [i.errors]) : [] }; } catch (e) { return { success: false, errors: [{ message: e.message }] }; } }
    const r = await fetch(baseDeploy + '/api/metadata-create/' + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  }
  async function doUpdate(type, body) {
    if (org) { try { const r = await sfMulti.metadataUpdate(org, type, body); const i = Array.isArray(r) ? r[0] : r; return { success: i?.success !== false, errors: i?.errors ? (Array.isArray(i.errors) ? i.errors : [i.errors]) : [] }; } catch (e) { return { success: false, errors: [{ message: e.message }] }; } }
    const r = await fetch(baseDeploy + '/api/metadata-update/' + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  }
  async function doDelete(type, fullName) {
    if (org) { try { const r = await sfMulti.metadataDelete(org, type, fullName); const i = Array.isArray(r) ? r[0] : r; return { success: i?.success !== false, errors: i?.errors ? (Array.isArray(i.errors) ? i.errors : [i.errors]) : [] }; } catch (e) { return { success: false, errors: [{ message: e.message }] }; } }
    const r = await fetch(baseDeploy + '/api/metadata-delete/' + type + '/' + encodeURIComponent(fullName));
    return await r.json();
  }
  async function doApex(code) {
    if (org) { try { const r = await sfMulti.executeApex(org, code); return { success: r?.success !== false, errors: r?.compileProblem ? [{ message: r.compileProblem }] : (r?.exceptionMessage ? [{ message: r.exceptionMessage }] : []) }; } catch (e) { return { success: false, errors: [{ message: e.message }] }; } }
    const r = await fetch(baseDeploy + '/api/execute-anonymous', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return await r.json();
  }
  async function doLayout(layoutName, fieldName, sectionLabel) {
    if (org) { try { return await sfMulti.moveFieldInLayout(org, layoutName, fieldName, sectionLabel); } catch (e) { return { success: false, error: e.message }; } }
    const r = await fetch(baseDeploy + '/api/move-field-in-layout/' + encodeURIComponent(layoutName) + '/' + encodeURIComponent(fieldName) + '/' + encodeURIComponent(sectionLabel));
    return await r.json();
  }

  for (const step of smartDeploy.steps) {
    try {
      if (step.type === 'metadata-create') {
        const result = await doCreate(step.metadataType, step.body);
        const alreadyExists = (result.errors || []).some(e => (e.message || '').includes('already') || (e.message || '').includes('duplicate'));
        deployResults.push({ component: (step.description || step.metadataType), success: result.success || alreadyExists, errors: alreadyExists ? [] : (result.errors || []) });
      } else if (step.type === 'add-to-layout') {
        const ln = step.layout || (step.object + '-' + step.object + ' Layout');
        const sn = step.section || (step.object + ' Information');
        const result = await doLayout(ln, step.field, sn);
        deployResults.push({ component: (step.description || 'Layout: ' + step.field), success: result.success || result.status === 'added' || result.status === 'moved', errors: result.error ? [{ message: result.error }] : [] });
      } else if (step.type === 'add-permission') {
        const psName = step.permissionSetName || 'Everi9_Deploy_Access';
        const body = { fullName: psName, label: step.permissionSetLabel || psName.replace(/_/g, ' '), fieldPermissions: (step.fields || [step.field]).map(f => ({ field: f, editable: true, readable: true })) };
        let result = await doCreate('PermissionSet', body);
        if (!result.success) { result = await doUpdate('PermissionSet', body); }
        deployResults.push({ component: (step.description || 'Permission Set'), success: result.success !== false, errors: result.errors || [] });
        try {
          const assignApex = "PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = '" + psName + "' LIMIT 1]; List<User> users = [SELECT Id FROM User WHERE IsActive = true AND UserType = 'Standard' AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :ps.Id)]; List<PermissionSetAssignment> psas = new List<PermissionSetAssignment>(); for (User u : users) { psas.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id)); } if (!psas.isEmpty()) insert psas;";
          await doApex(assignApex);
          deployResults.push({ component: 'Atribuir PS aos usuarios', success: true, errors: [] });
        } catch {}
      } else if (step.type === 'metadata-update') {
        const result = await doUpdate(step.metadataType, step.body);
        deployResults.push({ component: (step.description || step.metadataType), success: result.success !== false, errors: result.errors || [] });
      } else if (step.type === 'execute-apex') {
        const result = await doApex(step.code);
        deployResults.push({ component: (step.description || 'Apex'), success: result.success !== false, errors: result.errors || [] });
      } else if (step.type === 'delete-metadata' || step.type === 'delete-field') {
        const mtype = step.metadataType || 'CustomField';
        const fullName = step.fullName || step.field;
        const result = await doDelete(mtype, fullName);
        const notExists = (result.errors || []).some(e => (e.message || '').includes('does not exist') || (e.message || '').includes('not found') || (e.message || '').includes('no CustomObject'));
        deployResults.push({ component: (step.description || 'Excluir ' + fullName), success: result.success !== false || notExists, errors: notExists ? [{ message: 'Componente nao encontrado nesta org' }] : (result.errors || []) });
      } else if (step.type === 'setup-instruction') {
        deployResults.push({ component: step.step || step.description, success: true, manual: true, setupUrl: step.setupUrl || '', errors: [] });
      }
    } catch (stepErr) {
      deployResults.push({ component: (step.description || step.type), success: false, errors: [{ message: stepErr.message }] });
    }
  }
  return deployResults;
}

// Helper: formata resultado do deploy
function formatDeployResult(smartDeploy, deployResults) {
  const successDeploy = deployResults.filter(r => !r.manual).every(r => r.success);
  const resultLines = [];
  resultLines.push(successDeploy ? '## \u2705 Deploy realizado com sucesso!' : '## \u26a0\ufe0f Deploy parcial');
  if (smartDeploy.summary) { resultLines.push(''); resultLines.push('**Resumo:** ' + smartDeploy.summary); }
  resultLines.push('');
  resultLines.push('### Passos executados');
  resultLines.push('| # | Acao | Status |');
  resultLines.push('|---|---|---|');
  deployResults.forEach((r, idx) => {
    const icon = r.manual ? '\ud83d\udcdd' : (r.success ? '\u2705' : '\u274c');
    const errMsg = r.errors?.length ? ' \u2014 ' + (r.errors[0]?.message || '') : '';
    resultLines.push('| ' + (idx + 1) + ' | ' + (r.component || 'N/A') + ' | ' + icon + errMsg + ' |');
  });
  return resultLines.join('\n');
}

// Helper: monta preview (dry-run) de um plano
function formatDeployPreview(smartDeploy, orgName) {
  const lines = [];
  lines.push('[[CONFIRM-BOX]]');
  lines.push('## \u26a0\ufe0f Confirmacao de Deploy');
  lines.push('');
  lines.push('### \ud83c\udfe2 Org de destino: ' + (orgName || 'Dev Org (padrao)'));
  if (smartDeploy.summary) { lines.push(''); lines.push('**Resumo:** ' + smartDeploy.summary); }
  lines.push('');
  lines.push('### O que sera feito');
  lines.push('| # | Tipo | Acao |');
  lines.push('|---|---|---|');
  const typeLabels = { 'metadata-create': 'Criar', 'add-to-layout': 'Layout', 'add-permission': 'Permissao', 'metadata-update': 'Config', 'execute-apex': 'Apex', 'delete-metadata': 'Excluir', 'delete-field': 'Excluir', 'setup-instruction': 'Manual' };
  smartDeploy.steps.forEach((step, idx) => {
    lines.push('| ' + (idx + 1) + ' | ' + (typeLabels[step.type] || step.type) + ' | ' + (step.description || step.metadataType || step.field || step.type) + ' |');
  });
  if (smartDeploy.code) {
    const codeItems = [];
    if (smartDeploy.code.apexClasses?.length) codeItems.push(smartDeploy.code.apexClasses.length + ' Apex Class(es)');
    if (smartDeploy.code.apexTriggers?.length) codeItems.push(smartDeploy.code.apexTriggers.length + ' Trigger(s)');
    if (smartDeploy.code.lwc?.length) codeItems.push(smartDeploy.code.lwc.length + ' LWC');
    if (codeItems.length) { lines.push(''); lines.push('**Codigo a deployar:** ' + codeItems.join(', ')); }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Nada foi alterado na org ainda.');
  lines.push('');
  lines.push('[[BTN-CONFIRM:Seguir e aplicar]]');
  lines.push('[[/CONFIRM-BOX]]');
  lines.push('');
  lines.push('---PLAN---');
  lines.push(JSON.stringify(smartDeploy));
  lines.push('---FIM---');
  return lines.join('\n');
}


// Detecta se a pergunta precisa da KB do projeto
function needsKB(text) {
  const lower = text.toLowerCase();
  const triggers = [
    'mcp', 'deploy', 'manifest', 'org', 'endpoint', 'heroku', 'scratch',
    'spec', 'campo', 'field', 'objeto', 'object', 'layout', 'permission',
    'picklist', 'validation', 'flow', 'apex', 'soql', 'metadata',
    'algar', 'everi9', 'ever i9', 'aichat', 'provisioning',
    'lead', 'account', 'opportunity', 'contact', 'quote', 'order',
    'record type', 'describe', '/hf', '/spec', '/ata', '/deploy',
    'github', 'salesforce', 'connected app', 'oauth',
  ];
  return triggers.some(t => lower.includes(t));
}

// ── Helper: pegar org selecionada ──
async function getSelectedOrg(req) {
  const orgId = req.headers['x-org-id'] || req.query.orgId;
  if (!orgId || orgId === 'default') return null; // usa org padrão (config vars)
  const result = await pool.query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  return result.rows[0] || null;
}

// ── Permissões por perfil ──
const ROLE_PERMISSIONS = {
  admin:     ['spec', 'spec-deep', 'hf', 'ata', 'deploy', 'delete', 'describe', 'status', 'chat', 'prototipo', 'list', 'discovery', 'arch'],
  funcional: ['hf', 'ata'],
  architect: ['spec', 'spec-deep', 'ata', 'list', 'discovery', 'arch'],
  developer: ['deploy', 'delete', 'describe', 'ata', 'list', 'discovery'],
  candidato: ['chat'],
};

function checkPermission(role, command) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(command);
}

function detectCommand(messages) {
  const last = (messages[messages.length - 1]?.content || '').toLowerCase();
  if (last.startsWith('/spec deep') || last.startsWith('/spec-deep')) return 'spec-deep';
  if (last.startsWith('/spec') || last.includes('gere a spec')) return 'spec';
  if (last.startsWith('/hf') || last.includes('historia funcional')) return 'hf';
  if (last.startsWith('/ata') || last.includes('ata de reuniao')) return 'ata';
  if (last.startsWith('/arch')) return 'arch';
  if (last.startsWith('/discovery') || last.startsWith('/disc')) return 'discovery';
  if (last.startsWith('/list')) return 'list';
  if (last.startsWith('/prototipo') || last.startsWith('/proto')) return 'prototipo';
  if (last.startsWith('/deploy')) return 'deploy';
  if (last.startsWith('/delete') || last.startsWith('/del ')) return 'delete';
  if (last.startsWith('/describe')) return 'describe';
  if (last.startsWith('/status') || last.startsWith('/org')) return 'status';
  return 'chat';
}

// ── Helper: parsear stream SSE e coletar texto completo ──
async function collectStream(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let usageIn = 0, usageOut = 0, usageCacheRead = 0, usageCacheWrite = 0, sawUsage = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const raw = line.replace('data: ', '').trim();
      if (raw === '[DONE]') continue;
      try {
        const p = JSON.parse(raw);
        if (p.type === 'content_block_delta' && p.delta?.text) full += p.delta.text;
        if (p.choices?.[0]?.delta?.content) full += p.choices[0].delta.content;
        // Captura passiva de usage (Claude stream)
        if (p.type === 'message_start' && p.message?.usage) {
          usageIn = p.message.usage.input_tokens || 0;
          usageCacheRead = p.message.usage.cache_read_input_tokens || 0;
          usageCacheWrite = p.message.usage.cache_creation_input_tokens || 0;
          sawUsage = true;
        }
        if (p.type === 'message_delta' && p.usage?.output_tokens != null) {
          usageOut = p.usage.output_tokens; sawUsage = true;
        }
        // Grok stream (se include_usage estiver ativo)
        if (p.usage && (p.usage.prompt_tokens != null || p.usage.completion_tokens != null)) {
          usageIn = p.usage.prompt_tokens || usageIn;
          usageOut = p.usage.completion_tokens || usageOut;
          sawUsage = true;
        }
      } catch {}
    }
  }
  if (sawUsage) {
    pushUsage('claude-sonnet-4-6', {
      input_tokens: usageIn, output_tokens: usageOut,
      cache_read_input_tokens: usageCacheRead, cache_creation_input_tokens: usageCacheWrite,
    });
  }
  return full;
}

// ── Helper: extrair JSON de uma resposta de texto ──
function extractJson(text) {
  // Tentar parsear direto
  try { return JSON.parse(text.trim()); } catch {}
  // Procurar JSON dentro de markdown ```json ... ```
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }
  // Procurar primeiro { ate ultimo }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// POST /api/chat
// GET /api/chat/usage — consumo de tokens do mes corrente (proprio usuario)
router.get('/usage', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const used = await getMonthlyUsage(userId);
    const breakdown = await getUsageBreakdown(userId);
    let limit = null;
    try {
      const r = await pool.query('SELECT token_limit FROM users WHERE id = $1', [userId]);
      limit = r.rows[0]?.token_limit ?? null;
    } catch {}
    res.json({ userId, month_used: used, token_limit: limit, breakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Middleware: contexto de uso de tokens por requisicao (ALS, passivo)
function usageContext(req, res, next) {
  const store = { userId: req.user?.id, command: null, pending: [] };
  res.on('finish', () => { try { recordUsage(store.userId, store.command, store.pending); } catch {} });
  usageALS.run(store, () => next());
}

router.post('/', authMiddleware, usageContext, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages obrigatorio' });

    const command = detectCommand(messages);
    const userRole = req.user?.role || 'funcional';
    try { const _s = usageALS.getStore(); if (_s) _s.command = command; } catch {}

    const FREE_UNAVAILABLE = '[[ALERT-FREE:indisponivel]]\n\nOs modelos gratuitos estao temporariamente sobrecarregados (limite do tier gratuito do OpenRouter). Tente novamente em alguns instantes, ou use um modelo moderno (Claude/Grok).';
    // ── GATE Fase 2: roteamento de modelo gratuito + limite de tokens ──
    const selectedModel = req.headers['x-model'] || 'auto';
    const usesFree = openrouter.isFreeModel(selectedModel);
    const FREE_ALLOWED = ['hf', 'ata', 'chat'];
    const MODERN_REQUIRED = ['spec', 'spec-deep', 'deploy', 'delete', 'arch', 'discovery', 'prototipo'];
    const MCP_ONLY = ['describe', 'status', 'list', 'org', 'orgs', 'scratch', 'mock'];

    // Detectar follow-up de confirmacao (deploy/delete) para NAO aplicar o gate nessas
    const _lastUser = (messages[messages.length - 1]?.content || '').toLowerCase().trim();
    const _prevAssist = [...messages].reverse().find(m => m.role === 'assistant')?.content || '';
    const _isConfirmFollowup = (_prevAssist.includes('---PLAN---') || _prevAssist.includes('---SPECDEEP---')) &&
      ['1', '2', 'seguir', 'cancelar', 'confirmar', 'confirma', 'cancela', 'sim', 'nao', 'não', 'reaproveitar', 'criar', 'criar novos', 'criar mesmo assim'].includes(_lastUser);

    if (!_isConfirmFollowup) {
      // (a) Modelo gratuito + comando que exige modelo moderno → bloqueio roxo
      if (usesFree && MODERN_REQUIRED.includes(command)) {
        return res.json({
          choices: [{ message: { content:
            '[[BLOCK-MODERN]]\n## \ud83d\udfe3 Modelo moderno necessario\n\n' +
            'As funcionalidades **Spec, Deploy e Delete** devem ser executadas com **modelos modernos** (Claude ou Grok), ' +
            'pela criticidade tecnica e por envolverem a org.\n\n' +
            'Selecione **Claude** ou **Grok** no seletor de modelo para continuar.\n[[/BLOCK-MODERN]]'
          } }],
          tipo: command, modelo_label: 'Bloqueado',
        });
      }
      // (b) Limite de tokens (modo pago/auto, comandos de IA)
      if (!usesFree && !MCP_ONLY.includes(command)) {
        const limit = req.user?.token_limit;
        if (limit && Number(limit) > 0) {
          const used = await getMonthlyUsage(req.user.id);
          if (used >= Number(limit)) {
            if (FREE_ALLOWED.includes(command)) {
              return res.json({
                choices: [{ message: { content:
                  '[[LIMIT-EXCEEDED]]\n## \ud83d\udd34 Limite de tokens excedido\n\n' +
                  'O limite de tokens designados ao seu usuario foi excedido. ' +
                  'Contate o administrador ou escolha uma das opcoes abaixo:\n[[FREE-BUTTONS]]\n[[/LIMIT-EXCEEDED]]'
                } }],
                tipo: command, modelo_label: 'Limite excedido',
              });
            } else {
              return res.json({
                choices: [{ message: { content:
                  '[[LIMIT-EXCEEDED]]\n## \ud83d\udd34 Limite de tokens excedido\n\n' +
                  'O limite de tokens designados ao seu usuario foi excedido. Esta funcionalidade exige um ' +
                  '**modelo moderno** (Claude/Grok) e nao pode usar modelos gratuitos. Contate o administrador para liberar.\n[[/LIMIT-EXCEEDED]]'
                } }],
                tipo: command, modelo_label: 'Limite excedido',
              });
            }
          }
        }
      }
    }

    // ── Follow-up de /spec deep: usuario decidiu sobre os conflitos ──
    const _isSpecDeepFollowup = _prevAssist.includes('---SPECDEEP---') &&
      ['1', '2', 'reaproveitar', 'criar', 'criar novos', 'criar mesmo assim'].includes(_lastUser);
    if (_isSpecDeepFollowup && (userRole === 'admin' || checkPermission(userRole, 'spec'))) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');
      const kaF = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      try {
        const m = _prevAssist.match(/---SPECDEEP---\s*([\s\S]*?)\s*---FIM---/);
        const data = m ? JSON.parse(m[1]) : { requirement: '', orgName: '', conflicts: [] };
        const reuse = ['1', 'reaproveitar'].includes(_lastUser);
        const decisionNote = reuse
          ? 'O usuario decidiu REAPROVEITAR os campos ja existentes. NAO especifique a criacao desses campos; indique reutilizar os existentes na org.'
          : 'O usuario decidiu CRIAR novos campos mesmo assim. Especifique a criacao normalmente.';
        const existListing = (data.conflicts || []).map(cf => {
          const diverge = (cf.existingType || '').toLowerCase() !== (cf.proposedType || '').toLowerCase();
          return '- ' + cf.object + '.' + cf.field + ' (existe como ' + cf.existingType + (diverge ? ', DIVERGE do tipo sugerido ' + cf.proposedType + ' - apenas AVISE na spec' : '') + ')';
        }).join('\n');
        const augmented = (data.requirement || '') +
          '\n\n[CONTEXTO DA ORG ' + (data.orgName || '') + ' - validado somente leitura]\nCampos ja existentes relevantes:\n' +
          existListing + '\n\nDecisao do usuario: ' + decisionNote;
        const readable = await claude.stream(specPrompt, [{ role: 'user', content: augmented }], 48000);
        const out = await collectStream(readable);
        clearInterval(kaF);
        res.end(JSON.stringify({ choices: [{ message: { content: out } }], modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet 4.6', tipo: 'spec' }));
        return;
      } catch (err) {
        clearInterval(kaF);
        res.end(JSON.stringify({ choices: [{ message: { content: 'Erro ao gerar spec deep: ' + err.message } }], tipo: 'spec' }));
        return;
      }
    }

    // Verificar permissão
    if (userRole !== 'admin' && !checkPermission(userRole, command)) {
      return res.json({
        choices: [{ message: { content: '🔒 **Comando não disponível**\n\nSeu perfil **' + userRole + '** não tem acesso a este comando.\n\n' + (userRole === 'candidato' ? 'Você pode usar o chat normalmente para fazer perguntas.' : 'Comandos disponíveis: ' + (ROLE_PERMISSIONS[userRole] || []).map(c => '/' + c).join(', ')) + '\n\nPrecisa de mais acesso? Fale com o administrador.' } }],
        modelo_usado: 'system',
        modelo_label: 'Sistema',
        tipo: 'error',
      });
    }
    let response, modelUsed, modelLabel;

    // ── SPEC: Claude Sonnet com streaming interno ──
    if (command === 'spec') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');
      const readable = await claude.stream(specPrompt, messages, 48000);
      const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      response = await collectStream(readable);
      clearInterval(keepAlive);
      res.end(JSON.stringify({
        choices: [{ message: { content: response } }],
        modelo_usado: 'claude-sonnet-4-6',
        modelo_label: 'Claude Sonnet 4.6',
        tipo: 'spec',
      }));
      return;
    }

    // ── SPEC DEEP: valida campos contra a org (SOMENTE LEITURA) antes de gerar ──
    if (command === 'spec-deep') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');
      const keepAliveSD = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      try {
        const reqText = messages[messages.length - 1].content.replace(/\/spec[\s-]deep\s*/i, '').trim();
        const orgSD = await getSelectedOrg(req);
        const orgNameSD = orgSD ? orgSD.name : 'Dev Org (padrao)';

        // Passada 1: extrair data model proposto (objetos + campos custom)
        const extractPrompt = 'Voce e um arquiteto Salesforce. Dado um requisito, liste APENAS os objetos Salesforce e os campos customizados que precisariam ser CRIADOS para atende-lo. Responda SOMENTE com JSON valido, sem markdown nem texto extra, no formato exato: {"objects":[{"name":"Lead","fields":[{"name":"Score__c","type":"Number"}]}]}. Use API names (sufixo __c nos customizados). Use nomes de objetos padrao quando aplicavel (Lead, Opportunity, Account, Contact, Case, Quote, Order, Asset, Contract). Nao inclua campos padrao.';
        let proposed = { objects: [] };
        try {
          const raw = await claude.call(extractPrompt, [{ role: 'user', content: reqText }], 1500);
          proposed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch (e) { proposed = { objects: [] }; }

        // Comparar proposto x existente (SOMENTE LEITURA: describe)
        const conflicts = [];
        for (const obj of (proposed.objects || [])) {
          const existing = {};
          try {
            const desc = await execDescribe(req, obj.name);
            const fields = desc?.fields || desc?.result?.fields || [];
            for (const fd of fields) { if (fd && fd.name) existing[fd.name.toLowerCase()] = fd.type || fd.soapType || '?'; }
          } catch {}
          for (const fd of (obj.fields || [])) {
            const key = (fd.name || '').toLowerCase();
            if (key && existing[key]) {
              conflicts.push({ object: obj.name, field: fd.name, existingType: existing[key], proposedType: fd.type || '?' });
            }
          }
        }

        clearInterval(keepAliveSD);

        if (conflicts.length > 0) {
          const lines = [];
          lines.push('[[SPEC-CONFLICT]]');
          lines.push('## \u26a0\ufe0f Campos ja existentes na org');
          lines.push('');
          lines.push('### \ud83c\udfe2 Org consultada (somente leitura): ' + orgNameSD);
          lines.push('');
          lines.push('Encontrei campos que o requisito criaria, mas que **ja existem** na org:');
          lines.push('');
          lines.push('| Objeto | Campo | Tipo existente | Tipo sugerido |');
          lines.push('|---|---|---|---|');
          for (const cf of conflicts) {
            const diverge = (cf.existingType || '').toLowerCase() !== (cf.proposedType || '').toLowerCase();
            lines.push('| ' + cf.object + ' | ' + cf.field + ' | ' + cf.existingType + (diverge ? ' \u26a0\ufe0f' : '') + ' | ' + cf.proposedType + ' |');
          }
          lines.push('');
          lines.push('\u26a0\ufe0f = divergencia de tipo (a spec apenas avisa, nao altera nada na org).');
          lines.push('');
          lines.push('Como proceder?');
          lines.push('[[SPEC-BTNS]]');
          lines.push('[[/SPEC-CONFLICT]]');
          lines.push('');
          lines.push('---SPECDEEP---');
          lines.push(JSON.stringify({ requirement: reqText, orgName: orgNameSD, conflicts }));
          lines.push('---FIM---');
          res.end(JSON.stringify({ choices: [{ message: { content: lines.join('\n') } }], tipo: 'spec-deep', modelo_label: 'Validacao org' }));
          return;
        }

        // Sem conflitos: gera direto, com nota de validacao
        const augmented = reqText + '\n\n[CONTEXTO: validado contra a org ' + orgNameSD + ' (somente leitura) - nenhum campo conflitante encontrado.]';
        res.write(' ');
        const ka2 = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
        const readableSD = await claude.stream(specPrompt, [{ role: 'user', content: augmented }], 48000);
        const specOut = await collectStream(readableSD);
        clearInterval(ka2);
        res.end(JSON.stringify({ choices: [{ message: { content: specOut } }], modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet 4.6', tipo: 'spec' }));
        return;
      } catch (err) {
        clearInterval(keepAliveSD);
        res.end(JSON.stringify({ choices: [{ message: { content: 'Erro no /spec deep: ' + err.message } }], tipo: 'spec-deep' }));
        return;
      }
    }

    // ── DEPLOY: Claude smart deploy (lê org + decide + executa) ──
    if (command === 'deploy') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');

      const userReq = messages[messages.length - 1].content.replace(/\/deploy\s*/i, '').trim();
      const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      const selectedOrgDeploy = await getSelectedOrg(req);
      const baseDeploy = 'http://localhost:' + (process.env.PORT || 3000);

      // 1. Ler estado da org
      let orgContextDeploy = '';
      try {
        const reqLower = userReq.toLowerCase();
        const metadataReads = [];
        const sfObjects = ['Lead','Opportunity','Account','Contact','Case','Quote','Order','Contract','Campaign','Product2','Asset'];
        for (const obj of sfObjects) {
          if (reqLower.includes(obj.toLowerCase())) {
            try {
              const desc = await execDescribe(req, obj);
              metadataReads.push({ type: 'Describe_' + obj, fields: (desc.fields || []).slice(0, 40).map(f => f.name + ' (' + f.type + (f.custom ? ', custom' : '') + ')') });
            } catch {}
          }
        }
        orgContextDeploy = JSON.stringify(metadataReads, null, 2);
      } catch {}

      // 2. Claude decide o que fazer
      let smartDeploy;
      try {
        const deploySmartPrompt = [
          'Voce e um ARQUITETO SALESFORCE SENIOR. Implemente o requisito abaixo na org.',
          '',
          'ESTADO ATUAL DA ORG:', orgContextDeploy || 'Nao disponivel',
          '',
          'REQUISITO:', userReq,
          '',
          'Retorne JSON com steps e opcionalmente code (Apex/LWC):',
          '{',
          '  "steps": [',
          '    {"type":"metadata-create","metadataType":"CustomField","body":{"fullName":"Obj.Campo__c","label":"Label","type":"Text","length":100},"description":"Descricao"},',
          '    {"type":"add-to-layout","object":"Lead","field":"Campo__c","section":"Lead Information","layout":"Lead-Lead Layout","description":"Descricao"},',
          '    {"type":"add-permission","field":"Lead.Campo__c","permissionSetName":"Nome_PS","permissionSetLabel":"Label PS","description":"Descricao"},',
          '    {"type":"metadata-update","metadataType":"Tipo","body":{...},"description":"Descricao"},',
          '    {"type":"execute-apex","code":"codigo apex","description":"Descricao"},',
          '    {"type":"delete-metadata","metadataType":"CustomField","fullName":"Lead.Campo__c","description":"Descricao"},',
          '    {"type":"setup-instruction","step":"Caminho no Setup","setupUrl":"/lightning/setup/...","description":"Descricao"}',
          '  ],',
          '  "code": { "apexClasses": [], "lwc": [], "apexTriggers": [] },',
          '  "summary": "Resumo do que sera feito"',
          '}',
          '',
          'REGRAS:',
          '- HIERARQUIA: metadata-create > add-to-layout > add-permission > code > setup-instruction',
          '- Picklist: valueSet com valueSetDefinition e value array [{fullName,label,default:false}]',
          '- Layout name formato: {Object}-{Object} Layout (ex: Lead-Lead Layout)',
          '- Permission field formato: {Object}.{Campo__c}',
          '- SEMPRE incluir add-to-layout e add-permission para novos campos',
          '- Se precisa Apex/LWC, inclua codigo COMPLETO em code',
          '- EXCLUSAO E SUPORTADA: para deletar campo use delete-metadata com metadataType=CustomField e fullName=Objeto.Campo__c (ex: Lead.Origem__c)',
          '- delete-metadata tambem serve para ValidationRule (Objeto.Regra), WebLink, etc. NAO use setup-instruction para excluir campos',
          '- setup-instruction APENAS se REALMENTE impossivel via API (ex: LeadConvertSettings em Dev Edition), com setupUrl',
          '- Responda APENAS JSON, sem markdown',
        ].join('\n');

        const smartResp = await claude.call(deploySmartPrompt, [{ role: 'user', content: 'Implemente: ' + userReq }], 16384);
        const jsonStart = smartResp.indexOf('{');
        const jsonEnd = smartResp.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          smartDeploy = JSON.parse(smartResp.slice(jsonStart, jsonEnd + 1));
        }
      } catch (aiErr) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '\u274c Erro ao planejar deploy: ' + aiErr.message } }],
          modelo_usado: 'claude', modelo_label: 'Claude Sonnet', tipo: 'deploy',
        }));
        return;
      }

      if (!smartDeploy?.steps?.length) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '\u274c Nao foi possivel planejar o deploy. Tente com mais detalhes.' } }],
          modelo_usado: 'claude', modelo_label: 'Claude Sonnet', tipo: 'deploy',
        }));
        return;
      }

      // 3. DRY-RUN: mostrar preview do plano (nao executa ainda)
      clearInterval(keepAlive);
      const orgNameDeploy = selectedOrgDeploy ? selectedOrgDeploy.name : 'Dev Org (padrao)';
      res.end(JSON.stringify({
        choices: [{ message: { content: formatDeployPreview(smartDeploy, orgNameDeploy) } }],
        modelo_usado: 'claude-sonnet-4-6',
        modelo_label: 'Claude Sonnet (Preview)',
        tipo: 'deploy',
      }));
      return;
    }

    // ── DELETE: exclui metadado com dry-run obrigatorio ──
    if (command === 'delete') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');

      const delReq = messages[messages.length - 1].content.replace(/\/del(ete)?\s*/i, '').trim();
      const kaDel = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      const baseDel = 'http://localhost:' + (process.env.PORT || 3000);

      // Ler contexto da org pra resolver nomes exatos
      let orgCtxDel = '';
      try {
        const reqLower = delReq.toLowerCase();
        const sfObjs = ['Lead','Opportunity','Account','Contact','Case','Quote','Order','Contract','Campaign','Product2','Asset'];
        for (const obj of sfObjs) {
          if (reqLower.includes(obj.toLowerCase())) {
            const desc = await execDescribe(req, obj);
            const customFields = (desc.fields || []).filter(f => f.custom).map(f => f.name);
            if (customFields.length) orgCtxDel += obj + ' campos custom: ' + customFields.join(', ') + '\n';
          }
        }
      } catch {}

      // Claude monta o plano de exclusao
      let delPlan;
      try {
        const delPrompt = [
          'Voce e um ARQUITETO SALESFORCE. O usuario quer EXCLUIR metadados da org.',
          '',
          'CONTEXTO DA ORG:', orgCtxDel || 'Nao disponivel',
          '',
          'PEDIDO DE EXCLUSAO:', delReq,
          '',
          'Retorne JSON com os steps de exclusao:',
          '{',
          '  "steps": [',
          '    {"type":"delete-metadata","metadataType":"CustomField","fullName":"Lead.Campo__c","description":"Excluir campo X"},',
          '    {"type":"delete-metadata","metadataType":"ValidationRule","fullName":"Lead.Regra","description":"Excluir VR Y"}',
          '  ],',
          '  "summary":"Resumo do que sera excluido"',
          '}',
          '',
          'REGRAS:',
          '- metadataType: CustomField (campos), ValidationRule (regras), WebLink, CustomObject (objetos), Layout, etc.',
          '- fullName de campo: Objeto.Campo__c (ex: Lead.Origem__c)',
          '- fullName de VR: Objeto.NomeRegra',
          '- Use os nomes EXATOS do contexto da org. Se o usuario deu nome aproximado, encontre o match no contexto',
          '- Se nao encontrar o componente no contexto, ainda assim monte o step com o nome fornecido',
          '- Responda APENAS JSON, sem markdown',
        ].join('\n');
        const delResp = await claude.call(delPrompt, [{ role: 'user', content: 'Excluir: ' + delReq }], 4096);
        const js = delResp.indexOf('{'); const je = delResp.lastIndexOf('}');
        if (js !== -1 && je !== -1) delPlan = JSON.parse(delResp.slice(js, je + 1));
      } catch (e) {
        clearInterval(kaDel);
        res.end(JSON.stringify({ choices: [{ message: { content: '\u274c Erro ao planejar exclusao: ' + e.message } }], modelo_usado: 'claude', modelo_label: 'Claude', tipo: 'delete' }));
        return;
      }

      if (!delPlan?.steps?.length) {
        clearInterval(kaDel);
        res.end(JSON.stringify({ choices: [{ message: { content: '\u274c Nao identifiquei o que excluir. Seja especifico (ex: "/delete campo Origem__c do Lead").' } }], modelo_usado: 'claude', modelo_label: 'Claude', tipo: 'delete' }));
        return;
      }

      // Preview com aviso forte (delete e irreversivel)
      clearInterval(kaDel);
      const orgNameDel = (await getSelectedOrg(req))?.name || 'Dev Org (padrao)';
      const lines = [];
      lines.push('[[CONFIRM-BOX]]');
      lines.push('## \u26a0\ufe0f Confirmacao de Exclusao');
      lines.push('');
      lines.push('### \ud83c\udfe2 Org de destino: ' + orgNameDel);
      if (delPlan.summary) { lines.push(''); lines.push('**' + delPlan.summary + '**'); }
      lines.push('');
      lines.push('### Sera excluido:');
      lines.push('| # | Tipo | Componente |');
      lines.push('|---|---|---|');
      delPlan.steps.forEach((s, i) => {
        lines.push('| ' + (i + 1) + ' | ' + (s.metadataType || 'Metadata') + ' | ' + (s.fullName || s.description) + ' |');
      });
      lines.push('');
      lines.push('\u26a0\ufe0f **Exclusao e irreversivel** (soft-delete de 15 dias). Nada foi excluido ainda.');
      lines.push('');
      lines.push('[[BTN-CONFIRM:Seguir e excluir]]');
      lines.push('[[/CONFIRM-BOX]]');
      lines.push('');
      lines.push('---PLAN---');
      lines.push(JSON.stringify(delPlan));
      lines.push('---FIM---');

      res.end(JSON.stringify({
        choices: [{ message: { content: lines.join('\n') } }],
        modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet (Delete Preview)', tipo: 'delete',
      }));
      return;
    }

    // ── PROTOTIPO: gera HTML + resumo HF + resumo Spec ──
    if (command === 'prototipo') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');

      const protoReq = messages[messages.length - 1].content.replace(/\/proto(tipo)?\s*/i, '').trim();
      const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

      let protoText;
      try {
        protoText = await grok.call(prototipoPrompt, [{ role: 'user', content: protoReq }], 16384);
      } catch (err) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '\u274c Erro ao gerar prototipo: ' + err.message } }],
          modelo_usado: 'grok', modelo_label: 'Grok', tipo: 'prototipo',
        }));
        return;
      }

      clearInterval(keepAlive);

      // Parsear blocos
      const htmlMatch = protoText.match(/---HTML---(\s*[\s\S]*?)---HF---/);
      const hfMatch = protoText.match(/---HF---(\s*[\s\S]*?)---SPEC---/);
      const specMatch = protoText.match(/---SPEC---(\s*[\s\S]*?)---MANIFEST---/);
      const manifestMatch = protoText.match(/---MANIFEST---(\s*[\s\S]*?)---FIM---/);

      const htmlContent = htmlMatch ? htmlMatch[1].trim() : '';
      const hfResumo = hfMatch ? hfMatch[1].trim() : 'Nao foi possivel gerar resumo HF';
      const specResumo = specMatch ? specMatch[1].trim() : 'Nao foi possivel gerar resumo Spec';

      let manifest = null;
      if (manifestMatch) {
        try { manifest = JSON.parse(manifestMatch[1].trim()); } catch {}
        if (!manifest) {
          const jsonStr = manifestMatch[1].match(/\{[\s\S]*\}/);
          if (jsonStr) try { manifest = JSON.parse(jsonStr[0]); } catch {}
        }
      }

      // Salvar HTML como arquivo acessivel
      let protoUrl = '';
      if (htmlContent) {
        const protoDir = '/tmp/prototipos';
        if (!existsSync(protoDir)) mkdirSync(protoDir, { recursive: true });
        const protoId = randomBytes(6).toString('hex');
        writeFileSync(protoDir + '/' + protoId + '.html', htmlContent);
        const host = req.headers.host || 'everi9.albertobottaro.info';
        protoUrl = 'https://' + host + '/prototipos/' + protoId + '.html';
      }

      // Montar resposta
      const lines = [];
      lines.push('## \u2705 Prototipo gerado!');
      lines.push('');
      if (protoUrl) {
        lines.push('### \ud83d\udd17 Prototipo interativo');
        lines.push('[\u27a1 Abrir prototipo](' + protoUrl + ')');
        lines.push('');
      }
      lines.push('### \ud83d\udcdd Resumo da Historia Funcional');
      lines.push(hfResumo);
      lines.push('');
      lines.push('### \ud83d\udee0 Resumo da Especificacao Tecnica');
      lines.push(specResumo);
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('**O que deseja fazer?**');
      lines.push('');
      lines.push('**1** \u2014 Gerar Historia Funcional completa');
      lines.push('');
      lines.push('**2** \u2014 Gerar Especificacao Tecnica completa');
      lines.push('');
      lines.push('**3** \u2014 Realizar deploy na org');
      lines.push('');
      lines.push('Digite o numero para prosseguir.');

      // Incluir manifest oculto na resposta para o follow-up de deploy
      if (manifest) {
        lines.push('');
        lines.push('---MANIFEST---');
        lines.push(JSON.stringify(manifest));
        lines.push('---FIM---');
      }

      res.end(JSON.stringify({
        choices: [{ message: { content: lines.join('\n') } }],
        modelo_usado: 'grok',
        modelo_label: 'Grok',
        tipo: 'prototipo',
        protoUrl,
      }));
      return;
    }

    // ── FOLLOW-UP: detectar 1, 2, 3 apos /prototipo ──
    if ((command === 'chat') && messages.length >= 2) {
      const lastUser = (messages[messages.length - 1]?.content || '').trim();
      const prevAssistant = messages[messages.length - 2]?.content || '';

      // ── CONFIRMAR deploy apos preview (dry-run) ──
      const isDryRunPreview = prevAssistant.includes('---PLAN---') && (prevAssistant.includes('Confirmacao de Deploy') || prevAssistant.includes('Confirmacao de Exclusao') || prevAssistant.includes('Preview do Deploy'));
      if (isDryRunPreview && ['confirmar', 'confirma', 'sim', '1', 'seguir'].includes(lastUser.toLowerCase())) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const kaConfirm = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        // Extrair plano embutido
        let plan = null;
        const pm = prevAssistant.match(/---PLAN---([\s\S]*?)---FIM---/);
        if (pm) { try { plan = JSON.parse(pm[1].trim()); } catch {} }

        if (!plan?.steps?.length) {
          clearInterval(kaConfirm);
          res.end(JSON.stringify({
            choices: [{ message: { content: '\u274c Nao consegui recuperar o plano. Rode o /deploy novamente.' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'deploy',
          }));
          return;
        }

        // Executar
        const deployResults = await runDeploySteps(plan, req);
        clearInterval(kaConfirm);
        res.end(JSON.stringify({
          choices: [{ message: { content: formatDeployResult(plan, deployResults) } }],
          modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet (Deploy)', tipo: 'deploy',
        }));
        return;
      }

      // Cancelar deploy
      if (isDryRunPreview && ['cancelar', 'cancela', 'nao', 'não', '2'].includes(lastUser.toLowerCase())) {
        res.json({
          choices: [{ message: { content: 'Deploy cancelado. Nada foi alterado na org.' } }],
          modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'deploy',
        });
        return;
      }

      const isArchFollowup = prevAssistant.includes('Gerar Spec tecnica com base no gap') && prevAssistant.includes('Deploy do que falta na org');

      if (isArchFollowup && ['1', '2'].includes(lastUser)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const keepAliveArchF = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        if (lastUser === '1') {
          // Gerar Spec com base no gap
          const specFromGap = await claude.call(specPrompt, [{ role: 'user', content: 'Gere a Especificacao Tecnica com base nesta analise de gap:\n\n' + prevAssistant }], 16384);
          clearInterval(keepAliveArchF);
          res.end(JSON.stringify({
            choices: [{ message: { content: specFromGap } }],
            modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet 4.6', tipo: 'spec',
          }));
          return;
        }

        if (lastUser === '2') {
          // Extrair gaps e deployar — redirecionar pro smart deploy
          const selectedOrgArchF = await getSelectedOrg(req);
          const orgName = selectedOrgArchF ? selectedOrgArchF.name : 'Dev Org (padrao)';
          clearInterval(keepAliveArchF);
          res.end(JSON.stringify({
            choices: [{ message: { content: '## \ud83d\ude80 Deploy\n\n**Org selecionada:** ' + orgName + '\n\nDeseja confirmar o deploy do que falta nesta org?\n\n**sim** \u2014 Confirmar e deployar\n\n**nao** \u2014 Cancelar' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'arch',
          }));
          return;
        }
      }

      const isProtoFollowup = prevAssistant.includes('Gerar Historia Funcional completa') && prevAssistant.includes('Realizar deploy na org');

      if (isProtoFollowup && ['1', '2', '3'].includes(lastUser)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const keepAlive2 = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        // Extrair contexto do prototipo (resumos da mensagem anterior)
        const contexto = prevAssistant;

        if (lastUser === '1') {
          // Gerar HF completa
          const hfFull = await grok.call(hfPrompt, [{ role: 'user', content: 'Com base neste contexto, gere a Historia Funcional completa:\n\n' + contexto }], 16384);
          clearInterval(keepAlive2);
          res.end(JSON.stringify({
            choices: [{ message: { content: hfFull } }],
            modelo_usado: 'grok', modelo_label: 'Grok', tipo: 'hf',
          }));
          return;
        }

        if (lastUser === '2') {
          // Gerar Spec completa via Claude
          const readable = await claude.stream(specPrompt, [{ role: 'user', content: 'Com base neste contexto, gere a Especificacao Tecnica completa:\n\n' + contexto }]);
          const specFull = await collectStream(readable);
          clearInterval(keepAlive2);
          res.end(JSON.stringify({
            choices: [{ message: { content: specFull } }],
            modelo_usado: 'claude-sonnet-4-6', modelo_label: 'Claude Sonnet 4.6', tipo: 'spec',
          }));
          return;
        }

        if (lastUser === '3') {
          // Deploy — extrair manifest de TODO o historico
          let manifest = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i].content || '';
            const mm = msg.match(/---MANIFEST---(\s*[\s\S]*?)---FIM---/);
            if (mm) {
              try { manifest = JSON.parse(mm[1].trim()); } catch {
                const jm = mm[1].match(/\{[\s\S]*\}/);
                if (jm) try { manifest = JSON.parse(jm[0]); } catch {}
              }
            }
            if (manifest) break;
          }

          // Verificar org selecionada
          const selectedOrg = await getSelectedOrg(req);
          const orgName = selectedOrg ? selectedOrg.name : 'Dev Org (padrao)';

          clearInterval(keepAlive2);
          res.end(JSON.stringify({
            choices: [{ message: { content: '## \ud83d\ude80 Deploy\n\n**Org selecionada:** ' + orgName + '\n\nDeseja confirmar o deploy nesta org?\n\n**sim** \u2014 Confirmar e deployar\n\n**nao** \u2014 Cancelar' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'prototipo',
            manifest: manifest ? JSON.stringify(manifest) : null,
          }));
          return;
        }
      }

      // Detectar confirmacao de deploy (sim/nao)
      const isDeployConfirm = prevAssistant.includes('Deseja confirmar o deploy nesta org');
      if (isDeployConfirm && (lastUser.toLowerCase() === 'sim' || lastUser.toLowerCase() === 's')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const keepAlive3 = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        // ── SMART DEPLOY: ler estado da org + IA decide o que fazer ──
        const selectedOrg = await getSelectedOrg(req);
        const base = 'http://localhost:' + (process.env.PORT || 3000);

        // Extrair contexto original do historico
        let originalReq = '';
        for (const m of messages) {
          if (m.role === 'user' && (m.content || '').toLowerCase().startsWith('/proto')) {
            originalReq = m.content;
            break;
          }
        }

        // Ler metadados relevantes da org (DINAMICO baseado no requisito)
        let orgContext = '';
        try {
          const reqLower = originalReq.toLowerCase();
          const metadataReads = [];

          // Detectar objetos mencionados e descrever
          const sfObjects = ['Lead','Opportunity','Account','Contact','Case','Quote','Order','Contract','Campaign','Task','Event','Product2','PricebookEntry','OpportunityLineItem','Asset','Entitlement'];
          for (const obj of sfObjects) {
            if (reqLower.includes(obj.toLowerCase())) {
              try {
                const desc = await execDescribe(req, obj);
                metadataReads.push({ type: 'Describe_' + obj, fields: (desc.fields || []).slice(0, 40).map(f => f.name + ' (' + f.type + (f.custom ? ', custom' : '') + ')') });
              } catch {}
            }
          }

          // Detectar settings relevantes
          const settingsMap = {
            'forecast': ['ForecastingSettings', 'Forecasting'],
            'territory': ['Territory2Settings', 'Territory2'],
            'lead convert': ['LeadConvertSettings', 'LeadConvert'],
            'case': ['CaseSettings', 'Case'],
            'knowledge': ['KnowledgeSettings', 'Knowledge'],
            'opportunity': ['OpportunitySettings', 'Opportunity'],
            'activity': ['ActivitySettings', 'Activity'],
            'sharing': ['SharingSettings', 'Sharing'],
          };
          for (const [keyword, [metaType, fullName]] of Object.entries(settingsMap)) {
            if (reqLower.includes(keyword)) {
              try {
                const mdata = await execMetadataRead(req, metaType, fullName);
                metadataReads.push({ type: metaType, data: mdata });
              } catch {}
            }
          }

          // Se nenhum objeto detectado, descrever os mais comuns
          if (metadataReads.length === 0) {
            try {
              const desc = await execDescribe(req, 'Opportunity');
              metadataReads.push({ type: 'Describe_Opportunity', fields: (desc.fields || []).slice(0, 20).map(f => f.name + ' (' + f.type + ')') });
            } catch {}
          }

          orgContext = JSON.stringify(metadataReads, null, 2);
        } catch (readErr) {
          orgContext = 'Erro ao ler metadata: ' + readErr.message;
        }

        // Pedir ao Grok para gerar os comandos EXATOS baseado no estado real da org
        let smartCommands;
        try {
          const smartPrompt = [
            'Voce e um ARQUITETO SALESFORCE SENIOR com capacidade de IMPLEMENTAR qualquer solucao.',
            'Sua funcao: receber um requisito + estado atual da org e retornar TUDO que precisa ser feito para implementar.',
            'Voce TEM que resolver. NAO existe "nao e possivel". Sempre ha um caminho: metadata API, Apex, LWC, Flow metadata, ou combinacao.',
            '',
            'INSTANCE URL DA ORG: ' + (selectedOrg?.login_url || 'https://orgfarm-6450ce60e0-dev-ed.develop.my.salesforce.com'),
            '',
            'ESTADO ATUAL DA ORG:',
            orgContext,
            '',
            'REQUISITO ORIGINAL:',
            originalReq,
            '',
            'Gere um JSON com array de steps. Cada step tem:',
            '- type: "metadata-update" | "metadata-create" | "execute-apex" | "setup-instruction"',
            '- Para metadata-update: metadataType, body (JSON COMPLETO do metadata atualizado)',
            '- Para add-to-layout: object (ex: Lead), field (ex: MCP_Server__c), section (ex: Lead Information), layout (FORMATO: {Object}-{Object} Layout, ex: Lead-Lead Layout, Account-Account Layout)',
            '- Para add-permission: field (ex: Lead.MCP_Server__c) ou fields (array), permissionSetName, permissionSetLabel',
            '- Para execute-apex: code (codigo Apex anonimo)',
            '- Para setup-instruction: step (caminho COMPLETO no Setup), setupUrl (URL direta do Setup Lightning, ex: /lightning/setup/Forecasting/home, /lightning/setup/ObjectManager/Lead/FieldsAndRelationships/view, /lightning/setup/PermSets/home)',
            '- setupUrl OBRIGATORIO em setup-instruction. Use o path Lightning Setup correto. Exemplos:',
            '  Forecasts: /lightning/setup/Forecasting/home',
            '  Fields: /lightning/setup/ObjectManager/{Objeto}/FieldsAndRelationships/view',
            '  Permission Sets: /lightning/setup/PermSets/home',
            '  Sharing: /lightning/setup/SecuritySharing/home',
            '  Profiles: /lightning/setup/EnhancedProfiles/home',
            '  Flows: /lightning/setup/Flows/home',
            '  Custom Metadata: /lightning/setup/CustomMetadata/home',
            '  Assignment Rules: /lightning/setup/LeadRules/home',
            '  Validation Rules: /lightning/setup/ObjectManager/{Objeto}/ValidationRules/view',
            '- description: descricao do que o passo faz',
            '',
            'REGRAS CRITICAS:',
            '- HIERARQUIA OBRIGATORIA: 1) metadata-update/create 2) Apex+LWC via code 3) setup-instruction (ULTIMO RECURSO)',
            '- Se metadata API nao resolve, GERE CODIGO Apex + LWC que resolve o problema e coloque em code',
            '- NUNCA retorne APENAS setup-instruction. Se nao da pra fazer via metadata, CRIE o codigo',
            '- O campo code com apexClasses e lwc sera deployado automaticamente na org',
            '- setup-instruction so para config de UI pura (ex: arrastar coluna, reordenar layout) que NENHUM codigo resolve',
            '',
            'REGRAS DO CODIGO:',
            '- Apex: classes completas, compilaveis, com @AuraEnabled e with sharing',
            '- LWC: js com @wire/@api, html com lightning-datatable ou lightning-card, meta.xml com targets corretos',
            '- Todo codigo deve ser funcional e pronto pra producao, nao placeholder',
            '',
            'REGRAS GERAIS:',
            '- Analise o estado atual e gere APENAS as mudancas necessarias',
            '- Se a config ja esta ativa, NAO repita',
            '- Para ForecastingSettings: envie o metadata COMPLETO com as alteracoes incluidas',
            '- Se NAO for possivel via API, use setup-instruction com o caminho EXATO',
            '- Responda APENAS com o JSON, sem markdown nem explicacao',
            '',
            'FORMATO:',
            '{',
            '  "steps": [...],',
            '  "summary": "descricao do que sera feito",',
            '  "code": {',
            '    "apexClasses": [{"name":"NomeClasse","body":"codigo apex completo"}],',
            '    "lwc": [{"name":"nomeComponente","js":"codigo js","html":"template html","meta":"xml meta"}],',
            '    "apexTriggers": [{"name":"NomeTrigger","body":"codigo trigger","object":"Opportunity"}]',
            '  }',
            '}',
            '',
            'REGRAS DE CODE (OBRIGATORIAS):',
            '- Se metadata API nao resolve SOZINHA, GERE codigo Apex + LWC que resolve',
            '- apexClasses: codigo .cls COMPLETO, compilavel, com @AuraEnabled, with sharing, SOQL correto',
            '- lwc: js (@wire/@api), html (lightning-datatable/lightning-card), meta.xml (isExposed=true, targets)',
            '- O codigo sera deployado automaticamente na org — precisa compilar de primeira',
            '- NUNCA diga "crie manualmente" ou "copie e cole" — o sistema FAZ o deploy',
            '- Se NAO precisa de codigo (metadata resolve tudo), code pode ser null',
            '',
            'HIERARQUIA (siga nesta ordem):',
            '1. metadata-create → campos, validation rules, record types',
            '   add-to-layout → adicionar campo ao layout (object, field, section)',
            '   add-permission → dar permissão no campo (field no formato Objeto.Campo__c)',
            '2. code (Apex + LWC) → logica customizada, telas, calculos, integracao',
            '3. setup-instruction → APENAS se e impossivel via codigo (ex: ativar feature flag na UI)',
            '   Quando usar setup-instruction, SEMPRE inclua setupUrl com o path Lightning Setup',
            '',
            'EXEMPLOS DE setupUrl:',
            '  /lightning/setup/Forecasting/home',
            '  /lightning/setup/ObjectManager/{Obj}/FieldsAndRelationships/view',
            '  /lightning/setup/PermSets/home',
            '  /lightning/setup/Flows/home',
            '  /lightning/setup/SecuritySharing/home',
            '  /lightning/setup/EnhancedProfiles/home',
            '  /lightning/setup/CustomMetadata/home'
          ].join('\n');

          const smartResp = await claude.call(smartPrompt, [{ role: 'user', content: 'Gere os comandos JSON para implementar o requisito. NUNCA retorne apenas setup-instruction. Se metadata API nao suporta, GERE codigo Apex + LWC completo no campo code.' }], 16384);
          
          // Parsear resposta
          const jsonStart = smartResp.indexOf('{');
          const jsonEnd = smartResp.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd !== -1) {
            smartCommands = JSON.parse(smartResp.slice(jsonStart, jsonEnd + 1));
          }
        } catch (aiErr) {
          smartCommands = null;
        }

        const deployResults = [];

        if (smartCommands?.steps?.length) {
          // Executar cada step
          for (const step of smartCommands.steps) {
            try {
              if (step.type === 'metadata-update') {
                const r = await fetch(base + '/api/metadata-update/' + step.metadataType, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(step.body),
                });
                const result = await r.json();
                const ok = result.success !== false;
                deployResults.push({
                  component: (step.description || 'Config: ' + step.metadataType),
                  success: ok, errors: result.errors || [],
                });
                if (!ok && step.fallbackInstruction) {
                  deployResults.push({ component: step.fallbackInstruction, success: true, manual: true, errors: [] });
                }

              } else if (step.type === 'metadata-create') {
                const r = await fetch(base + '/api/metadata-create/' + step.metadataType, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(step.body),
                });
                const result = await r.json();
                // Se "already exists" tratar como sucesso
                const alreadyExists = (result.errors || []).some(e => (e.message || '').includes('already') || (e.message || '').includes('duplicate'));
                if (alreadyExists) {
                  deployResults.push({ component: (step.description || 'Criar: ' + step.metadataType) + ' (ja existia)', success: true, errors: [] });
                } else {
                  deployResults.push({ component: (step.description || 'Criar: ' + step.metadataType), ...result });
                }

              } else if (step.type === 'execute-apex') {
                const r = await fetch(base + '/api/execute-anonymous', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ code: step.code }),
                });
                const result = await r.json();
                deployResults.push({ component: (step.description || 'Apex'), success: result.success !== false, errors: result.errors || [] });

              } else if (step.type === 'add-to-layout') {
                // GET /api/move-field-in-layout/:layoutName/:fieldName/:toSection
                const layoutName = encodeURIComponent(step.layout || (step.object + '-' + step.object + ' Layout'));
                const fieldName = encodeURIComponent(step.field);
                const section = encodeURIComponent(step.section || (step.object + ' Information'));
                const r = await fetch(base + '/api/move-field-in-layout/' + layoutName + '/' + fieldName + '/' + section);
                const result = await r.json();
                deployResults.push({ component: (step.description || 'Layout: ' + step.field + ' → ' + (step.section || 'default')), success: result.success !== false && !result.error, errors: result.error ? [{ message: result.error }] : (result.errors || []) });

              } else if (step.type === 'add-permission') {
                const psName = step.permissionSetName || 'Everi9_FieldAccess';
                const psLabel = step.permissionSetLabel || 'Everi9 Field Access';
                const body = {
                  fullName: psName,
                  label: psLabel,
                  fieldPermissions: (step.fields || [step.field]).map(f => ({
                    field: f,
                    editable: true,
                    readable: true,
                  })),
                };
                // Criar PS (ou update se já existe)
                let r = await fetch(base + '/api/metadata-create/PermissionSet', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                let result = await r.json();
                const alreadyExists = (result.errors || []).some(e => (e.message || '').includes('already') || (e.message || '').includes('duplicate'));
                if (!result.success && !alreadyExists) {
                  r = await fetch(base + '/api/metadata-update/PermissionSet', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  result = await r.json();
                }
                deployResults.push({ component: (step.description || 'Permission Set: ' + psName), success: result.success !== false || alreadyExists, errors: alreadyExists ? [] : (result.errors || []) });

                // ATRIBUIR PS a todos os users ativos via Apex
                try {
                  const assignApex = "PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = '" + psName + "' LIMIT 1]; List<User> users = [SELECT Id FROM User WHERE IsActive = true AND UserType = 'Standard' AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :ps.Id)]; List<PermissionSetAssignment> psas = new List<PermissionSetAssignment>(); for (User u : users) { psas.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id)); } if (!psas.isEmpty()) insert psas;";
                  const ar = await fetch(base + '/api/execute-anonymous', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: assignApex }),
                  });
                  const assignResult = await ar.json();
                  deployResults.push({ component: 'Atribuir PS a todos os usuarios', success: assignResult.success !== false, errors: assignResult.errors || [] });
                } catch (assignErr) {
                  deployResults.push({ component: 'Atribuir PS', success: false, errors: [{ message: assignErr.message }] });
                }

              } else if (step.type === 'setup-instruction') {
                deployResults.push({ component: step.step || step.description, success: true, manual: true, setupUrl: step.setupUrl || '', errors: [] });
              }
            } catch (stepErr) {
              deployResults.push({ component: (step.description || step.type), success: false, errors: [{ message: stepErr.message }] });
            }
          }
        } else {
          // Fallback: tentar com manifest do historico
          let manifest = null;
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i].content || '';
            const mm = msg.match(/---MANIFEST---(\s*[\s\S]*?)---FIM---/);
            if (mm) {
              try { manifest = JSON.parse(mm[1].trim()); } catch {
                const jm = mm[1].match(/\{[\s\S]*\}/);
                if (jm) try { manifest = JSON.parse(jm[0]); } catch {}
              }
            }
            if (manifest) break;
          }

          if (manifest?.metadata?.customFields?.length) {
            for (const field of manifest.metadata.customFields) {
              let result;
              if (selectedOrg) {
                result = await sfMulti.deployField(selectedOrg, field);
              } else {
                const fullName = field.objectName + '.' + field.fieldName;
                const body = { fullName, label: field.label, type: field.type };
                if (field.length) body.length = field.length;
                if (field.picklist) {
                  body.valueSet = { valueSetDefinition: { value: field.picklist.map(v => ({ fullName: v, label: v, default: false })) } };
                }
                const r = await fetch(base + '/api/metadata-create/CustomField', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                result = await r.json();
                result.component = 'Field: ' + fullName;
              }
              deployResults.push(result);
            }
          }
          
          if (manifest?.configSteps?.length) {
            for (const step of manifest.configSteps) {
              if (step.type === 'setup-instruction') {
                deployResults.push({ component: step.step, success: true, manual: true, setupUrl: step.setupUrl || '', errors: [] });
              }
            }
          }
        }

        // ── Deploy de código (Apex + LWC) via ZIP ──
        if (smartCommands?.code) {
          try {
            const JSZip = (await import('jszip')).default;
            const zip = new JSZip();
            const pkgMembers = [];

            // Apex Classes
            if (smartCommands.code.apexClasses?.length) {
              for (const cls of smartCommands.code.apexClasses) {
                zip.file('force-app/main/default/classes/' + cls.name + '.cls', cls.body);
                zip.file('force-app/main/default/classes/' + cls.name + '.cls-meta.xml',
                  '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>62.0</apiVersion>\n  <status>Active</status>\n</ApexClass>');
                pkgMembers.push({ type: 'ApexClass', name: cls.name });
              }
            }

            // Apex Triggers
            if (smartCommands.code.apexTriggers?.length) {
              for (const trg of smartCommands.code.apexTriggers) {
                zip.file('force-app/main/default/triggers/' + trg.name + '.trigger', trg.body);
                zip.file('force-app/main/default/triggers/' + trg.name + '.trigger-meta.xml',
                  '<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>62.0</apiVersion>\n  <status>Active</status>\n</ApexTrigger>');
                pkgMembers.push({ type: 'ApexTrigger', name: trg.name });
              }
            }

            // LWC
            if (smartCommands.code.lwc?.length) {
              for (const comp of smartCommands.code.lwc) {
                const path = 'force-app/main/default/lwc/' + comp.name + '/';
                zip.file(path + comp.name + '.js', comp.js);
                zip.file(path + comp.name + '.html', comp.html);
                zip.file(path + comp.name + '.js-meta.xml', comp.meta);
                pkgMembers.push({ type: 'LightningComponentBundle', name: comp.name });
              }
            }

            // Package.xml
            if (pkgMembers.length > 0) {
              let pkgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
              const byType = {};
              for (const m of pkgMembers) {
                if (!byType[m.type]) byType[m.type] = [];
                byType[m.type].push(m.name);
              }
              for (const [type, names] of Object.entries(byType)) {
                pkgXml += '  <types>\n';
                for (const n of names) pkgXml += '    <members>' + n + '</members>\n';
                pkgXml += '    <name>' + type + '</name>\n  </types>\n';
              }
              pkgXml += '  <version>62.0</version>\n</Package>';
              zip.file('package.xml', pkgXml);

              const zipB64 = await zip.generateAsync({ type: 'base64' });

              // Deploy via /api/deploy-code
              const codeRes = await fetch(base + '/api/deploy-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zipBase64: zipB64, checkOnly: false }),
              });
              const codeData = await codeRes.json();

              for (const m of pkgMembers) {
                deployResults.push({
                  component: m.type + ': ' + m.name,
                  success: codeData.success || codeData.status === 'Succeeded' || codeData.status === 'InProgress',
                  deployId: codeData.id,
                  errors: codeData.details?.componentFailures || [],
                });
              }

              // Se deploy assincrono, adicionar nota
              if (codeData.id && codeData.status !== 'Succeeded') {
                deployResults.push({
                  component: 'Deploy assincrono iniciado (ID: ' + codeData.id + '). Verificar status em ~30s.',
                  success: true, manual: true, errors: [],
                });
              }
            }
          } catch (codeErr) {
            deployResults.push({ component: 'Deploy de codigo', success: false, errors: [{ message: codeErr.message }] });
          }
        }

        clearInterval(keepAlive3);

        if (deployResults.length === 0) {
          res.end(JSON.stringify({
            choices: [{ message: { content: '\u26a0\ufe0f Nao foi possivel determinar as configuracoes necessarias. Use a opcao **2** para gerar a Spec com instrucoes detalhadas.' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'prototipo',
          }));
          return;
        }

        const success = deployResults.filter(r => !r.manual).every(r => r.success);
        const resultLines = [];
        resultLines.push(success ? '## \u2705 Configuracao realizada!' : '## \u26a0\ufe0f Configuracao parcial');
        if (smartCommands?.summary) {
          resultLines.push('');
          resultLines.push('**Resumo:** ' + smartCommands.summary);
        }
        resultLines.push('');
        resultLines.push('### Passos executados');
        resultLines.push('');
        resultLines.push('| # | Acao | Status |');
        resultLines.push('|---|---|---|');
        deployResults.forEach((r, idx) => {
          const icon = r.manual ? '\ud83d\udcdd' : (r.success ? '\u2705' : '\u274c');
          const errMsg = r.errors?.length ? ' — ' + (r.errors[0]?.message || r.errors[0]?.problem || '') : '';
          const tag = r.manual ? ' *(manual)*' : '';
          resultLines.push('| ' + (idx + 1) + ' | ' + (r.component || 'N/A') + ' | ' + icon + errMsg + tag + ' |');
        });

        // Obter instanceUrl para links do Setup
        let instanceUrl = '';
        try {
          const connRes = await fetch(base + '/test-connection');
          const connData = await connRes.json();
          instanceUrl = connData.instanceUrl || '';
        } catch {}

        // Passos manuais detalhados
        const manualSteps = deployResults.filter(r => r.manual);
        if (manualSteps.length > 0) {
          resultLines.push('');
          resultLines.push('---');
          resultLines.push('');
          resultLines.push('### Configuracao manual necessaria');
          resultLines.push('');
          manualSteps.forEach((step, idx) => {
            const sUrl = step.setupUrl || '';
            resultLines.push('**Passo ' + (idx + 1) + ':** ' + step.component);
            if (sUrl && instanceUrl) {
              resultLines.push('[\u27a1 Abrir no Setup](' + instanceUrl + sUrl + ')');
            }
            resultLines.push('');
          });
        }

        res.end(JSON.stringify({
          choices: [{ message: { content: resultLines.join('\n') } }],
          modelo_usado: 'grok + mcp',
          modelo_label: 'Smart Deploy',
          tipo: 'deploy',
        }));
        return;
      }
    }

        switch (command) {
      case 'arch': {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const keepAliveArch = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        const archReq = messages[messages.length - 1].content.replace(/\/arch\s*/i, '').trim();
        const selectedOrgArch = await getSelectedOrg(req);
        const baseArch = 'http://localhost:' + (process.env.PORT || 3000);

        // ── SCAN DA ORG ──
        const orgScan = {};

        // Detectar objetos mencionados no requisito
        const archLower = archReq.toLowerCase();
        const allObjects = ['Lead','Opportunity','Account','Contact','Case','Quote','Order','Contract','Campaign','Task','Event','Product2','PricebookEntry','OpportunityLineItem','Asset','Entitlement','Solution','ForecastingItem'];
        const mentionedObjects = allObjects.filter(o => archLower.includes(o.toLowerCase()));
        if (mentionedObjects.length === 0) mentionedObjects.push('Lead', 'Opportunity', 'Account');

        // Descrever objetos
        for (const obj of mentionedObjects) {
          try {
            const desc = await execDescribe(req, obj);
            orgScan['fields_' + obj] = (desc.fields || []).map(f => ({
              name: f.name, label: f.label, type: f.type, custom: f.custom,
              picklistValues: f.picklistValues?.length > 0 ? f.picklistValues.map(p => p.value) : undefined,
            }));
          } catch {}
        }

        // Listar Flows
        try {
          const fSoql = ("SELECT ApiName, Label, ProcessType, TriggerType, Description, IsActive FROM FlowDefinitionView WHERE IsActive = true ORDER BY Label");
          const fd = await execSoql(req, fSoql);
          orgScan.flows = (fd.records || []).map(f => ({ apiName: f.ApiName, label: f.Label, type: f.ProcessType, trigger: f.TriggerType, description: f.Description }));
        } catch {}

        // Listar Apex Classes
        try {
          const aSoql = ("SELECT Name, Body, LengthWithoutComments FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name");
          const ad = await execSoql(req, aSoql);
          orgScan.apexClasses = (ad.records || []).map(c => ({ name: c.Name, preview: (c.Body || '').slice(0, 300), size: c.LengthWithoutComments }));
        } catch {}

        // Listar Triggers
        try {
          const tSoql = ("SELECT Name, TableEnumOrId, Body FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name");
          const td = await execSoql(req, tSoql);
          orgScan.triggers = (td.records || []).map(t => ({ name: t.Name, object: t.TableEnumOrId, preview: (t.Body || '').slice(0, 300) }));
        } catch {}

        // Listar Validation Rules
        try {
          const vSoql = ("SELECT ValidationName, Active, Description, ErrorMessage FROM ValidationRule ORDER BY ValidationName");
          const vd = await execSoql(req, vSoql);
          orgScan.validationRules = (vd.records || []).map(v => ({ name: v.ValidationName, description: v.Description, errorMessage: v.ErrorMessage }));
        } catch {}

        // Listar Permission Sets custom
        try {
          const pSoql = ("SELECT Name, Label, Description FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null ORDER BY Label");
          const pd = await execSoql(req, pSoql);
          orgScan.permissionSets = (pd.records || []).map(p => ({ name: p.Name, label: p.Label, description: p.Description }));
        } catch {}

        // Listar Record Types
        try {
          const rSoql = ("SELECT Name, DeveloperName, SobjectType, IsActive FROM RecordType ORDER BY SobjectType, Name");
          const rd = await execSoql(req, rSoql);
          orgScan.recordTypes = (rd.records || []).map(r => ({ name: r.Name, devName: r.DeveloperName, object: r.SobjectType, active: r.IsActive }));
        } catch {}

        // ── ANÁLISE COM CLAUDE ──
        const archPrompt = [
          'Voce e um ARQUITETO SALESFORCE SENIOR fazendo uma ANALISE DE GAP.',
          'Recebeu um REQUISITO/ESPECIFICACAO e o ESTADO COMPLETO DA ORG.',
          'Sua missao: identificar o que JA EXISTE, o que ATENDE PARCIALMENTE, e o que FALTA implementar.',
          '',
          'FORMATO DA RESPOSTA:',
          '',
          '## Analise de Gap',
          '',
          '### Resumo',
          '[2-3 frases sobre a cobertura geral]',
          '',
          '### Ja existe na org',
          'Para cada item que ja atende ao requisito:',
          '- **[Tipo: Campo/Flow/Apex/VR/PS/RT]** [Nome] — [como atende ao requisito]',
          '',
          '### Atende parcialmente',
          'Para cada item que existe mas precisa de ajuste:',
          '- **[Tipo]** [Nome] — [o que ja faz] → [o que precisa mudar]',
          '',
          '### Nao existe (gap)',
          'Para cada item que precisa ser criado:',
          '- **[Tipo]** [Nome sugerido] — [descricao do que precisa ser criado]',
          '',
          '### Recomendacao',
          '[Abordagem recomendada: OOTB, Flow, Apex, LWC]',
          '[Estimativa de esforco: baixo/medio/alto]',
          '[Riscos ou dependencias]',
          '',
          'REGRAS:',
          '- Seja ESPECIFICO: cite nomes de campos, flows, classes que ja existem',
          '- Compare campo por campo, automacao por automacao',
          '- Se um Flow ja faz parte do que o requisito pede, cite-o',
          '- Se um campo custom ja existe com nome similar, cite-o',
          '- Nao invente componentes que nao estao no scan',
          '- Responda em portugues do Brasil',
        ].join('\n');

        let analysis;
        try {
          const scanStr = JSON.stringify(orgScan, null, 1);
          const truncatedScan = scanStr.length > 30000 ? scanStr.slice(0, 30000) + '\n... (truncado)' : scanStr;
          analysis = await claude.call(archPrompt, [{
            role: 'user',
            content: 'REQUISITO/ESPECIFICACAO:\n' + archReq + '\n\nESTADO DA ORG:\n' + truncatedScan,
          }], 16384);
        } catch (aiErr) {
          analysis = 'Erro na analise: ' + aiErr.message;
        }

        clearInterval(keepAliveArch);

        // Salvar como .txt
        const archFileName = 'Arch_Gap_Analysis.txt';
        try {
          const fs = await import('fs');
          const dir = '/tmp/prototipos';
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(dir + '/' + archFileName, [
            '='.repeat(60),
            '  ANALISE DE GAP — EVER i9 ARCH',
            '  Org: ' + (selectedOrgArch?.name || 'Dev Org (padrao)'),
            '  Data: ' + new Date().toLocaleString('pt-BR'),
            '='.repeat(60),
            '',
            'REQUISITO:',
            archReq,
            '',
            '='.repeat(60),
            '',
            analysis,
            '',
            '='.repeat(60),
            '  FIM DA ANALISE',
            '='.repeat(60),
          ].join('\n'));
        } catch {}

        const host = req.headers.host || 'everi9.albertobottaro.info';
        const downloadLink = '\n\n[\u2b07 Baixar relatorio .txt](https://' + host + '/prototipos/' + archFileName + ')';

        const menu = '\n\n---\n\n**O que deseja fazer?**\n\n**1** \u2014 Gerar Spec tecnica com base no gap\n\n**2** \u2014 Deploy do que falta na org\n\nDigite o numero para prosseguir.';

        response = analysis + downloadLink + menu;
        modelUsed = 'claude-sonnet-4-6'; modelLabel = 'Claude Sonnet (Arch)';
        break;
      }
      case 'discovery': {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.write(' ');
        const keepAliveDisc = setInterval(() => { try { res.write(' '); } catch {} }, 10000);

        const discArg = messages[messages.length - 1].content.replace(/\/(discovery|disc)\s*/i, '').trim();
        const discLower = discArg.toLowerCase().replace(/\s/g, '');
        const selectedOrgDisc = await getSelectedOrg(req);
        const baseDisc = 'http://localhost:' + (process.env.PORT || 3000);

        // Mapear tipo de componente para SOQL que traz detalhes
        const discoveryQueries = {
          'flow': "SELECT Id, DurableId, ApiName, Label, ProcessType, TriggerType, Description, IsActive, ActiveVersionId FROM FlowDefinitionView ORDER BY Label",
          'flows': "SELECT Id, DurableId, ApiName, Label, ProcessType, TriggerType, Description, IsActive, ActiveVersionId FROM FlowDefinitionView ORDER BY Label",
          'apex': "SELECT Id, Name, Body, LengthWithoutComments, Status FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
          'classes': "SELECT Id, Name, Body, LengthWithoutComments, Status FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
          'trigger': "SELECT Id, Name, Body, TableEnumOrId, Status FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name",
          'triggers': "SELECT Id, Name, Body, TableEnumOrId, Status FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name",
          'validationrules': "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, Description, ErrorMessage FROM ValidationRule ORDER BY EntityDefinition.QualifiedApiName, ValidationName",
          'vr': "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, Description, ErrorMessage FROM ValidationRule ORDER BY EntityDefinition.QualifiedApiName, ValidationName",
          'permissionsets': "SELECT Id, Name, Label, Description, IsCustom FROM PermissionSet WHERE IsCustom = true ORDER BY Label",
          'ps': "SELECT Id, Name, Label, Description, IsCustom FROM PermissionSet WHERE IsCustom = true ORDER BY Label",
          'recordtypes': "SELECT Id, Name, DeveloperName, SobjectType, IsActive, Description FROM RecordType ORDER BY SobjectType, Name",
          'rt': "SELECT Id, Name, DeveloperName, SobjectType, IsActive, Description FROM RecordType ORDER BY SobjectType, Name",
        };

        let discoveryData = [];
        let discoveryType = '';
        const soql = discoveryQueries[discLower];

        if (soql) {
          discoveryType = discLower;
          try {
            const result = await execSoql(req, soql);
            discoveryData = result.records || [];
          } catch (e) {
            clearInterval(keepAliveDisc);
            res.end(JSON.stringify({
              choices: [{ message: { content: '\u274c Erro ao consultar: ' + e.message } }],
              modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'discovery',
            }));
            return;
          }
        } else {
          // Tratar como nome de componente específico — buscar por nome
          const discArgSafe = discArg.replace(/'/g, "\\'");
          const discArgNoSpaces = discArgSafe.replace(/ /g, '');
          try {
            // Tentar como Flow — Label primeiro, depois ApiName (OR nao suportado)
            let result = await execSoql(req, "SELECT Id, ApiName, Label, ProcessType, TriggerType, Description, IsActive FROM FlowDefinitionView WHERE Label LIKE '%" + discArgSafe + "%'");
            if (!result.records?.length) {
              // Tentar por ApiName exato
              result = await execSoql(req, "SELECT Id, ApiName, Label, ProcessType, TriggerType, Description, IsActive FROM FlowDefinitionView WHERE ApiName = '" + discArgNoSpaces + "'");
            }
            if (result.records?.length) {
              discoveryData = result.records;
              discoveryType = 'flow';
            } else {
              // Tentar como Apex
              result = await execSoql(req, "SELECT Id, Name, Body, Status FROM ApexClass WHERE Name LIKE '%" + discArgSafe.replace(/ /g, '') + "%'");
              if (result.records?.length) {
                discoveryData = result.records;
                discoveryType = 'apex';
              } else {
                // Tentar como Trigger
                result = await execSoql(req, "SELECT Id, Name, Body, TableEnumOrId, Status FROM ApexTrigger WHERE Name LIKE '%" + discArgSafe.replace(/ /g, '') + "%'");
                if (result.records?.length) {
                  discoveryData = result.records;
                  discoveryType = 'trigger';
                }
              }
            }
          } catch {}
        }

        if (discoveryData.length === 0) {
          clearInterval(keepAliveDisc);
          res.end(JSON.stringify({
            choices: [{ message: { content: '\u26a0\ufe0f Nenhum componente encontrado para: **' + discArg + '**\n\nUse: /discovery flow, /discovery apex, /discovery triggers, /discovery vr, /discovery ps, /discovery rt\n\nOu passe o nome especifico: /discovery MeuFlowName' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'discovery',
          }));
          return;
        }

        // Montar contexto para análise da IA
        let componentSummary = '';
        if (['flow', 'flows'].includes(discoveryType)) {
          // Buscar definição COMPLETA dos flows via Tooling API
          const flowDetails = [];
          for (const f of discoveryData.slice(0, 10)) { // Limitar a 10 para não estourar contexto
            let detail = 'Flow: ' + (f.Label || f.ApiName) + ' | Tipo: ' + (f.ProcessType || '?') + ' | Trigger: ' + (f.TriggerType || 'N/A') + ' | Ativo: ' + (f.IsActive ? 'Sim' : 'Nao') + ' | Desc: ' + (f.Description || 'sem descricao');
            try {
              // Ler definição completa via metadata-read
              const selectedOrgFlow = await getSelectedOrg(req);
              let flowDef;
              if (selectedOrgFlow) {
                flowDef = await sfMulti.metadataRead(selectedOrgFlow, 'Flow', f.ApiName);
              } else {
                const baseFlow = 'http://localhost:' + (process.env.PORT || 3000);
                const fr = await fetch(baseFlow + '/api/metadata-read/Flow/' + encodeURIComponent(f.ApiName));
                flowDef = await fr.json();
              }
              if (flowDef && !flowDef.error) {
                // Extrair elementos relevantes da definição
                const elements = [];
                if (flowDef.processMetadataValues) elements.push('ProcessBuilder: ' + JSON.stringify(flowDef.processMetadataValues).slice(0, 200));
                if (flowDef.recordCreates) elements.push('Record Creates: ' + JSON.stringify(flowDef.recordCreates).slice(0, 300));
                if (flowDef.recordUpdates) elements.push('Record Updates: ' + JSON.stringify(flowDef.recordUpdates).slice(0, 300));
                if (flowDef.recordLookups) elements.push('Record Lookups: ' + JSON.stringify(flowDef.recordLookups).slice(0, 300));
                if (flowDef.decisions) elements.push('Decisions: ' + JSON.stringify(flowDef.decisions).slice(0, 300));
                if (flowDef.assignments) elements.push('Assignments: ' + JSON.stringify(flowDef.assignments).slice(0, 300));
                if (flowDef.actionCalls) elements.push('Action Calls: ' + JSON.stringify(flowDef.actionCalls).slice(0, 300));
                if (flowDef.screens) elements.push('Screens: ' + JSON.stringify(flowDef.screens).slice(0, 300));
                if (flowDef.start) elements.push('Start: ' + JSON.stringify(flowDef.start).slice(0, 300));
                if (flowDef.variables) elements.push('Variables: ' + JSON.stringify(flowDef.variables).slice(0, 200));
                if (flowDef.formulas) elements.push('Formulas: ' + JSON.stringify(flowDef.formulas).slice(0, 200));
                if (flowDef.loops) elements.push('Loops: ' + JSON.stringify(flowDef.loops).slice(0, 200));
                if (flowDef.subflows) elements.push('Subflows: ' + JSON.stringify(flowDef.subflows).slice(0, 200));
                if (elements.length > 0) {
                  detail += '\n  DEFINICAO COMPLETA:\n  ' + elements.join('\n  ');
                }
              }
            } catch (flowErr) {
              detail += '\n  (erro ao ler definicao: ' + flowErr.message + ')';
            }
            flowDetails.push(detail);
          }
          componentSummary = flowDetails.join('\n---\n');
        } else if (['apex', 'classes'].includes(discoveryType)) {
          componentSummary = discoveryData.map(c => {
            const bodyPreview = (c.Body || '').slice(0, 500).replace(/\n/g, ' ');
            return 'Classe: ' + c.Name + ' | Status: ' + c.Status + ' | Tamanho: ' + (c.LengthWithoutComments || '?') + ' chars | Preview: ' + bodyPreview;
          }).join('\n---\n');
        } else if (['trigger', 'triggers'].includes(discoveryType)) {
          componentSummary = discoveryData.map(t => {
            const bodyPreview = (t.Body || '').slice(0, 500).replace(/\n/g, ' ');
            return 'Trigger: ' + t.Name + ' | Objeto: ' + t.TableEnumOrId + ' | Status: ' + t.Status + ' | Preview: ' + bodyPreview;
          }).join('\n---\n');
        } else if (['validationrules', 'vr'].includes(discoveryType)) {
          componentSummary = discoveryData.map(v => {
            return 'VR: ' + (v.ValidationName || '') + ' | Objeto: ' + (v.EntityDefinition?.QualifiedApiName || '?') + ' | Ativa: ' + (v.Active ? 'Sim' : 'Nao') + ' | Msg: ' + (v.ErrorMessage || '') + ' | Desc: ' + (v.Description || '');
          }).join('\n');
        } else if (['permissionsets', 'ps'].includes(discoveryType)) {
          componentSummary = discoveryData.map(p => {
            return 'PS: ' + (p.Label || p.Name) + ' | API: ' + p.Name + ' | Desc: ' + (p.Description || 'sem descricao');
          }).join('\n');
        } else if (['recordtypes', 'rt'].includes(discoveryType)) {
          componentSummary = discoveryData.map(r => {
            return 'RT: ' + r.Name + ' | API: ' + r.DeveloperName + ' | Objeto: ' + r.SobjectType + ' | Ativo: ' + (r.IsActive ? 'Sim' : 'Nao') + ' | Desc: ' + (r.Description || '');
          }).join('\n');
        }

        // Enviar para Claude analisar
        const analysisPrompt = [
          'Voce e um analista Salesforce. Analise os componentes abaixo e descreva a FUNCIONALIDADE de cada um.',
          'Para cada componente, explique:',
          '1. O que ele faz (objetivo/funcionalidade)',
          '2. Como funciona (logica principal)',
          '3. Objetos/campos impactados',
          '4. Observacoes relevantes (riscos, dependencias, melhorias)',
          '',
          'Formato da resposta para cada componente:',
          '### [Nome do Componente]',
          '**Funcionalidade:** [descricao clara]',
          '**Logica:** [como funciona]',
          '**Impacto:** [objetos/campos]',
          '**Observacoes:** [riscos/dependencias]',
          '',
          'Se for codigo Apex, analise o codigo e descreva metodos, queries, DML.',
          'Se for Flow, descreva o tipo, trigger, e acoes principais.',
          'Se for Validation Rule, explique a regra e quando bloqueia.',
          'Responda em portugues do Brasil.',
        ].join('\n');

        let analysis;
        try {
          analysis = await claude.call(analysisPrompt, [{ role: 'user', content: 'Analise estes ' + discoveryData.length + ' componentes:\n\n' + componentSummary }], 16384);
        } catch (aiErr) {
          analysis = 'Erro na analise: ' + aiErr.message + '\n\nDados brutos:\n' + componentSummary;
        }

        clearInterval(keepAliveDisc);

        // Salvar análise como .txt
        const discFileName = 'Discovery_' + discoveryType + '.txt';
        try {
          const fs = await import('fs');
          const dir = '/tmp/prototipos';
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const txtContent = [
            '='.repeat(60),
            '  DISCOVERY: ' + discoveryType.toUpperCase(),
            '  Org: ' + (selectedOrgDisc?.name || 'Dev Org (padrao)'),
            '  Data: ' + new Date().toLocaleString('pt-BR'),
            '  Componentes analisados: ' + discoveryData.length,
            '='.repeat(60),
            '',
            analysis,
            '',
            '='.repeat(60),
            '  FIM DO DISCOVERY',
            '='.repeat(60),
          ].join('\n');
          fs.writeFileSync(dir + '/' + discFileName, txtContent);
        } catch {}

        const host = req.headers.host || 'everi9.albertobottaro.info';
        const header = '## Discovery: ' + discoveryType + '\n\n**Componentes analisados:** ' + discoveryData.length + '\n\n';
        const downloadLink = '\n\n[\u2b07 Baixar ' + discFileName + '](https://' + host + '/prototipos/' + discFileName + ')';

        res.end(JSON.stringify({
          choices: [{ message: { content: header + analysis + downloadLink } }],
          modelo_usado: 'claude-sonnet-4-6',
          modelo_label: 'Claude Sonnet 4.6',
          tipo: 'discovery',
        }));
        return;
      }
      case 'list': {
        const listArg = messages[messages.length - 1].content.replace(/\/list\s*/i, '').trim();
        const selectedOrg = await getSelectedOrg(req);

        // Tipos de componentes que podem ser listados via metadata
        const metadataTypes = {
          'flows': 'Flow', 'flow': 'Flow',
          'apex': 'ApexClass', 'classes': 'ApexClass', 'apexclass': 'ApexClass',
          'triggers': 'ApexTrigger', 'trigger': 'ApexTrigger',
          'lwc': 'LightningComponentBundle', 'components': 'LightningComponentBundle',
          'permissionsets': 'PermissionSet', 'ps': 'PermissionSet',
          'profiles': 'Profile', 'perfis': 'Profile',
          'validationrules': 'ValidationRule', 'vr': 'ValidationRule',
          'recordtypes': 'RecordType', 'rt': 'RecordType',
          'customobjects': 'CustomObject', 'objetos': 'CustomObject',
          'reports': 'Report', 'relatorios': 'Report',
          'dashboards': 'Dashboard', 'paineis': 'Dashboard',
          'emailtemplates': 'EmailTemplate', 'emails': 'EmailTemplate',
          'queues': 'Queue', 'filas': 'Queue',
          'groups': 'Group', 'grupos': 'Group',
        };

        const argLower = listArg.toLowerCase().replace(/\s/g, '');
        let listContent = '';
        let fileName = '';
        let displayText = '';

        // /list all — listar TODOS os objetos da org
        if (argLower === 'all' || argLower === 'todos' || argLower === 'objetos' || argLower === 'objects') {
          try {
            const base2 = 'http://localhost:' + (process.env.PORT || 3000);
            const soql = "SELECT QualifiedApiName, Label, KeyPrefix FROM EntityDefinition WHERE IsLayoutable = true ORDER BY QualifiedApiName";
            const soqlResult = await execSoql(req, soql);
            const items = soqlResult.records || [];

            const custom = items.filter(i => (i.QualifiedApiName || '').endsWith('__c'));
            const standard = items.filter(i => !(i.QualifiedApiName || '').endsWith('__c'));

            fileName = 'All_Objects.txt';
            const lines = [];
            lines.push('='.repeat(70));
            lines.push('  TODOS OS OBJETOS DA ORG');
            lines.push('  Org: ' + (selectedOrg?.name || 'Dev Org (padrao)'));
            lines.push('  Data: ' + new Date().toLocaleString('pt-BR'));
            lines.push('  Total: ' + items.length + ' objetos (' + standard.length + ' standard, ' + custom.length + ' custom)');
            lines.push('='.repeat(70));
            lines.push('');
            lines.push('--- OBJETOS CUSTOM ---');
            lines.push('');
            lines.push('API Name'.padEnd(45) + 'Label'.padEnd(35) + 'Prefix');
            lines.push('-'.repeat(85));
            for (const obj of custom) {
              lines.push(
                (obj.QualifiedApiName || '').padEnd(45) +
                (obj.Label || '').padEnd(35) +
                (obj.KeyPrefix || '')
              );
            }
            lines.push('');
            lines.push('--- OBJETOS STANDARD ---');
            lines.push('');
            lines.push('API Name'.padEnd(45) + 'Label'.padEnd(35) + 'Prefix');
            lines.push('-'.repeat(85));
            for (const obj of standard) {
              lines.push(
                (obj.QualifiedApiName || '').padEnd(45) +
                (obj.Label || '').padEnd(35) +
                (obj.KeyPrefix || '')
              );
            }
            lines.push('');
            lines.push('='.repeat(70));
            lines.push('  FIM DA LISTAGEM');
            lines.push('='.repeat(70));

            listContent = lines.join('\n');
            displayText = '## Todos os objetos da org\n\n';
            displayText += '**Total:** ' + items.length + ' objetos (' + custom.length + ' custom, ' + standard.length + ' standard)\n\n';

            if (custom.length > 0) {
              displayText += '### Objetos Custom (' + custom.length + ')\n\n';
              displayText += '| # | API Name | Label |\n|---|---|---|\n';
              custom.forEach((obj, idx) => {
                displayText += '| ' + (idx + 1) + ' | ' + (obj.QualifiedApiName || '') + ' | ' + (obj.Label || '') + ' |\n';
              });
              displayText += '\n';
            }

            displayText += '### Objetos Standard (primeiros 30 de ' + standard.length + ')\n\n';
            displayText += '| # | API Name | Label |\n|---|---|---|\n';
            standard.slice(0, 30).forEach((obj, idx) => {
              displayText += '| ' + (idx + 1) + ' | ' + (obj.QualifiedApiName || '') + ' | ' + (obj.Label || '') + ' |\n';
            });
            if (standard.length > 30) {
              displayText += '\n*...e mais ' + (standard.length - 30) + ' objetos no arquivo .txt*';
            }
          } catch (allErr) {
            displayText = '\u274c Erro ao listar objetos: ' + allErr.message;
          }

          // Salvar .txt
          if (listContent && fileName) {
            try {
              const fs = await import('fs');
              const dir = '/tmp/prototipos';
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(dir + '/' + fileName, listContent);
              const host = req.headers.host || 'everi9.albertobottaro.info';
              displayText += '\n\n[\u2b07 Baixar ' + fileName + '](https://' + host + '/prototipos/' + fileName + ')';
            } catch {}
          }

          response = displayText;
          modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
          break;
        }

        const metaType = metadataTypes[argLower];


        if (metaType) {
          // Listar componentes via SOQL no Tooling API ou metadata
          try {
            let items = [];
            const base2 = 'http://localhost:' + (process.env.PORT || 3000);

            // Usar SOQL para listar componentes
            const soqlMap = {
              'ApexClass': "SELECT Id, Name, Status, LengthWithoutComments, CreatedDate, LastModifiedDate FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name",
              'ApexTrigger': "SELECT Id, Name, TableEnumOrId, Status, CreatedDate FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name",
              'Flow': "SELECT Id, ApiName, Label, ProcessType, TriggerType, IsActive, Description FROM FlowDefinitionView ORDER BY Label",
              'PermissionSet': "SELECT Id, Name, Label, Description FROM PermissionSet WHERE IsOwnedByProfile = false AND NamespacePrefix = null ORDER BY Label",
              'Profile': "SELECT Id, Name FROM Profile ORDER BY Name",
              'ValidationRule': "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, Description FROM ValidationRule ORDER BY ValidationName",
              'RecordType': "SELECT Id, Name, DeveloperName, SobjectType, IsActive FROM RecordType ORDER BY SobjectType, Name",
              'CustomObject': "SELECT QualifiedApiName, Label, KeyPrefix FROM EntityDefinition WHERE QualifiedApiName LIKE '%__c' AND IsLayoutable = true ORDER BY QualifiedApiName",
              'Report': "SELECT Id, Name, DeveloperName, FolderName FROM Report ORDER BY FolderName, Name LIMIT 200",
              'Dashboard': "SELECT Id, Title, DeveloperName, FolderName FROM Dashboard ORDER BY FolderName, Title LIMIT 200",
              'EmailTemplate': "SELECT Id, Name, DeveloperName, FolderName, Subject FROM EmailTemplate ORDER BY FolderName, Name LIMIT 200",
            };

            const soql = soqlMap[metaType];
            if (soql) {
              const soqlResult = await execSoql(req, soql);
              items = soqlResult.records || [];
            }

            fileName = metaType + '_list.txt';
            const lines = [];
            lines.push('='.repeat(60));
            lines.push('  LISTAGEM: ' + metaType);
            lines.push('  Org: ' + (selectedOrg?.name || 'Dev Org (padrao)'));
            lines.push('  Data: ' + new Date().toLocaleString('pt-BR'));
            lines.push('  Total: ' + items.length + ' registros');
            lines.push('='.repeat(60));
            lines.push('');

            for (const item of items) {
              const attrs = item.attributes || {};
              delete item.attributes;
              const fields = Object.entries(item).filter(([k,v]) => v !== null && k !== 'Id');
              lines.push('-'.repeat(40));
              for (const [key, val] of fields) {
                if (typeof val === 'object' && val !== null) {
                  lines.push('  ' + key + ': ' + JSON.stringify(val));
                } else {
                  lines.push('  ' + key + ': ' + val);
                }
              }
            }
            lines.push('');
            lines.push('='.repeat(60));
            lines.push('  FIM DA LISTAGEM');
            lines.push('='.repeat(60));

            listContent = lines.join('\n');
            displayText = '## Listagem: ' + metaType + '\n\n';
            displayText += '**Total:** ' + items.length + ' registros\n\n';
            displayText += '| # | Nome | API Name | Detalhes |\n|---|---|---|---|\n';
            items.slice(0, 30).forEach((item, idx) => {
              const name = item.Name || item.Label || item.MasterLabel || item.ValidationName || item.Title || 'N/A';
              const apiName = item.ApiName || item.DeveloperName || item.Name || '';
              const detail = item.ProcessType || item.Status || item.SobjectType || item.FolderName || (item.IsActive === true ? 'Active' : item.IsActive === false ? 'Inactive' : '') || '';
              displayText += '| ' + (idx + 1) + ' | ' + name + ' | ' + apiName + ' | ' + detail + ' |\n';
            });
            if (items.length > 30) {
              displayText += '\n*...e mais ' + (items.length - 30) + ' registros no arquivo .txt*';
            }
          } catch (listErr) {
            displayText = '\u274c Erro ao listar ' + metaType + ': ' + listErr.message;
          }

        } else {
          // Tratar como objeto Salesforce — listar campos
          const objName = aliasResolve(listArg);
          try {
            const base2 = 'http://localhost:' + (process.env.PORT || 3000);
            let descData;
            descData = await execDescribe(req, objName);

            const fields = descData.fields || [];
            fileName = objName + '_fields.txt';

            const lines = [];
            lines.push('='.repeat(60));
            lines.push('  OBJETO: ' + (descData.label || objName) + ' (' + (descData.name || objName) + ')');
            lines.push('  Org: ' + (selectedOrg?.name || 'Dev Org (padrao)'));
            lines.push('  Data: ' + new Date().toLocaleString('pt-BR'));
            lines.push('  Total de campos: ' + fields.length);
            lines.push('='.repeat(60));
            lines.push('');
            lines.push('API Name'.padEnd(40) + 'Label'.padEnd(30) + 'Type'.padEnd(15) + 'Custom');
            lines.push('-'.repeat(90));

            for (const f of fields) {
              lines.push(
                (f.name || '').padEnd(40) +
                (f.label || '').padEnd(30) +
                (f.type || '').padEnd(15) +
                (f.custom ? 'Yes' : '')
              );
            }
            lines.push('');
            lines.push('='.repeat(60));
            lines.push('  FIM DA LISTAGEM');
            lines.push('='.repeat(60));

            listContent = lines.join('\n');
            displayText = '## Objeto: ' + (descData.label || objName) + '\n\n';
            displayText += '**API Name:** ' + (descData.name || objName) + '\n';
            displayText += '**Total de campos:** ' + fields.length + '\n\n';
            displayText += '| # | Campo | API Name | Tipo | Custom |\n|---|---|---|---|---|\n';
            fields.slice(0, 30).forEach((f, idx) => {
              displayText += '| ' + (idx + 1) + ' | ' + (f.label || '') + ' | ' + (f.name || '') + ' | ' + (f.type || '') + ' | ' + (f.custom ? 'Sim' : '') + ' |\n';
            });
            if (fields.length > 30) {
              displayText += '\n*...e mais ' + (fields.length - 30) + ' campos no arquivo .txt*';
            }
          } catch (descErr) {
            displayText = '\u274c Erro ao descrever ' + objName + ': ' + descErr.message;
          }
        }

        // Salvar .txt em /tmp/prototipos para download
        if (listContent && fileName) {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const dir = '/tmp/prototipos';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, fileName), listContent);
            const host = req.headers.host || 'everi9.albertobottaro.info';
            const downloadUrl = 'https://' + host + '/prototipos/' + fileName;
            displayText += '\n\n[\u2b07 Baixar ' + fileName + '](' + downloadUrl + ')';
          } catch {}
        }

        response = displayText;
        modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
        break;
      }
      case 'hf':
        if (usesFree) {
          // Keep-alive: a cascata pelo pool + geracao pode passar de 30s (timeout do Heroku).
          // Enviar bytes a cada 10s mantem a conexao viva. Frontend faz res.text().trim() -> parse.
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Transfer-Encoding', 'chunked');
          res.write(' ');
          const kaHf = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
          try {
            const fr = await openrouter.callWithDynamicPool(hfPrompt, messages);
            clearInterval(kaHf);
            res.end(JSON.stringify({
              choices: [{ message: { content: '[[ALERT-FREE:' + fr.label + ']]\n\n' + fr.text } }],
              modelo_usado: fr.model, modelo_label: fr.label, tipo: 'hf',
            }));
          } catch {
            clearInterval(kaHf);
            res.end(JSON.stringify({
              choices: [{ message: { content: FREE_UNAVAILABLE } }],
              modelo_usado: 'free-unavailable', modelo_label: 'Indisponivel', tipo: 'hf',
            }));
          }
          return;
        } else {
          response = await grok.call(hfPrompt, messages);
          modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        }
        break;
      case 'ata':
        if (usesFree) {
          try {
            const fr = await openrouter.callWithFallback(ataPrompt, messages, selectedModel);
            response = '[[ALERT-FREE:' + openrouter.labelFor(fr.model) + ']]\n\n' + fr.text;
            modelUsed = fr.model; modelLabel = openrouter.labelFor(fr.model);
          } catch { response = FREE_UNAVAILABLE; modelUsed = 'free-unavailable'; modelLabel = 'Indisponivel'; }
        } else {
          response = await grok.call(ataPrompt, messages);
          modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        }
        break;
      case 'describe': {
        const obj = messages[messages.length - 1].content.replace(/\/describe\s*/i, '').trim();
        const selectedOrg = await getSelectedOrg(req);
        if (selectedOrg) {
          const desc = await sfMulti.describeObject(selectedOrg, aliasResolve(obj));
          response = JSON.stringify(desc, null, 2);
        } else {
          const base = `http://localhost:${process.env.PORT || 3000}`;
          const r = await fetch(`${base}/api/describe/${aliasResolve(obj)}`);
          response = JSON.stringify(await r.json(), null, 2);
        }
        modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
        break;
      }
      case 'status': {
        const selectedOrg = await getSelectedOrg(req);
        if (selectedOrg) {
          const test = await sfMulti.testConnection(selectedOrg);
          response = JSON.stringify(test, null, 2);
        } else {
          const base = `http://localhost:${process.env.PORT || 3000}`;
          const r = await fetch(`${base}/test-connection`);
          response = JSON.stringify(await r.json(), null, 2);
        }
        modelUsed = 'mcp-server'; modelLabel = 'MCP Server';
        break;
      }
      default:
        const lastMsg = messages[messages.length - 1]?.content || '';
        const basePrompt = 'Voce e um assistente especialista. Responda em portugues do Brasil. Sempre traga informacoes atualizadas quando possivel.';
        if (usesFree) {
          try {
            const fr = await openrouter.callWithFallback(basePrompt, messages, selectedModel);
            response = '[[ALERT-FREE:' + openrouter.labelFor(fr.model) + ']]\n\n' + fr.text;
            modelUsed = fr.model; modelLabel = openrouter.labelFor(fr.model);
          } catch { response = FREE_UNAVAILABLE; modelUsed = 'free-unavailable'; modelLabel = 'Indisponivel'; }
        } else if (needsKB(lastMsg)) {
          response = await grok.call(basePrompt + '\n\nUse a base de conhecimento do projeto:\n\n' + knowledgeBase, messages, 16384, { search: true });
          modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        } else {
          response = await grok.call(basePrompt, messages, 16384, { search: true });
          modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        }
    }

    res.json({
      choices: [{ message: { content: response } }],
      modelo_usado: modelUsed,
      modelo_label: modelLabel,
      tipo: command,
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    try { res.status(503).json({ erro: `Erro: ${err.message}` }); } catch {}
  }
});

// GET /api/chat/stream — SSE streaming puro
router.get('/stream', authMiddleware, async (req, res) => {
  try {
    const messages = JSON.parse(req.query.messages || '[]');
    const command = detectCommand(messages);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let readable;
    if (command === 'spec') readable = await claude.stream(specPrompt, messages);
    else if (command === 'hf') readable = await grok.stream(hfPrompt, messages);
    else if (command === 'ata') readable = await grok.stream(ataPrompt, messages);
    else readable = await grok.stream('Voce e um assistente Salesforce.', messages);

    const reader = readable.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const raw = line.replace('data: ', '');
        if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
        try {
          const p = JSON.parse(raw);
          const text = p.delta?.text || p.choices?.[0]?.delta?.content || '';
          if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
        } catch {}
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

export default router;
