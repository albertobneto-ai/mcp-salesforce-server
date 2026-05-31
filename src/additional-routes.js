
export function registerAdditionalRoutes(app, sfClient, connectToTargetOrg) {

  // =============================================
  // EXECUTE ANONYMOUS APEX
  // =============================================

  // --- POST: Execute Anonymous Apex (body: { code: "..." }) ---
  app.post("/api/execute-anonymous", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.tooling.executeAnonymous(req.body.code);
      sfClient.clearTargetOrg();
      res.json({ success: result.success, compiled: result.compiled, compileProblem: result.compileProblem || null, exceptionMessage: result.exceptionMessage || null, exceptionStackTrace: result.exceptionStackTrace || null, line: result.line, column: result.column });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  // --- GET: Execute Anonymous Apex via base64 URL ---
  app.get("/api/execute-apex-b64/:data", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const apexCode = Buffer.from(req.params.data, "base64").toString("utf-8");
      const result = await conn.tooling.executeAnonymous(apexCode);
      sfClient.clearTargetOrg();
      res.json({
        success: result.success,
        compiled: result.compiled,
        compileProblem: result.compileProblem || null,
        exceptionMessage: result.exceptionMessage || null,
        exceptionStackTrace: result.exceptionStackTrace || null,
        line: result.line,
        column: result.column,
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // =============================================
  // SOQL VIA GET (browser-friendly)
  // =============================================

  // --- GET: SOQL via base64 URL ---
  app.get("/api/soql-b64/:data", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const soql = Buffer.from(req.params.data, "base64").toString("utf-8");
      const result = await sfClient.query(soql);
      sfClient.clearTargetOrg();
      res.json({ totalSize: result.totalSize, records: result.records });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- GET: SOQL via query param (convenience) ---
  app.get("/api/soql", async (req, res) => {
    try {
      if (!req.query.q) return res.status(400).json({ error: "Informe ?q=SELECT..." });
      await connectToTargetOrg(req);
      const result = await sfClient.query(req.query.q);
      sfClient.clearTargetOrg();
      res.json({ totalSize: result.totalSize, records: result.records });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // =============================================
  // UPSERT
  // =============================================

  // --- POST: Upsert records (body: { objectName, records, externalIdField }) ---
  app.post("/api/data/upsert", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { objectName, records, externalIdField } = req.body;
      if (!objectName || !records?.length || !externalIdField) {
        return res.status(400).json({ error: "Informe objectName, records[] e externalIdField" });
      }
      const results = [];
      for (const record of records) {
        try {
          const result = await conn.sobject(objectName).upsert(record, externalIdField);
          results.push({ success: true, id: result.id, created: result.created });
        } catch (err) {
          results.push({ success: false, error: err.message });
        }
      }
      sfClient.clearTargetOrg();
      res.json({ objectName, externalIdField, total: records.length, success: results.filter(r => r.success).length, results });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- GET: Upsert via base64 ---
  app.get("/api/data/upsert-b64/:data", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const payload = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));
      const { objectName, records, externalIdField } = payload;
      if (!objectName || !records?.length || !externalIdField) {
        sfClient.clearTargetOrg();
        return res.status(400).json({ error: "Informe objectName, records[] e externalIdField" });
      }
      const results = [];
      for (const record of records) {
        try {
          const result = await conn.sobject(objectName).upsert(record, externalIdField);
          results.push({ success: true, id: result.id, created: result.created });
        } catch (err) {
          results.push({ success: false, error: err.message });
        }
      }
      sfClient.clearTargetOrg();
      res.json({ objectName, externalIdField, total: records.length, success: results.filter(r => r.success).length, results });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // =============================================
  // UPDATE VIA GET (base64)
  // =============================================

  app.get("/api/update-records-b64/:data", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const payload = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));

      // payload: { objectName, records: [{ Id, Field: value }, ...] }
      // ou batches: [{ objectName, records }, ...]
      if (payload.batches) {
        const allResults = [];
        for (const batch of payload.batches) {
          const results = [];
          for (const record of batch.records) {
            try {
              const result = await conn.sobject(batch.objectName).update(record);
              results.push({ id: record.Id, success: result.success || true });
            } catch (err) {
              results.push({ id: record.Id, success: false, error: err.message });
            }
          }
          allResults.push({ objectName: batch.objectName, total: batch.records.length, success: results.filter(r => r.success).length, results });
        }
        sfClient.clearTargetOrg();
        return res.json({ batchCount: allResults.length, results: allResults });
      }

      const { objectName, records } = payload;
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

  // =============================================
  // COMPOSITE (multi-object insert in order)
  // =============================================

  // --- POST: Composite insert (respects insert order, returns IDs for chaining) ---
  app.post("/api/data/composite", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { steps } = req.body;
      // steps: [{ objectName, records, refPrefix }, ...]
      // Each step can reference previous step IDs via @{refPrefix_N}
      if (!steps?.length) {
        return res.status(400).json({ error: "Informe steps: [{ objectName, records, refPrefix }]" });
      }

      const idMap = {}; // refPrefix_N -> Salesforce Id
      const allResults = [];

      for (const step of steps) {
        const stepResults = [];
        for (let i = 0; i < step.records.length; i++) {
          const record = { ...step.records[i] };
          // Replace references @{ref_N} with actual IDs
          for (const [key, value] of Object.entries(record)) {
            if (typeof value === "string" && value.startsWith("@{") && value.endsWith("}")) {
              const ref = value.slice(2, -1);
              if (idMap[ref]) record[key] = idMap[ref];
            }
          }
          try {
            const result = await conn.request({
              method: "POST",
              url: `/services/data/v62.0/sobjects/${step.objectName}`,
              body: JSON.stringify(record),
              headers: { "Content-Type": "application/json", "Sforce-Duplicate-Rule-Header": "allowSave=true" },
            });
            const id = result.id;
            if (step.refPrefix) idMap[`${step.refPrefix}_${i}`] = id;
            stepResults.push({ success: true, id, ref: step.refPrefix ? `${step.refPrefix}_${i}` : undefined });
          } catch (err) {
            stepResults.push({ success: false, error: err.message });
          }
        }
        allResults.push({ objectName: step.objectName, total: step.records.length, success: stepResults.filter(r => r.success).length, results: stepResults });
      }

      sfClient.clearTargetOrg();
      res.json({ status: "completed", stepCount: allResults.length, idMap, results: allResults });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- GET: Composite via base64 ---
  app.get("/api/data/composite-b64/:data", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const payload = JSON.parse(Buffer.from(req.params.data, "base64").toString("utf-8"));

      const { steps } = payload;
      if (!steps?.length) {
        sfClient.clearTargetOrg();
        return res.status(400).json({ error: "Informe steps" });
      }

      const idMap = {};
      const allResults = [];

      for (const step of steps) {
        const stepResults = [];
        for (let i = 0; i < step.records.length; i++) {
          const record = { ...step.records[i] };
          for (const [key, value] of Object.entries(record)) {
            if (typeof value === "string" && value.startsWith("@{") && value.endsWith("}")) {
              const ref = value.slice(2, -1);
              if (idMap[ref]) record[key] = idMap[ref];
            }
          }
          try {
            const result = await conn.request({
              method: "POST",
              url: `/services/data/v62.0/sobjects/${step.objectName}`,
              body: JSON.stringify(record),
              headers: { "Content-Type": "application/json", "Sforce-Duplicate-Rule-Header": "allowSave=true" },
            });
            if (step.refPrefix) idMap[`${step.refPrefix}_${i}`] = result.id;
            stepResults.push({ success: true, id: result.id, ref: step.refPrefix ? `${step.refPrefix}_${i}` : undefined });
          } catch (err) {
            stepResults.push({ success: false, error: err.message });
          }
        }
        allResults.push({ objectName: step.objectName, total: step.records.length, success: stepResults.filter(r => r.success).length, results: stepResults });
      }

      sfClient.clearTargetOrg();
      res.json({ status: "completed", stepCount: allResults.length, idMap, results: allResults });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // =============================================
  // FORMULA FIELDS DEPLOY
  // =============================================

  app.post("/api/deploy-formula-fields", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const fields = Array.isArray(req.body) ? req.body : [req.body];
      if (!fields.length) return res.json({ status: "error", message: "No fields" });

      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();

      const byObj = {};
      for (const f of fields) {
        const [obj, fname] = f.fullName.split(".");
        if (!byObj[obj]) byObj[obj] = [];
        byObj[obj].push(f);
      }

      const members = fields.map(f => "<members>" + f.fullName + "</members>").join("\n        ");
      zip.file("package.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        ' + members + '\n        <name>CustomField</name>\n    </types>\n    <version>59.0</version>\n</Package>');

      for (const [obj, objFields] of Object.entries(byObj)) {
        let fieldsXml = "";
        for (const f of objFields) {
          const fname = f.fullName.split(".")[1];
          const formula = f.formula.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          fieldsXml += "\n    <fields>\n        <fullName>" + fname + "</fullName>\n        <label>" + f.label + "</label>\n        <type>" + (f.type || "Text") + "</type>\n        <formula>" + formula + "</formula>\n        <formulaTreatBlanksAs>" + (f.formulaTreatBlanksAs || "BlankAsBlank") + "</formulaTreatBlanksAs>\n    </fields>";
        }
        zip.file("objects/" + obj + ".object", '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">' + fieldsXml + '\n</CustomObject>');
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const { deployId } = await sfClient.startDeploy(zipBuffer, { checkOnly: false, testLevel: "NoTestRun" });

      sfClient.clearTargetOrg();
      res.json({ status: "deploying", deployId, checkStatusUrl: "/api/deploy-status/" + deployId, fields: fields.map(f => f.fullName) });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  // =============================================
  // LAYOUT UPDATE
  // =============================================

  app.post("/api/update-layout", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { layoutFullName, addFields, moveField } = req.body;
      if (!layoutFullName) return res.status(400).json({ status: "error", message: "Missing layoutFullName" });
      const layout = await conn.metadata.read("Layout", layoutFullName);
      if (!layout?.fullName) { sfClient.clearTargetOrg(); return res.status(404).json({ status: "error", message: "Layout not found" }); }
      const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections].filter(Boolean);
      const changes = [];
      if (addFields) { for (const add of addFields) { const tgt = sections.find(s => s.label === add.section); if (!tgt) { changes.push({ field: add.field, status: "section_not_found" }); continue; } const cols = Array.isArray(tgt.layoutColumns) ? tgt.layoutColumns : [tgt.layoutColumns].filter(Boolean); if (!cols.length) continue; let exists = false; for (const col of cols) { const items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean); if (items.some(i => i.field === add.field)) { exists = true; break; } } if (exists) { changes.push({ field: add.field, status: "already_present" }); continue; } const items = Array.isArray(cols[0].layoutItems) ? cols[0].layoutItems : [cols[0].layoutItems].filter(Boolean); items.push({ behavior: add.behavior || "Readonly", field: add.field }); cols[0].layoutItems = items; changes.push({ field: add.field, status: "added" }); } }
      if (moveField) { const src = sections.find(s => s.label === moveField.fromSection); if (src) { const srcCols = Array.isArray(src.layoutColumns) ? src.layoutColumns : [src.layoutColumns].filter(Boolean); for (const col of srcCols) { let items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean); col.layoutItems = items.filter(i => i.field !== moveField.field); } } const tgt = sections.find(s => s.label === moveField.toSection); if (tgt) { const tgtCols = Array.isArray(tgt.layoutColumns) ? tgt.layoutColumns : [tgt.layoutColumns].filter(Boolean); const items = Array.isArray(tgtCols[0].layoutItems) ? tgtCols[0].layoutItems : [tgtCols[0].layoutItems].filter(Boolean); items.push({ behavior: moveField.behavior || "Edit", field: moveField.field }); tgtCols[0].layoutItems = items; changes.push({ field: moveField.field, status: "moved" }); } }
      layout.layoutSections = sections;
      const deployResult = await conn.metadata.update("Layout", layout);
      const ok = Array.isArray(deployResult) ? deployResult[0]?.success : deployResult?.success;
      sfClient.clearTargetOrg();
      res.json({ status: ok ? "updated" : "failed", changes });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });



  // --- Metadata Create ---
  app.post("/api/metadata-create/:type", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.create(req.params.type, req.body);
      sfClient.clearTargetOrg();
      const item = Array.isArray(result) ? result[0] : result;
      res.json({ success: item?.success, fullName: item?.fullName, errors: item?.errors || null });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Delete (GET com fullName na URL) ---
  app.get("/api/metadata-delete/:type/:fullName", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.delete(req.params.type, req.params.fullName);
      sfClient.clearTargetOrg();
      const item = Array.isArray(result) ? result[0] : result;
      res.json({ success: item?.success !== false, fullName: req.params.fullName, errors: item?.errors || null });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Delete (POST com array de fullNames) ---
  app.post("/api/metadata-delete/:type", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const names = req.body.fullNames || [req.body.fullName];
      const result = await conn.metadata.delete(req.params.type, names);
      sfClient.clearTargetOrg();
      const items = Array.isArray(result) ? result : [result];
      res.json({ success: items.every(i => i?.success !== false), results: items });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Upsert ---
  app.post("/api/metadata-upsert/:type", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.upsert(req.params.type, req.body);
      sfClient.clearTargetOrg();
      const item = Array.isArray(result) ? result[0] : result;
      res.json({ success: item?.success, fullName: item?.fullName, created: item?.created, errors: item?.errors || null });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Read (generic) ---
  app.get("/api/metadata-read/:type/:fullName", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.read(req.params.type, decodeURIComponent(req.params.fullName));
      sfClient.clearTargetOrg();
      res.json(result);
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Update (generic) ---
  app.post("/api/metadata-update/:type", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.update(req.params.type, req.body);
      sfClient.clearTargetOrg();
      const item = Array.isArray(result) ? result[0] : result;
      res.json({ success: item?.success, errors: item?.errors || null });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Deploy Lead Convert Field Mappings ---
  app.post("/api/lead-convert-mapping", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { mappings } = req.body;
      // mappings: [{ inputField: "Sector__c", outputField: "Sector__c" }, ...]
      
      if (!mappings || !Array.isArray(mappings)) {
        return res.status(400).json({ error: "mappings array required" });
      }

      // Use sfClient.deploySettings for ZIP deploy
      const mappingXml = mappings.map(m => 
        `        <mappingFields>
            <inputField>${m.inputField}</inputField>
            <outputField>${m.outputField}</outputField>
        </mappingFields>`
      ).join("\n");

      const settingsXml = `<?xml version="1.0" encoding="UTF-8"?>
<LeadConvertSettings xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectMapping>
        <inputObject>Lead</inputObject>
        <outputObject>Opportunity</outputObject>
${mappingXml}
    </objectMapping>
</LeadConvertSettings>`;

      const result = await sfClient.deploySettings("LeadConvert", settingsXml);
      
      sfClient.clearTargetOrg();
      res.json({
        success: result?.success || false,
        status: result?.status || "unknown",
        componentsDeployed: result?.numberComponentsDeployed || 0,
        errors: result?.componentFailures || [],
        mappings: mappings,
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Enable Field History Tracking ---
  app.post("/api/field-history", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { object, fields } = req.body;
      // object: "Opportunity", fields: ["Sector__c", "Board__c"]

      if (!object || !fields || !Array.isArray(fields)) {
        return res.status(400).json({ error: "object and fields array required" });
      }

      // Enable history tracking on the object first
      try {
        await conn.metadata.update("CustomObject", {
          fullName: object,
          enableHistory: true,
        });
      } catch(e) { /* might already be enabled */ }

      // Update each field to enable trackHistory
      const results = [];
      for (const field of fields) {
        try {
          // Read current field metadata
          const fullName = `${object}.${field}`;
          const existing = await conn.metadata.read("CustomField", fullName);
          
          if (existing && existing.fullName) {
            // Update with trackHistory enabled
            const updateResult = await conn.metadata.update("CustomField", {
              fullName: fullName,
              label: existing.label,
              type: existing.type,
              trackHistory: true,
              ...(existing.length && { length: existing.length }),
              ...(existing.precision && { precision: existing.precision }),
              ...(existing.scale != null && { scale: existing.scale }),
              ...(existing.valueSet && { valueSet: existing.valueSet }),
            });
            const success = Array.isArray(updateResult) ? updateResult[0].success : updateResult.success;
            results.push({ field, success, error: success ? null : (updateResult.errors || "unknown") });
          } else {
            results.push({ field, success: false, error: "Field not found" });
          }
        } catch (err) {
          results.push({ field, success: false, error: err.message });
        }
      }

      sfClient.clearTargetOrg();
      res.json({
        object,
        results,
        totalSuccess: results.filter(r => r.success).length,
        totalFailed: results.filter(r => !r.success).length,
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Metadata Create (for new components like ReportType) ---
  app.post("/api/metadata-create/:type", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.metadata.create(req.params.type, req.body);
      sfClient.clearTargetOrg();
      const item = Array.isArray(result) ? result[0] : result;
      res.json({ success: item?.success, fullName: item?.fullName, errors: item?.errors || null });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });



  // =============================================
  // DATA CLOUD API ROUTES
  // =============================================

  // --- GET: Data Cloud Overview (all config in one call) ---
  app.get("/api/datacloud/overview", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const [streams, dlos, segments, ir, activations] = await Promise.all([
        conn.query("SELECT Id,Name,Description,DataStreamStatus,RefreshFrequency,RefreshMode,LastRefreshDate,TotalNumberOfRowsAdded FROM DataStream ORDER BY Name LIMIT 50").catch(()=>({records:[]})),
        conn.query("SELECT Id,Name,Description,DataLakeObjectStatus,Category,TotalRecords,Storage,TotalNumberOfFields,ExternalName FROM DataLakeObjectInstance ORDER BY Name LIMIT 50").catch(()=>({records:[]})),
        conn.query("SELECT Id,Name,Description,SegmentStatus,LastSegmentMemberCount,PublishScheduleInterval,IncludeCriteria,ExcludeCriteria,LastPublishedEndDateTime,NextPublishDateTime FROM MarketSegment ORDER BY Name LIMIT 50").catch(()=>({records:[]})),
        conn.query("SELECT Id,Name,Status,LastRunStatus,SourceCount,MatchedCount,UnifiedCount,ConsolidationRate,IsScheduled,LastSuccessfulRunDateTime FROM IdentityResolution LIMIT 20").catch(()=>({records:[]})),
        conn.query("SELECT Id,Name,MarketSegmentId,LastPublishStatus,ActivationRefreshType,RecordCount,LastPublishedDate FROM MarketSegmentActivation LIMIT 50").catch(()=>({records:[]}))
      ]);
      sfClient.clearTargetOrg();
      res.json({
        status: "ok",
        data: {
          streams: streams.records || [],
          dlos: dlos.records || [],
          segments: segments.records || [],
          identityResolution: ir.records || [],
          activations: activations.records || []
        }
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- GET: SSOT REST API proxy ---
  app.get("/api/datacloud/ssot/*", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const path = "/services/data/v62.0/ssot/" + req.params[0];
      console.log("[DC] GET", path);
      const result = await conn.request({ method: "GET", url: path });
      sfClient.clearTargetOrg();
      res.json({ status: "ok", data: result });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message || String(err) });
    }
  });

  // --- POST: SSOT REST API proxy (for creates/updates) ---
  app.post("/api/datacloud/ssot/*", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const path = "/services/data/v62.0/ssot/" + req.params[0];
      console.log("[DC] POST", path, JSON.stringify(req.body).substring(0, 200));
      const result = await conn.request({ method: "POST", url: path, body: JSON.stringify(req.body), headers: { "Content-Type": "application/json" } });
      sfClient.clearTargetOrg();
      res.json({ status: "ok", data: result });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message || String(err) });
    }
  });

  // --- GET: Data Cloud Query API (query DMOs) ---
  app.post("/api/datacloud/query", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.request({
        method: "POST",
        url: "/services/data/v62.0/ssot/queryV2",
        body: JSON.stringify({ sql: req.body.sql }),
        headers: { "Content-Type": "application/json" }
      });
      sfClient.clearTargetOrg();
      res.json({ status: "ok", data: result });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message });
    }
  });



  // Data Cloud diagnostic - try multiple API paths
  app.get("/api/datacloud/diag", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const results = {};
      
      const paths = [
        "/services/data/v62.0/sobjects/DataStream/describe",
        "/services/data/v62.0/connect/cdp",
        "/services/data/v62.0/ssot/data-connector-types",
        "/services/data/v62.0/ssot/data-streams",
        "/services/data/v62.0/ssot/data-spaces",
        "/services/data/v62.0/connect/data-connector-types"
      ];
      
      for (const path of paths) {
        try {
          const r = await conn.request({ method: "GET", url: path });
          results[path] = { status: "ok", data: JSON.stringify(r).substring(0, 300) };
        } catch (e) {
          results[path] = { status: "error", message: e.message || String(e) };
        }
      }
      
      // Also try to get user permissions
      try {
        const perms = await conn.query("SELECT Id, PermissionSet.Name FROM PermissionSetAssignment WHERE AssigneeId = '" + conn.userInfo.id + "' LIMIT 30");
        results["permissions"] = perms.records.map(r => r.PermissionSet?.Name).filter(Boolean);
      } catch(e) {
        results["permissions"] = e.message;
      }
      
      sfClient.clearTargetOrg();
      res.json({ status: "ok", results });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message });
    }
  });



  // CDP Token Exchange + API proxy
  app.get("/api/datacloud/cdp-test", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const instanceUrl = conn.instanceUrl;
      const accessToken = conn.accessToken;
      
      // Step 1: Exchange token for CDP token
      const tokenUrl = instanceUrl + "/services/a360/token";
      const tokenBody = "grant_type=urn:salesforce:grant-type:external:cdp" +
        "&subject_token=" + encodeURIComponent(accessToken) +
        "&subject_token_type=urn:ietf:params:oauth:token-type:access_token";
      
      const fetch = (await import("node-fetch")).default || globalThis.fetch;
      
      let tokenResponse;
      try {
        tokenResponse = await conn.request({
          method: "POST",
          url: "/services/a360/token",
          body: tokenBody,
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
      } catch(e) {
        // Try native fetch as fallback
        const r = await globalThis.fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenBody
        });
        tokenResponse = await r.json();
      }
      
      if (tokenResponse.access_token) {
        // Step 2: Use CDP token to call SSOT API
        const cdpToken = tokenResponse.access_token;
        const cdpUrl = (tokenResponse.instance_url || instanceUrl) + "/services/a360/api/v1/data-streams";
        
        const r2 = await globalThis.fetch(cdpUrl, {
          method: "GET",
          headers: { "Authorization": "Bearer " + cdpToken, "Content-Type": "application/json" }
        });
        const data = await r2.json();
        
        sfClient.clearTargetOrg();
        res.json({ status: "ok", tokenExchange: "success", cdpInstanceUrl: tokenResponse.instance_url, data });
      } else {
        sfClient.clearTargetOrg();
        res.json({ status: "error", message: "Token exchange failed", tokenResponse });
      }
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message, stack: err.stack?.substring(0, 200) });
    }
  });


  // Data Cloud DELETE and PATCH proxy
  app.delete("/api/datacloud/ssot/*", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const path = "/services/data/v62.0/ssot/" + req.params[0];
      const result = await conn.request({ method: "DELETE", url: path });
      sfClient.clearTargetOrg();
      res.json({ status: "ok", data: result });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message });
    }
  });

  app.patch("/api/datacloud/ssot/*", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const path = "/services/data/v62.0/ssot/" + req.params[0];
      const result = await conn.request({ method: "PATCH", url: path, body: JSON.stringify(req.body), headers: { "Content-Type": "application/json" } });
      sfClient.clearTargetOrg();
      res.json({ status: "ok", data: result });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.json({ status: "error", message: err.message });
    }
  });

  console.log("Routes: execute-anonymous, datacloud-overview, datacloud-ssot-proxy, datacloud-query, execute-apex-b64, soql-b64, soql-get, upsert, update-b64, composite, deploy-formula-fields, update-layout, lead-convert-mapping, field-history");
}
