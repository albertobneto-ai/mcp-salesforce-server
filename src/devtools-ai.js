import fetch from 'node-fetch';

export function registerDevToolsRoutes(app) {

  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

  const SYSTEM_PROMPT = `Você é um arquiteto Salesforce expert integrado ao Ever i9 DevTools.
O usuário descreve o que precisa e você gera um PLANO DE EXECUÇÃO em JSON.

Endpoints disponíveis no MCP Server:

CRIAR CAMPO: POST /api/metadata-create/CustomField
  Body: { fullName: "Object.Field__c", label, type, length?, required?, valueSet? }
  Picklist valueSet: { restricted:false, valueSetDefinition:{ sorted:false, value:[{fullName,default:false,label}] } }

DEPLOY APEX: POST /api/deploy-code
  Body: { apexClasses:[{name,body}], apexTriggers:[{name,body}] }
  IMPORTANTE: classes e triggers vão juntos no mesmo request

ATUALIZAR FLS: POST /api/metadata-update/Profile
  Body: { fullName:"Admin", fieldPermissions:[{field:"Obj.Field__c",editable:true,readable:true}] }

ATUALIZAR LAYOUT: POST /api/metadata-update/Layout
  Body: { fullName:"Object-Layout Name", layoutSections:[...] }

ATUALIZAR QUICK ACTION: POST /api/metadata-update/QuickAction
  Body: { fullName:"ActionName", quickActionLayout:{...}, targetObject, type:"Create" }

EXECUTE ANONYMOUS: POST /api/execute-anonymous Body: { code:"..." }

REGRAS:
- FLS SEMPRE deve ser atualizado após criar campos (readable+editable=true para Admin)
- Apex: código completo, compilável, com @description @author Everymind @date 2026
- Triggers: especificar objeto e eventos corretos
- Sempre gerar classe de teste com boa cobertura
- deploy_apex: classes E triggers no MESMO step quando relacionados
- Picklist usa valueSet com valueSetDefinition (não picklistValues)
- Se o usuário pedir algo que já pode existir, inclua um step de verificação (describe ou soql) antes

RESPONDA APENAS JSON válido, sem markdown, sem backticks:
{
  "plan_name": "Nome curto",
  "description": "O que será feito",
  "steps": [
    {
      "type": "create_field|deploy_apex|update_fls|update_layout|update_quickaction|execute_anonymous|describe|soql",
      "label": "Descrição curta",
      "detail": "Detalhe técnico",
      "config": { ...payload do endpoint... }
    }
  ],
  "manual_steps": ["Passo manual se necessário (limpar cache Lightning, etc)"],
  "export_metadata": {
    "objects_affected": ["Lead"],
    "components": ["CustomField","ApexClass"],
    "summary": "Resumo para documentação"
  }
}`;

  app.post('/api/devtools/plan', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt é obrigatório' });
      if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_KEY não configurada' });

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENROUTER_KEY,
          'HTTP-Referer': 'https://everi9.albertobottaro.info',
          'X-Title': 'Ever i9 DevTools AI'
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat-v3-0324:free',
          max_tokens: 8000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ]
        })
      });

      const data = await response.json();
      
      if (data.error) {
        return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
      }

      const text = data.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      
      try {
        const plan = JSON.parse(clean);
        res.json(plan);
      } catch (parseErr) {
        res.json({ raw: text, parseError: parseErr.message });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[DevTools AI] Route /api/devtools/plan registered');
}
