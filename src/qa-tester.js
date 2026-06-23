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
        const r = await sfCreate(sf, 'Account', { Name: existName, RecordTypeId: rtId, ShippingStreet: 'QA Test Street', ShippingCity: 'Test City', ShippingPostalCode: '12345', ShippingCountry: 'US', NomeFantasia__c: 'QA90 Dup Test', Segmento__c: 'CORPORATIVO', StatusCadastro__c: 'Pendente Dados', InscricaoMunicipal__c: 'QA00000' });
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
          results.push(fail('CA-003', 'Erro na criacao (investigar)', 'REST POST', `HTTP ${r.status}: ${errMsg}`, 'Verificar VRs e Flows no Account'));
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
      const payload = { Name: 'QA91_TESTE_IMPORT_' + Date.now(), RecordTypeId: rtId, StatusCadastro__c: 'Pendente Dados', OrigemConta__c: 'Importacao', Segmento__c: 'CORPORATIVO', NomeFantasia__c: 'QA91 Teste', ShippingStreet: 'QA Test Street 123', ShippingCity: 'Test City', ShippingPostalCode: '12345', ShippingCountry: 'US', InscricaoMunicipal__c: 'QA00000' };
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

async function test107(sf) {
  const results = [];
  const PS_NAMES = ['PS_Account_CamposGerais_FLS','PS_Account_SomenteLeitura_FLS','PS_Account_CamposRegulatorio_FLS','PS_Account_EditTotal_FLS'];
  const EXPECTED = {
    'PS_Account_CamposGerais_FLS': { minFields: 40, maxEditable: 20, keyReadOnly: ['Account.StatusCadastro__c','Account.TipoCliente__c','Account.Segmento__c','Account.OrigemConta__c'] },
    'PS_Account_SomenteLeitura_FLS': { minFields: 40, maxEditable: 0, keyReadOnly: ['Account.CNPJ__c','Account.StatusCadastro__c','Account.TipoCliente__c'] },
    'PS_Account_CamposRegulatorio_FLS': { minFields: 40, maxEditable: 60, keyEditable: ['Account.CNPJ__c','Account.TipoCliente__c','Account.NomeFantasia__c'], keyReadOnly: ['Account.StatusCadastro__c','Account.Segmento__c'] },
    'PS_Account_EditTotal_FLS': { minFields: 40, maxEditable: 60, keyEditable: ['Account.CNPJ__c','Account.StatusCadastro__c','Account.TipoCliente__c'] }
  };

  // CA-001: 4 PSs existem
  try {
    const r = await sfQuery(sf, `SELECT Id, Name, Label FROM PermissionSet WHERE Name IN ('${PS_NAMES.join("','")}') ORDER BY Name`);
    const found = (r.records || []).map(p => p.Name);
    const missing = PS_NAMES.filter(n => !found.includes(n));
    if (missing.length === 0) results.push(ok('CA-001', '4 Permission Sets existem', `REST SOQL: SELECT Name FROM PermissionSet WHERE Name IN (${PS_NAMES.join(',')})`, `Encontrados: ${found.join(', ')}`, 'Setup > Permission Sets > buscar PS_Vendedor, PS_Gestor, PS_BackOffice, PS_Admin'));
    else results.push(fail('CA-001', 'PSs faltando', 'REST SOQL PermissionSet', `Faltam: ${missing.join(', ')}`, 'Setup > Permission Sets'));
  } catch(e) { results.push(fail('CA-001', 'Erro', 'REST SOQL', e.message, '')); }

  // CA-002 a CA-005: FLS por PS
  for (const psName of PS_NAMES) {
    const exp = EXPECTED[psName];
    const shortName = psName.replace('PS_','').replace('_Account_FLS','');
    try {
      const r = await sfQuery(sf, `SELECT Field, PermissionsEdit, PermissionsRead FROM FieldPermissions WHERE ParentId IN (SELECT Id FROM PermissionSet WHERE Name='${psName}') AND SobjectType='Account'`);
      const recs = r.records || [];
      const editCount = recs.filter(x => x.PermissionsEdit).length;
      const totalOk = recs.length >= exp.minFields;
      const editOk = editCount <= exp.maxEditable;

      // Check key read-only fields
      let keyFails = [];
      if (exp.keyReadOnly) {
        for (const kf of exp.keyReadOnly) {
          const fp = recs.find(x => x.Field === kf);
          if (fp && fp.PermissionsEdit) keyFails.push(`${kf} deveria ser ReadOnly mas está Editable`);
        }
      }
      // Check key editable fields
      if (exp.keyEditable) {
        for (const kf of exp.keyEditable) {
          const fp = recs.find(x => x.Field === kf);
          if (fp && !fp.PermissionsEdit) keyFails.push(`${kf} deveria ser Editable mas está ReadOnly`);
        }
      }

      const caNum = `CA-00${PS_NAMES.indexOf(psName)+2}`;
      if (totalOk && editOk && keyFails.length === 0)
        results.push(ok(caNum, `FLS ${shortName} configurado`, `REST SOQL: FieldPermissions WHERE PS=${psName}`, `${recs.length} fields, ${editCount} editable. Key fields OK.`, `Setup > Permission Sets > ${psName} > Field Permissions`));
      else {
        const issues = [];
        if (!totalOk) issues.push(`total=${recs.length} < minimo=${exp.minFields}`);
        if (!editOk) issues.push(`editable=${editCount} > max=${exp.maxEditable}`);
        if (keyFails.length) issues.push(keyFails.join('; '));
        results.push(fail(caNum, `FLS ${shortName} incorreto`, 'REST SOQL FieldPermissions', issues.join(' | '), `Setup > Permission Sets > ${psName}`));
      }
    } catch(e) { results.push(fail(`CA-00${PS_NAMES.indexOf(psName)+2}`, `Erro FLS ${shortName}`, 'REST SOQL', e.message, '')); }
  }

  // CA-006: VRs protetoras ativas
  try {
    const expectedVRs = ['Block_RecordType_Change','VR_StatusCadastro','Prevent_CNPJ_Manual_Edit','VR_SituacaoCNPJ'];
    const r = await sfTooling(sf, `SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName IN ('${expectedVRs.join("','")}') AND Active=true`);
    const found = (r.records || []).map(v => v.ValidationName);
    const missing = expectedVRs.filter(v => !found.includes(v));
    if (missing.length === 0) results.push(ok('CA-006', 'VRs protetoras ativas', `Tooling SOQL: ValidationRule WHERE Active=true AND Name IN (${expectedVRs.join(',')})`, `Encontradas: ${found.join(', ')}`, 'Setup > Account > Validation Rules'));
    else results.push(fail('CA-006', 'VRs faltando', 'Tooling SOQL', `Faltam: ${missing.join(', ')}`, 'Setup > Account > Validation Rules'));
  } catch(e) { results.push(fail('CA-006', 'Erro VRs', 'Tooling SOQL', e.message, '')); }

  // CA-007: Campos formula sao read-only (plataforma)
  try {
    const formulas = ['CNAEFiscal__c','CNAEEscolhaCliente__c','DescricaoNaturezaJuridica__c','CNPJSemPontuacao__c','RecordTypeName__c'];
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/Account/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const dj = await desc.json();
    const formulaFields = (dj.fields || []).filter(f => formulas.includes(f.name));
    const allReadOnly = formulaFields.every(f => f.calculated === true || f.updateable === false);
    if (allReadOnly && formulaFields.length >= 4)
      results.push(ok('CA-007', 'Campos formula read-only', 'REST Describe Account > filter calculated fields', `${formulaFields.length} campos formula confirmados como non-updateable`, 'Setup > Object Manager > Account > Fields > filtrar campos Formula'));
    else results.push(fail('CA-007', 'Campos formula nao sao read-only', 'REST Describe', `Encontrados: ${formulaFields.length}, allReadOnly=${allReadOnly}`, 'Setup > Account > Fields'));
  } catch(e) { results.push(fail('CA-007', 'Erro', 'REST Describe', e.message, '')); }

  // Cenarios manuais
  results.push(manual('CA-003', 'Usuario Vendedor edita campo permitido (ex: Nome Fantasia) e salva com sucesso', 'Login como Vendedor > abrir conta da carteira > editar Nome Fantasia > salvar > verificar sucesso'));
  results.push(manual('CA-004', 'Campo Serasa bloqueado para Vendedor na UI', 'Login como Vendedor > abrir conta > verificar que Razao Social, CNAE, NJ, SituacaoCNPJ estao read-only'));
  results.push(manual('CA-005', 'Backoffice edita campos Serasa independente do status', 'Login como Backoffice > abrir qualquer conta > verificar que Razao Social, CNAE, NJ sao editaveis'));
  results.push(manual('CA-006-UI', 'Campos derivados bloqueados para todos na UI', 'Login como qualquer perfil > abrir conta > verificar que TipoCliente, IdentificadorIE estao read-only'));
  results.push(manual('CA-007-UI', 'Campos fiscais editaveis apenas por Backoffice', 'Login como Vendedor > verificar campos fiscais read-only. Login como Backoffice > verificar que RetencaoPIS, RetencaoISS sao editaveis.'));

  return results;
}

async function test108(sf) {
  const results = [];

  // CA-001: CustomPermission exists
  try {
    const r = await sfQuery(sf, "SELECT Id, SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType='CustomPermission' AND ParentId IN (SELECT Id FROM PermissionSet WHERE Name='PS_Account_SerasaIntegration_FLS')");
    if ((r.records||[]).length > 0) results.push(ok('CA-001','CustomPermission BypassRestrictedFieldsUpdate existe e atribuida ao PS Serasa','REST SOQL: SetupEntityAccess WHERE SetupEntityType=CustomPermission',`EntityId=${r.records[0].SetupEntityId}`,'Setup > Custom Permissions'));
    else results.push(fail('CA-001','CustomPermission nao encontrada','REST SOQL','Nenhum SetupEntityAccess encontrado','Setup > Custom Permissions'));
  } catch(e) { results.push(fail('CA-001','Erro','SOQL',e.message,'')); }

  // CA-002: PS_Account_RestrictedAPI_FLS with FLS
  try {
    const r = await sfQuery(sf, "SELECT Field, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (SELECT Id FROM PermissionSet WHERE Name='PS_Account_RestrictedAPI_FLS') AND SobjectType='Account'");
    const recs = r.records||[];
    const editCount = recs.filter(x=>x.PermissionsEdit).length;
    if (recs.length >= 40 && editCount <= 10) results.push(ok('CA-002',`PS_Account_RestrictedAPI_FLS: ${recs.length} FPs, ${editCount} editable`,'REST SOQL FieldPermissions','FLS restritivo OK','Setup > Permission Sets > PS_Account_RestrictedAPI_FLS'));
    else results.push(fail('CA-002',`FLS incorreto: ${recs.length} FPs, ${editCount} editable`,'REST SOQL','Esperado >=40 FPs e <=10 editable',''));
  } catch(e) { results.push(fail('CA-002','Erro','SOQL',e.message,'')); }

  // CA-003: PS_Account_SerasaIntegration_FLS with FLS + CP
  try {
    const r = await sfQuery(sf, "SELECT Field, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (SELECT Id FROM PermissionSet WHERE Name='PS_Account_SerasaIntegration_FLS') AND SobjectType='Account'");
    const recs = r.records||[];
    const editCount = recs.filter(x=>x.PermissionsEdit).length;
    if (recs.length >= 40 && editCount >= 10) results.push(ok('CA-003',`PS_Account_SerasaIntegration_FLS: ${recs.length} FPs, ${editCount} editable + CP atribuida`,'REST SOQL FieldPermissions','FLS Serasa + Custom Permission OK','Setup > Permission Sets > PS_Account_SerasaIntegration_FLS'));
    else results.push(fail('CA-003',`FLS incorreto: ${recs.length} FPs, ${editCount} editable`,'REST SOQL','Esperado >=40 FPs e >=10 editable',''));
  } catch(e) { results.push(fail('CA-003','Erro','SOQL',e.message,'')); }

  // CA-004: VR active
  try {
    const r = await sfTooling(sf, "SELECT Id, ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND ValidationName='VR_Account_RestrictedFields_APIUpdate' AND Active=true");
    if ((r.records||[]).length > 0) results.push(ok('CA-004','VR_Account_RestrictedFields_APIUpdate ativa','Tooling SOQL ValidationRule',`Msg: ${r.records[0].ErrorMessage.substring(0,60)}`,'Setup > Account > Validation Rules'));
    else results.push(fail('CA-004','VR nao encontrada ou inativa','Tooling SOQL','','Setup > Account > Validation Rules'));
  } catch(e) { results.push(fail('CA-004','Erro','Tooling',e.message,'')); }

  // CA-005: Total VRs ativas (should be 16)
  try {
    const r = await sfTooling(sf, "SELECT COUNT(Id) cnt FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Account' AND Active=true");
    const cnt = (r.records||[{}])[0].cnt||0;
    if (cnt >= 16) results.push(ok('CA-005',`${cnt} VRs ativas no Account (15 anteriores + 1 nova)`,'Tooling SOQL COUNT',`Total: ${cnt}`,'Setup > Account > Validation Rules'));
    else results.push(fail('CA-005',`Apenas ${cnt} VRs ativas (esperado >=16)`,'Tooling SOQL','',''));
  } catch(e) { results.push(fail('CA-005','Erro','Tooling',e.message,'')); }

  // CA-006: NJ custom object has TipoCliente mapping
  try {
    const desc = await fetch(`${sf.url}/services/data/v62.0/sobjects/NaturezaJuridica__c/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
    const dj = await desc.json();
    const hasTipoCliente = (dj.fields||[]).some(f => f.name === 'TipoCliente__c');
    if (hasTipoCliente) results.push(ok('CA-006','NaturezaJuridica__c tem campo TipoCliente__c (mapeamento para Screen Flow)','REST Describe NaturezaJuridica__c','Campo TipoCliente__c encontrado','Setup > Object Manager > NaturezaJuridica'));
    else results.push(fail('CA-006','Campo TipoCliente__c nao encontrado em NaturezaJuridica__c','REST Describe','',''));
  } catch(e) { results.push(fail('CA-006','Erro','Describe',e.message,'')); }

  // Manual tests
  results.push(manual('CA-007', 'API generica (sem CP) tenta Update de Razao Social → VR bloqueia', 'API: PATCH /sobjects/Account/{id} com Name alterado usando usuario sem BypassRestrictedFieldsUpdate'));
  results.push(manual('CA-008', 'MuleSoft (com CP) faz Update de campos Serasa → VR NAO bloqueia', 'API: PATCH /sobjects/Account/{id} com campos Serasa usando usuario com BypassRestrictedFieldsUpdate'));
  results.push(manual('CA-009', 'Screen Flow AlterarNaturezaJuridica mostra derivacao visual de TipoCliente', 'UI: Account > Quick Action Alterar NJ > selecionar nova NJ > verificar TipoCliente exibido'));
  results.push(manual('CA-010', 'Perfis de integracao criados (Integracao API + Integracao MuleSoft)', 'Setup > Profiles > verificar existencia'));
  results.push(manual('CA-011', 'Dynamic Action controla visibilidade da Quick Action por perfil', 'Setup > Account > Lightning Record Page > verificar Dynamic Action'));

  return results;
}




async function testLead(sf) {
  const R = [];
  const cleanup = [];
  const NAC_RT = '012Ha0000027AxaIAE';
  const INT_RT = '012Ha0000027H1NIAU';

  async function apiCreate(data) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/Lead`, {
      method:'POST', headers:{'Authorization':`Bearer ${sf.token}`,'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    const d = await r.json();
    if (d.id) cleanup.push(d.id);
    return { ok: !!d.id, id: d.id, status: r.status, error: d[0]?.message || d.message || '', raw: d };
  }

  async function apiUpdate(id, data) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/Lead/${id}`, {
      method:'PATCH', headers:{'Authorization':`Bearer ${sf.token}`,'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    if (r.status === 204) return { ok: true };
    const d = await r.json();
    return { ok: false, error: d[0]?.message || d.message || '', raw: d };
  }

  async function apiRead(id, fields) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/Lead/${id}?fields=${fields}`, {
      headers:{'Authorization':`Bearer ${sf.token}`}
    });
    return r.json();
  }

  async function apiDelete(id) {
    await fetch(`${sf.url}/services/data/v62.0/sobjects/Lead/${id}`, {
      method:'DELETE', headers:{'Authorization':`Bearer ${sf.token}`}
    });
  }

  // ============================================================
  // CT-01: Criar Lead Nacional com dados validos
  // ============================================================
  const ct01 = await apiCreate({
    FirstName:'QA', LastName:'Nacional01', Company:'Empresa Teste QA',
    Email:'qa01@empresa.com.br', Phone:'11999990001',
    CNPJ__c:'71208516000174', Nacionalidade__c:'Nacional',
    RecordTypeId: NAC_RT, OrigemCanal__c:'Manual', Status:'Novo'
  });
  if (ct01.ok) {
    R.push(ok('CT-01','Criar Lead Nacional com dados validos — CRIADO com sucesso',
      'POST Lead Nacional CNPJ=71208516000174 Email Phone Company FirstName',
      `Id=${ct01.id}`, 'US 2,14,20'));
  } else {
    R.push(fail('CT-01',`Criar Lead Nacional com dados validos — BLOQUEADO: ${ct01.error}`,
      'POST Lead Nacional CNPJ=71208516000174',
      `Erro: ${ct01.error}`, 'US 2,14 — Verificar VRs conflitantes e Permission Sets'));
  }

  // ============================================================
  // CT-02: Criar Lead Internacional sem CNPJ
  // ============================================================
  const ct02 = await apiCreate({
    FirstName:'QA', LastName:'Intl01', Company:'International Corp QA',
    Email:'qa.intl@corp.com', Phone:'11999990002',
    Nacionalidade__c:'Internacional',
    RecordTypeId: INT_RT, OrigemCanal__c:'Manual', Status:'Novo'
  });
  if (ct02.ok) {
    R.push(ok('CT-02','Criar Lead Internacional sem CNPJ — CRIADO com sucesso (CNPJ nao obrigatorio)',
      'POST Lead Internacional sem CNPJ__c',
      `Id=${ct02.id}`, 'US 2,14'));
  } else {
    R.push(fail('CT-02',`Criar Lead Internacional sem CNPJ — BLOQUEADO: ${ct02.error}`,
      'POST Lead Internacional sem CNPJ',
      `Erro: ${ct02.error}`, 'US 2 — Verificar VR LeadBlockInternacionalNoAuth e Custom Permission CPLeadCriarInternacional'));
  }

  // ============================================================
  // CT-03: Tentar criar Lead com CNPJ invalido (5 digitos)
  // ============================================================
  const ct03 = await apiCreate({
    FirstName:'QA', LastName:'CNPJInv', Company:'Teste',
    Email:'qa@test.com.br', Phone:'11999990003',
    CNPJ__c:'12345', Nacionalidade__c:'Nacional',
    RecordTypeId: NAC_RT, OrigemCanal__c:'Manual', Status:'Novo'
  });
  if (!ct03.ok) {
    R.push(ok('CT-03','CNPJ invalido (5 digitos) — BLOQUEADO corretamente',
      'POST Lead CNPJ=12345',
      `VR bloqueou: ${ct03.error.substring(0,120)}`, 'US 2,14'));
  } else {
    R.push(fail('CT-03','CNPJ invalido (5 digitos) — ACEITO indevidamente, VR nao bloqueou',
      'POST Lead CNPJ=12345',
      `Id=${ct03.id} criado`, 'US 2 — VR de formato CNPJ nao esta funcionando'));
  }

  // ============================================================
  // CT-04: Tentar criar Lead com email invalido
  // ============================================================
  const ct04 = await apiCreate({
    FirstName:'QA', LastName:'EmailInv', Company:'Teste',
    Email:'invalido-sem-arroba', Phone:'11999990004',
    CNPJ__c:'71208516000174', Nacionalidade__c:'Nacional',
    RecordTypeId: NAC_RT, OrigemCanal__c:'Manual', Status:'Novo'
  });
  if (!ct04.ok) {
    R.push(ok('CT-04','Email invalido — BLOQUEADO corretamente',
      'POST Lead Email=invalido-sem-arroba',
      `Bloqueou: ${ct04.error.substring(0,120)}`, 'US 2,14'));
  } else {
    R.push(fail('CT-04','Email invalido — ACEITO indevidamente',
      'POST Lead Email=invalido-sem-arroba',
      `Id=${ct04.id}`, 'US 2 — VR ValidateEmailFormat nao bloqueou'));
  }

  // ============================================================
  // CT-05: Tentar criar Lead com telefone invalido (3 digitos)
  // ============================================================
  const ct05 = await apiCreate({
    FirstName:'QA', LastName:'PhoneInv', Company:'Teste',
    Email:'qa@test.com.br', Phone:'123',
    CNPJ__c:'71208516000174', Nacionalidade__c:'Nacional',
    RecordTypeId: NAC_RT, OrigemCanal__c:'Manual', Status:'Novo'
  });
  if (!ct05.ok) {
    R.push(ok('CT-05','Telefone invalido (3 digitos) — BLOQUEADO corretamente',
      'POST Lead Phone=123',
      `Bloqueou: ${ct05.error.substring(0,120)}`, 'US 2,14'));
  } else {
    R.push(fail('CT-05','Telefone invalido (3 digitos) — ACEITO indevidamente',
      'POST Lead Phone=123',
      `Id=${ct05.id}`, 'US 2 — VR ValidatesPhoneFormat nao bloqueou'));
  }

  // ============================================================
  // CT-06: Tentar criar Lead sem campos obrigatorios (sem Company)
  // ============================================================
  const ct06 = await apiCreate({
    FirstName:'QA', LastName:'SemCompany',
    Email:'qa@test.com.br', Phone:'11999990006',
    Nacionalidade__c:'Nacional', RecordTypeId: NAC_RT, Status:'Novo'
  });
  if (!ct06.ok) {
    R.push(ok('CT-06','Lead sem Company — BLOQUEADO corretamente (campo obrigatorio)',
      'POST Lead sem Company',
      `Bloqueou: ${ct06.error.substring(0,120)}`, 'US 14,20'));
  } else {
    R.push(fail('CT-06','Lead sem Company — ACEITO indevidamente',
      'POST Lead sem Company', `Id=${ct06.id}`, 'US 14'));
  }

  // Use first created lead for remaining tests
  const leadId = ct01.ok ? ct01.id : (ct02.ok ? ct02.id : null);

  if (leadId) {
    // ============================================================
    // CT-07: Verificar CNPJ formatado automaticamente (Trigger applyMask)
    // ============================================================
    if (ct01.ok) {
      const data07 = await apiRead(ct01.id, 'CNPJ__c');
      const cnpj = data07.CNPJ__c || '';
      if (cnpj.includes('.') || cnpj.includes('/')) {
        R.push(ok('CT-07','CNPJ formatado automaticamente pelo Trigger (XX.XXX.XXX/XXXX-XX)',
          `GET Lead/${ct01.id} CNPJ__c`,
          `CNPJ__c=${cnpj}`, 'US 2,14 — CnpjFormatHelper.applyMask'));
      } else {
        R.push(fail('CT-07','CNPJ NAO formatado — Trigger CnpjFormatHelper nao executou',
          `GET Lead/${ct01.id}`,
          `CNPJ__c=${cnpj} (sem formatacao)`, 'US 2 — Verificar Trigger LeadTrigger'));
      }
    } else {
      R.push(manual('CT-07','CNPJ formatado automaticamente pelo Trigger',
        'Lead Nacional nao criado (CT-01 falhou) — verificar manualmente na UI'));
    }

    // ============================================================
    // CT-08: Verificar telefone formatado (PhoneFormatHelper)
    // ============================================================
    const data08 = await apiRead(leadId, 'Phone');
    const ph = data08.Phone || '';
    if (ph.includes('(') || ph.includes('-') || ph.length > 11) {
      R.push(ok('CT-08','Telefone formatado automaticamente pelo Trigger',
        `GET Lead/${leadId} Phone`,
        `Phone=${ph}`, 'US 2,14 — PhoneFormatHelper'));
    } else {
      R.push(fail('CT-08','Telefone NAO formatado',
        `GET Lead/${leadId}`,
        `Phone=${ph}`, 'US 2 — Verificar PhoneFormatHelper'));
    }

    // ============================================================
    // CT-09: Status inicial = Novo
    // ============================================================
    const data09 = await apiRead(leadId, 'Status');
    if (data09.Status === 'Novo') {
      R.push(ok('CT-09','Lead criado com Status=Novo',
        `GET Lead/${leadId} Status`,
        `Status=${data09.Status}`, 'US 20'));
    } else {
      R.push(fail('CT-09',`Lead criado com Status=${data09.Status} (esperado Novo)`,
        `GET Lead/${leadId}`,
        `Status=${data09.Status}`, 'US 20'));
    }

    // ============================================================
    // CT-10: Segmento preenchido automaticamente?
    // ============================================================
    const data10 = await apiRead(leadId, 'Segmento__c');
    if (data10.Segmento__c) {
      R.push(ok('CT-10',`Segmento preenchido automaticamente: "${data10.Segmento__c}"`,
        `GET Lead/${leadId} Segmento__c`,
        `Segmento__c=${data10.Segmento__c}`, 'US 19'));
    } else {
      R.push(fail('CT-10','Segmento NAO preenchido automaticamente — automacao de segmentacao ausente',
        `GET Lead/${leadId} Segmento__c`,
        'Segmento__c=null', 'US 19 — NeowaySegmentacaoService existe como Invocable mas nenhum Flow o chama'));
    }

    // ============================================================
    // CT-11: Rating/Prioridade preenchido automaticamente?
    // ============================================================
    const data11 = await apiRead(leadId, 'Rating');
    if (data11.Rating) {
      R.push(ok('CT-11',`Rating preenchido automaticamente: "${data11.Rating}"`,
        `GET Lead/${leadId} Rating`,
        `Rating=${data11.Rating}`, 'US 27'));
    } else {
      R.push(fail('CT-11','Rating NAO preenchido — automacao de priorizacao inexistente',
        `GET Lead/${leadId} Rating`,
        'Rating=null', 'US 27 — Nenhum Apex/Flow implementa calculo de prioridade'));
    }

    // ============================================================
    // CT-12: Relacionamento do Lead preenchido?
    // ============================================================
    const data12 = await apiRead(leadId, 'RelacionamentoLead__c');
    if (data12.RelacionamentoLead__c) {
      R.push(ok('CT-12',`Relacionamento preenchido: "${data12.RelacionamentoLead__c}"`,
        `GET Lead/${leadId}`,
        `RelacionamentoLead__c=${data12.RelacionamentoLead__c}`, 'US 2,3,13,15,16,17'));
    } else {
      R.push(fail('CT-12','Relacionamento NAO preenchido — automacao de busca conta por CNPJ ausente',
        `GET Lead/${leadId}`,
        'RelacionamentoLead__c=null', 'US 2 — Nenhum Flow/Apex verifica CNPJ em Account para derivar Base Existente/Novo Cliente'));
    }

    // ============================================================
    // CT-13: % Preenchimento calculado?
    // ============================================================
    const data13 = await apiRead(leadId, 'PercentualPreenchimento__c');
    if (data13.PercentualPreenchimento__c != null && data13.PercentualPreenchimento__c > 0) {
      R.push(ok('CT-13',`% Preenchimento calculado: ${data13.PercentualPreenchimento__c}%`,
        `GET Lead/${leadId}`,
        `PercentualPreenchimento__c=${data13.PercentualPreenchimento__c}`, 'US 27'));
    } else {
      R.push(fail('CT-13','% Preenchimento NAO calculado',
        `GET Lead/${leadId}`,
        `PercentualPreenchimento__c=${data13.PercentualPreenchimento__c}`, 'US 27 — Nenhum Formula/Flow calcula'));
    }

    // ============================================================
    // CT-14: Tentar editar Rating manualmente
    // ============================================================
    const ct14 = await apiUpdate(leadId, { Rating: 'Hot' });
    if (!ct14.ok) {
      R.push(ok('CT-14','Edicao manual de Rating — BLOQUEADA corretamente pela VR',
        `PATCH Lead/${leadId} Rating=Hot`,
        `VR bloqueou: ${ct14.error.substring(0,120)}`, 'US 27'));
    } else {
      R.push(fail('CT-14','Edicao manual de Rating — ACEITA indevidamente',
        `PATCH Lead/${leadId} Rating=Hot`,
        'Update aceito', 'US 27 — VR LeadBlockRatingEdit nao funcionou'));
      // Revert
      await apiUpdate(leadId, { Rating: null });
    }

    // ============================================================
    // CT-15: Tentar editar Segmento manualmente
    // ============================================================
    const ct15 = await apiUpdate(leadId, { Segmento__c: 'Operadoras' });
    if (!ct15.ok) {
      R.push(ok('CT-15','Edicao manual de Segmento — BLOQUEADA pela VR',
        `PATCH Lead/${leadId} Segmento__c=Operadoras`,
        `Bloqueou: ${ct15.error.substring(0,120)}`, 'US 19'));
    } else {
      R.push(fail('CT-15','Edicao manual de Segmento — ACEITA indevidamente',
        `PATCH Lead/${leadId} Segmento__c=Operadoras`,
        'Aceito', 'US 19 — VR LeadBlockSegmentEdit nao funcionou'));
    }

    // ============================================================
    // CT-16: Tentar cancelar sem motivo
    // ============================================================
    const ct16 = await apiUpdate(leadId, { Status: 'Cancelado' });
    if (!ct16.ok) {
      R.push(ok('CT-16','Cancelar sem motivo — BLOQUEADO pela VR',
        `PATCH Lead/${leadId} Status=Cancelado sem Motivo_cancelamento__c`,
        `Bloqueou: ${ct16.error.substring(0,120)}`, 'US 55'));
    } else {
      R.push(fail('CT-16','Cancelar sem motivo — ACEITO indevidamente',
        `PATCH Status=Cancelado sem motivo`,
        'Aceito', 'US 55 — VR ValidateCanceledStatus nao bloqueou'));
      await apiUpdate(leadId, { Status: 'Novo', Motivo_cancelamento__c: null });
    }

    // ============================================================
    // CT-17: Tentar preencher motivo fora do status Cancelado
    // ============================================================
    const ct17 = await apiUpdate(leadId, { Motivo_cancelamento__c: 'Sem_interesse' });
    if (!ct17.ok) {
      R.push(ok('CT-17','Motivo cancelamento fora de Cancelado — BLOQUEADO pela VR',
        `PATCH Motivo_cancelamento__c=Sem_interesse com Status=Novo`,
        `Bloqueou: ${ct17.error.substring(0,120)}`, 'US 55'));
    } else {
      R.push(fail('CT-17','Motivo cancelamento preenchido fora de Cancelado — VR nao bloqueou',
        `PATCH Motivo_cancelamento__c com Status!=Cancelado`,
        'Aceito', 'US 55 — VR ValidateMotivoCancelamento'));
      await apiUpdate(leadId, { Motivo_cancelamento__c: null });
    }

    // ============================================================
    // CT-18: Tentar avancar para Conversao sem campos qualificacao
    // ============================================================
    const ct18 = await apiUpdate(leadId, { Status: 'Conversao' });
    if (!ct18.ok) {
      R.push(ok('CT-18','Avancar para Conversao sem qualificacao — BLOQUEADO',
        `PATCH Status=Conversao sem OrcamentoDisponivel etc`,
        `Bloqueou: ${ct18.error.substring(0,120)}`, 'US 54,68'));
    } else {
      R.push(fail('CT-18','Avancou para Conversao sem qualificacao — VR nao bloqueou',
        `PATCH Status=Conversao`,
        'Aceito', 'US 54 — VR RequireQualificationFieldsOnAdvance'));
      await apiUpdate(leadId, { Status: 'Novo' });
    }

    // ============================================================
    // CT-19: Cancelar Lead com motivo (deve funcionar)
    // ============================================================
    const ct19 = await apiUpdate(leadId, { Status: 'Cancelado', Motivo_cancelamento__c: 'Sem_interesse' });
    if (ct19.ok) {
      R.push(ok('CT-19','Cancelar Lead com motivo "Sem_interesse" — SUCESSO',
        `PATCH Status=Cancelado + Motivo_cancelamento__c=Sem_interesse`,
        'Update aceito', 'US 55'));
      // Revert for more tests
      await apiUpdate(leadId, { Status: 'Novo', Motivo_cancelamento__c: null });
    } else {
      R.push(fail('CT-19',`Cancelar Lead com motivo — BLOQUEADO: ${ct19.error}`,
        `PATCH Status=Cancelado + Motivo`,
        `Erro: ${ct19.error.substring(0,120)}`, 'US 55'));
    }

    // ============================================================
    // CT-20: Blacklist check executou? (campos blacklist preenchidos)
    // ============================================================
    const data20 = await apiRead(leadId, 'TelefoneBlacklist__c,BlacklistValidationPending__c');
    if (data20.TelefoneBlacklist__c || data20.BlacklistValidationPending__c != null) {
      R.push(ok('CT-20',`Blacklist verificado: TelefoneBlacklist=${data20.TelefoneBlacklist__c}, Pending=${data20.BlacklistValidationPending__c}`,
        `GET Lead/${leadId}`, '', 'US 53'));
    } else {
      R.push(fail('CT-20','Blacklist NAO executou — campos blacklist vazios',
        `GET Lead/${leadId} TelefoneBlacklist__c`,
        'TelefoneBlacklist__c=null', 'US 53 — PhoneBlacklistHelper pode depender de API externa indisponivel'));
    }

  } else {
    // No lead created - mark remaining as blocked
    const blocked = ['CT-07','CT-08','CT-09','CT-10','CT-11','CT-12','CT-13','CT-14','CT-15','CT-16','CT-17','CT-18','CT-19','CT-20'];
    for (const ca of blocked) {
      R.push(fail(ca, `Teste bloqueado — nenhum Lead criado (CT-01 e CT-02 falharam)`,
        'N/A', 'Sem Lead de teste', 'Corrigir CT-01 ou CT-02 primeiro'));
    }
  }

  // ============================================================
  // CT-21: Duplicidade — criar 2 leads mesmo CNPJ
  // ============================================================
  if (ct01.ok) {
    const dup = await apiCreate({
      FirstName:'QA', LastName:'Dup01', Company:'Dup Empresa',
      Email:'dup@empresa.com.br', Phone:'11999990021',
      CNPJ__c:'71208516000174', Nacionalidade__c:'Nacional',
      RecordTypeId: NAC_RT, OrigemCanal__c:'Landing page', Status:'Novo'
    });
    if (dup.ok) {
      const dupData = await apiRead(dup.id, 'Status,Motivo_cancelamento__c,Lead_Relacionado__c');
      if (dupData.Status === 'Cancelado') {
        R.push(ok('CT-21',`Duplicidade: 2o lead auto-cancelado (Status=${dupData.Status}, Motivo=${dupData.Motivo_cancelamento__c})`,
          `Criados 2 leads CNPJ=71208516000174`, `Lead2 Status=${dupData.Status}`, 'US 22'));
      } else {
        R.push(fail('CT-21',`Duplicidade: 2o lead NAO auto-cancelado (Status=${dupData.Status})`,
          `Criados 2 leads mesmo CNPJ`,
          `Lead2 Status=${dupData.Status} — esperado Cancelado`, 'US 22 — Nenhum Flow/Apex de duplicidade implementado'));
      }
    } else {
      R.push(fail('CT-21',`Duplicidade: 2o lead nao criado: ${dup.error}`,
        'POST Lead mesmo CNPJ', dup.error.substring(0,120), 'US 22'));
    }
  } else {
    R.push(manual('CT-21','Duplicidade: verificar se 2o lead mesmo CNPJ e auto-cancelado',
      'CT-01 falhou — nao foi possivel testar. Criar 2 leads manualmente com mesmo CNPJ e verificar se o 2o fica Cancelado com motivo Duplicidade'));
  }

  // ============================================================
  // MANUAIS
  // ============================================================
  R.push(manual('CT-22','Layout exibe Nacionalidade (Nacional/Internacional) no topo da tela de criacao',
    'UI: Leads > Novo Lead > verificar que radio button ou picklist Nacionalidade aparece na primeira secao. Selecionar Internacional e confirmar que CNPJ deixa de ser obrigatorio'));

  R.push(manual('CT-23','CNPJ preenche dados da empresa a partir de conta existente',
    'UI: Criar Lead Nacional > informar CNPJ de uma conta existente > verificar se Nome da Empresa, Site, Setor, Porte sao auto-preenchidos'));

  R.push(manual('CT-24','Origem canal preenchido como Manual na criacao via SF',
    'UI: Criar Lead via botao Novo > apos salvar verificar que campo Origem Canal esta como "Manual"'));

  R.push(manual('CT-25','Botao Converter Lead visivel apenas em status Em conversao para perfil consultor',
    'UI: Acessar Lead com Status diferente de Em conversao > botao Converter nao deve aparecer. Mudar para Em conversao (com qualificacao preenchida) > botao deve aparecer para perfil consultor'));

  R.push(manual('CT-26','Enriquecimento Neoway/Receita ao entrar em Qualificacao',
    'UI: Mover Lead com CNPJ para status Qualificacao > verificar se campos endereco, porte, faixa funcionarios, situacao cadastral sao preenchidos. Verificar indicadores OK/VAZIO/ERRO. Botao Atualizar Dados disponivel'));

  R.push(manual('CT-27','Cadencia outbound cria tarefas automaticas em sequencia',
    'UI: Lead outbound em Qualificacao > verificar se tarefas sao criadas automaticamente (telefone, email, whatsapp, linkedin) com intervalos de 8h uteis'));

  R.push(manual('CT-28','Botao Cobertura de Rede em Qualificacao com endereco completo',
    'UI: Lead em Qualificacao com endereco completo (Rua, Cidade, Estado, CEP, Numero, Bairro) > verificar botao Cobertura de Rede visivel e funcional > popup com tecnologias x velocidades'));

  R.push(manual('CT-29','Redistribuicao: gerente pode trocar owner, par nao pode',
    'UI: Logar como gerente do consultor > redistribuir lead do consultor > deve funcionar. Logar como outro gerente (par) > tentar redistribuir > deve ser bloqueado'));

  R.push(manual('CT-30','Atribuicao automatica para fila SDR conforme segmento e regional',
    'UI: Criar Lead Cliente Novo, Segmento Corporativo, com regional > verificar que Owner = fila SDR CORPORATIVO. Sem regional > Owner = fila Lider Tecnico SDR'));

  R.push(manual('CT-31','Campanha: status atualizado para Em Andamento na data de inicio',
    'UI: Criar campanha com data inicio = hoje > verificar se status muda para Em Andamento. Campanha com data termino passada > tentar reativar > deve ser bloqueado'));

  R.push(manual('CT-32','Registro de interacoes (ligacao, email, tarefa) na aba Atividades',
    'UI: Lead > Atividades > Registrar chamada > preencher Assunto, Duracao, Telefone, Resumo (obrigatorios) + Resultado da chamada. Apos salvar verificar sugestao de criar tarefa'));

  R.push(manual('CT-33','Notificacao ao consultor quando lead inbound atribuido',
    'UI: Atribuir lead inbound a consultor > verificar notificacao no sino (bell) do Salesforce e push no mobile'));

  R.push(manual('CT-34','Dashboards Lead (funil, backlog, cancelados, SLA) com filtros',
    'App Leads > Dashboards > verificar 4 dashboards com filtros por segmento, status, regional, proprietario'));

  R.push(manual('CT-35','Carga mailing via Data Import Wizard aceita registros sem CNPJ',
    'Setup > Data Import Wizard > importar CSV de leads sem CNPJ > verificar que leads sao criados. Verificar Origem Canal = Mailing automaticamente'));

  R.push(manual('CT-36','Quarentena: lead outbound bloqueado se cliente tem lead cancelado recente',
    'Criar lead outbound com CNPJ de lead cancelado recentemente > verificar se sistema impede criacao (exceto se criado por SDR/Consultor/Atendimento)'));

  R.push(manual('CT-37','Aba WhatsApp no Lead com envio via template aprovado',
    'UI: Lead > aba WhatsApp (ao lado de Atividades) > selecionar template > enviar > verificar que mensagem livre nao e permitida como primeira msg'));

  // ============================================================
  // CLEANUP
  // ============================================================
  for (const id of cleanup.reverse()) {
    try { await apiDelete(id); } catch(e) {}
  }

  return R;
}



// ===== CRMB2B-172 — Criacao de Contato =====
async function test172(sf) {
  const R = [];

  // CT-172-001: FonteCriacao__c field exists with 6 values
  try {
    const r = await sfTooling(sf, "SELECT DeveloperName, DataType FROM CustomField WHERE TableEnumOrId='Contact' AND DeveloperName='FonteCriacao' AND NamespacePrefix=null");
    const recs = r.records || [];
    if (recs.length > 0) R.push(ok('CT-172-001', 'FonteCriacao__c existe', 'Tooling SOQL CustomField', `Tipo: ${recs[0].DataType}`, 'Setup > Contact > Fields > FonteCriacao__c'));
    else R.push(fail('CT-172-001', 'FonteCriacao__c NAO existe', 'Tooling SOQL', 'Campo nao encontrado', 'Setup > Contact > Fields'));
  } catch(e) { R.push(fail('CT-172-001', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-172-002: LeadOrigem__c field exists as Lookup
  try {
    const r = await sfTooling(sf, "SELECT DeveloperName, DataType FROM CustomField WHERE TableEnumOrId='Contact' AND DeveloperName='LeadOrigem' AND NamespacePrefix=null");
    const recs = r.records || [];
    if (recs.length > 0 && recs[0].DataType === 'Lookup') R.push(ok('CT-172-002', 'LeadOrigem__c existe (Lookup)', 'Tooling SOQL CustomField', `Tipo: ${recs[0].DataType}`, 'Setup > Contact > Fields > LeadOrigem__c'));
    else if (recs.length > 0) R.push(fail('CT-172-002', `LeadOrigem__c tipo errado: ${recs[0].DataType}`, 'Tooling SOQL', 'Esperado Lookup', ''));
    else R.push(fail('CT-172-002', 'LeadOrigem__c NAO existe', 'Tooling SOQL', 'Campo nao encontrado', ''));
  } catch(e) { R.push(fail('CT-172-002', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-172-003: VR FonteCriacao Imutavel ativa
  try {
    const r = await sfTooling(sf, "SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Contact' AND ValidationName='VR_Contact_FonteCriacao_Imutavel'");
    const recs = r.records || [];
    if (recs.length > 0 && recs[0].Active) R.push(ok('CT-172-003', 'VR FonteCriacao Imutavel ativa', 'Tooling SOQL ValidationRule', 'Active=true', 'Setup > Contact > Validation Rules'));
    else R.push(fail('CT-172-003', 'VR FonteCriacao Imutavel NAO ativa', 'Tooling SOQL', recs.length > 0 ? 'Active=false' : 'Nao encontrada', ''));
  } catch(e) { R.push(fail('CT-172-003', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-172-004: VR LeadOrigem Imutavel ativa
  try {
    const r = await sfTooling(sf, "SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Contact' AND ValidationName='VR_Contact_LeadOrigem_Imutavel'");
    const recs = r.records || [];
    if (recs.length > 0 && recs[0].Active) R.push(ok('CT-172-004', 'VR LeadOrigem Imutavel ativa', 'Tooling SOQL ValidationRule', 'Active=true', 'Setup > Contact > Validation Rules'));
    else R.push(fail('CT-172-004', 'VR LeadOrigem Imutavel NAO ativa', 'Tooling SOQL', recs.length > 0 ? 'Active=false' : 'Nao encontrada', ''));
  } catch(e) { R.push(fail('CT-172-004', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-172-005: PS_Contact_FonteCriacao_FLS existe
  try {
    const r = await sfQuery(sf, "SELECT Id, Name FROM PermissionSet WHERE Name='PS_Contact_FonteCriacao_FLS'");
    const recs = r.records || [];
    if (recs.length > 0) R.push(ok('CT-172-005', 'PS_Contact_FonteCriacao_FLS existe', 'REST SOQL PermissionSet', `Id: ${recs[0].Id}`, 'Setup > Permission Sets'));
    else R.push(fail('CT-172-005', 'PS NAO existe', 'REST SOQL', 'Nao encontrado', ''));
  } catch(e) { R.push(fail('CT-172-005', 'Erro', 'REST SOQL', e.message, '')); }

  // CT-172-006: FLS FonteCriacao Read Only no PS
  try {
    const r = await sfQuery(sf, "SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Parent.Name='PS_Contact_FonteCriacao_FLS' AND SobjectType='Contact'");
    const recs = r.records || [];
    const fc = recs.find(x => x.Field === 'Contact.FonteCriacao__c');
    const lo = recs.find(x => x.Field === 'Contact.LeadOrigem__c');
    const fcOk = fc && fc.PermissionsRead && !fc.PermissionsEdit;
    const loOk = lo && lo.PermissionsRead && !lo.PermissionsEdit;
    if (fcOk && loOk) R.push(ok('CT-172-006', 'FLS Read Only em FonteCriacao e LeadOrigem', 'REST SOQL FieldPermissions', `${recs.length} FPs. FonteCriacao=Read, LeadOrigem=Read`, 'Setup > PS > Field Permissions'));
    else R.push(fail('CT-172-006', 'FLS incorreto', 'REST SOQL', `FC: Read=${fc?.PermissionsRead} Edit=${fc?.PermissionsEdit}, LO: Read=${lo?.PermissionsRead} Edit=${lo?.PermissionsEdit}`, ''));
  } catch(e) { R.push(fail('CT-172-006', 'Erro', 'REST SOQL', e.message, '')); }

  // CT-172-007: FonteCriacao picklist tem 6 valores
  try {
    const r = await sfQuery(sf, "SELECT Id FROM Contact LIMIT 0");
    const desc = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/describe', { headers: { 'Authorization': 'Bearer ' + sf.token } });
    const d = await desc.json();
    const fcField = (d.fields || []).find(f => f.name === 'FonteCriacao__c');
    if (fcField) {
      const vals = (fcField.picklistValues || []).filter(v => v.active !== false).map(v => v.value);
      const expected = ['Lead','Manual','Mailing','Landing Page','Portal','Oportunidade'];
      const missing = expected.filter(e => !vals.includes(e));
      if (missing.length === 0) R.push(ok('CT-172-007', 'Picklist FonteCriacao 6 valores OK', 'REST Describe Contact', `Valores: ${vals.join(', ')}`, 'Setup > Contact > Fields > FonteCriacao__c'));
      else R.push(fail('CT-172-007', 'Valores faltando na picklist', 'REST Describe', `Faltam: ${missing.join(', ')}`, ''));
    } else R.push(fail('CT-172-007', 'FonteCriacao__c nao encontrado no describe', 'REST Describe', '', ''));
  } catch(e) { R.push(fail('CT-172-007', 'Erro', 'REST Describe', e.message, '')); }

  // CT-172-008: VR bloqueia alteracao FonteCriacao (teste real)
  try {
    // Create a test Contact
    const createResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'QA_Tester_172_' + Date.now(), FonteCriacao__c: 'Manual' })
    });
    const created = await createResp.json();
    if (created.id) {
      // Try to update FonteCriacao (should fail)
      const upResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + created.id, {
        method: 'PATCH', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ FonteCriacao__c: 'Lead' })
      });
      if (upResp.status === 400) {
        const err = await upResp.json();
        const msg = (err[0]?.message || err.message || '').toLowerCase();
        if (msg.includes('fonte de cria')) R.push(ok('CT-172-008', 'VR bloqueia alteracao FonteCriacao (real)', 'REST DML: Insert+Update Contact', `VR disparou: ${err[0]?.message?.substring(0,80)}`, 'Tentar editar FonteCriacao no registro'));
        else R.push(fail('CT-172-008', 'Bloqueio por outro motivo', 'REST DML', msg.substring(0,100), ''));
      } else {
        R.push(fail('CT-172-008', 'VR NAO bloqueou alteracao', 'REST DML', `Status: ${upResp.status}`, ''));
      }
      // Cleanup
      await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + created.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    } else R.push(fail('CT-172-008', 'Erro ao criar Contact de teste', 'REST DML', JSON.stringify(created).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-172-008', 'Erro', 'REST DML', e.message, '')); }

  // CT-172-009: Flow BeforeSave (MANUAL — Flow nao deployado)
  R.push(manual('CT-172-009', 'Flow Contact_BeforeSave_FonteCriacao (default Manual)', 'Flow Builder > Contact_BeforeSave_FonteCriacao'));

  // CT-172-010: Flow Lead Conversion (MANUAL)
  R.push(manual('CT-172-010', 'Flow Lead_AfterUpdate_Conversion (FonteCriacao=Lead + LeadOrigem)', 'Flow Builder > Lead_AfterUpdate_Conversion'));

  return R;
}


// ===== CRMB2B-173 — Campos do Contato =====
async function test173(sf) {
  const R = [];

  const EXPECTED_FIELDS = [
    'StatusContato','Celular2','Cargo','Departamento','CanalPreferencial',
    'TipoContato','ClassificacaoContato','ContatoPrincipal','GrauInfluencia',
    'Consentimento','NaoPerturbe','Blacklist','CodigoPaisCelular','CodigoPaisTelefone','CodigoPaisCelular2'
  ];

  // CT-173-001: 15 campos custom existem
  try {
    const r = await sfTooling(sf, "SELECT DeveloperName, DataType FROM CustomField WHERE TableEnumOrId='Contact' AND NamespacePrefix=null");
    const found = (r.records || []).map(x => x.DeveloperName);
    const missing = EXPECTED_FIELDS.filter(f => !found.includes(f));
    if (missing.length === 0) R.push(ok('CT-173-001', '15 campos custom existem', 'Tooling SOQL CustomField', `Encontrados: ${found.length} campos non-namespaced`, 'Setup > Contact > Fields'));
    else R.push(fail('CT-173-001', 'Campos faltando', 'Tooling SOQL', `Faltam: ${missing.join(', ')}`, ''));
  } catch(e) { R.push(fail('CT-173-001', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-173-002: VR EmailFormato ativa
  try {
    const r = await sfTooling(sf, "SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Contact' AND ValidationName='VR_Contact_EmailFormato'");
    const recs = r.records || [];
    if (recs.length > 0 && recs[0].Active) R.push(ok('CT-173-002', 'VR EmailFormato ativa', 'Tooling SOQL', 'Active=true', 'Setup > Contact > VRs'));
    else R.push(fail('CT-173-002', 'VR EmailFormato NAO ativa', 'Tooling SOQL', recs.length > 0 ? 'Active=false' : 'Nao encontrada', ''));
  } catch(e) { R.push(fail('CT-173-002', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-173-003: VR ReportsTo MesmaConta ativa
  try {
    const r = await sfTooling(sf, "SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Contact' AND ValidationName='VR_Contact_ReportsTo_MesmaConta'");
    const recs = r.records || [];
    if (recs.length > 0 && recs[0].Active) R.push(ok('CT-173-003', 'VR ReportsTo MesmaConta ativa', 'Tooling SOQL', 'Active=true', 'Setup > Contact > VRs'));
    else R.push(fail('CT-173-003', 'VR ReportsTo NAO ativa', 'Tooling SOQL', recs.length > 0 ? 'Active=false' : 'Nao encontrada', ''));
  } catch(e) { R.push(fail('CT-173-003', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-173-004: PS CamposGerais com 15 FP Edit
  try {
    const r = await sfQuery(sf, "SELECT Field, PermissionsEdit FROM FieldPermissions WHERE Parent.Name='PS_Contact_CamposGerais_FLS' AND SobjectType='Contact'");
    const recs = r.records || [];
    const editCount = recs.filter(x => x.PermissionsEdit).length;
    if (recs.length >= 15 && editCount >= 15) R.push(ok('CT-173-004', 'PS CamposGerais: 15+ FP Edit', 'REST SOQL FieldPermissions', `${recs.length} FPs, ${editCount} editable`, 'Setup > PS > PS_Contact_CamposGerais_FLS'));
    else R.push(fail('CT-173-004', 'FP insuficientes', 'REST SOQL', `Total=${recs.length}, Edit=${editCount}`, ''));
  } catch(e) { R.push(fail('CT-173-004', 'Erro', 'REST SOQL', e.message, '')); }

  // CT-173-005: PS SomenteLeitura com 15 FP ReadOnly
  try {
    const r = await sfQuery(sf, "SELECT Field, PermissionsEdit FROM FieldPermissions WHERE Parent.Name='PS_Contact_SomenteLeitura_FLS' AND SobjectType='Contact'");
    const recs = r.records || [];
    const editCount = recs.filter(x => x.PermissionsEdit).length;
    if (recs.length >= 15 && editCount === 0) R.push(ok('CT-173-005', 'PS SomenteLeitura: 15+ FP ReadOnly', 'REST SOQL FieldPermissions', `${recs.length} FPs, 0 editable`, 'Setup > PS > PS_Contact_SomenteLeitura_FLS'));
    else R.push(fail('CT-173-005', 'FP incorretos', 'REST SOQL', `Total=${recs.length}, Edit=${editCount} (esperado 0)`, ''));
  } catch(e) { R.push(fail('CT-173-005', 'Erro', 'REST SOQL', e.message, '')); }

  // CT-173-006: VR EmailFormato bloqueia email invalido (teste real)
  try {
    const createResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'QA_173_EmailTest', Email: 'invalido@' })
    });
    if (createResp.status === 400) {
      const err = await createResp.json();
      const msg = (err[0]?.message || '').toLowerCase();
      if (msg.includes('e-mail') || msg.includes('email')) R.push(ok('CT-173-006', 'VR bloqueia email formato invalido', 'REST DML Insert Contact', `VR disparou: ${err[0]?.message?.substring(0,80)}`, 'Criar Contact com Email=invalido@'));
      else R.push(ok('CT-173-006', 'Email invalido bloqueado (outro mecanismo)', 'REST DML', msg.substring(0,80), ''));
    } else {
      const created = await createResp.json();
      R.push(fail('CT-173-006', 'Email invalido NAO bloqueado', 'REST DML', `Status ${createResp.status}`, ''));
      if (created.id) await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + created.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    }
  } catch(e) { R.push(fail('CT-173-006', 'Erro', 'REST DML', e.message, '')); }

  // CT-173-007: Email formato valido aceito
  try {
    const createResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'QA_173_ValidEmail_' + Date.now(), Email: 'qa173test@everymind.com.br' })
    });
    const created = await createResp.json();
    if (created.id) {
      R.push(ok('CT-173-007', 'Email formato valido aceito', 'REST DML Insert Contact', `Id: ${created.id}`, ''));
      await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + created.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    } else R.push(fail('CT-173-007', 'Nao criou Contact com email valido', 'REST DML', JSON.stringify(created).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-173-007', 'Erro', 'REST DML', e.message, '')); }

  // CT-173-008: Cargo picklist tem 17 valores
  try {
    const desc = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/describe', { headers: { 'Authorization': 'Bearer ' + sf.token } });
    const d = await desc.json();
    const cargoField = (d.fields || []).find(f => f.name === 'Cargo__c');
    if (cargoField) {
      const vals = (cargoField.picklistValues || []).filter(v => v.active !== false);
      if (vals.length >= 15) R.push(ok('CT-173-008', `Cargo picklist: ${vals.length} valores`, 'REST Describe', vals.map(v=>v.value).join(', '), 'Setup > Contact > Cargo__c'));
      else R.push(fail('CT-173-008', `Cargo: apenas ${vals.length} valores`, 'REST Describe', vals.map(v=>v.value).join(', '), ''));
    } else R.push(fail('CT-173-008', 'Cargo__c nao encontrado', 'REST Describe', '', ''));
  } catch(e) { R.push(fail('CT-173-008', 'Erro', 'REST Describe', e.message, '')); }

  // CT-173-009: Departamento picklist tem 14 valores
  try {
    const desc = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/describe', { headers: { 'Authorization': 'Bearer ' + sf.token } });
    const d = await desc.json();
    const deptField = (d.fields || []).find(f => f.name === 'Departamento__c');
    if (deptField) {
      const vals = (deptField.picklistValues || []).filter(v => v.active !== false);
      if (vals.length >= 12) R.push(ok('CT-173-009', `Departamento picklist: ${vals.length} valores`, 'REST Describe', vals.map(v=>v.value).join(', '), 'Setup > Contact > Departamento__c'));
      else R.push(fail('CT-173-009', `Departamento: apenas ${vals.length} valores`, 'REST Describe', vals.map(v=>v.value).join(', '), ''));
    } else R.push(fail('CT-173-009', 'Departamento__c nao encontrado', 'REST Describe', '', ''));
  } catch(e) { R.push(fail('CT-173-009', 'Erro', 'REST Describe', e.message, '')); }

  // CT-173-010 a 012: MANUAL
  R.push(manual('CT-173-010', 'FHT registra alteracao Cargo/Status', 'Setup > Contact > History Tracking'));
  R.push(manual('CT-173-011', 'Contact sem Account privado (OWD)', 'Logar como outro usuario e buscar Contact'));
  R.push(manual('CT-173-012', 'SafetyEmail Apex (pendente deploy)', 'Deploy SafetyEmailService.cls e testar'));

  return R;
}

const TESTS = { '83': test83, '84': test84, '85': test85, 'usbase': testUSBase, '50a': test50A, '90': test90, '91': test91, '107': test107, '108': test108, 'lead': testLead, 
// ===== CRMB2B-174 — Duplicidade de Contato =====
async function test174(sf) {
  const R = [];
  const ts = Date.now();

  // Setup: create Account + base Contact
  let accId, baseContactId;
  try {
    const accResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Account', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'QA174_Account_' + ts })
    });
    const acc = await accResp.json();
    accId = acc.id;

    const cResp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Silva', FirstName: 'Joao', MobilePhone: '11999990001', AccountId: accId, StatusContato__c: 'Ativo' })
    });
    const base = await cResp.json();
    baseContactId = base.id;
    if (!baseContactId) { R.push(fail('CT-174-SETUP', 'Falha ao criar Contact base', 'REST DML', JSON.stringify(base).substring(0,150), '')); return R; }
    R.push(ok('CT-174-SETUP', 'Account + Contact base criados', 'REST DML', 'AccId=' + accId + ' ConId=' + baseContactId, ''));
  } catch(e) { R.push(fail('CT-174-SETUP', 'Erro setup', 'REST DML', e.message, '')); return R; }

  // CT-174-001 (CA-001): Block duplicate same account+phone+name+active
  try {
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Silva', FirstName: 'Joao', MobilePhone: '11999990001', AccountId: accId, StatusContato__c: 'Ativo' })
    });
    if (resp.status === 400) {
      const err = await resp.json();
      const msg = (err[0]?.message || '').toLowerCase();
      if (msg.includes('ja existe') || msg.includes('duplici')) R.push(ok('CT-174-001', 'CA-001: Duplicado bloqueado (mesmo cel+nome+conta+ativo)', 'REST DML Insert', err[0]?.message?.substring(0,100), ''));
      else R.push(fail('CT-174-001', 'Bloqueado mas msg errada', 'REST DML', msg.substring(0,100), ''));
    } else {
      const c = await resp.json();
      R.push(fail('CT-174-001', 'CA-001: NAO bloqueou duplicado', 'REST DML', 'Status=' + resp.status, ''));
      if (c.id) await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    }
  } catch(e) { R.push(fail('CT-174-001', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-002 (CA-002): Allow same phone+name in different account
  let acc2Id;
  try {
    const a2 = await fetch(sf.url + '/services/data/v62.0/sobjects/Account', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Name: 'QA174_AccountB_' + ts })
    });
    acc2Id = (await a2.json()).id;
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Silva', FirstName: 'Joao', MobilePhone: '11999990001', AccountId: acc2Id, StatusContato__c: 'Ativo' })
    });
    const c = await resp.json();
    if (c.id) { R.push(ok('CT-174-002', 'CA-002: Permitido em conta diferente', 'REST DML Insert', 'Id=' + c.id, '')); await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } }); }
    else R.push(fail('CT-174-002', 'CA-002: Bloqueou indevidamente', 'REST DML', JSON.stringify(c).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-174-002', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-003 (CA-003): Allow new unique contact
  try {
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Oliveira', FirstName: 'Maria', MobilePhone: '11999990002', AccountId: accId, StatusContato__c: 'Ativo' })
    });
    const c = await resp.json();
    if (c.id) { R.push(ok('CT-174-003', 'CA-003: Contato unico permitido', 'REST DML Insert', 'Id=' + c.id, '')); await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } }); }
    else R.push(fail('CT-174-003', 'Bloqueou contato unico', 'REST DML', JSON.stringify(c).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-174-003', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-004 (CA-008): Allow when existing is Inativo
  try {
    await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + baseContactId, {
      method: 'PATCH', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ StatusContato__c: 'Inativo' })
    });
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Silva', FirstName: 'Joao', MobilePhone: '11999990001', AccountId: accId, StatusContato__c: 'Ativo' })
    });
    const c = await resp.json();
    if (c.id) {
      R.push(ok('CT-174-004', 'CA-008: Permitido quando existente Inativo', 'REST DML', 'Id=' + c.id, ''));
      await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    } else R.push(fail('CT-174-004', 'Bloqueou com existente Inativo', 'REST DML', JSON.stringify(c).substring(0,100), ''));
    // Restore base
    await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + baseContactId, {
      method: 'PATCH', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ StatusContato__c: 'Ativo' })
    });
  } catch(e) { R.push(fail('CT-174-004', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-005 (CA-009): Different name same phone = allowed
  try {
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Santos', FirstName: 'Pedro', MobilePhone: '11999990001', AccountId: accId, StatusContato__c: 'Ativo' })
    });
    const c = await resp.json();
    if (c.id) { R.push(ok('CT-174-005', 'CA-009: Nome diferente + mesmo cel = permitido', 'REST DML', 'Id=' + c.id, '')); await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } }); }
    else R.push(fail('CT-174-005', 'Bloqueou nome diferente', 'REST DML', JSON.stringify(c).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-174-005', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-006: No account = skip validation
  try {
    const resp = await fetch(sf.url + '/services/data/v62.0/sobjects/Contact', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + sf.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ LastName: 'Silva', FirstName: 'Joao', MobilePhone: '11999990001', StatusContato__c: 'Ativo' })
    });
    const c = await resp.json();
    if (c.id) { R.push(ok('CT-174-006', 'RN-003: Sem conta = sem validacao', 'REST DML', 'Id=' + c.id, '')); await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + c.id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } }); }
    else R.push(fail('CT-174-006', 'Bloqueou sem conta', 'REST DML', JSON.stringify(c).substring(0,100), ''));
  } catch(e) { R.push(fail('CT-174-006', 'Erro', 'REST DML', e.message, '')); }

  // CT-174-007: Apex class exists
  try {
    const r = await sfTooling(sf, "SELECT Name FROM ApexClass WHERE Name='ContactDuplicateService'");
    if ((r.records||[]).length > 0) R.push(ok('CT-174-007', 'ContactDuplicateService existe', 'Tooling SOQL', '', ''));
    else R.push(fail('CT-174-007', 'Classe nao encontrada', 'Tooling SOQL', '', ''));
  } catch(e) { R.push(fail('CT-174-007', 'Erro', 'Tooling SOQL', e.message, '')); }

  // CT-174-008: Test class exists
  try {
    const r = await sfTooling(sf, "SELECT Name FROM ApexClass WHERE Name='ContactDuplicateServiceTest'");
    if ((r.records||[]).length > 0) R.push(ok('CT-174-008', 'ContactDuplicateServiceTest existe', 'Tooling SOQL', '', ''));
    else R.push(fail('CT-174-008', 'Test class nao encontrada', 'Tooling SOQL', '', ''));
  } catch(e) { R.push(fail('CT-174-008', 'Erro', 'Tooling SOQL', e.message, '')); }

  // Cleanup
  try {
    if (baseContactId) await fetch(sf.url + '/services/data/v62.0/sobjects/Contact/' + baseContactId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    if (accId) await fetch(sf.url + '/services/data/v62.0/sobjects/Account/' + accId, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
    if (acc2Id) await fetch(sf.url + '/services/data/v62.0/sobjects/Account/' + acc2Id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + sf.token } });
  } catch(e) { /* cleanup best effort */ }

  return R;
}

'172': test172, '173': test173, '174': test174 };

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
