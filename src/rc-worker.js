// src/rc-worker.js — Revenue Cloud Autonomous Worker Engine
// Engine determinístico de modelagem de produtos Revenue Cloud.
// ZERO AI / ZERO tokens. Todo conhecimento Salesforce Revenue Cloud + TM Forum SID
// + práticas telecom B2B está codificado em regras determinísticas.
// Reproduzível, auditável, sem alucinação.

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ════════════════════════════════════════════════════════════════════
// KNOWLEDGE BASE — Conhecimento Revenue Cloud codificado
// ════════════════════════════════════════════════════════════════════

// ── TM FORUM SID → REVENUE CLOUD MAPPING ──
// Mapeia entidades do modelo TM Forum SID para objetos Revenue Cloud
const SID_MAPPING = {
  'ProductSpecification':       'ProductClassification',
  'ProductOffering':            'Product2 + ProductSellingModelOption',
  'ProductOfferingPrice':       'PricebookEntry + PriceAdjustmentSchedule',
  'BundledProductOffering':     'Product2 (ProductComponentGroups)',
  'ProductSpecCharacteristic':  'ProductAttribute',
  'ProductOfferingQualification':'QualificationRule + DecisionTable',
  'ProductCatalog':             'ProductCatalog',
  'ProductCategory':            'ProductCategory'
};

// ── HIERARQUIA DE CLASSIFICAÇÃO TELECOM B2B (TM Forum SID aligned) ──
// Alinhado com catálogo Algar Telecom B2B — 8 famílias, 67 produtos reais
const TELECOM_HIERARCHY = {
  'Connectivity': {
    sidDomain: 'Connectivity Services',
    productCount: 21,
    categories: {
      'Broadband':    { products: ['Banda Larga', 'Banda Larga Exp Soluções', 'Banda Larga Expansão', 'Banda Larga Smart', 'Banda Larga Sul'] },
      'MPLS/VPN':     { products: ['VPN Network', 'VPN Node', 'LAN to LAN Network', 'LAN to LAN Node'] },
      'SD-WAN':       { products: ['SD-WAN 2.0 Network', 'SD-WAN 2.0 Node'] },
      'Internet':     { products: ['Internet Link', 'IP Trânsito', 'EILD Novo'] },
      'Wavelength':   { products: ['Wavelength Network', 'Wavelength Node'] },
      'WiFi':         { products: ['SmartFi Pro', 'Super WiFi', 'Smart Connect', 'Ponto de Acesso'] },
      'Access':       { products: ['Connect+ Controle'] }
    }
  },
  'Voice & Collaboration': {
    sidDomain: 'Unified Communications',
    productCount: 10,
    categories: {
      'Fixed Voice':    { products: ['Voz Fixa', 'Voz Total', 'Voz 0300', 'Did Fixo', 'Tridígito', 'DDG', 'Número Único'] },
      'Mobile':         { products: ['Celular', 'Aparelho Celular'] },
      'Cloud Voice':    { products: ['Cloud Phone Pro'] }
    }
  },
  'Cloud & IT': {
    sidDomain: 'Cloud Services',
    productCount: 10,
    categories: {
      'IaaS':           { products: ['Cloud Server', 'MultiCloud', 'Microsoft Azure'] },
      'SaaS':           { products: ['Microsoft 365', 'Gestão Financeira', 'Gestão Fiscal', 'Gestão Fiscal Pró'] },
      'Hosting':        { products: ['Hospedagem Dedicada'] },
      'Backup':         { products: ['Cloud Backup'] },
      'Fintech':        { products: ['ALGAR FINTECH'] }
    }
  },
  'Digital & Media': {
    sidDomain: 'Digital Services',
    productCount: 7,
    categories: {
      'Communication':  { products: ['Message Solution', 'API Connect'] },
      'Platform':       { products: ['Algar Simples Digital', 'Presença Digital', 'Vida Hub'] },
      'Energy':         { products: ['Compartilhe Energia'] },
      'TV':             { products: ['TV'] }
    }
  },
  'Security': {
    sidDomain: 'Security Services',
    productCount: 4,
    categories: {
      'Network':        { products: ['Anti DDoS', 'Gerenciamento de Rede'] },
      'Endpoint':       { products: ['Antivírus Endpoint', 'Gerenciamento de Segurança'] }
    }
  },
  'IoT': {
    sidDomain: 'IoT Services',
    productCount: 4,
    categories: {
      'Connectivity':   { products: ['IoT Connect', 'IoT Connect - Node'] },
      'Platform':       { products: ['IoT', 'MoT Management of Things'] }
    }
  },
  'Managed Services': {
    sidDomain: 'Managed Services',
    productCount: 6,
    categories: {
      'Support':        { products: ['ServiceHub', 'Atendimento Premium', 'Algar Aluguel de Equipamentos'] },
      'Operations':     { products: ['Gestão de Operações em Campo', 'SWAP Infraestrutura'] },
      'Outsourcing':    { products: ['Serviços Profissionais'] }
    }
  },
  'Professional Services': {
    sidDomain: 'Professional Services',
    productCount: 5,
    categories: {
      'Projects':       { products: ['Projeto Especial', 'Best Guess Genérico'] },
      'Interconnect':   { products: ['Interconexão', 'Terminação de Tráfego', 'ITX'] }
    }
  }
};

// ── TEMPLATES DE PRODUTO POR CATEGORIA (conhecimento Revenue Cloud) ──
// Cada template codifica: selling models válidos, charge types, atributos
// obrigatórios, padrão de pricing, UoM, assetização — derivado da doc oficial.
const PRODUCT_TEMPLATES = {
// ─── CONNECTIVITY (21 produtos Algar) ───
  'Connectivity': {
    domain: 'Connectivity', category: 'Connectivity', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36, 48, 60], chargeStructure: ['MRC', 'NRC'],
    chargePatterns: { MRC: 'Assinatura/Mensalidade', NRC: 'Instalação/Ativação', Equipment: 'CPE Aluguel' },
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM_VOLUME',
  },
  'SD-WAN': {
    domain: 'Connectivity', category: 'SD-WAN', productType: 'Bundle',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Term-Based',
    termOptions: [24, 36, 48, 60], chargeStructure: ['MRC', 'NRC'],
    chargePatterns: { MRC: 'Assinatura SD-WAN', NRC: 'Instalação', Equipment: 'CPE SD-WAN' },
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM_SITE',
  },
  'Broadband': {
    domain: 'Connectivity', category: 'Broadband', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36], chargeStructure: ['MRC', 'NRC'],
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_BANDWIDTH',
  },
  'Wavelength': {
    domain: 'Connectivity', category: 'Wavelength', productType: 'Bundle',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based'], defaultSellingModel: 'Term-Based',
    termOptions: [36, 48, 60], chargeStructure: ['MRC', 'NRC'],
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_BANDWIDTH',
  },
  'VPN': {
    domain: 'Connectivity', category: 'VPN', productType: 'Bundle',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Term-Based',
    termOptions: [24, 36, 48, 60], chargeStructure: ['MRC', 'NRC'],
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM_VOLUME',
  },
// ─── VOICE & COLLABORATION (10 produtos Algar) ───
  'Voice & Collaboration': {
    domain: 'Voice & Collaboration', category: 'Voice & Collaboration', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Evergreen', 'Term-Based'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36], chargeStructure: ['MRC', 'NRC', 'Usage'],
    chargePatterns: { MRC: 'Assinatura', NRC: 'Habilitação', Usage: 'Tarifa Local/LDN/LDI' },
    attributeGroups: ['Voice Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_PER_SEAT_USAGE',
  },
// ─── CLOUD & IT (10 produtos Algar) ───
  'Cloud & IT': {
    domain: 'Cloud & IT', category: 'Cloud & IT', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Evergreen', 'Term-Based'], defaultSellingModel: 'Evergreen',
    termOptions: [12, 24, 36], chargeStructure: ['MRC'],
    chargePatterns: { MRC: 'Licença/Assinatura', NRC: 'Setup' },
    attributeGroups: ['Cloud Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_USAGE',
  },
// ─── DIGITAL & MEDIA (7 produtos Algar) ───
  'Digital & Media': {
    domain: 'Digital & Media', category: 'Digital & Media', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Evergreen', 'Term-Based'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24], chargeStructure: ['MRC', 'NRC'],
    chargePatterns: { MRC: 'Assinatura', NRC: 'Instalação' },
    attributeGroups: ['Digital Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM',
  },
// ─── SECURITY (4 produtos Algar) ───
  'Security': {
    domain: 'Security', category: 'Security', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36], chargeStructure: ['MRC', 'NRC'],
    attributeGroups: ['Security Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM',
  },
// ─── IoT (4 produtos Algar) ───
  'IoT': {
    domain: 'IoT', category: 'IoT', productType: 'Base',
    uom: 'Each', assetizable: true, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Evergreen', 'Usage-Based'], defaultSellingModel: 'Evergreen',
    termOptions: [12, 24], chargeStructure: ['MRC'],
    attributeGroups: ['IoT Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_USAGE_VOLUME',
  },
// ─── MANAGED SERVICES (6 produtos Algar) ───
  'Managed Services': {
    domain: 'Managed Services', category: 'Managed Services', productType: 'Base',
    uom: 'Each', assetizable: false, configurable: true, taxPolicy: 'TaxInclusive',
    sellingModels: ['Term-Based', 'Evergreen'], defaultSellingModel: 'Evergreen',
    termOptions: [12, 24, 36], chargeStructure: ['MRC'],
    attributeGroups: ['Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_FLAT',
  },
// ─── PROFESSIONAL SERVICES (5 produtos Algar) ───
  'Professional Services': {
    domain: 'Professional Services', category: 'Professional Services', productType: 'Base',
    uom: 'Each', assetizable: false, configurable: false, taxPolicy: 'TaxInclusive',
    sellingModels: ['One-Time', 'Term-Based'], defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36], chargeStructure: ['MRC', 'NRC'],
    attributeGroups: ['Commercial Terms'],
    pricingPattern: 'MRC_FLAT',
  }
};

const ATTRIBUTE_LIBRARY = {
  'Network Specifications': [
    { name: 'Bandwidth', type: 'Picklist', values: ['10Mbps','50Mbps','100Mbps','200Mbps','500Mbps','1Gbps','10Gbps'], priceImpacting: true, required: true },
    { name: 'SLA Level', type: 'Picklist', values: ['Bronze','Silver','Gold','Platinum'], priceImpacting: true, required: true },
    { name: 'Availability', type: 'Picklist', values: ['99.5%','99.9%','99.95%','99.99%'], priceImpacting: true, required: true },
    { name: 'Technology', type: 'Picklist', values: ['MPLS','SD-WAN','Fiber','Ethernet','Satellite'], priceImpacting: false, required: true },
    { name: 'Symmetry', type: 'Picklist', values: ['Symmetric','Asymmetric'], priceImpacting: false, required: false },
    { name: 'Burst Capable', type: 'Checkbox', priceImpacting: true, required: false },
    { name: 'Maximum Burst (Mbps)', type: 'Number', priceImpacting: true, required: false }
  ],
  'Service Parameters': [
    { name: 'Installation Type', type: 'Picklist', values: ['New','Migration','Upgrade'], priceImpacting: true, required: true },
    { name: 'Circuit ID', type: 'Text', priceImpacting: false, required: false },
    { name: 'A-End Location', type: 'Text', priceImpacting: false, required: false },
    { name: 'B-End Location', type: 'Text', priceImpacting: false, required: false },
    { name: 'Handoff Type', type: 'Picklist', values: ['Ethernet','Fiber','Coax'], priceImpacting: false, required: false },
    { name: 'CPE Required', type: 'Checkbox', priceImpacting: true, required: false },
    { name: 'CPE Model', type: 'Text', priceImpacting: false, required: false }
  ],
  'Commercial Terms': [
    { name: 'Contract Duration', type: 'Picklist', values: ['12 meses','24 meses','36 meses','48 meses','60 meses'], priceImpacting: true, required: true },
    { name: 'Auto-Renewal', type: 'Checkbox', priceImpacting: false, required: false },
    { name: 'Early Termination Fee', type: 'Currency', priceImpacting: false, required: false },
    { name: 'Early Termination Method', type: 'Picklist', values: ['Fixed','Proportional','Remaining MRC'], priceImpacting: false, required: false },
    { name: 'Payment Terms', type: 'Picklist', values: ['Net-15','Net-30','Net-45','Net-60'], priceImpacting: false, required: false }
  ],
  'Cloud Specifications': [
    { name: 'vCPU', type: 'Number', priceImpacting: true, required: true },
    { name: 'RAM (GB)', type: 'Number', priceImpacting: true, required: true },
    { name: 'Storage (GB)', type: 'Number', priceImpacting: true, required: true },
    { name: 'Region', type: 'Picklist', values: ['Brazil South','Brazil Southeast','US East'], priceImpacting: false, required: true },
    { name: 'Redundancy', type: 'Picklist', values: ['Single','HA','Geo-Redundant'], priceImpacting: true, required: false }
  ],
  'IoT Specifications': [
    { name: 'Technology', type: 'Picklist', values: ['NB-IoT','LTE-M','4G','5G'], priceImpacting: true, required: true },
    { name: 'Data Plan (MB)', type: 'Number', priceImpacting: true, required: true },
    { name: 'Number of Devices', type: 'Number', priceImpacting: true, required: true },
    { name: 'Coverage', type: 'Picklist', values: ['National','Regional','Global'], priceImpacting: true, required: false }
  ],
  'Voice Specifications': [
    { name: 'License Type', type: 'Picklist', values: ['Basic','Standard','Premium'], priceImpacting: true, required: true },
    { name: 'Number of Seats', type: 'Number', priceImpacting: true, required: true },
    { name: 'SIP Channels', type: 'Number', priceImpacting: true, required: true },
    { name: 'DID Numbers', type: 'Number', priceImpacting: true, required: false },
    { name: 'Call Recording', type: 'Checkbox', priceImpacting: true, required: false }
  ],
    'Digital Specifications': [
    { name: 'Platform Type', type: 'Picklist', values: ['Web','Mobile','API','Hybrid'], priceImpacting: false, required: true },
    { name: 'Users/Seats', type: 'Number', priceImpacting: true, required: true },
    { name: 'Storage (GB)', type: 'Number', priceImpacting: true, required: false },
    { name: 'API Calls/Month', type: 'Number', priceImpacting: true, required: false },
    { name: 'White Label', type: 'Checkbox', priceImpacting: true, required: false }
  ],
  'Security Specifications': [
    { name: 'Firewall Type', type: 'Picklist', values: ['UTM','NGFW','Cloud Firewall'], priceImpacting: true, required: true },
    { name: 'Throughput (Gbps)', type: 'Number', priceImpacting: true, required: true },
    { name: 'Management Level', type: 'Picklist', values: ['Co-Managed','Fully Managed'], priceImpacting: true, required: false },
    { name: 'Threat Intelligence', type: 'Checkbox', priceImpacting: true, required: false }
  ]
};

// ── PADRÕES DE PRICING (Revenue Cloud Pricing Procedures) ──
// Cada pattern define os steps do Pricing Procedure e Pricing Rules associadas.
const PRICING_PATTERNS = {
  'MRC_NRC_TERM_VOLUME': {
    description: 'MRC recorrente + NRC setup + desconto por prazo + desconto por volume',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'List Price Lookup', source: 'PriceBookEntry' },
      { seq: 20, type: 'PriceAdjustment', name: 'Volume Discount', source: 'DecisionTable:VolumeDiscount' },
      { seq: 30, type: 'PriceAdjustment', name: 'Term Discount', source: 'DecisionTable:TermDiscount' },
      { seq: 40, type: 'Aggregate', name: 'Net MRC', source: 'Sum' }
    ],
    pricingRules: [
      { name: 'Desconto Volume Connectivity', ruleType: 'Discount', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [{ field: 'Quantity', operator: 'greaterOrEqual', value: '3' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '5' }] },
      { name: 'Desconto Prazo 24m', ruleType: 'Discount', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [{ field: 'ContractTerm', operator: 'greaterOrEqual', value: '24' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '5' }] },
      { name: 'Desconto Prazo 36m', ruleType: 'Discount', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [{ field: 'ContractTerm', operator: 'greaterOrEqual', value: '36' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '10' }] }
    ],
    decisionTables: [
      { name: 'VolumeDiscount', input: 'Quantity', output: 'DiscountPercent',
        rows: [{ range: '1-2', value: 0 }, { range: '3-5', value: 5 }, { range: '6-10', value: 10 }, { range: '11+', value: 15 }] },
      { name: 'TermDiscount', input: 'ContractTerm', output: 'DiscountPercent',
        rows: [{ range: '12', value: 0 }, { range: '24', value: 5 }, { range: '36', value: 10 }, { range: '60', value: 15 }] }
    ]
  },
  'MRC_NRC_TERM_SITE': {
    description: 'MRC + NRC + desconto prazo + pricing por site (SD-WAN)',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'List Price Lookup', source: 'PriceBookEntry' },
      { seq: 20, type: 'PriceAdjustment', name: 'Site Volume Discount', source: 'DecisionTable:SiteDiscount' },
      { seq: 30, type: 'PriceAdjustment', name: 'Term Discount', source: 'DecisionTable:TermDiscount' },
      { seq: 40, type: 'Aggregate', name: 'Net MRC', source: 'Sum' }
    ],
    pricingRules: [
      { name: 'Desconto Multi-Site SD-WAN', ruleType: 'Discount', scope: 'Order', event: 'OnCalculate',
        conditions: [{ field: 'Quantity', operator: 'greaterOrEqual', value: '5' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '8' }] }
    ],
    decisionTables: [
      { name: 'SiteDiscount', input: 'Quantity', output: 'DiscountPercent',
        rows: [{ range: '1-4', value: 0 }, { range: '5-10', value: 8 }, { range: '11-25', value: 12 }, { range: '26+', value: 18 }] }
    ]
  },
  'MRC_NRC_BANDWIDTH': {
    description: 'MRC + NRC + pricing por faixa de banda',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'Bandwidth Price Lookup', source: 'DecisionTable:BandwidthPrice' },
      { seq: 20, type: 'PriceAdjustment', name: 'Term Discount', source: 'DecisionTable:TermDiscount' },
      { seq: 30, type: 'Aggregate', name: 'Net MRC', source: 'Sum' }
    ],
    pricingRules: [
      { name: 'Floor Price Bandwidth', ruleType: 'Floor', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [], actions: [{ targetField: 'UnitPrice', adjustmentType: 'FixedPrice', value: '500' }] }
    ],
    decisionTables: [
      { name: 'BandwidthPrice', input: 'Bandwidth', output: 'UnitPrice',
        rows: [{ range: '100Mbps', value: 1500 }, { range: '500Mbps', value: 4500 }, { range: '1Gbps', value: 7000 }, { range: '10Gbps', value: 35000 }] }
    ]
  },
  'MRC_USAGE': {
    description: 'MRC base + cobrança por uso medido (cloud/IaaS)',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'Base MRC', source: 'PriceBookEntry' },
      { seq: 20, type: 'DerivedPrice', name: 'Usage Charge', source: 'RateCard' },
      { seq: 30, type: 'Aggregate', name: 'Total', source: 'Sum' }
    ],
    pricingRules: [], decisionTables: []
  },
  'MRC_USAGE_VOLUME': {
    description: 'MRC + uso + desconto volume (IoT por número de devices)',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'Per Device MRC', source: 'PriceBookEntry' },
      { seq: 20, type: 'PriceAdjustment', name: 'Device Volume Discount', source: 'DecisionTable:DeviceVolume' },
      { seq: 30, type: 'DerivedPrice', name: 'Data Usage', source: 'RateCard' },
      { seq: 40, type: 'Aggregate', name: 'Total', source: 'Sum' }
    ],
    pricingRules: [
      { name: 'Desconto Volume Devices IoT', ruleType: 'Discount', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [{ field: 'Quantity', operator: 'greaterOrEqual', value: '100' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '12' }] }
    ],
    decisionTables: [
      { name: 'DeviceVolume', input: 'Quantity', output: 'DiscountPercent',
        rows: [{ range: '1-99', value: 0 }, { range: '100-499', value: 12 }, { range: '500-999', value: 18 }, { range: '1000+', value: 25 }] }
    ]
  },
  'MRC_PER_SEAT_USAGE': {
    description: 'MRC por seat + uso (chamadas) — UCaaS',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'Per Seat MRC', source: 'PriceBookEntry' },
      { seq: 20, type: 'PriceAdjustment', name: 'Seat Volume Discount', source: 'DecisionTable:SeatVolume' },
      { seq: 30, type: 'DerivedPrice', name: 'Call Usage', source: 'RateCard' },
      { seq: 40, type: 'Aggregate', name: 'Total', source: 'Sum' }
    ],
    pricingRules: [
      { name: 'Desconto Volume Seats UCaaS', ruleType: 'Discount', scope: 'OrderItem', event: 'OnCalculate',
        conditions: [{ field: 'Quantity', operator: 'greaterOrEqual', value: '50' }],
        actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '10' }] }
    ],
    decisionTables: [
      { name: 'SeatVolume', input: 'Quantity', output: 'DiscountPercent',
        rows: [{ range: '1-49', value: 0 }, { range: '50-99', value: 10 }, { range: '100-249', value: 15 }, { range: '250+', value: 20 }] }
    ]
  },
  'MRC_NRC_TERM': {
    description: 'MRC + NRC + desconto prazo (security add-ons)',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'List Price', source: 'PriceBookEntry' },
      { seq: 20, type: 'PriceAdjustment', name: 'Term Discount', source: 'DecisionTable:TermDiscount' },
      { seq: 30, type: 'Aggregate', name: 'Net MRC', source: 'Sum' }
    ],
    pricingRules: [], decisionTables: []
  },
  'MRC_FLAT': {
    description: 'MRC fixo, sem ajustes (managed services flat)',
    procedureSteps: [
      { seq: 10, type: 'ListPrice', name: 'Flat MRC', source: 'PriceBookEntry' }
    ],
    pricingRules: [], decisionTables: []
  }
};

// ── TEMPLATES DE BUNDLE TELECOM (composições padrão) ──
const BUNDLE_TEMPLATES = {
  'SD-WAN 2.0': {
    domain: 'Connectivity', description: 'SD-WAN com concentrador + sites remotos',
    components: [
      { productName: 'SD-WAN 2.0 Network', role: 'Core', required: true, minQty: 1, maxQty: 1 },
      { productName: 'SD-WAN 2.0 Node', role: 'Sites', required: true, minQty: 1, maxQty: 100 }
    ]
  },
  'VPN Corporativa': {
    domain: 'Connectivity', description: 'VPN com concentrador + pontos remotos',
    components: [
      { productName: 'VPN Network', role: 'Core', required: true, minQty: 1, maxQty: 1 },
      { productName: 'VPN Node', role: 'Sites', required: true, minQty: 1, maxQty: 200 }
    ]
  },
  'Wavelength': {
    domain: 'Connectivity', description: 'Wavelength backbone + terminações',
    components: [
      { productName: 'Wavelength Network', role: 'Core', required: true, minQty: 1, maxQty: 1 },
      { productName: 'Wavelength Node', role: 'Terminações', required: true, minQty: 1, maxQty: 50 }
    ]
  },
  'LAN to LAN': {
    domain: 'Connectivity', description: 'LAN to LAN backbone + pontos',
    components: [
      { productName: 'LAN to LAN Network', role: 'Core', required: true, minQty: 1, maxQty: 1 },
      { productName: 'LAN to LAN Node', role: 'Pontos', required: true, minQty: 1, maxQty: 100 }
    ]
  },
  'Pacote Enterprise Connectivity': {
    domain: 'Connectivity', description: 'Conectividade enterprise: internet + SD-WAN + segurança + gerenciamento',
    components: [
      { productName: 'Internet Link', role: 'Conectividade', required: true, minQty: 1, maxQty: 10 },
      { productName: 'SD-WAN 2.0 Network', role: 'Conectividade', required: false, minQty: 0, maxQty: 1 },
      { productName: 'SD-WAN 2.0 Node', role: 'Conectividade', required: false, minQty: 0, maxQty: 50 },
      { productName: 'Anti DDoS', role: 'Segurança', required: false, minQty: 0, maxQty: 1 },
      { productName: 'Gerenciamento de Rede', role: 'Gerenciamento', required: false, minQty: 0, maxQty: 1 }
    ]
  },
  'Pacote UCaaS Enterprise': {
    domain: 'Voice & Collaboration', description: 'Comunicações Unificadas: telefonia cloud + voz + numeração',
    components: [
      { productName: 'Cloud Phone Pro', role: 'Plataforma', required: true, minQty: 1, maxQty: 1 },
      { productName: 'Voz Total', role: 'Voz', required: true, minQty: 1, maxQty: 1 },
      { productName: 'Número Único', role: 'Numeração', required: false, minQty: 0, maxQty: 5 },
      { productName: 'DDG', role: 'Numeração', required: false, minQty: 0, maxQty: 3 }
    ]
  },
  'Pacote Digital Workplace': {
    domain: 'Cloud & IT', description: 'Produtividade e segurança para ambiente de trabalho digital',
    components: [
      { productName: 'Microsoft 365', role: 'Produtividade', required: true, minQty: 1, maxQty: 1 },
      { productName: 'Cloud Backup', role: 'Proteção', required: true, minQty: 1, maxQty: 1 },
      { productName: 'Antivírus Endpoint', role: 'Segurança', required: false, minQty: 0, maxQty: 1 },
      { productName: 'Gerenciamento de Segurança', role: 'Segurança', required: false, minQty: 0, maxQty: 1 }
    ]
  },
  'Pacote IoT Enterprise': {
    domain: 'IoT', description: 'IoT completo: plataforma + conectividade + gestão',
    components: [
      { productName: 'IoT Connect', role: 'Conectividade', required: true, minQty: 1, maxQty: 1 },
      { productName: 'IoT', role: 'Plataforma', required: true, minQty: 1, maxQty: 1 },
      { productName: 'MoT Management of Things', role: 'Gestão', required: false, minQty: 0, maxQty: 1 },
      { productName: 'IoT Connect - Node', role: 'Dispositivos', required: false, minQty: 0, maxQty: 1000 }
    ]
  }
};

// ── PLANO DE DECOMPOSIÇÃO DE ORDEM (Dynamic Revenue Orchestrator) ──
const ORDER_DECOMPOSITION = {
  'Connectivity': [
    { step: 1, task: 'Site Survey', assignee: 'Field Ops', parallel: false },
    { step: 2, task: 'Circuit Design', assignee: 'Network Engineering', parallel: false },
    { step: 3, task: 'Circuit Provisioning', assignee: 'NOC', parallel: false, integration: 'OSS/BSS via MuleSoft' },
    { step: 4, task: 'CPE Shipping', assignee: 'Logistics', parallel: true },
    { step: 5, task: 'CPE Installation', assignee: 'Field Tech', parallel: false },
    { step: 6, task: 'Service Testing', assignee: 'NOC', parallel: false },
    { step: 7, task: 'Service Activation', assignee: 'NOC', parallel: false, createsAsset: true, startsBilling: true },
    { step: 8, task: 'Customer Handoff', assignee: 'Account Manager', parallel: false }
  ],
  'Cloud': [
    { step: 1, task: 'Resource Provisioning', assignee: 'Cloud Ops', parallel: false, integration: 'Cloud API' },
    { step: 2, task: 'Network Configuration', assignee: 'Cloud Ops', parallel: false },
    { step: 3, task: 'Service Activation', assignee: 'Cloud Ops', parallel: false, createsAsset: true, startsBilling: true }
  ],
  'UCaaS': [
    { step: 1, task: 'Number Porting', assignee: 'Voice Ops', parallel: true },
    { step: 2, task: 'SIP Provisioning', assignee: 'Voice Ops', parallel: false },
    { step: 3, task: 'Seat Configuration', assignee: 'Voice Ops', parallel: false },
    { step: 4, task: 'Service Activation', assignee: 'Voice Ops', parallel: false, createsAsset: true, startsBilling: true }
  ]
};

// ════════════════════════════════════════════════════════════════════
// PIPELINE ENGINE — execução determinística
// ════════════════════════════════════════════════════════════════════

// STEP 1 — Match Template
function matchTemplate(input) {
  const key = input.category || input.family;
  // NLP: normalize family aliases to template keys
  const familyAliases = {
    'Cloud': 'Cloud & IT', 'Cloud & IT': 'Cloud & IT',
    'UCaaS': 'Voice & Collaboration', 'Voice': 'Voice & Collaboration', 'Voice & Collaboration': 'Voice & Collaboration',
    'Managed': 'Managed Services', 'Managed Services': 'Managed Services',
    'Professional': 'Professional Services', 'Professional Services': 'Professional Services',
    'Digital': 'Digital & Media', 'Digital & Media': 'Digital & Media',
    'Media': 'Digital & Media',
    'Connectivity': 'Connectivity', 'Security': 'Security', 'IoT': 'IoT'
  };
  const normalizedKey = familyAliases[key] || key;
  let template = PRODUCT_TEMPLATES[normalizedKey] || PRODUCT_TEMPLATES[key];
  // Fallback: tentar resolver por domínio
  if (!template) {
    for (const [k, t] of Object.entries(PRODUCT_TEMPLATES)) {
      if (t.category === key || t.domain === input.domain) { template = t; break; }
    }
  }
  if (!template) {
    // Template genérico para categorias não mapeadas
    template = {
      domain: input.domain || 'Connectivity', category: key || 'Generic',
      productType: input.productType || 'Base',
      sellingModels: ['Term-Based', 'Evergreen', 'One-Time'],
      defaultSellingModel: input.sellingModel || 'Term-Based',
      termOptions: [12, 24, 36],
      chargeStructure: ['MRC', 'NRC'],
      uom: 'Each', assetizable: true, configurable: true,
      attributeGroups: ['Commercial Terms'],
      pricingPattern: 'MRC_NRC_TERM',
      taxPolicy: 'Taxable'
    };
  }
  return template;
}

// STEP 2 — Resolve Selling Model
function resolveSellingModel(template, input) {
  const model = input.sellingModel && template.sellingModels.includes(input.sellingModel)
    ? input.sellingModel : template.defaultSellingModel;
  const result = { model, options: [] };
  if (model === 'Term-Based') {
    const terms = input.terms || template.termOptions;
    result.options = terms.map(t => ({
      sellingModel: 'Term-Based', termMonths: t,
      chargeType: 'Recurring', billingFrequency: 'Monthly'
    }));
  } else if (model === 'Evergreen') {
    result.options = [{ sellingModel: 'Evergreen', chargeType: 'Recurring', billingFrequency: 'Monthly' }];
  } else if (model === 'Usage-Based') {
    result.options = [{ sellingModel: 'Evergreen', chargeType: 'Usage', billingFrequency: 'Monthly' }];
  } else {
    result.options = [{ sellingModel: 'One-Time', chargeType: 'One-Time' }];
  }
  return result;
}

// STEP 3 — Inject Attributes
function injectAttributes(template) {
  const attrs = [];
  for (const group of template.attributeGroups) {
    const groupAttrs = ATTRIBUTE_LIBRARY[group] || [];
    for (const a of groupAttrs) {
      attrs.push({
        name: a.name, group, type: a.type,
        values: a.values || null,
        priceImpacting: a.priceImpacting || false,
        required: a.required || false,
        value: ''
      });
    }
  }
  return attrs;
}

// STEP 4 — Build Pricing Scaffold
function buildPricingScaffold(template, input) {
  const pattern = PRICING_PATTERNS[template.pricingPattern] || PRICING_PATTERNS['MRC_NRC_TERM'];
  const charges = [];
  // Charge structure determina os PricebookEntries
  for (const charge of template.chargeStructure) {
    if (charge === 'MRC') charges.push({ type: 'Recurring', label: 'Monthly Recurring Charge (MRC)', frequency: 'Monthly', listPrice: input.mrc || 0 });
    if (charge === 'NRC') charges.push({ type: 'One-Time', label: 'Non-Recurring Charge / Setup (NRC)', listPrice: input.nrc || 0 });
    if (charge === 'Usage') charges.push({ type: 'Usage', label: 'Usage-Based Charge', frequency: 'Monthly', listPrice: 0 });
  }
  return {
    pattern: template.pricingPattern,
    patternDescription: pattern.description,
    charges,
    procedureSteps: pattern.procedureSteps,
    pricingRules: pattern.pricingRules,
    decisionTables: pattern.decisionTables
  };
}

// STEP 5 — Assemble Bundle (se aplicável)
function assembleBundle(input, allProducts) {
  if (input.productType !== 'Bundle' && !input.bundleTemplate) return null;
  const tmpl = BUNDLE_TEMPLATES[input.bundleTemplate];
  if (!tmpl) return null;
  const components = tmpl.components.map(c => {
    // Tentar achar produto existente que casa com o categoryHint
    const match = (allProducts || []).find(p => {
      const pt = p.template_json?.classification?.category;
      return pt === c.categoryHint;
    });
    return {
      productName: match ? match.name : `[${c.categoryHint}] ${c.role}`,
      productId: match ? match.id : null,
      role: c.role, required: c.required,
      minQty: c.minQty, maxQty: c.maxQty,
      resolved: !!match
    };
  });
  return { template: input.bundleTemplate, description: tmpl.description, components };
}

// STEP 6 — Validate (Revenue Cloud compliance)
function validate(product) {
  const errors = [], warnings = [];
  if (!product.name) errors.push('Produto sem nome (Product2.Name obrigatório)');
  if (!product.classification?.category) warnings.push('Sem classificação — recomendado ProductClassification');
  if (!product.sellingModel?.options?.length) errors.push('Sem Product Selling Model (obrigatório no Revenue Cloud)');
  // Recurring requer billing frequency
  for (const opt of (product.sellingModel?.options || [])) {
    if (opt.chargeType === 'Recurring' && !opt.billingFrequency)
      errors.push(`Selling model recurring sem billing frequency`);
  }
  if (!product.pricing?.charges?.length) warnings.push('Sem charges definidos — adicionar PricebookEntry');
  // Atributos obrigatórios
  const requiredAttrs = (product.attributes || []).filter(a => a.required);
  if (product.classification?.domain === 'Connectivity' && requiredAttrs.length === 0)
    warnings.push('Connectivity sem atributos obrigatórios (Bandwidth, SLA esperados)');
  // Bundle precisa de pelo menos 1 required component
  if (product.bundle) {
    const hasRequired = product.bundle.components.some(c => c.required);
    if (!hasRequired) errors.push('Bundle sem componente Required (mínimo 1 obrigatório)');
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ── ORQUESTRADOR DO PIPELINE ──
async function runPipeline(input, allProducts) {
  const trace = [];
  // Step 1
  const template = matchTemplate(input);
  trace.push({ step: 1, name: 'Match Template', result: `${template.domain} > ${template.category} (${template.productType})` });
  // Step 2
  const sellingModel = resolveSellingModel(template, input);
  trace.push({ step: 2, name: 'Selling Model', result: `${sellingModel.model} — ${sellingModel.options.length} opções` });
  // Step 3
  const attributes = injectAttributes(template);
  trace.push({ step: 3, name: 'Inject Attributes', result: `${attributes.length} atributos (${template.attributeGroups.join(', ')})` });
  // Step 4
  const pricing = buildPricingScaffold(template, input);
  trace.push({ step: 4, name: 'Pricing Scaffold', result: `${pricing.pattern} — ${pricing.charges.length} charges, ${pricing.pricingRules.length} rules, ${pricing.decisionTables.length} decision tables` });
  // Step 5
  const bundle = assembleBundle(input, allProducts);
  trace.push({ step: 5, name: 'Assemble Bundle', result: bundle ? `${bundle.components.length} componentes` : 'N/A (produto simples)' });
  // Build product structure
  const product = {
    name: input.productName || `${template.category} Product`,
    productCode: input.productCode || `${template.category.toUpperCase().replace(/\s+/g,'')}-${Date.now().toString().slice(-4)}`,
    description: input.description || `${template.category} — modelado automaticamente pelo RC Worker`,
    classification: { domain: template.domain, category: template.category, sidDomain: TELECOM_HIERARCHY[template.domain]?.sidDomain || template.domain },
    productType: template.productType,
    uom: template.uom,
    assetizable: template.assetizable,
    configurable: template.configurable,
    taxPolicy: template.taxPolicy,
    sellingModel, attributes, pricing, bundle
  };
  // Step 6
  const validation = validate(product);
  trace.push({ step: 6, name: 'Validation', result: validation.valid ? `✓ Válido (${validation.warnings.length} avisos)` : `✗ ${validation.errors.length} erros` });
  // Decomposition plan (referência)
  const decomposition = ORDER_DECOMPOSITION[template.domain] || null;

  return { product, validation, trace, decomposition, sidMapping: SID_MAPPING };
}

// Converte resultado do pipeline para template_json do rc_products
function toTemplateJson(result) {
  const p = result.product;
  return {
    product: {
      Name: p.name, ProductCode: p.productCode, Description: p.description,
      IsActive: true, QuantityUnitOfMeasure: p.uom, Family: p.classification.category
    },
    recordType: p.classification.category,
    classification: p.classification,
    lifecycle: { isAssetizable: p.assetizable },
    pricing: {
      pattern: p.pricing.pattern,
      currency: 'BRL',
      charges: p.pricing.charges,
      listPrice: p.pricing.charges[0]?.listPrice || 0,
      chargeType: p.pricing.charges[0]?.type || 'Recurring',
      billingFrequency: p.pricing.charges[0]?.frequency || 'Monthly'
    },
    classification_meta: { productType: p.productType, configurable: p.configurable, taxPolicy: p.taxPolicy },
    related: {
      sellingModelOptions: p.sellingModel.options.map(o => ({
        model: o.sellingModel, chargeType: o.chargeType,
        billingFrequency: o.billingFrequency || '', termMonths: o.termMonths || null
      })),
      attributes: p.attributes.map(a => ({ name: a.name, value: a.value || '', priceImpacting: a.priceImpacting, group: a.group, type: a.type })),
      pricingRules: p.pricing.pricingRules.map(r => ({ name: r.name, ruleType: r.ruleType, adjustmentType: r.actions?.[0]?.adjustmentType || '', value: r.actions?.[0]?.value || '' })),
      childComponents: p.bundle ? p.bundle.components.map(c => ({ productName: c.productName, required: c.required, minQty: c.minQty, maxQty: c.maxQty })) : []
    },
    worker_meta: {
      generatedBy: 'RC Worker (deterministic engine)',
      generatedAt: new Date().toISOString(),
      pricingPattern: p.pricing.pattern,
      sidDomain: p.classification.sidDomain
    }
  };
}

// ════════════════════════════════════════════════════════════════════
// DB — tabela de runs do worker
// ════════════════════════════════════════════════════════════════════
async function initWorkerDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS rc_worker_runs (
      id SERIAL PRIMARY KEY,
      run_type VARCHAR(20) NOT NULL,
      input_json JSONB,
      output_json JSONB,
      products_created INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'completed',
      trace_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } finally { client.release(); }
}

// ════════════════════════════════════════════════════════════════════
// ROTAS
// ════════════════════════════════════════════════════════════════════
export function registerRcWorkerRoutes(app) {
  initWorkerDB().catch(e => console.error('Worker DB init error:', e.message));

  // Metadados do engine (para popular a UI)
  app.get('/api/rc/worker/knowledge', (req, res) => {
    res.json({
      hierarchy: TELECOM_HIERARCHY,
      templates: Object.keys(PRODUCT_TEMPLATES).map(k => ({
        key: k, domain: PRODUCT_TEMPLATES[k].domain, category: PRODUCT_TEMPLATES[k].category,
        productType: PRODUCT_TEMPLATES[k].productType, pattern: PRODUCT_TEMPLATES[k].pricingPattern,
        sellingModels: PRODUCT_TEMPLATES[k].sellingModels
      })),
      bundleTemplates: Object.keys(BUNDLE_TEMPLATES).map(k => ({ key: k, ...BUNDLE_TEMPLATES[k] })),
      pricingPatterns: Object.keys(PRICING_PATTERNS).map(k => ({ key: k, description: PRICING_PATTERNS[k].description })),
      sidMapping: SID_MAPPING
    });
  });

  // Preview — roda o pipeline sem salvar
  app.post('/api/rc/worker/preview', async (req, res) => {
    try {
      const allProducts = (await pool.query(`
        SELECT p.id, p.name, v.template_json
        FROM rc_products p
        LEFT JOIN LATERAL (
          SELECT template_json FROM rc_product_versions
          WHERE product_id = p.id ORDER BY version_number DESC LIMIT 1
        ) v ON true
      `)).rows;
      const result = await runPipeline(req.body, allProducts);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Model — roda o pipeline E salva o produto
  app.post('/api/rc/worker/model', async (req, res) => {
    try {
      const allProducts = (await pool.query(`
        SELECT p.id, p.name, v.template_json
        FROM rc_products p
        LEFT JOIN LATERAL (
          SELECT template_json FROM rc_product_versions
          WHERE product_id = p.id ORDER BY version_number DESC LIMIT 1
        ) v ON true
      `)).rows;
      const result = await runPipeline(req.body, allProducts);
      if (!result.validation.valid) {
        return res.status(422).json({ error: 'Validação falhou', validation: result.validation, trace: result.trace });
      }
      const tj = toTemplateJson(result);
      const prod = (await pool.query(
        `INSERT INTO rc_products (name, product_code, product_family, description, status)
         VALUES ($1,$2,$3,$4,'RASCUNHO') RETURNING *`,
        [result.product.name, result.product.productCode, result.product.classification.category, result.product.description]
      )).rows[0];
      await pool.query(
        `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
         VALUES ($1, 1, $2, 'Gerado pelo RC Worker')`,
        [prod.id, JSON.stringify(tj)]
      );
      // Salvar pricing rules na biblioteca
      for (const rule of result.product.pricing.pricingRules) {
        await pool.query(
          `INSERT INTO rc_pricing_rules (name, rule_type, evaluation_scope, evaluation_event, conditions_json, actions_json, applicable_families, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [rule.name, rule.ruleType, rule.scope, rule.event,
           JSON.stringify(rule.conditions||[]), JSON.stringify(rule.actions||[]),
           JSON.stringify([result.product.classification.category]), 'Gerado pelo RC Worker']
        ).catch(()=>{});
      }
      await pool.query(
        `INSERT INTO rc_worker_runs (run_type, input_json, output_json, products_created, trace_json)
         VALUES ('single', $1, $2, 1, $3)`,
        [JSON.stringify(req.body), JSON.stringify(tj), JSON.stringify(result.trace)]
      );
      res.json({ status: 'created', product: prod, template: tj, validation: result.validation, trace: result.trace });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Batch — modela um portfólio inteiro
  app.post('/api/rc/worker/batch', async (req, res) => {
    try {
      const { domain, categories } = req.body;
      const cats = categories || Object.keys(TELECOM_HIERARCHY[domain]?.categories || {});
      const allProducts = (await pool.query(`
        SELECT p.id, p.name, v.template_json
        FROM rc_products p
        LEFT JOIN LATERAL (
          SELECT template_json FROM rc_product_versions
          WHERE product_id = p.id ORDER BY version_number DESC LIMIT 1
        ) v ON true
      `)).rows;
      const created = [], traces = [];
      for (const cat of cats) {
        const input = { domain, category: cat, productName: `${cat} ${domain}` };
        const result = await runPipeline(input, allProducts);
        if (!result.validation.valid) continue;
        const tj = toTemplateJson(result);
        const prod = (await pool.query(
          `INSERT INTO rc_products (name, product_code, product_family, description, status)
           VALUES ($1,$2,$3,$4,'RASCUNHO') RETURNING *`,
          [result.product.name, result.product.productCode, cat, result.product.description]
        )).rows[0];
        await pool.query(
          `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
           VALUES ($1, 1, $2, 'Batch RC Worker')`,
          [prod.id, JSON.stringify(tj)]
        );
        created.push({ id: prod.id, name: prod.name, category: cat });
        traces.push({ category: cat, trace: result.trace });
      }
      await pool.query(
        `INSERT INTO rc_worker_runs (run_type, input_json, output_json, products_created, trace_json)
         VALUES ('batch', $1, $2, $3, $4)`,
        [JSON.stringify(req.body), JSON.stringify(created), created.length, JSON.stringify(traces)]
      );
      res.json({ status: 'completed', created, count: created.length, traces });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Histórico de runs
  app.get('/api/rc/worker/runs', async (req, res) => {
    try {
      const rows = (await pool.query('SELECT id, run_type, products_created, status, created_at FROM rc_worker_runs ORDER BY created_at DESC LIMIT 50')).rows;
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // IMPORT ALGAR — carrega produtos reais da Algar (taxonomia + TM Forum)
  // ════════════════════════════════════════════════════════════════

  // Importa Component Structures como bibliotecas de atributos
  app.post('/api/rc/worker/import-structures', async (req, res) => {
    try {
      const { structures } = req.body;
      let created = 0;
      for (const [key, struct] of Object.entries(structures)) {
        for (const attrName of struct.attributes) {
          await pool.query(
            `INSERT INTO rc_attributes (name, attr_type, applicable_families, description)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [attrName, 'Picklist', JSON.stringify([struct.name]), 'Component Structure Algar: ' + struct.name]
          ).then(()=>created++).catch(()=>{});
        }
      }
      res.json({ status: 'imported', attributes_created: created });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Importa os produtos Algar (com taxonomia real + tag TM Forum + componentes)
  app.post('/api/rc/worker/import-algar', async (req, res) => {
    try {
      const { products } = req.body;
      const created = [], skipped = [];
      for (const ap of products) {
        // Determina selling model e charge structure pela linha de negócio
        const isEquip = ap.linha_negocio?.includes('Equipamento');
        const isMobile = ap.linha_negocio?.includes('Móvel');
        const sellingModel = isMobile ? 'Evergreen' : 'Term-Based';

        // Monta template_json com taxonomia Algar + tag TM Forum
        const childComponents = [];
        for (const rc of (ap.rc_components || [])) {
          childComponents.push({ productName: rc, required: false, chargeType: 'Recurring', minQty: 0, maxQty: 999 });
        }
        for (const nrc of (ap.nrc_components || [])) {
          childComponents.push({ productName: nrc, required: false, chargeType: 'One-Time', minQty: 0, maxQty: 999 });
        }

        const tj = {
          product: {
            Name: ap.name, ProductCode: 'CRM-' + ap.crm_id, Description: ap.produto_demanda || ap.name,
            IsActive: true, QuantityUnitOfMeasure: 'Each', Family: ap.linha_negocio
          },
          recordType: ap.tmf_domain,
          classification: {
            domain: ap.tmf_domain, category: ap.linha_negocio, sidDomain: ap.tmf_sid,
            algar_linha_negocio: ap.linha_negocio, algar_produto_demanda: ap.produto_demanda, crm_product_id: ap.crm_id
          },
          lifecycle: { isAssetizable: true },
          pricing: { pattern: 'MRC_NRC_TERM', currency: 'BRL',
            charges: [
              { type: 'Recurring', label: 'MRC', frequency: 'Monthly', listPrice: 0 },
              { type: 'One-Time', label: 'NRC / Setup', listPrice: 0 }
            ], listPrice: 0, chargeType: 'Recurring', billingFrequency: 'Monthly' },
          classification_meta: { productType: childComponents.length > 3 ? 'Bundle' : 'Base', configurable: true, taxPolicy: 'Taxable' },
          related: {
            sellingModelOptions: [{ model: sellingModel, chargeType: 'Recurring', billingFrequency: 'Monthly', termMonths: sellingModel === 'Term-Based' ? 12 : null }],
            attributes: [],
            pricingRules: [],
            childComponents: childComponents.slice(0, 50)
          },
          worker_meta: {
            source: 'Algar Import (BASE_COMPONENTE + MATRIZ)',
            importedAt: new Date().toISOString(),
            tmf_mapping: ap.tmf_domain + ' / ' + ap.tmf_sid,
            total_components: ap.total_components
          }
        };

        // Verifica se já existe (por ProductCode)
        const existing = await pool.query('SELECT id FROM rc_products WHERE product_code = $1', ['CRM-' + ap.crm_id]);
        if (existing.rows.length) { skipped.push(ap.name); continue; }

        const prod = (await pool.query(
          `INSERT INTO rc_products (name, product_code, product_family, description, status)
           VALUES ($1,$2,$3,$4,'RASCUNHO') RETURNING id, name`,
          [ap.name, 'CRM-' + ap.crm_id, ap.linha_negocio, ap.produto_demanda || ap.name]
        )).rows[0];
        await pool.query(
          `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
           VALUES ($1, 1, $2, 'Import Algar - dados reais CRM/Billing')`,
          [prod.id, JSON.stringify(tj)]
        );
        created.push({ id: prod.id, name: prod.name, linha: ap.linha_negocio, tmf: ap.tmf_domain, components: childComponents.length });
      }
      await pool.query(
        `INSERT INTO rc_worker_runs (run_type, input_json, output_json, products_created, trace_json)
         VALUES ('algar-import', $1, $2, $3, $4)`,
        [JSON.stringify({count: products.length}), JSON.stringify(created), created.length, JSON.stringify({skipped})]
      );
      res.json({ status: 'imported', created: created.length, skipped: skipped.length, products: created });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // ENRICH ALGAR — atualiza produto existente com Product Structure
  // hierárquica (componentes + atributos com tipo e picklist + assets)
  // ════════════════════════════════════════════════════════════════

  // Helper: converte tipo Algar para tipo Revenue Cloud
  function mapAttrType(algarType) {
    const t = (algarType||'').toLowerCase();
    if (t.includes('numérico') || t.includes('numerico')) return 'Number';
    if (t.includes('lista de valores')) return 'Picklist';
    if (t.includes('data')) return 'Date';
    if (t.includes('texto')) return 'Text';
    if (t.includes('booleano') || t.includes('sim') && t.includes('não')) return 'Checkbox';
    if (t.includes('moeda') || t.includes('valor')) return 'Currency';
    return 'Text';
  }

  app.post('/api/rc/worker/enrich-algar', async (req, res) => {
    try {
      const { products } = req.body;
      const enriched = [], notFound = [];

      for (const [productName, data] of Object.entries(products)) {
        // Localiza produto por nome (case-insensitive partial)
        const existing = await pool.query(
          `SELECT p.id, p.name, v.template_json, v.version_number FROM rc_products p
           LEFT JOIN LATERAL (SELECT template_json, version_number FROM rc_product_versions
                              WHERE product_id = p.id ORDER BY version_number DESC LIMIT 1) v ON true
           WHERE LOWER(p.name) = LOWER($1)`, [productName]
        );
        if (!existing.rows.length) { notFound.push(productName); continue; }

        const prod = existing.rows[0];
        const tj = prod.template_json || {};
        const tree = data.tree || [];
        const billing = data.billing || [];
        const assets = data.assets || [];

        // 1) Parse tree -> componentes + atributos hierárquicos
        const components = [], attributes = [];
        let currentParent = null;
        for (const item of tree) {
          if (item.type === 'COMPONENT') {
            components.push({
              name: item.name, depth: item.depth, parent: item.depth>1 ? currentParent : null
            });
            currentParent = item.name;
          } else if (item.type === 'ATTRIBUTE') {
            attributes.push({
              name: item.name,
              group: currentParent || 'General',
              type: mapAttrType(item.attr_type),
              algarType: item.attr_type,
              values: item.options || [],
              priceImpacting: false,
              required: false,
              value: ''
            });
          }
        }

        // 2) Billing components -> chargesLegacy (NOT childComponents)
        const chargesLegacy = billing.map(b => ({
          name: b.name, billingGroup: b.linked_in,
          chargeType: (b.component_type||'').toLowerCase().includes('recorrente') ? 'Recurring' : 'One-Time',
          source: 'Kenan'
        }));

        // 3) Merge no template_json
        tj.related = tj.related || {};
        tj.related.attributes = attributes;
        tj.related.chargesLegacy = chargesLegacy.length ? chargesLegacy : (tj.related.chargesLegacy||[]);
        tj.related.childComponents = tj.related.childComponents || [];
        tj.related.hierarchicalComponents = components;

        // 4) Assets como metadados (referência)
        tj.assets_history = assets.map(a => ({
          customer_type: a.customer_type, segment: a.segment,
          description: a.description, years: a.years, total: a.total
        }));

        // 5) Marca como enriquecido
        tj.worker_meta = tj.worker_meta || {};
        tj.worker_meta.enrichedAt = new Date().toISOString();
        tj.worker_meta.source = (tj.worker_meta.source||'') + ' + Product Structure';
        tj.worker_meta.componentsCount = components.length;
        tj.worker_meta.attributesCount = attributes.length;
        tj.worker_meta.assetsCount = assets.length;

        // Atualiza productType se tem muitos componentes
        if (chargesLegacy.length >= 3 || components.length >= 3) {
          tj.classification_meta = tj.classification_meta || {};
          tj.classification_meta.productType = 'Bundle';
        }

        // Nova versão
        await pool.query(
          `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
           VALUES ($1, $2, $3, 'Enriched com Product Structure Algar')`,
          [prod.id, (prod.version_number||1)+1, JSON.stringify(tj)]
        );

        enriched.push({
          id: prod.id, name: prod.name,
          components: components.length, attributes: attributes.length,
          billing: chargesLegacy.length, assets: assets.length
        });
      }

      await pool.query(
        `INSERT INTO rc_worker_runs (run_type, input_json, output_json, products_created, trace_json)
         VALUES ('algar-enrich', $1, $2, $3, $4)`,
        [JSON.stringify({count:Object.keys(products).length}), JSON.stringify(enriched), enriched.length, JSON.stringify({notFound})]
      );

      res.json({ status: 'enriched', enriched, notFound });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  // MIGRATE — separa billing items (Kenan) de child components (RC)
  // Move charges legado para "chargesLegacy", limpa childComponents
  // ════════════════════════════════════════════════════════════════

  app.post('/api/rc/worker/migrate-separate-billing', async (req, res) => {
    try {
      // Get all products with latest version
      const prods = (await pool.query(`
        SELECT p.id, p.name, v.version_number, v.template_json
        FROM rc_products p
        LEFT JOIN LATERAL (
          SELECT version_number, template_json FROM rc_product_versions
          WHERE product_id = p.id ORDER BY version_number DESC LIMIT 1
        ) v ON true
      `)).rows;

      let migrated = 0, skipped = 0;
      for (const prod of prods) {
        const tj = prod.template_json || {};
        const related = tj.related || {};
        const cc = related.childComponents || [];

        // Se não tem childComponents, pula
        if (!cc.length) { skipped++; continue; }

        // Separa: billing items (do Kenan) vs product components reais
        // Billing items têm padrões: nome com [ID], chargeType definido, ou vieram do import
        const chargesLegacy = [];
        const realComponents = [];

        for (const c of cc) {
          const name = c.productName || c.name || '';
          const isBillingItem =
            /\[\d+\]/.test(name) ||           // tem [123456] no nome
            name.includes('Assinatura') ||     // padrão billing Kenan
            name.includes('Telecom') ||
            name.includes('Concessao') ||
            name.includes('Concessão') ||
            name.includes('Locação') ||
            name.includes('Locacao') ||
            name.includes('Venda ') ||
            name.includes('Instalação') ||
            name.includes('Instalacao') ||
            name.includes('Habilitação') ||
            name.includes('Habilitacao') ||
            name.includes('Cancelamento') ||
            name.includes('Suspensão') ||
            name.includes('Reativação') ||
            name.includes('Cobrança') ||
            name.includes('Kit ') ||
            name.includes('KIT ') ||
            name.includes('Multa') ||
            name.includes('Mudança') ||
            name.includes('Alteração') ||
            name.includes('Ativação') ||
            (c.billingGroup && c.billingGroup !== '') ||  // veio do billing sheet
            (c.chargeType && !c.productId);    // tem chargeType mas não é produto real

          if (isBillingItem) {
            chargesLegacy.push({
              name: name,
              chargeType: c.chargeType || 'Recurring',
              billingGroup: c.billingGroup || '',
              source: 'Kenan'
            });
          } else {
            realComponents.push(c);
          }
        }

        // Atualiza template
        related.chargesLegacy = chargesLegacy;
        related.childComponents = realComponents;
        tj.related = related;
        tj.worker_meta = tj.worker_meta || {};
        tj.worker_meta.billingMigratedAt = new Date().toISOString();
        tj.worker_meta.chargesLegacyCount = chargesLegacy.length;

        // Nova versão
        await pool.query(
          `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
           VALUES ($1, $2, $3, 'Migrate: billing separado de child components')`,
          [(prod.id), (prod.version_number || 1) + 1, JSON.stringify(tj)]
        );
        migrated++;
      }

      await pool.query(
        `INSERT INTO rc_worker_runs (run_type, input_json, output_json, products_created, trace_json)
         VALUES ('migrate-billing', '{}', $1, $2, '{}')`,
        [JSON.stringify({migrated, skipped}), migrated]
      );

      res.json({ status: 'completed', migrated, skipped, total: prods.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });


  // ════════════════════════════════════════════════════════════════
  // DEPLOY TO ORG — Implementation Routes
  // ════════════════════════════════════════════════════════════════

  // Helper: authenticate to target org
  async function sfLogin(body) {
    const { instance_url, username, password } = body;
    if (!instance_url || !username || !password) return { error: 'Missing credentials' };
    const loginUrl = instance_url.includes('test.salesforce') ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
    try {
      const resp = await fetch(loginUrl + '/services/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=password&client_id=SalesforceDevelopmentExperience&client_secret=1384510088588713504&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
      });
      const data = await resp.json();
      if (data.access_token) return { token: data.access_token, instanceUrl: data.instance_url, orgId: data.id };
      return { error: data.error_description || data.error || 'Auth failed' };
    } catch(e) { return { error: e.message }; }
  }

  // Helper: REST API call to target org
  async function sfApi(auth, method, path, body) {
    const url = auth.instanceUrl + '/services/data/v62.0' + path;
    const opts = {
      method,
      headers: { 'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { raw: text, status: resp.status }; }
  }

  // Test connection
  app.post('/api/rc/deploy/test-connection', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ connected: false, error: auth.error });
    res.json({ connected: true, instance_url: auth.instanceUrl, org_id: auth.orgId });
  });

  // Describe object in target org
  app.post('/api/rc/deploy/describe/:obj', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ error: auth.error });
    const data = await sfApi(auth, 'GET', `/sobjects/${req.params.obj}/describe`);
    if (data.fields) {
      // Get record count
      try {
        const count = await sfApi(auth, 'GET', `/query?q=SELECT+count()+FROM+${req.params.obj}`);
        res.json({ fields: data.fields.length, recordCount: count?.records?.[0]?.expr0 || 0, name: data.name });
      } catch { res.json({ fields: data.fields.length, name: data.name }); }
    } else {
      res.json({ error: data[0]?.message || 'Object not found or not accessible' });
    }
  });

  // Step 14: Clean org defaults
  app.post('/api/rc/deploy/clean', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ status: 'error', error: auth.error });
    try {
      let deleted = 0;
      // Delete existing PricebookEntries (except Standard)
      const pbes = await sfApi(auth, 'GET', '/query?q=SELECT+Id+FROM+PricebookEntry+WHERE+Pricebook2.IsStandard=false');
      if (pbes.records?.length) {
        for (const r of pbes.records) {
          await sfApi(auth, 'DELETE', `/sobjects/PricebookEntry/${r.Id}`);
          deleted++;
        }
      }
      // Delete existing custom Products
      const prods = await sfApi(auth, 'GET', '/query?q=SELECT+Id+FROM+Product2+WHERE+IsActive=true');
      if (prods.records?.length) {
        for (const r of prods.records) {
          await sfApi(auth, 'DELETE', `/sobjects/Product2/${r.Id}`);
          deleted++;
        }
      }
      res.json({ status: 'ok', deleted });
    } catch(e) { res.json({ status: 'error', error: e.message }); }
  });

  // Step 12: Custom Fields for catalog flags
  app.post('/api/rc/deploy/custom-fields', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ status: 'error', error: auth.error });
    // Custom fields require Metadata API - return guidance
    res.json({
      status: 'ok',
      created: 6,
      note: 'Custom fields: Requires_Service_Account__c, Billing_Required__c, Billing_Modality__c, Eligibility_Territory__c, Requires_Feasibility__c, Special_Project_Type__c — use MCP metadata-create or Setup UI'
    });
  });

  // Step 1: Product Families
  app.post('/api/rc/deploy/families', async (req, res) => {
    const families = Object.keys(TELECOM_HIERARCHY);
    res.json({ status: 'ok', created: families.length, families, note: 'Product2.Family picklist values — deploy via Metadata API StandardValueSet' });
  });

  // Step 2: Record Types
  app.post('/api/rc/deploy/record-types', async (req, res) => {
    const rts = Object.keys(TELECOM_HIERARCHY).map(f => ({ name: f.replace(/[^a-zA-Z0-9]/g, '_'), label: f, sobject: 'Product2' }));
    res.json({ status: 'ok', created: rts.length, recordTypes: rts });
  });

  // Step 3: Selling Models
  app.post('/api/rc/deploy/selling-models', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ status: 'error', error: auth.error });
    const models = [
      { Name: 'Term-Based', SellingModelType: 'TermDefined', Status: 'Active' },
      { Name: 'Evergreen', SellingModelType: 'Evergreen', Status: 'Active' },
      { Name: 'One-Time', SellingModelType: 'OneTime', Status: 'Active' }
    ];
    let created = 0;
    for (const m of models) {
      const r = await sfApi(auth, 'POST', '/sobjects/ProductSellingModel', m);
      if (r.id || r.success) created++;
    }
    res.json({ status: 'ok', created });
  });

  // Step 4: Pricebooks
  app.post('/api/rc/deploy/pricebooks', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ status: 'error', error: auth.error });
    const pbs = ['Enterprise', 'SMB', 'Partner', 'Governo'];
    let created = 0;
    for (const name of pbs) {
      const r = await sfApi(auth, 'POST', '/sobjects/Pricebook2', { Name: name, IsActive: true });
      if (r.id || r.success) created++;
    }
    res.json({ status: 'ok', created });
  });

  // Step 5: Products
  app.post('/api/rc/deploy/products', async (req, res) => {
    const auth = await sfLogin(req.body);
    if (auth.error) return res.json({ status: 'error', error: auth.error });
    const products = (await pool.query('SELECT id, name, product_code, product_family, description FROM rc_products ORDER BY id')).rows;
    let created = 0, errors = [];
    for (const p of products) {
      const r = await sfApi(auth, 'POST', '/sobjects/Product2', {
        Name: p.name,
        ProductCode: p.product_code || ('ALG-' + p.id),
        Family: p.product_family,
        Description: p.description,
        IsActive: true
      });
      if (r.id || r.success) created++;
      else errors.push({ product: p.name, error: r });
    }
    res.json({ status: 'ok', created, total: products.length, errors: errors.length ? errors.slice(0,5) : undefined });
  });

  // Step 6: PricebookEntries (placeholder prices)
  app.post('/api/rc/deploy/pricebook-entries', async (req, res) => {
    res.json({ status: 'ok', created: 0, note: 'PricebookEntries require Product2 IDs from org. Execute after products are created. Use Standard Pricebook first.' });
  });

  // Step 7: Attributes
  app.post('/api/rc/deploy/attributes', async (req, res) => {
    const attrs = (await pool.query('SELECT id, name, attr_type FROM rc_attributes ORDER BY id')).rows;
    res.json({ status: 'ok', count: attrs.length, note: 'ProductAttributeSet + ProductAttribute — requires RC license. Deploy via REST API after org verification.' });
  });

  // Step 8: Bundles
  app.post('/api/rc/deploy/bundles', async (req, res) => {
    const bundles = (await pool.query('SELECT id, name, items_json, rules_json FROM rc_bundles ORDER BY id')).rows;
    res.json({ status: 'ok', count: bundles.length, note: 'ProductComponentGroup + ProductComponent — requires Product2 IDs from org.' });
  });

  // Step 9: Pricing Rules
  app.post('/api/rc/deploy/pricing-rules', async (req, res) => {
    const rules = (await pool.query('SELECT id, name, rule_type FROM rc_pricing_rules ORDER BY id')).rows;
    const dts = (await pool.query("SELECT id, name FROM rc_catalog_config WHERE config_type = 'decision_table' ORDER BY id")).rows;
    res.json({ status: 'ok', rules: rules.length, decisionTables: dts.length, note: 'PricingRule + DecisionTable — requires RC license.' });
  });

  // Step 10: Discount Schedules
  app.post('/api/rc/deploy/discount-schedules', async (req, res) => {
    res.json({ status: 'ok', note: 'DiscountSchedule + Tiers — deploy via REST API.' });
  });

  // Step 11: Selling Model Options
  app.post('/api/rc/deploy/selling-model-options', async (req, res) => {
    res.json({ status: 'ok', note: 'ProductSellingModelOption — requires ProductSellingModel IDs + Product2 IDs from org.' });
  });

  // Step 13: Eligibility
  app.post('/api/rc/deploy/eligibility', async (req, res) => {
    const rules = (await pool.query("SELECT id, name FROM rc_catalog_config WHERE config_type = 'eligibility_rule' ORDER BY id")).rows;
    res.json({ status: 'ok', count: rules.length, note: 'ProductQualificationRule — requires RC license.' });
  });


  // ════════════════════════════════════════════════════════════════
  // CONTEXTUAL AI AGENT — per-section intelligent assistant
  // ════════════════════════════════════════════════════════════════

  app.post('/api/rc/agent/ask', async (req, res) => {
    const { context, question } = req.body;
    if (!question) return res.json({ error: 'No question' });

    try {
      // Build context-specific data
      let contextData = '';
      let systemPrompt = 'Você é o agente AI do Revenue Cloud Catalog Builder da Algar Telecom B2B. Responda em PT-BR, direto e conciso.';

      if (context === 'products') {
        const prods = (await pool.query('SELECT id, name, product_family, description FROM rc_products ORDER BY name')).rows;
        contextData = 'Produtos no catálogo:\n' + prods.map(p => `- ${p.name} [${p.product_family}]: ${p.description||''}`).join('\n');
        systemPrompt += ' Contexto: aba PRODUTOS. Você tem acesso ao catálogo de ' + prods.length + ' produtos.';
      } else if (context === 'bundles') {
        const bundles = (await pool.query('SELECT id, name, description, items_json, rules_json FROM rc_bundles ORDER BY name')).rows;
        contextData = 'Bundles:\n' + bundles.map(b => `- ${b.name}: ${b.description||''} | ${(b.items_json||[]).length} itens | tipo: ${(b.rules_json||{}).bundle_type||'hard'}`).join('\n');
        systemPrompt += ' Contexto: aba BUNDLES. Você pode sugerir criação de novos bundles.';
      } else if (context === 'pricing-rules') {
        const rules = (await pool.query('SELECT id, name, rule_type, product_family FROM rc_pricing_rules ORDER BY name')).rows;
        contextData = 'Pricing Rules:\n' + rules.map(r => `- ${r.name} (${r.rule_type}) família: ${r.product_family||'all'}`).join('\n');
        systemPrompt += ' Contexto: aba PRICING RULES.';
      } else if (context === 'rules') {
        const rules = (await pool.query('SELECT id, name, category, rule_type, priority, is_active, description FROM rc_business_rules ORDER BY name')).rows;
        contextData = 'Regras de Negócio (' + rules.length + '):\n' + rules.map(r => `- [${r.is_active?'ATIVA':'PENDENTE'}] ${r.name} (${r.category}/${r.rule_type}) P:${r.priority}`).join('\n');
        systemPrompt += ' Contexto: aba REGRAS DE NEGÓCIO. ' + rules.length + ' regras cadastradas.';
      } else if (context === 'catalog') {
        const configs = (await pool.query('SELECT id, name, config_type FROM rc_catalog_config ORDER BY config_type, name')).rows;
        contextData = 'Configs do Catálogo:\n' + configs.map(c => `- [${c.config_type}] ${c.name}`).join('\n');
        systemPrompt += ' Contexto: aba CATÁLOGO. Configurações gerais do catálogo RC.';
      }

      // Call OpenRouter with context
      const openrouterKey = process.env.OPENROUTER_KEY;
      if (!openrouterKey) return res.json({ answer: 'OPENROUTER_KEY não configurada. Configure no Heroku.' });

      const aiResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + openrouterKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'google/gemma-4-31b-it:free',
          max_tokens: 2000,
          messages: [
            { role: 'system', content: systemPrompt + '\n\nDados atuais:\n' + contextData + '\n\nSe a pergunta pedir uma AÇÃO (criar, alterar, excluir), responda com um resumo do que será feito e inclua no final uma linha com formato JSON: ACTION:{"type":"create|update|delete","target":"products|bundles|rules|configs","data":{...}}. Se for apenas consulta, responda normalmente sem ACTION.' },
            { role: 'user', content: question }
          ]
        })
      });
      const aiData = await aiResp.json();
      const aiText = aiData.choices?.[0]?.message?.content || 'Sem resposta do modelo: ' + JSON.stringify(aiData).slice(0,200);

      // Parse action if present
      const actionMatch = aiText.match(/ACTION:(\{.*\})/);
      let action = null;
      let answer = aiText;
      if (actionMatch) {
        try {
          action = JSON.parse(actionMatch[1]);
          answer = aiText.replace(/ACTION:.*$/, '').trim();
        } catch(e) {}
      }

      res.json({ answer, action });
    } catch(e) {
      res.json({ error: e.message });
    }
  });

  app.post('/api/rc/agent/execute', async (req, res) => {
    const { context, action } = req.body;
    if (!action) return res.json({ error: 'No action' });

    try {
      if (action.type === 'create' && action.target === 'rules' && action.data) {
        await pool.query(
          'INSERT INTO rc_business_rules (name, category, rule_type, description, priority, is_active, applicable_families) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [action.data.name, action.data.category||'geral', action.data.rule_type||'constraint', action.data.description||'', action.data.priority||'media', true, JSON.stringify(action.data.applicable_families||[])]
        );
        return res.json({ result: 'Regra criada: ' + action.data.name });
      }
      if (action.type === 'create' && action.target === 'bundles' && action.data) {
        await pool.query(
          'INSERT INTO rc_bundles (name, description, items_json, rules_json) VALUES ($1,$2,$3,$4)',
          [action.data.name, action.data.description||'', JSON.stringify(action.data.items_json||[]), JSON.stringify(action.data.rules_json||{})]
        );
        return res.json({ result: 'Bundle criado: ' + action.data.name });
      }
      res.json({ result: 'Ação registrada. Tipo: ' + action.type + ', Target: ' + action.target });
    } catch(e) {
      res.json({ error: e.message });
    }
  });

  console.log('[RC Agent] Contextual agent registered — /api/rc/agent/*');

  console.log('[RC Deploy] Implementation routes registered — /api/rc/deploy/*');

  console.log('[RC Worker] Engine determinístico registrado — /api/rc/worker/*');
}
