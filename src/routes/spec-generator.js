// src/routes/spec-generator.js — Spec-to-Runbook with fallback: DeepSeek → Grok → Sonnet
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── Keys ──
const _XK = 'eGFpLU44R2J0UGNrdk1GSXJ0eGltWlVqZ2l1aVN2OHkzVVlFTFZxS0VURmxvdHBoaVRPZ1F6RDlnZjZtTHVQb3VLSHdZa2swVHRqaXJuT1puOGJm';
const getXaiKey = () => process.env.XAI_KEY || process.env.GROK_KEY || Buffer.from(_XK, 'base64').toString('utf-8');
const getAnthropicKey = () => process.env.ANTHROPIC_KEY || '';
const getOpenRouterKey = () => process.env.OPENROUTER_KEY || '';

// ── Model configs ──
const MODELS = [
  {
    id: 'deepseek',
    label: 'DeepSeek V4 Flash',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'deepseek/deepseek-v4-flash',
    getKey: getOpenRouterKey,
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://everi9.albertobottaro.info',
      'X-Title': 'Ever i9 Spec Generator',
    }),
    buildBody: (model, msgs) => ({
      model, messages: msgs, max_tokens: 16384, temperature: 0.15, stream: true,
    }),
    extractDelta: (json) => json.choices?.[0]?.delta?.content,
    extractFull: (json) => json.choices?.[0]?.message?.content,
  },
  {
    id: 'grok',
    label: 'Grok 4.3 (xAI)',
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-4.3',
    getKey: getXaiKey,
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    buildBody: (model, msgs) => ({
      model, messages: msgs, max_tokens: 16384, temperature: 0.15, stream: true,
    }),
    extractDelta: (json) => json.choices?.[0]?.delta?.content,
    extractFull: (json) => json.choices?.[0]?.message?.content,
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet 4.6',
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-6',
    getKey: getAnthropicKey,
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (model, msgs) => ({
      model, max_tokens: 16384, temperature: 0.15, stream: true,
      system: msgs.find(m => m.role === 'system')?.content || '',
      messages: msgs.filter(m => m.role !== 'system'),
    }),
    extractDelta: (json) => {
      if (json.type === 'content_block_delta') return json.delta?.text;
      return null;
    },
    extractFull: (json) => json.content?.[0]?.text,
  },
];

// ── System Prompt ──
const SYSTEM_PROMPT = `# SF Agent — Conversor Completo de Spec Técnica para Runbook Executável

## Papel
Você converte especificações técnicas Salesforce em Runbook JSON estruturado para execução automática no SF Agent.

## Regra de ouro
ZERO intervenção manual. Tudo via Metadata API.

## REGRAS CRÍTICAS — LEIA ANTES DE GERAR

### Objetos STANDARD — NUNCA criar como customObject
Os seguintes objetos JÁ EXISTEM no Salesforce e NUNCA devem aparecer em customObjects:
Lead, Account, Contact, Opportunity, Case, Order, Quote, Contract, Campaign, Product2, Pricebook2, PricebookEntry, OpportunityLineItem, Task, Event, User, ContentDocument, ContentVersion, Attachment, Note, EmailMessage, FeedItem, Dashboard, Report.

Para objetos standard, apenas ADICIONE campos em customFields com o objectName correto.
ERRADO: {"customObjects":[{"fullName":"Account",...}]} ← NUNCA FAÇA ISSO
CERTO: {"customFields":[{"objectName":"Account","fieldName":"CNPJ__c",...}]}

### Picklist
SEMPRE array simples: "picklist":["V1","V2"]. NUNCA picklistValues ou valueSet.

---

## FORMATO DO RUNBOOK

{
  "specName": "Nome_Fase_N",
  "summary": "Descrição",
  "metadata": {
    "customObjects": [],
    "customFields": [],
    "validationRules": [],
    "recordTypes": [],
    "permissionSets": []
  },
  "apexClasses": [],
  "apexTriggers": [],
  "flows": [],
  "layoutOperations": [],
  "listViews": [],
  "quickActions": [],
  "compactLayouts": [],
  "fieldHistory": [],
  "manual": []
}

---

## COMPONENTES

### 1. Custom Objects (APENAS objetos NOVOS com sufixo __c)
{"fullName":"Visita__c","label":"Visita","pluralLabel":"Visitas","nameField":{"type":"AutoNumber","label":"Número","displayFormat":"VIS-{0000}"},"sharingModel":"ReadWrite","deploymentStatus":"Deployed"}

### 2. Custom Fields
Sempre: objectName, fieldName (com __c), label, type + params do tipo.
Tipos: Text(+length), LongTextArea(+length,visibleLines), Number/Currency/Percent(+precision,scale), Picklist(+picklist[]), MultiselectPicklist(+picklist[],visibleLines), Lookup/MasterDetail(+referenceTo,relationshipLabel), Checkbox, Date, DateTime, Email, Phone, Url, TextArea, Html(+length,visibleLines), Formula(+formula,formulaTreatBlanksAs).

### 3. Validation Rules
{"objectName":"Opportunity","fullName":"Opportunity.Valor_Minimo","active":true,"errorConditionFormula":"Amount < 100","errorMessage":"Valor mínimo R$100","errorDisplayField":"Amount"}
Fórmula = TRUE quando dado é INVÁLIDO.

### 4. Record Types
{"objectName":"Account","fullName":"Account.Enterprise","label":"Enterprise","active":true,"description":"Contas enterprise"}

### 5. Page Layouts (layoutOperations)
Operações sequenciais:

moveField: {"action":"moveField","layoutName":"Account-Account Layout","fieldName":"CNPJ__c","toSection":"Dados Fiscais"}
addRelatedList: {"action":"addRelatedList","layoutName":"Account-Account Layout","relatedListName":"Visita__c.Account__c"}
removeField: {"action":"removeField","layoutName":"Account-Account Layout","fieldName":"Fax"}

Layout completo com seções:
{"action":"defineLayout","layoutName":"Account-Account Layout","sections":[
  {"label":"Identificação","columns":2,"fields":["Name","Type","Industry","Phone"]},
  {"label":"Dados Fiscais","columns":2,"fields":["CNPJ__c","Inscricao_Estadual__c"]},
  {"label":"Endereço","columns":2,"fields":["BillingStreet","BillingCity","BillingState"]}
],"relatedLists":["Contacts","Opportunities","Visita__c.Account__c"]}

### 6. Flows (XML completo no campo definition)
Record-Triggered After Save:
{"name":"Update_Account_After_Visit","definition":"<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n<Flow xmlns=\\"http://soap.sforce.com/2006/04/metadata\\">\\n<apiVersion>62.0</apiVersion>\\n<status>Active</status>\\n<processType>AutoLaunchedFlow</processType>\\n<label>Update Account After Visit</label>\\n<start>\\n<locationX>50</locationX>\\n<locationY>0</locationY>\\n<connector><targetReference>Update_Account</targetReference></connector>\\n<object>Visita__c</object>\\n<recordTriggerType>CreateAndUpdate</recordTriggerType>\\n<triggerType>RecordAfterSave</triggerType>\\n<filters><field>Status__c</field><operator>EqualTo</operator><value><stringValue>Realizada</stringValue></value></filters>\\n</start>\\n<recordUpdates>\\n<name>Update_Account</name>\\n<label>Update Account</label>\\n<locationX>176</locationX>\\n<locationY>158</locationY>\\n<object>Account</object>\\n<filters><field>Id</field><operator>EqualTo</operator><value><elementReference>$Record.Account__c</elementReference></value></filters>\\n<inputAssignments><field>Ultima_Visita__c</field><value><elementReference>$Record.Data_Visita__c</elementReference></value></inputAssignments>\\n</recordUpdates>\\n</Flow>"}

Elementos disponíveis: decisions, assignments, recordLookups, recordCreates, recordUpdates, recordDeletes, loops, screens, actionCalls (apex/email), subflows, waits, collectionProcessors.

Before Save: triggerType=RecordBeforeSave, assignments em $Record (sem recordUpdates).
Screen Flow: processType=Flow, com screens e fields.
Scheduled: start com schedule, frequency, startDate, startTime.

### 7. Apex Classes
{"name":"VisitaService","body":"public class VisitaService {\\n    @InvocableMethod(label='Get Visitas Pendentes')\\n    public static List<List<Visita__c>> getPendentes(List<Id> accountIds) {\\n        List<List<Visita__c>> results = new List<List<Visita__c>>();\\n        Map<Id, List<Visita__c>> byAccount = new Map<Id, List<Visita__c>>();\\n        for (Visita__c v : [SELECT Id, Name, Data_Visita__c, Status__c, Account__c FROM Visita__c WHERE Account__c IN :accountIds AND Status__c = 'Agendada' ORDER BY Data_Visita__c]) {\\n            if (!byAccount.containsKey(v.Account__c)) byAccount.put(v.Account__c, new List<Visita__c>());\\n            byAccount.get(v.Account__c).add(v);\\n        }\\n        for (Id aid : accountIds) results.add(byAccount.containsKey(aid) ? byAccount.get(aid) : new List<Visita__c>());\\n        return results;\\n    }\\n}"}
REGRAS: Código COMPLETO, bulkificado, null handling, NUNCA stubs/TODOs.

### 8. Apex Triggers
{"name":"OpportunityTrigger","body":"trigger OpportunityTrigger on Opportunity (before insert, before update) {\\n    for (Opportunity opp : Trigger.new) {\\n        if (opp.Amount != null && opp.Amount > 1000000) opp.Priority__c = 'Alta';\\n    }\\n}"}

### 9. Permission Sets
{"label":"Vendedor_B2B","description":"Acesso B2B","objectPermissions":[{"object":"Visita__c","allowCreate":true,"allowRead":true,"allowEdit":true,"allowDelete":false}],"fieldPermissions":[{"field":"Account.CNPJ__c","readable":true,"editable":true}]}

### 10. List Views
{"objectName":"Visita__c","fullName":"Visita__c.Pendentes","label":"Visitas Pendentes","filterScope":"Everything","columns":["NAME","Data_Visita__c","Status__c","Account__c"],"filters":[{"field":"Status__c","operation":"equals","value":"Agendada"}]}

### 11. Quick Actions
{"objectName":"Account","fullName":"Account.Nova_Visita","type":"Create","targetSobjectType":"Visita__c","label":"Nova Visita","fields":["Account__c","Data_Visita__c","Status__c"]}

### 12. Compact Layouts
{"objectName":"Visita__c","fullName":"Visita__c.Default_Compact","label":"Compact","fields":["Name","Status__c","Data_Visita__c","Account__c"]}

### 13. Field History Tracking
{"object":"Visita__c","fields":["Status__c","Data_Visita__c","OwnerId"]}

### 14. Manual (ÚLTIMO RECURSO — sem API)
{"type":"OrgConfig","name":"...","description":"...","steps":"Setup > ..."}

---

## FASES (ordem de dependência)
1. Custom Objects (novos __c apenas)
2. Custom Fields objetos custom
3. Custom Fields objetos standard
4. Record Types + Validation Rules
5. Layouts + Compact Layouts + List Views
6. Flows (XML completo)
7. Apex + Triggers + Test Classes
8. Permission Sets + Quick Actions
9. Field History + Manual

Máximo 15 componentes/fase. Specs pequenas condensam.

## SAÍDA
=== FASE N: [descrição] ===
\\\`\\\`\\\`json
{json}
\\\`\\\`\\\`

APENAS fases. Sem texto extra.`;

// ── Streaming helper ──
async function streamFromModel(modelCfg, messages, res, log) {
  const key = modelCfg.getKey();
  if (!key) {
    log.push({ model: modelCfg.id, status: 'skipped', reason: 'no API key' });
    return false;
  }

  log.push({ model: modelCfg.id, status: 'trying', label: modelCfg.label });
  console.log(`[spec-gen] Trying ${modelCfg.label}...`);

  try {
    const body = modelCfg.buildBody(modelCfg.model, messages);
    const apiRes = await fetch(modelCfg.url, {
      method: 'POST',
      headers: modelCfg.headers(key),
      body: JSON.stringify(body),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      const reason = `HTTP ${apiRes.status}: ${errBody.slice(0, 150)}`;
      log.push({ model: modelCfg.id, status: 'failed', reason });
      console.error(`[spec-gen] ${modelCfg.label} failed:`, reason.slice(0, 200));
      return false;
    }

    // Success — stream to client
    log.push({ model: modelCfg.id, status: 'streaming' });
    console.log(`[spec-gen] ${modelCfg.label} connected, streaming...`);

    // Send model info event
    res.write(`data: ${JSON.stringify({ meta: { model: modelCfg.id, label: modelCfg.label } })}\n\n`);

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalChars = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        // Anthropic streaming events
        if (modelCfg.id === 'sonnet') {
          try {
            const json = JSON.parse(payload);
            if (json.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
              continue;
            }
            const delta = modelCfg.extractDelta(json);
            if (delta) {
              totalChars += delta.length;
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            }
          } catch { /* skip */ }
        } else {
          try {
            const json = JSON.parse(payload);
            const delta = modelCfg.extractDelta(json);
            if (delta) {
              totalChars += delta.length;
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            }
          } catch { /* skip */ }
        }
      }
    }

    log.push({ model: modelCfg.id, status: 'success', chars: totalChars });
    console.log(`[spec-gen] ${modelCfg.label} done, ${totalChars} chars`);
    return true;
  } catch (err) {
    log.push({ model: modelCfg.id, status: 'error', reason: err.message });
    console.error(`[spec-gen] ${modelCfg.label} error:`, err.message);
    return false;
  }
}

// ── POST /convert (streaming SSE with fallback) ──
router.post('/convert', authMiddleware, async (req, res) => {
  const { specText } = req.body;
  if (!specText || specText.trim().length < 50) {
    return res.status(400).json({ error: 'Especificação muito curta. Cole o conteúdo completo da spec.' });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Converta esta especificação técnica Salesforce em Runbook JSON executável. Inclua TODOS os componentes: objetos custom (NUNCA standard), campos, validation rules, record types, page layouts, flows (XML completo), apex, permission sets, list views, quick actions, compact layouts, field history.\n\n${specText}` },
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const log = [];

  for (const modelCfg of MODELS) {
    const ok = await streamFromModel(modelCfg, messages, res, log);
    if (ok) {
      // Send log summary
      res.write(`data: ${JSON.stringify({ log })}\n\n`);
      res.end();
      return;
    }
  }

  // All models failed
  res.write(`data: ${JSON.stringify({ error: 'Todos os modelos falharam', log })}\n\n`);
  res.end();
});

// ── POST /convert-sync (non-streaming with fallback) ──
router.post('/convert-sync', authMiddleware, async (req, res) => {
  const { specText } = req.body;
  if (!specText || specText.trim().length < 50) {
    return res.status(400).json({ error: 'Especificação muito curta.' });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Converta esta especificação técnica Salesforce em Runbook JSON executável:\n\n${specText}` },
  ];

  const log = [];

  for (const modelCfg of MODELS) {
    const key = modelCfg.getKey();
    if (!key) {
      log.push({ model: modelCfg.id, status: 'skipped', reason: 'no key' });
      continue;
    }

    log.push({ model: modelCfg.id, status: 'trying' });
    try {
      const body = { ...modelCfg.buildBody(modelCfg.model, messages), stream: false };
      const apiRes = await fetch(modelCfg.url, {
        method: 'POST',
        headers: modelCfg.headers(key),
        body: JSON.stringify(body),
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text().catch(() => '');
        log.push({ model: modelCfg.id, status: 'failed', reason: `HTTP ${apiRes.status}` });
        continue;
      }

      const data = await apiRes.json();
      const text = modelCfg.extractFull(data) || '';
      if (text.length > 10) {
        log.push({ model: modelCfg.id, status: 'success', chars: text.length });
        return res.json({ runbook: text, model: modelCfg.id, label: modelCfg.label, log });
      }
      log.push({ model: modelCfg.id, status: 'empty' });
    } catch (err) {
      log.push({ model: modelCfg.id, status: 'error', reason: err.message });
    }
  }

  res.status(502).json({ error: 'Todos os modelos falharam', log });
});

// ── GET /models — lista modelos disponíveis ──
router.get('/models', (req, res) => {
  const available = MODELS.map(m => ({
    id: m.id,
    label: m.label,
    hasKey: !!m.getKey(),
  }));
  res.json({ models: available });
});

export default router;
