import { Router } from 'express';
import { listItems, createItem, deleteItem, getItemContent } from '../lab-db.js';

const router = Router();

// Auth middleware (reuse from existing)
function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const jwt = await import('jsonwebtoken');
    const decoded = jwt.default.verify(token, process.env.JWT_SECRET || 'everi9-secret-2026');
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Wrapper because we use async import
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const jwt = (await import('jsonwebtoken')).default;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'everi9-secret-2026');
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// List items (optional ?category=prototipos|apresentacoes|documentacoes)
router.get('/items', auth, async (req, res) => {
  try {
    const items = await listItems(req.query.category);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create item
router.post('/items', auth, async (req, res) => {
  try {
    const { category, title, description, url, file_name, file_type, file_size, file_content } = req.body;
    if (!category || !title) return res.status(400).json({ error: 'category and title required' });
    const item = await createItem({
      category, title, description, url,
      file_name, file_type, file_size, file_content,
      created_by: req.user.name || req.user.email || ''
    });
    res.json({ item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete item
router.delete('/items/:id', auth, async (req, res) => {
  try {
    await deleteItem(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download / view item content
router.get('/items/:id/content', auth, async (req, res) => {
  try {
    const item = await getItemContent(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (item.file_content) {
      const buf = Buffer.from(item.file_content, 'base64');
      res.setHeader('Content-Disposition', 'attachment; filename="' + (item.file_name || 'file') + '"');
      res.setHeader('Content-Type', item.file_type || 'application/octet-stream');
      return res.send(buf);
    }
    if (item.url) return res.json({ url: item.url });
    res.json({ item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View (returns URL or content info without downloading)
router.get('/items/:id', auth, async (req, res) => {
  try {
    const item = await getItemContent(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    // Don't send file_content in view (too large)
    const { file_content, ...rest } = item;
    rest.has_content = !!file_content;
    res.json({ item: rest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
