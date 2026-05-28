#!/usr/bin/env node
// tests/smoke.js — Smoke test pós-deploy do Ever i9
// Uso: BASE_URL=https://... ADMIN_PASS=... node tests/smoke.js

const BASE = process.env.BASE_URL || 'https://everi9.albertobottaro.info';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@everi9.com';
const PASS = process.env.ADMIN_PASS || 'admin2026';

let token = '';
let passed = 0, failed = 0;
const results = [];

function log(name, ok, detail = '') {
  const icon = ok ? '\u2705' : '\u274c';
  console.log(`${icon} ${name}${detail ? ' \u2014 ' + detail : ''}`);
  results.push({ name, ok, detail });
  if (ok) passed++; else failed++;
}

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { ...opts, headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function chat(content, history = []) {
  const messages = [...history, { role: 'user', content }];
  const r = await req('/api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
  return r.json?.choices?.[0]?.message?.content || r.json?.erro || '';
}

async function run() {
  console.log('\n=== SMOKE TEST: ' + BASE + ' ===\n');

  // 1. Health
  const h = await req('/api/health');
  log('Health check', h.status === 200 && h.json?.status === 'running');

  // 2. Login
  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASS }) });
  token = login.json?.token || '';
  log('Login admin', !!token);
  if (!token) { console.log('\nABORT: login falhou'); process.exit(1); }

  // 3. Dashboard
  const dash = await req('/api/setup/dashboard');
  log('Dashboard', dash.status === 200);

  // 4. Orgs
  const orgs = await req('/api/orgs');
  log('Listar orgs', orgs.status === 200 && Array.isArray(orgs.json?.orgs));

  // 5. Conversas — CRUD
  const createConv = await req('/api/conversations', { method: 'POST', body: JSON.stringify({ title: 'Smoke', messages: [{ role: 'user', content: 'x' }] }) });
  const convId = createConv.json?.conversation?.id;
  log('Criar conversa', !!convId);
  const listConv = await req('/api/conversations');
  log('Listar conversas', listConv.status === 200);
  if (convId) {
    const delConv = await req('/api/conversations/' + convId, { method: 'DELETE' });
    log('Deletar conversa', delConv.status === 200);
  }

  // 6. Comandos MCP
  const orgStatus = await chat('/org');
  log('/org', orgStatus.includes('orgId') || orgStatus.includes('instanceUrl') || orgStatus.includes('username'));

  const describe = await chat('/describe Lead');
  log('/describe Lead', describe.includes('Name') || describe.includes('fields') || describe.length > 50);

  const listFlows = await chat('/list flows');
  log('/list flows', listFlows.includes('|') && !listFlows.includes('Erro'));

  const listLead = await chat('/list Lead');
  log('/list Lead', listLead.includes('|') && !listLead.includes('Erro'));

  const listAll = await chat('/list all');
  log('/list all', listAll.includes('|') && !listAll.includes('Erro'));

  // 7. Comandos IA (apenas verificar que respondem)
  const hf = await chat('/hf processo de teste smoke');
  log('/hf', hf.length > 100 && !hf.includes('Erro ao'));

  // 8. Deploy preview (dry-run, nao executa)
  const deployPreview = await chat('/deploy criar campo Smoke_Test_Field__c no Lead tipo Text 50');
  log('/deploy preview (dry-run)', deployPreview.includes('Preview') && deployPreview.includes('---PLAN---'));

  // 9. Discovery
  const disc = await chat('/discovery flows');
  log('/discovery flows', disc.length > 100 && !disc.includes('Nenhum componente'));

  // Resumo
  console.log('\n=== RESULTADO ===');
  console.log(`Passou: ${passed} | Falhou: ${failed}`);
  if (failed > 0) {
    console.log('\nFALHAS:');
    results.filter(r => !r.ok).forEach(r => console.log('  - ' + r.name));
    process.exit(1);
  }
  console.log('\nTodos os testes passaram!');
  process.exit(0);
}

run().catch(err => { console.error('ERRO FATAL:', err.message); process.exit(1); });
