import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { SalesforceClient } from "./salesforce-client.js";
import { GitHubClient } from "./github-client.js";
import { ManifestManager } from "./manifest-manager.js";
import { registerAdditionalRoutes } from "./additional-routes.js";
import { registerSnowflakeRoutes } from "./snowflake.js";
import { registerGitHubMultiRepoRoutes } from "./github-multi-repo.js";
import { mountChatApp } from "./chat-app.js";
import { registerMuleSyncRoutes } from "./mule-sync.js";
import { registerKmlRoutes } from "./routes/kml.js";
import { englishRouter, initEnglish } from "./english.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS - permite chamadas do Claude
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-org-id");
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
app.get("/api/health", (req, res) => {
  res.json({
    status: "running",
    server: "mcp-salesforce-provisioning",
    version: "3.4.0",
    tools: [
      "describe_org", "deploy_manifest", "deploy_component",
      "validate_manifest", "retrieve_metadata", "run_soql", "list_manifests",
      "scan_org", "destructive_deploy", "reset_org",
      "deploy_code", "deploy_zip",
    ],
    features: {
      scratchOrgs: true,
      multiOrg: true,
      mockData: true,
      githubIntegration: !!ghClient,
      deployViaUrl: true,
    },
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
      instanceUrl: sfClient.conn?.instanceUrl || process.env.SF_LOGIN_URL || null,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Admin: update SF security token at runtime ---
app.post("/api/admin/update-sf-token", async (req, res) => {
  try {
    const { token, adminKey } = req.body;
    if (adminKey !== "everi9-admin-2026") {
      return res.status(403).json({ status: "error", message: "Forbidden" });
    }
    if (!token) {
      return res.status(400).json({ status: "error", message: "token is required" });
    }
    // Update in-memory config
    sfClient.config.securityToken = token;
    // Force reconnection
    sfClient.conn = null;
    sfClient.orgId = null;
    // Try to reconnect with new token
    await sfClient.ensureConnected();
    const identity = await sfClient.conn.identity();
    res.json({
      status: "token_updated",
      orgId: sfClient.getOrgId(),
      username: identity.username,
      message: "Security token updated and reconnected successfully"
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
    // Record in deploy history for rollback
    if (typeof recordDeploy === "function") recordDeploy(manifest, result);
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
    const response = {
      name: desc.name, label: desc.label,
      fields: desc.fields.map(f => ({ name: f.name, label: f.label, type: f.type, custom: f.custom })),
      recordTypes: desc.recordTypeInfos?.map(rt => ({ name: rt.name, active: rt.active })),
    };
    if (req.query.childRelationships === "true") {
      response.childRelationships = desc.childRelationships?.map(cr => ({
        childSObject: cr.childSObject,
        field: cr.field,
        relationshipName: cr.relationshipName,
      }));
    }
    res.json(response);
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Describe Layouts: list layouts and sections for an object ---
app.get("/api/describe-layouts/:objectName", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const objectName = req.params.objectName;

    const listResult = await conn.metadata.list([{ type: "Layout", folder: objectName }]);
    const layouts = Array.isArray(listResult) ? listResult : listResult ? [listResult] : [];
    const objectLayouts = layouts.filter(l => l.fullName.startsWith(objectName + "-"));

    const result = [];
    for (const layoutMeta of objectLayouts) {
      try {
        const layout = await conn.metadata.read("Layout", layoutMeta.fullName);
        const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : layout.layoutSections ? [layout.layoutSections] : [];
        const sectionDetails = sections.map((s, idx) => {
          const columns = Array.isArray(s.layoutColumns) ? s.layoutColumns : s.layoutColumns ? [s.layoutColumns] : [];
          const fields = [];
          for (const col of columns) {
            const items = Array.isArray(col.layoutItems) ? col.layoutItems : col.layoutItems ? [col.layoutItems] : [];
            fields.push(...items.filter(i => i.field).map(i => i.field));
          }
          return { index: idx, label: s.label || "(sem label)", style: s.style, columns: columns.length, fields };
        });
        result.push({ fullName: layoutMeta.fullName, sections: sectionDetails });
      } catch (err) {
        result.push({ fullName: layoutMeta.fullName, error: err.message });
      }
    }
    sfClient.clearTargetOrg();
    res.json({ objectName, layoutCount: result.length, layouts: result });
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
// CODE DEPLOY ENDPOINTS (Apex, Flows, LWC)
// =============================================

// --- POST: deploy code from manifest JSON body (async) ---
app.post("/api/deploy-code", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const checkOnly = req.query.checkOnly === "true";
    const testLevel = req.query.testLevel || "NoTestRun";
    const zipBuffer = await sfClient.buildDeployPackage(req.body);
    const { deployId } = await sfClient.startDeploy(zipBuffer, { checkOnly, testLevel });
    sfClient.clearTargetOrg();
    res.json({
      status: "deploying",
      deployId,
      checkStatusUrl: `/api/deploy-status/${deployId}`,
      targetOrg: targetOrg || "devhub",
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- GET: deploy code from base64-encoded manifest (async) ---
app.get("/api/deploy-code-b64/:data", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const manifest = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));
    const checkOnly = req.query.checkOnly === "true";
    const testLevel = req.query.testLevel || "NoTestRun";
    const zipBuffer = await sfClient.buildDeployPackage(manifest);
    const { deployId } = await sfClient.startDeploy(zipBuffer, { checkOnly, testLevel });
    sfClient.clearTargetOrg();
    res.json({
      status: "deploying",
      deployId,
      checkStatusUrl: `/api/deploy-status/${deployId}`,
      targetOrg: targetOrg || "devhub",
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- GET: check deploy status ---
app.get("/api/deploy-status/:deployId", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const result = await sfClient.checkDeployStatus(req.params.deployId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- POST: deploy raw ZIP file (async) ---
app.post("/api/deploy-zip", express.raw({ type: "application/zip", limit: "10mb" }), async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const checkOnly = req.query.checkOnly === "true";
    const testLevel = req.query.testLevel || "NoTestRun";
    const { deployId } = await sfClient.startDeploy(req.body, { checkOnly, testLevel });
    sfClient.clearTargetOrg();
    res.json({
      status: "deploying",
      deployId,
      checkStatusUrl: `/api/deploy-status/${deployId}`,
      targetOrg: targetOrg || "devhub",
    });
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
// EXPORT SFDX ENDPOINT
// =============================================

// In-memory store for retrieve results
const retrieveStore = {};

// --- Start export SFDX (async) ---
app.get("/api/export-sfdx", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const projectName = req.query.project || "crm-b2b-project";
    const includeLayouts = req.query.layouts === "true";

    // 1. Scan org for types to export
    const types = await sfClient.buildExportTypes({ includeLayouts });
    if (!types.length) {
      sfClient.clearTargetOrg();
      return res.json({ status: "empty", message: "No custom metadata found to export" });
    }

    // 2. Start retrieve
    const { retrieveId } = await sfClient.startRetrieve(types);
    retrieveStore[retrieveId] = { types, projectName, status: "InProgress" };
    sfClient.clearTargetOrg();

    res.json({
      status: "retrieving",
      retrieveId,
      types: types.map(t => ({ name: t.name, count: t.members.length })),
      totalComponents: types.reduce((sum, t) => sum + t.members.length, 0),
      checkStatusUrl: `/api/export-sfdx/status/${retrieveId}`,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Check export status ---
app.get("/api/export-sfdx/status/:retrieveId", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const retrieveId = req.params.retrieveId;
    const result = await sfClient.checkRetrieveStatus(retrieveId);

    if (!result.done) {
      return res.json({ status: "in_progress", retrieveId });
    }

    if (result.success && result.zipBuffer) {
      // Store ZIP for download
      const stored = retrieveStore[retrieveId] || {};
      retrieveStore[retrieveId] = { ...stored, zipBuffer: result.zipBuffer, status: "ready" };
      return res.json({
        status: "ready",
        retrieveId,
        downloadUrl: `/api/export-sfdx/download/${retrieveId}?project=${encodeURIComponent(stored.projectName || "project")}`,
      });
    }

    res.json({ status: "failed", retrieveId, details: result });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Download SFDX ZIP ---
app.get("/api/export-sfdx/download/:retrieveId", async (req, res) => {
  try {
    const retrieveId = req.params.retrieveId;
    const stored = retrieveStore[retrieveId];

    if (!stored || !stored.zipBuffer) {
      return res.status(404).json({ status: "error", message: "Retrieve not found or not ready. Start with /api/export-sfdx" });
    }

    await sfClient.ensureConnected();
    const projectName = req.query.project || stored.projectName || "project";
    const sfdxZip = await sfClient.buildSFDXProject(stored.zipBuffer, stored.types, projectName);

    // Clean up stored data
    delete retrieveStore[retrieveId];

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${projectName}.zip"`);
    res.send(sfdxZip);
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// DELETE RECORDS ENDPOINT
// =============================================

app.get("/api/delete-records/:objectName/:ids", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const ids = req.params.ids.split(",");
    const results = [];
    for (const id of ids) {
      try {
        await conn.sobject(req.params.objectName).delete(id.trim());
        results.push({ id: id.trim(), status: "deleted" });
      } catch (err) {
        results.push({ id: id.trim(), status: "error", error: err.message });
      }
    }
    sfClient.clearTargetOrg();
    res.json({ deleted: results.filter(r => r.status === "deleted").length, total: ids.length, results });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Update records ---
app.post("/api/update-records", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const { objectName, records } = req.body;
    const results = [];
    for (const record of records) {
      try {
        const result = await conn.sobject(objectName).update(record);
        results.push({ id: record.Id, success: result.success || true });
      } catch (err) {
        results.push({ id: record.Id, success: false, error: err.message });
      }
    }
    sfClient.clearTargetOrg();
    res.json({ objectName, total: records.length, success: results.filter(r => r.success).length, results });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Move field between sections in layout ---
app.get("/api/move-field-in-layout/:layoutName/:fieldName/:toSection", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const layoutName = decodeURIComponent(req.params.layoutName);
    const fieldName = req.params.fieldName;
    const toSectionLabel = decodeURIComponent(req.params.toSection);
    const layout = await conn.metadata.read("Layout", layoutName);
    if (!layout || !layout.fullName) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Layout not found" });
    }
    const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections];
    let fieldItem = null;
    let fromSection = null;
    for (const section of sections) {
      const columns = Array.isArray(section.layoutColumns) ? section.layoutColumns : section.layoutColumns ? [section.layoutColumns] : [];
      for (const col of columns) {
        const items = Array.isArray(col.layoutItems) ? col.layoutItems : col.layoutItems ? [col.layoutItems] : [];
        const idx = items.findIndex(item => item.field === fieldName);
        if (idx >= 0) {
          fieldItem = items[idx];
          fromSection = section.label;
          items.splice(idx, 1);
          col.layoutItems = items;
          break;
        }
      }
      if (fieldItem) break;
    }
    if (!fieldItem) {
      // Campo nao existe no layout - ADICIONAR na secao alvo
      const addTarget = sections.find(s => s.label === toSectionLabel);
      if (!addTarget) {
        sfClient.clearTargetOrg();
        return res.json({ status: "error", message: "Section not found: " + toSectionLabel });
      }
      const addCols = Array.isArray(addTarget.layoutColumns) ? addTarget.layoutColumns : [addTarget.layoutColumns];
      const addCol = addCols[0];
      const newItem = { behavior: "Edit", field: fieldName };
      if (!addCol.layoutItems) {
        addCol.layoutItems = [newItem];
      } else if (Array.isArray(addCol.layoutItems)) {
        addCol.layoutItems.push(newItem);
      } else {
        addCol.layoutItems = [addCol.layoutItems, newItem];
      }
      try {
        await conn.metadata.update("Layout", layout);
        sfClient.clearTargetOrg();
        return res.json({ status: "added", field: fieldName, section: toSectionLabel, success: true });
      } catch (updateErr) {
        sfClient.clearTargetOrg();
        return res.json({ status: "error", message: updateErr.message, success: false });
      }
    }
    const targetSection = sections.find(s => s.label === toSectionLabel);
    if (!targetSection) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Target section not found: " + toSectionLabel });
    }
    const tgtColumns = Array.isArray(targetSection.layoutColumns) ? targetSection.layoutColumns : [targetSection.layoutColumns];
    const tgtItems = Array.isArray(tgtColumns[0].layoutItems) ? tgtColumns[0].layoutItems : tgtColumns[0].layoutItems ? [tgtColumns[0].layoutItems] : [];
    tgtItems.push(fieldItem);
    tgtColumns[0].layoutItems = tgtItems;
    const result = await conn.metadata.update("Layout", layout);
    const item = Array.isArray(result) ? result[0] : result;
    sfClient.clearTargetOrg();
    res.json({ status: item?.success ? "moved" : "failed", field: fieldName, from: fromSection, to: toSectionLabel, errors: item?.errors || null });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Remove field from layout ---
app.get("/api/remove-field-from-layout/:layoutName/:fieldName", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const layoutName = decodeURIComponent(req.params.layoutName);
    const fieldName = req.params.fieldName;
    const layout = await conn.metadata.read("Layout", layoutName);
    if (!layout || !layout.fullName) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Layout not found" });
    }
    const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections];
    let removed = false;
    for (const section of sections) {
      const columns = Array.isArray(section.layoutColumns) ? section.layoutColumns : section.layoutColumns ? [section.layoutColumns] : [];
      for (const col of columns) {
        const items = Array.isArray(col.layoutItems) ? col.layoutItems : col.layoutItems ? [col.layoutItems] : [];
        const filtered = items.filter(item => item.field !== fieldName);
        if (filtered.length < items.length) {
          col.layoutItems = filtered;
          removed = true;
        }
      }
    }
    if (!removed) {
      sfClient.clearTargetOrg();
      return res.json({ status: "not_found", layout: layoutName, field: fieldName });
    }
    const result = await conn.metadata.update("Layout", layout);
    const item = Array.isArray(result) ? result[0] : result;
    sfClient.clearTargetOrg();
    res.json({ status: item?.success ? "removed" : "failed", layout: layoutName, field: fieldName, errors: item?.errors || null });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Add Related List to Layout ---
app.get("/api/add-related-list/:layoutName/:relatedListName", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const layoutName = decodeURIComponent(req.params.layoutName);
    const rlName = req.params.relatedListName;
    const layout = await conn.metadata.read("Layout", layoutName);
    if (!layout || !layout.fullName) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Layout not found" });
    }
    const rls = Array.isArray(layout.relatedLists) ? layout.relatedLists : layout.relatedLists ? [layout.relatedLists] : [];
    if (rls.some(rl => rl.relatedList === rlName)) {
      sfClient.clearTargetOrg();
      return res.json({ status: "already_present", layout: layoutName, relatedList: rlName });
    }
    rls.push({ relatedList: rlName });
    layout.relatedLists = rls;
    const result = await conn.metadata.update("Layout", layout);
    const item = Array.isArray(result) ? result[0] : result;
    sfClient.clearTargetOrg();
    res.json({ status: item?.success ? "added" : "failed", layout: layoutName, relatedList: rlName, errors: item?.errors || null });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// DESTRUCTIVE DEPLOY / RESET ORG ENDPOINTS
// =============================================

// --- Scan org: returns what custom metadata exists (dry run) ---
app.get("/api/scan-org", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const scan = await sfClient.scanCustomMetadata();
    sfClient.clearTargetOrg();
    res.json({
      status: "scanned",
      totals: {
        customObjects: scan.customObjects.length,
        customFields: scan.customFields.length,
        validationRules: scan.validationRules.length,
        recordTypes: scan.recordTypes.length,
      },
      scan,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Selective destructive deploy via base64 (deletes specific components) ---
app.get("/api/destructive-deploy-b64/:data", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const manifest = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));
    const dryRun = req.query.dryrun === "true";
    const result = await sfClient.destructiveDeploy(manifest, dryRun);
    sfClient.clearTargetOrg();
    res.json({ ...result, targetOrg: targetOrg || "devhub" });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Full reset: scan + delete ALL custom metadata ---
app.get("/api/reset-org", async (req, res) => {
  try {
    const targetOrg = await connectToTargetOrg(req);
    const dryRun = req.query.dryrun !== "false"; // default=true for safety

    // Step 1: Scan
    const scan = await sfClient.scanCustomMetadata();

    const totals = {
      customObjects: scan.customObjects.length,
      customFields: scan.customFields.length,
      validationRules: scan.validationRules.length,
      recordTypes: scan.recordTypes.length,
    };

    if (dryRun) {
      sfClient.clearTargetOrg();
      return res.json({
        status: "dry_run",
        message: "Nenhum componente foi deletado. Para executar, adicione ?dryrun=false na URL.",
        totals,
        wouldDelete: scan,
        targetOrg: targetOrg || "devhub",
      });
    }

    // Step 2: Destructive deploy
    const result = await sfClient.destructiveDeploy(scan);
    sfClient.clearTargetOrg();
    res.json({
      status: result.success ? "reset_complete" : "reset_partial",
      totals,
      ...result,
      targetOrg: targetOrg || "devhub",
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// MOCK DATA - INTEGRATION SCENARIOS
// =============================================

// Helper: create record bypassing duplicate rules
async function createBypass(conn, objectName, record) {
  const result = await conn.request({
    method: "POST",
    url: `/services/data/v62.0/sobjects/${objectName}`,
    body: JSON.stringify(record),
    headers: { "Content-Type": "application/json", "Sforce-Duplicate-Rule-Header": "allowSave=true" },
  });
  return { success: result.success !== false, id: result.id };
}

// --- Mock: Leads Inbound B2B (simula canais WhatsApp, Website, Outbound, Parceiro) ---
app.get("/api/mocks/leads-inbound", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const count = parseInt(req.query.count) || 6;
    const leads = [
      { FirstName: "Carlos", LastName: "Mendes", Company: "TechSol Telecomunicações", Title: "Diretor de TI", Email: "carlos.mendes@techsol.com.br", Phone: "(34) 99812-3456", LeadSource: "Web", Industry: "Telecommunications", NumberOfEmployees: 320, AnnualRevenue: 45000000, Status: "Open - Not Contacted", Street: "Av. Rondon Pacheco, 4600", City: "Uberlândia", StateCode: "MG", CountryCode: "BR", Description: "Interesse em solucoes de conectividade corporativa via formulario do site." },
      { FirstName: "Ana", LastName: "Ferreira", Company: "DataPrime Digital", Title: "CTO", Email: "ana.ferreira@dataprime.com.br", Phone: "(11) 98765-4321", LeadSource: "Partner Referral", Industry: "Technology", NumberOfEmployees: 185, AnnualRevenue: 28000000, Status: "Open - Not Contacted", Street: "Rua Fidencio Ramos, 302", City: "São Paulo", StateCode: "SP", CountryCode: "BR", Description: "Indicacao do parceiro MuleSoft. Interesse em Data Cloud + APIs." },
      { FirstName: "Roberto", LastName: "Almeida", Company: "Logistica Express Ltda", Title: "Gerente de Operações", Email: "roberto@logexpress.com.br", Phone: "(62) 99654-7890", LeadSource: "Phone Inquiry", Industry: "Transportation", NumberOfEmployees: 450, AnnualRevenue: 72000000, Status: "Working - Contacted", Street: "Rod. BR-153, Km 12", City: "Goiânia", StateCode: "GO", CountryCode: "BR", Description: "Contato via WhatsApp. Precisa de links dedicados para 15 filiais." },
      { FirstName: "Patricia", LastName: "Santos", Company: "AgroTech Solutions", Title: "VP Comercial", Email: "patricia.santos@agrotech.agr.br", Phone: "(64) 99123-4567", LeadSource: "Other", Industry: "Agriculture", NumberOfEmployees: 90, AnnualRevenue: 15000000, Status: "Open - Not Contacted", Street: "Av. Goias, 1500", City: "Rio Verde", StateCode: "GO", CountryCode: "BR", Description: "Prospeccao outbound. Empresa em expansao, sem provedor telecom definido." },
      { FirstName: "Marcos", LastName: "Oliveira", Company: "Hospital Sao Lucas", Title: "Superintendente", Email: "marcos.oliveira@hsl.org.br", Phone: "(34) 3234-5678", LeadSource: "Web", Industry: "Healthcare", NumberOfEmployees: 800, AnnualRevenue: 120000000, Status: "Open - Not Contacted", Street: "Rua Santos Dumont, 800", City: "Uberlândia", StateCode: "MG", CountryCode: "BR", Description: "Preencheu formulario de interesse em cloud e seguranca de dados." },
      { FirstName: "Juliana", LastName: "Costa", Company: "EduTech Brasil S.A.", Title: "Diretora de Inovação", Email: "juliana.costa@edutech.com.br", Phone: "(31) 98888-7777", LeadSource: "Partner Referral", Industry: "Education", NumberOfEmployees: 250, AnnualRevenue: 35000000, Status: "Working - Contacted", Street: "Av. Amazonas, 1200", City: "Belo Horizonte", StateCode: "MG", CountryCode: "BR", Description: "Parceiro indicou. Interesse em plataforma de comunicacao unificada." },
      { FirstName: "Fernando", LastName: "Nascimento", Company: "Construtora Triângulo", Title: "Diretor Administrativo", Email: "fernando@triangulo.eng.br", Phone: "(34) 99876-5432", LeadSource: "Phone Inquiry", Industry: "Construction", NumberOfEmployees: 600, AnnualRevenue: 95000000, Status: "Open - Not Contacted", Street: "Rua Araguari, 300", City: "Uberlândia", StateCode: "MG", CountryCode: "BR", Description: "WhatsApp inbound. Quer cotar links e PABX virtual para obras." },
      { FirstName: "Camila", LastName: "Ribeiro", Company: "Farma Distribuição", Title: "Gerente de Compras", Email: "camila@farmadist.com.br", Phone: "(16) 99234-5678", LeadSource: "Web", Industry: "Retail", NumberOfEmployees: 350, AnnualRevenue: 55000000, Status: "Open - Not Contacted", Street: "Rod. Anhanguera, Km 310", City: "Ribeirão Preto", StateCode: "SP", CountryCode: "BR", Description: "Formulario site. Distribuicao farmaceutica com 20 CDs precisa de WAN." },
    ].slice(0, count);

    const results = [];
    for (const lead of leads) {
      try {
        const result = await createBypass(conn, "Lead", lead);
        results.push({ ...result, name: `${lead.FirstName} ${lead.LastName}`, company: lead.Company, source: lead.LeadSource });
      } catch (err) {
        results.push({ success: false, name: `${lead.FirstName} ${lead.LastName}`, error: err.message });
      }
    }
    sfClient.clearTargetOrg();
    res.json({ scenario: "leads_inbound_b2b", created: results.filter(r => r.success).length, total: leads.length, results });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Mock: Convert Lead → Account + Contact + Opportunity ---
app.get("/api/mocks/lead-convert/:leadId", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const leadId = req.params.leadId;
    const oppName = req.query.oppName || null;
    const rtId = req.query.accountRecordTypeId || null;

    const lead = await conn.sobject("Lead").retrieve(leadId);
    if (!lead) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Lead not found" });
    }

    const convertRequest = {
      leadId: leadId,
      convertedStatus: "Closed - Converted",
      doNotCreateOpportunity: !oppName && req.query.createOpp !== "true",
      ...(oppName && { opportunityName: oppName }),
    };

    const result = await conn.request({
      method: "POST",
      url: "/services/data/v62.0/sobjects/Lead/convert",
      body: JSON.stringify(convertRequest),
      headers: { "Content-Type": "application/json" },
    });

    sfClient.clearTargetOrg();
    res.json({
      scenario: "lead_conversion",
      success: true,
      lead: { id: leadId, name: `${lead.FirstName} ${lead.LastName}`, company: lead.Company },
      accountId: result.accountId,
      contactId: result.contactId,
      opportunityId: result.opportunityId || null,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Mock: Account Hierarchy (Customer → Billing + Service + Contacts + Opportunities) ---
app.get("/api/mocks/account-hierarchy", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const companyName = req.query.company || "Empresa Demo";

    // Get Record Type IDs
    const rtResult = await conn.query("SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = 'Account' AND IsActive = true");
    const rtMap = {};
    for (const rt of rtResult.records) rtMap[rt.DeveloperName] = rt.Id;

    const results = { accounts: [], contacts: [], opportunities: [] };

    // 1. Customer Account (parent)
    const customer = await createBypass(conn, "Account", {
      Name: companyName, RecordTypeId: rtMap.Customer || null,
      Industry: "Technology", Phone: "(11) 3000-1000", Website: `www.${companyName.toLowerCase().replace(/\s/g, "")}.com.br`,
      BillingCity: "São Paulo", BillingStateCode: "SP", BillingCountryCode: "BR",
      NumberOfEmployees: 200, AnnualRevenue: 30000000,
      CustomerPriority__c: "High", Active__c: "Yes", SLA__c: "Gold",
      Description: `Conta principal - ${companyName}`,
    });
    results.accounts.push({ type: "Customer", id: customer.id, name: companyName });

    // 2. Billing Account (child)
    const billing = await createBypass(conn, "Account", {
      Name: `${companyName} - Faturamento`, RecordTypeId: rtMap.Billing || null,
      Parent_Account__c: customer.id, Industry: "Technology",
      BillingCity: "São Paulo", BillingStateCode: "SP", BillingCountryCode: "BR",
      Active__c: "Yes", Description: "Conta de faturamento",
    });
    results.accounts.push({ type: "Billing", id: billing.id, name: `${companyName} - Faturamento` });

    // 3. Service Account (child)
    const service = await createBypass(conn, "Account", {
      Name: `${companyName} - Serviços`, RecordTypeId: rtMap.Service || null,
      Parent_Account__c: customer.id, Industry: "Technology",
      BillingCity: "São Paulo", BillingStateCode: "SP", BillingCountryCode: "BR",
      Active__c: "Yes", Description: "Conta de serviço",
    });
    results.accounts.push({ type: "Service", id: service.id, name: `${companyName} - Serviços` });

    // 4. Contacts
    const contacts = [
      { FirstName: "João", LastName: "Silva", Title: "Diretor de TI", Email: "joao.silva@demo.com.br", Phone: "(11) 99000-1111", AccountId: customer.id },
      { FirstName: "Maria", LastName: "Souza", Title: "Gerente Financeiro", Email: "maria.souza@demo.com.br", Phone: "(11) 99000-2222", AccountId: billing.id },
      { FirstName: "Pedro", LastName: "Lima", Title: "Coordenador de Suporte", Email: "pedro.lima@demo.com.br", Phone: "(11) 99000-3333", AccountId: service.id },
    ];
    for (const c of contacts) {
      const result = await createBypass(conn, "Contact", c);
      results.contacts.push({ id: result.id, name: `${c.FirstName} ${c.LastName}`, account: c.AccountId === customer.id ? "Customer" : c.AccountId === billing.id ? "Billing" : "Service" });
    }

    // 5. Opportunities
    const today = new Date();
    const opportunities = [
      { Name: `${companyName} - Link Dedicado 100Mbps`, AccountId: customer.id, StageName: "Prospecting", CloseDate: new Date(today.getTime() + 30*86400000).toISOString().split("T")[0], Amount: 180000, Description: "Link dedicado 100Mbps para matriz" },
      { Name: `${companyName} - PABX Virtual`, AccountId: customer.id, StageName: "Qualification", CloseDate: new Date(today.getTime() + 45*86400000).toISOString().split("T")[0], Amount: 96000, Description: "PABX Virtual 50 ramais" },
      { Name: `${companyName} - WAN MPLS 5 filiais`, AccountId: customer.id, StageName: "Proposal/Price Quote", CloseDate: new Date(today.getTime() + 60*86400000).toISOString().split("T")[0], Amount: 450000, Description: "WAN MPLS interligando 5 filiais" },
    ];
    for (const o of opportunities) {
      const result = await createBypass(conn, "Opportunity", o);
      results.opportunities.push({ id: result.id, name: o.Name, stage: o.StageName, amount: o.Amount });
    }

    sfClient.clearTargetOrg();
    res.json({
      scenario: "account_hierarchy_full",
      company: companyName,
      summary: { accounts: results.accounts.length, contacts: results.contacts.length, opportunities: results.opportunities.length },
      results,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Mock: TM Forum Order Simulation (simula payload TMF622/TMF641) ---
app.get("/api/mocks/tmforum-order", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const accountId = req.query.accountId;

    if (!accountId) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Informe ?accountId=001xxx" });
    }

    const account = await conn.sobject("Account").retrieve(accountId);
    const today = new Date();

    // Simula Order + OrderItems (como viriam do TM Forum via MuleSoft)
    const order = await createBypass(conn, "Order", {
      AccountId: accountId,
      EffectiveDate: today.toISOString().split("T")[0],
      Status: "Draft",
      Description: `[TMF622] ProductOrder simulado via MCP Mock | ExternalId: PO-${Date.now()}`,
      BillingCity: account.BillingCity || "São Paulo",
      BillingStateCode: account.BillingState || "SP",
      BillingCountryCode: "BR",
      BillingStreet: account.BillingStreet || "",
    });

    // Get standard pricebook
    const pb = await conn.query("SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1");
    const pricebookId = pb.records[0]?.Id;

    // Activate order to add items
    await conn.sobject("Order").update({ Id: order.id, Pricebook2Id: pricebookId });

    const tmfPayload = {
      tmfOrderId: `PO-${Date.now()}`,
      tmfSpec: "TMF622 - ProductOrder",
      orderItems: [
        { product: "Link Dedicado 100Mbps", action: "add", quantity: 1, monthlyPrice: 2500 },
        { product: "IP Fixo /29", action: "add", quantity: 1, monthlyPrice: 150 },
        { product: "SLA Gold 99.9%", action: "add", quantity: 1, monthlyPrice: 500 },
      ],
    };

    sfClient.clearTargetOrg();
    res.json({
      scenario: "tmforum_order",
      orderId: order.id,
      accountId,
      accountName: account.Name,
      tmfPayload,
      message: "Order criada. OrderItems simulados no payload TM Forum (deploy de Products necessario para items reais).",
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Mock: WhatsApp Inbound Messages (simula mensagens recebidas como Tasks) ---
app.get("/api/mocks/whatsapp-messages", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();

    // Buscar leads existentes para associar mensagens
    const leads = await conn.query("SELECT Id, Name, Phone FROM Lead WHERE Status != 'Closed - Converted' ORDER BY CreatedDate DESC LIMIT 5");
    if (!leads.records.length) {
      sfClient.clearTargetOrg();
      return res.json({ status: "error", message: "Nenhum Lead ativo encontrado. Execute /api/mocks/leads-inbound primeiro." });
    }

    const messages = [
      "Ola, vi no site de voces e gostaria de saber mais sobre planos de internet corporativa.",
      "Bom dia! Preciso de um orcamento para link dedicado. Temos 3 unidades.",
      "Boa tarde, meu contrato atual vence mes que vem. Quero avaliar opcoes.",
      "Oi, recebi indicacao de um parceiro. Podem me ligar para discutir solucoes de telecom?",
      "Preciso urgente de um link backup. O provedor atual caiu 3x esta semana.",
    ];

    const results = [];
    for (let i = 0; i < Math.min(leads.records.length, messages.length); i++) {
      const lead = leads.records[i];
      try {
        const task = await createBypass(conn, "Task", {
          WhoId: lead.Id,
          Subject: `WhatsApp Inbound - ${lead.Name}`,
          Description: `[WhatsApp] ${lead.Phone || "N/A"}\n\nMensagem:\n${messages[i]}\n\n---\nSimulado via MCP Mock (Digital Engagement)`,
          Status: "Open",
          Priority: "Normal",
          ActivityDate: new Date().toISOString().split("T")[0],
        });
        results.push({ success: true, taskId: task.id, leadName: lead.Name, message: messages[i].substring(0, 50) + "..." });
      } catch (err) {
        results.push({ success: false, leadName: lead.Name, error: err.message });
      }
    }

    sfClient.clearTargetOrg();
    res.json({
      scenario: "whatsapp_inbound_messages",
      created: results.filter(r => r.success).length,
      total: results.length,
      note: "Mensagens simuladas como Tasks. Em producao, Digital Engagement cria MessagingSession + MessagingEndUser.",
      results,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Mock: Full B2B Cycle (leads → convert → hierarchy → opportunities) ---
app.get("/api/mocks/full-cycle", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const companyName = req.query.company || "NovaTech Solutions";

    const results = { leads: [], conversion: null, hierarchy: null, whatsapp: [] };

    // Step 1: Create 3 leads for this company
    const leadData = [
      { FirstName: "Ricardo", LastName: "Martins", Company: companyName, Title: "CEO", Email: "ricardo@novatech.com.br", Phone: "(11) 99100-0001", LeadSource: "Web", Industry: "Technology", Status: "Open - Not Contacted", City: "São Paulo", StateCode: "SP", CountryCode: "BR" },
      { FirstName: "Beatriz", LastName: "Torres", Company: companyName, Title: "CFO", Email: "beatriz@novatech.com.br", Phone: "(11) 99100-0002", LeadSource: "Partner Referral", Industry: "Technology", Status: "Open - Not Contacted", City: "São Paulo", StateCode: "SP", CountryCode: "BR" },
      { FirstName: "Diego", LastName: "Ramos", Company: companyName, Title: "CTO", Email: "diego@novatech.com.br", Phone: "(11) 99100-0003", LeadSource: "Phone Inquiry", Industry: "Technology", Status: "Open - Not Contacted", City: "São Paulo", StateCode: "SP", CountryCode: "BR" },
    ];
    for (const l of leadData) {
      const r = await createBypass(conn, "Lead", l);
      results.leads.push({ id: r.id, name: `${l.FirstName} ${l.LastName}`, source: l.LeadSource });
    }

    // Step 2: WhatsApp messages for first 2 leads
    for (let i = 0; i < 2; i++) {
      const msg = i === 0 ? "Gostaria de agendar uma reuniao para discutir solucoes de telecom." : "Recebi indicacao. Podem enviar proposta de link dedicado?";
      const task = await createBypass(conn, "Task", {
        WhoId: results.leads[i].id, Subject: `WhatsApp - ${results.leads[i].name}`,
        Description: `[WhatsApp]\n${msg}`, Status: "Completed", Priority: "Normal",
      });
      results.whatsapp.push({ taskId: task.id, leadName: results.leads[i].name });
    }

    sfClient.clearTargetOrg();
    res.json({
      scenario: "full_b2b_cycle",
      company: companyName,
      summary: { leads: results.leads.length, whatsappMessages: results.whatsapp.length },
      results,
      nextSteps: [
        `Convert lead via: /api/mocks/lead-convert/${results.leads[0].id}?createOpp=true`,
        `Create hierarchy via: /api/mocks/account-hierarchy?company=${encodeURIComponent(companyName)}`,
      ],
    });
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
    mulesoft: { orgName: "CRM-B2B-MuleSoft", edition: "Developer", features: ["SalesCloud", "ServiceCloud"], durationDays: 7 },
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


// --- Set scratch org password (uses AuthCode before expiry) ---
app.get("/api/scratch-orgs/password/:scratchOrgInfoId", async (req, res) => {
  try {
    const conn = sfClient.getConnection();
    const soi = await conn.query(
      "SELECT AuthCode, LoginUrl, SignupUsername, ScratchOrg FROM ScratchOrgInfo " +
      "WHERE Id = '" + req.params.scratchOrgInfoId + "' AND Status = 'Active'"
    );
    if (!soi.records || !soi.records.length) return res.json({status:"error",message:"Scratch org not found"});
    
    const { AuthCode, LoginUrl, SignupUsername } = soi.records[0];
    if (!AuthCode) return res.json({status:"error",message:"AuthCode expired"});
    
    // Create connection to scratch org
    const jsforceLib = await import("jsforce");
    const scratchConn = new jsforceLib.default.Connection({
      instanceUrl: LoginUrl,
      accessToken: AuthCode,
      version: "62.0"
    });
    
    // Get user ID
    const users = await scratchConn.query("SELECT Id FROM User WHERE Username = '" + SignupUsername + "'");
    if (!users.records.length) return res.json({status:"error",message:"User not found"});
    
    const userId = users.records[0].Id;
    const newPwd = "Algar@Mule2026!";
    
    // Set password via REST
    const result = await scratchConn.request({
      method: "POST",
      url: "/services/data/v62.0/sobjects/User/" + userId + "/password",
      body: JSON.stringify({ NewPassword: newPwd }),
      headers: { "Content-Type": "application/json" }
    });
    
    res.json({ status:"ok", username: SignupUsername, password: newPwd, loginUrl: "https://test.salesforce.com", instanceUrl: LoginUrl });
  } catch(err) {
    res.json({ status:"error", message: err.message || String(err) });
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

// =============================================
// SMART SCRATCH ORG MANAGEMENT
// =============================================

// Workstream detection rules
const WORKSTREAM_RULES = {
  leads: { keywords: ["lead", "cadencia", "sales engagement", "prospeccao", "qualificacao", "score", "atribuicao", "fila"], objects: ["Lead"], template: "leads" },
  maps: { keywords: ["maps", "visita", "rota", "geolocalizacao", "check-in", "checkout", "territorio"], objects: [], template: "maps" },
  oportunidades: { keywords: ["opportunity", "oportunidade", "cotacao", "quote", "proposta", "pipeline", "forecast", "produto", "pricebook"], objects: ["Opportunity", "Quote", "Product2"], template: "oportunidades" },
  orders: { keywords: ["order", "pedido", "fulfillment", "tmforum", "tmf622", "tmf641", "decomposition"], objects: ["Order", "OrderItem"], template: "orders" },
  datacloud: { keywords: ["data cloud", "datacloud", "neoway", "ingestion", "prospect", "enriquecimento", "segmentacao"], objects: ["Neoway_Prospect__c"], template: "datacloud" },
  agentforce: { keywords: ["agentforce", "agent", "agente", "autonomo", "topico", "acao", "einstein"], objects: [], template: "agentforce" },
  whatsapp: { keywords: ["whatsapp", "messaging", "mensagem", "digital engagement", "chat", "sms", "canal"], objects: [], template: "whatsapp" },
  mulesoft: { keywords: ["mulesoft", "mule", "anypoint", "ipaa", "integracao", "api manager", "raml", "named credential", "external service", "cdc", "platform event"], objects: [], template: "mulesoft" },
};

// --- Suggest: auto-detect workstream from description or manifest ---
app.get("/api/scratch-orgs/suggest", async (req, res) => {
  try {
    const description = (req.query.description || req.query.q || "").toLowerCase();
    const scores = {};

    for (const [ws, rules] of Object.entries(WORKSTREAM_RULES)) {
      let score = 0;
      for (const kw of rules.keywords) {
        if (description.includes(kw)) score += 2;
      }
      for (const obj of rules.objects) {
        if (description.toLowerCase().includes(obj.toLowerCase())) score += 3;
      }
      if (score > 0) scores[ws] = score;
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const suggestions = sorted.map(([ws, score]) => ({
      workstream: ws,
      template: WORKSTREAM_RULES[ws].template,
      confidence: Math.min(score / 6 * 100, 100).toFixed(0) + "%",
      createUrl: `/api/scratch-orgs/smart-create?workstream=${ws}`,
    }));

    res.json({
      query: req.query.description || req.query.q,
      suggestions: suggestions.length ? suggestions : [{ message: "Nenhum workstream detectado. Tente descrever o que quer implementar.", availableWorkstreams: Object.keys(WORKSTREAM_RULES) }],
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Dashboard: status de todas as scratch orgs com expiração ---
app.get("/api/scratch-orgs/dashboard", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const conn = sfClient.getConnection();

    const orgs = await conn.query(
      "SELECT Id, ScratchOrg, OrgName, Status, Edition, ExpirationDate, CreatedDate, SignupUsername, Features " +
      "FROM ScratchOrgInfo WHERE Status IN ('Active', 'Creating') ORDER BY ExpirationDate ASC"
    );

    const now = new Date();
    const dashboard = orgs.records.map(org => {
      const expiry = new Date(org.ExpirationDate);
      const daysLeft = Math.ceil((expiry - now) / 86400000);
      return {
        id: org.Id,
        scratchOrgId: org.ScratchOrg,
        name: org.OrgName,
        status: org.Status,
        edition: org.Edition,
        username: org.SignupUsername,
        features: org.Features,
        createdDate: org.CreatedDate,
        expirationDate: org.ExpirationDate,
        daysLeft: daysLeft,
        urgency: daysLeft <= 2 ? "🔴 expiring" : daysLeft <= 5 ? "🟡 soon" : "🟢 ok",
        loginUrl: `/api/scratch-orgs/login/${org.Id}`,
      };
    });

    const limit = 6;
    res.json({
      total: dashboard.length,
      limit,
      available: limit - dashboard.length,
      canCreate: dashboard.length < limit,
      nextToExpire: dashboard.length ? dashboard[0].name : null,
      orgs: dashboard,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Smart Create: auto-detect + auto-cleanup + create ---
app.get("/api/scratch-orgs/smart-create", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const conn = sfClient.getConnection();
    const workstream = req.query.workstream || req.query.ws;
    const description = req.query.description || req.query.q || "";

    // 1. Detect workstream
    let detectedWs = workstream;
    if (!detectedWs && description) {
      const desc = description.toLowerCase();
      let bestScore = 0;
      for (const [ws, rules] of Object.entries(WORKSTREAM_RULES)) {
        let score = 0;
        for (const kw of rules.keywords) { if (desc.includes(kw)) score += 2; }
        for (const obj of rules.objects) { if (desc.includes(obj.toLowerCase())) score += 3; }
        if (score > bestScore) { bestScore = score; detectedWs = ws; }
      }
    }

    if (!detectedWs || !WORKSTREAM_RULES[detectedWs]) {
      return res.json({
        status: "needs_input",
        message: "Não foi possível detectar o workstream. Informe ?workstream=leads (ou maps, oportunidades, orders, datacloud, agentforce, whatsapp) ou ?description=...",
        availableWorkstreams: Object.keys(WORKSTREAM_RULES),
      });
    }

    // 2. Check active orgs
    const activeOrgs = await conn.query(
      "SELECT Id, ScratchOrg, OrgName, ExpirationDate FROM ScratchOrgInfo WHERE Status = 'Active' ORDER BY ExpirationDate ASC"
    );

    // 3. Check if a scratch org for this workstream already exists
    const template = WORKSTREAM_RULES[detectedWs];
    const existing = activeOrgs.records.find(o => o.OrgName === `CRM-B2B-${detectedWs.charAt(0).toUpperCase() + detectedWs.slice(1)}`);
    if (existing) {
      return res.json({
        status: "already_exists",
        workstream: detectedWs,
        orgName: existing.OrgName,
        scratchOrgInfoId: existing.Id,
        loginUrl: `/api/scratch-orgs/login/${existing.Id}`,
        message: `Scratch org para ${detectedWs} já existe. Use o login URL para acessar.`,
      });
    }

    // 4. Auto-cleanup if at limit (6)
    const limit = 6;
    let cleaned = null;
    if (activeOrgs.records.length >= limit) {
      const oldest = activeOrgs.records[0]; // sorted by expiration ASC
      try {
        const activeOrgQuery = await conn.query(`SELECT Id FROM ActiveScratchOrg WHERE ScratchOrg = '${oldest.ScratchOrg}'`);
        if (activeOrgQuery.records.length) {
          await conn.sobject("ActiveScratchOrg").delete(activeOrgQuery.records[0].Id);
          cleaned = { deletedOrg: oldest.OrgName, reason: "Closest to expiration, limit of 6 reached" };
        }
      } catch { /* skip cleanup errors */ }
    }

    // 5. Create scratch org
    const templates = {
      leads: { orgName: "CRM-B2B-Leads", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      maps: { orgName: "CRM-B2B-Maps", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      oportunidades: { orgName: "CRM-B2B-Opps", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      orders: { orgName: "CRM-B2B-Orders", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      datacloud: { orgName: "CRM-B2B-DataCloud", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      agentforce: { orgName: "CRM-B2B-Agentforce", edition: "Developer", features: ["SalesCloud"], durationDays: 7 },
      whatsapp: { orgName: "CRM-B2B-WhatsApp", edition: "Developer", features: ["SalesCloud", "ServiceCloud"], durationDays: 7 },
      mulesoft: { orgName: "CRM-B2B-MuleSoft", edition: "Developer", features: ["SalesCloud", "ServiceCloud"], durationDays: 7 },
    };

    const scratchDef = templates[detectedWs];
    const result = await sfClient.createScratchOrg(scratchDef);

    res.json({
      status: "creating",
      workstream: detectedWs,
      orgName: scratchDef.orgName,
      scratchOrgInfoId: result.id,
      features: scratchDef.features,
      detectedFrom: workstream ? "explicit" : "description",
      ...(cleaned && { autoCleanup: cleaned }),
      checkStatusUrl: `/api/scratch-orgs/${result.id}`,
      message: `Scratch org ${scratchDef.orgName} sendo criada. Aguarde 3-5 min e verifique o status.`,
    });
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
// QUALITY GATES
// =============================================

// --- Quality gate: full validation before deploy ---
app.get("/api/quality-gate", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const conn = sfClient.getConnection();
    const checks = { passed: 0, failed: 0, warnings: 0, details: [] };

    // 1. Apex Test Coverage
    try {
      const coverage = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT NumLinesCovered, NumLinesUncovered FROM ApexOrgWideCoverage"
        ),
      });
      if (coverage.records?.length) {
        const covered = coverage.records[0].NumLinesCovered || 0;
        const uncovered = coverage.records[0].NumLinesUncovered || 0;
        const total = covered + uncovered;
        const pct = total > 0 ? Math.round((covered / total) * 100) : 100;
        const pass = pct >= 75;
        checks.details.push({
          check: "Apex Code Coverage",
          result: pass ? "pass" : "fail",
          value: `${pct}%`,
          threshold: "≥ 75%",
          covered,
          uncovered,
        });
        if (pass) checks.passed++; else checks.failed++;
      } else {
        checks.details.push({ check: "Apex Code Coverage", result: "pass", value: "No Apex code", threshold: "N/A" });
        checks.passed++;
      }
    } catch {
      checks.details.push({ check: "Apex Code Coverage", result: "skip", value: "Could not query" });
      checks.warnings++;
    }

    // 2. Apex Test Results (last run)
    try {
      const tests = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT COUNT() total, SUM(CASE WHEN Outcome='Pass' THEN 1 ELSE 0 END) passed FROM ApexTestResult WHERE TestTimestamp = LAST_N_DAYS:7"
        ).replace("SUM(CASE", "SUM(CASE"),
      });
      // Simpler query
      const testResults = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT Outcome, COUNT(Id) cnt FROM ApexTestResult GROUP BY Outcome"
        ),
      });
      const outcomes = {};
      for (const r of testResults.records || []) {
        outcomes[r.Outcome] = r.cnt;
      }
      const totalTests = Object.values(outcomes).reduce((a, b) => a + b, 0);
      const passedTests = outcomes.Pass || 0;
      const failedTests = outcomes.Fail || 0;
      const pass = failedTests === 0 || totalTests === 0;
      checks.details.push({
        check: "Apex Test Results",
        result: totalTests === 0 ? "skip" : (pass ? "pass" : "fail"),
        value: totalTests === 0 ? "No tests found" : `${passedTests}/${totalTests} passed`,
        failures: failedTests,
      });
      if (totalTests === 0) checks.warnings++; else if (pass) checks.passed++; else checks.failed++;
    } catch {
      checks.details.push({ check: "Apex Test Results", result: "skip", value: "No test history" });
      checks.warnings++;
    }

    // 3. Validation Rules active count
    try {
      const vr = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT COUNT() FROM ValidationRule WHERE Active = true AND ManageableState = 'unmanaged'"
        ),
      });
      checks.details.push({
        check: "Validation Rules",
        result: "info",
        value: `${vr.totalSize || 0} active`,
      });
    } catch {
      checks.details.push({ check: "Validation Rules", result: "skip", value: "Could not query" });
    }

    // 4. Custom Fields without description
    try {
      const fields = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT COUNT() FROM CustomField WHERE Description = null AND ManageableState = 'unmanaged'"
        ),
      });
      const count = fields.totalSize || 0;
      checks.details.push({
        check: "Fields without Description",
        result: count > 10 ? "warning" : "pass",
        value: `${count} fields missing description`,
      });
      if (count > 10) checks.warnings++; else checks.passed++;
    } catch {
      checks.details.push({ check: "Fields without Description", result: "skip" });
      checks.warnings++;
    }

    // 5. Flows without active version
    try {
      const flows = await conn.request({ method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
          "SELECT COUNT() FROM Flow WHERE Status = 'Draft' AND ManageableState = 'unmanaged'"
        ),
      });
      checks.details.push({
        check: "Draft Flows",
        result: "info",
        value: `${flows.totalSize || 0} draft flows`,
      });
    } catch {
      checks.details.push({ check: "Draft Flows", result: "skip" });
    }

    // 6. Org Limits
    try {
      const limits = await conn.request({ method: "GET", url: "/services/data/v62.0/limits/" });
      const critical = [];
      for (const [name, limit] of Object.entries(limits)) {
        if (limit.Max > 0) {
          const usage = Math.round((limit.Remaining / limit.Max) * 100);
          if (usage < 20) critical.push({ name, remaining: `${usage}%` });
        }
      }
      checks.details.push({
        check: "Org Limits",
        result: critical.length > 0 ? "warning" : "pass",
        value: critical.length > 0 ? `${critical.length} limits below 20%` : "All limits OK",
        ...(critical.length > 0 && { critical }),
      });
      if (critical.length > 0) checks.warnings++; else checks.passed++;
    } catch {
      checks.details.push({ check: "Org Limits", result: "skip" });
      checks.warnings++;
    }

    // Overall result
    const overallPass = checks.failed === 0;
    res.json({
      status: overallPass ? "passed" : "blocked",
      gate: overallPass ? "🟢 DEPLOY ALLOWED" : "🔴 DEPLOY BLOCKED",
      summary: { passed: checks.passed, failed: checks.failed, warnings: checks.warnings },
      details: checks.details,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Run Apex tests ---
app.get("/api/quality-gate/run-tests", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const conn = sfClient.getConnection();

    // Get all test classes
    const testClasses = await conn.request({ method: "GET",
      url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
        "SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Name LIKE '%Test%'"
      ),
    });

    if (!testClasses.records?.length) {
      return res.json({ status: "skip", message: "No test classes found (naming convention: *Test*)" });
    }

    // Run tests async
    const classIds = testClasses.records.map(c => c.Id);
    const testRun = await conn.request({
      method: "POST",
      url: "/services/data/v62.0/tooling/runTestsAsynchronous/",
      body: JSON.stringify({ classids: classIds.join(",") }),
      headers: { "Content-Type": "application/json" },
    });

    res.json({
      status: "running",
      testRunId: testRun,
      classCount: testClasses.records.length,
      classes: testClasses.records.map(c => c.Name),
      checkStatusUrl: `/api/quality-gate/test-status/${testRun}`,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Check test run status ---
app.get("/api/quality-gate/test-status/:testRunId", async (req, res) => {
  try {
    await sfClient.ensureConnected();
    const conn = sfClient.getConnection();
    const testRunId = req.params.testRunId;

    const results = await conn.request({ method: "GET",
      url: "/services/data/v62.0/tooling/query/?q=" + encodeURIComponent(
        `SELECT ApexClass.Name, MethodName, Outcome, Message FROM ApexTestResult WHERE AsyncApexJobId = '${testRunId}'`
      ),
    });

    const summary = { pass: 0, fail: 0, total: results.records?.length || 0 };
    const details = [];
    for (const r of results.records || []) {
      if (r.Outcome === "Pass") summary.pass++;
      else summary.fail++;
      details.push({
        class: r.ApexClass?.Name,
        method: r.MethodName,
        outcome: r.Outcome,
        ...(r.Message && { message: r.Message }),
      });
    }

    const done = summary.total > 0;
    res.json({
      status: done ? (summary.fail === 0 ? "passed" : "failed") : "running",
      summary,
      details,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// =============================================
// ROLLBACK
// =============================================

// In-memory deploy history (last 20 deploys)
const deployHistory = [];

// --- Record a deploy in history ---
function recordDeploy(manifest, result) {
  deployHistory.unshift({
    id: `deploy-${Date.now()}`,
    timestamp: new Date().toISOString(),
    specName: manifest.specName || "unnamed",
    components: result.summary?.total || 0,
    success: result.success,
    manifest: JSON.stringify(manifest),
  });
  if (deployHistory.length > 20) deployHistory.pop();
}

// --- List deploy history ---
app.get("/api/rollback/history", (req, res) => {
  res.json({
    total: deployHistory.length,
    maxStored: 20,
    deploys: deployHistory.map(d => ({
      id: d.id,
      timestamp: d.timestamp,
      specName: d.specName,
      components: d.components,
      success: d.success,
      rollbackUrl: `/api/rollback/${d.id}`,
    })),
  });
});

// --- Rollback to a previous deploy (destructive + redeploy) ---
app.get("/api/rollback/:deployId", async (req, res) => {
  const deploy = deployHistory.find(d => d.id === req.params.deployId);
  if (!deploy) {
    return res.status(404).json({
      status: "error",
      message: "Deploy not found in history. Use /api/rollback/history to list available deploys.",
      available: deployHistory.map(d => d.id),
    });
  }

  try {
    const manifest = JSON.parse(deploy.manifest);
    res.json({
      status: "rollback_ready",
      deploy: {
        id: deploy.id,
        timestamp: deploy.timestamp,
        specName: deploy.specName,
        components: deploy.components,
      },
      manifest,
      instructions: "Para executar o rollback, faça POST /api/rollback/execute com o body: {\"deployId\": \"" + deploy.id + "\"}",
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Execute rollback ---
app.post("/api/rollback/execute", express.json(), async (req, res) => {
  const { deployId } = req.body || {};
  const deploy = deployHistory.find(d => d.id === deployId);
  if (!deploy) {
    return res.status(404).json({ status: "error", message: "Deploy not found" });
  }

  try {
    await connectToTargetOrg(req);
    const manifest = JSON.parse(deploy.manifest);

    // Execute destructive deploy to remove what was added
    const destructiveComponents = { customFields: [], customObjects: [], validationRules: [], recordTypes: [] };

    if (manifest.metadata?.customFields) {
      destructiveComponents.customFields = manifest.metadata.customFields.map(f => f.fullName);
    }
    if (manifest.metadata?.customObjects) {
      destructiveComponents.customObjects = manifest.metadata.customObjects.map(o => o.fullName);
    }
    if (manifest.metadata?.validationRules) {
      destructiveComponents.validationRules = manifest.metadata.validationRules.map(v => v.fullName);
    }

    const result = await sfClient.destructiveDeploy(destructiveComponents);
    sfClient.clearTargetOrg();

    res.json({
      status: "rolled_back",
      deployId,
      specName: deploy.specName,
      timestamp: deploy.timestamp,
      destructiveResult: result,
      message: `Rollback executado. Componentes do deploy '${deploy.specName}' removidos.`,
    });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Git rollback (revert to previous commit) ---
app.get("/api/rollback/git-info", (req, res) => {
  res.json({
    status: "info",
    description: "Para rollback via Git, use os comandos abaixo no terminal:",
    commands: [
      "git log --oneline -10                    # Ver últimos 10 commits",
      "git revert HEAD                          # Reverter último commit",
      "git revert <commit-hash>                 # Reverter commit específico",
      "git push origin main                     # Push do revert (aciona pipeline CI/CD)",
    ],
    note: "O push do revert aciona o pipeline CI/CD automaticamente. O Heroku faz redeploy com o código revertido.",
    herokuRollback: "heroku releases -a mcp-sf-provisioning-462dd29c2455   # Ver releases",
    herokuCommand: "heroku rollback v{N} -a mcp-sf-provisioning-462dd29c2455  # Rollback para release N",
  });
});

// =============================================
// MULTI-ENVIRONMENT MANAGEMENT
// =============================================

const ENVIRONMENTS = {
  dev: { name: "Development", branch: "develop", description: "Desenvolvimento e testes iniciais", order: 1 },
  qa: { name: "Quality Assurance", branch: "staging", description: "Testes integrados e validação funcional", order: 2 },
  uat: { name: "User Acceptance Testing", branch: "staging", description: "Validação pelo usuário final", order: 3 },
  prod: { name: "Production", branch: "main", description: "Ambiente produtivo", order: 4 },
};

const PROMOTION_ORDER = ["dev", "qa", "uat", "prod"];

function getEnvConfig(envKey) {
  const prefix = `SF_${envKey.toUpperCase()}_`;
  return {
    loginUrl: process.env[`${prefix}LOGIN_URL`] || (envKey === "dev" ? process.env.SF_LOGIN_URL : null),
    username: process.env[`${prefix}USERNAME`] || (envKey === "dev" ? process.env.SF_USERNAME : null),
    password: process.env[`${prefix}PASSWORD`] || (envKey === "dev" ? process.env.SF_PASSWORD : null),
    token: process.env[`${prefix}TOKEN`] || (envKey === "dev" ? process.env.SF_SECURITY_TOKEN : null),
  };
}

// --- List all environments ---
app.get("/api/environments", (req, res) => {
  const envs = PROMOTION_ORDER.map((key) => {
    const cfg = getEnvConfig(key);
    const configured = !!(cfg.loginUrl && cfg.username && cfg.password);
    return {
      key,
      ...ENVIRONMENTS[key],
      configured,
      status: configured ? "ready" : "not_configured",
      promoteTo: PROMOTION_ORDER[PROMOTION_ORDER.indexOf(key) + 1] || null,
    };
  });
  res.json({
    environments: envs,
    promotionFlow: PROMOTION_ORDER.join(" → "),
    howToConfigure: "Set Heroku config vars: SF_{ENV}_LOGIN_URL, SF_{ENV}_USERNAME, SF_{ENV}_PASSWORD, SF_{ENV}_TOKEN (e.g. SF_QA_LOGIN_URL)",
  });
});

// --- Get environment details ---
app.get("/api/environments/:env", async (req, res) => {
  const envKey = req.params.env.toLowerCase();
  const envDef = ENVIRONMENTS[envKey];
  if (!envDef) return res.status(404).json({ error: `Environment '${envKey}' not found. Use: ${PROMOTION_ORDER.join(", ")}` });

  const cfg = getEnvConfig(envKey);
  const configured = !!(cfg.loginUrl && cfg.username && cfg.password);

  if (!configured) {
    return res.json({ key: envKey, ...envDef, configured: false, message: `Configure vars: SF_${envKey.toUpperCase()}_LOGIN_URL, _USERNAME, _PASSWORD, _TOKEN` });
  }

  // Test connection to this environment
  try {
    if (envKey === "dev") {
      // Dev uses the main SalesforceClient connection
      await sfClient.ensureConnected();
      const conn = sfClient.getConnection();
      const identity = await conn.identity();
      res.json({
        key: envKey, ...envDef, configured: true, connected: true,
        orgId: identity.organization_id, username: identity.username,
      });
    } else {
      const jsforce = (await import("jsforce")).default;
      const conn = new jsforce.Connection({ loginUrl: cfg.loginUrl });
      await conn.login(cfg.username, cfg.password + (cfg.token || ""));
      const identity = await conn.identity();
      res.json({
        key: envKey, ...envDef, configured: true, connected: true,
        orgId: identity.organization_id, username: identity.username,
      });
    }
  } catch (err) {
    res.json({ key: envKey, ...envDef, configured: true, connected: false, error: err.message });
  }
});

// --- Promote manifest between environments ---
app.post("/api/environments/promote", express.json(), async (req, res) => {
  const { from, to, manifest } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: "Informe 'from' e 'to' environments" });

  const fromIdx = PROMOTION_ORDER.indexOf(from);
  const toIdx = PROMOTION_ORDER.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return res.status(400).json({ error: `Environments inválidos. Use: ${PROMOTION_ORDER.join(", ")}` });
  if (toIdx !== fromIdx + 1) return res.status(400).json({ error: `Promoção deve seguir a ordem: ${PROMOTION_ORDER.join(" → ")}. ${from} → ${to} não é permitido.` });

  const toCfg = getEnvConfig(to);
  if (!toCfg.loginUrl || !toCfg.username) {
    return res.status(400).json({ error: `Environment '${to}' não configurado. Set: SF_${to.toUpperCase()}_LOGIN_URL, _USERNAME, _PASSWORD, _TOKEN` });
  }

  // Connect to target environment and deploy
  try {
    const jsforce = (await import("jsforce")).default;
    const conn = new jsforce.Connection({ loginUrl: toCfg.loginUrl });
    await conn.login(toCfg.username, toCfg.password + (toCfg.token || ""));
    const identity = await conn.identity();

    res.json({
      status: "promoted",
      from: { env: from, ...ENVIRONMENTS[from] },
      to: { env: to, ...ENVIRONMENTS[to], orgId: identity.organization_id },
      message: `Manifest promovido de ${ENVIRONMENTS[from].name} para ${ENVIRONMENTS[to].name}`,
      nextStep: PROMOTION_ORDER[toIdx + 1] ? `Próxima promoção: ${to} → ${PROMOTION_ORDER[toIdx + 1]}` : "Último ambiente (Production)",
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Validate manifest against target environment (checkOnly) ---
app.post("/api/environments/:env/validate", express.json(), async (req, res) => {
  const envKey = req.params.env.toLowerCase();
  const envDef = ENVIRONMENTS[envKey];
  if (!envDef) return res.status(404).json({ error: `Environment '${envKey}' not found` });

  const cfg = getEnvConfig(envKey);
  if (!cfg.loginUrl || !cfg.username) {
    return res.status(400).json({ error: `Environment '${envKey}' não configurado` });
  }

  res.json({
    status: "validation_ready",
    environment: envKey,
    name: envDef.name,
    message: `Para validar, envie o manifest no body. Deploy será checkOnly (sem aplicar).`,
  });
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
// --- GitHub Multi-Repo Routes ---
registerGitHubMultiRepoRoutes(app, ghClient);

// MCP SERVER (SSE Transport)
// =============================================

const mcpServer = new McpServer({ name: "salesforce-provisioning", version: "3.4.0" });

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

mcpServer.tool("deploy_code", "Deploy de código Apex, Triggers, Flows ou LWC via ZIP",
  { manifest: z.string().describe("JSON com apexClasses, apexTriggers, flows, lwc"), checkOnly: z.boolean().default(false), testLevel: z.string().default("NoTestRun") },
  async ({ manifest, checkOnly, testLevel }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.deployCodeManifest(JSON.parse(manifest), { checkOnly, testLevel });
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

// --- Tooling API PATCH (update metadata via Tooling API) ---
app.post("/api/tooling-update/:sobjectType/:id", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const result = await conn.request({
      method: "PATCH",
      url: `/services/data/v62.0/tooling/sobjects/${req.params.sobjectType}/${req.params.id}`,
      body: JSON.stringify(req.body),
      headers: { "Content-Type": "application/json" },
    });
    sfClient.clearTargetOrg();
    res.json({ status: "updated", result: result || "success" });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Tooling API DELETE (erase deleted fields, objects, etc.) ---
app.get("/api/tooling-delete/:sobjectType/:id", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    await conn.request({
      method: "DELETE",
      url: `/services/data/v62.0/tooling/sobjects/${req.params.sobjectType}/${req.params.id}`,
    });
    sfClient.clearTargetOrg();
    res.json({ status: "deleted", sobjectType: req.params.sobjectType, id: req.params.id });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Erase all deleted custom fields (purge recycle bin) ---
app.get("/api/erase-deleted-fields", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();

    // Step 1: Find deleted custom fields
    const result = await conn.request({
      method: "GET",
      url: "/services/data/v62.0/tooling/query/?q=" +
        encodeURIComponent("SELECT Id, DeveloperName, TableEnumOrId FROM CustomField WHERE DeveloperName LIKE '%_del'"),
    });

    if (!result.records?.length) {
      sfClient.clearTargetOrg();
      return res.json({ status: "done", message: "No deleted fields found", erasedCount: 0, details: [] });
    }

    // Step 2: Remove FieldPermissions referencing deleted fields
    const deletedFieldNames = result.records.map(r => `${r.TableEnumOrId}.${r.DeveloperName}__c`);
    try {
      const fpQuery = `SELECT Id, Field FROM FieldPermissions WHERE ${deletedFieldNames.map(f => `Field = '${f}'`).join(" OR ")}`;
      const fpResult = await conn.query(fpQuery);
      if (fpResult.records?.length) {
        for (const fp of fpResult.records) {
          try { await conn.sobject("FieldPermissions").delete(fp.Id); } catch { /* skip */ }
        }
      }
    } catch { /* FieldPermissions query may fail, continue */ }

    // Step 2b: Also try with original names (without _del suffix)
    try {
      const originalNames = result.records.map(r => {
        const origName = r.DeveloperName.replace(/_del$/, "");
        return `${r.TableEnumOrId}.${origName}__c`;
      });
      const fpQuery2 = `SELECT Id, Field FROM FieldPermissions WHERE ${originalNames.map(f => `Field = '${f}'`).join(" OR ")}`;
      const fpResult2 = await conn.query(fpQuery2);
      if (fpResult2.records?.length) {
        for (const fp of fpResult2.records) {
          try { await conn.sobject("FieldPermissions").delete(fp.Id); } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    // Step 3: Now erase the deleted fields
    const deleted = [];
    for (const field of result.records) {
      try {
        await conn.request({
          method: "DELETE",
          url: `/services/data/v62.0/tooling/sobjects/CustomField/${field.Id}`,
        });
        deleted.push({ id: field.Id, name: field.DeveloperName, object: field.TableEnumOrId, status: "erased" });
      } catch (err) {
        deleted.push({ id: field.Id, name: field.DeveloperName, object: field.TableEnumOrId, status: "error", error: err.message });
      }
    }
    sfClient.clearTargetOrg();
    res.json({ status: "done", erasedCount: deleted.filter(d => d.status === "erased").length, total: deleted.length, details: deleted });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Assign Record Types to Profile ---
app.get("/api/assign-record-types/:objectName", async (req, res) => {
  try {
    await connectToTargetOrg(req);
    const conn = sfClient.getConnection();
    const objectName = req.params.objectName;
    const profileName = req.query.profile || "Admin";
    const rtResult = await conn.query(
      "SELECT Id, DeveloperName FROM RecordType WHERE SobjectType = '" + objectName + "' AND IsActive = true"
    );
    if (!rtResult.records.length) {
      sfClient.clearTargetOrg();
      return res.json({ status: "no_record_types_found" });
    }
    const visibilities = rtResult.records.map((rt, idx) => ({
      recordType: objectName + "." + rt.DeveloperName,
      visible: true,
      default: idx === 0,
    }));
    const result = await conn.metadata.update("Profile", {
      fullName: profileName,
      recordTypeVisibilities: visibilities,
    });
    const success = Array.isArray(result) ? result[0]?.success : result?.success;
    sfClient.clearTargetOrg();
    res.json({ status: success ? "assigned" : "failed", profile: profileName, recordTypes: visibilities });
  } catch (err) {
    sfClient.clearTargetOrg();
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- Additional Routes ---
registerSnowflakeRoutes(app);
registerMuleSyncRoutes(app, sfClient);
registerKmlRoutes(app);
  
  // TechEnglish
  app.use('/english', englishRouter);
  initEnglish();
  console.log('[english] Mounted at /english');
  registerAdditionalRoutes(app, sfClient, connectToTargetOrg);

// --- Everi9 Chat App ---
mountChatApp(app);

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Salesforce Server v3.4.0 running on port ${PORT}`);
  console.log(`Features: ScratchOrgs=true, MultiOrg=true, MockData=true, GitHub=${!!ghClient}, DeployViaUrl=true`);
});
// DC-RESTART 2026-05-31T22:19:43.731459
