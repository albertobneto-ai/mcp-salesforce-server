
export function registerAdditionalRoutes(app, sfClient, connectToTargetOrg) {

  app.post("/api/execute-anonymous", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const result = await conn.tooling.executeAnonymous(req.body.code);
      sfClient.clearTargetOrg();
      res.json({ success: result.success, compiled: result.compiled, compileProblem: result.compileProblem || null, exceptionMessage: result.exceptionMessage || null, exceptionStackTrace: result.exceptionStackTrace || null, line: result.line, column: result.column });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  app.post("/api/deploy-formula-fields", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const fields = Array.isArray(req.body) ? req.body : [req.body];
      if (!fields.length) return res.json({ status: "error", message: "No fields" });

      // Build ZIP using jszip (same as sfClient uses internally)
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();

      const members = fields.map(f => "<members>" + f.fullName + "</members>").join("\n        ");
      const pkgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        ' + members + '\n        <name>CustomField</name>\n    </types>\n    <version>59.0</version>\n</Package>';
      zip.file("package.xml", pkgXml);

      for (const f of fields) {
        const fname = f.fullName.split(".")[1];
        const formula = f.formula.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>' + fname + '</fullName>\n    <label>' + f.label + '</label>\n    <type>' + (f.type || "Text") + '</type>\n    <formula>' + formula + '</formula>\n    <formulaTreatBlanksAs>' + (f.formulaTreatBlanksAs || "BlankAsBlank") + '</formulaTreatBlanksAs>\n</CustomField>';
        zip.file("fields/" + f.fullName + ".field-meta.xml", xml);
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      // Use sfClient.startDeploy like deploy-code does (async, returns deployId)
      const { deployId } = await sfClient.startDeploy(zipBuffer, { checkOnly: false, testLevel: "NoTestRun" });

      sfClient.clearTargetOrg();
      res.json({
        status: "deploying",
        deployId,
        checkStatusUrl: "/api/deploy-status/" + deployId,
        fields: fields.map(f => f.fullName)
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
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
      const deployResult = await conn.metadata.update("Layout", layout);
      const ok = Array.isArray(deployResult) ? deployResult[0]?.success : deployResult?.success;
      sfClient.clearTargetOrg();
      res.json({ status: ok ? "updated" : "failed", changes });
    } catch (err) { sfClient.clearTargetOrg(); res.status(500).json({ status: "error", message: err.message }); }
  });

  console.log("Routes: execute-anonymous, deploy-formula-fields (async), update-layout");
}
