import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { SalesforceClient } from "./salesforce-client.js";
import { ManifestManager } from "./manifest-manager.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Salesforce Connection (from env vars) ---
const sfClient = new SalesforceClient({
  loginUrl: process.env.SF_LOGIN_URL || "https://login.salesforce.com",
  username: process.env.SF_USERNAME,
  password: process.env.SF_PASSWORD,
  securityToken: process.env.SF_SECURITY_TOKEN || "",
});

const manifestManager = new ManifestManager();

// --- MCP Server Setup ---
const mcpServer = new McpServer({
  name: "salesforce-provisioning",
  version: "1.0.0",
});

// ========== TOOL: describe_org ==========
mcpServer.tool(
  "describe_org",
  "Retorna informações da org conectada: objetos, campos existentes, limites",
  {
    objectName: z
      .string()
      .optional()
      .describe("Nome do objeto para detalhar (ex: Lead, Account). Se omitido, lista todos os objetos custom."),
  },
  async ({ objectName }) => {
    try {
      await sfClient.ensureConnected();

      if (objectName) {
        const desc = await sfClient.describeObject(objectName);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  name: desc.name,
                  label: desc.label,
                  fieldCount: desc.fields.length,
                  fields: desc.fields.map((f) => ({
                    name: f.name,
                    label: f.label,
                    type: f.type,
                    custom: f.custom,
                  })),
                  recordTypeCount: desc.recordTypeInfos?.length || 0,
                  recordTypes: desc.recordTypeInfos?.map((rt) => ({
                    name: rt.name,
                    active: rt.active,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // List all custom objects
      const globalDesc = await sfClient.describeGlobal();
      const customObjects = globalDesc.sobjects
        .filter((s) => s.custom)
        .map((s) => ({ name: s.name, label: s.label }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                orgId: sfClient.getOrgId(),
                totalObjects: globalDesc.sobjects.length,
                customObjects,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
    }
  }
);

// ========== TOOL: deploy_manifest ==========
mcpServer.tool(
  "deploy_manifest",
  "Recebe um manifest JSON e faz deploy de metadados na org Salesforce (objetos, campos, validation rules, etc.)",
  {
    manifest: z
      .string()
      .describe("Manifest JSON completo com metadados a provisionar (customObjects, customFields, validationRules, etc.)"),
    checkOnly: z
      .boolean()
      .default(false)
      .describe("Se true, apenas valida sem fazer deploy efetivo"),
  },
  async ({ manifest, checkOnly }) => {
    try {
      await sfClient.ensureConnected();
      const manifestData = JSON.parse(manifest);
      const results = await sfClient.deployManifest(manifestData, checkOnly);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: results.success ? "SUCCESS" : "FAILED",
                checkOnly,
                specName: manifestData.specName || "unknown",
                summary: results.summary,
                details: results.details,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro no deploy: ${err.message}` }] };
    }
  }
);

// ========== TOOL: deploy_component ==========
mcpServer.tool(
  "deploy_component",
  "Deploy de um componente individual na org (um campo, um objeto, uma validation rule)",
  {
    componentType: z
      .enum([
        "CustomObject",
        "CustomField",
        "ValidationRule",
        "RecordType",
        "Layout",
        "PermissionSet",
        "Flow",
      ])
      .describe("Tipo do componente de metadado"),
    metadata: z
      .string()
      .describe("JSON do componente a ser criado/atualizado"),
  },
  async ({ componentType, metadata }) => {
    try {
      await sfClient.ensureConnected();
      const metadataObj = JSON.parse(metadata);
      const result = await sfClient.deployComponent(componentType, metadataObj);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
    }
  }
);

// ========== TOOL: validate_manifest ==========
mcpServer.tool(
  "validate_manifest",
  "Valida um manifest sem fazer deploy (checkOnly). Retorna erros de validação se houver.",
  {
    manifest: z.string().describe("Manifest JSON a validar"),
  },
  async ({ manifest }) => {
    try {
      await sfClient.ensureConnected();
      const manifestData = JSON.parse(manifest);
      const results = await sfClient.deployManifest(manifestData, true);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                valid: results.success,
                errors: results.details?.filter((d) => !d.success) || [],
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro na validação: ${err.message}` }] };
    }
  }
);

// ========== TOOL: retrieve_metadata ==========
mcpServer.tool(
  "retrieve_metadata",
  "Puxa metadados existentes da org para comparar com a spec",
  {
    metadataTypes: z
      .array(z.string())
      .describe("Lista de tipos de metadado a recuperar (ex: ['CustomObject', 'CustomField'])"),
    objectName: z
      .string()
      .optional()
      .describe("Filtrar por objeto específico (ex: 'Lead')"),
  },
  async ({ metadataTypes, objectName }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.retrieveMetadata(metadataTypes, objectName);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
    }
  }
);

// ========== TOOL: run_soql ==========
mcpServer.tool(
  "run_soql",
  "Executa uma query SOQL na org e retorna os resultados",
  {
    query: z.string().describe("Query SOQL (ex: SELECT Id, Name FROM Account LIMIT 10)"),
  },
  async ({ query }) => {
    try {
      await sfClient.ensureConnected();
      const result = await sfClient.query(query);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { totalSize: result.totalSize, records: result.records },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Erro SOQL: ${err.message}` }] };
    }
  }
);

// ========== TOOL: list_manifests ==========
mcpServer.tool(
  "list_manifests",
  "Lista manifests disponíveis por workstream",
  {},
  async () => {
    const manifests = manifestManager.listManifests();
    return {
      content: [{ type: "text", text: JSON.stringify(manifests, null, 2) }],
    };
  }
);

// --- SSE Transport for MCP over HTTP ---
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  
  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  
  if (!transport) {
    return res.status(400).json({ error: "No active session found" });
  }
  
  await transport.handlePostMessage(req, res);
});

// --- Health check ---
app.get("/", (req, res) => {
  res.json({
    status: "running",
    server: "mcp-salesforce-provisioning",
    version: "1.0.0",
    tools: [
      "describe_org",
      "deploy_manifest",
      "deploy_component",
      "validate_manifest",
      "retrieve_metadata",
      "run_soql",
      "list_manifests",
    ],
  });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Salesforce Server running on port ${PORT}`);
  console.log(`SSE endpoint: /sse`);
  console.log(`Health check: /`);
});
