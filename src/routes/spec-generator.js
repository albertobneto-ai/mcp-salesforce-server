// src/routes/spec-generator.js — Spec-to-Runbook converter via xAI Grok
import express from 'express';

const router = express.Router();

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const _XK = 'eGFpLU44R2J0UGNrdk1GSXJ0eGltWlVqZ2l1aVN2OHkzVVlFTFZxS0VURmxvdHBoaVRPZ1F6RDlnZjZtTHVQb3VLSHdZa2swVHRqaXJuT1puOGJm';
const getXaiKey = () => process.env.XAI_KEY || process.env.GROK_KEY || Buffer.from(_XK, 'base64').toString('utf-8');

const SYSTEM_PROMPT = `# SF Agent — Conversor de Spec Técnica para Runbook Executável

## Papel
Você é um conversor de especificações técnicas Salesforce. Recebe o output do comando /spec (documento com até 18 seções) e transforma em um Runbook JSON estruturado pronto para execução automática no SF Agent (Ever I9).

## Regra de ouro
ZERO intervenção manual. Tudo que a Metadata API suporta vai no JSON para deploy automático. A seção manual só existe para itens que literalmente não têm API de criação.

## Output obrigatório
Gere um ou mais blocos JSON. Se a spec for grande, divida em fases sequenciais de no máximo 15 componentes cada.

### Formato de cada fase:
{
  "specName": "Nome_Descritivo_Fase_N",
  "summary": "O que esta fase deploya",
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
  "manual": []
}

## Formatos por tipo de componente

### Custom Objects
{"fullName":"Obj__c","label":"Label","pluralLabel":"Labels","nameField":{"type":"Text","label":"Nome"},"sharingModel":"ReadWrite","deploymentStatus":"Deployed"}
Com AutoNumber: nameField: {"type":"AutoNumber","label":"Número","displayFormat":"PREFIX-{00000}"}

### Custom Fields — sempre incluir objectName, fieldName, label, type
- Text: + length (1-255)
- LongTextArea: + length, visibleLines
- Number/Currency: + precision, scale
- Picklist: + picklist (ARRAY SIMPLES de strings ["V1","V2"]. NUNCA picklistValues)
- MultiselectPicklist: + picklist, visibleLines
- Lookup: + referenceTo, relationshipLabel
- Checkbox/Date/DateTime/Email/Phone/Url/TextArea: sem params extras

### Validation Rules
{"objectName":"Obj","fullName":"Obj.RuleName","active":true,"errorConditionFormula":"...","errorMessage":"...","errorDisplayField":"Field__c"}

### Record Types
{"objectName":"Obj","fullName":"Obj.RTName","label":"Label","active":true,"description":"..."}

### Apex Classes
{"name":"ClassName","body":"public class ClassName { ... }"}
REGRA: Código Apex COMPLETO e funcional. Nunca stubs ou TODOs.

### Apex Triggers
{"name":"TriggerName","body":"trigger TriggerName on Obj__c (...) { ... }"}

### Flows (descritivo)
{"name":"FlowName","type":"RecordTriggered","object":"Obj__c","description":"...","triggerCondition":"...","actions":["..."]}

### Permission Sets
{"label":"PSName","description":"...","objectPermissions":[{"object":"Obj__c","allowCreate":true,"allowRead":true,"allowEdit":true,"allowDelete":false}]}

### Manual (ÚLTIMO RECURSO)
{"type":"OrgConfig","name":"...","description":"...","steps":"..."}

## Regras de divisão em fases
1. FASE 1: Custom Objects — SEMPRE primeiro
2. FASE 2: Custom Fields objetos custom
3. FASE 3: Custom Fields objetos standard
4. FASE 4: Validation Rules + Record Types
5. FASE 5: Apex Classes + Triggers
6. FASE 6: Flows + Permission Sets
7. FASE 7: Itens manuais
Máximo 15 componentes por fase.

## Regras de conversão
1. Custom = __c. Standard mantém API name nativo
2. Lead, Account, Contact, Opportunity, Case, Order, Quote, Contract, Campaign, Product2 são STANDARD — NÃO criar como customObject
3. Lookups em customFields com type Lookup
4. Picklist SEMPRE array simples ["V1","V2"]
5. Respeitar dependências: objetos antes de campos

## Formato de saída
Para cada fase gere:

=== FASE N: [descrição] ===

\`\`\`json
{json da fase}
\`\`\`

Gere APENAS o runbook. Sem explicações extras antes ou depois das fases.`;

// ── POST /convert (streaming SSE) ──
router.post('/convert', async (req, res) => {
  const { specText } = req.body;
  if (!specText || specText.trim().length < 50) {
    return res.status(400).json({ error: 'Especificação muito curta. Cole o conteúdo completo da spec.' });
  }

  const apiKey = getXaiKey();
  if (!apiKey) {
    return res.status(500).json({ error: 'XAI_KEY não configurada no servidor.' });
  }

  try {
    const apiRes = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4.3',
        max_tokens: 16384,
        temperature: 0.2,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Converta esta especificação técnica Salesforce em Runbook JSON executável:\n\n${specText}` },
        ],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('[spec-gen] xAI error:', apiRes.status, errBody.slice(0, 300));
      return res.status(502).json({ error: `Grok retornou ${apiRes.status}`, detail: errBody.slice(0, 200) });
    }

    // Stream SSE to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = apiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch { /* skip malformed */ }
      }
    }

    res.end();
  } catch (err) {
    console.error('[spec-gen] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// ── POST /convert-sync (non-streaming) ──
router.post('/convert-sync', async (req, res) => {
  const { specText } = req.body;
  if (!specText || specText.trim().length < 50) {
    return res.status(400).json({ error: 'Especificação muito curta.' });
  }

  const apiKey = getXaiKey();
  if (!apiKey) {
    return res.status(500).json({ error: 'XAI_KEY não configurada.' });
  }

  try {
    const apiRes = await fetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4.3',
        max_tokens: 16384,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Converta esta especificação técnica Salesforce em Runbook JSON executável:\n\n${specText}` },
        ],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      return res.status(502).json({ error: `Grok ${apiRes.status}`, detail: errBody.slice(0, 200) });
    }

    const data = await apiRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    res.json({ runbook: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
