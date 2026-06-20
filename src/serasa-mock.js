import express from 'express';
const router = express.Router();

const MOCK_DB = {
  '71208516000174': {
    razaoSocial: 'ALGAR TELECOM S/A', nomeFantasia: 'ALGAR TELECOM', dataFundacao: '1954-11-06',
    cnaePrincipal: { codigo: '6110801' }, naturezaJuridica: { codigo: '2046' },
    inscricaoEstadual: '702235524', ufIe: 'MG', situacaoIe: 'ATIVO',
    situacaoCnpj: 'ATIVA', porte: 'GRANDE',
    endereco: { logradouro: 'Rua Jose Alves Garcia', numero: '415', bairro: 'Centro', complemento: '', cep: '38400-668', cidade: 'Uberlandia', uf: 'MG', pais: 'BR' }
  },
  '12345678000190': {
    razaoSocial: 'EMPRESA TESTE LTDA', nomeFantasia: 'TESTE COMERCIAL', dataFundacao: '2010-03-15',
    cnaePrincipal: { codigo: '4751201' }, naturezaJuridica: { codigo: '2062' },
    inscricaoEstadual: '123456789', ufIe: 'SP', situacaoIe: 'ATIVO',
    situacaoCnpj: 'ATIVA', porte: 'MEDIO',
    endereco: { logradouro: 'Av Paulista', numero: '1000', bairro: 'Bela Vista', complemento: 'Sala 501', cep: '01310-100', cidade: 'Sao Paulo', uf: 'SP', pais: 'BR' }
  },
  '99999999000199': {
    razaoSocial: 'EMPRESA BAIXADA LTDA', nomeFantasia: 'BAIXADA COMERCIO', dataFundacao: '2005-06-20',
    cnaePrincipal: { codigo: '4711302' }, naturezaJuridica: { codigo: '2062' },
    inscricaoEstadual: '', ufIe: '', situacaoIe: '',
    situacaoCnpj: 'BAIXADA', porte: 'PEQUENO',
    endereco: { logradouro: 'Rua Teste', numero: '1', bairro: 'Centro', complemento: '', cep: '30000-000', cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR' }
  },
  '11111111000111': {
    razaoSocial: 'EMPRESA PARCIAL SA', nomeFantasia: null, dataFundacao: '2018-01-10',
    cnaePrincipal: { codigo: '6201501' }, naturezaJuridica: { codigo: '2046' },
    inscricaoEstadual: null, ufIe: null, situacaoIe: null,
    situacaoCnpj: 'ATIVA', porte: null,
    endereco: { logradouro: 'Rua Dev', numero: '42', bairro: 'Tech', complemento: null, cep: '01001-000', cidade: 'Sao Paulo', uf: 'SP', pais: 'BR' }
  },
  '22222222000122': {
    razaoSocial: 'SECRETARIA DE FAZENDA DO ESTADO DE MG', nomeFantasia: 'SEFAZ MG', dataFundacao: '1891-06-14',
    cnaePrincipal: { codigo: '8411600' }, naturezaJuridica: { codigo: '1040' },
    inscricaoEstadual: 'ISENTO', ufIe: 'MG', situacaoIe: 'NAO HABILITADO',
    situacaoCnpj: 'ATIVA', porte: 'GRANDE',
    endereco: { logradouro: 'Rodovia Papa Joao Paulo II', numero: '4001', bairro: 'Serra Verde', complemento: '', cep: '31630-901', cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR' }
  }
};

router.get('/consulta/:cnpj', (req, res) => {
  const cnpj = req.params.cnpj.replace(/[^0-9]/g, '');
  console.log(`[serasa-mock] Consulta CNPJ: ${cnpj}`);
  if (cnpj === '00000000000000') return res.status(404).json({ error: 'CNPJ nao encontrado na base Serasa', cnpj });
  if (cnpj === '88888888000188') return setTimeout(() => res.status(504).json({ error: 'Gateway Timeout' }), 12000);
  if (MOCK_DB[cnpj]) { console.log(`[serasa-mock] Hit: ${MOCK_DB[cnpj].razaoSocial}`); return res.json(MOCK_DB[cnpj]); }
  res.json({
    razaoSocial: 'EMPRESA ' + cnpj.substring(0, 8) + ' LTDA', nomeFantasia: 'COMERCIO ' + cnpj.substring(0, 4),
    dataFundacao: '2015-01-01', cnaePrincipal: { codigo: '4751201' }, naturezaJuridica: { codigo: '2062' },
    inscricaoEstadual: cnpj.substring(0, 9), ufIe: 'SP', situacaoIe: 'ATIVO',
    situacaoCnpj: 'ATIVA', porte: 'MEDIO',
    endereco: { logradouro: 'Rua Gerada', numero: '100', bairro: 'Centro', complemento: '', cep: '01000-000', cidade: 'Sao Paulo', uf: 'SP', pais: 'BR' }
  });
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'serasa-mock', version: '1.0', cnpjs_mock: Object.keys(MOCK_DB).length });
});

export default router;
