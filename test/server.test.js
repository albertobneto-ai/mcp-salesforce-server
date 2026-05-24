import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.TEST_URL || 'https://mcp-sf-provisioning-462dd29c2455.herokuapp.com';

// Helper: fetch JSON
async function fetchJSON(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  return { status: res.status, data: await res.json() };
}

// ================================
// Health & Connection Tests
// ================================
describe('Server Health', () => {
  it('should return server info', async () => {
    const { status, data } = await fetchJSON('/');
    assert.equal(status, 200);
    assert.ok(data.version, 'Should have version');
    assert.equal(data.status, 'running');
  });

  it('should test Salesforce connection', async () => {
    const { status, data } = await fetchJSON('/test-connection');
    assert.equal(status, 200);
    assert.ok(data.orgId || data.status, 'Should return orgId or status');
  });
});

// ================================
// Describe Endpoint Tests
// ================================
describe('Describe API', () => {
  it('should describe Lead object', async () => {
    const { status, data } = await fetchJSON('/api/describe/Lead');
    assert.equal(status, 200);
    assert.ok(data.name === 'Lead', 'Should return Lead object');
    assert.ok(data.fields.length > 0, 'Should have fields');
  });

  it('should describe Account object', async () => {
    const { status, data } = await fetchJSON('/api/describe/Account');
    assert.equal(status, 200);
    assert.ok(data.fields.length > 0, 'Should have fields');
  });

  it('should return error for invalid object', async () => {
    const { status } = await fetchJSON('/api/describe/InvalidObject999');
    assert.ok(status >= 400, 'Should return error status');
  });
});

// ================================
// SOQL Endpoint Tests
// ================================
describe('SOQL API', () => {
  it('should execute SOQL query', async () => {
    const { status, data } = await fetchJSON('/api/soql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT COUNT() FROM Account' }),
    });
    assert.equal(status, 200);
    assert.ok('totalSize' in data, 'Should have totalSize');
  });

  it('should reject invalid SOQL', async () => {
    const { status } = await fetchJSON('/api/soql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'INVALID QUERY' }),
    });
    assert.ok(status >= 400, 'Should return error');
  });
});

// ================================
// Scan Org Tests
// ================================
describe('Scan Org', () => {
  it('should return org metadata summary', async () => {
    const { status, data } = await fetchJSON('/api/scan-org');
    assert.equal(status, 200);
    assert.ok('totals' in data, 'Should have totals');
    assert.ok('scan' in data, 'Should have scan');
    assert.ok('customFields' in data.totals, 'Should count custom fields');
  });
});

// ================================
// Scratch Org Smart Tests
// ================================
describe('Smart Scratch Orgs', () => {
  it('should suggest workstream from description', async () => {
    const { status, data } = await fetchJSON('/api/scratch-orgs/suggest?q=lead+scoring+cadencia');
    assert.equal(status, 200);
    assert.ok(data.suggestions, 'Should have suggestions');
    assert.ok(data.suggestions.length > 0, 'Should suggest at least one');
    assert.equal(data.suggestions[0].workstream, 'leads');
  });

  it('should detect orders workstream', async () => {
    const { status, data } = await fetchJSON('/api/scratch-orgs/suggest?q=order+fulfillment+tmforum');
    assert.equal(status, 200);
    assert.equal(data.suggestions[0].workstream, 'orders');
  });

  it('should return dashboard', async () => {
    const { status, data } = await fetchJSON('/api/scratch-orgs/dashboard');
    assert.equal(status, 200);
    assert.ok('total' in data, 'Should have total');
    assert.ok('limit' in data, 'Should have limit');
    assert.ok('available' in data, 'Should have available');
  });
});

// ================================
// Export SFDX Tests
// ================================
describe('Export SFDX', () => {
  it('should start SFDX export', async () => {
    const { status, data } = await fetchJSON('/api/export-sfdx');
    assert.equal(status, 200);
    assert.ok(data.retrieveId || data.status === 'empty', 'Should return retrieveId or empty');
  });
});

// ================================
// Deploy Validation Tests
// ================================
describe('Deploy Validation', () => {
  it('should accept valid manifest structure', async () => {
    const manifest = {
      specName: 'CI_Test',
      metadata: { customFields: [], customObjects: [], validationRules: [], recordTypes: [] }
    };
    const b64 = Buffer.from(JSON.stringify(manifest)).toString('base64');
    const { status, data } = await fetchJSON(`/api/deploy-b64/${b64}`);
    assert.equal(status, 200);
    assert.ok('summary' in data, 'Should have summary');
    assert.equal(data.summary.total, 0, 'Empty manifest = 0 components');
  });
});
