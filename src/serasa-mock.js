import { Router } from 'express';
const router = Router();

// ============================================================
// MOCK SERASA API — Contrato completo conforme mapeamento
// Campos: Razão Social, Nome Fantasia, Situação CNPJ, Data Fundação,
// CNAE (código + descrição), NJ (código + descrição), IE, UF IE,
// Situação IE, Porte, Endereço completo, Simples Nacional,
// Situação Especial, Nível Conta (Matriz/Filial), Data Situação
// ============================================================

const MOCK_DB = {
  '71208516000174': {
    razaoSocial: 'ALGAR TELECOM S/A',
    nomeFantasia: 'ALGAR TELECOM',
    situacaoCnpj: 'ATIVA',
    dataFundacao: '1954-11-06',
    cnaeCodigo: '6110801',
    cnaeDescricao: 'Serviços de telefonia fixa comutada - STFC',
    njCodigo: '2046',
    njDescricao: 'SOCIEDADE ANONIMA ABERTA',
    inscricaoEstadual: '702235524',
    ufIe: 'MG',
    situacaoIe: 'HABILITADO',
    situacaoCnpj: 'ATIVA',
    porte: 'GRANDE',
    simplesNacional: 'N',
    nivelConta: 'M',
    situacaoEspecial: '',
    dataSituacaoCadastral: '2011-10-28',
    endereco: {
      logradouro: 'Rua Jose Alves Garcia',
      numero: '415',
      complemento: 'Bloco A',
      bairro: 'Centro',
      cidade: 'Uberlandia',
      uf: 'MG',
      cep: '38400668'
    }
  },
  '12345678000190': {
    razaoSocial: 'EMPRESA TESTE LTDA',
    nomeFantasia: 'TESTE COMERCIAL',
    situacaoCnpj: 'ATIVA',
    dataFundacao: '2020-03-15',
    cnaeCodigo: '4751201',
    cnaeDescricao: 'Comercio varejista especializado de equipamentos e suprimentos de informatica',
    njCodigo: '2062',
    njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: '123456789',
    ufIe: 'SP',
    situacaoIe: 'HABILITADO',
    porte: 'MEDIO',
    simplesNacional: 'P',
    nivelConta: 'M',
    situacaoEspecial: '',
    dataSituacaoCadastral: '2020-03-15',
    endereco: {
      logradouro: 'Av Paulista',
      numero: '1000',
      complemento: 'Sala 501',
      bairro: 'Bela Vista',
      cidade: 'Sao Paulo',
      uf: 'SP',
      cep: '01310100'
    }
  },
  '99999999000199': {
    razaoSocial: 'EMPRESA BAIXADA LTDA',
    nomeFantasia: 'BAIXADA COM',
    situacaoCnpj: 'BAIXADA',
    dataFundacao: '2000-01-01',
    cnaeCodigo: '4711301',
    cnaeDescricao: 'Comercio varejista de mercadorias em geral com predominancia de produtos alimenticios',
    njCodigo: '2062',
    njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: '',
    ufIe: '',
    situacaoIe: '',
    porte: 'PEQUENO',
    simplesNacional: 'N',
    nivelConta: 'M',
    situacaoEspecial: 'EMPRESA EM LIQUIDACAO EXTRAJUDICIAL',
    dataSituacaoCadastral: '2023-06-15',
    endereco: {
      logradouro: 'Rua da Baixa',
      numero: '10',
      complemento: '',
      bairro: 'Industrial',
      cidade: 'Belo Horizonte',
      uf: 'MG',
      cep: '30000000'
    }
  },
  '11111111000111': {
    razaoSocial: 'EMPRESA PARCIAL S/A',
    nomeFantasia: '',
    situacaoCnpj: 'ATIVA',
    dataFundacao: '2018-07-01',
    cnaeCodigo: '6201501',
    cnaeDescricao: 'Desenvolvimento de programas de computador sob encomenda',
    njCodigo: '2046',
    njDescricao: 'SOCIEDADE ANONIMA ABERTA',
    inscricaoEstadual: '',
    ufIe: '',
    situacaoIe: '',
    porte: 'MEDIO',
    simplesNacional: 'N',
    nivelConta: 'F',
    situacaoEspecial: '',
    dataSituacaoCadastral: '2018-07-01',
    endereco: {
      logradouro: 'Av Brasil',
      numero: '500',
      complemento: '2o Andar',
      bairro: 'Funcionarios',
      cidade: 'Belo Horizonte',
      uf: 'MG',
      cep: '30140000'
    }
  },
  '22222222000122': {
    razaoSocial: 'SECRETARIA DA FAZENDA DE MG',
    nomeFantasia: 'SEFAZ MG',
    situacaoCnpj: 'ATIVA',
    dataFundacao: '1891-06-14',
    cnaeCodigo: '8411600',
    cnaeDescricao: 'Administracao publica em geral',
    njCodigo: '1104',
    njDescricao: 'AUTARQUIA ESTADUAL OU DO DISTRITO FEDERAL',
    inscricaoEstadual: 'ISENTO',
    ufIe: 'MG',
    situacaoIe: 'ISENTO',
    porte: 'GRANDE',
    simplesNacional: 'N',
    nivelConta: 'M',
    situacaoEspecial: '',
    dataSituacaoCadastral: '2005-09-02',
    endereco: {
      logradouro: 'Rodovia Papa Joao Paulo II',
      numero: '4001',
      complemento: 'Ed Minas',
      bairro: 'Serra Verde',
      cidade: 'Belo Horizonte',
      uf: 'MG',
      cep: '31630900'
    }
  }
};

// Helper: gera empresa dinamica para CNPJs nao cadastrados
function gerarEmpresa(cnpj) {
  return {
    razaoSocial: 'EMPRESA ' + cnpj.substring(0, 8) + ' LTDA',
    nomeFantasia: 'COMERCIO ' + cnpj.substring(0, 4),
    situacaoCnpj: 'ATIVA',
    dataFundacao: '2015-01-01',
    cnaeCodigo: '4751201',
    cnaeDescricao: 'Comercio varejista especializado de equipamentos e suprimentos de informatica',
    njCodigo: '2062',
    njDescricao: 'SOCIEDADE EMPRESARIA LIMITADA',
    inscricaoEstadual: cnpj.substring(0, 9),
    ufIe: 'SP',
    situacaoIe: 'HABILITADO',
    porte: 'MEDIO',
    simplesNacional: 'N',
    nivelConta: 'M',
    situacaoEspecial: '',
    dataSituacaoCadastral: '2015-01-01',
    endereco: {
      logradouro: 'Rua Gerada Automaticamente',
      numero: '100',
      complemento: '',
      bairro: 'Centro',
      cidade: 'Sao Paulo',
      uf: 'SP',
      cep: '01000000'
    }
  };
}

// ============================================================
// Rota principal: GET /consulta/:cnpj
// ============================================================
router.get('/consulta/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, '');
  console.log('[serasa-mock] Consulta CNPJ: ' + cnpj);

  if (cnpj === '88888888000188') {
    return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout', cnpj }), 12000);
  }
  if (cnpj === '00000000000000') {
    return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  }

  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  console.log('[serasa-mock] Hit: ' + raw.razaoSocial + ' | ' + raw.situacaoCnpj);
  return res.json(raw);
});

// Catch-all para CNPJs formatados (com barras/pontos)
router.get('/consulta/*', (req, res) => {
  const rawPath = req.params[0] || '';
  const cnpj = rawPath.replace(/[^0-9]/g, '');
  console.log('[serasa-mock] Catch-all CNPJ: ' + rawPath + ' -> ' + cnpj);

  if (!cnpj || cnpj.length < 11) {
    return res.status(400).json({ error: 'CNPJ invalido', raw: rawPath });
  }
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 12000);

  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  console.log('[serasa-mock] Hit: ' + raw.razaoSocial);
  return res.json(raw);
});

// V1 API — contrato identico, path alternativo
router.get('/v1/consulta/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, '');
  console.log('[serasa-api-v1] Consulta CNPJ: ' + cnpj);
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 12000);
  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  console.log('[serasa-api-v1] OK: ' + raw.razaoSocial);
  return res.json(raw);
});

// V1 catch-all formatado
router.get('/v1/consulta/*', (req, res) => {
  const rawPath = req.params[0] || '';
  const cnpj = rawPath.replace(/[^0-9]/g, '');
  if (!cnpj || cnpj.length < 11) return res.status(400).json({ error: 'CNPJ invalido' });
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado', cnpj });
  const raw = MOCK_DB[cnpj] || gerarEmpresa(cnpj);
  return res.json(raw);
});

// Health checks
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'serasa-mock', cnpjs: Object.keys(MOCK_DB).length });
});
router.get('/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'algar-serasa-api', version: '1.0', env: 'mock' });
});

export default router;
