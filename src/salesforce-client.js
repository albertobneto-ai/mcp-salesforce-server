import jsforce from "jsforce";

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

  async deployField(conn, fieldMeta) {
    const result = await conn.metadata.upsert("CustomField", fieldMeta);
    const success = Array.isArray(result) ? result[0].success : result.success;
    if (success && fieldMeta.fullName.includes(".")) {
      const objectName = fieldMeta.fullName.split(".")[0];
      await this.grantFLS(conn, objectName, fieldMeta.fullName);
    }
    return { success, result };
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
          const { success } = await this.deployField(conn, fieldMeta);
          if (success) summary.success++; else summary.failed++;
          details.push({ type: "CustomField", fullName: field.fullName, success });
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
