// src/worker-engine.js — Autonomous Modeling Worker Engine
// Engine determinístico (ZERO AI) que mapeia produtos/objetos Salesforce
// com base em blueprints hardcoded por nuvem. Escalável para múltiplas clouds.
//
// Arquitetura:
//   CLOUD_BLUEPRINTS = { revenue_cloud: {...}, sales_cloud: {...}, ... }
//   Cada blueprint define: templates, regras, atributos, pricing, validações
//   O worker recebe input mínimo → aplica regras → gera output completo
//
// Conhecimento Salesforce está CRISTALIZADO no código (não depende de LLM).

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ═══════════════════════════════════════════════════════════════════
// CLOUD BLUEPRINTS — Conhecimento determinístico por nuvem Salesforce
// ═══════════════════════════════════════════════════════════════════

const REVENUE_CLOUD_BLUEPRINT = {
  id: 'revenue_cloud',
  label: 'Revenue Cloud (RLM)',
  version: 'Spring 26',

  // ── Famílias telecom B2B (TM Forum SID aligned) ──
  productFamilies: {
    Connectivity: {
      classification: 'Connectivity Services',
      sidEntity: 'ProductSpecification',
      defaultSellingModel: 'Term-Based',
      defaultChargeType: 'Recurring',
      defaultBillingFrequency: 'Monthly',
      assetizable: true,
      subTypes: ['MPLS', 'SD-WAN', 'Dedicated Internet Access', 'Fiber Optic', 'Ethernet', 'Wireless Backup'],
      attributes: [
        { name: 'Bandwidth', type: 'Picklist', values: ['10Mbps','50Mbps','100Mbps','500Mbps','1Gbps','10Gbps'], priceImpacting: true, group: 'Network Specifications' },
        { name: 'SLA Level', type: 'Picklist', values: ['Bronze','Silver','Gold','Platinum'], priceImpacting: true, group: 'Network Specifications' },
        { name: 'Availability', type: 'Percent', values: ['99.5','99.9','99.95','99.99'], priceImpacting: false, group: 'Network Specifications' },
        { name: 'Technology', type: 'Picklist', values: ['MPLS','SD-WAN','Fiber','Ethernet','Satellite'], priceImpacting: false, group: 'Network Specifications' },
        { name: 'Symmetry', type: 'Picklist', values: ['Symmetric','Asymmetric'], priceImpacting: false, group: 'Network Specifications' },
        { name: 'A-End Location', type: 'Text', priceImpacting: false, group: 'Service Parameters' },
        { name: 'B-End Location', type: 'Text', priceImpacting: false, group: 'Service Parameters' },
        { name: 'CPE Required', type: 'Boolean', priceImpacting: true, group: 'Service Parameters' },
      ],
      pricingPatterns: ['MRC+NRC', 'Bandwidth-Based', 'Contract Term Discount', 'Volume'],
    },
    Cloud: {
      classification: 'Cloud Services',
      sidEntity: 'ProductSpecification',
      defaultSellingModel: 'Evergreen',
      defaultChargeType: 'Recurring',
      defaultBillingFrequency: 'Monthly',
      assetizable: true,
      subTypes: ['IaaS', 'PaaS', 'SaaS', 'Backup', 'DRaaS'],
      attributes: [
        { name: 'Compute Units', type: 'Number', priceImpacting: true, group: 'Resource Specifications' },
        { name: 'Storage GB', type: 'Number', priceImpacting: true, group: 'Resource Specifications' },
        { name: 'Region', type: 'Picklist', values: ['Brazil-South','Brazil-Southeast','US-East'], priceImpacting: true, group: 'Resource Specifications' },
        { name: 'Redundancy', type: 'Picklist', values: ['Single','Multi-AZ','Multi-Region'], priceImpacting: true, group: 'Resource Specifications' },
        { name: 'Support Tier', type: 'Picklist', values: ['Basic','Standard','Premium','Enterprise'], priceImpacting: true, group: 'Commercial Terms' },
      ],
      pricingPatterns: ['Usage-Based', 'Tiered', 'MRC+NRC'],
    },
    IoT: {
      classification: 'IoT Services',
      sidEntity: 'ProductSpecification',
      defaultSellingModel: 'Term-Based',
      defaultChargeType: 'Recurring',
      defaultBillingFrequency: 'Monthly',
      assetizable: true,
      subTypes: ['Connectivity SIM', 'Asset Tracking', 'Smart Metering', 'Fleet Management'],
      attributes: [
        { name: 'Data Plan', type: 'Picklist', values: ['1MB','10MB','100MB','1GB','Unlimited'], priceImpacting: true, group: 'IoT Specifications' },
        { name: 'Device Count', type: 'Number', priceImpacting: true, group: 'IoT Specifications' },
        { name: 'Coverage', type: 'Picklist', values: ['National','International','Roaming'], priceImpacting: true, group: 'IoT Specifications' },
        { name: 'Connectivity Type', type: 'Picklist', values: ['NB-IoT','LTE-M','4G','5G'], priceImpacting: false, group: 'IoT Specifications' },
      ],
      pricingPatterns: ['Volume', 'Usage-Based', 'Tiered'],
    },
    UCaaS: {
      classification: 'UCaaS',
      sidEntity: 'ProductSpecification',
      defaultSellingModel: 'Term-Based',
      defaultChargeType: 'Recurring',
      defaultBillingFrequency: 'Monthly',
      assetizable: true,
      subTypes: ['Voice Licenses', 'SIP Trunk', 'Contact Center', 'Video Conferencing'],
      attributes: [
        { name: 'License Type', type: 'Picklist', values: ['Basic','Standard','Professional','Enterprise'], priceImpacting: true, group: 'UCaaS Specifications' },
        { name: 'User Count', type: 'Number', priceImpacting: true, group: 'UCaaS Specifications' },
        { name: 'SIP Channels', type: 'Number', priceImpacting: true, group: 'UCaaS Specifications' },
        { name: 'DID Numbers', type: 'Number', priceImpacting: true, group: 'UCaaS Specifications' },
      ],
      pricingPatterns: ['Volume', 'MRC+NRC', 'Contract Term Discount'],
    },
    Security: {
      classification: 'Security Services',
      sidEntity: 'ProductSpecification',
      defaultSellingModel: 'Term-Based',
      defaultChargeType: 'Recurring',
      defaultBillingFrequency: 'Monthly',
      assetizable: true,
      subTypes: ['Managed Firewall', 'DDoS Protection', 'SOC', 'Endpoint Security'],
      attributes: [
        { name: 'Throughput', type: 'Picklist', values: ['100Mbps','500Mbps','1Gbps','10Gbps'], priceImpacting: true, group: 'Security Specifications' },
        { name: 'Protection Level', type: 'Picklist', values: ['Standard','Advanced','Premium'], priceImpacting: true, group: 'Security Specifications' },
        { name: 'Management Level', type: 'Picklist', values: ['Self-Managed','Co-Managed','Fully-Managed'], priceImpacting: true, group: 'Security Specifications' },
      ],
      pricingPatterns: ['MRC+NRC', 'Contract Term Discount'],
    },
  },

  // ── Selling Models OOTB ──
  sellingModels: {
    'One-Time': { chargeType: 'One-Time', recurring: false, billingFrequency: null },
    'Evergreen': { chargeType: 'Recurring', recurring: true, billingFrequency: 'Monthly', termMonths: null },
    'Term-Based': { chargeType: 'Recurring', recurring: true, billingFrequency: 'Monthly', termOptions: [12, 24, 36, 48, 60] },
  },

  // ── Templates de bundle telecom ──
  bundleTemplates: {
    'Enterprise Connectivity Package': {
      productType: 'Bundle',
      family: 'Connectivity',
      components: [
        { role: 'Link Base', required: true, minQty: 1, maxQty: 1, family: 'Connectivity' },
        { role: 'IP Address Block', required: false, minQty: 0, maxQty: 5, family: 'Connectivity' },
        { role: 'SLA Enhancement', required: false, minQty: 0, maxQty: 1, family: 'Connectivity' },
        { role: 'Managed Router/CPE', required: false, minQty: 0, maxQty: 1, family: 'Connectivity' },
        { role: 'Firewall Service', required: false, minQty: 0, maxQty: 1, family: 'Security' },
      ],
    },
    'UCaaS Enterprise': {
      productType: 'Bundle',
      family: 'UCaaS',
      components: [
        { role: 'Voice Licenses', required: true, minQty: 1, maxQty: 9999, family: 'UCaaS' },
        { role: 'SIP Trunk', required: true, minQty: 1, maxQty: 100, family: 'UCaaS' },
        { role: 'Contact Center', required: false, minQty: 0, maxQty: 1, family: 'UCaaS' },
        { role: 'Video Conferencing', required: false, minQty: 0, maxQty: 1, family: 'UCaaS' },
        { role: 'Collaboration Tools', required: false, minQty: 0, maxQty: 1, family: 'UCaaS' },
      ],
    },
  },

  // ── Pricing patterns → estrutura de pricing rules ──
  pricingRuleTemplates: {
    'Volume': {
      rule_type: 'Discount',
      evaluation_scope: 'OrderItem',
      evaluation_event: 'OnCalculate',
      conditions: [{ field: 'Quantity', operator: 'greaterOrEqual', value: '3' }],
      actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '5' }],
      tiers: [
        { min: 3, max: 5, discount: 5 },
        { min: 6, max: 10, discount: 10 },
        { min: 11, max: 999, discount: 15 },
      ],
    },
    'Contract Term Discount': {
      rule_type: 'Discount',
      evaluation_scope: 'Product',
      evaluation_event: 'OnCalculate',
      conditions: [{ field: 'ContractTerm', operator: 'greaterOrEqual', value: '24' }],
      actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '5' }],
      tiers: [
        { min: 12, max: 12, discount: 0 },
        { min: 24, max: 24, discount: 5 },
        { min: 36, max: 36, discount: 10 },
        { min: 60, max: 60, discount: 15 },
      ],
    },
    'Bandwidth-Based': {
      rule_type: 'PriceOverride',
      evaluation_scope: 'Product',
      evaluation_event: 'OnCalculate',
      conditions: [{ field: 'Product.Family', operator: 'equals', value: 'Connectivity' }],
      actions: [{ targetField: 'UnitPrice', adjustmentType: 'Formula', value: 'BandwidthTier' }],
    },
    'MRC+NRC': {
      // Gera 2 pricebook entries: recurring + one-time
      generatesPricebookEntries: [
        { chargeType: 'Recurring', frequency: 'Monthly', label: 'MRC' },
        { chargeType: 'One-Time', frequency: null, label: 'NRC (Setup)' },
      ],
    },
    'Usage-Based': {
      rule_type: 'Surcharge',
      evaluation_scope: 'OrderItem',
      evaluation_event: 'OnCalculate',
      conditions: [{ field: 'Usage', operator: 'greaterThan', value: '0' }],
      actions: [{ targetField: 'TotalPrice', adjustmentType: 'Formula', value: 'UsageRate' }],
    },
    'Tiered': {
      rule_type: 'Discount',
      evaluation_scope: 'OrderItem',
      evaluation_event: 'OnCalculate',
      conditions: [{ field: 'TotalPrice', operator: 'greaterOrEqual', value: '1000' }],
      actions: [{ targetField: 'DiscountPercent', adjustmentType: 'PercentDiscount', value: '8' }],
    },
  },

  // ── Order decomposition (DRO) por família ──
  orderDecomposition: {
    Connectivity: [
      { step: 'Site Survey', assignee: 'Field Ops', sequence: 1 },
      { step: 'Circuit Design', assignee: 'Network Engineering', sequence: 2 },
      { step: 'Circuit Provisioning', assignee: 'NOC', sequence: 3, integration: 'OSS/BSS via MuleSoft' },
      { step: 'CPE Installation', assignee: 'Field Tech', sequence: 4 },
      { step: 'Service Testing', assignee: 'NOC', sequence: 5 },
      { step: 'Service Activation', assignee: 'NOC', sequence: 6, createsAsset: true, startsBilling: true },
      { step: 'Customer Handoff', assignee: 'Account Manager', sequence: 7 },
    ],
    UCaaS: [
      { step: 'License Provisioning', assignee: 'Provisioning', sequence: 1 },
      { step: 'SIP Trunk Setup', assignee: 'Voice Engineering', sequence: 2 },
      { step: 'Number Porting', assignee: 'Provisioning', sequence: 3, integration: 'Carrier API' },
      { step: 'Service Activation', assignee: 'NOC', sequence: 4, createsAsset: true, startsBilling: true },
    ],
  },

  // ── Validation rules (Revenue Cloud) ──
  validations: [
    { rule: 'sellingModelRequired', message: 'Product must have a Selling Model' },
    { rule: 'pricebookEntryRequired', message: 'Recurring products need at least one Price Book Entry' },
    { rule: 'classificationRequired', message: 'Product should have a Classification for attribute inheritance' },
    { rule: 'bundleNeedsComponents', message: 'Bundle products must have at least one required component' },
    { rule: 'mrcNeedsBillingFrequency', message: 'Recurring charge requires a Billing Frequency' },
  ],
};

// ── Sales Cloud blueprint (estrutura preparada, expansão futura) ──
const SALES_CLOUD_BLUEPRINT = {
  id: 'sales_cloud',
  label: 'Sales Cloud',
  version: 'Spring 26',
  status: 'planned',
  objectTemplates: {
    Lead: { standardFields: ['FirstName','LastName','Company','Email','Status','LeadSource'], stages: ['New','Working','Nurturing','Qualified','Unqualified'] },
    Opportunity: { standardFields: ['Name','StageName','Amount','CloseDate','Probability'], stages: ['Prospecting','Qualification','Proposal','Negotiation','Closed Won','Closed Lost'] },
    Account: { standardFields: ['Name','Industry','Type','AnnualRevenue','NumberOfEmployees'] },
  },
};

// ── Service Cloud blueprint (estrutura preparada) ──
const SERVICE_CLOUD_BLUEPRINT = {
  id: 'service_cloud',
  label: 'Service Cloud',
  version: 'Spring 26',
  status: 'planned',
  objectTemplates: {
    Case: { standardFields: ['Subject','Status','Priority','Origin','Type'], stages: ['New','Working','Escalated','Closed'] },
    Entitlement: { standardFields: ['Name','StartDate','EndDate','Type'] },
  },
};

// ── Registry central de blueprints ──
const CLOUD_BLUEPRINTS = {
  revenue_cloud: REVENUE_CLOUD_BLUEPRINT,
  sales_cloud: SALES_CLOUD_BLUEPRINT,
  service_cloud: SERVICE_CLOUD_BLUEPRINT,
};

// ═══════════════════════════════════════════════════════════════════
// WORKER PIPELINE — Mapeamento determinístico (steps executados em ordem)
// ═══════════════════════════════════════════════════════════════════

// Step 1: Template Matching — resolve família/tipo → blueprint config
function stepTemplateMatching(blueprint, input) {
  const family = blueprint.productFamilies[input.family];
  if (!family) {
    return { ok: false, error: `Família "${input.family}" não existe no blueprint ${blueprint.id}` };
  }
  return {
    ok: true,
    family,
    log: `Template resolvido: ${input.family} → Classification "${family.classification}" (SID: ${family.sidEntity})`,
  };
}

// Step 2: Product Structure — monta o produto com campos padrão derivados de regras
function stepProductStructure(blueprint, input, familyConfig) {
  const sellingModel = input.sellingModel || familyConfig.defaultSellingModel;
  const smConfig = blueprint.sellingModels[sellingModel];

  const product = {
    Name: input.name,
    ProductCode: input.productCode || generateCode(input.name, input.family),
    StockKeepingUnit: input.sku || `SKU-${generateCode(input.name, input.family)}`,
    Family: input.family,
    Description: input.description || `${input.name} — ${familyConfig.classification}`,
    IsActive: true,
    QuantityUnitOfMeasure: 'Each',
  };

  const classification = {
    name: familyConfig.classification,
    sidEntity: familyConfig.sidEntity,
  };

  const lifecycle = {
    isAssetizable: familyConfig.assetizable,
    availabilityDate: new Date().toISOString().slice(0, 10),
  };

  const classify = {
    productType: input.productType || 'Base',
    sellingModel,
    chargeType: smConfig.chargeType,
    configureDuringSale: input.productType === 'Bundle' ? 'Required' : 'Allowed',
  };

  return {
    ok: true,
    product, classification, lifecycle, classify, smConfig, sellingModel,
    log: `Produto estruturado: ${product.Name} | Type: ${classify.productType} | Selling Model: ${sellingModel} | Charge: ${smConfig.chargeType}`,
  };
}

// Step 3: Attributes Injection — injeta atributos padrão da família
function stepAttributesInjection(familyConfig) {
  const attributes = familyConfig.attributes.map(a => ({
    name: a.name,
    value: a.values ? a.values[0] : '',
    type: a.type,
    priceImpacting: a.priceImpacting,
    group: a.group,
    allowedValues: a.values || [],
  }));
  return {
    ok: true,
    attributes,
    log: `${attributes.length} atributos injetados: ${attributes.map(a => a.name).join(', ')}`,
  };
}

// Step 4: Pricing Scaffold — monta esqueleto de pricing
function stepPricingScaffold(blueprint, input, familyConfig, smConfig) {
  const priceBookEntries = [];
  const pricingRules = [];

  // MRC + NRC pattern: gera 2 pricebook entries
  if (familyConfig.pricingPatterns.includes('MRC+NRC')) {
    const mrcnrc = blueprint.pricingRuleTemplates['MRC+NRC'];
    mrcnrc.generatesPricebookEntries.forEach(pbe => {
      priceBookEntries.push({
        pricebook: input.pricebook || 'Standard',
        currency: input.currency || 'BRL',
        listPrice: 0,
        chargeType: pbe.chargeType,
        frequency: pbe.frequency,
        label: pbe.label,
      });
    });
  } else {
    // Default: single recurring or one-time entry
    priceBookEntries.push({
      pricebook: input.pricebook || 'Standard',
      currency: input.currency || 'BRL',
      listPrice: 0,
      chargeType: smConfig.chargeType,
      frequency: smConfig.billingFrequency,
      label: smConfig.recurring ? 'Recurring' : 'One-Time',
    });
  }

  // Gera pricing rules baseado nos patterns da família
  familyConfig.pricingPatterns.forEach(pattern => {
    const tmpl = blueprint.pricingRuleTemplates[pattern];
    if (tmpl && tmpl.rule_type) {
      pricingRules.push({
        name: `${pattern} — ${input.family}`,
        ruleType: tmpl.rule_type,
        evaluationScope: tmpl.evaluation_scope,
        evaluationEvent: tmpl.evaluation_event,
        conditions: tmpl.conditions,
        actions: tmpl.actions,
        tiers: tmpl.tiers || null,
        applicableFamilies: [input.family],
      });
    }
  });

  return {
    ok: true,
    priceBookEntries, pricingRules,
    log: `Pricing scaffold: ${priceBookEntries.length} price book entries, ${pricingRules.length} pricing rules (patterns: ${familyConfig.pricingPatterns.join(', ')})`,
  };
}

// Step 5: Bundle Assembly — monta composição se for Bundle
function stepBundleAssembly(blueprint, input, familyConfig) {
  if (input.productType !== 'Bundle') {
    return { ok: true, components: [], log: 'Não é Bundle — assembly ignorado' };
  }

  // Busca template de bundle compatível com a família
  const templateName = Object.keys(blueprint.bundleTemplates).find(
    t => blueprint.bundleTemplates[t].family === input.family
  );

  if (!templateName) {
    return { ok: true, components: [], log: `Sem template de bundle para família ${input.family}` };
  }

  const template = blueprint.bundleTemplates[templateName];
  const components = template.components.map(c => ({
    role: c.role,
    required: c.required,
    minQty: c.minQty,
    maxQty: c.maxQty,
    family: c.family,
  }));

  return {
    ok: true,
    components, templateName,
    log: `Bundle "${templateName}" montado com ${components.length} componentes (${components.filter(c => c.required).length} obrigatórios)`,
  };
}

// Step 6: Order Decomposition — gera plano DRO
function stepOrderDecomposition(blueprint, input) {
  const plan = blueprint.orderDecomposition[input.family] || [];
  return {
    ok: true,
    decompositionPlan: plan,
    log: plan.length ? `Plano DRO: ${plan.length} steps de fulfillment` : 'Sem plano de decomposição para esta família',
  };
}

// Step 7: Validation — valida contra regras do blueprint
function stepValidation(blueprint, assembled) {
  const issues = [];
  const passed = [];

  blueprint.validations.forEach(v => {
    let ok = true;
    switch (v.rule) {
      case 'sellingModelRequired':
        ok = !!assembled.sellingModel; break;
      case 'pricebookEntryRequired':
        ok = !assembled.smConfig.recurring || assembled.priceBookEntries.length > 0; break;
      case 'classificationRequired':
        ok = !!assembled.classification?.name; break;
      case 'bundleNeedsComponents':
        ok = assembled.classify.productType !== 'Bundle' || (assembled.components && assembled.components.some(c => c.required)); break;
      case 'mrcNeedsBillingFrequency':
        ok = !assembled.smConfig.recurring || assembled.priceBookEntries.some(p => p.frequency); break;
    }
    if (ok) passed.push(v.rule);
    else issues.push(v.message);
  });

  return {
    ok: issues.length === 0,
    issues, passed,
    log: `Validação: ${passed.length} regras OK${issues.length ? ', ' + issues.length + ' issues' : ''}`,
  };
}

// ── Helpers ──
function generateCode(name, family) {
  const prefix = (family || 'PROD').slice(0, 4).toUpperCase();
  const slug = name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
  return `${prefix}-${slug}`;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN WORKER — executa o pipeline completo
// ═══════════════════════════════════════════════════════════════════

function runWorkerPipeline(cloudId, input) {
  const blueprint = CLOUD_BLUEPRINTS[cloudId];
  if (!blueprint) return { ok: false, error: `Blueprint "${cloudId}" não existe` };
  if (blueprint.status === 'planned') return { ok: false, error: `Blueprint "${blueprint.label}" ainda não está implementado` };

  const trace = [];
  const result = { cloud: blueprint.label, version: blueprint.version, input };

  // Step 1
  const s1 = stepTemplateMatching(blueprint, input);
  trace.push({ step: 'Template Matching', ...s1 });
  if (!s1.ok) return { ok: false, error: s1.error, trace };

  // Step 2
  const s2 = stepProductStructure(blueprint, input, s1.family);
  trace.push({ step: 'Product Structure', ok: s2.ok, log: s2.log });

  // Step 3
  const s3 = stepAttributesInjection(s1.family);
  trace.push({ step: 'Attributes Injection', ok: s3.ok, log: s3.log });

  // Step 4
  const s4 = stepPricingScaffold(blueprint, input, s1.family, s2.smConfig);
  trace.push({ step: 'Pricing Scaffold', ok: s4.ok, log: s4.log });

  // Step 5
  const s5 = stepBundleAssembly(blueprint, input, s1.family);
  trace.push({ step: 'Bundle Assembly', ok: s5.ok, log: s5.log });

  // Step 6
  const s6 = stepOrderDecomposition(blueprint, input);
  trace.push({ step: 'Order Decomposition', ok: s6.ok, log: s6.log });

  // Build assembled object
  const assembled = {
    ...s2,
    attributes: s3.attributes,
    priceBookEntries: s4.priceBookEntries,
    pricingRules: s4.pricingRules,
    components: s5.components,
    bundleTemplate: s5.templateName,
    decompositionPlan: s6.decompositionPlan,
  };

  // Step 7
  const s7 = stepValidation(blueprint, assembled);
  trace.push({ step: 'Validation', ok: s7.ok, log: s7.log, issues: s7.issues });

  // Build final template_json (compatível com rc_products)
  const template_json = {
    product: assembled.product,
    recordType: assembled.classification.name,
    classification: assembled.classify,
    lifecycle: assembled.lifecycle,
    pricing: {
      currency: input.currency || 'BRL',
      listPrice: 0,
      chargeType: assembled.smConfig.chargeType,
      billingFrequency: assembled.smConfig.billingFrequency,
    },
    related: {
      attributes: assembled.attributes.map(a => ({ name: a.name, value: a.value, priceImpacting: a.priceImpacting })),
      priceBookEntries: assembled.priceBookEntries,
      pricingRules: assembled.pricingRules.map(r => ({ name: r.name, ruleType: r.ruleType, adjustmentType: r.actions?.[0]?.adjustmentType || '', value: r.actions?.[0]?.value || '' })),
      childComponents: assembled.components.map(c => ({ productName: c.role, required: c.required, minQty: c.minQty, maxQty: c.maxQty })),
      sellingModelOptions: [{ model: assembled.sellingModel, chargeType: assembled.smConfig.chargeType, billingFrequency: assembled.smConfig.billingFrequency }],
    },
    _worker: {
      decompositionPlan: assembled.decompositionPlan,
      bundleTemplate: assembled.bundleTemplate,
      generatedAt: new Date().toISOString(),
      engine: 'deterministic-worker-v1',
      cloud: cloudId,
    },
  };

  return {
    ok: true,
    cloud: blueprint.label,
    version: blueprint.version,
    template_json,
    pricingRulesDetailed: assembled.pricingRules,
    trace,
    validation: { passed: s7.passed, issues: s7.issues },
    summary: {
      attributes: assembled.attributes.length,
      priceBookEntries: assembled.priceBookEntries.length,
      pricingRules: assembled.pricingRules.length,
      components: assembled.components.length,
      decompositionSteps: assembled.decompositionPlan.length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerWorkerEngineRoutes(app) {

  // Lista blueprints disponíveis
  app.get('/api/worker/blueprints', (req, res) => {
    const list = Object.values(CLOUD_BLUEPRINTS).map(b => ({
      id: b.id,
      label: b.label,
      version: b.version,
      status: b.status || 'active',
      families: b.productFamilies ? Object.keys(b.productFamilies) : [],
      objects: b.objectTemplates ? Object.keys(b.objectTemplates) : [],
    }));
    res.json(list);
  });

  // Detalhe de um blueprint (famílias, atributos, patterns)
  app.get('/api/worker/blueprints/:cloudId', (req, res) => {
    const b = CLOUD_BLUEPRINTS[req.params.cloudId];
    if (!b) return res.status(404).json({ error: 'Blueprint não encontrado' });
    res.json(b);
  });

  // PREVIEW: roda o pipeline mas NÃO salva (dry-run)
  app.post('/api/worker/preview', (req, res) => {
    try {
      const { cloud, input } = req.body;
      if (!cloud || !input || !input.name || !input.family) {
        return res.status(400).json({ error: 'cloud, input.name e input.family são obrigatórios' });
      }
      const result = runWorkerPipeline(cloud, input);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // RUN: roda o pipeline E persiste no rc_products
  app.post('/api/worker/run', async (req, res) => {
    try {
      const { cloud, input } = req.body;
      if (!cloud || !input || !input.name || !input.family) {
        return res.status(400).json({ error: 'cloud, input.name e input.family são obrigatórios' });
      }

      const result = runWorkerPipeline(cloud, input);
      if (!result.ok) return res.status(400).json(result);

      // Persiste o produto
      const prodResult = await pool.query(
        `INSERT INTO rc_products (name, product_code, product_family, description, ai_input, ai_output)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [input.name, result.template_json.product.ProductCode, input.family,
         result.template_json.product.Description,
         JSON.stringify(input), 'deterministic-worker']
      );
      const product = prodResult.rows[0];

      // Cria versão com o template
      await pool.query(
        `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
         VALUES ($1, 1, $2, $3)`,
        [product.id, JSON.stringify(result.template_json), 'Gerado pelo Worker Engine (determinístico)']
      );

      // Persiste pricing rules geradas
      let rulesCreated = 0;
      for (const rule of result.pricingRulesDetailed) {
        if (!rule.ruleType) continue;
        try {
          await pool.query(
            `INSERT INTO rc_pricing_rules (name, rule_type, evaluation_scope, evaluation_event, conditions_json, actions_json, applicable_families, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [rule.name, rule.ruleType, rule.evaluationScope, rule.evaluationEvent,
             JSON.stringify(rule.conditions || []), JSON.stringify(rule.actions || []),
             JSON.stringify(rule.applicableFamilies || []), 'Gerada pelo Worker Engine']
          );
          rulesCreated++;
        } catch (e) { /* duplicata, ignora */ }
      }

      res.json({
        ok: true,
        productId: product.id,
        product,
        rulesCreated,
        summary: result.summary,
        trace: result.trace,
        validation: result.validation,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // BATCH: roda múltiplos produtos de uma vez
  app.post('/api/worker/batch', async (req, res) => {
    try {
      const { cloud, items } = req.body;
      if (!cloud || !Array.isArray(items)) {
        return res.status(400).json({ error: 'cloud e items[] são obrigatórios' });
      }
      const results = [];
      for (const input of items) {
        const result = runWorkerPipeline(cloud, input);
        if (result.ok) {
          const prodResult = await pool.query(
            `INSERT INTO rc_products (name, product_code, product_family, description, ai_input, ai_output)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name`,
            [input.name, result.template_json.product.ProductCode, input.family,
             result.template_json.product.Description, JSON.stringify(input), 'deterministic-worker']
          );
          await pool.query(
            `INSERT INTO rc_product_versions (product_id, version_number, template_json, notes)
             VALUES ($1, 1, $2, $3)`,
            [prodResult.rows[0].id, JSON.stringify(result.template_json), 'Worker Engine batch']
          );
          results.push({ ok: true, name: input.name, productId: prodResult.rows[0].id, summary: result.summary });
        } else {
          results.push({ ok: false, name: input.name, error: result.error });
        }
      }
      res.json({ ok: true, total: items.length, created: results.filter(r => r.ok).length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[worker-engine] Routes registered: /api/worker/*');
}
