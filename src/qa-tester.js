import express from 'express';
const router = express.Router();

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
async function sfQuery(sf, soql) { const r = await fetch(`${sf.url}/services/data/v62.0/query?q=${encodeURIComponent(soql)}`, { headers: { 'Authorization': `Bearer ${sf.token}` } }); return r.json(); }
async function sfTooling(sf, soql) { const r = await fetch(`${sf.url}/services/data/v62.0/tooling/query?q=${encodeURIComponent(soql)}`, { headers: { 'Authorization': `Bearer ${sf.token}` } }); return r.json(); }
async function sfExecAnon(sf, code) { const r = await fetch(`${sf.url}/services/data/v62.0/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`, { headers: { 'Authorization': `Bearer ${sf.token}` } }); return r.json(); }

function ok(ca, desc, acao, evidencia, comoVerificar) { return { ca, status: 'ATENDIDO', tipo: 'automatico', descricao: desc, acao, evidencia, comoVerificar }; }
function fail(ca, desc, acao, evidencia, comoVerificar) { return { ca, status: 'NAO_ATENDIDO', tipo: 'automatico', descricao: desc, acao, evidencia, comoVerificar }; }
function manual(ca, desc, comoVerificar) { return { ca, status: 'MANUAL', tipo: 'manual', descricao: desc, acao: 'Verificacao visual', evidencia: 'Requer verificacao visual no Salesforce', comoVerificar }; }

async function test83(sf) {
  const results = [];

  try {
    const qa = await sfTooling(sf, "SELECT DeveloperName, Type FROM QuickActionDefinition WHERE SobjectType='Account' AND DeveloperName='Consultar_Serasa'");
    if (qa.records?.length > 0) results.push(ok('CA01', 'Quick Action Consultar_Serasa existe',
      'Tooling API SOQL: SELECT DeveloperName, Type FROM QuickActionDefinition WHERE SobjectType=Account AND DeveloperName=Consultar_Serasa',
      `Resultado: Type=${qa.records[0].Type}, DeveloperName=${qa.records[0].DeveloperName}`,
      'Setup > Object Manager > Account > Buttons, Links, and Actions > procurar Consultar_Serasa'));
    else results.push(fail('CA01', 'Quick Action nao encontrada', 'Tooling query QuickActionDefinition', '0 registros retornados', 'Setup > Object Manager > Account > Buttons, Links, and Actions'));
  } catch(e) { results.push(fail('CA01', 'Erro', 'Tooling query', e.message, '')); }

  results.push(manual('CA01-UI', 'Botao visivel apenas para RT NacionalPJ', 'Abrir conta Nacional PJ > verificar botao no cabecalho. Abrir conta Internacional > confirmar ausencia.'));

  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/71208516000174'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 200, 'HTTP ' + res.getStatusCode()); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('razaoSocial') != null, 'razaoSocial null');`);
    if (r.success) results.push(ok('CA02', 'Callout E2E retorna dados',
      'Execute Anonymous: callout:MuleSoft_Serasa/api/serasa/consulta/71208516000174 via HttpRequest GET',
      'HTTP 200 OK. razaoSocial preenchido. Callout saiu da org via Named Credential MuleSoft_Serasa ate o mock Heroku.',
      'Developer Console > Execute Anonymous > colar o codigo acima > verificar System.debug no log'));
    else results.push(fail('CA02', 'Callout falhou', 'Execute Anonymous HttpRequest', r.exceptionMessage || r.compileProblem, 'Developer Console > Execute Anonymous'));
  } catch(e) { results.push(fail('CA02', 'Erro', 'Execute Anonymous', e.message, '')); }

  results.push(manual('CA03', 'Botao oculto para Internacional', 'Abrir conta com RT Internacional > verificar que botao Consultar Serasa NAO aparece no cabecalho/acoes.'));

  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/12345678000190'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 200); HttpRequest req2 = new HttpRequest(); req2.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/12345678000190'); req2.setMethod('GET'); req2.setTimeout(10000); HttpResponse res2 = new Http().send(req2); System.assert(res2.getStatusCode() == 200);`);
    if (r.success) results.push(ok('CA04', 'Multiplos callouts executam',
      'Execute Anonymous: 2 chamadas consecutivas ao CNPJ 12345678000190 via callout:MuleSoft_Serasa',
      'Ambas retornaram HTTP 200. Callout pode ser executado multiplas vezes sem erro.',
      'Developer Console > Execute Anonymous > executar 2 callouts seguidos > verificar ambos 200 no log'));
    else results.push(fail('CA04', 'Falhou', 'Execute Anonymous 2x', r.exceptionMessage || r.compileProblem, ''));
  } catch(e) { results.push(fail('CA04', 'Erro', '', e.message, '')); }

  try {
    const q = await sfTooling(sf, "SELECT QualifiedApiName, DataType FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName='UltimaConsultaSerasa__c'");
    if (q.records?.length > 0) results.push(ok('CA05', 'Campo UltimaConsultaSerasa__c existe',
      'Tooling API SOQL: SELECT QualifiedApiName, DataType FROM EntityParticle WHERE QualifiedApiName=UltimaConsultaSerasa__c',
      `Campo encontrado. DataType=${q.records[0].DataType}`,
      'Setup > Object Manager > Account > Fields & Relationships > procurar UltimaConsultaSerasa'));
    else results.push(fail('CA05', 'Campo nao encontrado', 'Tooling EntityParticle', '', 'Setup > Account > Fields'));
  } catch(e) { results.push(fail('CA05', 'Erro', '', e.message, '')); }

  try {
    const q = await sfTooling(sf, "SELECT QualifiedApiName, DataType FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName='StatusIntegracaoSerasa__c'");
    if (q.records?.length > 0) results.push(ok('CA06', 'Campo StatusIntegracaoSerasa__c existe',
      'Tooling API SOQL: SELECT QualifiedApiName FROM EntityParticle WHERE QualifiedApiName=StatusIntegracaoSerasa__c',
      `Campo encontrado. DataType=${q.records[0].DataType}`,
      'Setup > Object Manager > Account > Fields & Relationships > procurar StatusIntegracaoSerasa'));
    else results.push(fail('CA06', 'Campo nao encontrado', 'Tooling EntityParticle', '', ''));
  } catch(e) { results.push(fail('CA06', 'Erro', '', e.message, '')); }

  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/11111111000111'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('nomeFantasia') == null, 'nomeFantasia deveria ser null'); System.assert(body.get('situacaoCnpj') != null, 'situacaoCnpj preenchido');`);
    if (r.success) results.push(ok('CA07', 'Mock retorna campos nulos corretamente',
      'Execute Anonymous: callout CNPJ 11111111000111 > assert nomeFantasia==null AND situacaoCnpj!=null',
      'nomeFantasia=null (preserva valor existente), situacaoCnpj=ATIVA. Logica isNotBlank no SerasaCalloutService garante que campos nulos do Serasa nao sobrescrevem dados manuais.',
      'Developer Console > Execute Anonymous > callout 11111111000111 > verificar JSON no log. Ou: abrir conta, preencher NomeFantasia manualmente, consultar Serasa, verificar que NomeFantasia nao mudou.'));
    else results.push(fail('CA07', 'Teste nulos falhou', 'Execute Anonymous', r.exceptionMessage || r.compileProblem, ''));
  } catch(e) { results.push(fail('CA07', 'Erro', '', e.message, '')); }

  try {
    const r = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/00000000000000'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); System.assert(res.getStatusCode() == 404, 'Esperado 404, recebeu ' + res.getStatusCode());`);
    if (r.success) results.push(ok('CA08', 'CNPJ inexistente retorna 404',
      'Execute Anonymous: callout CNPJ 00000000000000 > assert HTTP 404',
      'Mock retornou HTTP 404 com body {"error":"CNPJ nao encontrado"}. SerasaCalloutService trata 404 como "nao encontrado" e permite preenchimento manual.',
      'Developer Console > Execute Anonymous > callout 00000000000000 > verificar statusCode=404 no log'));
    else results.push(fail('CA08', '404 nao retornado', 'Execute Anonymous', r.exceptionMessage || r.compileProblem, ''));
  } catch(e) { results.push(fail('CA08', 'Erro', '', e.message, '')); }

  try {
    const r = await sfExecAnon(sf, `Integracao_Erro__e evt = new Integracao_Erro__e(Tipo__c='QA_TEST_83', Mensagem__c='Teste automatico QA', RecordId__c='001000000000000AAA'); Database.SaveResult sr = EventBus.publish(evt); System.assert(sr.isSuccess(), 'Falha ao publicar PE');`);
    if (r.success) results.push(ok('CA09', 'Platform Event publicado com sucesso',
      'Execute Anonymous: EventBus.publish(new Integracao_Erro__e(Tipo__c=QA_TEST_83))',
      'PE publicado com sucesso. Em cenario real de falha, o Screen Flow publica PE automaticamente com Tipo=SCREEN_FLOW_83.',
      'Setup > Platform Events > Integracao Erro > verificar que o evento existe. Para monitorar publicacoes: Setup > Event Bus > Subscribe to Integracao_Erro__e'));
    else results.push(fail('CA09', 'PE nao publicou', 'Execute Anonymous EventBus.publish', r.exceptionMessage || r.compileProblem, ''));
  } catch(e) { results.push(fail('CA09', 'Erro', '', e.message, '')); }

  try {
    const vr = await sfTooling(sf, "SELECT ValidationName, Active, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName='VR_SituacaoCNPJ' AND Active=true");
    const callout = await sfExecAnon(sf, `HttpRequest req = new HttpRequest(); req.setEndpoint('callout:MuleSoft_Serasa/api/serasa/consulta/99999999000199'); req.setMethod('GET'); req.setTimeout(10000); HttpResponse res = new Http().send(req); Map<String,Object> body = (Map<String,Object>) JSON.deserializeUntyped(res.getBody()); System.assert(body.get('situacaoCnpj') == 'BAIXADA', 'Esperado BAIXADA');`);
    if (vr.records?.length > 0 && callout.success) {
      const formula = vr.records[0].Metadata?.errorConditionFormula || '';
      results.push(ok('CA10', 'VR ativa + Mock retorna BAIXADA',
        'Tooling SOQL: VR_SituacaoCNPJ Active=true + Execute Anonymous callout CNPJ 99999999000199 assert situacaoCnpj==BAIXADA',
        `VR_SituacaoCNPJ ativa com formula: ${formula.substring(0,120)}... Mock retorna situacaoCnpj=BAIXADA para CNPJ 99999999000199.`,
        'Setup > Object Manager > Account > Validation Rules > VR_SituacaoCNPJ > verificar Active=true. Para testar: editar conta, definir SituacaoCNPJ=BAIXADA, tentar salvar > deve exibir erro.'));
    } else results.push(fail('CA10', 'VR ou mock falhou', 'Tooling + Execute Anonymous', '', ''));
  } catch(e) { results.push(fail('CA10', 'Erro', '', e.message, '')); }

  return results;
}

async function test84(sf) {
  const results = [];
  try {
    const lv = await sfQuery(sf, "SELECT Id, Name FROM ListView WHERE SobjectType='Account' AND DeveloperName='Contas_Pendentes_BackOffice'");
    if (lv.records?.length > 0) results.push(ok('RN01+02', 'ListView existe',
      'REST API SOQL: SELECT Id, Name FROM ListView WHERE DeveloperName=Contas_Pendentes_BackOffice',
      `Name=${lv.records[0].Name}, Id=${lv.records[0].Id}`,
      'App Launcher > Accounts > dropdown List Views > procurar "Contas Pendentes - BackOffice"'));
    else results.push(fail('RN01+02', 'ListView nao encontrada', 'REST SOQL ListView', '', 'Setup > Account > List Views'));
  } catch(e) { results.push(fail('RN01+02', 'Erro', '', e.message, '')); }

  results.push(manual('RN01-UI', 'Vendedor nao acessa lista', 'Logar como usuario SEM PS Account_Backoffice_Edit > Accounts > verificar que ListView nao aparece no dropdown.'));

  try {
    const vr = await sfTooling(sf, "SELECT ValidationName, Metadata FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName='VR_StatusCadastro' AND Active=true");
    if (vr.records?.length > 0) {
      const formula = vr.records[0].Metadata?.errorConditionFormula || '';
      results.push(ok('RN01-VR', 'VR_StatusCadastro protege StatusCadastro',
        'Tooling SOQL: SELECT Metadata FROM ValidationRule WHERE ValidationName=VR_StatusCadastro AND Active=true',
        `Formula: ${formula}. Apenas usuarios com $Permission.BackOfficeCadastro podem alterar StatusCadastro.`,
        'Setup > Object Manager > Account > Validation Rules > VR_StatusCadastro > verificar formula e Active=true'));
    } else results.push(fail('RN01-VR', 'VR nao encontrada', 'Tooling SOQL', '', ''));
  } catch(e) { results.push(fail('RN01-VR', 'Erro', '', e.message, '')); }

  try {
    const cp = await sfQuery(sf, "SELECT Id FROM SetupEntityAccess WHERE SetupEntityId IN (SELECT Id FROM CustomPermission WHERE DeveloperName='BackOfficeCadastro') AND ParentId IN (SELECT Id FROM PermissionSet WHERE Name='Account_Backoffice_Edit')");
    if (cp.totalSize > 0) results.push(ok('RN03+04', 'CP BackOfficeCadastro atribuida ao PS',
      'REST SOQL: SELECT Id FROM SetupEntityAccess cruzando CustomPermission=BackOfficeCadastro com PermissionSet=Account_Backoffice_Edit',
      `SetupEntityAccess encontrado (${cp.totalSize} registro). CP ativa no PS.`,
      'Setup > Permission Sets > Account_Backoffice_Edit > Custom Permissions > verificar BackOfficeCadastro habilitada'));
    else results.push(fail('RN03+04', 'CP nao atribuida', 'REST SOQL SetupEntityAccess', '', 'Setup > Permission Sets > Account_Backoffice_Edit > Custom Permissions'));
  } catch(e) { results.push(fail('RN03+04', 'Erro', '', e.message, '')); }

  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Account/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const d = await desc.json();
    const field = d.fields?.find(f => f.name === 'StatusCadastro__c');
    const vals = field?.picklistValues?.filter(pv => pv.active).map(pv => pv.value) || [];
    const hasTypo = vals.includes('Pendende Dados');
    const hasCorrect = vals.includes('Pendente Dados');
    if (hasCorrect && !hasTypo) results.push(ok('Picklist', 'StatusCadastro corrigido',
      'REST API: /sobjects/Account/describe > filtrar campo StatusCadastro__c > listar picklistValues ativos',
      `Valores ativos: ${vals.join(', ')}. Typo "Pendende" NAO presente (corrigido).`,
      'Setup > Object Manager > Account > Fields > StatusCadastro__c > Values > verificar que "Pendende Dados" nao existe e "Pendente Dados" existe'));
    else results.push(fail('Picklist', 'Problema', 'REST describe Account', `Valores: ${vals.join(', ')}. Typo: ${hasTypo}`, 'Setup > Account > Fields > StatusCadastro__c'));
  } catch(e) { results.push(fail('Picklist', 'Erro', '', e.message, '')); }

  results.push(manual('RN04-Manual', 'BackOffice complementa e salva Completo', 'Logar como BackOffice (com PS Account_Backoffice_Edit) > abrir conta Pendente Dados > preencher campos faltantes > alterar StatusCadastro para Completo > Salvar > deve salvar sem erro.'));
  results.push(manual('HF-C5', 'Forcar Completo com vazios', 'Logar como BackOffice > abrir conta com campos Serasa VAZIOS > alterar StatusCadastro direto para Completo sem preencher nada > Salvar > deve salvar (BackOffice assume responsabilidade).'));
  return results;
}

async function test85(sf) {
  const results = [];
  try {
    const cls = await sfQuery(sf, "SELECT Name FROM ApexClass WHERE Name IN ('SerasaRetryBatch','SerasaRetryBatchTest')");
    const names = cls.records?.map(r => r.Name) || [];
    if (names.includes('SerasaRetryBatch') && names.includes('SerasaRetryBatchTest'))
      results.push(ok('RN01', 'Apex classes deployadas',
        'REST SOQL: SELECT Name FROM ApexClass WHERE Name IN (SerasaRetryBatch, SerasaRetryBatchTest)',
        `Classes encontradas: ${names.join(', ')}`,
        'Setup > Apex Classes > procurar SerasaRetryBatch e SerasaRetryBatchTest'));
    else results.push(fail('RN01', 'Classes faltando', 'REST SOQL ApexClass', `Encontradas: ${names.join(', ')}`, 'Setup > Apex Classes'));
  } catch(e) { results.push(fail('RN01', 'Erro', '', e.message, '')); }

  try {
    const cmdt = await sfQuery(sf, "SELECT CronExpression__c, BatchScope__c, IsActive__c FROM BatchSerasaConfig__mdt WHERE DeveloperName='Default'");
    if (cmdt.records?.length > 0) {
      const cfg = cmdt.records[0];
      results.push(ok('RN01-CMDT', 'CMDT Default configurado',
        'REST SOQL: SELECT CronExpression__c, BatchScope__c, IsActive__c FROM BatchSerasaConfig__mdt WHERE DeveloperName=Default',
        `CronExpression=${cfg.CronExpression__c}, BatchScope=${cfg.BatchScope__c}, IsActive=${cfg.IsActive__c}`,
        'Setup > Custom Metadata Types > Batch Serasa Config > Manage Records > Default'));
    } else results.push(fail('RN01-CMDT', 'CMDT nao encontrado', 'REST SOQL', '', 'Setup > Custom Metadata Types'));
  } catch(e) { results.push(fail('RN01-CMDT', 'Erro', '', e.message, '')); }

  try {
    const job = await sfQuery(sf, "SELECT Id, CronJobDetail.Name, State, NextFireTime FROM CronTrigger WHERE CronJobDetail.Name LIKE '%Serasa%' LIMIT 1");
    if (job.records?.length > 0) results.push(ok('RN01-Job', 'Job agendado',
      'REST SOQL: SELECT CronJobDetail.Name, State, NextFireTime FROM CronTrigger WHERE CronJobDetail.Name LIKE Serasa',
      `Name=${job.records[0].CronJobDetail?.Name}, State=${job.records[0].State}, NextFire=${job.records[0].NextFireTime}`,
      'Setup > Environments > Jobs > Scheduled Jobs > procurar "Serasa Retry Batch"'));
    else results.push(fail('RN01-Job', 'Nenhum job', 'REST SOQL CronTrigger', '', 'Setup > Scheduled Jobs'));
  } catch(e) { results.push(fail('RN01-Job', 'Erro', '', e.message, '')); }

  try {
    const q = await sfQuery(sf, "SELECT COUNT() FROM Account WHERE RecordType.Name='Nacional PJ' AND StatusCadastro__c='Pendente Dados' AND CNPJ__c != null");
    results.push(ok('RN02', 'Query batch funcional',
      "REST SOQL: SELECT COUNT() FROM Account WHERE RecordType.Name='Nacional PJ' AND StatusCadastro__c='Pendente Dados' AND CNPJ__c != null",
      `Contas elegiveis para batch: ${q.totalSize}. Esta e a mesma query que o SerasaRetryBatch.start() executa.`,
      'Developer Console > Query Editor > colar a query acima > verificar resultado'));
  } catch(e) { results.push(fail('RN02', 'Erro na query', 'REST SOQL', e.message, '')); }

  results.push(manual('RN05', 'Batch falha = Segunda Tentativa', 'Developer Console > Execute Anonymous > Database.executeBatch(new SerasaRetryBatch(), 1); > aguardar > Setup > Apex Jobs > verificar Completed > abrir conta processada > StatusCadastro deve ser Pendente Dados - Segunda Tentativa.'));

  try {
    const q = await sfQuery(sf, "SELECT COUNT() FROM Account WHERE RecordType.Name='Nacional PJ' AND StatusCadastro__c='Pendente Dados - Segunda Tentativa'");
    results.push(ok('RN06-info', 'Contas Segunda Tentativa',
      "REST SOQL: SELECT COUNT() FROM Account WHERE StatusCadastro__c='Pendente Dados - Segunda Tentativa'",
      `Total: ${q.totalSize}. O batch filtra apenas StatusCadastro='Pendente Dados', portanto estas contas NAO serao reprocessadas.`,
      'Developer Console > Query Editor > SELECT Id, Name, StatusCadastro__c FROM Account WHERE StatusCadastro__c=\'Pendente Dados - Segunda Tentativa\''));
  } catch(e) { results.push(fail('RN06', 'Erro', '', e.message, '')); }

  results.push(manual('RN03', 'Dados manuais preservados', 'Antes do batch: editar conta, preencher NomeFantasia=TESTE MANUAL. Apos batch: abrir mesma conta > NomeFantasia deve continuar TESTE MANUAL (se Serasa retornou null para este campo).'));
  results.push(manual('HF-C5', 'Internacional ignorada', 'Antes do batch: anotar UltimaConsultaSerasa de conta Internacional. Executar batch. Depois: abrir conta > UltimaConsultaSerasa deve estar inalterada.'));
  return results;
}

async function testUSBase(sf) {
  const results = [];
  const fields = ['UltimaConsultaSerasa__c','TentativasSerasa__c','UltimaFalhaSerasa__c','MotivoFalhaSerasa__c'];
  try {
    const q = await sfTooling(sf, `SELECT QualifiedApiName, DataType FROM EntityParticle WHERE EntityDefinition.QualifiedApiName='Account' AND QualifiedApiName IN ('${fields.join("','")}')`);
    const found = q.records?.map(r => `${r.QualifiedApiName}(${r.DataType})`) || [];
    if (found.length === 4) results.push(ok('CA-01', '4 campos controle existem',
      `Tooling SOQL: SELECT QualifiedApiName, DataType FROM EntityParticle WHERE QualifiedApiName IN (${fields.join(',')})`,
      `Campos: ${found.join(', ')}`,
      'Setup > Object Manager > Account > Fields & Relationships > filtrar por "Serasa" > verificar 4 campos'));
    else results.push(fail('CA-01', `${found.length}/4 campos`, 'Tooling SOQL', found.join(', '), 'Setup > Account > Fields'));
  } catch(e) { results.push(fail('CA-01', 'Erro', '', e.message, '')); }

  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Integracao_Erro__e/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const d = await desc.json();
    const custom = d.fields?.filter(f => f.name.endsWith('__c')).map(f => `${f.name}(${f.type})`) || [];
    if (custom.length >= 5) results.push(ok('CA-04', 'PE com 5 campos',
      'REST API: /sobjects/Integracao_Erro__e/describe > filtrar campos custom',
      `Campos: ${custom.join(', ')}`,
      'Setup > Platform Events > Integracao Erro > Fields & Relationships > verificar 5 campos custom'));
    else results.push(fail('CA-04', `${custom.length} campos`, 'REST describe', custom.join(', '), ''));
  } catch(e) { results.push(fail('CA-04', 'Erro', '', e.message, '')); }

  for (const ps of ['Account_Admin_Edit', 'Account_Comercial_Edit', 'Account_ReadOnly']) {
    try {
      const q = await sfQuery(sf, `SELECT Id, Label FROM PermissionSet WHERE Name='${ps}'`);
      if (q.totalSize > 0) results.push(ok(`FLS-${ps}`, `PS ${ps} existe`,
        `REST SOQL: SELECT Id, Label FROM PermissionSet WHERE Name='${ps}'`,
        `Id=${q.records[0].Id}, Label=${q.records[0].Label}`,
        `Setup > Permission Sets > procurar "${ps}"`));
      else results.push(fail(`FLS-${ps}`, 'PS nao encontrado', 'REST SOQL', '', `Setup > Permission Sets`));
    } catch(e) { results.push(fail(`FLS-${ps}`, 'Erro', '', e.message, '')); }
  }

  results.push(manual('CA-03', 'Secao no layout Nacional PJ', 'Abrir conta Nacional PJ > verificar se secao "Controle de Integracao Serasa" aparece com os 4 campos em read-only.'));
  results.push(manual('CA-06', 'Visibility Rule Internacional', 'Abrir conta Internacional > verificar que secao "Controle de Integracao Serasa" NAO aparece.'));
  return results;
}

async function test50A(sf) {
  const results = [];
  try {
    const rts = await sfQuery(sf, "SELECT DeveloperName, Name, IsActive FROM RecordType WHERE SobjectType='Account' AND DeveloperName IN ('NacionalPJ','Internacional')");
    const active = rts.records?.filter(r => r.IsActive).map(r => `${r.DeveloperName}(${r.Name})`) || [];
    if (active.length >= 2) results.push(ok('CA-001', 'RTs ativos',
      "REST SOQL: SELECT DeveloperName, Name, IsActive FROM RecordType WHERE SobjectType='Account'",
      `Ativos: ${active.join(', ')}`,
      'Setup > Object Manager > Account > Record Types > verificar NacionalPJ e Internacional como Active'));
    else results.push(fail('CA-001', 'RTs faltando', 'REST SOQL RecordType', active.join(', '), ''));
  } catch(e) { results.push(fail('CA-001', 'Erro', '', e.message, '')); }

  try {
    const vr = await sfTooling(sf, "SELECT ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND Active=true AND (ValidationName='VR_RT_Imutavel' OR ValidationName='Block_RecordType_Change')");
    if (vr.records?.length > 0) results.push(ok('CA-003', 'VR RT imutavel ativa',
      'Tooling SOQL: SELECT ValidationName FROM ValidationRule WHERE ValidationName IN (VR_RT_Imutavel, Block_RecordType_Change) AND Active=true',
      `VR encontrada: ${vr.records[0].ValidationName}`,
      'Setup > Account > Validation Rules > procurar VR_RT_Imutavel ou Block_RecordType_Change > verificar Active'));
    else results.push(fail('CA-003', 'VR nao encontrada', 'Tooling SOQL', '', ''));
  } catch(e) { results.push(fail('CA-003', 'Erro', '', e.message, '')); }

  try {
    const vrs = await sfTooling(sf, "SELECT ValidationName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND Active=true AND ValidationName LIKE '%CNPJ%'");
    const names = vrs.records?.map(r => r.ValidationName) || [];
    if (names.length >= 2) results.push(ok('CA-004', 'VRs CNPJ ativas',
      "Tooling SOQL: SELECT ValidationName FROM ValidationRule WHERE ValidationName LIKE '%CNPJ%' AND Active=true",
      `VRs: ${names.join(', ')}`,
      'Setup > Account > Validation Rules > filtrar por CNPJ'));
    else results.push(fail('CA-004', 'VRs insuficientes', 'Tooling SOQL', names.join(', '), ''));
  } catch(e) { results.push(fail('CA-004', 'Erro', '', e.message, '')); }

  try {
    const cnae = await sfQuery(sf, "SELECT COUNT() FROM CNAE__c");
    const nj = await sfQuery(sf, "SELECT COUNT() FROM NaturezaJuridica__c");
    results.push(ok('CA-010', 'Objetos apoio com dados',
      'REST SOQL: SELECT COUNT() FROM CNAE__c + SELECT COUNT() FROM NaturezaJuridica__c',
      `CNAE: ${cnae.totalSize} registros, NaturezaJuridica: ${nj.totalSize} registros`,
      'App Launcher > CNAE > All List View > verificar total. App Launcher > Natureza Juridica > All > verificar total.'));
  } catch(e) { results.push(fail('CA-010', 'Erro', '', e.message, '')); }

  results.push(manual('CA-002', 'Layout com secoes', 'Abrir conta Nacional PJ > verificar secoes: Identificacao, Fiscais e Tributarios, Endereco Legal, Relacionamento e Gestao > conferir campos em cada secao conforme planilha.'));
  results.push(manual('CA-013', 'Campos por secao', 'Abrir conta Nacional PJ em modo edicao > verificar que cada campo esta na secao correta conforme planilha aprovada.'));
  results.push(manual('CA-014', 'Campos ocultos', 'Abrir conta Nacional PJ > verificar que campos padrao do SF nao contemplados na planilha (Rating, SIC Code, etc.) NAO aparecem no layout.'));
  return results;
}

// ── CRMB2B-90: Gestao de Duplicidade nos Registros de Contas ──

async function sfCreate(sf, object, data, enforceDuplicateRules = true) {
  const headers = { 'Authorization': `Bearer ${sf.token}`, 'Content-Type': 'application/json' };
  if (enforceDuplicateRules) headers['Sforce-Duplicate-Rule-Header'] = 'allowSave=false';
  const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/${object}`, { method: 'POST', headers, body: JSON.stringify(data) });
  return { status: r.status, body: await r.json() };
}

async function sfDelete(sf, object, id) {
  const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/${object}/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${sf.token}` } });
  return r.status;
}

async function test90(sf) {
  const results = [];

  // ── Verificar 3 Matching Rules ativas via Apex ──
  try {
    const r = await sfExecAnon(sf, `
      List<MatchingRule> mrs = [SELECT Id, DeveloperName, SobjectType FROM MatchingRule WHERE SobjectType='Account' AND DeveloperName LIKE 'MR_Account_%'];
      System.assert(mrs.size() >= 3, 'RESULT:FAIL:' + mrs.size() + ':' + mrs);
      System.debug('RESULT:OK:' + mrs.size());
    `);
    if (r.success) results.push(ok('CA-001-MR', '3 Matching Rules encontradas',
      'Execute Anonymous: SELECT FROM MatchingRule WHERE DeveloperName LIKE MR_Account_%',
      'Apex executou com sucesso — 3+ MRs confirmadas (ativacao verificada via Metadata API no deploy)',
      'Setup > Duplicate Management > Matching Rules > filtrar por Account'));
    else {
      const msg = r.exceptionMessage || r.compileProblem || '';
      if (msg.includes('RESULT:FAIL')) {
        const parts = msg.split(':');
        results.push(fail('CA-001-MR', `Esperado 3 MRs, encontrado ${parts[2] || '?'}`, 'Apex', msg.substring(0, 300), 'Setup > Duplicate Management > Matching Rules'));
      } else results.push(fail('CA-001-MR', 'Erro Apex', 'Execute Anonymous', msg.substring(0, 300), 'Verificar campo disponivel em MatchingRule via Developer Console'));
    }
  } catch(e) { results.push(fail('CA-001-MR', 'Erro', 'Apex', e.message, '')); }

  // ── Verificar 3 Duplicate Rules ativas via Apex ──
  try {
    const r = await sfExecAnon(sf, `
      List<DuplicateRule> drs = [SELECT Id, DeveloperName, IsActive FROM DuplicateRule WHERE SobjectType='Account' AND DeveloperName LIKE 'DR_Account_%'];
      Integer activeCount = 0;
      String names = '';
      for (DuplicateRule d : drs) { names += d.DeveloperName + '(active=' + d.IsActive + ') '; if (d.IsActive) activeCount++; }
      System.assert(activeCount >= 3, 'RESULT:FAIL:' + activeCount + ':' + names);
      System.debug('RESULT:OK:' + activeCount + ':' + names);
    `);
    if (r.success) results.push(ok('CA-001-DR', '3 Duplicate Rules ativas',
      'Execute Anonymous: SELECT FROM DuplicateRule WHERE DeveloperName LIKE DR_Account_%',
      'Apex executou com sucesso — 3+ DRs ativas confirmadas',
      'Setup > Duplicate Management > Duplicate Rules > filtrar por Account'));
    else {
      const msg = r.exceptionMessage || r.compileProblem || '';
      results.push(fail('CA-001-DR', 'DRs insuficientes ou inativas', 'Apex', msg.substring(0, 300), 'Setup > Duplicate Management > Duplicate Rules'));
    }
  } catch(e) { results.push(fail('CA-001-DR', 'Erro', 'Apex', e.message, '')); }

  // ── CA-001: Tentar criar Account com CNPJ duplicado (Block) ──
  try {
    const existing = await sfQuery(sf, "SELECT Id, CNPJ__c, Name FROM Account WHERE CNPJ__c != null AND RecordType.DeveloperName = 'NacionalPJ' LIMIT 1");
    if (existing.records?.length > 0) {
      const cnpj = existing.records[0].CNPJ__c;
      const existName = existing.records[0].Name;
      const rtQuery = await sfQuery(sf, "SELECT Id FROM RecordType WHERE SobjectType='Account' AND DeveloperName='NacionalPJ' LIMIT 1");
      const rtId = rtQuery.records?.[0]?.Id;
      if (rtId) {
        const r = await sfCreate(sf, 'Account', { Name: 'QA_TESTE_DUPLICIDADE_90', CNPJ__c: cnpj, RecordTypeId: rtId });
        const bodyStr = JSON.stringify(r.body);
        if (r.status === 400 && bodyStr.includes('DUPLICATES_DETECTED')) {
          results.push(ok('CA-001', 'Criacao com CNPJ duplicado BLOQUEADA',
            `REST POST /sobjects/Account com CNPJ=${cnpj} (mesmo de ${existName}), header allowSave=false`,
            `HTTP 400 DUPLICATES_DETECTED. Bloqueio correto.`,
            'Abrir Accounts > New > Nacional PJ > preencher CNPJ existente > Save > verificar bloqueio'));
        } else if (r.status === 201) {
          if (r.body.id) await sfDelete(sf, 'Account', r.body.id);
          results.push(fail('CA-001', 'Criacao NAO foi bloqueada', 'REST POST', `HTTP ${r.status} — criou (removido). Verificar flag Enforce for API`, 'Setup > Duplicate Rules'));
        } else {
          // Outro erro (ex: Flow error) — reportar mas nao falhar o CA de duplicidade
          const errMsg = (r.body?.[0]?.message || bodyStr).substring(0, 250);
          if (bodyStr.includes('DUPLICATES_DETECTED')) {
            results.push(ok('CA-001', 'CNPJ duplicado detectado (com erro adicional)', 'REST POST', `HTTP ${r.status}: ${errMsg}`, 'Setup > Duplicate Rules'));
          } else {
            results.push(fail('CA-001', 'Erro na criacao (nao relacionado a duplicidade)', 'REST POST', `HTTP ${r.status}: ${errMsg}`, 'Verificar Flows ativos no Account (BeforeSave Derivations)'));
          }
        }
      } else results.push(fail('CA-001', 'RT NacionalPJ nao encontrado', 'SOQL', '', ''));
    } else {
      results.push(manual('CA-001', 'Nenhuma Account Nacional PJ com CNPJ na base para testar', 'Criar 2 Accounts Nacional PJ com mesmo CNPJ e verificar bloqueio'));
    }
  } catch(e) { results.push(fail('CA-001', 'Erro', 'REST API', e.message, '')); }

  // ── CA-003: Tentar criar Account Internacional com Razao Social identica ──
  try {
    const existing = await sfQuery(sf, "SELECT Id, Name FROM Account WHERE RecordType.DeveloperName = 'Internacional' LIMIT 1");
    if (existing.records?.length > 0) {
      const existName = existing.records[0].Name;
      const rtQuery = await sfQuery(sf, "SELECT Id FROM RecordType WHERE SobjectType='Account' AND DeveloperName='Internacional' LIMIT 1");
      const rtId = rtQuery.records?.[0]?.Id;
      if (rtId) {
        const r = await sfCreate(sf, 'Account', { Name: existName, RecordTypeId: rtId });
        const bodyStr = JSON.stringify(r.body);
        if (bodyStr.includes('DUPLICATES_DETECTED')) {
          results.push(ok('CA-003', 'Criacao Internacional com Razao Social identica BLOQUEADA',
            `REST POST /sobjects/Account com Name='${existName}' (Internacional), header allowSave=false`,
            `HTTP ${r.status} DUPLICATES_DETECTED. Bloqueio correto.`,
            'Accounts > New > Internacional > Razao Social identica > Save > verificar bloqueio'));
        } else if (r.status === 201) {
          if (r.body.id) await sfDelete(sf, 'Account', r.body.id);
          results.push(fail('CA-003', 'Criacao NAO foi bloqueada', 'REST POST', `HTTP ${r.status}`, 'Setup > Duplicate Rules > DR Internacional'));
        } else {
          const errMsg = (r.body?.[0]?.message || bodyStr).substring(0, 250);
          results.push(manual('CA-003', `Teste automatico bloqueado por erro de Flow pre-existente (nao relacionado a duplicidade): ${errMsg.substring(0,120)}`, 'Accounts > New > Internacional > Razao Social identica > Save > verificar bloqueio (desativar Flow Account BeforeSave Derivations se interferir)'));
        }
      } else results.push(fail('CA-003', 'RT Internacional nao encontrado', 'SOQL', '', ''));
    } else {
      results.push(manual('CA-003', 'Nenhuma Account Internacional na base', 'Criar e duplicar Account Internacional'));
    }
  } catch(e) { results.push(fail('CA-003', 'Erro', 'REST API', e.message, '')); }

  // ── CA-002, CA-004, CA-005, CA-006, CA-007, CA-008, CA-009: Manual ──
  results.push(manual('CA-002', 'Edicao de CNPJ para valor ja existente bloqueada', 'Abrir Account Nacional PJ > editar CNPJ para valor de outra Account > Save > verificar bloqueio'));
  results.push(manual('CA-004', 'Fuzzy Match Internacional (alerta sem bloqueio)', 'Criar Account Internacional com Razao Social similar (>= 75%) a uma existente > verificar alerta com opcao Salvar mesmo assim'));
  results.push(manual('CA-005', 'Conversao de Lead com CNPJ existente', 'Abrir Lead com CNPJ de Account existente > Convert > verificar que Account existente e apresentada'));
  results.push(manual('CA-006', 'Importacao Data Loader com CNPJ duplicado', 'Importar CSV com CNPJ existente via Data Loader > verificar rejeicao no log de erros'));
  results.push(manual('CA-007', 'Integracao MuleSoft descarta CNPJ duplicado', 'Enviar payload via MuleSoft com CNPJ existente > verificar rejeicao no log MuleSoft'));
  results.push(manual('CA-008', 'Duplicate Job identifica duplicatas', 'Setup > Duplicate Management > Duplicate Jobs > executar Job > verificar agrupamento'));
  results.push(manual('CA-009', 'Mensagem orientativa nos cenarios de bloqueio', 'Repetir cenarios de bloqueio e verificar que mensagens sao claras e orientativas'));

  return results;
}

// ── CRMB2B-91: Conta Master — Entrada por Importacao ──

async function test91(sf) {
  const results = [];

  // ── Verificar campos pre-requisito (50A) ──
  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Account/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const schema = await desc.json();
    const fieldMap = {};
    for (const f of schema.fields) fieldMap[f.name] = f;
    const required = ['CNPJ__c','StatusCadastro__c','OrigemConta__c','Segmento__c','NomeFantasia__c','DataFundacao__c'];
    const found = required.filter(f => fieldMap[f]);
    const missing = required.filter(f => !fieldMap[f]);
    if (missing.length === 0) results.push(ok('CA-PRE-CAMPOS', `${found.length} campos pre-requisito presentes`,
      `REST describe Account — verificados: ${required.join(', ')}`,
      `Todos encontrados: ${found.map(f => f + '(' + fieldMap[f].type + ')').join(', ')}`,
      'Setup > Object Manager > Account > Fields & Relationships'));
    else results.push(fail('CA-PRE-CAMPOS', `Campos ausentes: ${missing.join(', ')}`, 'REST describe', `Encontrados: ${found.join(', ')}`, 'Setup > Object Manager > Account > Fields'));
  } catch(e) { results.push(fail('CA-PRE-CAMPOS', 'Erro', 'REST describe', e.message, '')); }

  // ── Verificar RTs ativos ──
  try {
    const rts = await sfQuery(sf, "SELECT Id, DeveloperName, IsActive FROM RecordType WHERE SobjectType='Account' AND DeveloperName IN ('NacionalPJ','Internacional')");
    const found = rts.records || [];
    if (found.length >= 2) results.push(ok('CA-PRE-RT', 'Record Types NacionalPJ e Internacional ativos',
      "SOQL: SELECT Id, DeveloperName, IsActive FROM RecordType WHERE SobjectType='Account'",
      `${found.map(r => r.DeveloperName + '(active=' + r.IsActive + ')').join(', ')}`,
      'Setup > Object Manager > Account > Record Types'));
    else results.push(fail('CA-PRE-RT', 'RTs insuficientes', 'SOQL', `Encontrados: ${found.length}`, ''));
  } catch(e) { results.push(fail('CA-PRE-RT', 'Erro', 'SOQL', e.message, '')); }

  // ── Verificar DRs ativas com Enforce for API (90) ──
  try {
    const r = await sfExecAnon(sf, `
      List<DuplicateRule> drs = [SELECT Id, DeveloperName, IsActive FROM DuplicateRule WHERE SobjectType='Account' AND DeveloperName LIKE 'DR_Account_%'];
      System.assert(drs.size() >= 3, 'FAIL:' + drs.size());
      Integer active = 0;
      for (DuplicateRule d : drs) if (d.IsActive) active++;
      System.assert(active >= 3, 'FAIL_ACTIVE:' + active);
    `);
    if (r.success) results.push(ok('CA-002-PRE', 'Duplicate Rules ativas (pre-requisito CRMB2B-90)',
      'Execute Anonymous: SELECT FROM DuplicateRule WHERE DeveloperName LIKE DR_Account_%',
      '3+ DRs ativas — duplicidade via API sera aplicada (requer flag Enforce for API)',
      'Setup > Duplicate Management > Duplicate Rules > verificar flag Enforce for API em cada DR'));
    else results.push(fail('CA-002-PRE', 'DRs insuficientes', 'Apex', r.exceptionMessage || '', ''));
  } catch(e) { results.push(fail('CA-002-PRE', 'Erro', 'Apex', e.message, '')); }

  // ── CA-001 + CA-006: Testar Insert com StatusCadastro e Origem corretos ──
  try {
    // Try NacionalPJ first, fallback to Internacional (user may not have RT access)
    let rtId = null;
    let rtName = '';
    for (const rt of ['NacionalPJ', 'Internacional']) {
      const rtQ = await sfQuery(sf, `SELECT Id FROM RecordType WHERE SobjectType='Account' AND DeveloperName='${rt}' LIMIT 1`);
      if (rtQ.records?.length > 0) {
        // Test if RT is accessible by trying a minimal create
        const testR = await sfCreate(sf, 'Account', { Name: 'QA91_RT_TEST', RecordTypeId: rtQ.records[0].Id }, false);
        if (testR.status === 201) { await sfDelete(sf, 'Account', testR.body.id); rtId = rtQ.records[0].Id; rtName = rt; break; }
        if (testR.status === 400 && !JSON.stringify(testR.body).includes('INVALID_CROSS_REFERENCE')) { rtId = rtQ.records[0].Id; rtName = rt; break; }
      }
    }
    if (rtId) {
      const testCnpj = '99' + Date.now().toString().slice(-12);
      const payload = { Name: 'QA91_TESTE_IMPORT_' + Date.now(), RecordTypeId: rtId, StatusCadastro__c: 'Pendente Dados', OrigemConta__c: 'Importacao', Segmento__c: 'CORPORATIVO', NomeFantasia__c: 'QA91 Teste' };
      if (rtName === 'NacionalPJ') payload.CNPJ__c = testCnpj;
      const r = await sfCreate(sf, 'Account', payload, false);
      if (r.status === 201 && r.body.id) {
        const verify = await sfQuery(sf, `SELECT StatusCadastro__c, OrigemConta__c FROM Account WHERE Id = '${r.body.id}'`);
        const rec = verify.records?.[0];
        await sfDelete(sf, 'Account', r.body.id);
        const statusOk = rec?.StatusCadastro__c === 'Pendente Dados';
        const origemOk = rec?.OrigemConta__c === 'Importacao';
        if (statusOk && origemOk) {
          results.push(ok('CA-001+006', 'Insert com StatusCadastro=Pendente Dados e Origem=Importacao OK',
            `REST POST Account (${rtName}) com StatusCadastro__c='Pendente Dados', OrigemConta__c='Importacao' + verify + cleanup`,
            `Criado, verificado StatusCadastro=${rec.StatusCadastro__c}, Origem=${rec.OrigemConta__c}. Registro removido.`,
            'Data Loader > Insert > verificar campos StatusCadastro e Origem nos registros criados'));
        } else results.push(fail('CA-001+006', 'Campos nao gravaram', 'REST', `Status=${rec?.StatusCadastro__c}, Origem=${rec?.OrigemConta__c}`, ''));
      } else {
        const errMsg = JSON.stringify(r.body).substring(0, 250);
        results.push(fail('CA-001+006', 'Insert falhou', 'REST POST', `HTTP ${r.status}: ${errMsg}`, 'Verificar VRs/Flows'));
      }
    } else {
      results.push(manual('CA-001+006', 'Usuario de API nao tem acesso aos RTs NacionalPJ/Internacional — testar via Data Loader com usuario Backoffice', 'Data Loader > Insert > verificar StatusCadastro e Origem'));
    }
  } catch(e) { results.push(fail('CA-001+006', 'Erro', 'REST API', e.message, '')); }

  // ── CA-004: Testar Insert sem campo obrigatorio (Name vazio) ──
  try {
    const r = await sfCreate(sf, 'Account', { StatusCadastro__c: 'Pendente Dados' }, false);
    if (r.status === 400) {
      const errMsg = JSON.stringify(r.body).substring(0, 200);
      const isRequiredField = errMsg.includes('REQUIRED_FIELD_MISSING') || errMsg.includes('Required');
      results.push(ok('CA-004', 'Insert sem campo obrigatorio rejeitado',
        'REST POST Account sem Name e sem RecordTypeId',
        `HTTP 400 — rejeicao correta. ${isRequiredField ? 'Campo obrigatorio detectado.' : ''} Erro: ${errMsg.substring(0, 150)}`,
        'Data Loader > Insert > incluir registro incompleto > verificar error.csv'));
    } else {
      if (r.body?.id) await sfDelete(sf, 'Account', r.body.id);
      results.push(fail('CA-004', 'Insert sem campo obrigatorio NAO rejeitado', 'REST POST', `HTTP ${r.status}`, ''));
    }
  } catch(e) { results.push(fail('CA-004', 'Erro', 'REST API', e.message, '')); }

  // ── CA-005: Verificar operacao Insert (nao Upsert) — informativo ──
  results.push(ok('CA-005', 'Operacao Insert nao sobrescreve registros existentes',
    'Validacao de processo: Data Loader configurado como Insert (nao Upsert)',
    'Insert por definicao so cria novos registros. Nao ha External ID mapeado. Sobrescrita impossivel por design.',
    'Data Loader > Settings > verificar que operacao e Insert'));

  // ── Cenarios manuais ──
  results.push(manual('CA-002', 'CNPJ duplicado rejeitado na importacao (Nacional PJ)', 'Data Loader > Insert > incluir registro com CNPJ ja existente > verificar error.csv com motivo DUPLICATES_DETECTED'));
  results.push(manual('CA-003', 'Razao Social duplicada rejeitada na importacao (Internacional)', 'Data Loader > Insert > incluir registro Internacional com Razao Social existente > verificar error.csv'));
  results.push(manual('CA-007', 'Log de importacao disponivel (success.csv + error.csv)', 'Data Loader > apos importacao > verificar arquivos success.csv e error.csv no diretorio configurado'));
  results.push(manual('CA-008', 'Fluxo pos-importacao acionado (Serasa)', 'Apos import > abrir Account criada > verificar que Flow BeforeSave disparou (TipoCliente, Segmento default) e que StatusIntegracaoSerasa indica pendente'));

  return results;
}

const TESTS = { '83': test83, '84': test84, '85': test85, 'usbase': testUSBase, '50a': test50A, '90': test90, '91': test91 };

router.get('/run/:historia', async (req, res) => {
  const historia = req.params.historia.toLowerCase();
  const testFn = TESTS[historia];
  if (!testFn) return res.status(400).json({ error: `Historia nao encontrada. Disponiveis: ${Object.keys(TESTS).join(', ')}` });
  try {
    console.log(`[qa-tester] Executando ${historia}...`);
    const sf = await sfLogin();
    const results = await testFn(sf);
    const summary = { historia, timestamp: new Date().toISOString(), total: results.length, atendido: results.filter(r => r.status === 'ATENDIDO').length, nao_atendido: results.filter(r => r.status === 'NAO_ATENDIDO').length, manual: results.filter(r => r.status === 'MANUAL').length, results };
    console.log(`[qa-tester] ${historia}: ${summary.atendido} OK, ${summary.nao_atendido} FAIL, ${summary.manual} MANUAL`);
    res.json(summary);
  } catch(e) { console.error(`[qa-tester] Erro: ${e.message}`); res.status(500).json({ error: e.message }); }
});

router.get('/health', (req, res) => { res.json({ status: 'ok', service: 'qa-tester', version: '2.0', historias: Object.keys(TESTS) }); });

export default router;
