import jsforce from "jsforce";
import JSZip from "jszip";

export class SalesforceClient {
  constructor(config) {
    this.config = config;
    this.conn = null;
    this.orgId = null;
    this.targetConn = null;
    this.orgTokens = new Map();
    this.adminPermSetCache = new Map();
    this.ghClient = null; // set externally for token persistence
  }

  setGitHubClient(ghClient) { this.ghClient = ghClient; }

  async ensureConnected() {
    if (this.conn && this.orgId) return;
    const params = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password + (this.config.securityToken || ""),
    });
    const tokenResponse = await fetch(this.config.loginUrl + "/services/oauth2/token", {
      method: "POST", body: params,
    });
    const tokenData = await tokenResponse.json();
    if (tokenData.error) throw new Error(tokenData.error + ": " + (tokenData.error_description || ""));
    this.conn = new jsforce.Connection({
      instanceUrl: tokenData.instance_url,
      accessToken: tokenData.access_token,
      version: "62.0",
    });
    this.orgId = tokenData.id.split("/")[4];
    console.log("Connected to DevHub org:", this.orgId);
  }

  getOrgId() { return this.orgId; }
  getConnection() { return this.targetConn || this.conn; }

  // --- Token persistence via GitHub ---
  storeOrgTokens(scratchOrgId, tokenData) {
    this.orgTokens.set(scratchOrgId, {
      instanceUrl: tokenData.instance_url,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      storedAt: new Date().toISOString(),
    });
    console.log(`Tokens stored for scratch org: ${scratchOrgId}`);
    this.persistTokens(); // fire-and-forget
  }

  async persistTokens() {
    if (!this.ghClient) return;
    try {
      const data = {};
      for (const [orgId, tokens] of this.orgTokens) {
        data[orgId] = tokens;
      }
      await this.ghClient.updateFile(
        "data/tokens.json",
        JSON.stringify(data, null, 2),
        "auto: persist scratch org tokens"
      );
      console.log("Tokens persisted to GitHub");
    } catch (err) {
      console.error("Failed to persist tokens:", err.message);
    }
  }

  async loadPersistedTokens() {
    if (!this.ghClient) return;
    try {
      const file = await this.ghClient.getFile("data/tokens.json");
      if (file && file.content) {
        // getFile returns content as plain text (already decoded)
        const raw = typeof file.content === "string" ? file.content : Buffer.from(file.content, "base64").toString("utf-8");
        const data = JSON.parse(raw);
        for (const [orgId, tokens] of Object.entries(data)) {
          this.orgTokens.set(orgId, tokens);
        }
        console.log(`Loaded ${Object.keys(data).length} persisted token(s) from GitHub`);
      }
    } catch (err) {
      console.log("No persisted tokens found or error:", err.message);
    }
  }

  // --- Multi-org connection ---
  async connectToScratchOrg(scratchOrgId) {
    // 1. Check stored tokens
    const stored = this.orgTokens.get(scratchOrgId);
    if (stored) {
      try {
        const testConn = new jsforce.Connection({
          instanceUrl: stored.instanceUrl, accessToken: stored.accessToken, version: "62.0",
        });
        await testConn.identity();
        this.targetConn = testConn;
        return this.targetConn;
      } catch {
        if (stored.refreshToken) {
          try {
            const r = await this.refreshOrgToken(scratchOrgId, stored);
            if (r) return r;
          } catch { /* fall through */ }
        }
        this.orgTokens.delete(scratchOrgId);
        this.persistTokens();
      }
    }

    // 2. Try AuthCode
    await this.ensureConnected();
    const result = await this.conn.query(
      `SELECT Id, ScratchOrg, OrgName, Status, LoginUrl, AuthCode, SignupUsername ` +
      `FROM ScratchOrgInfo WHERE ScratchOrg = '${scratchOrgId}' AND Status = 'Active' LIMIT 1`
    );
    if (!result.records.length) throw new Error(`Scratch org ${scratchOrgId} não encontrada ou não ativa`);
    const info = result.records[0];
    const tokenRes = await fetch(info.LoginUrl + "/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: info.AuthCode,
        client_id: "PlatformCLI", redirect_uri: "http://localhost:1717/OauthRedirect",
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      this.storeOrgTokens(scratchOrgId, tokenData);
      this.targetConn = new jsforce.Connection({
        instanceUrl: tokenData.instance_url, accessToken: tokenData.access_token, version: "62.0",
      });
      return this.targetConn;
    }
    throw new Error(`Sem tokens e AuthCode expirado para ${info.OrgName}. Login via /api/scratch-orgs/login/${info.Id} primeiro.`);
  }

  async refreshOrgToken(scratchOrgId, stored) {
    const r = await fetch(stored.instanceUrl + "/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: stored.refreshToken, client_id: "PlatformCLI",
      }),
    });
    const d = await r.json();
    if (d.access_token) {
      this.storeOrgTokens(scratchOrgId, { ...d, refresh_token: stored.refreshToken });
      this.targetConn = new jsforce.Connection({
        instanceUrl: d.instance_url, accessToken: d.access_token, version: "62.0",
      });
      return this.targetConn;
    }
    return null;
  }

  clearTargetOrg() { this.targetConn = null; }

  // --- Login + store tokens ---
  async loginToScratchOrg(scratchOrgInfoId) {
    await this.ensureConnected();
    const info = await this.getScratchOrgInfo(scratchOrgInfoId);
    if (!info || info.Status !== "Active") throw new Error("Org não está ativa");
    const tokenRes = await fetch(info.LoginUrl + "/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: info.AuthCode,
        client_id: "PlatformCLI", redirect_uri: "http://localhost:1717/OauthRedirect",
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      if (info.ScratchOrg) this.storeOrgTokens(info.ScratchOrg, tokenData);
      return {
        success: true,
        frontDoorUrl: tokenData.instance_url + "/secur/frontdoor.jsp?sid=" + tokenData.access_token,
        instanceUrl: tokenData.instance_url, scratchOrgId: info.ScratchOrg,
        orgName: info.OrgName, username: info.SignupUsername,
      };
    }
    return { success: false, error: tokenData.error_description || tokenData.error,
      loginUrl: info.LoginUrl, username: info.SignupUsername, scratchOrgId: info.ScratchOrg };
  }

  hasStoredTokens(scratchOrgId) { return this.orgTokens.has(scratchOrgId); }
  getStoredOrgs() {
    return [...this.orgTokens].map(([orgId, t]) => ({ orgId, instanceUrl: t.instanceUrl, storedAt: t.storedAt }));
  }

  // --- Auto-FLS ---
  async getAdminPermSetId(conn) {
    const key = conn.instanceUrl;
    if (this.adminPermSetCache.has(key)) return this.adminPermSetCache.get(key);
    const identity = await conn.identity();
    const user = await conn.query(`SELECT ProfileId FROM User WHERE Id = '${identity.user_id}'`);
    if (!user.records.length) return null;
    const ps = await conn.query(`SELECT Id FROM PermissionSet WHERE ProfileId = '${user.records[0].ProfileId}' AND IsOwnedByProfile = true LIMIT 1`);
    if (!ps.records.length) return null;
    this.adminPermSetCache.set(key, ps.records[0].Id);
    return ps.records[0].Id;
  }

  async grantFLS(conn, sobjectType, fieldFullName) {
    try {
      const permSetId = await this.getAdminPermSetId(conn);
      if (!permSetId) return;
      await conn.sobject("FieldPermissions").create({
        ParentId: permSetId, SobjectType: sobjectType,
        Field: fieldFullName, PermissionsRead: true, PermissionsEdit: true,
      });
    } catch (err) {
      console.log(`FLS note for ${fieldFullName}: ${err.message}`);
    }
  }

  // --- Describe ---
  async describeGlobal() { return await this.getConnection().describeGlobal(); }
  async describeObject(objectName) { return await this.getConnection().sobject(objectName).describe(); }
  async query(soql) { return await this.getConnection().query(soql); }

  // --- Metadata ---
  async deployComponent(componentType, metadata) {
    const result = await this.getConnection().metadata.upsert(componentType, metadata);
    return { success: result.success, fullName: result.fullName, errors: result.errors || [] };
  }

  async readMetadata(type, fullNames) { return await this.getConnection().metadata.read(type, fullNames); }

  async retrieveMetadata(types, objectName) {
    const results = {};
    for (const type of types) {
      try {
        const list = await this.getConnection().metadata.list([{ type }]);
        let items = Array.isArray(list) ? list : list ? [list] : [];
        if (objectName) items = items.filter(i => i.fullName.startsWith(objectName + ".") || i.fullName === objectName);
        results[type] = items.map(i => ({ fullName: i.fullName, type: i.type, lastModified: i.lastModifiedDate }));
      } catch (err) { results[type] = { error: err.message }; }
    }
    return results;
  }

  buildFieldMeta(field, parentObject) {
    const fullName = parentObject ? `${parentObject}.${field.fullName}` : field.fullName;
    return {
      fullName, label: field.label, type: field.type,
      ...(field.length != null && { length: field.length }),
      ...(field.required != null && { required: field.required }),
      ...(field.externalId != null && { externalId: field.externalId }),
      ...(field.precision != null && { precision: field.precision }),
      ...(field.scale != null && { scale: field.scale }),
      ...(field.formula != null && { formula: field.formula }),
      ...(field.formulaTreatBlanksAs != null && { formulaTreatBlanksAs: field.formulaTreatBlanksAs }),
      ...(field.description != null && { description: field.description }),
      ...(field.defaultValue != null && { defaultValue: field.defaultValue }),
      ...(field.referenceTo != null && {
        referenceTo: field.referenceTo,
        relationshipName: field.relationshipName,
        relationshipLabel: field.relationshipLabel || field.label,
      }),
      ...(field.type === "MultiselectPicklist" && { visibleLines: field.visibleLines || 4 }),
      ...(field.picklist && {
        valueSet: { valueSetDefinition: {
          value: field.picklist.map(v => ({ fullName: v, label: v, default: false })),
        }},
      }),
    };
  }

  async deployField(conn, fieldMeta, layoutConfig = null) {
    const result = await conn.metadata.upsert("CustomField", fieldMeta);
    const success = Array.isArray(result) ? result[0].success : result.success;
    let layoutResults = null;
    if (success && fieldMeta.fullName.includes(".")) {
      const objectName = fieldMeta.fullName.split(".")[0];
      await this.grantFLS(conn, objectName, fieldMeta.fullName);
      // Auto-add to page layouts
      const fieldApiName = fieldMeta.fullName.split(".")[1];
      layoutResults = await this.addFieldToLayouts(conn, objectName, fieldApiName, layoutConfig);
    }
    return { success, result, layoutResults };
  }

  /**
   * Add a field to page layouts of an object
   * @param {Object} layoutConfig - Optional: { layouts, section, newSection, newSectionColumns, column }
   *   layouts: array of layout fullNames (e.g. ["Lead-Lead Layout"]), null = all layouts
   *   section: existing section label to add field into
   *   newSection: create a new section with this label (takes priority over section)
   *   newSectionColumns: columns for new section (default 2)
   *   column: "left" or "right" (default "right")
   */
  async addFieldToLayouts(conn, objectName, fieldApiName, layoutConfig = null) {
    try {
      // 1. Find layouts
      const listResult = await conn.metadata.list([{ type: "Layout", folder: objectName }]);
      const allLayouts = Array.isArray(listResult) ? listResult : listResult ? [listResult] : [];
      let objectLayouts = allLayouts.filter(l => l.fullName.startsWith(objectName + "-"));

      // Filter to specific layouts if configured
      if (layoutConfig?.layouts?.length) {
        objectLayouts = objectLayouts.filter(l => layoutConfig.layouts.includes(l.fullName));
      }

      if (!objectLayouts.length) {
        return { success: false, reason: "no_layouts_found" };
      }

      const results = [];
      for (const layoutMeta of objectLayouts) {
        try {
          const layout = await conn.metadata.read("Layout", layoutMeta.fullName);
          if (!layout || !layout.layoutSections) continue;

          const sections = Array.isArray(layout.layoutSections) ? layout.layoutSections : [layout.layoutSections];

          // Check if field already exists
          let fieldExists = false;
          for (const section of sections) {
            const columns = Array.isArray(section.layoutColumns) ? section.layoutColumns : section.layoutColumns ? [section.layoutColumns] : [];
            for (const col of columns) {
              const items = Array.isArray(col.layoutItems) ? col.layoutItems : col.layoutItems ? [col.layoutItems] : [];
              if (items.some(item => item.field === fieldApiName)) { fieldExists = true; break; }
            }
            if (fieldExists) break;
          }
          if (fieldExists) {
            results.push({ layout: layoutMeta.fullName, status: "already_present" });
            continue;
          }

          let targetSection = null;

          // Option A: Create new section
          if (layoutConfig?.newSection) {
            const numCols = layoutConfig.newSectionColumns || 2;
            const newSec = {
              label: layoutConfig.newSection,
              detailHeading: true,
              editHeading: true,
              style: numCols === 1 ? "OneColumn" : "TwoColumnsLeftToRight",
              layoutColumns: [],
            };
            for (let i = 0; i < numCols; i++) {
              newSec.layoutColumns.push({ layoutItems: [] });
            }
            // Insert before the last section (usually CustomLinks or System Info)
            const insertIdx = Math.max(sections.length - 1, 0);
            sections.splice(insertIdx, 0, newSec);
            layout.layoutSections = sections;
            targetSection = newSec;
          }

          // Option B: Find specific section by label
          if (!targetSection && layoutConfig?.section) {
            targetSection = sections.find(s =>
              s.label && s.label.toLowerCase() === layoutConfig.section.toLowerCase()
            );
          }

          // Option C: Auto-find first suitable section
          if (!targetSection) {
            for (const section of sections) {
              const columns = Array.isArray(section.layoutColumns) ? section.layoutColumns : section.layoutColumns ? [section.layoutColumns] : [];
              if (columns.length > 0 && section.style !== "CustomLinks") {
                targetSection = section;
                if (section.label && (section.label.includes("Information") || section.label.includes("Informação"))) break;
              }
            }
          }

          if (!targetSection) {
            results.push({ layout: layoutMeta.fullName, status: "no_suitable_section" });
            continue;
          }

          // Add field to target column
          const columns = Array.isArray(targetSection.layoutColumns) ? targetSection.layoutColumns : [targetSection.layoutColumns];
          const colChoice = layoutConfig?.column === "right" ? (columns.length > 1 ? 1 : 0) : 0;
          const targetColumn = columns[colChoice];
          const items = Array.isArray(targetColumn.layoutItems) ? targetColumn.layoutItems : targetColumn.layoutItems ? [targetColumn.layoutItems] : [];
          items.push({ behavior: "Edit", field: fieldApiName });
          targetColumn.layoutItems = items;

          // Update layout
          const updateResult = await conn.metadata.update("Layout", layout);
          const updateSuccess = Array.isArray(updateResult) ? updateResult[0]?.success : updateResult?.success;
          results.push({
            layout: layoutMeta.fullName,
            section: targetSection.label,
            newSection: !!layoutConfig?.newSection,
            status: updateSuccess ? "field_added" : "update_failed",
          });
        } catch (layoutErr) {
          results.push({ layout: layoutMeta.fullName, status: "error", error: layoutErr.message });
        }
      }
      return { success: true, results };
    } catch (err) {
      console.log(`Layout update note for ${objectName}.${fieldApiName}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // --- Manifest Deploy ---
  async deployManifest(manifest, checkOnly = false) {
    const conn = this.getConnection();
    const summary = { total: 0, success: 0, failed: 0 };
    const details = [];

    if (manifest.metadata?.customObjects?.length) {
      for (const obj of manifest.metadata.customObjects) {
        summary.total++;
        try {
          const objMeta = {
            fullName: obj.fullName, label: obj.label, pluralLabel: obj.pluralLabel,
            deploymentStatus: obj.deploymentStatus || "Deployed",
            sharingModel: obj.sharingModel || "ReadWrite",
            nameField: obj.nameField || { fullName: "Name", label: "Name", type: "Text" },
          };
          const result = await conn.metadata.upsert("CustomObject", objMeta);
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) {
            summary.success++;
            details.push({ type: "CustomObject", fullName: obj.fullName, success: true });
            if (obj.fields?.length) {
              for (const field of obj.fields) {
                summary.total++;
                try {
                  const fieldMeta = this.buildFieldMeta(field, obj.fullName);
                  const { success: fSuccess } = await this.deployField(conn, fieldMeta);
                  if (fSuccess) summary.success++; else summary.failed++;
                  details.push({ type: "CustomField", fullName: fieldMeta.fullName, success: fSuccess });
                } catch (fieldErr) {
                  summary.failed++;
                  details.push({ type: "CustomField", fullName: `${obj.fullName}.${field.fullName}`, success: false, errors: [fieldErr.message] });
                }
              }
            }
          } else {
            summary.failed++;
            details.push({ type: "CustomObject", fullName: obj.fullName, success: false, errors: [result.errors || result[0]?.errors] });
          }
        } catch (objErr) {
          summary.failed++;
          details.push({ type: "CustomObject", fullName: obj.fullName, success: false, errors: [objErr.message] });
        }
      }
    }

    if (manifest.metadata?.customFields?.length) {
      for (const field of manifest.metadata.customFields) {
        summary.total++;
        try {
          const fieldMeta = this.buildFieldMeta(field);
          const layoutConfig = field.layoutConfig || null;
          const { success, layoutResults } = await this.deployField(conn, fieldMeta, layoutConfig);
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "CustomField", fullName: field.fullName, success, layoutResults: layoutResults?.results || null });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomField", fullName: field.fullName, success: false, errors: [err.message] });
        }
      }
    }

    if (manifest.metadata?.validationRules?.length) {
      for (const rule of manifest.metadata.validationRules) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("ValidationRule", {
            fullName: rule.fullName, active: rule.active !== false,
            errorConditionFormula: rule.errorConditionFormula, errorMessage: rule.errorMessage,
            ...(rule.errorDisplayField && { errorDisplayField: rule.errorDisplayField }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "ValidationRule", fullName: rule.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "ValidationRule", fullName: rule.fullName, success: false, errors: [err.message] });
        }
      }
    }

    if (manifest.metadata?.recordTypes?.length) {
      for (const rt of manifest.metadata.recordTypes) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("RecordType", {
            fullName: rt.fullName, label: rt.label, active: rt.active !== false,
            ...(rt.description && { description: rt.description }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "RecordType", fullName: rt.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "RecordType", fullName: rt.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // --- Queues & Email Templates (via ZIP deploy - async) ---
    const zipTypes = {
      queues: manifest.metadata?.queues,
      emailTemplates: manifest.metadata?.emailTemplates,
    };
    const hasZipTypes = Object.values(zipTypes).some(v => v?.length);
    if (hasZipTypes) {
      try {
        const zipManifest = {};
        if (zipTypes.queues?.length) zipManifest.queues = zipTypes.queues;
        if (zipTypes.emailTemplates?.length) zipManifest.emailTemplates = zipTypes.emailTemplates;
        const zipBuffer = await this.buildDeployPackage(zipManifest);
        const { deployId } = await this.startDeploy(zipBuffer);
        const typeNames = Object.keys(zipManifest).join(", ");
        const count = (zipManifest.queues?.length || 0) + (zipManifest.emailTemplates?.length || 0);
        summary.total += count;
        details.push({
          type: "ZipDeploy",
          components: typeNames,
          count,
          deployId,
          status: "deploying",
          checkStatusUrl: `/api/deploy-status/${deployId}`,
        });
      } catch (err) {
        const count = (zipTypes.queues?.length || 0) + (zipTypes.emailTemplates?.length || 0);
        summary.total += count;
        summary.failed += count;
        details.push({ type: "ZipDeploy", status: "error", errors: [err.message] });
      }
    }

    // --- Permission Sets ---
    if (manifest.metadata?.permissionSets?.length) {
      for (const ps of manifest.metadata.permissionSets) {
        summary.total++;
        try {
          const psMeta = {
            fullName: ps.fullName, label: ps.label || ps.fullName,
            description: ps.description || "",
            ...(ps.objectPermissions && { objectPermissions: ps.objectPermissions }),
            ...(ps.fieldPermissions && { fieldPermissions: ps.fieldPermissions }),
            ...(ps.recordTypeVisibilities && { recordTypeVisibilities: ps.recordTypeVisibilities }),
            ...(ps.tabSettings && { tabSettings: ps.tabSettings }),
            ...(ps.userPermissions && { userPermissions: ps.userPermissions }),
            ...(ps.applicationVisibilities && { applicationVisibilities: ps.applicationVisibilities }),
          };
          const result = await conn.metadata.upsert("PermissionSet", psMeta);
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "PermissionSet", fullName: ps.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "PermissionSet", fullName: ps.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // --- Custom Metadata Records ---
    if (manifest.metadata?.customMetadata?.length) {
      for (const cmd of manifest.metadata.customMetadata) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("CustomMetadata", {
            fullName: cmd.fullName, label: cmd.label,
            ...(cmd.values && { values: cmd.values }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "CustomMetadata", fullName: cmd.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomMetadata", fullName: cmd.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // --- Lightning Apps ---
    if (manifest.metadata?.customApplications?.length) {
      for (const app of manifest.metadata.customApplications) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("CustomApplication", {
            fullName: app.fullName, label: app.label,
            ...(app.description && { description: app.description }),
            formFactors: app.formFactors || ["Large"],
            navType: app.navType || "Standard", uiType: app.uiType || "Lightning",
            ...(app.tabs && { tabs: app.tabs }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "CustomApplication", fullName: app.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomApplication", fullName: app.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // --- Custom Tabs ---
    if (manifest.metadata?.customTabs?.length) {
      for (const tab of manifest.metadata.customTabs) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("CustomTab", {
            fullName: tab.fullName, label: tab.label,
            customObject: tab.customObject !== false,
            motif: tab.motif || "Custom66: Handsaw",
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "CustomTab", fullName: tab.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomTab", fullName: tab.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // --- Assignment Rules ---
    if (manifest.metadata?.assignmentRules?.length) {
      for (const ar of manifest.metadata.assignmentRules) {
        summary.total++;
        try {
          const result = await conn.metadata.upsert("AssignmentRule", {
            fullName: ar.fullName, active: ar.active !== false,
            ...(ar.ruleEntry && { ruleEntry: ar.ruleEntry }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "AssignmentRule", fullName: ar.fullName, success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "AssignmentRule", fullName: ar.fullName, success: false, errors: [err.message] });
        }
      }
    }

    return { success: summary.failed === 0, summary, details };
  }

  // --- Scratch Org Management ---
  async createScratchOrg(definition) {
    await this.ensureConnected();
    try {
      return await this.conn.sobject('ScratchOrgInfo').create({
        ConnectedAppConsumerKey: "PlatformCLI",
        ConnectedAppCallbackUrl: "http://localhost:1717/OauthRedirect",
        OrgName: definition.orgName || "MCP Scratch Org",
        Edition: definition.edition || "Developer",
        AdminEmail: this.config.username, Country: "BR",
        DurationDays: definition.durationDays || 7,
        HasSampleData: false, Description: definition.orgName || "MCP Scratch Org",
      });
    } catch (err) { throw new Error(JSON.stringify(err.data || err.message || err)); }
  }

  async listScratchOrgs() {
    await this.ensureConnected();
    const result = await this.conn.query(
      "SELECT Id, ScratchOrg, OrgName, Status, Edition, ExpirationDate, SignupUsername, LoginUrl, Description " +
      "FROM ScratchOrgInfo WHERE Status = 'Active' ORDER BY CreatedDate DESC"
    );
    return result.records;
  }

  async deleteScratchOrg(scratchOrgId) {
    await this.ensureConnected();
    return await this.conn.request({ method: "DELETE", url: `/services/data/v62.0/sobjects/ActiveScratchOrg/${scratchOrgId}` });
  }

  async getScratchOrgInfo(scratchOrgInfoId) {
    await this.ensureConnected();
    const result = await this.conn.query(
      `SELECT Id, ScratchOrg, OrgName, Status, Edition, ExpirationDate, SignupUsername, LoginUrl, AuthCode, ErrorCode ` +
      `FROM ScratchOrgInfo WHERE Id = '${scratchOrgInfoId}'`
    );
    return result.records[0];
  }

  // --- ZIP-based Deploy (Apex, Triggers, Flows) ---

  /**
   * Start a ZIP deploy via Metadata API (async - returns deployId immediately)
   * @param {Buffer} zipBuffer - ZIP file as Node.js Buffer
   * @param {Object} options - { checkOnly, testLevel, runTests }
   * @returns {Object} { deployId }
   */
  async startDeploy(zipBuffer, options = {}) {
    const conn = this.getConnection();
    const deployOptions = {
      rollbackOnError: true,
      singlePackage: true,
      checkOnly: options.checkOnly || false,
      testLevel: options.testLevel || "NoTestRun",
      ...(options.runTests && { runTests: options.runTests }),
    };

    const deployResult = await conn.metadata.deploy(zipBuffer, deployOptions);
    // deployResult has an .id property with the async deploy ID
    return { deployId: deployResult.id };
  }

  /**
   * Check status of a deploy
   * @param {string} deployId
   * @returns {Object} deploy status
   */
  async checkDeployStatus(deployId) {
    const conn = this.getConnection();
    const result = await conn.metadata.checkDeployStatus(deployId, true);
    return {
      id: deployId,
      done: result.done,
      success: result.success,
      status: result.status,
      numberComponentsDeployed: result.numberComponentsDeployed,
      numberComponentErrors: result.numberComponentErrors,
      numberComponentsTotal: result.numberComponentsTotal,
      numberTestsCompleted: result.numberTestsCompleted,
      numberTestErrors: result.numberTestErrors,
      stateDetail: result.stateDetail || null,
      componentFailures: result.done ? (result.details?.componentFailures || []) : [],
      runTestResult: result.done ? (result.details?.runTestResult || null) : null,
    };
  }

  /**
   * Deploy ZIP and wait for completion (sync - may timeout on Heroku)
   * Use startDeploy + checkDeployStatus for async approach
   */
  async deployZip(zipBuffer, options = {}) {
    const { deployId } = await this.startDeploy(zipBuffer, options);
    // Poll until done (max 120s)
    const maxWait = 120000;
    const interval = 3000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await this.checkDeployStatus(deployId);
      if (status.done) return status;
      await new Promise(r => setTimeout(r, interval));
    }
    return await this.checkDeployStatus(deployId);
  }

  /**
   * Build a ZIP package from a manifest containing Apex classes, triggers, and Flows
   * @param {Object} manifest - { apexClasses, apexTriggers, flows, apiVersion }
   * @returns {Buffer} ZIP buffer ready for deploy
   */
  async buildDeployPackage(manifest) {
    const zip = new JSZip();
    const apiVersion = manifest.apiVersion || "62.0";
    const packageTypes = [];

    // --- Apex Classes ---
    if (manifest.apexClasses?.length) {
      packageTypes.push({ name: "ApexClass", members: [] });
      for (const cls of manifest.apexClasses) {
        const name = cls.fullName || cls.name;
        // .cls file
        zip.file(`classes/${name}.cls`, cls.body);
        // .cls-meta.xml
        zip.file(`classes/${name}.cls-meta.xml`,
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
          `    <apiVersion>${cls.apiVersion || apiVersion}</apiVersion>\n` +
          `    <status>Active</status>\n` +
          `</ApexClass>`
        );
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Apex Triggers ---
    if (manifest.apexTriggers?.length) {
      packageTypes.push({ name: "ApexTrigger", members: [] });
      for (const trg of manifest.apexTriggers) {
        const name = trg.fullName || trg.name;
        zip.file(`triggers/${name}.trigger`, trg.body);
        zip.file(`triggers/${name}.trigger-meta.xml`,
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
          `    <apiVersion>${trg.apiVersion || apiVersion}</apiVersion>\n` +
          `    <status>Active</status>\n` +
          `</ApexTrigger>`
        );
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Flows ---
    if (manifest.flows?.length) {
      packageTypes.push({ name: "Flow", members: [] });
      for (const flow of manifest.flows) {
        const name = flow.fullName || flow.name;
        // Flow definition XML
        zip.file(`flows/${name}.flow-meta.xml`, flow.definition);
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- LWC (Lightning Web Components) ---
    if (manifest.lwc?.length) {
      packageTypes.push({ name: "LightningComponentBundle", members: [] });
      for (const comp of manifest.lwc) {
        const name = comp.fullName || comp.name;
        // Each LWC is a folder with files
        for (const file of comp.files) {
          zip.file(`lwc/${name}/${file.name}`, file.content);
        }
        // meta.xml
        if (!comp.files.some(f => f.name.endsWith('.js-meta.xml'))) {
          zip.file(`lwc/${name}/${name}.js-meta.xml`,
            `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
            `    <apiVersion>${comp.apiVersion || apiVersion}</apiVersion>\n` +
            `    <isExposed>${comp.isExposed !== false}</isExposed>\n` +
            (comp.targets ? `    <targets>\n${comp.targets.map(t => `        <target>${t}</target>`).join('\n')}\n    </targets>\n` : '') +
            `</LightningComponentBundle>`
          );
        }
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Aura Components ---
    if (manifest.aura?.length) {
      packageTypes.push({ name: "AuraDefinitionBundle", members: [] });
      for (const comp of manifest.aura) {
        const name = comp.fullName || comp.name;
        for (const file of comp.files) {
          zip.file(`aura/${name}/${file.name}`, file.content);
        }
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Static Resources ---
    if (manifest.staticResources?.length) {
      packageTypes.push({ name: "StaticResource", members: [] });
      for (const sr of manifest.staticResources) {
        const name = sr.fullName || sr.name;
        zip.file(`staticresources/${name}.resource`, sr.body);
        zip.file(`staticresources/${name}.resource-meta.xml`,
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
          `    <cacheControl>${sr.cacheControl || 'Public'}</cacheControl>\n` +
          `    <contentType>${sr.contentType || 'application/octet-stream'}</contentType>\n` +
          `</StaticResource>`
        );
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Queues (via ZIP) ---
    if (manifest.queues?.length) {
      packageTypes.push({ name: "Queue", members: [] });
      for (const queue of manifest.queues) {
        const name = queue.fullName || queue.name;
        const label = queue.label || name.replace(/_/g, " ");
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<Queue xmlns="http://soap.sforce.com/2006/04/metadata">\n`;
        xml += `    <name>${label}</name>\n`;
        xml += `    <doesSendEmailToMembers>${queue.doesSendEmailToMembers !== false}</doesSendEmailToMembers>\n`;
        const sobjects = Array.isArray(queue.queueSobject) ? queue.queueSobject : queue.queueSobject ? [queue.queueSobject] : [];
        for (const sobj of sobjects) {
          xml += `    <queueSobject>\n        <sobjectType>${sobj}</sobjectType>\n    </queueSobject>\n`;
        }
        xml += `</Queue>`;
        zip.file(`queues/${name}.queue`, xml);
        packageTypes[packageTypes.length - 1].members.push(name);
      }
    }

    // --- Email Templates (via ZIP) ---
    if (manifest.emailTemplates?.length) {
      packageTypes.push({ name: "EmailTemplate", members: [] });
      for (const et of manifest.emailTemplates) {
        const folder = et.folder || "unfiled$public";
        const name = et.name || et.fullName;
        const fullName = et.fullName || `${folder}/${name}`;
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">\n`;
        xml += `    <available>${et.available !== false}</available>\n`;
        xml += `    <encodingKey>${et.encodingKey || 'UTF-8'}</encodingKey>\n`;
        xml += `    <name>${name}</name>\n`;
        xml += `    <subject>${et.subject || ''}</subject>\n`;
        xml += `    <type>${et.type || 'text'}</type>\n`;
        xml += `    <style>${et.style || (et.type === 'html' ? 'freeForm' : 'none')}</style>\n`;
        if (et.description) xml += `    <description>${et.description}</description>\n`;
        xml += `</EmailTemplate>`;
        zip.file(`email/${folder}/${name}.email`, et.body || "");
        zip.file(`email/${folder}/${name}.email-meta.xml`, xml);
        packageTypes[packageTypes.length - 1].members.push(fullName);
      }
    }

    // --- Build package.xml ---
    let packageXml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    packageXml += `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n`;
    for (const pt of packageTypes) {
      packageXml += `    <types>\n`;
      for (const member of pt.members) {
        packageXml += `        <members>${member}</members>\n`;
      }
      packageXml += `        <name>${pt.name}</name>\n`;
      packageXml += `    </types>\n`;
    }
    packageXml += `    <version>${apiVersion}</version>\n`;
    packageXml += `</Package>`;

    zip.file("package.xml", packageXml);

    // Generate buffer
    return await zip.generateAsync({ type: "nodebuffer" });
  }

  /**
   * High-level: build ZIP from manifest and deploy
   * @param {Object} manifest - manifest with apexClasses, apexTriggers, flows, lwc, etc.
   * @param {Object} options - { checkOnly, testLevel, runTests }
   */
  async deployCodeManifest(manifest, options = {}) {
    const zipBuffer = await this.buildDeployPackage(manifest);
    return await this.deployZip(zipBuffer, options);
  }

  // --- Destructive Deploy / Reset Org ---

  // Standard objects to scan for custom fields
  static STANDARD_OBJECTS_TO_SCAN = [
    "Lead", "Account", "Contact", "Opportunity", "Case", "Order",
    "Product2", "Pricebook2", "PricebookEntry", "Quote", "QuoteLineItem",
    "Contract", "Asset", "Campaign", "CampaignMember", "Task", "Event",
    "OpportunityLineItem", "OrderItem", "Solution",
  ];

  /**
   * Scan the org for all custom metadata (objects, fields, validation rules, record types)
   * Returns a destructive manifest ready for destructiveDeploy()
   */
  async scanCustomMetadata() {
    const conn = this.getConnection();
    const scan = {
      customObjects: [],
      customFields: [],
      validationRules: [],
      recordTypes: [],
    };

    // 1. Custom Objects
    const globalDesc = await conn.describeGlobal();
    const customObjs = globalDesc.sobjects
      .filter(s => s.custom && s.name.endsWith("__c") && !s.name.includes("__mdt") && !s.name.includes("__e") && !s.name.includes("__b"))
      .map(s => s.name);
    scan.customObjects = customObjs;

    // 2. Custom Fields on standard objects
    for (const objName of SalesforceClient.STANDARD_OBJECTS_TO_SCAN) {
      try {
        const desc = await conn.sobject(objName).describe();
        const customFields = desc.fields
          .filter(f => f.custom && f.name.endsWith("__c"))
          .map(f => `${objName}.${f.name}`);
        scan.customFields.push(...customFields);
      } catch {
        // Object may not exist in this edition, skip
      }
    }

    // 3. Validation Rules via Tooling API
    try {
      const vrResult = await conn.request({
        method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" +
          encodeURIComponent("SELECT Id, ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule WHERE ManageableState = 'unmanaged'"),
      });
      if (vrResult.records) {
        scan.validationRules = vrResult.records.map(r => ({
          fullName: `${r.EntityDefinition.QualifiedApiName}.${r.ValidationName}`,
          id: r.Id,
          active: r.Active,
        }));
      }
    } catch {
      // Tooling API may not be available, skip
    }

    // 4. Custom Record Types via Tooling API
    try {
      const rtResult = await conn.request({
        method: "GET",
        url: "/services/data/v62.0/tooling/query/?q=" +
          encodeURIComponent("SELECT Id, DeveloperName, SobjectType, IsActive FROM RecordType WHERE ManageableState = 'unmanaged' AND IsPersonType = false"),
      });
      if (rtResult.records) {
        scan.recordTypes = rtResult.records.map(r => ({
          fullName: `${r.SobjectType}.${r.DeveloperName}`,
          id: r.Id,
          active: r.IsActive,
        }));
      }
    } catch {
      // Skip if not available
    }

    return scan;
  }

  /**
   * Execute destructive deploy - deletes components from the org
   * @param {Object} destructiveManifest - { customObjects, customFields, validationRules, recordTypes }
   * @param {boolean} dryRun - if true, only returns what would be deleted
   */
  async destructiveDeploy(destructiveManifest, dryRun = false) {
    const conn = this.getConnection();
    const summary = { total: 0, success: 0, failed: 0, skipped: 0 };
    const details = [];

    if (dryRun) {
      return {
        dryRun: true,
        wouldDelete: {
          customObjects: destructiveManifest.customObjects?.length || 0,
          customFields: destructiveManifest.customFields?.length || 0,
          validationRules: destructiveManifest.validationRules?.length || 0,
          recordTypes: destructiveManifest.recordTypes?.length || 0,
        },
        manifest: destructiveManifest,
      };
    }

    // ORDER MATTERS: VRs → RTs → Fields on std objects → Custom Objects

    // 1. Delete Validation Rules (they may reference custom fields)
    if (destructiveManifest.validationRules?.length) {
      for (const vr of destructiveManifest.validationRules) {
        summary.total++;
        const fullName = typeof vr === "string" ? vr : vr.fullName;
        try {
          // First deactivate, then delete
          try {
            await conn.metadata.update("ValidationRule", {
              fullName,
              active: false,
              errorConditionFormula: "false",
              errorMessage: "to be deleted",
            });
          } catch { /* may fail if already inactive */ }
          const result = await conn.metadata.delete("ValidationRule", fullName);
          const success = Array.isArray(result) ? result[0]?.success : result?.success;
          if (success) { summary.success++; } else { summary.failed++; }
          details.push({ type: "ValidationRule", fullName, action: "deleted", success: !!success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "ValidationRule", fullName, action: "delete_failed", error: err.message });
        }
      }
    }

    // 2. Delete Record Types
    if (destructiveManifest.recordTypes?.length) {
      for (const rt of destructiveManifest.recordTypes) {
        summary.total++;
        const fullName = typeof rt === "string" ? rt : rt.fullName;
        try {
          const result = await conn.metadata.delete("RecordType", fullName);
          const success = Array.isArray(result) ? result[0]?.success : result?.success;
          if (success) { summary.success++; } else { summary.failed++; }
          details.push({ type: "RecordType", fullName, action: "deleted", success: !!success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "RecordType", fullName, action: "delete_failed", error: err.message });
        }
      }
    }

    // 3. Delete Custom Fields on standard objects
    if (destructiveManifest.customFields?.length) {
      for (const field of destructiveManifest.customFields) {
        summary.total++;
        const fullName = typeof field === "string" ? field : field.fullName;
        try {
          const result = await conn.metadata.delete("CustomField", fullName);
          const success = Array.isArray(result) ? result[0]?.success : result?.success;
          if (success) { summary.success++; } else { summary.failed++; }
          details.push({ type: "CustomField", fullName, action: "deleted", success: !!success });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomField", fullName, action: "delete_failed", error: err.message });
        }
      }
    }

    // 4. Delete Custom Objects (deletes their fields automatically)
    if (destructiveManifest.customObjects?.length) {
      for (const obj of destructiveManifest.customObjects) {
        summary.total++;
        const fullName = typeof obj === "string" ? obj : obj.fullName;
        try {
          // Try metadata.delete first
          const result = await conn.metadata.delete("CustomObject", [fullName]);
          const item = Array.isArray(result) ? result[0] : result;
          if (item?.success) {
            summary.success++;
            details.push({ type: "CustomObject", fullName, action: "deleted", success: true });
          } else {
            // Metadata API failed — try Tooling API fallback
            const errMsg = item?.errors ? JSON.stringify(item.errors) : "metadata.delete returned false";
            try {
              const devName = fullName.replace("__c", "");
              const query = await conn.request({
                method: "GET",
                url: "/services/data/v62.0/tooling/query/?q=" +
                  encodeURIComponent(`SELECT Id FROM CustomObject WHERE DeveloperName='${devName}'`),
              });
              if (query.records?.length) {
                await conn.request({
                  method: "DELETE",
                  url: `/services/data/v62.0/tooling/sobjects/CustomObject/${query.records[0].Id}`,
                });
                summary.success++;
                details.push({ type: "CustomObject", fullName, action: "deleted_via_tooling", success: true });
              } else {
                summary.failed++;
                details.push({ type: "CustomObject", fullName, action: "delete_failed", success: false, error: errMsg, fallback: "object_not_found_in_tooling" });
              }
            } catch (toolingErr) {
              summary.failed++;
              details.push({ type: "CustomObject", fullName, action: "delete_failed", success: false, error: errMsg, fallbackError: toolingErr.message });
            }
          }
        } catch (err) {
          // Primary exception — try Tooling API fallback
          try {
            const devName = fullName.replace("__c", "");
            const query = await conn.request({
              method: "GET",
              url: "/services/data/v62.0/tooling/query/?q=" +
                encodeURIComponent(`SELECT Id FROM CustomObject WHERE DeveloperName='${devName}'`),
            });
            if (query.records?.length) {
              await conn.request({
                method: "DELETE",
                url: `/services/data/v62.0/tooling/sobjects/CustomObject/${query.records[0].Id}`,
              });
              summary.success++;
              details.push({ type: "CustomObject", fullName, action: "deleted_via_tooling", success: true });
            } else {
              summary.failed++;
              details.push({ type: "CustomObject", fullName, action: "delete_failed", error: err.message });
            }
          } catch (toolingErr) {
            summary.failed++;
            details.push({ type: "CustomObject", fullName, action: "delete_failed", error: err.message, fallbackError: toolingErr.message });
          }
        }
      }
    }

    return { success: summary.failed === 0, summary, details };
  }

  // --- Mock Data ---
  async insertRecords(objectName, records) {
    const conn = this.getConnection();
    const results = [];
    for (const record of records) {
      try {
        const result = await conn.sobject(objectName).create(record);
        results.push({ success: result.success, id: result.id, errors: result.errors || [] });
      } catch (err) {
        results.push({ success: false, id: null, errors: [err.message] });
      }
    }
    const successCount = results.filter(r => r.success).length;
    return { objectName, total: records.length, success: successCount, failed: records.length - successCount, records: results };
  }
}
