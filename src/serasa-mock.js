import { Router } from 'express';
const router = Router();

// ============================================================
// MOCK SERASA API — Contrato COMPLETO conforme planilha de mapeamento
// Retorna TODOS os campos do Serasa, inclusive os não mapeados no SF
// ============================================================

const MOCK_DB = {
  '71208516000174': {
    // Dados cadastrais
    razaoSocial: 'ALGAR TELECOM S/A',
    nomeFantasia: 'ALGAR TELECOM',
    situacaoCnpj: 'ATIVA',
    dataFundacao: '1954-11-06',
    dataSituacaoCadastral: '2011-10-28',
    dataConsulta: '2026-06-26 10:00:00',
    // CNAE
    cnaeCodigo: '6110801',
    cnaeDescricao: 'Servicos de telefonia fixa comutada - STFC',
    cnaeSecundario: [
      { codigo: '6120501', descricao: 'Telefonia movel celular' },
      { codigo: '6190699', descricao: 'Outras atividades de telecomunicacoes' }
    ],
    // Natureza Juridica
    njCodigo: '2046',
    njDescricao: 'SOCIEDADE ANONIMA ABERTA',
    // Inscricao Estadual / Sintegra
    inscricaoEstadual: '702235524',
    ufIe: 'MG',
    situacaoIe: 'HABILITADO',
    // Porte e classificacao
    porte: 'GRANDE',
    receitaPresumida: 'ACIMA DE R$ 300 MM',
    riskTriage: 'Baixo',
    // Simples Nacional
    simplesNacional: 'N',
    // Matriz/Filial
    nivelConta: 'M',
    // Situacao especial
    situacaoEspecial: '',
    dataSituacaoEspecial: '',
    // Endereco
    endereco: {
      logradouro: 'Rua Jose Alves Garcia',
      numero: '415',
      complemento: 'Bloco A',
      bairro: 'Centro',
      cidade: 'Uberlandia',
      uf: 'MG',
      cep: '38400668',
      codIBGE: '3170206',
      pais: 'BR'
    },
    // Indicador operacional
    indicadorOperacional: 'SIM',
    // Status fixo
    status: 'SUCCESS'
  },
  '12345678000190': {
    razaoSocial: 'EMPRESA TESTE LTDA', nomeFantasia: 'TESTE COMERCIAL',
    situacaoCnpj: 'ATIVA', dataFundacao: '2020-03-15', dataSituacaoCadastral: '2020-03-15',
    dataConsulta: '2026-06-26 10:00:00',
    cnaeCodigo: '4751201', cnaeDescricao: 'Comercio varejista especializado de equipamentos e suprimentos de informatica',
    cnaeSecundario: [{ codigo: '4751202', descricao: 'Recarga de cartuchos para equipamentos de informatica' }],
    njCodigo: '2062', njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: '123456789', ufIe: 'SP', situacaoIe: 'HABILITADO',
    porte: 'MEDIO', receitaPresumida: 'DE R$ 2,4 MM A R$ 10 MM', riskTriage: 'Medio',
    simplesNacional: 'P', nivelConta: 'M',
    situacaoEspecial: '', dataSituacaoEspecial: '',
    endereco: { logradouro: 'Av Paulista', numero: '1000', complemento: 'Sala 501', bairro: 'Bela Vista', cidade: 'Sao Paulo', uf: 'SP', cep: '01310100', codIBGE: '3550308', pais: 'BR' },
    indicadorOperacional: 'SIM', status: 'SUCCESS'
  },
  '99999999000199': {
    razaoSocial: 'EMPRESA BAIXADA LTDA', nomeFantasia: 'BAIXADA COM',
    situacaoCnpj: 'BAIXADA', dataFundacao: '2000-01-01', dataSituacaoCadastral: '2023-06-15',
    dataConsulta: '2026-06-26 10:00:00',
    cnaeCodigo: '4711301', cnaeDescricao: 'Comercio varejista de mercadorias em geral',
    cnaeSecundario: [],
    njCodigo: '2062', njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: '', ufIe: '', situacaoIe: '',
    porte: 'PEQUENO', receitaPresumida: 'ATE R$ 240 MIL', riskTriage: 'Alto',
    simplesNacional: 'N', nivelConta: 'M',
    situacaoEspecial: 'EMPRESA EM LIQUIDACAO EXTRAJUDICIAL', dataSituacaoEspecial: '2023-01-10',
    endereco: { logradouro: 'Rua da Baixa', numero: '10', complemento: '', bairro: 'Industrial', cidade: 'Belo Horizonte', uf: 'MG', cep: '30000000', codIBGE: '3106200', pais: 'BR' },
    indicadorOperacional: 'NAO', status: 'SUCCESS'
  },
  '11111111000111': {
    razaoSocial: 'EMPRESA PARCIAL S/A', nomeFantasia: '',
    situacaoCnpj: 'ATIVA', dataFundacao: '2018-07-01', dataSituacaoCadastral: '2018-07-01',
    dataConsulta: '2026-06-26 10:00:00',
    cnaeCodigo: '6201501', cnaeDescricao: 'Desenvolvimento de programas de computador sob encomenda',
    cnaeSecundario: [{ codigo: '6202300', descricao: 'Desenvolvimento e licenciamento de programas customizaveis' }],
    njCodigo: '2046', njDescricao: 'SOCIEDADE ANONIMA ABERTA',
    inscricaoEstadual: '', ufIe: '', situacaoIe: '',
    porte: 'MEDIO', receitaPresumida: 'DE R$ 10 MM A R$ 50 MM', riskTriage: 'Baixo',
    simplesNacional: 'N', nivelConta: 'F',
    situacaoEspecial: '', dataSituacaoEspecial: '',
    endereco: { logradouro: 'Av Brasil', numero: '500', complemento: '2o Andar', bairro: 'Funcionarios', cidade: 'Belo Horizonte', uf: 'MG', cep: '30140000', codIBGE: '3106200', pais: 'BR' },
    indicadorOperacional: 'SIM', status: 'SUCCESS'
  },
  '22222222000122': {
    razaoSocial: 'SECRETARIA DA FAZENDA DE MG', nomeFantasia: 'SEFAZ MG',
    situacaoCnpj: 'ATIVA', dataFundacao: '1891-06-14', dataSituacaoCadastral: '2005-09-02',
    dataConsulta: '2026-06-26 10:00:00',
    cnaeCodigo: '8411600', cnaeDescricao: 'Administracao publica em geral',
    cnaeSecundario: [],
    njCodigo: '1104', njDescricao: 'AUTARQUIA ESTADUAL OU DO DISTRITO FEDERAL',
    inscricaoEstadual: 'ISENTO', ufIe: 'MG', situacaoIe: 'ISENTO',
    porte: 'GRANDE', receitaPresumida: 'ACIMA DE R$ 300 MM', riskTriage: 'Baixo',
    simplesNacional: 'N', nivelConta: 'M',
    situacaoEspecial: '', dataSituacaoEspecial: '',
    endereco: { logradouro: 'Rodovia Papa Joao Paulo II', numero: '4001', complemento: 'Ed Minas', bairro: 'Serra Verde', cidade: 'Belo Horizonte', uf: 'MG', cep: '31630900', codIBGE: '3106200', pais: 'BR' },
    indicadorOperacional: 'SIM', status: 'SUCCESS'
  }
};

function gerarEmpresa(cnpj) {
  return {
    razaoSocial: 'EMPRESA ' + cnpj.substring(0, 8) + ' LTDA',
    nomeFantasia: 'COMERCIO ' + cnpj.substring(0, 4),
    situacaoCnpj: 'ATIVA', dataFundacao: '2015-01-01', dataSituacaoCadastral: '2015-01-01',
    dataConsulta: new Date().toISOString().replace('T',' ').substring(0,19),
    cnaeCodigo: '4751201', cnaeDescricao: 'Comercio varejista especializado de equipamentos e suprimentos de informatica',
    cnaeSecundario: [{ codigo: '5211799', descricao: 'Depositos de mercadorias para terceiros' }],
    njCodigo: '2062', njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: cnpj.substring(0, 9), ufIe: 'SP', situacaoIe: 'HABILITADO',
    porte: 'MEDIO', receitaPresumida: 'DE R$ 240,01 MIL A R$ 2,4 MM', riskTriage: 'Medio',
    simplesNacional: 'N', nivelConta: 'M',
    situacaoEspecial: '', dataSituacaoEspecial: '',
    endereco: { logradouro: 'Rua Gerada Automaticamente', numero: '100', complemento: '', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'SP', cep: '01000000', codIBGE: '3550308', pais: 'BR' },
    indicadorOperacional: 'SIM', status: 'SUCCESS'
  };
}

// Rota principal
router.get('/consulta/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, '');
  console.log('[serasa-mock] Consulta CNPJ: ' + cnpj);
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout', cnpj }), 12000);
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  console.log('[serasa-mock] Hit: ' + raw.razaoSocial + ' | ' + raw.situacaoCnpj);
  return res.json(raw);
});

// Catch-all CNPJs formatados
router.get('/consulta/*', (req, res) => {
  const rawPath = req.params[0] || '';
  const cnpj = rawPath.replace(/[^0-9]/g, '');
  console.log('[serasa-mock] Catch-all CNPJ: ' + rawPath + ' -> ' + cnpj);
  if (!cnpj || cnpj.length < 11) return res.status(400).json({ error: 'CNPJ invalido', raw: rawPath });
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 12000);
  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  console.log('[serasa-mock] Hit: ' + raw.razaoSocial);
  return res.json(raw);
});

// V1 rotas
router.get('/v1/consulta/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, '');
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 12000);
  return res.json(MOCK_DB[cnpj] || gerarEmpresa(cnpj));
});
router.get('/v1/consulta/*', (req, res) => {
  const cnpj = (req.params[0]||'').replace(/[^0-9]/g, '');
  if (!cnpj || cnpj.length < 11) return res.status(400).json({ error: 'CNPJ invalido' });
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  return res.json(MOCK_DB[cnpj] || gerarEmpresa(cnpj));
});

// Health
router.get('/health', (req, res) => res.json({ status: 'ok', service: 'serasa-mock', cnpjs: Object.keys(MOCK_DB).length }));
router.get('/v1/health', (req, res) => res.json({ status: 'ok', service: 'algar-serasa-api', version: '1.0', env: 'mock' }));

export default router;
