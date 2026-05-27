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
  admin:     ['spec', 'hf', 'ata', 'deploy', 'describe', 'status', 'chat'],
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
        choices: [{ message: { content: '🔒 **Acesso negado**\n\nVocê não tem permissão de acesso à consultas externas e a AI.\n\nSeu perfil **' + userRole + '** permite apenas: ' + (ROLE_PERMISSIONS[userRole] || []).map(c => '/' + c).join(', ') + '.\n\nEntre em contato com o administrador para solicitar acesso.' } }],
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
        const basePrompt = 'Voce e um assistente Salesforce especialista. Responda em portugues do Brasil.';
        if (needsKB(lastMsg)) {
          response = await grok.call(basePrompt + '\n\nUse a base de conhecimento do projeto:\n\n' + knowledgeBase, messages);
        } else {
          response = await grok.call(basePrompt, messages);
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
