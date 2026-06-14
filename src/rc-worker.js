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
// Service Domain > Service Category > Service Specification
const TELECOM_HIERARCHY = {
  'Connectivity': {
    sidDomain: 'Connectivity Services',
    categories: {
      'MPLS':      { specs: ['MPLS Standard', 'MPLS Premium', 'MPLS Burst'] },
      'SD-WAN':    { specs: ['SD-WAN Basic', 'SD-WAN Advanced', 'SD-WAN Secure'] },
      'DIA':       { specs: ['Dedicated Internet Standard', 'Dedicated Internet Premium'] },
      'Fiber':     { specs: ['Fiber Dedicated', 'Fiber Shared', 'Fiber GPON'] },
      'Ethernet':  { specs: ['E-Line', 'E-LAN', 'E-Tree'] },
      'Wireless':  { specs: ['4G Backup', '5G Primary', 'Satellite Backup'] }
    }
  },
  'Cloud': {
    sidDomain: 'Cloud Services',
    categories: {
      'IaaS':      { specs: ['Compute', 'Storage', 'Network'] },
      'Hosting':   { specs: ['Colocation', 'Managed Hosting', 'Cloud Hosting'] },
      'Backup':    { specs: ['Cloud Backup', 'DRaaS'] }
    }
  },
  'IoT': {
    sidDomain: 'IoT Services',
    categories: {
      'Connectivity': { specs: ['NB-IoT', 'LTE-M', 'IoT SIM'] },
      'Platform':     { specs: ['Device Management', 'Data Analytics'] }
    }
  },
  'UCaaS': {
    sidDomain: 'Unified Communications',
    categories: {
      'Voice':         { specs: ['SIP Trunk', 'Hosted PBX', 'Cloud Voice'] },
      'Collaboration': { specs: ['Video Conferencing', 'Team Messaging'] },
      'ContactCenter': { specs: ['CCaaS Basic', 'CCaaS Omnichannel'] }
    }
  },
  'Security': {
    sidDomain: 'Security Services',
    categories: {
      'Network':   { specs: ['Managed Firewall', 'DDoS Protection', 'SASE'] },
      'Endpoint':  { specs: ['Endpoint Protection', 'MDR'] }
    }
  },
  'Managed': {
    sidDomain: 'Managed Services',
    categories: {
      'NetworkOps': { specs: ['NOC Monitoring', 'Managed Router'] },
      'FieldOps':   { specs: ['On-Site Support', 'Installation'] }
    }
  }
};

// ── TEMPLATES DE PRODUTO POR CATEGORIA (conhecimento Revenue Cloud) ──
// Cada template codifica: selling models válidos, charge types, atributos
// obrigatórios, padrão de pricing, UoM, assetização — derivado da doc oficial.
const PRODUCT_TEMPLATES = {
  // ─── CONNECTIVITY ───
  'MPLS': {
    domain: 'Connectivity', category: 'MPLS',
    productType: 'Base',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36, 48, 60],
    chargeStructure: ['MRC', 'NRC'],   // Monthly Recurring + Non-Recurring (setup)
    uom: 'Each',
    assetizable: true,
    configurable: true,
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM_VOLUME',
    taxPolicy: 'Taxable'
  },
  'SD-WAN': {
    domain: 'Connectivity', category: 'SD-WAN',
    productType: 'Base',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC', 'NRC'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM_SITE',
    taxPolicy: 'Taxable'
  },
  'DIA': {
    domain: 'Connectivity', category: 'DIA',
    productType: 'Base',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC', 'NRC'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_BANDWIDTH',
    taxPolicy: 'Taxable'
  },
  'Fiber': {
    domain: 'Connectivity', category: 'Fiber',
    productType: 'Base',
    sellingModels: ['Term-Based'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36, 60],
    chargeStructure: ['MRC', 'NRC'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_BANDWIDTH',
    taxPolicy: 'Taxable'
  },
  'Ethernet': {
    domain: 'Connectivity', category: 'Ethernet',
    productType: 'Base',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC', 'NRC'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Network Specifications', 'Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_BANDWIDTH',
    taxPolicy: 'Taxable'
  },
  // ─── CLOUD ───
  'IaaS': {
    domain: 'Cloud', category: 'IaaS',
    productType: 'Base',
    sellingModels: ['Evergreen', 'Term-Based'],
    defaultSellingModel: 'Evergreen',
    termOptions: [1, 12, 36],
    chargeStructure: ['MRC', 'Usage'],   // Recorrente + uso medido
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Cloud Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_USAGE',
    taxPolicy: 'Taxable'
  },
  // ─── IoT ───
  'Connectivity_IoT': {
    domain: 'IoT', category: 'Connectivity',
    productType: 'Base',
    sellingModels: ['Evergreen', 'Usage-Based'],
    defaultSellingModel: 'Usage-Based',
    termOptions: [1, 12, 24],
    chargeStructure: ['MRC', 'Usage'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['IoT Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_USAGE_VOLUME',
    taxPolicy: 'Taxable'
  },
  // ─── UCaaS ───
  'Voice': {
    domain: 'UCaaS', category: 'Voice',
    productType: 'Base',
    sellingModels: ['Evergreen', 'Term-Based'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC', 'NRC', 'Usage'],   // licença + setup + uso (chamadas)
    uom: 'Seat', assetizable: true, configurable: true,
    attributeGroups: ['Voice Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_PER_SEAT_USAGE',
    taxPolicy: 'Taxable'
  },
  // ─── SECURITY ───
  'Network_Security': {
    domain: 'Security', category: 'Network',
    productType: 'Add-On',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Term-Based',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC', 'NRC'],
    uom: 'Each', assetizable: true, configurable: true,
    attributeGroups: ['Security Specifications', 'Commercial Terms'],
    pricingPattern: 'MRC_NRC_TERM',
    taxPolicy: 'Taxable'
  },
  // ─── MANAGED ───
  'NetworkOps': {
    domain: 'Managed', category: 'NetworkOps',
    productType: 'Add-On',
    sellingModels: ['Term-Based', 'Evergreen'],
    defaultSellingModel: 'Evergreen',
    termOptions: [12, 24, 36],
    chargeStructure: ['MRC'],
    uom: 'Each', assetizable: true, configurable: false,
    attributeGroups: ['Service Parameters', 'Commercial Terms'],
    pricingPattern: 'MRC_FLAT',
    taxPolicy: 'Taxable'
  }
};

// ── BIBLIOTECA DE ATRIBUTOS POR GRUPO (telecom B2B padrão) ──
// Atributos padrão Revenue Cloud por grupo de atributo, com tipo e valores.
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
  'Enterprise Connectivity Package': {
    domain: 'Connectivity',
    description: 'Pacote completo de conectividade enterprise',
    components: [
      { categoryHint: 'MPLS', role: 'Link Base', required: true, minQty: 1, maxQty: 10 },
      { categoryHint: 'DIA', role: 'Backup Link', required: false, minQty: 0, maxQty: 5 },
      { categoryHint: 'Network_Security', role: 'Firewall', required: false, minQty: 0, maxQty: 1 },
      { categoryHint: 'NetworkOps', role: 'Managed Router', required: false, minQty: 0, maxQty: 1 }
    ]
  },
  'UCaaS Enterprise': {
    domain: 'UCaaS',
    description: 'Solução completa de comunicação unificada',
    components: [
      { categoryHint: 'Voice', role: 'Voice Licenses', required: true, minQty: 1, maxQty: 1000 },
      { categoryHint: 'Voice', role: 'SIP Trunk', required: true, minQty: 1, maxQty: 50 },
      { categoryHint: 'ContactCenter', role: 'Contact Center', required: false, minQty: 0, maxQty: 1 }
    ]
  },
  'SD-WAN Managed Solution': {
    domain: 'Connectivity',
    description: 'SD-WAN gerenciado multi-site',
    components: [
      { categoryHint: 'SD-WAN', role: 'SD-WAN Edge', required: true, minQty: 1, maxQty: 100 },
      { categoryHint: 'Network_Security', role: 'Integrated Security', required: false, minQty: 0, maxQty: 1 },
      { categoryHint: 'NetworkOps', role: 'NOC Monitoring', required: false, minQty: 0, maxQty: 1 }
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
  let template = PRODUCT_TEMPLATES[key];
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
      const allProducts = (await pool.query('SELECT id, name, template_json FROM rc_products')).rows;
      const result = await runPipeline(req.body, allProducts);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Model — roda o pipeline E salva o produto
  app.post('/api/rc/worker/model', async (req, res) => {
    try {
      const allProducts = (await pool.query('SELECT id, name, template_json FROM rc_products')).rows;
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
      const allProducts = (await pool.query('SELECT id, name, template_json FROM rc_products')).rows;
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

  console.log('[RC Worker] Engine determinístico registrado — /api/rc/worker/*');
}
