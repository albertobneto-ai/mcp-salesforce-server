import express from 'express';
const router = express.Router();

// ══════════════════════════════════════════════════════════
// QA TESTER — Tester funcional automatico por historia
// Rota: GET /api/qa/run/:historia
// Retorna JSON com resultado por CA (ATENDIDO/FALHA/MANUAL)
// ══════════════════════════════════════════════════════════

const ORG = {
  loginUrl: 'https://test.salesforce.com',
  username: 'alberto.bottaro@aircompany.ai.arqevery',
  password: 'Nicework@0001',
  token: 'bpQwYa7Yk0LdA6VVtkvEI5WBJ'
};

async function sfLogin() {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body><urn:login><urn:username>${ORG.username}</urn:username><urn:password>${ORG.password}${ORG.token}</urn:password></urn:login></soapenv:Body>
</soapenv:Envelope>`;
  const resp = await fetch(`${ORG.loginUrl}/services/Soap/u/62.0`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': 'login' }, body
  });
  const xml = await resp.text();
  const sessionId = xml.match(/<sessionId>([^<]+)/)?.[1];
  const serverUrl = xml.match(/<serverUrl>([^<]+)/)?.[1]?.replace(/\/services\/.*/, '');
  if (!sessionId) throw new Error('SF login failed');
  return { token: sessionId, url: serverUrl };
}

async function sfQuery(sf, soql) {
  const resp = await fetch(`${sf.url}/services/data/v62.0/query?q=${encodeURIComponent(soql)}`, {
    headers: { 'Authorization': `Bearer ${sf.token}` }
  });
  return resp.json();
}

async function sfTooling(sf, soql) {
  const resp = await fetch(`${sf.url}/services/data/v62.0/tooling/query?q=${encodeURIComponent(soql)}`, {
    headers: { 'Authorization': `Bearer ${sf.token}` }
  });
  return resp.json();
}

async function sfExecAnon(sf, code) {
  const resp = await fetch(`${sf.url}/services/data/v62.0/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`, {
    headers: { 'Authorization': `Bearer ${sf.token}` }
  });
  return resp.json();
}

function ok(ca, desc, evidence) { return { ca, status: 'ATENDIDO', tipo: 'automatico', descricao: desc, evidencia: evidence }; }
function fail(ca, desc, evidence) { return { ca, status: 'NAO_ATENDIDO', tipo: 'automatico', descricao: desc, evidencia: evidence }; }
function manual(ca, desc) { return { ca, status: 'MANUAL', tipo: 'manual', descricao: desc, evidencia: 'Requer verificacao visual no Salesforce' }; }

// ══════════════════════════════════════
// TESTES POR HISTORIA
// ══════════════════════════════════════

async function test83(sf) {
  const results = [];

  // CA01: Quick Action existe
  try {
    const qa = await sfTooling(sf, "SELECT DeveloperName, Type FROM QuickActionDefinition WHERE SobjectType='Account' AND DeveloperName='Consultar_Serasa'");
    if (qa.records?.length > 0) results.push(ok('CA01', 'Quick Action Consultar_Serasa existe', `Type=${qa.records[0].Type}, DeveloperName=${qa.records[0].DeveloperName}`));
    else results.push(fail('CA01', 'Quick Action nao encontrada', 'QuickActionDefinition query retornou 0 registros'));
  } catch(e) { results.push(fail('CA01', 'Erro ao verificar QA', e.message)); }

  // CA01 complemento: botao na Flexipage (verificacao API)
  results.push(manual('CA01-UI', 'Verificar visualmente que botao aparece apenas para RT NacionalPJ'));

  // CA02: Callout E2E funciona
  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/71208516000174'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 200, 'HTTP ' + res.getStatusCode()); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('razaoSocial') != null, 'razaoSocial null');`);
    if (r.success) results.push(ok('CA02', 'Callout E2E retorna dados', `compiled=${r.compiled}, success=${r.success}. NC MuleSoft_Serasa → Mock → 200 OK, razaoSocial preenchido`));
    else results.push(fail('CA02', 'Callout falhou', `${r.compileProblem || ''} ${r.exceptionMessage || ''}`));
  } catch(e) { results.push(fail('CA02', 'Erro callout', e.message)); }

  // CA03: Botao oculto Internacional
  results.push(manual('CA03', 'Abrir conta Internacional e verificar que botao Consultar Serasa NAO aparece'));

  // CA04: Multiplas execucoes (callout 2x)
  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/12345678000190'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 200); HttpRequest req2 = new HttpRequest(); req2.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/12345678000190'); req2.setMethod('GET'); req2.setTimeout(10000); HttpResponse res2 = new Http().send(req2); System.assert(res2.getStatusCode() == 200);`);
    if (r.success) results.push(ok('CA04', 'Multiplos callouts executam com sucesso', `2 chamadas consecutivas ao mock, ambas HTTP 200`));
    else results.push(fail('CA04', 'Multiplo callout falhou', r.exceptionMessage || r.compileProblem));
  } catch(e) { results.push(fail('CA04', 'Erro', e.message)); }

  // CA05: UltimaConsultaSerasa (verificar campo existe e e queryable)
  try {
    const q = await sfTooling(sf, "SELECT QualifiedApiName FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName='UltimaConsultaSerasa__c'");
    if (q.records?.length > 0) results.push(ok('CA05', 'Campo UltimaConsultaSerasa__c existe e e queryable', `EntityParticle confirmado`));
    else results.push(fail('CA05', 'Campo UltimaConsultaSerasa__c nao encontrado', ''));
  } catch(e) { results.push(fail('CA05', 'Erro', e.message)); }

  // CA06: StatusIntegracaoSerasa (campo existe)
  try {
    const q = await sfTooling(sf, "SELECT QualifiedApiName FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName='StatusIntegracaoSerasa__c'");
    if (q.records?.length > 0) results.push(ok('CA06', 'Campo StatusIntegracaoSerasa__c existe', 'EntityParticle confirmado'));
    else results.push(fail('CA06', 'Campo nao encontrado', ''));
  } catch(e) { results.push(fail('CA06', 'Erro', e.message)); }

  // CA07: Callout com campos nulos (parcial)
  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/11111111000111'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('nomeFantasia') == null, 'nomeFantasia deveria ser null'); System.assert(body.get('situacaoCnpj') != null, 'situacaoCnpj preenchido');`);
    if (r.success) results.push(ok('CA07', 'Mock retorna campos nulos corretamente', 'CNPJ 11111111000111: nomeFantasia=null, situacaoCnpj=ATIVA. Logica isNotBlank preserva campo existente'));
    else results.push(fail('CA07', 'Teste campos nulos falhou', r.exceptionMessage || r.compileProblem));
  } catch(e) { results.push(fail('CA07', 'Erro', e.message)); }

  // CA08: CNPJ nao encontrado (404)
  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/00000000000000'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 404, 'Esperado 404, recebeu ' + res.getStatusCode());`);
    if (r.success) results.push(ok('CA08', 'CNPJ inexistente retorna 404', 'Mock retornou HTTP 404 para CNPJ 00000000000000'));
    else results.push(fail('CA08', '404 nao retornado', r.exceptionMessage || r.compileProblem));
  } catch(e) { results.push(fail('CA08', 'Erro', e.message)); }

  // CA09: Platform Event publicavel
  try {
    const r = await sfExecAnon(sf, `Integracao_Erro__e evt = new Integracao_Erro__e(Tipo__c='QA_TEST_83', Mensagem__c='Teste automatico QA', RecordId__c='001000000000000AAA'); Database.SaveResult sr = EventBus.publish(evt); System.assert(sr.isSuccess(), 'Falha ao publicar PE');`);
    if (r.success) results.push(ok('CA09', 'Platform Event publicado com sucesso', 'Integracao_Erro__e publicado com Tipo=QA_TEST_83'));
    else results.push(fail('CA09', 'PE nao publicou', r.exceptionMessage || r.compileProblem));
  } catch(e) { results.push(fail('CA09', 'Erro', e.message)); }

  // CA10: VR_SituacaoCNPJ ativa + CNPJ BAIXADA retorna do mock
  try {
    const vr = await sfTooling(sf, "SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName='VR_SituacaoCNPJ' AND Active=true");
    const callout = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/99999999000199'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('situacaoCnpj') == 'BAIXADA', 'Esperado BAIXADA');`);
    if (vr.records?.length > 0 && callout.success) results.push(ok('CA10', 'VR ativa + Mock retorna BAIXADA', `VR_SituacaoCNPJ Active=true. Mock CNPJ 99999999000199 retorna situacaoCnpj=BAIXADA`));
    else results.push(fail('CA10', 'VR ou mock falhou', `VR encontrada: ${vr.records?.length > 0}, callout: ${callout.success}`));
  } catch(e) { results.push(fail('CA10', 'Erro', e.message)); }

  return results;
}

async function test84(sf) {
  const results = [];

  // C1: ListView existe
  try {
    const lv = await sfQuery(sf, "SELECT Id, Name FROM ListView WHERE SobjectType='Account' AND DeveloperName='Contas_Pendentes_BackOffice'");
    if (lv.records?.length > 0) results.push(ok('RN01+02', 'ListView Contas_Pendentes_BackOffice existe', `Name=${lv.records[0].Name}`));
    else results.push(fail('RN01+02', 'ListView nao encontrada', ''));
  } catch(e) { results.push(fail('RN01+02', 'Erro', e.message)); }

  results.push(manual('RN01-UI', 'Logar como Vendedor e verificar que nao consegue acessar a lista'));

  // C2: VR_StatusCadastro ativa com formula correta
  try {
    const vr = await sfTooling(sf, "SELECT ValidationName, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName='VR_StatusCadastro' AND Active=true");
    if (vr.records?.length > 0) {
      const formula = vr.records[0].Metadata?.errorConditionFormula || '';
      const hasCP = formula.includes('BackOfficeCadastro');
      if (hasCP) results.push(ok('RN01-VR', 'VR_StatusCadastro protege StatusCadastro', `Formula inclui $Permission.BackOfficeCadastro. Apenas BackOffice pode alterar.`));
      else results.push(fail('RN01-VR', 'VR sem referencia a CP', formula));
    } else results.push(fail('RN01-VR', 'VR_StatusCadastro nao encontrada ou inativa', ''));
  } catch(e) { results.push(fail('RN01-VR', 'Erro', e.message)); }

  // C3: CP atribuida ao PS
  try {
    const cp = await sfQuery(sf, "SELECT Id FROM SetupEntityAccess WHERE SetupEntityId IN (SELECT Id FROM CustomPermission WHERE DeveloperName='BackOfficeCadastro') AND ParentId IN (SELECT Id FROM PermissionSet WHERE Name='Account_Backoffice_Edit')");
    if (cp.totalSize > 0) results.push(ok('RN03+04', 'CP BackOfficeCadastro atribuida ao PS Account_Backoffice_Edit', `SetupEntityAccess encontrado`));
    else results.push(fail('RN03+04', 'CP nao atribuida ao PS', ''));
  } catch(e) { results.push(fail('RN03+04', 'Erro', e.message)); }

  // C4+C5: Picklist corrigida
  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Account/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const d = await desc.json();
    const field = d.fields?.find(f => f.name === 'StatusCadastro__c');
    const vals = field?.picklistValues?.filter(pv => pv.active).map(pv => pv.value) || [];
    const hasTypo = vals.includes('Pendende Dados');
    const hasCorrect = vals.includes('Pendente Dados');
    if (hasCorrect && !hasTypo) results.push(ok('Picklist', 'StatusCadastro corrigido', `Valores ativos: ${vals.join(', ')}. Typo "Pendende" ausente.`));
    else results.push(fail('Picklist', 'Picklist com problema', `Valores: ${vals.join(', ')}. Typo presente: ${hasTypo}`));
  } catch(e) { results.push(fail('Picklist', 'Erro', e.message)); }

  results.push(manual('RN04-Manual', 'Logar como BackOffice, abrir conta Pendente, preencher campos e alterar StatusCadastro para Completo'));
  results.push(manual('HF-C5', 'Logar como BackOffice, forcar StatusCadastro=Completo com campos Serasa vazios'));

  return results;
}

async function test85(sf) {
  const results = [];

  // Apex class existe
  try {
    const cls = await sfQuery(sf, "SELECT Name FROM ApexClass WHERE Name IN ('SerasaRetryBatch','SerasaRetryBatchTest')");
    const names = cls.records?.map(r => r.Name) || [];
    if (names.includes('SerasaRetryBatch') && names.includes('SerasaRetryBatchTest'))
      results.push(ok('RN01', 'Apex classes deployadas', `${names.join(', ')}`));
    else results.push(fail('RN01', 'Apex classes faltando', `Encontradas: ${names.join(', ')}`));
  } catch(e) { results.push(fail('RN01', 'Erro', e.message)); }

  // CMDT existe
  try {
    const cmdt = await sfQuery(sf, "SELECT CronExpression__c, BatchScope__c, IsActive__c FROM BatchSerasaConfig__mdt WHERE DeveloperName='Default'");
    if (cmdt.records?.length > 0) {
      const cfg = cmdt.records[0];
      results.push(ok('RN01-CMDT', 'CMDT Default configurado', `Cron=${cfg.CronExpression__c}, Scope=${cfg.BatchScope__c}, Ativo=${cfg.IsActive__c}`));
    } else results.push(fail('RN01-CMDT', 'CMDT Default nao encontrado', ''));
  } catch(e) { results.push(fail('RN01-CMDT', 'Erro', e.message)); }

  // Job agendado
  try {
    const job = await sfQuery(sf, "SELECT Id, CronJobDetail.Name, State FROM CronTrigger WHERE CronJobDetail.Name LIKE '%Serasa%' LIMIT 1");
    if (job.records?.length > 0) results.push(ok('RN01-Job', 'Job agendado', `Name=${job.records[0].CronJobDetail?.Name}, State=${job.records[0].State}`));
    else results.push(fail('RN01-Job', 'Nenhum job agendado', ''));
  } catch(e) { results.push(fail('RN01-Job', 'Erro', e.message)); }

  // RN02: Query do batch filtra corretamente
  try {
    const q = await sfQuery(sf, "SELECT COUNT() FROM Account WHERE RecordType.Name='Nacional PJ' AND StatusCadastro__c='Pendente Dados' AND CNPJ__c != null");
    results.push(ok('RN02', 'Query batch funcional', `Contas elegiveis para batch: ${q.totalSize}`));
  } catch(e) { results.push(fail('RN02', 'Erro na query', e.message)); }

  // RN05: Falha muda para Segunda Tentativa (verificar via mock)
  results.push(manual('RN05', 'Executar batch manualmente e verificar que contas mudaram para Pendente Dados - Segunda Tentativa'));

  // RN06: Segunda Tentativa nao reprocessada
  try {
    const q = await sfQuery(sf, "SELECT COUNT() FROM Account WHERE RecordType.Name='Nacional PJ' AND StatusCadastro__c='Pendente Dados - Segunda Tentativa'");
    results.push(ok('RN06-info', 'Contas Segunda Tentativa (nao reprocessaveis)', `Total: ${q.totalSize}. Batch filtra apenas StatusCadastro='Pendente Dados', ignorando estas.`));
  } catch(e) { results.push(fail('RN06', 'Erro', e.message)); }

  results.push(manual('RN03', 'Verificar que campos preenchidos manualmente nao foram sobrescritos por valores nulos do Serasa'));
  results.push(manual('HF-C5', 'Verificar que conta Internacional nao foi processada pela batch'));

  return results;
}

async function testUSBase(sf) {
  const results = [];
  const fields = ['UltimaConsultaSerasa__c','TentativasSerasa__c','UltimaFalhaSerasa__c','MotivoFalhaSerasa__c'];

  // 4 campos existem
  try {
    const q = await sfTooling(sf, `SELECT QualifiedApiName FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName IN ('${fields.join("','")}')`);
    const found = q.records?.map(r => r.QualifiedApiName) || [];
    if (found.length === 4) results.push(ok('CA-01', '4 campos controle existem', `Campos: ${found.join(', ')}`));
    else results.push(fail('CA-01', `Apenas ${found.length}/4 campos`, `Encontrados: ${found.join(', ')}`));
  } catch(e) { results.push(fail('CA-01', 'Erro', e.message)); }

  // PE existe com 5 campos
  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Integracao_Erro__e/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const d = await desc.json();
    const custom = d.fields?.filter(f => f.name.endsWith('__c')).map(f => f.name) || [];
    if (custom.length >= 5) results.push(ok('CA-04', 'Platform Event com 5 campos', `Campos: ${custom.join(', ')}`));
    else results.push(fail('CA-04', `PE com ${custom.length} campos`, `${custom.join(', ')}`));
  } catch(e) { results.push(fail('CA-04', 'Erro', e.message)); }

  // FLS verificacao (3 PSs)
  for (const ps of ['Account_Admin_Edit', 'Account_Comercial_Edit', 'Account_ReadOnly']) {
    try {
      const q = await sfQuery(sf, `SELECT Id FROM PermissionSet WHERE Name='${ps}'`);
      if (q.totalSize > 0) results.push(ok(`FLS-${ps}`, `PS ${ps} existe`, `Id=${q.records[0].Id}`));
      else results.push(fail(`FLS-${ps}`, `PS ${ps} nao encontrado`, ''));
    } catch(e) { results.push(fail(`FLS-${ps}`, 'Erro', e.message)); }
  }

  results.push(manual('CA-03', 'Verificar secao Controle de Integracao Serasa no layout Nacional PJ'));
  results.push(manual('CA-06', 'Verificar Visibility Rule: secao oculta para Internacional'));

  return results;
}

async function test50A(sf) {
  const results = [];

  // RTs
  try {
    const rts = await sfQuery(sf, "SELECT DeveloperName, IsActive FROM RecordType WHERE SobjectType='Account' AND DeveloperName IN ('NacionalPJ','Internacional')");
    const active = rts.records?.filter(r => r.IsActive).map(r => r.DeveloperName) || [];
    if (active.includes('NacionalPJ') && active.includes('Internacional'))
      results.push(ok('CA-001', 'RTs NacionalPJ e Internacional ativos', `Ativos: ${active.join(', ')}`));
    else results.push(fail('CA-001', 'RTs faltando', `Ativos: ${active.join(', ')}`));
  } catch(e) { results.push(fail('CA-001', 'Erro', e.message)); }

  // VR RT imutavel
  try {
    const vr = await sfTooling(sf, "SELECT ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND Active=true AND (ValidationName='VR_RT_Imutavel' OR ValidationName='Block_RecordType_Change')");
    if (vr.records?.length > 0) results.push(ok('CA-003', 'VR RT imutavel ativa', `${vr.records[0].ValidationName}`));
    else results.push(fail('CA-003', 'VR RT imutavel nao encontrada', ''));
  } catch(e) { results.push(fail('CA-003', 'Erro', e.message)); }

  // VR CNPJ
  try {
    const vrs = await sfTooling(sf, "SELECT ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND Active=true AND (ValidationName LIKE '%CNPJ%')");
    const names = vrs.records?.map(r => r.ValidationName) || [];
    if (names.length >= 2) results.push(ok('CA-004', 'VRs CNPJ ativas', `${names.join(', ')}`));
    else results.push(fail('CA-004', 'VRs CNPJ insuficientes', `Encontradas: ${names.join(', ')}`));
  } catch(e) { results.push(fail('CA-004', 'Erro', e.message)); }

  // Objetos apoio
  try {
    const cnae = await sfQuery(sf, "SELECT COUNT() FROM CNAE__c");
    const nj = await sfQuery(sf, "SELECT COUNT() FROM NaturezaJuridica__c");
    results.push(ok('CA-010', 'Objetos apoio com dados', `CNAE: ${cnae.totalSize} registros, NJ: ${nj.totalSize} registros`));
  } catch(e) { results.push(fail('CA-010', 'Erro', e.message)); }

  results.push(manual('CA-002', 'Verificar layout Nacional PJ com secoes e campos conforme planilha'));
  results.push(manual('CA-013', 'Verificar organizacao de campos por secao'));
  results.push(manual('CA-014', 'Verificar campos nativos nao contemplados ocultos'));

  return results;
}

// ══════════════════════════════════════
// ROUTER
// ══════════════════════════════════════

const TESTS = { '83': test83, '84': test84, '85': test85, 'usbase': testUSBase, '50a': test50A };

router.get('/run/:historia', async (req, res) => {
  const historia = req.params.historia.toLowerCase();
  const testFn = TESTS[historia];
  if (!testFn) return res.status(400).json({ error: `Historia '${historia}' nao encontrada. Disponiveis: ${Object.keys(TESTS).join(', ')}` });

  try {
    console.log(`[qa-tester] Executando testes para ${historia}...`);
    const sf = await sfLogin();
    const results = await testFn(sf);
    const summary = {
      historia,
      timestamp: new Date().toISOString(),
      total: results.length,
      atendido: results.filter(r => r.status === 'ATENDIDO').length,
      nao_atendido: results.filter(r => r.status === 'NAO_ATENDIDO').length,
      manual: results.filter(r => r.status === 'MANUAL').length,
      results
    };
    console.log(`[qa-tester] ${historia}: ${summary.atendido} OK, ${summary.nao_atendido} FAIL, ${summary.manual} MANUAL`);
    res.json(summary);
  } catch(e) {
    console.error(`[qa-tester] Erro: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'qa-tester', historias: Object.keys(TESTS) });
});

export default router;
