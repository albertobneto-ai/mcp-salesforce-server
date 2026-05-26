export class GitHubClient {
  constructor(config) {
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
    this.baseUrl = "https://api.github.com";
  }

  async request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    return await res.json();
  }

  async listFiles(path = "") {
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/contents/${path}`);
    if (Array.isArray(data)) {
      return data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size, sha: f.sha }));
    }
    return data;
  }

  async getFile(path) {
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/contents/${path}`);
    if (data.content) {
      return {
        name: data.name,
        path: data.path,
        sha: data.sha,
        content: Buffer.from(data.content, "base64").toString("utf-8"),
      };
    }
    return data;
  }

  async updateFile(path, content, message, sha) {
    if (!sha) {
      const existing = await this.getFile(path).catch(() => null);
      sha = existing?.sha;
    }

    const body = {
      message: message || `Update ${path}`,
      content: Buffer.from(content).toString("base64"),
      ...(sha && { sha }),
    };

    return await this.request("PUT", `/repos/${this.owner}/${this.repo}/contents/${path}`, body);
  }

  async createFile(path, content, message) {
    return await this.updateFile(path, content, message || `Create ${path}`);
  }

  async deleteFile(path, message) {
    const existing = await this.getFile(path);
    return await this.request("DELETE", `/repos/${this.owner}/${this.repo}/contents/${path}`, {
      message: message || `Delete ${path}`,
      sha: existing.sha,
    });
  }

  async getLatestCommit() {
    const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/commits?per_page=1`);
    if (Array.isArray(data) && data.length > 0) {
      return { sha: data[0].sha, message: data[0].commit.message, date: data[0].commit.committer.date };
    }
    return null;
  }

  // ── Multi-repo support ──────────────────────────────

  async createRepo(name, description = "", isPrivate = false) {
    return await this.request("POST", "/user/repos", {
      name,
      description,
      private: isPrivate,
      auto_init: true,
    });
  }

  async listRepos() {
    return await this.request("GET", `/users/${this.owner}/repos?per_page=50&sort=updated`);
  }

  async createFileInRepo(repo, path, content, message) {
    const body = {
      message: message || `Create ${path}`,
      content: Buffer.from(content).toString("base64"),
    };
    // Check if file exists first
    const existing = await this.request("GET", `/repos/${this.owner}/${repo}/contents/${path}`).catch(() => null);
    if (existing && existing.sha) {
      body.sha = existing.sha;
    }
    return await this.request("PUT", `/repos/${this.owner}/${repo}/contents/${path}`, body);
  }

  async getFileFromRepo(repo, path) {
    const data = await this.request("GET", `/repos/${this.owner}/${repo}/contents/${path}`);
    if (data.content) {
      return {
        name: data.name,
        path: data.path,
        sha: data.sha,
        content: Buffer.from(data.content, "base64").toString("utf-8"),
      };
    }
    return data;
  }

  async listFilesInRepo(repo, path = "") {
    const data = await this.request("GET", `/repos/${this.owner}/${repo}/contents/${path}`);
    if (Array.isArray(data)) {
      return data.map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size, sha: f.sha }));
    }
    return data;
  }
}
