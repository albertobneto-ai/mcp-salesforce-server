// mule-sync.js — MuleSoft Integration Layer (CDC real-time sync)
// Handles: Sales Cloud <-> Snowflake <-> CRM Algar bidirectional sync

export function registerMuleSyncRoutes(app, sfClient) {

  const PORT = process.env.PORT || 3000;
  
  // Internal Snowflake query wrapper (calls our own /api/snowflake/execute)
  const snowflake = {
    execute: async (sql) => {
      try {
        const resp = await fetch(`http://localhost:${PORT}/api/snowflake/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql })
        });
        const data = await resp.json();
        return data.status === "ok" ? data.data : [];
      } catch (e) {
        console.error("[MuleSync] Snowflake error:", e.message);
        return [];
      }
    }
  };

  // ═══ HEALTH CHECK ═══
  app.get("/api/mule/health", (req, res) => {
    res.json({ status: "ok", service: "MuleSoft Sync Layer", version: "1.0", timestamp: new Date().toISOString() });
  });

  // ═══ 1. SALESFORCE → SNOWFLAKE (CDC Listener) ═══
  // Called by Salesforce Flow/Trigger when Account is created/updated
  app.post("/api/mule/cdc/account", async (req, res) => {
    const start = Date.now();
    const correlationId = `MULE-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    
    try {
      const { records, operation = "UPSERT", source = "Salesforce" } = req.body;
      
      if (!records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ status: "error", message: "records array required" });
      }

      const results = [];
      
      for (const record of records) {
        const sfId = record.Id || record.SF_ID;
        const name = record.Name;
        
        if (!sfId || !name) {
          results.push({ sfId, status: "error", message: "Id and Name required" });
          continue;
        }

        // Check if record exists in Snowflake CRM_ACCOUNTS
        const existing = await snowflake.execute(
          `SELECT SF_ID FROM CRM_ACCOUNTS WHERE SF_ID = '${sfId.replace(/'/g, "''")}'`
        );

        let sql;
        if (existing && existing.length > 0) {
          // UPDATE
          sql = `UPDATE CRM_ACCOUNTS SET 
            NAME = '${(name || "").replace(/'/g, "''")}',
            INDUSTRY = '${(record.Industry || "").replace(/'/g, "''")}',
            TYPE = '${(record.Type || "").replace(/'/g, "''")}',
            PHONE = '${(record.Phone || "").replace(/'/g, "''")}',
            WEBSITE = '${(record.Website || "").replace(/'/g, "''")}',
            BILLING_CITY = '${(record.BillingCity || "").replace(/'/g, "''")}',
            BILLING_STATE = '${(record.BillingState || "").replace(/'/g, "''")}',
            ANNUAL_REVENUE = ${record.AnnualRevenue || "NULL"},
            NUMBER_OF_EMPLOYEES = ${record.NumberOfEmployees || "NULL"},
            OWNER_NAME = '${(record.OwnerName || record.Owner_Name__c || "").replace(/'/g, "''")}',
            LAST_SYNC = CURRENT_TIMESTAMP()
            WHERE SF_ID = '${sfId.replace(/'/g, "''")}'`;
          await snowflake.execute(sql);
          results.push({ sfId, name, status: "updated", target: "CRM_ACCOUNTS" });
        } else {
          // INSERT
          sql = `INSERT INTO CRM_ACCOUNTS (SF_ID, NAME, INDUSTRY, TYPE, PHONE, WEBSITE, BILLING_CITY, BILLING_STATE, ANNUAL_REVENUE, NUMBER_OF_EMPLOYEES, OWNER_NAME, LAST_SYNC)
            VALUES (
              '${sfId.replace(/'/g, "''")}',
              '${(name || "").replace(/'/g, "''")}',
              '${(record.Industry || "").replace(/'/g, "''")}',
              '${(record.Type || "").replace(/'/g, "''")}',
              '${(record.Phone || "").replace(/'/g, "''")}',
              '${(record.Website || "").replace(/'/g, "''")}',
              '${(record.BillingCity || "").replace(/'/g, "''")}',
              '${(record.BillingState || "").replace(/'/g, "''")}',
              ${record.AnnualRevenue || "NULL"},
              ${record.NumberOfEmployees || "NULL"},
              '${(record.OwnerName || "").replace(/'/g, "''")}',
              CURRENT_TIMESTAMP()
            )`;
          await snowflake.execute(sql);
          results.push({ sfId, name, status: "inserted", target: "CRM_ACCOUNTS" });
        }

        // Also sync to LEGACY_ACCOUNTS (for CRM Algar visibility)
        const legacyExisting = await snowflake.execute(
          `SELECT LEGACY_ID FROM LEGACY_ACCOUNTS WHERE SF_ID = '${sfId.replace(/'/g, "''")}'`
        );

        if (!legacyExisting || legacyExisting.length === 0) {
          const legacyId = `LEG-${sfId.slice(-8)}`;
          await snowflake.execute(`INSERT INTO LEGACY_ACCOUNTS (LEGACY_ID, NAME, CNPJ, INDUSTRY, TYPE, BILLING_CITY, BILLING_STATE, ANNUAL_REVENUE, SEGMENT, LEGACY_SYSTEM, SF_ID, SYNC_STATUS, LAST_SYNC)
            VALUES (
              '${legacyId}',
              '${(name || "").replace(/'/g, "''")}',
              '',
              '${(record.Industry || "").replace(/'/g, "''")}',
              '${(record.Type || "").replace(/'/g, "''")}',
              '${(record.BillingCity || "").replace(/'/g, "''")}',
              '${(record.BillingState || "").replace(/'/g, "''")}',
              ${record.AnnualRevenue || "NULL"},
              '${record.Type === "Enterprise" ? "Large" : "Medium"}',
              'SALESFORCE_CDC',
              '${sfId.replace(/'/g, "''")}',
              'SYNCED',
              CURRENT_TIMESTAMP()
            )`);
          results.push({ sfId, name, status: "mirrored", target: "LEGACY_ACCOUNTS", legacyId });
        } else {
          await snowflake.execute(`UPDATE LEGACY_ACCOUNTS SET 
            NAME = '${(name || "").replace(/'/g, "''")}',
            INDUSTRY = '${(record.Industry || "").replace(/'/g, "''")}',
            SYNC_STATUS = 'SYNCED',
            LAST_SYNC = CURRENT_TIMESTAMP()
            WHERE SF_ID = '${sfId.replace(/'/g, "''")}'`);
          results.push({ sfId, name, status: "updated", target: "LEGACY_ACCOUNTS" });
        }
      }

      // Log to Integration_Log__c in Salesforce
      try {
        const conn = sfClient.getConnection();
        if (conn) {
          await conn.sobject("Integration_Log__c").create({
            Source_System__c: source,
            Target_System__c: "Snowflake",
            Operation__c: operation,
            Object_Name__c: "Account",
            Status__c: "Success",
            Duration_ms__c: Date.now() - start,
            API_Name__c: "account-sync-process-api",
            HTTP_Method__c: "POST",
            HTTP_Status__c: 200,
            Correlation_Id__c: correlationId,
            Flow_Name__c: "sf-to-snowflake-account-cdc"
          });
        }
      } catch (logErr) { /* silent */ }

      res.json({
        status: "ok",
        correlationId,
        operation,
        count: results.length,
        duration_ms: Date.now() - start,
        results
      });

    } catch (err) {
      // Log error
      try {
        const conn = sfClient.getConnection();
        if (conn) {
          await conn.sobject("Integration_Log__c").create({
            Source_System__c: "Salesforce",
            Target_System__c: "Snowflake",
            Operation__c: "SYNC",
            Object_Name__c: "Account",
            Status__c: "Error",
            Error_Message__c: err.message?.slice(0, 255),
            Duration_ms__c: Date.now() - start,
            Correlation_Id__c: correlationId,
            Flow_Name__c: "sf-to-snowflake-account-cdc"
          });
        }
      } catch (logErr) { /* silent */ }

      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ═══ 2. CRM ALGAR → SALESFORCE (Reverse Sync) ═══
  // Called by CRM Algar emulator when user creates/updates account
  app.post("/api/mule/crm-to-sf/account", async (req, res) => {
    const start = Date.now();
    const correlationId = `MULE-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    try {
      const conn = sfClient.getConnection();
      if (!conn) return res.status(503).json({ status: "error", message: "Salesforce not connected" });

      const { records } = req.body;
      if (!records || !Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ status: "error", message: "records array required" });
      }

      const results = [];

      for (const record of records) {
        // Create in Salesforce
        const sfRecord = {
          Name: record.NAME || record.name,
          Industry: record.INDUSTRY || record.industry,
          Type: record.TYPE || record.type,
          BillingCity: record.BILLING_CITY || record.city,
          BillingState: record.BILLING_STATE || record.state,
          AnnualRevenue: record.ANNUAL_REVENUE || record.revenue,
          Legacy_CRM_Id__c: record.LEGACY_ID || record.legacy_id
        };

        const sfResult = await conn.sobject("Account").create(sfRecord);

        if (sfResult.success) {
          const sfId = sfResult.id;

          // Update Snowflake with the new SF_ID
          if (record.LEGACY_ID) {
            await snowflake.execute(`UPDATE LEGACY_ACCOUNTS SET 
              SF_ID = '${sfId}', SYNC_STATUS = 'SYNCED', LAST_SYNC = CURRENT_TIMESTAMP()
              WHERE LEGACY_ID = '${(record.LEGACY_ID || "").replace(/'/g, "''")}'`);
          }

          // Also insert into CRM_ACCOUNTS
          await snowflake.execute(`INSERT INTO CRM_ACCOUNTS (SF_ID, NAME, INDUSTRY, TYPE, BILLING_CITY, BILLING_STATE, ANNUAL_REVENUE, LAST_SYNC)
            VALUES (
              '${sfId}',
              '${(sfRecord.Name || "").replace(/'/g, "''")}',
              '${(sfRecord.Industry || "").replace(/'/g, "''")}',
              '${(sfRecord.Type || "").replace(/'/g, "''")}',
              '${(sfRecord.BillingCity || "").replace(/'/g, "''")}',
              '${(sfRecord.BillingState || "").replace(/'/g, "''")}',
              ${sfRecord.AnnualRevenue || "NULL"},
              CURRENT_TIMESTAMP()
            )`);

          // Update Mule_Sync_Status__c on the new Account
          try {
            await conn.sobject("Account").update({ Id: sfId, Mule_Sync_Status__c: "Synced", Mule_Last_Sync__c: new Date().toISOString() });
          } catch(e) { /* field might not exist yet */ }

          results.push({ sfId, name: sfRecord.Name, legacyId: record.LEGACY_ID, status: "created_in_sf" });
        } else {
          results.push({ name: sfRecord.Name, status: "error", error: sfResult.errors });
        }
      }

      // Log
      try {
        await conn.sobject("Integration_Log__c").create({
          Source_System__c: "Legacy CRM",
          Target_System__c: "Salesforce",
          Operation__c: "CREATE",
          Object_Name__c: "Account",
          Status__c: "Success",
          Duration_ms__c: Date.now() - start,
          API_Name__c: "crm-to-sf-account-sync",
          HTTP_Method__c: "POST",
          HTTP_Status__c: 200,
          Correlation_Id__c: correlationId,
          Flow_Name__c: "crm-algar-to-salesforce-account"
        });
      } catch (logErr) { /* silent */ }

      res.json({ status: "ok", correlationId, count: results.length, duration_ms: Date.now() - start, results });

    } catch (err) {
      res.status(500).json({ status: "error", correlationId, message: err.message });
    }
  });

  // ═══ 3. FULL SYNC (Batch — resync all accounts) ═══
  app.post("/api/mule/sync/accounts/full", async (req, res) => {
    const start = Date.now();
    const correlationId = `MULE-BATCH-${Date.now()}`;

    try {
      const conn = sfClient.getConnection();
      if (!conn) return res.status(503).json({ status: "error", message: "SF not connected" });

      // Get all accounts from Salesforce
      const sfAccounts = await conn.query(
        "SELECT Id, Name, Industry, Type, Phone, Website, BillingCity, BillingState, AnnualRevenue, NumberOfEmployees, Owner.Name FROM Account ORDER BY Name"
      );

      let inserted = 0, updated = 0;

      for (const acc of sfAccounts.records) {
        const sfId = acc.Id;
        const existing = await snowflake.execute(`SELECT SF_ID FROM CRM_ACCOUNTS WHERE SF_ID = '${sfId}'`);

        if (existing && existing.length > 0) {
          await snowflake.execute(`UPDATE CRM_ACCOUNTS SET 
            NAME='${(acc.Name||"").replace(/'/g,"''")}', INDUSTRY='${(acc.Industry||"").replace(/'/g,"''")}',
            TYPE='${(acc.Type||"").replace(/'/g,"''")}', PHONE='${(acc.Phone||"").replace(/'/g,"''")}',
            BILLING_CITY='${(acc.BillingCity||"").replace(/'/g,"''")}', BILLING_STATE='${(acc.BillingState||"").replace(/'/g,"''")}',
            ANNUAL_REVENUE=${acc.AnnualRevenue||"NULL"}, NUMBER_OF_EMPLOYEES=${acc.NumberOfEmployees||"NULL"},
            OWNER_NAME='${(acc.Owner?.Name||"").replace(/'/g,"''")}', LAST_SYNC=CURRENT_TIMESTAMP()
            WHERE SF_ID='${sfId}'`);
          updated++;
        } else {
          await snowflake.execute(`INSERT INTO CRM_ACCOUNTS (SF_ID,NAME,INDUSTRY,TYPE,PHONE,WEBSITE,BILLING_CITY,BILLING_STATE,ANNUAL_REVENUE,NUMBER_OF_EMPLOYEES,OWNER_NAME,LAST_SYNC)
            VALUES('${sfId}','${(acc.Name||"").replace(/'/g,"''")}','${(acc.Industry||"").replace(/'/g,"''")}','${(acc.Type||"").replace(/'/g,"''")}',
            '${(acc.Phone||"").replace(/'/g,"''")}','${(acc.Website||"").replace(/'/g,"''")}','${(acc.BillingCity||"").replace(/'/g,"''")}',
            '${(acc.BillingState||"").replace(/'/g,"''")}',${acc.AnnualRevenue||"NULL"},${acc.NumberOfEmployees||"NULL"},
            '${(acc.Owner?.Name||"").replace(/'/g,"''")}',CURRENT_TIMESTAMP())`);
          inserted++;
        }
      }

      // Log
      try {
        await conn.sobject("Integration_Log__c").create({
          Source_System__c: "Salesforce", Target_System__c: "Snowflake",
          Operation__c: "SYNC", Object_Name__c: "Account", Status__c: "Success",
          Duration_ms__c: Date.now() - start, Correlation_Id__c: correlationId,
          Flow_Name__c: "full-account-sync-batch"
        });
      } catch(e) {}

      res.json({ status: "ok", correlationId, total: sfAccounts.totalSize, inserted, updated, duration_ms: Date.now() - start });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // ═══ 4. SYNC STATUS ═══
  app.get("/api/mule/status", async (req, res) => {
    try {
      const conn = sfClient.getConnection();
      const sfCount = conn ? (await conn.query("SELECT COUNT() FROM Account")).totalSize : 0;
      const crmCount = await snowflake.execute("SELECT COUNT(*) as C FROM CRM_ACCOUNTS");
      const legacyCount = await snowflake.execute("SELECT COUNT(*) as C FROM LEGACY_ACCOUNTS");
      const syncedCount = await snowflake.execute("SELECT COUNT(*) as C FROM LEGACY_ACCOUNTS WHERE SYNC_STATUS = 'SYNCED'");
      const logs = conn ? (await conn.query("SELECT COUNT() FROM Integration_Log__c")).totalSize : 0;

      res.json({
        status: "ok",
        salesforce: { accounts: sfCount },
        snowflake: { crm_accounts: crmCount?.[0]?.C || 0, legacy_accounts: legacyCount?.[0]?.C || 0, synced: syncedCount?.[0]?.C || 0 },
        integration_logs: logs,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.json({ status: "error", message: err.message });
    }
  });

  console.log("[MuleSync] Routes registered: /api/mule/*");
}
