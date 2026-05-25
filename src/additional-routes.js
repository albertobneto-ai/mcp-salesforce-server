
export function registerAdditionalRoutes(app, sfClient, connectToTargetOrg) {

  // --- Execute Anonymous Apex ---
  app.post("/api/execute-anonymous", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { code } = req.body;
      if (!code) return res.status(400).json({ status: "error", message: "Missing code" });
      const result = await conn.tooling.executeAnonymous(code);
      sfClient.clearTargetOrg();
      res.json({
        success: result.success, compiled: result.compiled,
        compileProblem: result.compileProblem || null,
        exceptionMessage: result.exceptionMessage || null,
        exceptionStackTrace: result.exceptionStackTrace || null,
        line: result.line, column: result.column,
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Create Formula Field via Tooling API ---
  app.post("/api/create-formula-field", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const fields = Array.isArray(req.body) ? req.body : [req.body];
      const results = [];
      for (const f of fields) {
        try {
          const toolingResult = await conn.request({
            method: "POST",
            url: "/services/data/v62.0/tooling/sobjects/CustomField/",
            body: JSON.stringify({
              FullName: f.fullName,
              Metadata: {
                label: f.label,
                type: f.type || "Text",
                formula: f.formula,
                formulaTreatBlanksAs: f.formulaTreatBlanksAs || "BlankAsBlank",
                ...(f.description && { description: f.description }),
              },
            }),
            headers: { "Content-Type": "application/json" },
          });
          results.push({ fullName: f.fullName, success: true, id: toolingResult.id });
        } catch (err) {
          results.push({ fullName: f.fullName, success: false, error: err.message });
        }
      }
      sfClient.clearTargetOrg();
      res.json({ results });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Update Layout: add/move fields ---
  app.post("/api/update-layout", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { layoutFullName, addFields, moveField } = req.body;
      if (!layoutFullName) return res.status(400).json({ status: "error", message: "Missing layoutFullName" });
      const layout = await conn.metadata.read("Layout", layoutFullName);
      if (!layout || !layout.fullName) {
        sfClient.clearTargetOrg();
        return res.status(404).json({ status: "error", message: "Layout not found" });
      }
      const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections].filter(Boolean);
      const changes = [];
      if (addFields && Array.isArray(addFields)) {
        for (const add of addFields) {
          const { field, section, behavior } = add;
          const targetSection = sections.find(s => s.label === section);
          if (!targetSection) { changes.push({ action: "add", field, section, status: "section_not_found" }); continue; }
          const columns = Array.isArray(targetSection.layoutColumns) ? targetSection.layoutColumns : [targetSection.layoutColumns].filter(Boolean);
          if (!columns.length) { changes.push({ action: "add", field, section, status: "no_columns" }); continue; }
          let exists = false;
          for (const col of columns) {
            const items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean);
            if (items.some(i => i.field === field)) { exists = true; break; }
          }
          if (exists) { changes.push({ action: "add", field, section, status: "already_present" }); continue; }
          const items = Array.isArray(columns[0].layoutItems) ? columns[0].layoutItems : [columns[0].layoutItems].filter(Boolean);
          items.push({ behavior: behavior || "Readonly", field });
          columns[0].layoutItems = items;
          changes.push({ action: "add", field, section, status: "added" });
        }
      }
      if (moveField) {
        const { field, fromSection, toSection, behavior } = moveField;
        const srcSec = sections.find(s => s.label === fromSection);
        if (srcSec) {
          const srcCols = Array.isArray(srcSec.layoutColumns) ? srcSec.layoutColumns : [srcSec.layoutColumns].filter(Boolean);
          for (const col of srcCols) {
            let items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean);
            col.layoutItems = items.filter(i => i.field !== field);
          }
        }
        const tgtSec = sections.find(s => s.label === toSection);
        if (tgtSec) {
          const tgtCols = Array.isArray(tgtSec.layoutColumns) ? tgtSec.layoutColumns : [tgtSec.layoutColumns].filter(Boolean);
          const items = Array.isArray(tgtCols[0].layoutItems) ? tgtCols[0].layoutItems : [tgtCols[0].layoutItems].filter(Boolean);
          items.push({ behavior: behavior || "Edit", field });
          tgtCols[0].layoutItems = items;
          changes.push({ action: "move", field, from: fromSection, to: toSection, status: "moved" });
        }
      }
      layout.layoutSections = sections;
      const deployResult = await conn.metadata.update("Layout", layout);
      const success = Array.isArray(deployResult) ? deployResult[0]?.success : deployResult?.success;
      sfClient.clearTargetOrg();
      res.json({ status: success ? "updated" : "failed", layoutFullName, changes, deployResult });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  console.log("Additional routes registered: /api/execute-anonymous, /api/create-formula-field, /api/update-layout");
}
