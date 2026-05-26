// =============================================
// GitHub Multi-Repo Routes
// Create repos, push files to any repo under the owner
// =============================================

export function registerGitHubMultiRepoRoutes(app, ghClient) {
  if (!ghClient) {
    console.log("GitHub multi-repo routes skipped (no GH_TOKEN)");
    return;
  }

  // --- List all repos ---
  app.get("/api/github/repos", async (req, res) => {
    try {
      const repos = await ghClient.listRepos();
      if (Array.isArray(repos)) {
        res.json(repos.map(r => ({
          name: r.name, full_name: r.full_name, description: r.description,
          private: r.private, html_url: r.html_url, updated_at: r.updated_at,
        })));
      } else {
        res.json(repos);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Create a new repo ---
  app.post("/api/github/create-repo", async (req, res) => {
    try {
      const { name, description, isPrivate } = req.body;
      if (!name) return res.status(400).json({ error: "name is required" });
      const result = await ghClient.createRepo(name, description || "", isPrivate || false);
      res.json({
        status: result.id ? "created" : "error",
        name: result.name,
        full_name: result.full_name,
        html_url: result.html_url,
        clone_url: result.clone_url,
        message: result.message || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Push a file to any repo ---
  app.post("/api/github/repo/:repo/file", async (req, res) => {
    try {
      const { path, content, message } = req.body;
      if (!path || content === undefined) return res.status(400).json({ error: "path and content required" });
      const result = await ghClient.createFileInRepo(req.params.repo, path, content, message);
      res.json({ status: result.content ? "ok" : "error", path, message: result.message || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Push multiple files to any repo (batch) ---
  app.post("/api/github/repo/:repo/files", async (req, res) => {
    try {
      const { files, message } = req.body;
      if (!Array.isArray(files)) return res.status(400).json({ error: "files array required" });
      const results = [];
      for (const f of files) {
        try {
          const r = await ghClient.createFileInRepo(req.params.repo, f.path, f.content, message || `Add ${f.path}`);
          results.push({ path: f.path, status: r.content ? "ok" : "error" });
        } catch (e) {
          results.push({ path: f.path, status: "error", error: e.message });
        }
      }
      res.json({ total: files.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- List files in any repo ---
  app.get("/api/github/repo/:repo/files", async (req, res) => {
    try {
      const path = req.query.path || "";
      const files = await ghClient.listFilesInRepo(req.params.repo, path);
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Get a file from any repo ---
  app.get("/api/github/repo/:repo/file", async (req, res) => {
    try {
      const file = await ghClient.getFileFromRepo(req.params.repo, req.query.path);
      res.json(file);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log("GitHub multi-repo routes: repos, create-repo, repo/:repo/file(s)");
}
