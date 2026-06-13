// src/revenue-catalog.js — Revenue Cloud Catalog Builder
// Plataforma de modelagem de produtos Revenue Cloud com AI

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── DB Init ──
async function initRevenueCatalogDB() {
  const client = await pool.connect();
  try {
    // Produtos
    await client.query(`CREATE TABLE IF NOT EXISTS rc_products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      product_code VARCHAR(100),
      product_family VARCHAR(100),
      status VARCHAR(30) DEFAULT 'RASCUNHO',
      current_version INT DEFAULT 1,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Versões de produto
    await client.query(`CREATE TABLE IF NOT EXISTS rc_product_versions (
      id SERIAL PRIMARY KEY,
      product_id INT REFERENCES rc_products(id) ON DELETE CASCADE,
      version_number INT NOT NULL,
      template_json JSONB,
      ai_input TEXT,
      ai_output TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_rc_pv_product ON rc_product_versions(product_id)');

    // Biblioteca de Atributos
    await client.query(`CREATE TABLE IF NOT EXISTS rc_attributes (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      attr_type VARCHAR(50) NOT NULL,
      possible_values JSONB,
      applicable_families JSONB,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Biblioteca de Modelos de Precificação
    await client.query(`CREATE TABLE IF NOT EXISTS rc_pricing_models (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      charge_type VARCHAR(50) NOT NULL,
      parameters_json JSONB,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Biblioteca de Bundles
    await client.query(`CREATE TABLE IF NOT EXISTS rc_bundles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      items_json JSONB,
      rules_json JSONB,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Componentes de produto (ligação produto ↔ bibliotecas)
    await client.query(`CREATE TABLE IF NOT EXISTS rc_product_components (
      id SERIAL PRIMARY KEY,
      product_version_id INT REFERENCES rc_product_versions(id) ON DELETE CASCADE,
      component_type VARCHAR(30) NOT NULL,
      component_id INT NOT NULL,
      config_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_rc_pc_version ON rc_product_components(product_version_id)');

    // Relações entre produtos
    await client.query(`CREATE TABLE IF NOT EXISTS rc_product_relations (
      id SERIAL PRIMARY KEY,
      source_product_id INT REFERENCES rc_products(id) ON DELETE CASCADE,
      target_product_id INT REFERENCES rc_products(id) ON DELETE CASCADE,
      relation_type VARCHAR(30) NOT NULL,
      config_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_rc_pr_source ON rc_product_relations(source_product_id)');

    // Infraestrutura do Catálogo (Pricebooks, Catalogs, etc.)
    await client.query(`CREATE TABLE IF NOT EXISTS rc_catalog_config (
      id SERIAL PRIMARY KEY,
      config_type VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      config_json JSONB,
      is_default BOOLEAN DEFAULT FALSE,
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Knowledge Base
    await client.query(`CREATE TABLE IF NOT EXISTS rc_kb_documents (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      filename VARCHAR(255),
      content_type VARCHAR(50),
      doc_version VARCHAR(50),
      content_text TEXT,
      chunks_json JSONB,
      is_active BOOLEAN DEFAULT TRUE,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Regras de Negócio
    await client.query(`CREATE TABLE IF NOT EXISTS rc_business_rules (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      rule_type VARCHAR(50) DEFAULT 'constraint',
      description TEXT NOT NULL,
      applicable_families JSONB,
      applicable_objects JSONB,
      priority VARCHAR(20) DEFAULT 'medium',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Perfis de acesso do Ever i9
    await client.query(`CREATE TABLE IF NOT EXISTS rc_profiles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      permissions JSONB DEFAULT '[]',
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Seed perfis padrão se não existirem
    await client.query(`INSERT INTO rc_profiles (name, permissions, description)
      VALUES ('architect', '["rc_full_access","org_read","org_write"]', 'Arquiteto Salesforce — acesso completo ao Revenue Catalog')
      ON CONFLICT (name) DO NOTHING`);

    console.log('[RC] Revenue Catalog tables initialized');
  } finally {
    client.release();
  }
}

// ── ROUTES ──
export function registerRevenueCatalogRoutes(app) {

  // Init DB on startup
  initRevenueCatalogDB().catch(err => console.error('[RC] DB init error:', err.message));

  // =============================================
  // PRODUCTS
  // =============================================

  // List products
  app.get('/api/rc/products', async (req, res) => {
    try {
      const { status, family, search } = req.query;
      let q = 'SELECT * FROM rc_products WHERE 1=1';
      const params = [];
      if (status) { params.push(status); q += ` AND status = $${params.length}`; }
      if (family) { params.push(family); q += ` AND product_family = $${params.length}`; }
      if (search) { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`; }
      q += ' ORDER BY updated_at DESC';
      const result = await pool.query(q, params);
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get single product with current version
  app.get('/api/rc/products/:id', async (req, res) => {
    try {
      const product = await pool.query('SELECT * FROM rc_products WHERE id = $1', [req.params.id]);
      if (!product.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
      const versions = await pool.query('SELECT * FROM rc_product_versions WHERE product_id = $1 ORDER BY version_number DESC', [req.params.id]);
      const relations = await pool.query(`SELECT r.*, p.name as target_name, p.status as target_status
        FROM rc_product_relations r JOIN rc_products p ON r.target_product_id = p.id
        WHERE r.source_product_id = $1`, [req.params.id]);
      const components = versions.rows.length ? await pool.query(
        'SELECT * FROM rc_product_components WHERE product_version_id = $1', [versions.rows[0].id]
      ) : { rows: [] };
      res.json({ ...product.rows[0], versions: versions.rows, relations: relations.rows, components: components.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Create product
  app.post('/api/rc/products', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { name, description, product_code, product_family, template_json, ai_input, ai_output, notes } = req.body;
      const product = await client.query(
        `INSERT INTO rc_products (name, description, product_code, product_family, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, description || '', product_code || '', product_family || '', req.body.created_by || 'admin']
      );
      const pid = product.rows[0].id;
      await client.query(
        `INSERT INTO rc_product_versions (product_id, version_number, template_json, ai_input, ai_output, notes)
         VALUES ($1, 1, $2, $3, $4, $5)`,
        [pid, JSON.stringify(template_json || {}), ai_input || '', ai_output || '', notes || '']
      );
      await client.query('COMMIT');
      res.json(product.rows[0]);
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
    finally { client.release(); }
  });

  // Update product metadata
  app.put('/api/rc/products/:id', async (req, res) => {
    try {
      const { name, description, product_code, product_family, status } = req.body;
      const result = await pool.query(
        `UPDATE rc_products SET name=COALESCE($1,name), description=COALESCE($2,description),
         product_code=COALESCE($3,product_code), product_family=COALESCE($4,product_family),
         status=COALESCE($5,status), updated_at=NOW() WHERE id=$6 RETURNING *`,
        [name, description, product_code, product_family, status, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Create new version
  app.post('/api/rc/products/:id/versions', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const product = await client.query('SELECT * FROM rc_products WHERE id = $1', [req.params.id]);
      if (!product.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Produto não encontrado' }); }
      const newVersion = product.rows[0].current_version + 1;
      const { template_json, notes, ai_input, ai_output } = req.body;
      const version = await client.query(
        `INSERT INTO rc_product_versions (product_id, version_number, template_json, ai_input, ai_output, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.params.id, newVersion, JSON.stringify(template_json || {}), ai_input || '', ai_output || '', notes || '']
      );
      await client.query('UPDATE rc_products SET current_version=$1, updated_at=NOW(), status=\'RASCUNHO\' WHERE id=$2', [newVersion, req.params.id]);
      await client.query('COMMIT');
      res.json(version.rows[0]);
    } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
    finally { client.release(); }
  });

  // Delete product
  app.delete('/api/rc/products/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_products WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // PRODUCT RELATIONS
  // =============================================

  app.post('/api/rc/relations', async (req, res) => {
    try {
      const { source_product_id, target_product_id, relation_type, config_json } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_product_relations (source_product_id, target_product_id, relation_type, config_json)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [source_product_id, target_product_id, relation_type, JSON.stringify(config_json || {})]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/relations/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_product_relations WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // LIBRARY: ATTRIBUTES
  // =============================================

  app.get('/api/rc/attributes', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM rc_attributes ORDER BY name');
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/attributes', async (req, res) => {
    try {
      const { name, attr_type, possible_values, applicable_families, description } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_attributes (name, attr_type, possible_values, applicable_families, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, attr_type, JSON.stringify(possible_values || []), JSON.stringify(applicable_families || []), description || '']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/rc/attributes/:id', async (req, res) => {
    try {
      const { name, attr_type, possible_values, applicable_families, description } = req.body;
      const result = await pool.query(
        `UPDATE rc_attributes SET name=COALESCE($1,name), attr_type=COALESCE($2,attr_type),
         possible_values=COALESCE($3,possible_values), applicable_families=COALESCE($4,applicable_families),
         description=COALESCE($5,description) WHERE id=$6 RETURNING *`,
        [name, attr_type, possible_values ? JSON.stringify(possible_values) : null,
         applicable_families ? JSON.stringify(applicable_families) : null, description, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/attributes/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_attributes WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // LIBRARY: PRICING MODELS
  // =============================================

  app.get('/api/rc/pricing-models', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM rc_pricing_models ORDER BY name');
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/pricing-models', async (req, res) => {
    try {
      const { name, charge_type, parameters_json, description } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_pricing_models (name, charge_type, parameters_json, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, charge_type, JSON.stringify(parameters_json || {}), description || '']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/rc/pricing-models/:id', async (req, res) => {
    try {
      const { name, charge_type, parameters_json, description } = req.body;
      const result = await pool.query(
        `UPDATE rc_pricing_models SET name=COALESCE($1,name), charge_type=COALESCE($2,charge_type),
         parameters_json=COALESCE($3,parameters_json), description=COALESCE($4,description) WHERE id=$5 RETURNING *`,
        [name, charge_type, parameters_json ? JSON.stringify(parameters_json) : null, description, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/pricing-models/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_pricing_models WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // LIBRARY: BUNDLES
  // =============================================

  app.get('/api/rc/bundles', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM rc_bundles ORDER BY name');
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/bundles', async (req, res) => {
    try {
      const { name, items_json, rules_json, description } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_bundles (name, items_json, rules_json, description)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, JSON.stringify(items_json || []), JSON.stringify(rules_json || {}), description || '']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/rc/bundles/:id', async (req, res) => {
    try {
      const { name, items_json, rules_json, description } = req.body;
      const result = await pool.query(
        `UPDATE rc_bundles SET name=COALESCE($1,name), items_json=COALESCE($2,items_json),
         rules_json=COALESCE($3,rules_json), description=COALESCE($4,description) WHERE id=$5 RETURNING *`,
        [name, items_json ? JSON.stringify(items_json) : null,
         rules_json ? JSON.stringify(rules_json) : null, description, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/bundles/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_bundles WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // CATALOG INFRASTRUCTURE (Pricebooks, Catalogs, etc.)
  // =============================================

  app.get('/api/rc/catalog-config', async (req, res) => {
    try {
      const { config_type } = req.query;
      let q = 'SELECT * FROM rc_catalog_config';
      const params = [];
      if (config_type) { params.push(config_type); q += ' WHERE config_type = $1'; }
      q += ' ORDER BY config_type, name';
      const result = await pool.query(q, params);
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/catalog-config', async (req, res) => {
    try {
      const { config_type, name, config_json, is_default, description } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_catalog_config (config_type, name, config_json, is_default, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [config_type, name, JSON.stringify(config_json || {}), is_default || false, description || '']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/rc/catalog-config/:id', async (req, res) => {
    try {
      const { name, config_json, is_default, description } = req.body;
      const result = await pool.query(
        `UPDATE rc_catalog_config SET name=COALESCE($1,name), config_json=COALESCE($2,config_json),
         is_default=COALESCE($3,is_default), description=COALESCE($4,description), updated_at=NOW()
         WHERE id=$5 RETURNING *`,
        [name, config_json ? JSON.stringify(config_json) : null, is_default, description, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/catalog-config/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_catalog_config WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // BUSINESS RULES (Regras de Negócio)
  // =============================================

  app.get('/api/rc/business-rules', async (req, res) => {
    try {
      const { category, active_only } = req.query;
      let q = 'SELECT * FROM rc_business_rules WHERE 1=1';
      const params = [];
      if (category) { params.push(category); q += ` AND category = $${params.length}`; }
      if (active_only === 'true') q += ' AND is_active = true';
      q += ' ORDER BY priority DESC, name';
      const result = await pool.query(q, params);
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/business-rules', async (req, res) => {
    try {
      const { name, category, rule_type, description, applicable_families, applicable_objects, priority } = req.body;
      if (!name || !description) return res.status(400).json({ error: 'Nome e descrição são obrigatórios' });
      const result = await pool.query(
        `INSERT INTO rc_business_rules (name, category, rule_type, description, applicable_families, applicable_objects, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [name, category || 'geral', rule_type || 'constraint', description,
         JSON.stringify(applicable_families || []), JSON.stringify(applicable_objects || []), priority || 'medium']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/rc/business-rules/:id', async (req, res) => {
    try {
      const { name, category, rule_type, description, applicable_families, applicable_objects, priority, is_active } = req.body;
      const result = await pool.query(
        `UPDATE rc_business_rules SET name=COALESCE($1,name), category=COALESCE($2,category),
         rule_type=COALESCE($3,rule_type), description=COALESCE($4,description),
         applicable_families=COALESCE($5,applicable_families), applicable_objects=COALESCE($6,applicable_objects),
         priority=COALESCE($7,priority), is_active=COALESCE($8,is_active) WHERE id=$9 RETURNING *`,
        [name, category, rule_type, description,
         applicable_families ? JSON.stringify(applicable_families) : null,
         applicable_objects ? JSON.stringify(applicable_objects) : null,
         priority, is_active, req.params.id]
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/business-rules/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_business_rules WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // KNOWLEDGE BASE
  // =============================================

  app.get('/api/rc/kb', async (req, res) => {
    try {
      const result = await pool.query('SELECT id, title, filename, content_type, doc_version, is_active, uploaded_at FROM rc_kb_documents ORDER BY uploaded_at DESC');
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/kb', async (req, res) => {
    try {
      const { title, filename, content_type, doc_version, content_text } = req.body;
      // Simple chunking: split by paragraphs, group into ~1000 char chunks
      const chunks = [];
      if (content_text) {
        const paragraphs = content_text.split(/\n\n+/);
        let current = '';
        for (const p of paragraphs) {
          if (current.length + p.length > 1500 && current.length > 0) {
            chunks.push(current.trim());
            current = p;
          } else {
            current += '\n\n' + p;
          }
        }
        if (current.trim()) chunks.push(current.trim());
      }
      const result = await pool.query(
        `INSERT INTO rc_kb_documents (title, filename, content_type, doc_version, content_text, chunks_json)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, filename, doc_version, uploaded_at`,
        [title, filename || '', content_type || 'text', doc_version || '1.0', content_text || '', JSON.stringify(chunks)]
      );
      res.json({ ...result.rows[0], chunks_count: chunks.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/rc/kb/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM rc_kb_documents WHERE id = $1', [req.params.id]);
      res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // AI MODELING
  // =============================================

  app.post('/api/rc/ai/model', async (req, res) => {
    try {
      const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
      const GROK_KEY = process.env.GROK_KEY;

      if (!ANTHROPIC_KEY && !GROK_KEY) return res.status(500).json({ error: 'Nenhuma chave de AI configurada' });

      const { description, product_family } = req.body;
      if (!description) return res.status(400).json({ error: 'Descrição do produto é obrigatória' });

      // Load KB chunks for context
      const kbResult = await pool.query(
        'SELECT chunks_json FROM rc_kb_documents WHERE is_active = true ORDER BY uploaded_at DESC LIMIT 5'
      );
      let kbContext = '';
      for (const row of kbResult.rows) {
        const chunks = typeof row.chunks_json === 'string' ? JSON.parse(row.chunks_json) : row.chunks_json;
        if (Array.isArray(chunks)) kbContext += chunks.join('\n\n') + '\n\n---\n\n';
      }

      // Load existing attributes and pricing models for reference
      const attrs = await pool.query('SELECT name, attr_type, possible_values FROM rc_attributes');
      const pricings = await pool.query('SELECT name, charge_type, parameters_json FROM rc_pricing_models');
      const bundles = await pool.query('SELECT name, items_json, rules_json FROM rc_bundles');
      const configs = await pool.query("SELECT name, config_type, config_json FROM rc_catalog_config");
      const rules = await pool.query("SELECT name, category, rule_type, description, applicable_families, priority FROM rc_business_rules WHERE is_active = true ORDER BY priority DESC");

      const libraryContext = `
BIBLIOTECA DE ATRIBUTOS EXISTENTES:
${attrs.rows.map(a => `- ${a.name} (${a.attr_type}): ${JSON.stringify(a.possible_values)}`).join('\n') || 'Nenhum cadastrado'}

MODELOS DE PRECIFICAÇÃO EXISTENTES:
${pricings.rows.map(p => `- ${p.name} (${p.charge_type}): ${JSON.stringify(p.parameters_json)}`).join('\n') || 'Nenhum cadastrado'}

BUNDLES EXISTENTES:
${bundles.rows.map(b => `- ${b.name}: ${JSON.stringify(b.items_json)}`).join('\n') || 'Nenhum cadastrado'}

INFRAESTRUTURA DO CATÁLOGO:
${configs.rows.map(c => `- [${c.config_type}] ${c.name}: ${JSON.stringify(c.config_json)}`).join('\n') || 'Nenhuma configurada'}

REGRAS DE NEGÓCIO ATIVAS (OBRIGATÓRIO considerar na modelagem):
${rules.rows.map(r => `- [${r.priority.toUpperCase()}] [${r.category}] ${r.name}: ${r.description}${r.applicable_families?.length ? ' (Famílias: ' + r.applicable_families.join(', ') + ')' : ''}`).join('\n') || 'Nenhuma regra cadastrada'}
`;

      const systemPrompt = `Você é um especialista em Salesforce Revenue Cloud / Revenue Lifecycle Management (RLM).
Sua função é receber a descrição de um produto em linguagem natural e gerar um TEMPLATE DE MODELAGEM mapeado para os objetos Revenue Cloud.

${kbContext ? 'KNOWLEDGE BASE REVENUE CLOUD (use como referência principal):\n' + kbContext : 'ATENÇÃO: Nenhum documento foi carregado na KB ainda. Use seu conhecimento de Revenue Cloud, mas sinalize que a KB está vazia.'}

${libraryContext}

REGRAS:
1. Mapeie CADA aspecto do produto para o objeto Revenue Cloud correspondente
2. Se existir atributo/pricing/bundle na biblioteca que se aplique, REFERENCIE pelo nome
3. Se precisar de novo atributo/pricing/bundle, PROPONHA a criação
4. Responda APENAS em JSON válido, sem markdown, sem backticks
5. Se a KB não cobrir algum aspecto, sinalize em "kb_gaps"
6. SEMPRE considere e aplique as REGRAS DE NEGÓCIO ATIVAS listadas acima. Documente no campo "business_rules_applied" quais regras foram consideradas e como impactaram a modelagem

FORMATO DE RESPOSTA (JSON):
{
  "product_name": "Nome do Produto",
  "product_code": "CODIGO",
  "product_family": "Família",
  "summary": "Resumo da modelagem",
  "revenue_cloud_mapping": [
    {
      "component": "Descrição do componente de negócio",
      "sf_object": "Objeto Salesforce",
      "sf_fields": { "campo": "valor" },
      "notes": "Observações"
    }
  ],
  "attributes": [
    { "name": "Nome", "source": "existing|new", "values": [], "config": {} }
  ],
  "pricing": [
    { "model_name": "Nome", "source": "existing|new", "charge_type": "Recurring|OneTime|Usage", "config": {} }
  ],
  "bundle_config": {
    "is_bundle": true,
    "items": [{ "product": "Nome", "required": true, "min_qty": 1, "max_qty": null }]
  },
  "contract_terms": { "min_duration_months": 0, "auto_renewal": false, "early_termination": {} },
  "catalog_infrastructure": {
    "pricebook": "Nome do Pricebook sugerido",
    "catalog": "Nome do Catálogo sugerido",
    "notes": "Observações sobre infra necessária"
  },
  "proposed_new_library_items": {
    "attributes": [],
    "pricing_models": [],
    "bundles": []
  },
  "kb_gaps": ["Lista de aspectos que a KB não cobre"],
  "business_rules_applied": [
    { "rule": "Nome da regra", "impact": "Como a regra impactou a modelagem" }
  ],
  "implementation_notes": "Notas de implementação"
}`;

      const userMsg = `Modele o seguinte produto Revenue Cloud:\n\n${description}${product_family ? `\n\nFamília sugerida: ${product_family}` : ''}`;

      let aiText = '';
      let modelUsed = 'unknown';
      let tokensIn = 0, tokensOut = 0;

      // Try Anthropic first, fallback to Grok
      let usedFallback = false;
      if (ANTHROPIC_KEY) {
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] })
          });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message || 'Anthropic error');
          aiText = data.content?.[0]?.text || '';
          modelUsed = 'claude-sonnet-4-6';
          tokensIn = data.usage?.input_tokens || 0;
          tokensOut = data.usage?.output_tokens || 0;
        } catch (anthropicErr) {
          console.log('[RC] Anthropic failed, falling back to Grok:', anthropicErr.message);
          usedFallback = true;
        }
      } else {
        usedFallback = true;
      }

      if (usedFallback && GROK_KEY) {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROK_KEY}` },
          body: JSON.stringify({
            model: 'grok-3-mini',
            max_tokens: 4096,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }]
          })
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
        aiText = data.choices?.[0]?.message?.content || '';
        modelUsed = 'grok-3-mini (fallback)';
        tokensIn = data.usage?.prompt_tokens || 0;
        tokensOut = data.usage?.completion_tokens || 0;
      } else if (usedFallback && !GROK_KEY) {
        return res.status(500).json({ error: 'Anthropic indisponível e GROK_KEY não configurada' });
      }

      // Track token usage
      try {
        await pool.query(
          `INSERT INTO token_usage (user_id, command, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
           VALUES (1, 'rc_model', $1, $2, $3, 0, 0)`,
          [modelUsed, tokensIn, tokensOut]
        );
      } catch {}

      // Try to parse the AI output as JSON
      let template = null;
      try {
        const cleaned = aiText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        template = JSON.parse(cleaned);
      } catch {
        template = { raw_output: aiText, parse_error: true };
      }

      res.json({
        template,
        ai_raw: aiText,
        model: modelUsed,
        tokens: { input: tokensIn, output: tokensOut },
        kb_used: kbResult.rows.length > 0
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // PROFILES
  // =============================================

  app.get('/api/rc/profiles', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM rc_profiles ORDER BY name');
      res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/rc/profiles', async (req, res) => {
    try {
      const { name, permissions, description } = req.body;
      const result = await pool.query(
        `INSERT INTO rc_profiles (name, permissions, description) VALUES ($1, $2, $3) RETURNING *`,
        [name, JSON.stringify(permissions || []), description || '']
      );
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // =============================================
  // STATS / DASHBOARD
  // =============================================

  app.get('/api/rc/stats', async (req, res) => {
    try {
      const products = await pool.query('SELECT status, COUNT(*) as count FROM rc_products GROUP BY status');
      const families = await pool.query('SELECT product_family, COUNT(*) as count FROM rc_products WHERE product_family IS NOT NULL GROUP BY product_family');
      const attrs = await pool.query('SELECT COUNT(*) as count FROM rc_attributes');
      const pricings = await pool.query('SELECT COUNT(*) as count FROM rc_pricing_models');
      const bundlesCount = await pool.query('SELECT COUNT(*) as count FROM rc_bundles');
      const kbDocs = await pool.query('SELECT COUNT(*) as count FROM rc_kb_documents WHERE is_active = true');
      const rulesCount = await pool.query('SELECT COUNT(*) as count FROM rc_business_rules WHERE is_active = true');
      const configs = await pool.query('SELECT config_type, COUNT(*) as count FROM rc_catalog_config GROUP BY config_type');
      res.json({
        products_by_status: products.rows,
        products_by_family: families.rows,
        total_attributes: parseInt(attrs.rows[0].count),
        total_pricing_models: parseInt(pricings.rows[0].count),
        total_bundles: parseInt(bundlesCount.rows[0].count),
        total_kb_docs: parseInt(kbDocs.rows[0].count),
        total_business_rules: parseInt(rulesCount.rows[0].count),
        catalog_config: configs.rows
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  console.log('[RC] Revenue Catalog routes registered at /api/rc/*');
}
