// src/routes/auth.js — Login + Registro com role
import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import { generateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Credenciais invalidas' });
    const token = generateToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role || 'funcional' } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatorios' });
    const validRoles = ['admin', 'funcional', 'developer', 'architect'];
    const userRole = validRoles.includes(role) ? role : 'funcional';
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Email ja cadastrado' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, userRole]);
    const user = result.rows[0];
    res.status(201).json({ token: generateToken(user), user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;
