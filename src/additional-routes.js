
export function registerAdditionalRoutes(app, sfClient, connectToTargetOrg) {

  app.post("/api/execute-anonymous", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { code } = req.body;
      if (!code) return res.status(400).json({ status: "error", message: "Missing code" });
      const result = await conn.tooling.executeAnonymous(code);
      sfClient.clearTargetOrg();
      res.json({ success: result.success, compiled: result.compiled, compileProblem: result.compileProblem || null, exceptionMessage: result.exceptionMessage || null, exceptionStackTrace: result.exceptionStackTrace || null, line: result.line, column: result.column });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  app.post("/api/deploy-formula-fields", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const fields = Array.isArray(req.body) ? req.body : [req.body];
      const results = [];
      for (const f of fields) {
        const [obj, fname] = f.fullName.split(".");
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const fieldXml = `<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>${fname}</fullName><label>${f.label}</label><type>${f.type || "Text"}</type><formula>${esc(f.formula)}</formula><formulaTreatBlanksAs>${f.formulaTreatBlanksAs || "BlankAsBlank"}</formulaTreatBlanksAs></CustomField>`;
        const pkgXml = `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>${f.fullName}</members><name>CustomField</name></types><version>59.0</version></Package>`;
        try {
          const { default: JSZip } = await import("jszip");
          const zip = new JSZip();
          zip.file("package.xml", pkgXml);
          zip.file("fields/" + f.fullName + ".field-meta.xml", fieldXml);
          const buf = await zip.generateAsync({ type: "nodebuffer" });
          const dr = await new Promise((ok, fail) => {
            conn.metadata.deploy(buf, { singlePackage: true }).complete(true, (e, r) => e ? fail(e) : ok(r));
          });
          results.push({ fullName: f.fullName, success: dr.success, deployed: dr.numberComponentsDeployed, errors: dr.numberComponentErrors, failures: dr.details?.componentFailures || [] });
        } catch (err) {
          results.push({ fullName: f.fullName, success: false, error: err.message });
        }
      }
      sfClient.clearTargetOrg();
      res.json({ results });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

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
      if (addFields) {
        for (const add of addFields) {
          const tgt = sections.find(s => s.label === add.section);
          if (!tgt) { changes.push({ field: add.field, status: "section_not_found" }); continue; }
          const cols = Array.isArray(tgt.layoutColumns) ? tgt.layoutColumns : [tgt.layoutColumns].filter(Boolean);
          if (!cols.length) continue;
          let exists = false;
          for (const col of cols) { const items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean); if (items.some(i => i.field === add.field)) { exists = true; break; } }
          if (exists) { changes.push({ field: add.field, status: "already_present" }); continue; }
          const items = Array.isArray(cols[0].layoutItems) ? cols[0].layoutItems : [cols[0].layoutItems].filter(Boolean);
          items.push({ behavior: add.behavior || "Readonly", field: add.field });
          cols[0].layoutItems = items;
          changes.push({ field: add.field, status: "added" });
        }
      }
      if (moveField) {
        const src = sections.find(s => s.label === moveField.fromSection);
        if (src) { const srcCols = Array.isArray(src.layoutColumns) ? src.layoutColumns : [src.layoutColumns].filter(Boolean); for (const col of srcCols) { let items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean); col.layoutItems = items.filter(i => i.field !== moveField.field); } }
        const tgt = sections.find(s => s.label === moveField.toSection);
        if (tgt) { const tgtCols = Array.isArray(tgt.layoutColumns) ? tgt.layoutColumns : [tgt.layoutColumns].filter(Boolean); const items = Array.isArray(tgtCols[0].layoutItems) ? tgtCols[0].layoutItems : [tgtCols[0].layoutItems].filter(Boolean); items.push({ behavior: moveField.behavior || "Edit", field: moveField.field }); tgtCols[0].layoutItems = items; changes.push({ field: moveField.field, status: "moved" }); }
      }
      layout.layoutSections = sections;
      const r = await conn.metadata.update("Layout", layout);
      const ok = Array.isArray(r) ? r[0]?.success : r?.success;
      sfClient.clearTargetOrg();
      res.json({ status: ok ? "updated" : "failed", changes });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  console.log("Routes: execute-anonymous, deploy-formula-fields, update-layout");
}
