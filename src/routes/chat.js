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

const router = express.Router();

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
  admin:     ['spec', 'hf', 'ata', 'deploy', 'describe', 'status', 'chat', 'prototipo', 'list', 'discovery'],
  funcional: ['hf', 'ata'],
  architect: ['spec', 'ata', 'list', 'discovery'],
  developer: ['deploy', 'describe', 'ata', 'list', 'discovery'],
  candidato: ['chat'],
};

function checkPermission(role, command) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(command);
}

function detectCommand(messages) {
  const last = (messages[messages.length - 1]?.content || '').toLowerCase();
  if (last.startsWith('/spec') || last.includes('gere a spec')) return 'spec';
  if (last.startsWith('/hf') || last.includes('historia funcional')) return 'hf';
  if (last.startsWith('/ata') || last.includes('ata de reuniao')) return 'ata';
  if (last.startsWith('/discovery') || last.startsWith('/disc')) return 'discovery';
  if (last.startsWith('/list')) return 'list';
  if (last.startsWith('/prototipo') || last.startsWith('/proto')) return 'prototipo';
  if (last.startsWith('/deploy')) return 'deploy';
  if (last.startsWith('/describe')) return 'describe';
  if (last.startsWith('/status') || last.startsWith('/org')) return 'status';
  return 'chat';
}

// ── Helper: parsear stream SSE e coletar texto completo ──
async function collectStream(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let full = '';
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
      } catch {}
    }
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
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages obrigatorio' });

    const command = detectCommand(messages);
    const userRole = req.user?.role || 'funcional';

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
      const readable = await claude.stream(specPrompt, messages);
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
              const dr = await fetch(baseDeploy + '/api/describe/' + obj);
              const desc = await dr.json();
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
          '- setup-instruction APENAS se impossivel via API, com setupUrl',
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

      // 3. Executar steps
      const deployResults = [];
      for (const step of smartDeploy.steps) {
        try {
          if (step.type === 'metadata-create') {
            const r = await fetch(baseDeploy + '/api/metadata-create/' + step.metadataType, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(step.body),
            });
            const result = await r.json();
            const alreadyExists = (result.errors || []).some(e => (e.message || '').includes('already') || (e.message || '').includes('duplicate'));
            deployResults.push({ component: (step.description || step.metadataType), success: result.success || alreadyExists, errors: alreadyExists ? [] : (result.errors || []) });

          } else if (step.type === 'add-to-layout') {
            const ln = encodeURIComponent(step.layout || (step.object + '-' + step.object + ' Layout'));
            const fn = encodeURIComponent(step.field);
            const sn = encodeURIComponent(step.section || (step.object + ' Information'));
            const r = await fetch(baseDeploy + '/api/move-field-in-layout/' + ln + '/' + fn + '/' + sn);
            const result = await r.json();
            deployResults.push({ component: (step.description || 'Layout: ' + step.field), success: result.success || result.status === 'added' || result.status === 'moved', errors: result.error ? [{ message: result.error }] : [] });

          } else if (step.type === 'add-permission') {
            const psName = step.permissionSetName || 'Everi9_Deploy_Access';
            const body = { fullName: psName, label: step.permissionSetLabel || psName.replace(/_/g, ' '), fieldPermissions: (step.fields || [step.field]).map(f => ({ field: f, editable: true, readable: true })) };
            let r = await fetch(baseDeploy + '/api/metadata-create/PermissionSet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            let result = await r.json();
            if (!result.success) { r = await fetch(baseDeploy + '/api/metadata-update/PermissionSet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); result = await r.json(); }
            deployResults.push({ component: (step.description || 'Permission Set'), success: result.success !== false, errors: result.errors || [] });
            // Assign PS
            try {
              const assignApex = "PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = '" + psName + "' LIMIT 1]; List<User> users = [SELECT Id FROM User WHERE IsActive = true AND UserType = 'Standard' AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :ps.Id)]; List<PermissionSetAssignment> psas = new List<PermissionSetAssignment>(); for (User u : users) { psas.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id)); } if (!psas.isEmpty()) insert psas;";
              await fetch(baseDeploy + '/api/execute-anonymous', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: assignApex }) });
              deployResults.push({ component: 'Atribuir PS aos usuarios', success: true, errors: [] });
            } catch {}

          } else if (step.type === 'metadata-update') {
            const r = await fetch(baseDeploy + '/api/metadata-update/' + step.metadataType, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(step.body) });
            const result = await r.json();
            deployResults.push({ component: (step.description || step.metadataType), success: result.success !== false, errors: result.errors || [] });

          } else if (step.type === 'execute-apex') {
            const r = await fetch(baseDeploy + '/api/execute-anonymous', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: step.code }) });
            const result = await r.json();
            deployResults.push({ component: (step.description || 'Apex'), success: result.success !== false, errors: result.errors || [] });

          } else if (step.type === 'setup-instruction') {
            deployResults.push({ component: step.step || step.description, success: true, manual: true, setupUrl: step.setupUrl || '', errors: [] });
          }
        } catch (stepErr) {
          deployResults.push({ component: (step.description || step.type), success: false, errors: [{ message: stepErr.message }] });
        }
      }
clearInterval(keepAlive);

      // 4. Formatar resultado
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

      const manualSteps = deployResults.filter(r => r.manual);
      if (manualSteps.length > 0) {
        resultLines.push(''); resultLines.push('---'); resultLines.push('');
        resultLines.push('### Configuracao manual');
        let instanceUrl = '';
        try { const cr = await fetch(baseDeploy + '/test-connection'); instanceUrl = (await cr.json()).instanceUrl || ''; } catch {}
        manualSteps.forEach((step, idx) => {
          resultLines.push('**Passo ' + (idx + 1) + ':** ' + step.component);
          if (step.setupUrl && instanceUrl) resultLines.push('[\u27a1 Abrir no Setup](' + instanceUrl + step.setupUrl + ')');
          resultLines.push('');
        });
      }

      res.end(JSON.stringify({
        choices: [{ message: { content: resultLines.join('\n') } }],
        modelo_usado: 'claude-sonnet-4-6',
        modelo_label: 'Claude Sonnet (Smart Deploy)',
        tipo: 'deploy',
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
                const dr = await fetch(base + '/api/describe/' + obj);
                const desc = await dr.json();
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
                const sr = await fetch(base + '/api/metadata-read/' + metaType + '/' + fullName);
                metadataReads.push({ type: metaType, data: await sr.json() });
              } catch {}
            }
          }

          // Se nenhum objeto detectado, descrever os mais comuns
          if (metadataReads.length === 0) {
            try {
              const dr = await fetch(base + '/api/describe/Opportunity');
              const desc = await dr.json();
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
            const encSoql = Buffer.from(soql).toString('base64');
            const sr = await fetch(baseDisc + '/api/soql-b64/' + encSoql);
            const result = await sr.json();
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
          try {
            // Tentar como Flow
            let encSoql = Buffer.from("SELECT Id, ApiName, Label, ProcessType, TriggerType, Description, IsActive FROM FlowDefinitionView WHERE ApiName LIKE '%" + discArg.replace(/ /g, '%') + "%' OR Label LIKE '%" + discArg + "%'").toString('base64');
            let sr = await fetch(baseDisc + '/api/soql-b64/' + encSoql);
            let result = await sr.json();
            if (result.records?.length) {
              discoveryData = result.records;
              discoveryType = 'flow';
            } else {
              // Tentar como Apex
              encSoql = Buffer.from("SELECT Id, Name, Body, Status FROM ApexClass WHERE Name LIKE '%" + discArg.replace(/ /g, '%') + "%'").toString('base64');
              sr = await fetch(baseDisc + '/api/soql-b64/' + encSoql);
              result = await sr.json();
              if (result.records?.length) {
                discoveryData = result.records;
                discoveryType = 'apex';
              } else {
                // Tentar como Trigger
                encSoql = Buffer.from("SELECT Id, Name, Body, TableEnumOrId, Status FROM ApexTrigger WHERE Name LIKE '%" + discArg.replace(/ /g, '%') + "%'").toString('base64');
                sr = await fetch(baseDisc + '/api/soql-b64/' + encSoql);
                result = await sr.json();
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
          componentSummary = discoveryData.map(f => {
            return 'Flow: ' + (f.Label || f.ApiName) + ' | Tipo: ' + (f.ProcessType || '?') + ' | Trigger: ' + (f.TriggerType || 'N/A') + ' | Ativo: ' + (f.IsActive ? 'Sim' : 'Nao') + ' | Desc: ' + (f.Description || 'sem descricao');
          }).join('\n');
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

        // /list all — listar TODOS os objetos da org
        if (argLower === 'all' || argLower === 'todos' || argLower === 'objetos' || argLower === 'objects') {
          try {
            const base2 = 'http://localhost:' + (process.env.PORT || 3000);
            const soql = "SELECT QualifiedApiName, Label, KeyPrefix, IsCustom, IsCustomSetting FROM EntityDefinition WHERE IsLayoutable = true ORDER BY QualifiedApiName";
            const encSoql = Buffer.from(soql).toString('base64');
            const sr = await fetch(base2 + '/api/soql-b64/' + encSoql);
            const soqlResult = await sr.json();
            const items = soqlResult.records || [];

            const standard = items.filter(i => !i.IsCustom);
            const custom = items.filter(i => i.IsCustom);

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

        let listContent = '';
        let fileName = '';
        let displayText = '';

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
              'PermissionSet': "SELECT Id, Name, Label, IsCustom, Description FROM PermissionSet WHERE IsCustom = true ORDER BY Label",
              'Profile': "SELECT Id, Name FROM Profile ORDER BY Name",
              'ValidationRule': "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active, Description FROM ValidationRule ORDER BY ValidationName",
              'RecordType': "SELECT Id, Name, DeveloperName, SobjectType, IsActive FROM RecordType ORDER BY SobjectType, Name",
              'CustomObject': "SELECT Id, DeveloperName, Description FROM CustomObject WHERE DeveloperName != null ORDER BY DeveloperName",
              'Report': "SELECT Id, Name, DeveloperName, FolderName FROM Report ORDER BY FolderName, Name LIMIT 200",
              'Dashboard': "SELECT Id, Title, DeveloperName, FolderName FROM Dashboard ORDER BY FolderName, Title LIMIT 200",
              'EmailTemplate': "SELECT Id, Name, DeveloperName, FolderName, Subject FROM EmailTemplate ORDER BY FolderName, Name LIMIT 200",
            };

            const soql = soqlMap[metaType];
            if (soql) {
              const encSoql = Buffer.from(soql).toString('base64');
              const sr = await fetch(base2 + '/api/soql-b64/' + encSoql);
              const soqlResult = await sr.json();
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
            displayText += '| # | Nome | Detalhes |\n|---|---|---|\n';
            items.slice(0, 30).forEach((item, idx) => {
              const name = item.Name || item.Label || item.MasterLabel || item.DeveloperName || item.ApiName || item.ValidationName || item.Title || 'N/A';
              const detail = item.ProcessType || item.Status || item.SobjectType || item.FolderName || (item.IsActive === true ? 'Active' : item.IsActive === false ? 'Inactive' : '') || '';
              displayText += '| ' + (idx + 1) + ' | ' + name + ' | ' + detail + ' |\n';
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
            if (selectedOrg) {
              descData = await sfMulti.describeObject(selectedOrg, objName);
            } else {
              const dr = await fetch(base2 + '/api/describe/' + objName);
              descData = await dr.json();
            }

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
        response = await grok.call(hfPrompt, messages);
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
        break;
      case 'ata':
        response = await grok.call(ataPrompt, messages);
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
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
        if (needsKB(lastMsg)) {
          response = await grok.call(basePrompt + '\n\nUse a base de conhecimento do projeto:\n\n' + knowledgeBase, messages, 16384, { search: true });
        } else {
          response = await grok.call(basePrompt, messages, 16384, { search: true });
        }
        modelUsed = 'grok-4.20'; modelLabel = 'Grok 4.20';
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
