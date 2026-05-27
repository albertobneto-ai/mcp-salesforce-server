// src/services/sf-multi.js — Conexão multi-org Salesforce via jsforce
import jsforce from 'jsforce';

// Cache de conexões ativas (evita re-login a cada request)
const connections = {};

export async function connectToOrg(org) {
  const key = org.id || org.username;
  
  // Usar cache se conexão ainda válida
  if (connections[key]) {
    try {
      await connections[key].identity();
      return connections[key];
    } catch {
      delete connections[key];
    }
  }

  const conn = new jsforce.Connection({
    loginUrl: org.login_url,
    version: '62.0',
  });

  await conn.login(org.username, org.password + (org.security_token || ''));
  connections[key] = conn;
  return conn;
}

// Describe objeto em qualquer org
export async function describeObject(org, objectName) {
  const conn = await connectToOrg(org);
  const meta = await conn.describe(objectName);
  return {
    name: meta.name,
    label: meta.label,
    fields: meta.fields.map(f => ({
      name: f.name, label: f.label, type: f.type,
      length: f.length, custom: f.custom,
      referenceTo: f.referenceTo,
    })),
    recordTypeInfos: meta.recordTypeInfos,
  };
}

// Executar SOQL em qualquer org
export async function runSoql(org, query) {
  const conn = await connectToOrg(org);
  return await conn.query(query);
}

// Criar metadado em qualquer org
export async function metadataCreate(org, type, metadata) {
  const conn = await connectToOrg(org);
  return await conn.metadata.create(type, metadata);
}

// Ler metadado em qualquer org
export async function metadataRead(org, type, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.read(type, fullName);
}

// Testar conexão com qualquer org
export async function testConnection(org) {
  try {
    const conn = await connectToOrg(org);
    const identity = await conn.identity();
    return {
      status: 'connected',
      orgId: identity.organization_id,
      username: identity.username,
      displayName: identity.display_name,
      instanceUrl: conn.instanceUrl,
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// Deploy campo via metadata.create
export async function deployField(org, field) {
  const conn = await connectToOrg(org);
  const fullName = field.objectName + '.' + field.fieldName;
  const body = { fullName, label: field.label, type: field.type };
  if (field.length) body.length = field.length;
  if (field.precision) body.precision = field.precision;
  if (field.scale) body.scale = field.scale;
  if (field.visibleLines) body.visibleLines = field.visibleLines;
  if (field.referenceTo) body.referenceTo = field.referenceTo;
  if (field.relationshipLabel) body.relationshipLabel = field.relationshipLabel;
  if (field.picklist) {
    body.valueSet = {
      valueSetDefinition: {
        value: field.picklist.map(v => ({ fullName: v, label: v, default: false }))
      }
    };
  }
  const result = await conn.metadata.create('CustomField', body);
  return { component: 'Field: ' + fullName, ...result };
}

// Delete campo (para limpeza de testes)
export async function deleteField(org, fullName) {
  const conn = await connectToOrg(org);
  return await conn.metadata.delete('CustomField', fullName);
}
