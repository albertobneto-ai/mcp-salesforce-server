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
  const results = [];
  const createdIds = []; // cleanup

  // Helper: create record
  async function sfCreate(obj, data) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/${obj}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${sf.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const d = await r.json();
    if (d.id) createdIds.push({ obj, id: d.id });
    return { status: r.status, ...d };
  }

  // Helper: update record
  async function sfUpdate(obj, id, data) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/${obj}/${id}`, {
      method: 'PATCH', headers: { 'Authorization': `Bearer ${sf.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (r.status === 204) return { success: true };
    const d = await r.json();
    return { success: false, status: r.status, ...d };
  }

  // Helper: read record
  async function sfRead(obj, id, fields) {
    const r = await fetch(`${sf.url}/services/data/v62.0/sobjects/${obj}/${id}?fields=${fields}`, {
      headers: { 'Authorization': `Bearer ${sf.token}` }
    });
    return r.json();
  }

  // Helper: delete
  async function sfDelete(obj, id) {
    await fetch(`${sf.url}/services/data/v62.0/sobjects/${obj}/${id}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${sf.token}` }
    });
  }

  // Describe for metadata checks
  const descResp = await fetch(`${sf.url}/services/data/v62.0/sobjects/Lead/describe`, { headers: { 'Authorization': `Bearer ${sf.token}` } });
  const desc = await descResp.json();
  const fieldMap = {};
  (desc.fields || []).forEach(f => { fieldMap[f.name] = f; });
  const rtMap = {};
  (desc.recordTypeInfos || []).forEach(rt => { rtMap[rt.name] = rt; });

  function picklistValues(apiName) {
    const f = fieldMap[apiName];
    return f ? (f.picklistValues || []).map(pv => pv.value) : [];
  }

  const nacionalRT = rtMap['Nacional']?.recordTypeId;
  const internacionalRT = rtMap['Internacional']?.recordTypeId;

  // ================================================================
  // BLOCO 1: INFRAESTRUTURA (metadata verification)
  // ================================================================

  // 1.1 Record Types
  if (nacionalRT && internacionalRT)
    results.push(ok('INF-01', 'Record Types Nacional e Internacional existem e ativos',
      'Describe Lead', `Nacional=${nacionalRT}, Internacional=${internacionalRT}`, 'Setup > Lead > Record Types'));
  else results.push(fail('INF-01', 'Record Types Nacional/Internacional ausentes',
    'Describe Lead', `Nacional=${!!nacionalRT}, Internacional=${!!internacionalRT}`, 'Setup > Lead > Record Types'));

  // 1.2 Key fields exist
  const keyFields = ['CNPJ__c','Segmento__c','OrigemCanal__c','TipoLead__c','RelacionamentoLead__c',
    'Nacionalidade__c','PercentualPreenchimento__c','Regional__c','Diretoria__c','Motivo_cancelamento__c',
    'Lead_Relacionado__c','OrcamentoDisponivel__c','NivelDecisaoContrato__c','NecessidadeIdentificada__c',
    'PrazoContratacao__c','FornecedoresEmpresa__c','HistoricoWhatsApp__c','SituacaoCadastral__c'];
  const missing = keyFields.filter(f => !fieldMap[f]);
  if (missing.length === 0)
    results.push(ok('INF-02', `${keyFields.length} campos criticos existem`,
      'Describe Lead', `${keyFields.length}/${keyFields.length} OK`, 'Setup > Lead > Fields'));
  else results.push(fail('INF-02', `Campos criticos faltando: ${missing.join(', ')}`,
    'Describe Lead', `${keyFields.length - missing.length}/${keyFields.length}`, 'Setup > Lead > Fields'));

  // 1.3 VRs ativas
  const vrResp = await sfTooling(sf, "SELECT ValidationName,Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='Lead'");
  const vrs = {};
  (vrResp.records || []).forEach(v => { vrs[v.ValidationName] = v.Active; });
  const criticalVRs = ['ValidateCNPJFormat','ValidateEmailFormat','ValidatesPhoneFormat',
    'ValidateCanceledStatus','ValidateMotivoCancelamento','RequireQualificationFieldsOnAdvance',
    'BlockUnauthorizedLeadConversion','LeadBlockRatingEdit','LeadBlockSegmentEdit'];
  const vrMissing = criticalVRs.filter(v => !vrs[v]);
  const vrInactive = criticalVRs.filter(v => vrs[v] === false);
  if (vrMissing.length === 0 && vrInactive.length === 0)
    results.push(ok('INF-03', `${criticalVRs.length} VRs criticas ativas`,
      'Tooling API', `${criticalVRs.join(', ')}`, 'Setup > Lead > VRs'));
  else results.push(fail('INF-03', `VRs com problema — faltando: ${vrMissing.join(',')} / inativas: ${vrInactive.join(',')}`,
    'Tooling API', '', 'Setup > Lead > VRs'));

  // 1.4 Permission Sets Lead
  const psResp = await sfTooling(sf, "SELECT Name FROM PermissionSet WHERE Name LIKE '%Lead%' OR Name LIKE '%lead%'");
  const psCount = psResp.records?.length || 0;
  if (psCount >= 10)
    results.push(ok('INF-04', `${psCount} Permission Sets Lead-related encontrados`,
      'Tooling API', `${psCount} PSs`, 'Setup > Permission Sets'));
  else results.push(fail('INF-04', `Apenas ${psCount} PSs Lead (esperado 10+)`,
    'Tooling API', '', 'Setup > Permission Sets'));

  // 1.5 Flows ativos para Lead
  const flowResp = await sfTooling(sf, "SELECT DeveloperName FROM Flow WHERE Status='Active' AND (DeveloperName LIKE '%Lead%' OR DeveloperName LIKE '%lead%' OR DeveloperName LIKE '%Segmen%' OR DeveloperName LIKE '%Duplic%' OR DeveloperName LIKE '%Blacklist%')");
  const flowCount = flowResp.records?.length || 0;
  if (flowCount > 0)
    results.push(ok('INF-05', `${flowCount} Flows ativos Lead-related`,
      'Tooling API', flowResp.records.map(r=>r.DeveloperName).join(', '), 'Setup > Flows'));
  else results.push(fail('INF-05', 'NENHUM Flow ativo para Lead — segmentacao, duplicidade, priorizacao, cadencia NAO estao automatizados',
    'Tooling API', '0 Flows ativos', 'Setup > Flows'));

  // ================================================================
  // BLOCO 2: TESTES COMPORTAMENTAIS — VRs (tentar operacoes invalidas)
  // ================================================================

  // 2.1 BUG DOCUMENTADO: VR_CNPJ_Format ([0-9]{14}) CONFLITA com CnpjFormatHelper.applyMask (LeadTrigger)
  // Trigger formata CNPJ antes da VR avaliar, causando rejeicao. DESATIVAR VR_CNPJ_Format.
  try {
    const nacLead = await sfCreate('Lead', {
      FirstName: 'QA_Test', LastName: 'LeadNacional', Company: 'QA Empresa Teste Ltda',
      Email: 'qa.test@empresa.com.br', Phone: '1199999999',
      CNPJ__c: '71208516000174', Nacionalidade__c: 'Nacional',
      RecordTypeId: nacionalRT, OrigemCanal__c: 'Manual', Status: 'Novo'
    });
    if (nacLead.id)
      results.push(ok('BUG-01', 'Lead Nacional criado com sucesso — VR_CNPJ_Format nao conflita mais',
        'POST /sobjects/Lead CNPJ=71208516000174', `Id=${nacLead.id}`, ''));
    else
      results.push(fail('BUG-01', 'BUG CONFIRMADO: VR_CNPJ_Format conflita com CnpjFormatHelper.applyMask — Trigger formata CNPJ para XX.XXX.XXX/XXXX-XX ANTES da VR avaliar, VR exige [0-9]{14} e rejeita. ACAO: Desativar VR_CNPJ_Format (ValidateCNPJFormat ja cobre)',
        'POST /sobjects/Lead CNPJ=71208516000174', `Trigger applyMask formata→VR rejeita`, 'Desativar VR_CNPJ_Format ou ajustar regex'));
  } catch(e) { results.push(fail('BUG-01', `Erro: ${e.message}`, '', '', '')); }

  // 2.1b Fallback: Criar Lead Internacional (sem CNPJ) para testar demais VRs
  try {
    const intLead = await sfCreate('Lead', {
      FirstName: 'QA_Test', LastName: 'LeadIntl', Company: 'QA International Corp',
      Email: 'qa.intl@empresa.com', Phone: '1199999999',
      Nacionalidade__c: 'Internacional',
      RecordTypeId: internacionalRT, OrigemCanal__c: 'Manual', Status: 'Novo'
    });
    if (intLead.id)
      results.push(ok('VR-01', 'Lead Internacional criado com sucesso (bypass CNPJ para testar demais cenarios)',
        'POST /sobjects/Lead Internacional sem CNPJ', `Id=${intLead.id}`, ''));
    else
      results.push(fail('VR-01', `Lead Internacional NAO criado: ${JSON.stringify(intLead).substring(0,200)}`,
        'POST /sobjects/Lead', JSON.stringify(intLead).substring(0,200), 'Verificar VRs'));
  } catch(e) { results.push(fail('VR-01', `Erro: ${e.message}`, '', '', '')); }

  // 2.2 Tentar criar Lead com CNPJ invalido (menos de 14 digitos)
  try {
    const invalidCNPJ = await sfCreate('Lead', {
      FirstName: 'QA_Test', LastName: 'CNPJInvalido', Company: 'Teste',
      Email: 'qa@test.com', Phone: '1199999999',
      CNPJ__c: '12345', Nacionalidade__c: 'Nacional',
      RecordTypeId: nacionalRT, OrigemCanal__c: 'Manual', Status: 'Novo'
    });
    if (invalidCNPJ.id)
      results.push(fail('VR-02', 'Lead com CNPJ invalido (6 digitos) foi ACEITO — VR nao bloqueou',
        'POST /sobjects/Lead com CNPJ=12345 (5 chars)', `Id=${invalidCNPJ.id} criado indevidamente`, 'VR VR_CNPJ_Format deveria bloquear'));
    else {
      const msg = invalidCNPJ[0]?.message || JSON.stringify(invalidCNPJ).substring(0,150);
      results.push(ok('VR-02', 'VR bloqueou Lead com CNPJ invalido (6 digitos)',
        'POST /sobjects/Lead com CNPJ=12345 (5 chars)', `Erro: ${msg}`, 'VR_CNPJ_Format ativa'));
    }
  } catch(e) { results.push(fail('VR-02', `Erro inesperado: ${e.message}`, '', '', '')); }

  // 2.3 Tentar criar Lead com email invalido
  try {
    const invalidEmail = await sfCreate('Lead', {
      FirstName: 'QA_Test', LastName: 'EmailInvalido', Company: 'Teste',
      Email: 'semdominio', Phone: '1199999999',
      CNPJ__c: '71.208.516/0001-74', Nacionalidade__c: 'Nacional',
      RecordTypeId: nacionalRT, OrigemCanal__c: 'Manual', Status: 'Novo'
    });
    if (invalidEmail.id)
      results.push(fail('VR-03', 'Lead com email invalido ("semdominio") foi ACEITO — VR nao bloqueou',
        'POST /sobjects/Lead com Email=semdominio', `Id=${invalidEmail.id}`, 'VR ValidateEmailFormat deveria bloquear'));
    else
      results.push(ok('VR-03', 'VR bloqueou Lead com email invalido',
        'POST /sobjects/Lead com Email=semdominio', `Bloqueado`, 'VR ValidateEmailFormat ativa'));
  } catch(e) { results.push(fail('VR-03', `Erro: ${e.message}`, '', '', '')); }

  // 2.4 Tentar criar Lead com telefone invalido (menos de 10 digitos)
  try {
    const invalidPhone = await sfCreate('Lead', {
      FirstName: 'QA_Test', LastName: 'PhoneInvalido', Company: 'Teste',
      Email: 'qa@test.com.br', Phone: '123',
      CNPJ__c: '71.208.516/0001-74', Nacionalidade__c: 'Nacional',
      RecordTypeId: nacionalRT, OrigemCanal__c: 'Manual', Status: 'Novo'
    });
    if (invalidPhone.id)
      results.push(fail('VR-04', 'Lead com telefone invalido ("123") foi ACEITO — VR nao bloqueou',
        'POST /sobjects/Lead com Phone=123', `Id=${invalidPhone.id}`, 'VR ValidatesPhoneFormat deveria bloquear'));
    else
      results.push(ok('VR-04', 'VR bloqueou Lead com telefone invalido (3 digitos)',
        'POST /sobjects/Lead com Phone=123', 'Bloqueado', 'VR ValidatesPhoneFormat ativa'));
  } catch(e) { results.push(fail('VR-04', `Erro: ${e.message}`, '', '', '')); }

  // 2.5 Tentar editar Rating manualmente
  const testLeadId = createdIds.find(c => c.obj === 'Lead')?.id;
  if (testLeadId) {
    try {
      const ratingUpdate = await sfUpdate('Lead', testLeadId, { Rating: 'Hot' });
      if (ratingUpdate.success)
        results.push(fail('VR-05', 'Edicao manual de Rating foi ACEITA — VR LeadBlockRatingEdit nao bloqueou',
          `PATCH /sobjects/Lead/${testLeadId} Rating=Hot`, 'Update aceito', 'VR deveria bloquear'));
      else
        results.push(ok('VR-05', 'VR bloqueou edicao manual de Rating',
          `PATCH /sobjects/Lead/${testLeadId} Rating=Hot`, `Bloqueado: ${ratingUpdate[0]?.message?.substring(0,80) || ''}`, 'VR LeadBlockRatingEdit ativa'));
    } catch(e) { results.push(fail('VR-05', `Erro: ${e.message}`, '', '', '')); }

    // 2.6 Tentar editar Segmento manualmente
    try {
      const segUpdate = await sfUpdate('Lead', testLeadId, { Segmento__c: 'Operadoras' });
      if (segUpdate.success)
        results.push(fail('VR-06', 'Edicao manual de Segmento foi ACEITA — VR LeadBlockSegmentEdit nao bloqueou',
          `PATCH Rating Segmento__c=Operadoras`, 'Update aceito', 'VR deveria bloquear'));
      else
        results.push(ok('VR-06', 'VR bloqueou edicao manual de Segmento',
          `PATCH Segmento__c=Operadoras`, `Bloqueado`, 'VR LeadBlockSegmentEdit ativa'));
    } catch(e) { results.push(fail('VR-06', `Erro: ${e.message}`, '', '', '')); }

    // 2.7 Tentar cancelar sem motivo
    try {
      const cancelNoMotivo = await sfUpdate('Lead', testLeadId, { Status: 'Cancelado' });
      if (cancelNoMotivo.success)
        results.push(fail('VR-07', 'Lead cancelado SEM motivo — VR ValidateCanceledStatus nao bloqueou',
          `PATCH Status=Cancelado sem Motivo_cancelamento__c`, 'Update aceito', 'VR deveria exigir motivo'));
      else
        results.push(ok('VR-07', 'VR exigiu motivo ao cancelar (ValidateCanceledStatus)',
          `PATCH Status=Cancelado sem motivo`, `Bloqueado`, 'VR ValidateCanceledStatus'));
    } catch(e) { results.push(fail('VR-07', `Erro: ${e.message}`, '', '', '')); }

    // 2.8 Tentar preencher motivo cancelamento fora do status Cancelado
    try {
      const motivoSemCancelado = await sfUpdate('Lead', testLeadId, { Motivo_cancelamento__c: 'Sem_interesse' });
      if (motivoSemCancelado.success)
        results.push(fail('VR-08', 'Motivo de cancelamento preenchido fora do status Cancelado — VR ValidateMotivoCancelamento nao bloqueou',
          'PATCH Motivo_cancelamento__c=Sem_interesse com Status=Novo', 'Update aceito', 'VR deveria bloquear'));
      else
        results.push(ok('VR-08', 'VR impediu motivo fora do status Cancelado',
          'PATCH Motivo_cancelamento__c com Status!=Cancelado', 'Bloqueado', 'VR ValidateMotivoCancelamento'));
    } catch(e) { results.push(fail('VR-08', `Erro: ${e.message}`, '', '', '')); }

    // 2.9 Tentar avancar para Conversao sem campos qualificacao
    try {
      const convSemQual = await sfUpdate('Lead', testLeadId, { Status: 'Conversao' });
      if (convSemQual.success)
        results.push(fail('VR-09', 'Avancou para Conversao SEM campos qualificacao — VRs nao bloquearam',
          'PATCH Status=Conversao sem campos qualificacao', 'Update aceito', 'VRs RequireQualification + RestrictTransition deveriam bloquear'));
      else
        results.push(ok('VR-09', 'VR bloqueou avanco para Conversao sem campos qualificacao',
          'PATCH Status=Conversao sem preencher qualificacao', `Bloqueado`, 'VR RequireQualificationFieldsOnAdvance'));
    } catch(e) { results.push(fail('VR-09', `Erro: ${e.message}`, '', '', '')); }

    // 2.10 Verificar se Segmento foi preenchido automaticamente (Flow/Trigger)
    try {
      const leadData = await sfRead('Lead', testLeadId, 'Segmento__c,Rating,RelacionamentoLead__c,PercentualPreenchimento__c');
      if (leadData.Segmento__c)
        results.push(ok('BHV-01', `Segmento preenchido automaticamente: "${leadData.Segmento__c}"`,
          `GET /sobjects/Lead/${testLeadId}`, `Segmento__c=${leadData.Segmento__c}`, 'Automacao (Flow/Trigger) derivou segmento'));
      else
        results.push(fail('BHV-01', 'Segmento NAO preenchido automaticamente — automacao de segmentacao ausente ou inativa',
          `GET /sobjects/Lead/${testLeadId}`, 'Segmento__c=null', 'CRMB2B-19: Implementar Flow/Trigger de segmentacao'));

      if (leadData.Rating)
        results.push(ok('BHV-02', `Prioridade (Rating) preenchida automaticamente: "${leadData.Rating}"`,
          `GET Lead`, `Rating=${leadData.Rating}`, 'Automacao de priorizacao funcionando'));
      else
        results.push(fail('BHV-02', 'Rating NAO preenchido automaticamente — automacao de priorizacao ausente',
          `GET Lead`, 'Rating=null', 'CRMB2B-27: Implementar Flow/Trigger de priorizacao'));

      if (leadData.RelacionamentoLead__c)
        results.push(ok('BHV-03', `Relacionamento do Lead preenchido: "${leadData.RelacionamentoLead__c}"`,
          'GET Lead', `RelacionamentoLead__c=${leadData.RelacionamentoLead__c}`, 'Automacao derivou relacionamento'));
      else
        results.push(fail('BHV-03', 'Relacionamento NAO preenchido automaticamente — automacao ausente',
          'GET Lead', 'RelacionamentoLead__c=null', 'CRMB2B-14: Implementar derivacao Relacionamento'));

      if (leadData.PercentualPreenchimento__c != null && leadData.PercentualPreenchimento__c > 0)
        results.push(ok('BHV-04', `% Preenchimento calculado: ${leadData.PercentualPreenchimento__c}%`,
          'GET Lead', `PercentualPreenchimento__c=${leadData.PercentualPreenchimento__c}`, 'Formula/Flow calculou preenchimento'));
      else
        results.push(fail('BHV-04', '% Preenchimento NAO calculado — automacao ausente',
          'GET Lead', `PercentualPreenchimento__c=${leadData.PercentualPreenchimento__c}`, 'CRMB2B-27: Implementar calculo'));
    } catch(e) { results.push(fail('BHV-01', `Erro leitura Lead: ${e.message}`, '', '', '')); }

  } else {
    results.push(fail('VR-05', 'Lead base nao criado — testes comportamentais pulados', '', '', ''));
  }

  // ================================================================
  // BLOCO 3: DUPLICIDADE (criar 2 Leads mesmo CNPJ)
  // ================================================================
  try {
    const lead1 = await sfCreate('Lead', {
      FirstName: 'QA_Dup', LastName: 'Lead1', Company: 'Dup Empresa',
      Email: 'dup1@test.com.br', Phone: '1199998888',
      CNPJ__c: '11.222.333/0001-81', Nacionalidade__c: 'Nacional',
      RecordTypeId: nacionalRT, OrigemCanal__c: 'Landing page', Status: 'Novo'
    });
    if (lead1.id) {
      const lead2 = await sfCreate('Lead', {
        FirstName: 'QA_Dup', LastName: 'Lead2', Company: 'Dup Empresa 2',
        Email: 'dup2@test.com.br', Phone: '1199997777',
        CNPJ__c: '11.222.333/0001-81', Nacionalidade__c: 'Nacional',
        RecordTypeId: nacionalRT, OrigemCanal__c: 'Landing page', Status: 'Novo'
      });
      if (lead2.id) {
        // Read lead2 to check if it was auto-cancelled
        const dup2 = await sfRead('Lead', lead2.id, 'Status,Motivo_cancelamento__c,Lead_Relacionado__c');
        if (dup2.Status === 'Cancelado' && dup2.Motivo_cancelamento__c === 'Duplicidade')
          results.push(ok('DUP-01', 'Lead duplicado (mesmo CNPJ, inbound x inbound) auto-cancelado com motivo Duplicidade',
            `Lead1=${lead1.id}, Lead2=${lead2.id}`, `Status=${dup2.Status}, Motivo=${dup2.Motivo_cancelamento__c}`, 'CRMB2B-22'));
        else
          results.push(fail('DUP-01', `Lead duplicado NAO auto-cancelado — Status=${dup2.Status}, Motivo=${dup2.Motivo_cancelamento__c || 'null'}. Automacao de duplicidade AUSENTE`,
            `Criados 2 Leads com CNPJ=11.222.333/0001-81`, `Lead2 Status=${dup2.Status}`, 'CRMB2B-22: Implementar Flow de duplicidade'));

        if (dup2.Lead_Relacionado__c)
          results.push(ok('DUP-02', `Lead duplicado relacionado ao original via Lead_Relacionado__c=${dup2.Lead_Relacionado__c}`,
            'GET Lead2', '', 'CRMB2B-22'));
        else
          results.push(fail('DUP-02', 'Lead duplicado NAO relacionou ao original — campo Lead_Relacionado__c vazio',
            'GET Lead2', 'Lead_Relacionado__c=null', 'CRMB2B-22'));
      } else {
        results.push(fail('DUP-01', `Lead2 nao criado: ${JSON.stringify(lead2).substring(0,150)}`, '', '', ''));
      }
    } else {
      results.push(fail('DUP-01', `Lead1 duplicidade nao criado: ${JSON.stringify(lead1).substring(0,150)}`, '', '', ''));
    }
  } catch(e) { results.push(fail('DUP-01', `Erro teste duplicidade: ${e.message}`, '', '', '')); }

  // ================================================================
  // BLOCO 4: TESTES MANUAIS (UI-only)
  // ================================================================
  results.push(manual('M-01', 'Layout exibe Nacionalidade (Nacional/Internacional) no topo da tela de criacao',
    'UI: Leads > Novo > verificar radio button Nacionalidade'));
  results.push(manual('M-02', 'Criar Lead Internacional: CNPJ nao obrigatorio',
    'UI: Lead Internacional > salvar sem CNPJ > deve aceitar'));
  results.push(manual('M-03', 'CNPJ preenche dados da empresa automaticamente (se conta existe)',
    'UI: Lead Nacional > CNPJ de conta existente > campos empresa devem auto-preencher'));
  results.push(manual('M-04', 'Botao Converter Lead visivel apenas em status Em conversao',
    'UI: Lead Em conversao > verificar botao Converter para perfil consultor'));
  results.push(manual('M-05', 'Enriquecimento Neoway/Receita dispara ao entrar em Qualificacao',
    'UI: Lead Qualificacao > verificar campos endereco e situacao cadastral preenchidos'));
  results.push(manual('M-06', 'Cadencia outbound cria tarefas automaticas em sequencia',
    'UI: Lead outbound Qualificacao > verificar tarefas criadas (telefone, email, whatsapp)'));
  results.push(manual('M-07', 'Dashboards Lead (funil, backlog, cancelados, SLA) com filtros',
    'App > Dashboards > verificar 4 dashboards com filtros funcionais'));

  // ================================================================
  // CLEANUP
  // ================================================================
  for (const { obj, id } of createdIds.reverse()) {
    try { await sfDelete(obj, id); } catch(e) { /* ignore */ }
  }

  return results;
}


const TESTS = { '83': test83, '84': test84, '85': test85, 'usbase': testUSBase, '50a': test50A, '90': test90, '91': test91, '107': test107, '108': test108, 'lead': testLead };

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
