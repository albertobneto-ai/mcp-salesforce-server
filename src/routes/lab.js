import { Router } from 'express';
import { listItems, createItem, deleteItem, getItemContent } from '../lab-db.js';

const router = Router();

// Auth middleware (async wrapper)
async function auth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    var jwt = (await import('jsonwebtoken')).default;
    var decoded = jwt.verify(token, process.env.JWT_SECRET || 'everi9-secret-2026');
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// List items
router.get('/items', auth, async (req, res) => {
  try {
    var items = await listItems(req.query.category);
    res.json({ items: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create item
router.post('/items', auth, async (req, res) => {
  try {
    var b = req.body;
    if (!b.category || !b.title) return res.status(400).json({ error: 'category and title required' });
    var item = await createItem({
      category: b.category,
      title: b.title,
      description: b.description || '',
      url: b.url || '',
      file_name: b.file_name || '',
      file_type: b.file_type || '',
      file_size: b.file_size || 0,
      file_content: b.file_content || '',
      created_by: req.user.name || req.user.email || ''
    });
    res.json({ item: item });
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

// Download file content
router.get('/items/:id/content', auth, async (req, res) => {
  try {
    var item = await getItemContent(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (item.file_content) {
      var buf = Buffer.from(item.file_content, 'base64');
      res.setHeader('Content-Disposition', 'attachment; filename="' + (item.file_name || 'file') + '"');
      res.setHeader('Content-Type', item.file_type || 'application/octet-stream');
      return res.send(buf);
    }
    if (item.url) return res.json({ url: item.url });
    res.json({ item: item });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// View item metadata
router.get('/items/:id', auth, async (req, res) => {
  try {
    var item = await getItemContent(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    var result = Object.assign({}, item);
    result.has_content = !!result.file_content;
    delete result.file_content;
    res.json({ item: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
