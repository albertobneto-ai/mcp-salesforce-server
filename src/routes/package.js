// src/routes/package.js — Gera ZIP com metadados SFDX + guia de implementação
import express from 'express';
import JSZip from 'jszip';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── Gerar XML de campo SFDX ──
function fieldToXml(field) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  xml += '    <fullName>' + field.fieldName + '</fullName>\n';
  xml += '    <label>' + field.label + '</label>\n';
  xml += '    <type>' + field.type + '</type>\n';
  if (field.length) xml += '    <length>' + field.length + '</length>\n';
  if (field.precision) xml += '    <precision>' + field.precision + '</precision>\n';
  if (field.scale) xml += '    <scale>' + field.scale + '</scale>\n';
  if (field.visibleLines) xml += '    <visibleLines>' + field.visibleLines + '</visibleLines>\n';
  if (field.required) xml += '    <required>true</required>\n';
  if (field.referenceTo) {
    xml += '    <referenceTo>' + field.referenceTo + '</referenceTo>\n';
    xml += '    <relationshipLabel>' + (field.relationshipLabel || field.referenceTo) + '</relationshipLabel>\n';
    xml += '    <relationshipName>' + (field.relationshipLabel || field.referenceTo).replace(/\s/g,'') + '</relationshipName>\n';
  }
  if (field.picklist) {
    xml += '    <valueSet>\n';
    xml += '        <valueSetDefinition>\n';
    for (const v of field.picklist) {
      xml += '            <value>\n';
      xml += '                <fullName>' + v + '</fullName>\n';
      xml += '                <label>' + v + '</label>\n';
      xml += '                <default>false</default>\n';
      xml += '            </value>\n';
    }
    xml += '        </valueSetDefinition>\n';
    xml += '    </valueSet>\n';
  }
  if (field.description) xml += '    <description>' + field.description + '</description>\n';
  xml += '</CustomField>';
  return xml;
}

// ── Gerar XML de Permission Set ──
function permSetToXml(ps) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  xml += '    <label>' + (ps.label || ps.name) + '</label>\n';
  xml += '    <hasActivationRequired>false</hasActivationRequired>\n';
  if (ps.fieldPermissions) {
    for (const fp of ps.fieldPermissions) {
      xml += '    <fieldPermissions>\n';
      xml += '        <field>' + fp.field + '</field>\n';
      xml += '        <editable>' + (fp.editable !== false) + '</editable>\n';
      xml += '        <readable>true</readable>\n';
      xml += '    </fieldPermissions>\n';
    }
  }
  xml += '</PermissionSet>';
  return xml;
}

// ── Gerar XML de Validation Rule ──
function validationToXml(vr) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  xml += '    <fullName>' + vr.fullName + '</fullName>\n';
  xml += '    <active>' + (vr.active !== false) + '</active>\n';
  xml += '    <errorConditionFormula>' + (vr.errorConditionFormula || '') + '</errorConditionFormula>\n';
  xml += '    <errorMessage>' + (vr.errorMessage || '') + '</errorMessage>\n';
  if (vr.errorDisplayField) xml += '    <errorDisplayField>' + vr.errorDisplayField + '</errorDisplayField>\n';
  xml += '</ValidationRule>';
  return xml;
}

// ── Gerar package.xml ──
function generatePackageXml(manifest) {
  const types = [];
  
  if (manifest.metadata?.customFields?.length) {
    const members = manifest.metadata.customFields.map(f => f.objectName + '.' + f.fieldName);
    types.push({ name: 'CustomField', members });
  }
  if (manifest.metadata?.permissionSets?.length) {
    const members = manifest.metadata.permissionSets.map(ps => ps.name || ps.label);
    types.push({ name: 'PermissionSet', members });
  }
  if (manifest.metadata?.validationRules?.length) {
    const members = manifest.metadata.validationRules.map(vr => vr.fullName);
    types.push({ name: 'ValidationRule', members });
  }
  if (manifest.metadata?.recordTypes?.length) {
    const members = manifest.metadata.recordTypes.map(rt => rt.fullName);
    types.push({ name: 'RecordType', members });
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  for (const t of types) {
    xml += '    <types>\n';
    for (const m of t.members) {
      xml += '        <members>' + m + '</members>\n';
    }
    xml += '        <name>' + t.name + '</name>\n';
    xml += '    </types>\n';
  }
  xml += '    <version>62.0</version>\n';
  xml += '</Package>';
  return xml;
}

// ── Gerar guia de implementação ──
function generateGuide(manifest, specContent) {
  const lines = [];
  lines.push('# Guia Rápido de Implementação');
  lines.push('');
  lines.push('**Spec:** ' + (manifest.specName || 'N/A'));
  lines.push('**Data:** ' + new Date().toLocaleDateString('pt-BR'));
  lines.push('**Gerado por:** Ever i9 — Spec AI Platform');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Pré-requisitos
  lines.push('## 1. Pré-requisitos');
  lines.push('');
  lines.push('- Acesso de System Administrator na org de destino');
  lines.push('- Salesforce CLI (sf/sfdx) instalado (opcional, para deploy via CLI)');
  lines.push('- Backup do ambiente antes do deploy');
  lines.push('');

  // O que será criado
  lines.push('## 2. Componentes');
  lines.push('');
  if (manifest.metadata?.customFields?.length) {
    lines.push('### Campos Customizados');
    lines.push('| Objeto | Campo | API Name | Tipo |');
    lines.push('|--------|-------|----------|------|');
    for (const f of manifest.metadata.customFields) {
      lines.push('| ' + f.objectName + ' | ' + f.label + ' | ' + f.fieldName + ' | ' + f.type + ' |');
    }
    lines.push('');
  }
  if (manifest.metadata?.permissionSets?.length) {
    lines.push('### Permission Sets');
    for (const ps of manifest.metadata.permissionSets) {
      lines.push('- **' + (ps.label || ps.name) + '**');
    }
    lines.push('');
  }
  if (manifest.metadata?.validationRules?.length) {
    lines.push('### Validation Rules');
    for (const vr of manifest.metadata.validationRules) {
      lines.push('- **' + vr.fullName + '**');
    }
    lines.push('');
  }

  // Deploy manual
  lines.push('## 3. Deploy Manual (Setup)');
  lines.push('');
  if (manifest.metadata?.customFields?.length) {
    for (const f of manifest.metadata.customFields) {
      lines.push('### Campo: ' + f.label);
      lines.push('1. Setup → Object Manager → ' + f.objectName + ' → Fields & Relationships → New');
      lines.push('2. Tipo: ' + f.type);
      if (f.length) lines.push('3. Length: ' + f.length);
      if (f.picklist) lines.push('3. Valores: ' + f.picklist.join(', '));
      lines.push('4. Label: ' + f.label);
      lines.push('5. API Name: ' + f.fieldName);
      lines.push('');
    }
  }

  // Deploy via CLI
  lines.push('## 4. Deploy via Salesforce CLI');
  lines.push('');
  lines.push('```bash');
  lines.push('# Autenticar na org');
  lines.push('sf org login web --alias minha-org');
  lines.push('');
  lines.push('# Deploy dos metadados');
  lines.push('sf project deploy start --source-dir force-app --target-org minha-org');
  lines.push('```');
  lines.push('');

  // Deploy via Ever i9
  lines.push('## 5. Deploy via Ever i9 (MCP Server)');
  lines.push('');
  lines.push('```bash');
  lines.push('# O manifest.json pode ser deployado diretamente:');
  lines.push('# 1. Abra www.everi9.com');
  lines.push('# 2. Use o comando /deploy com o requisito');
  lines.push('# 3. Ou use a API diretamente:');
  lines.push('curl https://www.everi9.com/api/deploy-b64/$(cat manifest.json | base64 -w 0)');
  lines.push('```');
  lines.push('');

  // Validação
  lines.push('## 6. Validação Pós-Deploy');
  lines.push('');
  if (manifest.metadata?.customFields?.length) {
    for (const f of manifest.metadata.customFields) {
      lines.push('- [ ] Campo **' + f.label + '** visível em Object Manager → ' + f.objectName);
    }
  }
  if (manifest.metadata?.permissionSets?.length) {
    for (const ps of manifest.metadata.permissionSets) {
      lines.push('- [ ] Permission Set **' + (ps.label || ps.name) + '** criado e atribuído');
    }
  }
  lines.push('- [ ] Testes funcionais realizados');
  lines.push('- [ ] Dados de produção não afetados');
  lines.push('');

  // Rollback
  lines.push('## 7. Rollback');
  lines.push('');
  lines.push('Caso necessário reverter, execute na ordem inversa:');
  lines.push('');
  if (manifest.metadata?.permissionSets?.length) {
    lines.push('1. Remover Permission Sets');
  }
  if (manifest.metadata?.customFields?.length) {
    for (const f of manifest.metadata.customFields) {
      lines.push((manifest.metadata?.permissionSets?.length ? '2' : '1') + '. Object Manager → ' + f.objectName + ' → ' + f.fieldName + ' → Delete');
    }
  }

  return lines.join('\n');
}

// POST /api/package — Gera ZIP com metadados + guia
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { manifest, specContent } = req.body;
    if (!manifest) return res.status(400).json({ error: 'manifest obrigatório' });

    const zip = new JSZip();
    const specName = manifest.specName || 'Package';

    // 1. manifest.json
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    // 2. Guia de implementação
    zip.file('GUIA_IMPLEMENTACAO.md', generateGuide(manifest, specContent));

    // 3. package.xml
    zip.file('force-app/package.xml', generatePackageXml(manifest));

    // 4. Metadados SFDX — Campos
    if (manifest.metadata?.customFields?.length) {
      for (const field of manifest.metadata.customFields) {
        const obj = field.objectName;
        const name = field.fieldName.replace('__c', '');
        const path = 'force-app/main/default/objects/' + obj + '/fields/' + field.fieldName + '.field-meta.xml';
        zip.file(path, fieldToXml(field));
      }
    }

    // 5. Permission Sets
    if (manifest.metadata?.permissionSets?.length) {
      for (const ps of manifest.metadata.permissionSets) {
        const name = (ps.name || ps.label || 'PermSet').replace(/\s/g, '_');
        zip.file('force-app/main/default/permissionsets/' + name + '.permissionset-meta.xml', permSetToXml(ps));
      }
    }

    // 6. Validation Rules
    if (manifest.metadata?.validationRules?.length) {
      for (const vr of manifest.metadata.validationRules) {
        const parts = vr.fullName.split('.');
        const obj = parts[0];
        const name = parts[1] || vr.fullName;
        zip.file('force-app/main/default/objects/' + obj + '/validationRules/' + name + '.validationRule-meta.xml', validationToXml(vr));
      }
    }

    // 7. Spec completa (se fornecida)
    if (specContent) {
      zip.file('SPEC_TECNICA.md', specContent);
    }

    // Gerar ZIP
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + specName + '.zip"');
    res.send(buffer);
  } catch (err) {
    console.error('Package error:', err);
    res.status(500).json({ error: 'Erro ao gerar pacote: ' + err.message });
  }
});

export default router;
