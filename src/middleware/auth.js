// src/middleware/auth.js — JWT com role
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'everi9-dev-secret';

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role || 'funcional' },
    SECRET,
    { expiresIn: '8h' }
  );
}
