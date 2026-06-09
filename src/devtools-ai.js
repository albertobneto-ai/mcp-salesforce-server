import fetch from 'node-fetch';

export function registerDevToolsRoutes(app) {

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

  const SYSTEM_PROMPT = `Você é um arquiteto Salesforce expert integrado ao Ever i9 DevTools.
O usuário descreve o que precisa e você gera um PLANO DE EXECUÇÃO em JSON.

Endpoints disponíveis no MCP Server:

CRIAR CAMPO: POST /api/metadata-create/CustomField
  Body: { fullName: "Object.Field__c", label, type, length?, required?, valueSet? }
  Picklist valueSet: { restricted:false, valueSetDefinition:{ sorted:false, value:[{fullName,default:false,label}] } }
  Tipos válidos: Text, LongTextArea, RichTextArea, Number, Currency, Percent, Picklist, MultiselectPicklist, Checkbox, Date, DateTime, Email, Phone, Url, TextArea, Lookup
  Text requer: length (1-255)
  Number/Currency/Percent requer: precision, scale
  Lookup requer: referenceTo, relationshipLabel, relationshipName

DEPLOY APEX: POST /api/deploy-code
  Body: { apexClasses:[{name,body}], apexTriggers:[{name,body}] }
  IMPORTANTE: classes e triggers vão juntos no mesmo request para garantir compilação

ATUALIZAR FLS: POST /api/metadata-update/Profile
  Body: { fullName:"Admin", fieldPermissions:[{field:"Obj.Field__c",editable:true,readable:true}] }

EXECUTE ANONYMOUS: POST /api/execute-anonymous
  Body: { code:"apex code here" }

REGRAS CRÍTICAS:
- FLS SEMPRE deve ser atualizado após criar campos (readable+editable=true para Admin)
- Apex: código COMPLETO e compilável, com /** @description ... @author Everymind @date 2026 */
- Triggers: especificar objeto e eventos corretos (before insert, before update, etc)
- Sempre gerar classe de teste @isTest com cobertura de cenários positivos E negativos
- deploy_apex: colocar TODAS as classes E triggers relacionados no MESMO step
- Picklist: usar valueSet com valueSetDefinition (NUNCA picklistValues)
- NÃO tente atualizar layouts automaticamente — sempre coloque isso nos manual_steps
- NÃO tente atualizar Quick Actions automaticamente — sempre coloque nos manual_steps
- Para validações complexas (CPF, CNPJ, email), crie classe utilitária separada + trigger + test class

RESPONDA APENAS JSON válido, sem markdown, sem backticks, sem texto antes ou depois do JSON:
{
  "plan_name": "Nome curto descritivo",
  "description": "Descrição clara do que será feito",
  "steps": [
    {
      "type": "create_field|deploy_apex|update_fls|execute_anonymous",
      "label": "Descrição curta do passo",
      "detail": "Detalhe técnico (API name, objeto, etc)",
      "config": { ...payload exato do endpoint... }
    }
  ],
  "manual_steps": [
    "Adicionar campo X ao Page Layout do objeto Y via Setup > Object Manager > Y > Page Layouts",
    "Limpar cache do Lightning: Ctrl+Shift+R ou abrir em aba anônima"
  ],
  "export_metadata": {
    "objects_affected": ["Lead"],
    "components": ["CustomField", "ApexClass", "ApexTrigger"],
    "summary": "Resumo completo para documentação do que foi criado/alterado"
  }
}`;

  app.post('/api/devtools/plan', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt é obrigatório' });
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no Heroku' });

      console.log('[DevTools AI] Chamando Claude Sonnet...');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();

      if (data.error) {
        console.log('[DevTools AI] Erro API:', data.error.message);
        return res.status(500).json({ error: data.error.message });
      }

      const text = (data.content || []).map(c => c.text || '').join('');
      if (!text) return res.status(500).json({ error: 'Resposta vazia do Claude' });

      // Limpar e extrair JSON
      let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) clean = jsonMatch[0];

      try {
        const plan = JSON.parse(clean);
        plan._model = 'claude-sonnet-4';
        console.log('[DevTools AI] Plano gerado:', plan.plan_name, '—', plan.steps?.length, 'steps');
        return res.json(plan);
      } catch (parseErr) {
        return res.status(500).json({ error: 'JSON inválido na resposta', raw: text.substring(0, 500) });
      }
    } catch (err) {
      console.error('[DevTools AI] Erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[DevTools AI] Route /api/devtools/plan registered (Claude Sonnet 4)');
}
