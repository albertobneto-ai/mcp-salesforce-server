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
  admin:     ['spec', 'hf', 'ata', 'deploy', 'describe', 'status', 'chat', 'prototipo'],
  funcional: ['hf', 'ata'],
  architect: ['spec', 'ata'],
  developer: ['deploy', 'describe', 'ata'],
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

    // ── DEPLOY: Grok gera manifest → MCP Server deploya ──
    if (command === 'deploy') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(' ');

      const userReq = messages[messages.length - 1].content.replace(/\/deploy\s*/i, '').trim();
      
      // 1. Grok gera o manifest
      const keepAlive = setInterval(() => { try { res.write(' '); } catch {} }, 10000);
      
      let manifestText;
      try {
        manifestText = await grok.call(deployPrompt, [{ role: 'user', content: userReq }], 4096);
      } catch (err) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '❌ Erro ao gerar manifest: ' + err.message } }],
          modelo_usado: 'grok-4.20', modelo_label: 'Grok 4.20', tipo: 'deploy',
        }));
        return;
      }

      // 2. Extrair JSON do manifest
      const manifest = extractJson(manifestText);
      if (!manifest) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '❌ Nao consegui gerar um manifest valido.\n\nResposta do modelo:\n```\n' + manifestText + '\n```' } }],
          modelo_usado: 'grok-4.20', modelo_label: 'Grok 4.20', tipo: 'deploy',
        }));
        return;
      }

      // 3. Deploy via metadata-create (mais confiavel que deploy-b64)
      const base = `http://localhost:${process.env.PORT || 3000}`;
      const deployResults = [];
      
      try {
        const deployOrg = await getSelectedOrg(req);

        // Deploy customFields
        if (manifest.metadata?.customFields?.length) {
          for (const field of manifest.metadata.customFields) {
            const fullName = `${field.objectName}.${field.fieldName}`;
            let result;
            if (deployOrg) {
              result = await sfMulti.deployField(deployOrg, field);
            } else {
              const body = { fullName, label: field.label, type: field.type };
              if (field.length) body.length = field.length;
              if (field.precision) body.precision = field.precision;
              if (field.scale) body.scale = field.scale;
              if (field.visibleLines) body.visibleLines = field.visibleLines;
              if (field.referenceTo) body.referenceTo = field.referenceTo;
              if (field.relationshipLabel) body.relationshipLabel = field.relationshipLabel;
              if (field.picklist) {
                body.valueSet = { valueSetDefinition: { value: field.picklist.map(v => ({ fullName: v, label: v, default: false })) } };
              }
              const r = await fetch(`${base}/api/metadata-create/CustomField`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              result = await r.json();
              result.component = `Field: ${fullName}`;
            }
            deployResults.push(result);
          }
        }

        // Deploy permissionSets
        if (manifest.metadata?.permissionSets?.length) {
          for (const ps of manifest.metadata.permissionSets) {
            const r = await fetch(`${base}/api/metadata-create/PermissionSet`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(ps)
            });
            const result = await r.json();
            deployResults.push({ component: `PermSet: ${ps.label || ps.name}`, ...result });
          }
        }

        // Deploy validationRules
        if (manifest.metadata?.validationRules?.length) {
          for (const vr of manifest.metadata.validationRules) {
            const r = await fetch(`${base}/api/metadata-create/ValidationRule`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(vr)
            });
            const result = await r.json();
            deployResults.push({ component: `Rule: ${vr.fullName}`, ...result });
          }
        }

        // Deploy recordTypes
        if (manifest.metadata?.recordTypes?.length) {
          for (const rt of manifest.metadata.recordTypes) {
            const r = await fetch(`${base}/api/metadata-create/RecordType`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rt)
            });
            const result = await r.json();
            deployResults.push({ component: `RecType: ${rt.fullName}`, ...result });
          }
        }
      } catch (err) {
        clearInterval(keepAlive);
        res.end(JSON.stringify({
          choices: [{ message: { content: '❌ Erro no deploy: ' + err.message + '\n\nManifest gerado:\n```json\n' + JSON.stringify(manifest, null, 2) + '\n```' } }],
          modelo_usado: 'grok-4.20', modelo_label: 'Grok 4.20', tipo: 'deploy',
        }));
        return;
      }
      
      const deployResult = {
        success: deployResults.every(r => r.success),
        total: deployResults.length,
        results: deployResults,
      };

      clearInterval(keepAlive);

      // 4. Formatar resultado
      const success = deployResult.success;
      const resultLines = [];
      resultLines.push(success ? '## ✅ Deploy realizado com sucesso!' : '## ❌ Deploy falhou');
      resultLines.push('');
      resultLines.push('### Manifest');
      resultLines.push('**specName:** ' + (manifest.specName || 'N/A'));
      if (manifest.metadata?.customFields?.length) {
        resultLines.push('');
        resultLines.push('### Campos criados');
        resultLines.push('| Objeto | Campo | Tipo |');
        resultLines.push('|---|---|---|');
        for (const f of manifest.metadata.customFields) {
          resultLines.push(`| ${f.objectName} | ${f.fieldName} | ${f.type} |`);
        }
      }
      if (manifest.metadata?.permissionSets?.length) {
        resultLines.push('');
        resultLines.push('### Permission Sets');
        for (const ps of manifest.metadata.permissionSets) {
          resultLines.push('- **' + ps.name + '**: ' + (ps.fieldPermissions?.map(fp => fp.field).join(', ') || 'N/A'));
        }
      }
      if (manifest.metadata?.validationRules?.length) {
        resultLines.push('');
        resultLines.push('### Validation Rules');
        for (const vr of manifest.metadata.validationRules) {
          resultLines.push('- **' + vr.fullName + '**');
        }
      }
      resultLines.push('');
      resultLines.push('### Resultado');
      resultLines.push('| Componente | Status |');
      resultLines.push('|---|---|');
      for (const r of deployResult.results || []) {
        const icon = r.success ? '✅' : '❌';
        const err = r.errors?.length ? ` — ${r.errors[0]?.message || ''}` : '';
        resultLines.push(`| ${r.component} | ${icon}${err} |`);
      }

      res.end(JSON.stringify({
        choices: [{ message: { content: resultLines.join('\n') } }],
        modelo_usado: 'grok-4.20',
        modelo_label: 'Grok 4.20',
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

        // Procurar manifest em TODO o historico de mensagens
        let manifest = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i].content || '';
          const mm = msg.match(/---MANIFEST---(\s*[\s\S]*?)---FIM---/);
          if (mm) {
            const raw = mm[1].trim();
            try { manifest = JSON.parse(raw); } catch {
              const jm = raw.match(/\{[\s\S]*\}/);
              if (jm) try { manifest = JSON.parse(jm[0]); } catch {}
            }
          }
          if (manifest) break;
        }

        if (!manifest) {
          // Tentar gerar manifest a partir do contexto
          try {
            const manifestText = await grok.call(deployPrompt, [{ role: 'user', content: 'Gere o manifest para deploy com base neste contexto:\n\n' + prevAssistant }], 4096);
            const start = manifestText.indexOf('{');
            const end = manifestText.lastIndexOf('}');
            if (start !== -1 && end !== -1) manifest = JSON.parse(manifestText.slice(start, end + 1));
          } catch {}
        }

        if (!manifest) {
          clearInterval(keepAlive3);
          res.end(JSON.stringify({
            choices: [{ message: { content: '\u274c Nao foi possivel extrair o manifest para deploy. Use /deploy para deployar manualmente.' } }],
            modelo_usado: 'system', modelo_label: 'Sistema', tipo: 'error',
          }));
          return;
        }

        // Executar deploy
        const selectedOrg = await getSelectedOrg(req);
        const base = 'http://localhost:' + (process.env.PORT || 3000);
        const deployResults = [];

        if (manifest.metadata?.customFields?.length) {
          for (const field of manifest.metadata.customFields) {
            let result;
            if (selectedOrg) {
              result = await sfMulti.deployField(selectedOrg, field);
            } else {
              const fullName = field.objectName + '.' + field.fieldName;
              const body = { fullName, label: field.label, type: field.type };
              if (field.length) body.length = field.length;
              if (field.precision) body.precision = field.precision;
              if (field.scale) body.scale = field.scale;
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

        clearInterval(keepAlive3);

        const success = deployResults.every(r => r.success);
        const resultLines = [];
        resultLines.push(success ? '## \u2705 Deploy realizado com sucesso!' : '## \u274c Deploy com erros');
        resultLines.push('');
        resultLines.push('| Componente | Status |');
        resultLines.push('|---|---|');
        for (const r of deployResults) {
          const icon = r.success ? '\u2705' : '\u274c';
          const err = r.errors?.length ? ' \u2014 ' + (r.errors[0]?.message || '') : '';
          resultLines.push('| ' + (r.component || 'N/A') + ' | ' + icon + err + ' |');
        }

        res.end(JSON.stringify({
          choices: [{ message: { content: resultLines.join('\n') } }],
          modelo_usado: 'system', modelo_label: 'MCP Server', tipo: 'deploy',
        }));
        return;
      }
    }

    switch (command) {
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
