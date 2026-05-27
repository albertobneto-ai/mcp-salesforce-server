// src/chat-app.js — Monta rotas do aichat no Express existente
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import downloadRoutes from './routes/download.js';
import setupRoutes from './setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function mountChatApp(app) {
  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/download', downloadRoutes);
  app.use('/api/setup', setupRoutes);

  // React SPA (serve build estatico)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // SPA fallback
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'), err => {
      if (err) res.status(404).json({ error: 'Frontend nao buildado' });
    });
  });

  console.log('[everi9] Rotas montadas: /api/auth, /api/chat, /api/download, /api/setup');
}
