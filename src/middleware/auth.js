// src/middleware/auth.js — JWT com role + validação de sessão no banco
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const SECRET = process.env.JWT_SECRET || 'everi9-dev-secret';

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  let decoded;
  try {
    decoded = jwt.verify(header.split(' ')[1], SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalido ou expirado', code: 'TOKEN_INVALID' });
  }
  // Validar sessão contra o banco: usuário existe + versão de sessão confere
  try {
    const result = await pool.query('SELECT id, role, session_version FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Sessao encerrada', code: 'SESSION_ENDED' });
    }
    const tokenSv = decoded.sv || 1;
    const dbSv = user.session_version || 1;
    if (tokenSv !== dbSv) {
      return res.status(401).json({ error: 'Sessao encerrada', code: 'SESSION_ENDED' });
    }
    // role sempre do banco (reflete mudanças sem precisar re-login enquanto sessão valida)
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name, role: user.role || decoded.role };
    next();
  } catch (err) {
    // Fail-open: se o banco falhar, aceita o token para nao trancar todos os usuarios
    console.error('authMiddleware DB check failed:', err.message);
    req.user = decoded;
    next();
  }
}

export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'funcional',
      sv: user.session_version || 1,
    },
    SECRET,
    { expiresIn: '8h' }
  );
}
