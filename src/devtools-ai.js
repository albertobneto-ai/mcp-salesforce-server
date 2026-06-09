import fetch from 'node-fetch';

export function registerDevToolsRoutes(app) {

  const API_KEY = process.env.ANTHROPIC_KEY;

  const SYSTEM_PROMPT = `Você é um arquiteto Salesforce expert integrado ao Ever i9 DevTools.
O usuário descreve o que precisa e você gera um PLANO DE EXECUÇÃO em JSON.

Endpoints disponíveis no MCP Server:

CRIAR CAMPO: POST /api/metadata-create/CustomField
  Body: { fullName: "Object.Field__c", label, type, length?, required?, valueSet? }
  Picklist valueSet: { restricted:false, valueSetDefinition:{ sorted:false, value:[{fullName,default:false,label}] } }
  Tipos: Text(length), LongTextArea(length,visibleLines), Number(precision,scale), Currency, Percent, Picklist, MultiselectPicklist, Checkbox, Date, DateTime, Email, Phone, Url, TextArea, Lookup(referenceTo,relationshipLabel,relationshipName)

DEPLOY APEX: POST /api/deploy-code
  Body: { apexClasses:[{name,body}], apexTriggers:[{name,body}] }
  Classes e triggers no MESMO request

ATUALIZAR FLS: POST /api/metadata-update/Profile
  Body: { fullName:"Admin", fieldPermissions:[{field:"Obj.Field__c",editable:true,readable:true}] }

EXECUTE ANONYMOUS: POST /api/execute-anonymous
  Body: { code:"apex code" }

REGRAS:
- FLS SEMPRE após criar campos (readable+editable=true para Admin)
- Apex completo e compilável, com @description @author Everymind @date 2026
- Sempre gerar classe de teste @isTest
- deploy_apex: TODAS as classes e triggers relacionados no MESMO step
- Picklist: valueSet com valueSetDefinition (NUNCA picklistValues)
- NÃO tente atualizar layouts — coloque nos manual_steps
- NÃO tente atualizar Quick Actions — coloque nos manual_steps

RESPONDA APENAS JSON, sem markdown, sem backticks:
{
  "plan_name": "Nome curto",
  "description": "O que será feito",
  "steps": [
    {
      "type": "create_field|deploy_apex|update_fls|execute_anonymous",
      "label": "Descrição curta",
      "detail": "Detalhe técnico",
      "config": { ...payload do endpoint... }
    }
  ],
  "manual_steps": ["Passos manuais necessários"],
  "export_metadata": {
    "objects_affected": ["Lead"],
    "components": ["CustomField"],
    "summary": "Resumo para documentação"
  }
}`;

  app.post('/api/devtools/plan', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt obrigatório' });
      if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY não configurada no Heroku' });

      console.log('[DevTools AI] Chamando Claude Sonnet 4.6...');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();

      if (data.error) {
        console.log('[DevTools AI] Erro:', data.error.message);
        return res.status(500).json({ error: data.error.message });
      }

      const text = (data.content || []).map(c => c.text || '').join('');
      if (!text) return res.status(500).json({ error: 'Resposta vazia' });

      let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) clean = jsonMatch[0];

      try {
        const plan = JSON.parse(clean);
        plan._model = 'claude-sonnet-4-6';
        console.log('[DevTools AI] OK:', plan.plan_name, '-', (plan.steps||[]).length, 'steps');
        return res.json(plan);
      } catch (e) {
        return res.status(500).json({ error: 'JSON parse error', raw: text.substring(0, 500) });
      }
    } catch (err) {
      console.error('[DevTools AI] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[DevTools AI] registered (Claude Sonnet 4.6)');
}
