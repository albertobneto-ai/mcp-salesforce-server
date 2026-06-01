// src/routes/inventory.js — Inventário automático de org + upload KB
// 100% read-only na org. Apenas descreve, consulta e documenta.
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { describeObject, runSoql, runToolingQuery } from '../services/sf-multi.js';
import * as kbdb from '../services/kb-db.js';
import pool from '../config/db.js';

const router = express.Router();

// Helper: busca org por ID no Postgres
async function getOrg(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Helper: tooling query segura
async function toolingSafe(org, query) {
  try { return (await runToolingQuery(org, query)).records || []; }
  catch { return []; }
}

// Helper: SOQL segura
async function soqlSafe(org, query) {
  try { return (await runSoql(org, query)).records || []; }
  catch { return []; }
}

// ══════════════════════════════════════════════════
// POST /api/inventory/run — Executa inventário completo
// ══════════════════════════════════════════════════
router.post('/run', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'architect') {
    return res.status(403).json({ erro: 'Apenas admin/architect' });
  }

  const orgId = req.body.org_id || 1;
  const org = await getOrg(orgId);
  if (!org) return res.status(404).json({ erro: 'Org não encontrada' });

  // Keep-alive
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write(' ');
  const ka = setInterval(() => { try { res.write(' '); } catch {} }, 12000);

  try {
    const started = Date.now();
    const lines = [];
    const p = (s = '') => lines.push(s);
    const stats = {};

    p(`# INVENTÁRIO DE CUSTOMIZAÇÕES — ${org.name}`);
    p(`**Org:** ${org.login_url.replace('https://','')}`);
    p(`**Username:** ${org.username}`);
    p(`**Data:** ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`);
    p(`**Tipo:** Read-only — nenhuma alteração foi feita na org`);
    p('');
    p('---');

    // ── 1. Custom Objects ──
    p('\n## 1. CUSTOM OBJECTS (sem pacote gerenciado)\n');
    const entities = await soqlSafe(org,
      "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = true AND QualifiedApiName LIKE '%__c' AND Publisher.Name = null ORDER BY QualifiedApiName"
    );
    const customObjs = entities.filter(e => !e.QualifiedApiName.startsWith('maps__') && !e.QualifiedApiName.startsWith('vlocity_cmt__'));
    p('| API Name | Label |');
    p('|----------|-------|');
    for (const e of customObjs) p(`| ${e.QualifiedApiName} | ${e.Label || ''} |`);
    if (!customObjs.length) p('| (nenhum) | — |');
    stats.custom_objects = customObjs.length;

    // ── 2. Custom Fields ──
    const stdObjects = ['Lead', 'Account', 'Contact', 'Opportunity', 'Case', 'Campaign', 'Order', 'Quote', 'Contract', 'Task', 'Event'];
    let totalCustomFields = 0;

    for (const obj of stdObjects) {
      try {
        const desc = await describeObject(org, obj);
        const customs = desc.fields.filter(f =>
          f.custom && !f.name.startsWith('maps__') && !f.name.startsWith('vlocity_cmt__')
        );
        if (customs.length) {
          p(`\n## 2. CAMPOS CUSTOM — ${obj} (${customs.length})\n`);
          p('| Campo | Tipo | Label |');
          p('|-------|------|-------|');
          for (const f of customs) p(`| ${f.name} | ${f.type} | ${f.label || ''} |`);
          totalCustomFields += customs.length;
        }
      } catch {}
    }
    stats.custom_fields = totalCustomFields;

    // ── 3. Apex Classes ──
    p('\n## 3. APEX CLASSES (sem pacote)\n');
    const apexClasses = await toolingSafe(org,
      "SELECT Name, Status, LengthWithoutComments, ApiVersion, Body FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name"
    );
    p('| Classe | API | Tamanho | Função |');
    p('|--------|-----|---------|--------|');
    for (const c of apexClasses) {
      const body = (c.Body || '').slice(0, 200);
      let func = '—';
      if (body.includes('@InvocableMethod')) func = 'Invocable Action';
      else if (body.includes('implements Queueable')) func = 'Queueable (async)';
      else if (body.includes('implements Database.Batchable')) func = 'Batch Apex';
      else if (body.includes('implements Finalizer')) func = 'Finalizer';
      else if (body.includes('@AuraEnabled')) func = 'Aura/LWC Controller';
      else if (body.includes('@IsTest')) func = 'Test Class';
      else if (body.includes('Helper')) func = 'Helper/Utility';
      else if (body.includes('Controller')) func = 'Controller';
      else if (body.includes('Service')) func = 'Service';
      else if (body.includes('Adapter')) func = 'Adapter/Integration';
      p(`| ${c.Name} | v${c.ApiVersion || ''} | ${c.LengthWithoutComments || 0} chars | ${func} |`);
    }
    stats.apex_classes = apexClasses.length;

    // ── 4. Apex Triggers ──
    p('\n## 4. APEX TRIGGERS\n');
    const triggers = await toolingSafe(org,
      "SELECT Name, TableEnumOrId, Status, ApiVersion FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name"
    );
    p('| Trigger | Objeto | API |');
    p('|---------|--------|-----|');
    for (const t of triggers) p(`| ${t.Name} | ${t.TableEnumOrId || ''} | v${t.ApiVersion || ''} |`);
    if (!triggers.length) p('| (nenhum) | — | — |');
    stats.triggers = triggers.length;

    // ── 5. Flows ──
    p('\n## 5. FLOWS CUSTOM\n');
    const flows = await toolingSafe(org,
      "SELECT DeveloperName, ActiveVersionId, Description FROM FlowDefinition WHERE NamespacePrefix = null ORDER BY DeveloperName"
    );
    p('| Flow | Status | Descrição |');
    p('|------|--------|-----------|');
    for (const f of flows) {
      const status = f.ActiveVersionId ? 'ATIVO' : 'INATIVO';
      p(`| ${f.DeveloperName} | ${status} | ${(f.Description || '—').slice(0, 80)} |`);
    }
    stats.flows = flows.length;
    stats.flows_active = flows.filter(f => f.ActiveVersionId).length;

    // ── 6. Record Types ──
    p('\n## 6. RECORD TYPES\n');
    const rts = await soqlSafe(org,
      "SELECT SobjectType, DeveloperName, Name, IsActive FROM RecordType WHERE IsActive = true ORDER BY SobjectType, DeveloperName"
    );
    const rtsFiltered = rts.filter(r => !r.SobjectType.startsWith('vlocity_cmt__') && !r.SobjectType.startsWith('maps__'));
    p('| Objeto | Developer Name | Label |');
    p('|--------|---------------|-------|');
    for (const r of rtsFiltered) p(`| ${r.SobjectType} | ${r.DeveloperName} | ${r.Name || ''} |`);
    stats.record_types = rtsFiltered.length;

    // ── 7. Permission Sets ──
    p('\n## 7. PERMISSION SETS CUSTOM\n');
    const ps = await soqlSafe(org,
      "SELECT Name, Label FROM PermissionSet WHERE IsCustom = true AND NamespacePrefix = null ORDER BY Name"
    );
    const psClean = ps.filter(p => !p.Name.startsWith('X00e'));
    p('| Name | Label |');
    p('|------|-------|');
    for (const s of psClean) p(`| ${s.Name} | ${s.Label || ''} |`);
    stats.permission_sets = psClean.length;

    // ── 8. Page Layouts ──
    p('\n## 8. PAGE LAYOUTS CUSTOMIZADOS\n');
    const layoutObjects = ['Lead', 'Account', 'Opportunity', 'Case', 'Contact', 'Campaign'];
    let totalLayouts = 0;

    for (const obj of layoutObjects) {
      // Get layout names
      const layoutNames = await toolingSafe(org,
        `SELECT Name FROM Layout WHERE EntityDefinitionId = '${obj}' AND NamespacePrefix = null`
      );
      if (!layoutNames.length) continue;

      for (const ln of layoutNames) {
        try {
          const lr = await toolingSafe(org,
            `SELECT Name, Metadata FROM Layout WHERE Name = '${ln.Name.replace(/'/g, "\\'")}' AND EntityDefinitionId = '${obj}'`
          );
          if (!lr.length || !lr[0].Metadata) continue;
          const meta = lr[0].Metadata;
          const sections = meta.layoutSections || [];
          let hasCustom = false;

          for (const s of sections) {
            const cols = s.layoutColumns || [];
            const fields = [];
            for (const col of (Array.isArray(cols) ? cols : [cols])) {
              if (!col) continue;
              let items = col.layoutItems || [];
              if (!Array.isArray(items)) items = [items];
              for (const item of items) {
                if (item.field) fields.push(item.field);
              }
            }
            const custom = fields.filter(f => f.endsWith('__c'));
            if (custom.length) {
              if (!hasCustom) {
                p(`\n### ${obj} — ${ln.Name}\n`);
                hasCustom = true;
                totalLayouts++;
              }
              p(`**[${s.label || '(sem label)'}]** (${custom.length} custom)`);
              p(custom.map(f => `- ${f}`).join('\n'));
              p('');
            }
          }
        } catch {}
      }
    }
    stats.layouts_with_custom = totalLayouts;

    // ── 9. Picklist Values ──
    p('\n## 9. VALORES DE PICKLIST EM USO\n');
    const picklistFields = [
      ['Lead', 'LeadSource'],
      ['Lead', 'OrigemCanal__c'],
      ['Lead', 'OrigemMidia__c'],
      ['Lead', 'Segmento__c'],
      ['Lead', 'TipoLead__c'],
      ['Lead', 'Status'],
      ['Account', 'Segmento__c'],
      ['Account', 'TipoCliente__c'],
      ['Account', 'Tier__c'],
    ];
    for (const [obj, field] of picklistFields) {
      try {
        const vals = await soqlSafe(org,
          `SELECT ${field}, COUNT(Id) cnt FROM ${obj} GROUP BY ${field} ORDER BY ${field}`
        );
        if (vals.length) {
          p(`**${obj}.${field}:** ${vals.map(v => `${v[field] || '(vazio)'} (${v.cnt})`).join(', ')}`);
        }
      } catch {}
    }

    // ── 10. Custom Labels ──
    p('\n## 10. CUSTOM LABELS\n');
    const labels = await toolingSafe(org,
      "SELECT Name, Value, Language FROM CustomLabel WHERE NamespacePrefix = null ORDER BY Name"
    );
    if (labels.length) {
      p('| Name | Value |');
      p('|------|-------|');
      for (const l of labels) p(`| ${l.Name} | ${(l.Value || '').slice(0, 60)} |`);
    } else {
      p('(nenhum)');
    }
    stats.custom_labels = labels.length;

    // ── Footer ──
    const elapsed = Math.round((Date.now() - started) / 1000);
    p('\n---');
    p(`*Inventário gerado automaticamente pelo Ever i9 em ${elapsed}s — 100% read-only.*`);

    const fullDoc = lines.join('\n');

    // ── Upload to KB (remove old inventory docs first) ──
    const existingDocs = await kbdb.listDocuments();
    for (const doc of existingDocs) {
      if (doc.source_type === 'inventory') {
        await kbdb.deleteDocument(doc.id);
      }
    }

    const result = await kbdb.addDocument(
      `Inventário Customizações — ${org.name} (${new Date().toLocaleDateString('pt-BR')})`,
      fullDoc,
      'inventory',
      'all'
    );

    clearInterval(ka);
    res.end(JSON.stringify({
      success: true,
      org: org.name,
      elapsed_seconds: elapsed,
      stats,
      kb: { document_id: result.id, chunks: result.chunks },
      document_size: fullDoc.length,
    }));

  } catch (err) {
    clearInterval(ka);
    res.end(JSON.stringify({ success: false, erro: err.message }));
  }
});

// ══════════════════════════════════════════════════
// GET /api/inventory/status — Último inventário
// ══════════════════════════════════════════════════
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const docs = await kbdb.listDocuments();
    const inventoryDocs = docs.filter(d => d.source_type === 'inventory');
    res.json({
      inventory_documents: inventoryDocs.length,
      documents: inventoryDocs.map(d => ({
        id: d.id, title: d.title, chunks: d.chunk_count,
        created_at: d.created_at
      })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

export default router;
