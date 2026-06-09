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

ADICIONAR CAMPO AO LAYOUT: POST /api/devtools/add-to-layout
  Body: { objectName: "Lead", fieldName: "MeuCampo__c", behavior: "Edit" }
  Este endpoint automaticamente lê TODOS os layouts do objeto e adiciona o campo na seção principal de cada um.
  Use SEMPRE após criar um campo para garantir visibilidade na UI.
  behavior pode ser: "Edit" (editável), "Required" (obrigatório), "Readonly" (somente leitura)

EXECUTE ANONYMOUS: POST /api/execute-anonymous
  Body: { code:"apex code" }

REGRAS:
- FLS SEMPRE após criar campos (readable+editable=true para Admin)
- Após FLS, SEMPRE adicionar campo ao layout via add_to_layout
- Apex completo e compilável, com @description @author Everymind @date 2026
- Sempre gerar classe de teste @isTest
- deploy_apex: TODAS as classes e triggers relacionados no MESMO step
- Picklist: valueSet com valueSetDefinition (NUNCA picklistValues)

RESPONDA APENAS JSON, sem markdown, sem backticks:
{
  "plan_name": "Nome curto",
  "description": "O que será feito",
  "steps": [
    {
      "type": "create_field|deploy_apex|update_fls|add_to_layout|execute_anonymous",
      "label": "Descrição curta",
      "detail": "Detalhe técnico",
      "config": { ...payload do endpoint... }
    }
  ],
  "manual_steps": ["Apenas passos que NÃO podem ser automatizados"],
  "export_metadata": {
    "objects_affected": ["Lead"],
    "components": ["CustomField"],
    "summary": "Resumo para documentação"
  }
}`;

  // ─── Add field to ALL layouts of an object ───────────────────
  app.post('/api/devtools/add-to-layout', async (req, res) => {
    try {
      const { objectName, fieldName, behavior } = req.body;
      if (!objectName || !fieldName) return res.status(400).json({ error: 'objectName e fieldName obrigatórios' });

      const beh = behavior || 'Edit';
      const baseUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

      // 1. Get all layouts for this object
      const layoutsResp = await fetch(`${req.protocol}://${req.get('host')}/api/describe-layouts/${objectName}`);
      const layoutsData = await layoutsResp.json();
      const layouts = layoutsData.layouts || [];

      if (layouts.length === 0) return res.json({ success: false, error: 'Nenhum layout encontrado para ' + objectName });

      const results = [];

      for (const layout of layouts) {
        const fullName = decodeURIComponent(layout.fullName);

        // 2. Read current layout metadata
        const metaResp = await fetch(`${req.protocol}://${req.get('host')}/api/metadata-read/Layout/${encodeURIComponent(fullName)}`);
        const meta = await metaResp.json();

        if (!meta.layoutSections || meta.layoutSections.length === 0) {
          results.push({ layout: fullName, success: false, error: 'Sem seções' });
          continue;
        }

        // Check if field already exists in any section
        let alreadyExists = false;
        for (const sec of meta.layoutSections) {
          for (const col of (sec.layoutColumns || [])) {
            for (const item of (col.layoutItems || [])) {
              if (item.field === fieldName) { alreadyExists = true; break; }
            }
            if (alreadyExists) break;
          }
          if (alreadyExists) break;
        }

        if (alreadyExists) {
          results.push({ layout: fullName, success: true, skipped: true, message: 'Campo já existe no layout' });
          continue;
        }

        // 3. Add field to first section, first column
        const firstSection = meta.layoutSections[0];
        const columns = firstSection.layoutColumns || [];
        if (columns.length > 0) {
          const items = columns[0].layoutItems || [];
          // Add after the last required field or at position 4 (after Name/Company/Title)
          let insertIdx = Math.min(items.length, 4);
          items.splice(insertIdx, 0, { behavior: beh, field: fieldName });
          columns[0].layoutItems = items;
        }

        // 4. Update layout
        const updateResp = await fetch(`${req.protocol}://${req.get('host')}/api/metadata-update/Layout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fullName, layoutSections: meta.layoutSections })
        });
        const updateResult = await updateResp.json();

        results.push({
          layout: fullName,
          success: updateResult.success || false,
          error: updateResult.errors?.[0]?.message || null
        });
      }

      const allOk = results.every(r => r.success);
      const added = results.filter(r => r.success && !r.skipped).length;
      const skipped = results.filter(r => r.skipped).length;

      res.json({
        success: allOk,
        message: `${added} layout(s) atualizado(s), ${skipped} já tinham o campo`,
        details: results
      });

    } catch (err) {
      console.error('[DevTools] add-to-layout error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── AI Plan endpoint ────────────────────────────────────────
  app.post('/api/devtools/plan', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt obrigatório' });
      if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY não configurada' });

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

  console.log('[DevTools AI] registered (Claude Sonnet 4.6 + add-to-layout)');
}
