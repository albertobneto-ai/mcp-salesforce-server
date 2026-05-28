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

        // Ler metadados relevantes da org para contexto
        let orgContext = '';
        try {
          // Detectar que metadata ler com base no requisito
          const reqLower = originalReq.toLowerCase();
          const metadataReads = [];

          if (reqLower.includes('forecast')) {
            const fr = await fetch(base + '/api/metadata-read/ForecastingSettings/Forecasting');
            metadataReads.push({ type: 'ForecastingSettings', data: await fr.json() });
          }
          if (reqLower.includes('lead') || reqLower.includes('opportunity') || reqLower.includes('account') || reqLower.includes('contact')) {
            const objName = reqLower.includes('lead') ? 'Lead' : reqLower.includes('opportunity') ? 'Opportunity' : reqLower.includes('account') ? 'Account' : 'Contact';
            const dr = await fetch(base + '/api/describe/' + objName);
            const desc = await dr.json();
            metadataReads.push({ type: 'Describe_' + objName, fields: (desc.fields || []).slice(0, 30).map(f => f.name + ' (' + f.type + ')') });
          }

          orgContext = JSON.stringify(metadataReads, null, 2);
        } catch (readErr) {
          orgContext = 'Erro ao ler metadata: ' + readErr.message;
        }

        // Pedir ao Grok para gerar os comandos EXATOS baseado no estado real da org
        let smartCommands;
        try {
          const smartPrompt = [
            'Voce e um configurador Salesforce. Com base no ESTADO ATUAL da org e no REQUISITO, gere os comandos EXATOS para implementar.',
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
            '- Para metadata-update: metadataType, body (JSON COMPLETO do metadata atualizado, nao parcial)',
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
            'REGRAS DE CODE:',
            '- Se a solucao precisa de Apex ou LWC, inclua o codigo COMPLETO em code',
            '- apexClasses: codigo .cls completo e funcional',
            '- lwc: JS, HTML e meta.xml completos',
            '- Se NAO precisa de codigo, deixe code como null',
            '- O codigo sera deployado automaticamente na org via SFDX ZIP'
          ].join('\n');

          const smartResp = await grok.call(smartPrompt, [{ role: 'user', content: 'Gere os comandos para implementar o requisito' }], 8192);
          
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
                deployResults.push({ component: (step.description || 'Criar: ' + step.metadataType), ...result });

              } else if (step.type === 'execute-apex') {
                const r = await fetch(base + '/api/execute-anonymous', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ code: step.code }),
                });
                const result = await r.json();
                deployResults.push({ component: (step.description || 'Apex'), success: result.success !== false, errors: result.errors || [] });

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
