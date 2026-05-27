// src/middleware/auth.js — JWT verification
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'everi9-dev-secret';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado' });
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    SECRET,
    { expiresIn: '8h' }
  );
}

module.exports = { authMiddleware, generateToken };
