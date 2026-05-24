import jsforce from "jsforce";

export class SalesforceClient {
  constructor(config) {
    this.config = config;
    this.conn = null;
    this.orgId = null;
    this.targetConn = null;
  }

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
      method: "POST",
      body: params,
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      throw new Error(tokenData.error + ": " + (tokenData.error_description || ""));
    }

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

  // --- Connect to a specific scratch org ---
  async connectToOrg(instanceUrl, accessToken) {
    this.targetConn = new jsforce.Connection({
      instanceUrl,
      accessToken,
      version: "62.0",
    });
    return this.targetConn;
  }

  clearTargetOrg() {
    this.targetConn = null;
  }

  // --- Describe ---
  async describeGlobal() { return await this.getConnection().describeGlobal(); }
  async describeObject(objectName) { return await this.getConnection().sobject(objectName).describe(); }
  async query(soql) { return await this.getConnection().query(soql); }

  // --- Metadata CRUD ---
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
        if (objectName) {
          items = items.filter(i => i.fullName.startsWith(objectName + ".") || i.fullName === objectName);
        }
        results[type] = items.map(i => ({ fullName: i.fullName, type: i.type, lastModified: i.lastModifiedDate }));
      } catch (err) { results[type] = { error: err.message }; }
    }
    return results;
  }

  // --- Build field metadata (with scale:0 fix) ---
  buildFieldMeta(field, parentObject) {
    const fullName = parentObject ? `${parentObject}.${field.fullName}` : field.fullName;
    return {
      fullName,
      label: field.label,
      type: field.type,
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
        valueSet: {
          valueSetDefinition: {
            value: field.picklist.map(v => ({ fullName: v, label: v, default: false })),
          },
        },
      }),
    };
  }

  // --- Manifest Deploy ---
  async deployManifest(manifest, checkOnly = false) {
    const conn = this.getConnection();
    const summary = { total: 0, success: 0, failed: 0 };
    const details = [];

    // 1. Custom Objects
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
                  const fResult = await conn.metadata.upsert("CustomField", fieldMeta);
                  const fSuccess = Array.isArray(fResult) ? fResult[0].success : fResult.success;
                  if (fSuccess) summary.success++; else summary.failed++;
                  details.push({
                    type: "CustomField", fullName: fieldMeta.fullName, success: fSuccess,
                    errors: fSuccess ? [] : [fResult.errors || fResult[0]?.errors],
                  });
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

    // 2. Custom Fields on existing objects
    if (manifest.metadata?.customFields?.length) {
      for (const field of manifest.metadata.customFields) {
        summary.total++;
        try {
          const fieldMeta = this.buildFieldMeta(field);
          const result = await conn.metadata.upsert("CustomField", fieldMeta);
          const success = Array.isArray(result) ? result[0].success : result.success;
          if (success) summary.success++; else summary.failed++;
          details.push({
            type: "CustomField", fullName: field.fullName, success,
            errors: success ? [] : [result.errors || result[0]?.errors],
          });
        } catch (err) {
          summary.failed++;
          details.push({ type: "CustomField", fullName: field.fullName, success: false, errors: [err.message] });
        }
      }
    }

    // 3. Validation Rules
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

    // 4. Record Types
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
    const result = await this.conn.request({
      method: "POST",
      url: "/services/data/v62.0/sobjects/ScratchOrgInfo",
      body: JSON.stringify({
        ConnectedAppConsumerKey: this.config.clientId,
        AdminEmail: this.config.username,
        Country: "BR",
        Edition: definition.edition || "Developer",
        Description: definition.orgName || "MCP Scratch Org",
        DurationDays: definition.durationDays || 7,
        Features: definition.features?.join(";") || "",
        HasSampleData: false,
        OrgName: definition.orgName || "MCP Scratch Org",
        Namespace: definition.namespace || "",
      }),
      headers: { "Content-Type": "application/json" },
    });
    return result;
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
    const result = await this.conn.request({
      method: "DELETE",
      url: `/services/data/v62.0/sobjects/ActiveScratchOrg/${scratchOrgId}`,
    });
    return result;
  }

  async getScratchOrgInfo(scratchOrgInfoId) {
    await this.ensureConnected();
    const result = await this.conn.query(
      `SELECT Id, ScratchOrg, OrgName, Status, Edition, ExpirationDate, SignupUsername, LoginUrl, AuthCode, ErrorCode ` +
      `FROM ScratchOrgInfo WHERE Id = '${scratchOrgInfoId}'`
    );
    return result.records[0];
  }
}
