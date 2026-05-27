// src/github-read.js — Leitura de arquivos via GitHub API
const express = require('express');
const router = express.Router();

router.get('/read/:path(*)', async (req, res) => {
  try {
    const owner = process.env.GH_OWNER;
    const repo = req.query.repo || process.env.GH_REPO;
    const path = req.params.path;
    const resp = await fetch(
      \`https://api.github.com/repos/\${owner}/\${repo}/contents/\${path}\`,
      { headers: { Authorization: \`Bearer \${process.env.GH_TOKEN}\`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (!resp.ok) throw new Error(\`GitHub \${resp.status}\`);
    const data = await resp.json();
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    res.json({ path, content, sha: data.sha });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
