// src/chat-app.js — Integra rotas do aichat no Express existente
// Importar este arquivo no src/index.js e chamar: mountChatApp(app)

const path     = require('path');
const express  = require('express');
const chatRoutes     = require('./routes/chat');
const authRoutes     = require('./routes/auth');
const downloadRoutes = require('./routes/download');

function mountChatApp(app) {
  // ── API Routes (aichat) ──
  app.use('/api/auth',     authRoutes);
  app.use('/api/chat',     chatRoutes);
  app.use('/api/download', downloadRoutes);

  // ── React SPA (servir build estatico) ──
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // SPA fallback — qualquer rota que nao seja /api/* serve o index.html
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const indexPath = path.join(clientDist, 'index.html');
    res.sendFile(indexPath, err => {
      if (err) res.status(404).json({ error: 'Frontend nao buildado. Rode: npm run build' });
    });
  });

  console.log('[everi9] Chat routes montadas: /api/auth, /api/chat, /api/download');
  console.log('[everi9] SPA servido de:', clientDist);
}

module.exports = mountChatApp;
