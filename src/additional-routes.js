
// Additional Routes: Execute Anonymous Apex + Layout Manipulation
// Added by Claude for CRM B2B Algar Telecom

export function registerAdditionalRoutes(app, sfClient, connectToTargetOrg) {

  // --- Execute Anonymous Apex ---
  app.post("/api/execute-anonymous", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { code } = req.body;
      if (!code) return res.status(400).json({ status: "error", message: "Missing 'code' in body" });
      
      const result = await conn.tooling.executeAnonymous(code);
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

  // --- Update Layout: add/move fields in a section ---
  app.post("/api/update-layout", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const { layoutFullName, addFields, removeFields, moveField } = req.body;
      
      if (!layoutFullName) return res.status(400).json({ status: "error", message: "Missing layoutFullName" });

      // Read current layout
      const layout = await conn.metadata.read("Layout", layoutFullName);
      if (!layout || !layout.fullName) {
        sfClient.clearTargetOrg();
        return res.status(404).json({ status: "error", message: "Layout not found: " + layoutFullName });
      }

      const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections].filter(Boolean);
      const changes = [];

      // ADD FIELDS to a section
      if (addFields && Array.isArray(addFields)) {
        for (const add of addFields) {
          const { field, section, behavior } = add;
          const targetSection = sections.find(s => s.label === section);
          if (!targetSection) {
            changes.push({ action: "add", field, section, status: "section_not_found" });
            continue;
          }
          const columns = Array.isArray(targetSection.layoutColumns) ? targetSection.layoutColumns : [targetSection.layoutColumns].filter(Boolean);
          if (!columns.length) {
            changes.push({ action: "add", field, section, status: "no_columns" });
            continue;
          }
          // Check if field already exists
          let exists = false;
          for (const col of columns) {
            const items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean);
            if (items.some(i => i.field === field)) { exists = true; break; }
          }
          if (exists) {
            changes.push({ action: "add", field, section, status: "already_present" });
            continue;
          }
          // Add to first column
          const items = Array.isArray(columns[0].layoutItems) ? columns[0].layoutItems : [columns[0].layoutItems].filter(Boolean);
          items.push({ behavior: behavior || "Readonly", field });
          columns[0].layoutItems = items;
          changes.push({ action: "add", field, section, status: "added", behavior: behavior || "Readonly" });
        }
      }

      // MOVE FIELD between sections
      if (moveField) {
        const { field, fromSection, toSection, behavior } = moveField;
        // Remove from source
        const srcSec = sections.find(s => s.label === fromSection);
        if (srcSec) {
          const srcCols = Array.isArray(srcSec.layoutColumns) ? srcSec.layoutColumns : [srcSec.layoutColumns].filter(Boolean);
          for (const col of srcCols) {
            let items = Array.isArray(col.layoutItems) ? col.layoutItems : [col.layoutItems].filter(Boolean);
            col.layoutItems = items.filter(i => i.field !== field);
          }
        }
        // Add to target
        const tgtSec = sections.find(s => s.label === toSection);
        if (tgtSec) {
          const tgtCols = Array.isArray(tgtSec.layoutColumns) ? tgtSec.layoutColumns : [tgtSec.layoutColumns].filter(Boolean);
          const items = Array.isArray(tgtCols[0].layoutItems) ? tgtCols[0].layoutItems : [tgtCols[0].layoutItems].filter(Boolean);
          items.push({ behavior: behavior || "Edit", field });
          tgtCols[0].layoutItems = items;
          changes.push({ action: "move", field, from: fromSection, to: toSection, status: "moved" });
        } else {
          changes.push({ action: "move", field, status: "target_section_not_found" });
        }
      }

      // Deploy updated layout
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

  console.log("Additional routes registered: /api/execute-anonymous, /api/update-layout");
}
