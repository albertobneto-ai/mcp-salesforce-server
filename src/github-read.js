// src/github-read.js — Endpoint para ler conteudo de arquivos do GitHub
module.exports = function(app, octokit, owner, repo) {
  app.get('/api/github/read/:path(*)', async (req, res) => {
    try {
      const filePath = req.params.path;
      const targetRepo = req.query.repo || repo;
      const { data } = await octokit.repos.getContent({
        owner,
        repo: targetRepo,
        path: filePath,
      });
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      res.json({ path: filePath, content, sha: data.sha });
    } catch (err) {
      res.status(404).json({ error: 'Arquivo nao encontrado', detail: err.message });
    }
  });
};
