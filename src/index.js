import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { SalesforceClient } from "./salesforce-client.js";
import { GitHubClient } from "./github-client.js";
import { ManifestManager } from "./manifest-manager.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS - permite chamadas do Claude
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// --- Clients ---
const sfClient = new SalesforceClient({
  loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
  username: process.env.SF_USERNAME,
  password: process.env.SF_PASSWORD,
  securityToken: process.env.SF_SECURITY_TOKEN || "",
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
});

const ghClient = process.env.GH_TOKEN ? new GitHubClient({
  token: process.env.GH_TOKEN,
  owner: process.env.GH_OWNER || "albertobneto-ai",
  repo: process.env.GH_REPO || "mcp-salesforce-server",
}) : null;

const manifestManager = new ManifestManager();

// --- Inject GitHub client for token persistence ---
if (ghClient) sfClient.setGitHubClient(ghClient);

// --- Load persisted tokens on startup ---
sfClient.loadPersistedTokens().catch(err => console.log("Token load skipped:", err.message));


// =============================================
// HELPER: Connect to target org if ?org= provided
// =============================================
async function connectToTargetOrg(req) {
  await sfClient.ensureConnected();
  const orgId = req.query.org;
  if (orgId) {
    await sfClient.connectToScratchOrg(orgId);
    return orgId;
  }
  sfClient.clearTargetOrg();
  return null;
}

// =============================================
// REST API ENDPOINTS
// =============================================

// --- Health check ---
app.get("/", (req, res) => {
  res.json({
    status: "running",
    server: "mcp-salesforce-provisioning",
    version: "3.2.0",
    tools: [
      "describe_org", "deploy_manifest", "deploy_component",
      "validate_manifest", "retrieve_metadata", "run_soql", "list_manifests",
    ],
    features: {
      scratchOrgs: true,
      multiOrg: true,
      mockData: true,
      githubIntegration: !!ghClient,
      deployViaUrl: true,
    },
    storedOrgTokens: sfClient.getStoredOrgs(),
  });
});

// --- Test Salesforce connection ---
app.get("/test-connection", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const identity = await sfClient.conn.identity();
    res.json({
      status: "connected",
      orgId: sfClient.getOrgId(),
      username: identity.username,
      displayName: identity.display_name,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- POST deploy (manifest in body, optional ?org=00DAs...) ---
app.post("/api/deploy", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const result = await sfClient.deployManifest(req.body);
    sfClient.clearTargetOrg();
    res.json({ ...result, targetOrg: targetOrg || "devhub" });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- GET deploy via base64 URL (optional ?org=00DAs...) ---
app.get("/api/deploy-b64/:data", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const manifest = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));
    const result = await sfClient.deployManifest(manifest);
    sfClient.clearTargetOrg();
    res.json({ ...result, targetOrg: targetOrg || "devhub" });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Describe object (optional ?org=) ---
app.get("/api/describe/:objectName", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const desc = await sfClient.describeObject(req.params.objectName);
    sfClient.clearTargetOrg();
    res.json({
      name: desc.name, label: desc.label,
      fields: desc.fields.map(f => ({ name: f.name, label: f.label, type: f.type, custom: f.custom })),
      recordTypes: desc.recordTypeInfos?.map(rt => ({ name: rt.name, active: rt.active })),
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Run SOQL (optional ?org=) ---
app.post("/api/soql", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const result = await sfClient.query(req.body.query);
    sfClient.clearTargetOrg();
    res.json({ totalSize: result.totalSize, records: result.records });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// MOCK DATA ENDPOINTS
// =============================================

// --- POST: insert records (body: { objectName, records: [...] }, optional ?org=) ---
app.post("/api/mock-data", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const { objectName, records } = req.body;
    if (!objectName || !records?.length) {
      return res.status(400).json({ error: "Informe objectName e records[]" });
    }
    const result = await sfClient.insertRecords(objectName, records);
    sfClient.clearTargetOrg();
    res.json(result);
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- GET: insert mock data via base64 URL (optional ?org=) ---
app.get("/api/mock-data-b64/:data", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const payload = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));

    // payload pode ser: { objectName, records } ou { batches: [{ objectName, records }, ...] }
    if (payload.batches) {
      const results = [];
      for (const batch of payload.batches) {
        const result = await sfClient.insertRecords(batch.objectName, batch.records);
        results.push(result);
      }
      sfClient.clearTargetOrg();
      res.json({ batchCount: results.length, results });
    } else {
      const result = await sfClient.insertRecords(payload.objectName, payload.records);
      sfClient.clearTargetOrg();
      res.json(result);
    }
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// SCRATCH ORG ENDPOINTS
// =============================================

// --- Create scratch org ---
app.post("/api/scratch-orgs", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const result = await sfClient.createScratchOrg(req.body);
    res.json({ status: "creating", scratchOrgInfoId: result.id, message: "Scratch org sendo criada. Use GET /api/scratch-orgs/:id para verificar status." });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/scratch-orgs/create/:template", async (req, res) => {
  const templates = {
    leads: { orgName: "CRM-B2B-Leads", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    maps: { orgName: "CRM-B2B-Maps", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    oportunidades: { orgName: "CRM-B2B-Opps", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    orders: { orgName: "CRM-B2B-Orders", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    datacloud: { orgName: "CRM-B2B-DataCloud", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    agentforce: { orgName: "CRM-B2B-Agentforce", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
    whatsapp: { orgName: "CRM-B2B-WhatsApp", edition: "Developer", features: ["SalesCloud", "ServiceCloud"], durationDays: 7 },
  };

  const template = templates[req.params.template];
  if (!template) {
    return res.status(400).json({ status: "error", message: `Template não encontrado. Disponíveis: ${Object.keys(templates).join(", ")}` });
  }

  try {
    await sfClient.ensureConnected();
    const result = await sfClient.createScratchOrg(template);
    res.json({ status: "creating", template: req.params.template, scratchOrgInfoId: result.id, orgName: template.orgName });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- List scratch orgs ---
app.get("/api/scratch-orgs", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const orgs = await sfClient.listScratchOrgs();
    res.json({ count: orgs.length, orgs });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Get scratch org status ---
app.get("/api/scratch-orgs/:id", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const info = await sfClient.getScratchOrgInfo(req.params.id);
    res.json(info || { status: "not_found" });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Delete scratch org (DELETE method) ---
app.delete("/api/scratch-orgs/:id", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    await sfClient.deleteScratchOrg(req.params.id);
    res.json({ status: "deleted", id: req.params.id });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Delete scratch org via GET (browser-friendly) ---
app.get("/api/scratch-orgs/delete/:orgId", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const orgs = await sfClient.conn.query(
      "SELECT Id FROM ActiveScratchOrg WHERE ScratchOrg = '" + req.params.orgId + "'"
    );
    if (orgs.records.length > 0) {
      await sfClient.conn.sobject('ActiveScratchOrg').delete(orgs.records[0].Id);
      res.json({ status: "deleted", orgId: req.params.orgId });
    } else {
      res.json({ status: "not_found" });
    }
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Login to Scratch Org (stores tokens + persists to GitHub) ---
app.get("/api/scratch-orgs/login/:id", async (req, res) => {
  try {
    const result = await sfClient.loginToScratchOrg(req.params.id);
    if (result.success) {
      if (req.query.redirect === "false") {
        res.json({
          status: "authenticated", scratchOrgId: result.scratchOrgId,
          orgName: result.orgName, username: result.username,
          instanceUrl: result.instanceUrl, tokensStored: true,
          message: "Tokens armazenados e persistidos. Deploy multi-org habilitado.",
        });
      } else {
        res.redirect(result.frontDoorUrl);
      }
    } else {
      res.json({
        status: "error", message: result.error,
        loginUrl: result.loginUrl, username: result.username,
        hint: "AuthCode expirado. Recrie a scratch org.",
      });
    }
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// GITHUB ENDPOINTS
// =============================================

app.get("/api/github/status", (req, res) => {
  res.json({ connected: !!ghClient, owner: process.env.GH_OWNER, repo: process.env.GH_REPO });
});

app.get("/api/github/files", async (req, res) => {
  if (!ghClient) return res.status(400).json({ error: "GitHub not configured. Set GH_TOKEN, GH_OWNER, GH_REPO." });
  try {
    const path = req.query.path || "";
    const files = await ghClient.listFiles(path);
    res.json(files);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/github/file", async (req, res) => {
  if (!ghClient) return res.status(400).json({ error: "GitHub not configured." });
  try {
    const file = await ghClient.getFile(req.query.path);
    res.json(file);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.post("/api/github/file", async (req, res) => {
  if (!ghClient) return res.status(400).json({ error: "GitHub not configured." });
  try {
    const { path, content, message } = req.body;
    const result = await ghClient.updateFile(path, content, message);
    res.json({ status: "updated", path, commit: result.commit?.sha });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

app.get("/api/github/commit", async (req, res) => {
  if (!ghClient) return res.status(400).json({ error: "GitHub not configured." });
  try {
    const commit = await ghClient.getLatestCommit();
    res.json(commit);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// MCP SERVER (SSE Transport)
// =============================================

const mcpServer = new McpServer({ name: "salesforce-provisioning", version: "3.2.0" });

mcpServer.tool("describe_org", "Retorna informações da org conectada",
  { objectName: z.string().optional().describe("Nome do objeto para detalhar. Se omitido, lista objetos custom.") },
  async ({ objectName }) => {
    try {
      await sfClient.ensureConnected();
      if (objectName) {
        const desc = await sfClient.describeObject(objectName);
        return { content: [{ type: "text", text: JSON.stringify({ name: desc.name, label: desc.label, fieldCount: desc.fields.length, fields: desc.fields.map(f => ({ name: f.name, label: f.label, type: f.type, custom: f.custom })) }, null, 2) }] };
      }
      const globalDesc = await sfClient.describeGlobal();
      const customObjects = globalDesc.sobjects.filter(s => s.custom).map(s => ({ name: s.name, label: s.label }));
      return { content: [{ type: "text", text: JSON.stringify({ orgId: sfClient.getOrgId(), customObjects }, null, 2) }] };
    } catch (err) { return { content: [{ type: "text", text: `Erro: ${err.message}` }] }; }
  }
);

mcpServer.tool("deploy_manifest", "Faz deploy de metadados na org via manifest JSON",
  { manifest: z.string().describe("Manifest JSON"), checkOnly: z.boolean().default(false) },
  async ({ manifest, checkOnly }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.deployManifest(JSON.parse(manifest), checkOnly);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) { return { content: [{ type: "text", text: `Erro: ${err.message}` }] }; }
  }
);

mcpServer.tool("deploy_component", "Deploy de um componente individual",
  { componentType: z.enum(["CustomObject", "CustomField", "ValidationRule", "RecordType", "Layout", "PermissionSet", "Flow"]), metadata: z.string() },
  async ({ componentType, metadata }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.deployComponent(componentType, JSON.parse(metadata));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) { return { content: [{ type: "text", text: `Erro: ${err.message}` }] }; }
  }
);

mcpServer.tool("run_soql", "Executa query SOQL",
  { query: z.string() },
  async ({ query }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.query(query);
      return { content: [{ type: "text", text: JSON.stringify({ totalSize: result.totalSize, records: result.records }, null, 2) }] };
    } catch (err) { return { content: [{ type: "text", text: `Erro: ${err.message}` }] }; }
  }
);

mcpServer.tool("list_manifests", "Lista manifests disponíveis", {},
  async () => {
    const manifests = manifestManager.listManifests();
    return { content: [{ type: "text", text: JSON.stringify(manifests, null, 2) }] };
  }
);

// --- SSE Transport ---
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).json({ error: "No active session" });
  await transport.handlePostMessage(req, res);
});


// --- Tooling SOQL ---
app.get("/api/tooling-query", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const result = await conn.request({
      method: "GET",
      url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(req.query.q),
    });
    sfClient.clearTargetOrg();
    res.json(result);
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Salesforce Server v3.2.0 running on port ${PORT}`);
  console.log(`Features: ScratchOrgs=true, MultiOrg=true, MockData=true, GitHub=${!!ghClient}, DeployViaUrl=true`);
});
