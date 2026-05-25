
import JSZip from 'jszip';

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

  // --- Deploy Formula Fields via Metadata API ZIP deploy ---
  app.post("/api/deploy-formula-fields", async (req, res) => {
    try {
      await connectToTargetOrg(req);
      const conn = sfClient.getConnection();
      const fields = Array.isArray(req.body) ? req.body : [req.body];
      
      // Build ZIP package with field XML
      const zip = new JSZip();
      
      // package.xml
      const members = fields.map(f => f.fullName).join("</members>\n        <members>");
      zip.file("package.xml", `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>${members}</members>
        <name>CustomField</name>
    </types>
    <version>59.0</version>
</Package>`);
      
      // Field XMLs
      for (const f of fields) {
        const [objName, fieldName] = f.fullName.split(".");
        const fieldXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${fieldName}</fullName>
    <label>${f.label}</label>
    <type>${f.type || "Text"}</type>
    <formula>${f.formula.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</formula>
    <formulaTreatBlanksAs>${f.formulaTreatBlanksAs || "BlankAsBlank"}</formulaTreatBlanksAs>
${f.description ? "    <description>" + f.description + "</description>" : ""}
</CustomField>`;
        zip.file(`fields/${objName}.${fieldName}.field-meta.xml`, fieldXml);
      }
      
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      
      // Deploy via Metadata API
      const deployResult = await new Promise((resolve, reject) => {
        conn.metadata.deploy(zipBuffer, { singlePackage: true })
          .complete(true, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
      });
      
      sfClient.clearTargetOrg();
      res.json({
        status: deployResult.success ? "deployed" : "failed",
        done: deployResult.done,
        numberComponentsDeployed: deployResult.numberComponentsDeployed,
        numberComponentErrors: deployResult.numberComponentErrors,
        componentFailures: deployResult.details?.componentFailures || [],
        componentSuccesses: deployResult.details?.componentSuccesses || [],
      });
    } catch (err) {
      sfClient.clearTargetOrg();
      res.status(500).json({ status: "error", message: err.message });
    }
  });

  // --- Update Layout ---
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

  console.log("Routes: /api/execute-anonymous, /api/deploy-formula-fields, /api/update-layout");
}
