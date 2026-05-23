import jsforce from "jsforce";

export class SalesforceClient {
  constructor(config) {
    this.config = config;
    this.conn = null;
    this.orgId = null;
  }

  async ensureConnected() {
    if (this.conn && this.orgId) return;

    this.conn = new jsforce.Connection({
      loginUrl: this.config.loginUrl,
      version: "62.0",
    });

    await this.conn.login(
      this.config.username,
      this.config.password + (this.config.securityToken || "")
    );

    this.orgId = this.conn.userInfo.organizationId;
    console.log(`Connected to Salesforce org: ${this.orgId}`);
  }

  getOrgId() {
    return this.orgId;
  }

  // --- Describe ---

  async describeGlobal() {
    return await this.conn.describeGlobal();
  }

  async describeObject(objectName) {
    return await this.conn.sobject(objectName).describe();
  }

  // --- SOQL ---

  async query(soql) {
    return await this.conn.query(soql);
  }

  // --- Metadata CRUD ---

  async deployComponent(componentType, metadata) {
    const result = await this.conn.metadata.upsert(componentType, metadata);
    return {
      success: result.success,
      fullName: result.fullName,
      errors: result.errors || [],
    };
  }

  async readMetadata(type, fullNames) {
    return await this.conn.metadata.read(type, fullNames);
  }

  async retrieveMetadata(types, objectName) {
    const results = {};

    for (const type of types) {
      try {
        const list = await this.conn.metadata.list([{ type }]);
        let items = Array.isArray(list) ? list : list ? [list] : [];

        if (objectName) {
          items = items.filter(
            (i) =>
              i.fullName.startsWith(objectName + ".") ||
              i.fullName === objectName
          );
        }

        results[type] = items.map((i) => ({
          fullName: i.fullName,
          type: i.type,
          lastModified: i.lastModifiedDate,
        }));
      } catch (err) {
        results[type] = { error: err.message };
      }
    }

    return results;
  }

  // --- Manifest Deploy ---

  async deployManifest(manifest, checkOnly = false) {
    const summary = {
      total: 0,
      success: 0,
      failed: 0,
    };
    const details = [];

    // 1. Custom Objects
    if (manifest.metadata?.customObjects?.length) {
      for (const obj of manifest.metadata.customObjects) {
        summary.total++;
        try {
          // Create object first (without fields)
          const objMeta = {
            fullName: obj.fullName,
            label: obj.label,
            pluralLabel: obj.pluralLabel,
            deploymentStatus: obj.deploymentStatus || "Deployed",
            sharingModel: obj.sharingModel || "ReadWrite",
            nameField: obj.nameField || {
              fullName: "Name",
              label: "Name",
              type: "Text",
            },
          };

          const result = await this.conn.metadata.upsert("CustomObject", objMeta);
          const success = Array.isArray(result) ? result[0].success : result.success;

          if (success) {
            summary.success++;
            details.push({ type: "CustomObject", fullName: obj.fullName, success: true });

            // Now create fields for this object
            if (obj.fields?.length) {
              for (const field of obj.fields) {
                summary.total++;
                try {
                  const fieldMeta = {
                    fullName: `${obj.fullName}.${field.fullName}`,
                    label: field.label,
                    type: field.type,
                    ...(field.length && { length: field.length }),
                    ...(field.required && { required: field.required }),
                    ...(field.externalId && { externalId: field.externalId }),
                    ...(field.formula && { formula: field.formula }),
                    ...(field.formulaTreatBlanksAs && {
                      formulaTreatBlanksAs: field.formulaTreatBlanksAs,
                    }),
                    ...(field.referenceTo && { referenceTo: field.referenceTo }),
                    ...(field.relationshipName && {
                      relationshipName: field.relationshipName,
                    }),
                    ...(field.precision && { precision: field.precision }),
                    ...(field.scale && { scale: field.scale }),
                    ...(field.picklist && {
                      valueSet: {
                        valueSetDefinition: {
                          value: field.picklist.map((v) => ({
                            fullName: v,
                            label: v,
                            default: false,
                          })),
                        },
                      },
                    }),
                  };

                  const fResult = await this.conn.metadata.upsert(
                    "CustomField",
                    fieldMeta
                  );
                  const fSuccess = Array.isArray(fResult)
                    ? fResult[0].success
                    : fResult.success;

                  if (fSuccess) {
                    summary.success++;
                  } else {
                    summary.failed++;
                  }
                  details.push({
                    type: "CustomField",
                    fullName: fieldMeta.fullName,
                    success: fSuccess,
                    errors: fSuccess ? [] : [fResult.errors || fResult[0]?.errors],
                  });
                } catch (fieldErr) {
                  summary.failed++;
                  details.push({
                    type: "CustomField",
                    fullName: `${obj.fullName}.${field.fullName}`,
                    success: false,
                    errors: [fieldErr.message],
                  });
                }
              }
            }
          } else {
            summary.failed++;
            details.push({
              type: "CustomObject",
              fullName: obj.fullName,
              success: false,
              errors: [result.errors || result[0]?.errors],
            });
          }
        } catch (objErr) {
          summary.failed++;
          details.push({
            type: "CustomObject",
            fullName: obj.fullName,
            success: false,
            errors: [objErr.message],
          });
        }
      }
    }

    // 2. Custom Fields on Standard Objects
    if (manifest.metadata?.customFields?.length) {
      for (const field of manifest.metadata.customFields) {
        summary.total++;
        try {
          const fieldMeta = {
            fullName: field.fullName,
            label: field.label,
            type: field.type,
            ...(field.length && { length: field.length }),
            ...(field.required && { required: field.required }),
            ...(field.formula && { formula: field.formula }),
            ...(field.formulaTreatBlanksAs && {
              formulaTreatBlanksAs: field.formulaTreatBlanksAs,
            }),
            ...(field.description && { description: field.description }),
            ...(field.precision && { precision: field.precision }),
            ...(field.scale && { scale: field.scale }),
            ...(field.externalId && { externalId: field.externalId }),
            ...(field.picklist && {
              valueSet: {
                valueSetDefinition: {
                  value: field.picklist.map((v) => ({
                    fullName: v,
                    label: v,
                    default: false,
                  })),
                },
              },
            }),
          };

          const result = await this.conn.metadata.upsert("CustomField", fieldMeta);
          const success = Array.isArray(result) ? result[0].success : result.success;

          if (success) {
            summary.success++;
          } else {
            summary.failed++;
          }
          details.push({
            type: "CustomField",
            fullName: field.fullName,
            success,
            errors: success ? [] : [result.errors || result[0]?.errors],
          });
        } catch (err) {
          summary.failed++;
          details.push({
            type: "CustomField",
            fullName: field.fullName,
            success: false,
            errors: [err.message],
          });
        }
      }
    }

    // 3. Validation Rules
    if (manifest.metadata?.validationRules?.length) {
      for (const rule of manifest.metadata.validationRules) {
        summary.total++;
        try {
          const result = await this.conn.metadata.upsert("ValidationRule", {
            fullName: rule.fullName,
            active: rule.active !== false,
            errorConditionFormula: rule.errorConditionFormula,
            errorMessage: rule.errorMessage,
            ...(rule.errorDisplayField && {
              errorDisplayField: rule.errorDisplayField,
            }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;

          if (success) summary.success++;
          else summary.failed++;
          details.push({
            type: "ValidationRule",
            fullName: rule.fullName,
            success,
          });
        } catch (err) {
          summary.failed++;
          details.push({
            type: "ValidationRule",
            fullName: rule.fullName,
            success: false,
            errors: [err.message],
          });
        }
      }
    }

    // 4. Record Types
    if (manifest.metadata?.recordTypes?.length) {
      for (const rt of manifest.metadata.recordTypes) {
        summary.total++;
        try {
          const result = await this.conn.metadata.upsert("RecordType", {
            fullName: rt.fullName,
            label: rt.label,
            active: rt.active !== false,
            ...(rt.description && { description: rt.description }),
          });
          const success = Array.isArray(result) ? result[0].success : result.success;

          if (success) summary.success++;
          else summary.failed++;
          details.push({
            type: "RecordType",
            fullName: rt.fullName,
            success,
          });
        } catch (err) {
          summary.failed++;
          details.push({
            type: "RecordType",
            fullName: rt.fullName,
            success: false,
            errors: [err.message],
          });
        }
      }
    }

    return {
      success: summary.failed === 0,
      summary,
      details,
    };
  }
}
