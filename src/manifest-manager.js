import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, "..", "manifests");

export class ManifestManager {
  listManifests() {
    if (!existsSync(MANIFESTS_DIR)) {
      return { manifests: [], message: "Nenhum manifest encontrado. Diretório: " + MANIFESTS_DIR };
    }

    const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith(".json"));

    return {
      manifests: files.map((f) => {
        try {
          const content = JSON.parse(readFileSync(join(MANIFESTS_DIR, f), "utf-8"));
          return {
            fileName: f,
            specName: content.specName || f.replace(".json", ""),
            version: content.version || "unknown",
            components: this.countComponents(content),
          };
        } catch {
          return { fileName: f, error: "Erro ao ler manifest" };
        }
      }),
    };
  }

  getManifest(specName) {
    const filePath = join(MANIFESTS_DIR, `${specName}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Manifest não encontrado: ${specName}`);
    }
    return JSON.parse(readFileSync(filePath, "utf-8"));
  }

  countComponents(manifest) {
    const meta = manifest.metadata || {};
    return {
      customObjects: meta.customObjects?.length || 0,
      customFields: meta.customFields?.length || 0,
      validationRules: meta.validationRules?.length || 0,
      recordTypes: meta.recordTypes?.length || 0,
      flows: meta.flows?.length || 0,
      permissionSets: meta.permissionSets?.length || 0,
      layouts: meta.layouts?.length || 0,
    };
  }
}
