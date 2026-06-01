// mule-sync.js — Arquitetura correta: Sales Cloud → MuleSoft → CRM Algar → Snowflake → Data Cloud
// MuleSoft (iPaaS) orquestra entre sistemas. CRM Algar é dono dos dados e alimenta o Snowflake.

export function registerMuleSyncRoutes(app, sfClient) {

  const PORT = process.env.PORT || 3000;
  const SELF = `http://localhost:${PORT}`;

  const snowflake = {
    execute: async (sql) => {
      try {
        const resp = await fetch(`${SELF}/api/snowflake/execute`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql })
        });
        const data = await resp.json();
        return data.status === "ok" ? data.data : [];
      } catch (e) { console.error("[Snowflake]", e.message); return []; }
    }
  };
  const esc = (v) => (v == null ? "" : String(v).replace(/'/g, "''"));
  const num = (v) => (v == null || v === "" ? "NULL" : Number(v));

  // ════════════════════════════════════════════
  // CAMADA 1 — MULESOFT (iPaaS / orquestrador)
  // Sales Cloud → MuleSoft → chama CRM Algar API
  // ════════════════════════════════════════════
  app.post("/api/mule/cdc/account", async (req, res) => {
    const start = Date.now();
    const correlationId = `MULE-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    try {
      const { records, operation = "UPSERT", source = "Salesforce" } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });

      // MuleSoft transforma o payload Salesforce e chama a API do CRM Algar
      const crmPayload = records.map(r => ({
        sf_id: r.Id || r.SF_ID,
        name: r.Name,
        industry: r.Industry,
        type: r.Type,
        city: r.BillingCity,
        state: r.BillingState,
        annual_revenue: r.AnnualRevenue,
        source_system: source
      }));

      // MuleSoft → CRM Algar (não grava Snowflake direto!)
      const crmResp = await fetch(`${SELF}/api/crm-algar/account`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: crmPayload, correlationId })
      });
      const crmResult = await crmResp.json();

      // Log no Salesforce
      try {
        const conn = sfClient.getConnection();
        if (conn) await conn.sobject("Integration_Log__c").create({
          Source_System__c: source, Target_System__c: "Legacy CRM",
          Operation__c: operation, Object_Name__c: "Account", Status__c: "Success",
          Duration_ms__c: Date.now() - start, API_Name__c: "account-sync-process-api",
          HTTP_Method__c: "POST", HTTP_Status__c: 200, Correlation_Id__c: correlationId,
          Flow_Name__c: "salescloud-to-mulesoft-to-crmalgar"
        });
      } catch (e) {}

      res.json({
        status: "ok", correlationId, layer: "MuleSoft → CRM Algar",
        count: records.length, duration_ms: Date.now() - start,
        crm_algar: crmResult
      });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CAMADA 2 — CRM ALGAR (dono dos dados legados)
  // Recebe do MuleSoft, grava no SEU banco nativo,
  // depois dispara ingestão para o Snowflake (data lake)
  // ════════════════════════════════════════════
  app.post("/api/crm-algar/account", async (req, res) => {
    const start = Date.now();
    const correlationId = req.body.correlationId || `CRM-${Date.now()}`;
    try {
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });

      const results = [];
      for (const r of records) {
        const sfId = r.sf_id;
        const crmId = `ACR-${(sfId || Date.now().toString()).slice(-10)}`;

        // Grava no banco NATIVO do CRM Algar
        const existing = await snowflake.execute(
          `SELECT CRM_ID FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS WHERE SF_ID = '${esc(sfId)}'`
        );

        if (existing?.length > 0) {
          await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET
            NAME='${esc(r.name)}', INDUSTRY='${esc(r.industry)}', TYPE='${esc(r.type)}',
            CITY='${esc(r.city)}', STATE='${esc(r.state)}', ANNUAL_REVENUE=${num(r.annual_revenue)},
            UPDATED_AT=CURRENT_TIMESTAMP(), INGESTED_TO_LAKE=FALSE
            WHERE SF_ID='${esc(sfId)}'`);
          results.push({ crmId, sfId, name: r.name, status: "updated_in_crm_algar" });
        } else {
          await snowflake.execute(`INSERT INTO ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS
            (CRM_ID, NAME, CNPJ, INDUSTRY, TYPE, CITY, STATE, ANNUAL_REVENUE, SEGMENT, SF_ID, SOURCE_SYSTEM, CREATED_AT, UPDATED_AT, INGESTED_TO_LAKE)
            VALUES('${crmId}','${esc(r.name)}','','${esc(r.industry)}','${esc(r.type)}','${esc(r.city)}','${esc(r.state)}',
            ${num(r.annual_revenue)},'${r.type === "Enterprise" ? "Large" : "Medium"}','${esc(sfId)}','${esc(r.source_system)}',
            CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP(),FALSE)`);
          results.push({ crmId, sfId, name: r.name, status: "created_in_crm_algar" });
        }
      }

      // CRM Algar dispara SUA PRÓPRIA ingestão para o data lake (Snowflake LEGACY_ACCOUNTS)
      const ingestResp = await fetch(`${SELF}/api/crm-algar/ingest-to-lake`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correlationId })
      });
      const ingestResult = await ingestResp.json();

      res.json({
        status: "ok", correlationId, layer: "CRM Algar (native DB)",
        count: results.length, duration_ms: Date.now() - start,
        records: results, lake_ingestion: ingestResult
      });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CAMADA 3 — INGESTÃO CRM ALGAR → SNOWFLAKE DATA LAKE
  // CRM Algar empurra seus dados para o data lake (LEGACY_ACCOUNTS)
  // que o Data Cloud consome via Zero Copy
  // ════════════════════════════════════════════
  app.post("/api/crm-algar/ingest-to-lake", async (req, res) => {
    const start = Date.now();
    try {
      // Pega registros nativos ainda não ingeridos
      const pending = await snowflake.execute(
        `SELECT CRM_ID, NAME, CNPJ, INDUSTRY, TYPE, CITY, STATE, ANNUAL_REVENUE, SEGMENT, SF_ID
         FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS WHERE INGESTED_TO_LAKE = FALSE`
      );

      let ingested = 0;
      for (const r of pending) {
        const legacyId = r.CRM_ID.replace("ACR-", "LEG-");
        const exists = await snowflake.execute(`SELECT LEGACY_ID FROM LEGACY_ACCOUNTS WHERE SF_ID='${esc(r.SF_ID)}'`);

        if (exists?.length > 0) {
          await snowflake.execute(`UPDATE LEGACY_ACCOUNTS SET
            NAME='${esc(r.NAME)}', INDUSTRY='${esc(r.INDUSTRY)}', TYPE='${esc(r.TYPE)}',
            BILLING_CITY='${esc(r.CITY)}', BILLING_STATE='${esc(r.STATE)}', ANNUAL_REVENUE=${num(r.ANNUAL_REVENUE)},
            SYNC_STATUS='SYNCED', LAST_SYNC=CURRENT_TIMESTAMP() WHERE SF_ID='${esc(r.SF_ID)}'`);
        } else {
          await snowflake.execute(`INSERT INTO LEGACY_ACCOUNTS
            (LEGACY_ID, NAME, CNPJ, INDUSTRY, TYPE, BILLING_CITY, BILLING_STATE, ANNUAL_REVENUE, SEGMENT, LEGACY_SYSTEM, SF_ID, SYNC_STATUS, LAST_SYNC)
            VALUES('${legacyId}','${esc(r.NAME)}','${esc(r.CNPJ)}','${esc(r.INDUSTRY)}','${esc(r.TYPE)}',
            '${esc(r.CITY)}','${esc(r.STATE)}',${num(r.ANNUAL_REVENUE)},'${esc(r.SEGMENT)}','ALGAR_CRM','${esc(r.SF_ID)}','SYNCED',CURRENT_TIMESTAMP())`);
        }

        // Marca como ingerido
        await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET INGESTED_TO_LAKE=TRUE WHERE CRM_ID='${r.CRM_ID}'`);
        ingested++;
      }

      res.json({ status: "ok", layer: "CRM Algar → Snowflake data lake", ingested, duration_ms: Date.now() - start,
        note: "Data Cloud consome LEGACY_ACCOUNTS via Zero Copy" });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CRM ALGAR → SALES CLOUD (reverso, via MuleSoft)
  // ════════════════════════════════════════════
  app.post("/api/crm-algar/to-salesforce/account", async (req, res) => {
    const start = Date.now();
    const correlationId = `CRM-SF-${Date.now()}`;
    try {
      const conn = sfClient.getConnection();
      if (!conn) return res.status(503).json({ status: "error", message: "SF not connected" });
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });

      const results = [];
      for (const r of records) {
        const sfResult = await conn.sobject("Account").create({
          Name: r.NAME || r.name, Industry: r.INDUSTRY || r.industry,
          Type: r.TYPE || r.type, BillingCity: r.CITY || r.city,
          Legacy_CRM_Id__c: r.CRM_ID || r.crm_id
        });
        if (sfResult.success) {
          // Atualiza o banco nativo do CRM Algar com o SF_ID
          await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET SF_ID='${sfResult.id}', UPDATED_AT=CURRENT_TIMESTAMP() WHERE CRM_ID='${esc(r.CRM_ID || r.crm_id)}'`);
          results.push({ sfId: sfResult.id, crmId: r.CRM_ID, status: "created_in_salesforce" });
        }
      }
      res.json({ status: "ok", correlationId, count: results.length, duration_ms: Date.now() - start, results });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // STATUS — visão das 3 camadas
  // ════════════════════════════════════════════
  app.get("/api/mule/status", async (req, res) => {
    try {
      const conn = sfClient.getConnection();
      const sfCount = conn ? (await conn.query("SELECT COUNT() FROM Account")).totalSize : 0;
      const crmNative = await snowflake.execute("SELECT COUNT(*) as C FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS");
      const pending = await snowflake.execute("SELECT COUNT(*) as C FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS WHERE INGESTED_TO_LAKE=FALSE");
      const lakeLegacy = await snowflake.execute("SELECT COUNT(*) as C FROM LEGACY_ACCOUNTS");
      const lakeCrm = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_ACCOUNTS");
      const logs = conn ? (await conn.query("SELECT COUNT() FROM Integration_Log__c")).totalSize : 0;

      res.json({
        status: "ok",
        arquitetura: "Sales Cloud → MuleSoft → CRM Algar → Snowflake → Data Cloud",
        camada_1_salescloud: { accounts: sfCount },
        camada_2_crm_algar_native: { accounts: crmNative?.[0]?.C || 0, pendente_ingestao: pending?.[0]?.C || 0 },
        camada_3_snowflake_lake: { legacy_accounts: lakeLegacy?.[0]?.C || 0, crm_accounts: lakeCrm?.[0]?.C || 0 },
        integration_logs: logs,
        timestamp: new Date().toISOString()
      });
    } catch (err) { res.json({ status: "error", message: err.message }); }
  });

  app.get("/api/mule/health", (req, res) =>
    res.json({ status: "ok", service: "MuleSoft Sync Layer", arquitetura: "SalesCloud→MuleSoft→CRMAlgar→Snowflake→DataCloud", version: "2.0" }));

  console.log("[MuleSync] v2.0 — arquitetura correta registrada");
}
