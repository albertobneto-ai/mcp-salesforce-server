
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

  console.log("Routes: execute-anonymous, execute-apex-b64, soql-b64, soql-get, upsert, update-b64, composite, deploy-formula-fields, update-layout");
}
