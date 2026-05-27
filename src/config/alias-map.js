// src/config/alias-map.js — PT-BR → API Names
const aliases = {
  // Objetos
  'lead':         'Lead',
  'leads':        'Lead',
  'conta':        'Account',
  'contas':       'Account',
  'contato':      'Contact',
  'contatos':     'Contact',
  'oportunidade': 'Opportunity',
  'oportunidades':'Opportunity',
  'caso':         'Case',
  'casos':        'Case',
  'pedido':       'Order',
  'pedidos':      'Order',
  'cotacao':      'Quote',
  'cotacoes':     'Quote',
  'produto':      'Product2',
  'produtos':     'Product2',
  'ativo':        'Asset',
  'ativos':       'Asset',
  'contrato':     'Contract',
  'contratos':    'Contract',
  'campanha':     'Campaign',
  'campanhas':    'Campaign',
  'tarefa':       'Task',
  'tarefas':      'Task',
  'evento':       'Event',
  'eventos':      'Event',
  'usuario':      'User',
  'usuarios':     'User',
  'perfil':       'Profile',
  'perfis':       'Profile',
};

function resolve(input) {
  const key = input.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return aliases[key] || input;
}

module.exports = { aliases, resolve };
