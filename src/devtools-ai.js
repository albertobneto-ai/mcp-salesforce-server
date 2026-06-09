import fetch from 'node-fetch';

export function registerDevToolsRoutes(app) {

  const OPENROUTER_KEY = process.env.OPENROUTER_KEY;

  const FREE_MODELS = [
    'qwen/qwen3-next-80b-a3b-instruct:free',
    'moonshotai/kimi-k2.6:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'poolside/laguna-m.1:free',
    'nex-agi/nex-n2-pro:free',
  ];

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
ATUALIZAR QUICK ACTION: POST /api/metadata-update/QuickAction
EXECUTE ANONYMOUS: POST /api/execute-anonymous Body: { code:"..." }

REGRAS:
- FLS SEMPRE deve ser atualizado após criar campos (readable+editable=true para Admin)
- Apex: código completo, compilável, com @description @author Everymind @date 2026
- Triggers: especificar objeto e eventos corretos
- Sempre gerar classe de teste com boa cobertura
- deploy_apex: classes E triggers no MESMO step
- Picklist: usar valueSet com valueSetDefinition

RESPONDA APENAS JSON válido, sem markdown, sem backticks, sem texto antes ou depois:
{
  "plan_name": "Nome curto",
  "description": "O que será feito",
  "steps": [
    {
      "type": "create_field|deploy_apex|update_fls|update_layout|update_quickaction|execute_anonymous",
      "label": "Descrição curta",
      "detail": "Detalhe técnico",
      "config": { ...payload do endpoint... }
    }
  ],
  "manual_steps": ["Passo manual se necessário"],
  "export_metadata": {
    "objects_affected": ["Lead"],
    "components": ["CustomField","ApexClass"],
    "summary": "Resumo para documentação"
  }
}`;

  async function callModel(model, prompt) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'HTTP-Referer': 'https://everi9.albertobottaro.info',
        'X-Title': 'Ever i9 DevTools AI'
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ]
      })
    });
    return response.json();
  }

  app.post('/api/devtools/plan', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt é obrigatório' });
      if (!OPENROUTER_KEY) return res.status(500).json({ error: 'OPENROUTER_KEY não configurada' });

      let lastError = null;

      for (const model of FREE_MODELS) {
        try {
          console.log('[DevTools AI] Tentando modelo:', model);
          const data = await callModel(model, prompt);

          if (data.error) {
            console.log('[DevTools AI] Erro em', model, ':', data.error.message || data.error.code);
            lastError = data.error.message || JSON.stringify(data.error);
            if (data.error.code === 429) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            continue;
          }

          const text = data.choices?.[0]?.message?.content || '';
          if (!text) { lastError = 'Resposta vazia de ' + model; continue; }

          // Limpar thinking tags e markdown
          let clean = text;
          clean = clean.replace(/<think>[\s\S]*?<\/think>/g, '');
          clean = clean.replace(/```json\s*/g, '').replace(/```\s*/g, '');
          clean = clean.trim();

          // Tentar extrair JSON se houver texto antes/depois
          const jsonMatch = clean.match(/\{[\s\S]*\}/);
          if (jsonMatch) clean = jsonMatch[0];

          try {
            const plan = JSON.parse(clean);
            console.log('[DevTools AI] Sucesso com modelo:', model);
            plan._model = model;
            return res.json(plan);
          } catch (parseErr) {
            lastError = 'JSON inválido de ' + model;
            continue;
          }
        } catch (fetchErr) {
          lastError = fetchErr.message;
          continue;
        }
      }

      res.status(500).json({ error: 'Todos os modelos falharam. Último erro: ' + lastError });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[DevTools AI] Route /api/devtools/plan registered (' + FREE_MODELS.length + ' models in pool)');
}
