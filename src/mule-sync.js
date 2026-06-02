// mule-sync.js v4.0 — Bidirecional: SF ↔ CRM Algar ↔ Snowflake
// Cada lado guarda o ID do outro (SF_ID ↔ Legacy_CRM_Id__c / CRM_ID)

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
  // MULESOFT CDC: ACCOUNT (SF → CRM Algar → Snowflake → back-update SF)
  // ════════════════════════════════════════════
  app.post("/api/mule/cdc/account", async (req, res) => {
    const start = Date.now();
    const correlationId = `MULE-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    try {
      const { records, operation = "UPSERT", source = "Salesforce" } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });

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

      // MuleSoft → CRM Algar
      const crmResp = await fetch(`${SELF}/api/crm-algar/account`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: crmPayload, correlationId, skipSalesforce: true })
      });
      const crmResult = await crmResp.json();

      // Back-update SF com Legacy_CRM_Id__c (cross-reference)
      const conn = sfClient.getConnection();
      const backUpdates = [];
      if (conn && crmResult.records) {
        for (const r of crmResult.records) {
          if (r.sfId && r.crmId) {
            try {
              await fetch(`${SELF}/api/update-records`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ objectName: "Account", records: [{ Id: r.sfId, Legacy_CRM_Id__c: r.crmId }] })
              });
              backUpdates.push({ sfId: r.sfId, crmId: r.crmId, status: "sf_updated" });
            } catch (e) {
              backUpdates.push({ sfId: r.sfId, error: e.message });
            }
          }
        }
      }

      res.json({
        status: "ok", correlationId, layer: "MuleSoft → CRM Algar → SF back-sync",
        count: records.length, duration_ms: Date.now() - start,
        crm_algar: crmResult, sf_back_updates: backUpdates
      });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CDC: LEAD — direto no Snowflake CRM_LEADS
  // ════════════════════════════════════════════
  app.post("/api/mule/cdc/lead", async (req, res) => {
    const start = Date.now();
    const correlationId = `CDC-LEAD-${Date.now()}`;
    try {
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });
      let upserted = 0;
      for (const r of records) {
        const sfId = r.Id || r.SF_ID;
        const existing = await snowflake.execute(`SELECT SF_ID FROM CRM_LEADS WHERE SF_ID = '${esc(sfId)}'`);
        if (existing?.length > 0) {
          await snowflake.execute(`UPDATE CRM_LEADS SET FIRST_NAME='${esc(r.FirstName)}', LAST_NAME='${esc(r.LastName)}', EMAIL='${esc(r.Email)}', PHONE='${esc(r.Phone)}', COMPANY='${esc(r.Company)}', TITLE='${esc(r.Title)}', STATUS='${esc(r.Status)}', RATING='${esc(r.Rating)}', LAST_SYNC=CURRENT_TIMESTAMP() WHERE SF_ID='${esc(sfId)}'`);
        } else {
          await snowflake.execute(`INSERT INTO CRM_LEADS (SF_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, COMPANY, TITLE, STATUS, RATING, LAST_SYNC) VALUES('${esc(sfId)}','${esc(r.FirstName)}','${esc(r.LastName)}','${esc(r.Email)}','${esc(r.Phone)}','${esc(r.Company)}','${esc(r.Title)}','${esc(r.Status)}','${esc(r.Rating)}',CURRENT_TIMESTAMP())`);
        }
        upserted++;
      }
      res.json({ status: "ok", correlationId, object: "Lead", upserted, duration_ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CDC: CONTACT — direto no Snowflake CRM_CONTACTS
  // ════════════════════════════════════════════
  app.post("/api/mule/cdc/contact", async (req, res) => {
    const start = Date.now();
    const correlationId = `CDC-CONTACT-${Date.now()}`;
    try {
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });
      let upserted = 0;
      for (const r of records) {
        const sfId = r.Id || r.SF_ID;
        const existing = await snowflake.execute(`SELECT SF_ID FROM CRM_CONTACTS WHERE SF_ID = '${esc(sfId)}'`);
        if (existing?.length > 0) {
          await snowflake.execute(`UPDATE CRM_CONTACTS SET FIRST_NAME='${esc(r.FirstName)}', LAST_NAME='${esc(r.LastName)}', EMAIL='${esc(r.Email)}', PHONE='${esc(r.Phone)}', TITLE='${esc(r.Title)}', ACCOUNT_ID='${esc(r.AccountId)}', ACCOUNT_NAME='${esc(r.AccountName || "")}', DEPARTMENT='${esc(r.Department)}', LAST_SYNC=CURRENT_TIMESTAMP() WHERE SF_ID='${esc(sfId)}'`);
        } else {
          await snowflake.execute(`INSERT INTO CRM_CONTACTS (SF_ID, FIRST_NAME, LAST_NAME, EMAIL, PHONE, TITLE, ACCOUNT_ID, ACCOUNT_NAME, DEPARTMENT, LAST_SYNC) VALUES('${esc(sfId)}','${esc(r.FirstName)}','${esc(r.LastName)}','${esc(r.Email)}','${esc(r.Phone)}','${esc(r.Title)}','${esc(r.AccountId)}','${esc(r.AccountName || "")}','${esc(r.Department)}',CURRENT_TIMESTAMP())`);
        }
        upserted++;
      }
      res.json({ status: "ok", correlationId, object: "Contact", upserted, duration_ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CDC: OPPORTUNITY — direto no Snowflake CRM_OPPORTUNITIES
  // ════════════════════════════════════════════
  app.post("/api/mule/cdc/opportunity", async (req, res) => {
    const start = Date.now();
    const correlationId = `CDC-OPP-${Date.now()}`;
    try {
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });
      let upserted = 0;
      for (const r of records) {
        const sfId = r.Id || r.SF_ID;
        const existing = await snowflake.execute(`SELECT SF_ID FROM CRM_OPPORTUNITIES WHERE SF_ID = '${esc(sfId)}'`);
        if (existing?.length > 0) {
          await snowflake.execute(`UPDATE CRM_OPPORTUNITIES SET NAME='${esc(r.Name)}', ACCOUNT_ID='${esc(r.AccountId)}', ACCOUNT_NAME='${esc(r.AccountName || "")}', STAGE='${esc(r.StageName)}', AMOUNT=${num(r.Amount)}, PROBABILITY=${num(r.Probability)}, CLOSE_DATE=${r.CloseDate ? "'" + esc(r.CloseDate) + "'" : "NULL"}, TYPE='${esc(r.Type)}', LAST_SYNC=CURRENT_TIMESTAMP() WHERE SF_ID='${esc(sfId)}'`);
        } else {
          await snowflake.execute(`INSERT INTO CRM_OPPORTUNITIES (SF_ID, NAME, ACCOUNT_ID, ACCOUNT_NAME, STAGE, AMOUNT, PROBABILITY, CLOSE_DATE, TYPE, LAST_SYNC) VALUES('${esc(sfId)}','${esc(r.Name)}','${esc(r.AccountId)}','${esc(r.AccountName || "")}','${esc(r.StageName)}',${num(r.Amount)},${num(r.Probability)},${r.CloseDate ? "'" + esc(r.CloseDate) + "'" : "NULL"},'${esc(r.Type)}',CURRENT_TIMESTAMP())`);
        }
        upserted++;
      }
      res.json({ status: "ok", correlationId, object: "Opportunity", upserted, duration_ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // FULL SYNC
  // ════════════════════════════════════════════
  app.post("/api/mule/full-sync", async (req, res) => {
    const start = Date.now();
    try {
      const conn = sfClient.getConnection();
      if (!conn) return res.status(503).json({ status: "error", message: "SF not connected" });
      const results = {};
      const leads = await conn.query("SELECT Id, FirstName, LastName, Email, Phone, Company, Title, Status, Rating FROM Lead");
      if (leads.records?.length) {
        const lr = await fetch(`${SELF}/api/mule/cdc/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: leads.records }) });
        results.leads = await lr.json();
      }
      const contacts = await conn.query("SELECT Id, FirstName, LastName, Email, Phone, Title, AccountId, Department FROM Contact");
      if (contacts.records?.length) {
        const cr = await fetch(`${SELF}/api/mule/cdc/contact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: contacts.records }) });
        results.contacts = await cr.json();
      }
      const opps = await conn.query("SELECT Id, Name, AccountId, StageName, Amount, Probability, CloseDate, Type FROM Opportunity");
      if (opps.records?.length) {
        const or2 = await fetch(`${SELF}/api/mule/cdc/opportunity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: opps.records }) });
        results.opportunities = await or2.json();
      }
      res.json({ status: "ok", duration_ms: Date.now() - start, results });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ════════════════════════════════════════════
  // CRM ALGAR — BIDIRECIONAL
  // Se source_system=CRM_ALGAR → cria no SF também
  // Se vem do SF (skipSalesforce=true) → só CRM Algar + Snowflake
  // ════════════════════════════════════════════
  app.post("/api/crm-algar/account", async (req, res) => {
    const start = Date.now();
    const correlationId = req.body.correlationId || `CRM-${Date.now()}`;
    const skipSalesforce = req.body.skipSalesforce === true;
    try {
      const { records } = req.body;
      if (!records?.length) return res.status(400).json({ status: "error", message: "records required" });

      const results = [];
      const conn = sfClient.getConnection();

      for (const r of records) {
        const sfIdInput = r.sf_id || r.Id;
        const crmId = `ACR-${(sfIdInput || Date.now().toString()).slice(-10)}`;
        let finalSfId = sfIdInput;

        // 1. Criar/atualizar no CRM Algar nativo
        const existing = await snowflake.execute(
          `SELECT CRM_ID FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS WHERE SF_ID = '${esc(sfIdInput)}'`
        );

        if (existing?.length > 0) {
          await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET
            NAME='${esc(r.name || r.Name)}', INDUSTRY='${esc(r.industry || r.Industry)}', TYPE='${esc(r.type || r.Type)}',
            CITY='${esc(r.city || r.BillingCity)}', STATE='${esc(r.state || r.BillingState)}', ANNUAL_REVENUE=${num(r.annual_revenue || r.AnnualRevenue)},
            UPDATED_AT=CURRENT_TIMESTAMP(), INGESTED_TO_LAKE=FALSE
            WHERE SF_ID='${esc(sfIdInput)}'`);
          results.push({ crmId: existing[0].CRM_ID, sfId: sfIdInput, name: r.name || r.Name, status: "updated_in_crm_algar" });
        } else {
          // 2. Se vem do CRM Algar (não do SF), criar no SF primeiro
          if (!skipSalesforce && (r.source_system === "CRM_ALGAR" || !sfIdInput || sfIdInput.startsWith("CRM-"))) {
            try {
              const sfResp = await fetch(`${SELF}/api/data/composite`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  steps: [{ objectName: "Account", refPrefix: "acc", records: [{
                    Name: r.name || r.Name,
                    Industry: r.industry || r.Industry,
                    Type: r.type || r.Type,
                    BillingCity: r.city || r.BillingCity,
                    BillingState: r.state || r.BillingState,
                    Legacy_CRM_Id__c: crmId
                  }]}]
                })
              });
              const sfData = await sfResp.json();
              const accId = sfData?.idMap?.acc_0;
              if (accId) {
                finalSfId = accId;
                console.log("[CRM→SF] Account criado:", accId, "Legacy_CRM_Id__c:", crmId);
              }
            } catch (e) {
              console.error("[CRM→SF]", e.message);
            }
          }

          await snowflake.execute(`INSERT INTO ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS
            (CRM_ID, NAME, CNPJ, INDUSTRY, TYPE, CITY, STATE, ANNUAL_REVENUE, SEGMENT, SF_ID, SOURCE_SYSTEM, CREATED_AT, UPDATED_AT, INGESTED_TO_LAKE)
            VALUES('${crmId}','${esc(r.name || r.Name)}','','${esc(r.industry || r.Industry)}','${esc(r.type || r.Type)}',
            '${esc(r.city || r.BillingCity)}','${esc(r.state || r.BillingState)}',${num(r.annual_revenue || r.AnnualRevenue)},
            '${(r.type || r.Type) === "Enterprise" ? "Large" : "Medium"}','${esc(finalSfId)}','${esc(r.source_system || "Salesforce")}',
            CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP(),FALSE)`);
          results.push({ crmId, sfId: finalSfId, name: r.name || r.Name, status: finalSfId !== sfIdInput ? "created_in_crm_algar_and_salesforce" : "created_in_crm_algar" });
        }
      }

      // 3. Ingest to Snowflake
      const ingestResp = await fetch(`${SELF}/api/crm-algar/ingest-to-lake`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correlationId })
      });
      const ingestResult = await ingestResp.json();

      res.json({
        status: "ok", correlationId, layer: "CRM Algar (bidirecional)",
        count: results.length, duration_ms: Date.now() - start,
        records: results, lake_ingestion: ingestResult
      });
    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // INGESTÃO CRM ALGAR → SNOWFLAKE
  app.post("/api/crm-algar/ingest-to-lake", async (req, res) => {
    const start = Date.now();
    try {
      const pending = await snowflake.execute(
        `SELECT CRM_ID, NAME, CNPJ, INDUSTRY, TYPE, CITY, STATE, ANNUAL_REVENUE, SEGMENT, SF_ID
         FROM ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS WHERE INGESTED_TO_LAKE = FALSE`
      );
      let ingested = 0;
      for (const r of pending) {
        const legacyId = r.CRM_ID.replace("ACR-", "LEG-");
        const exists = await snowflake.execute(`SELECT LEGACY_ID FROM LEGACY_ACCOUNTS WHERE SF_ID='${esc(r.SF_ID)}'`);
        if (exists?.length > 0) {
          await snowflake.execute(`UPDATE LEGACY_ACCOUNTS SET NAME='${esc(r.NAME)}', INDUSTRY='${esc(r.INDUSTRY)}', TYPE='${esc(r.TYPE)}', BILLING_CITY='${esc(r.CITY)}', BILLING_STATE='${esc(r.STATE)}', ANNUAL_REVENUE=${num(r.ANNUAL_REVENUE)}, SYNC_STATUS='SYNCED', LAST_SYNC=CURRENT_TIMESTAMP() WHERE SF_ID='${esc(r.SF_ID)}'`);
        } else {
          await snowflake.execute(`INSERT INTO LEGACY_ACCOUNTS (LEGACY_ID, NAME, CNPJ, INDUSTRY, TYPE, BILLING_CITY, BILLING_STATE, ANNUAL_REVENUE, SEGMENT, LEGACY_SYSTEM, SF_ID, SYNC_STATUS, LAST_SYNC) VALUES('${legacyId}','${esc(r.NAME)}','${esc(r.CNPJ)}','${esc(r.INDUSTRY)}','${esc(r.TYPE)}','${esc(r.CITY)}','${esc(r.STATE)}',${num(r.ANNUAL_REVENUE)},'${esc(r.SEGMENT)}','ALGAR_CRM','${esc(r.SF_ID)}','SYNCED',CURRENT_TIMESTAMP())`);
        }
        await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET INGESTED_TO_LAKE=TRUE WHERE CRM_ID='${r.CRM_ID}'`);
        ingested++;
      }
      res.json({ status: "ok", layer: "CRM Algar → Snowflake", ingested, duration_ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // CRM ALGAR → SALES CLOUD (standalone, para uso manual)
  app.post("/api/crm-algar/to-salesforce/account", async (req, res) => {
    const start = Date.now();
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
          await snowflake.execute(`UPDATE ALGAR_CRM_LAKE.ALGAR_CRM_NATIVE.ACCOUNTS SET SF_ID='${sfResult.id}', UPDATED_AT=CURRENT_TIMESTAMP() WHERE CRM_ID='${esc(r.CRM_ID || r.crm_id)}'`);
          results.push({ sfId: sfResult.id, crmId: r.CRM_ID, status: "created_in_salesforce" });
        }
      }
      res.json({ status: "ok", count: results.length, duration_ms: Date.now() - start, results });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // STATUS
  app.get("/api/mule/status", async (req, res) => {
    try {
      const conn = sfClient.getConnection();
      const sfAccounts = conn ? (await conn.query("SELECT COUNT() FROM Account")).totalSize : 0;
      const sfLeads = conn ? (await conn.query("SELECT COUNT() FROM Lead")).totalSize : 0;
      const sfContacts = conn ? (await conn.query("SELECT COUNT() FROM Contact")).totalSize : 0;
      const sfOpps = conn ? (await conn.query("SELECT COUNT() FROM Opportunity")).totalSize : 0;
      const crmLeads = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_LEADS");
      const crmContacts = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_CONTACTS");
      const crmOpps = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_OPPORTUNITIES");
      const crmAccounts = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_ACCOUNTS");
      const nativeAccounts = await snowflake.execute("SELECT COUNT(*) as C FROM ALGAR_CRM_NATIVE.ACCOUNTS");
      res.json({
        status: "ok",
        arquitetura: "Bidirecional: SF ↔ CRM Algar ↔ Snowflake",
        salesforce: { accounts: sfAccounts, leads: sfLeads, contacts: sfContacts, opportunities: sfOpps },
        snowflake: { crm_accounts: crmAccounts?.[0]?.C || 0, crm_leads: crmLeads?.[0]?.C || 0, crm_contacts: crmContacts?.[0]?.C || 0, crm_opportunities: crmOpps?.[0]?.C || 0, native_accounts: nativeAccounts?.[0]?.C || 0 },
        timestamp: new Date().toISOString()
      });
    } catch (err) { res.json({ status: "error", message: err.message }); }
  });

  app.get("/api/mule/health", (req, res) =>
    res.json({ status: "ok", service: "MuleSoft Sync Layer", version: "4.0-bidirecional",
      routes: ["/api/mule/cdc/account","/api/mule/cdc/lead","/api/mule/cdc/contact","/api/mule/cdc/opportunity","/api/mule/full-sync","/api/crm-algar/account (bidirecional)"] }));

  console.log("[MuleSync] v4.0 — Bidirecional SF ↔ CRM Algar ↔ Snowflake");
}
