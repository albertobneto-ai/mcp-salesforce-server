// src/chat-app.js — Monta rotas do aichat no Express existente
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import downloadRoutes from './routes/download.js';
import setupRoutes from './setup.js';
import orgRoutes from './routes/orgs.js';
import conversationRoutes from './routes/conversations.js';
import packageRoutes from './routes/package.js';
import kbRoutes from './routes/kb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function mountChatApp(app) {
  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/download', downloadRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/orgs', orgRoutes);
  app.use('/api/conversations', conversationRoutes);
  app.use('/api/package', packageRoutes);
  app.use('/api/kb', kbRoutes);
  // GP: import dinâmico para isolar falhas de startup
  try {
    const { default: gpRoutes } = await import('./routes/gp.js');
    app.use('/api/gp', gpRoutes);
  } catch (e) { console.error('[GP] Rota nao carregada:', e.message); }

  // Refinamentos (Agenda de Refinamento)
  try {
    const { default: refRoutes } = await import('./routes/refinements.js');
    app.use('/api/gp/refinements', refRoutes);
  } catch (e) { console.error('[Refinements] Rota nao carregada:', e.message); }

  // Squad Agentes SF
  try {
    const { default: squadRoutes } = await import('./routes/squad.js');
    app.use('/api/squad', squadRoutes);
  } catch (e) { console.error('[Squad] Rota nao carregada:', e.message); }

  // Inventory
  try {
    const { default: inventoryRoutes } = await import('./routes/inventory.js');
    app.use('/api/inventory', inventoryRoutes);
  } catch (e) { console.error('[Inventory] Rota nao carregada:', e.message); }

  // Laboratorio
  try {
    const { default: labRoutes } = await import('./routes/lab.js');
    app.use('/api/lab', labRoutes);
  } catch (e) { console.error('[Lab] Rota nao carregada:', e.message); }

  // HF Studio (Discovery interativo + DeepSeek)
  try {
    const { default: hfStudioRoutes } = await import('./routes/hf-studio.js');
    app.use('/api/hf-studio', hfStudioRoutes);
  } catch (e) { console.error('[HF-Studio] Rota nao carregada:', e.message); }

  // Servir prototipos como HTML estatico
  const protoDir = '/tmp/prototipos';
  try { const fs = await import('fs'); fs.default.mkdirSync(protoDir, { recursive: true }); } catch {}
  app.use('/prototipos', express.static(protoDir));

  // React SPA (serve build estatico)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));

  // SPA fallback (exclui /api/ e /prototipos/)
  app.get(/^\/(?!api\/|prototipos\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'), err => {
      if (err) res.status(404).json({ error: 'Frontend nao buildado' });
    });
  });

  console.log('[everi9] Rotas montadas: /api/auth, /api/chat, /api/download, /api/setup, /api/orgs, /api/squad, /api/gp/refinements');
}
