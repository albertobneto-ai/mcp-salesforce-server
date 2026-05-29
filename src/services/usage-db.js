// src/services/usage-db.js — Persistencia e consulta de consumo de tokens
import pool from '../config/db.js';

// Grava todas as usages acumuladas de uma requisicao
export async function recordUsage(userId, command, pending) {
  if (!userId || !pending || !pending.length) return;
  try {
    for (const u of pending) {
      await pool.query(
        `INSERT INTO token_usage (user_id, command, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, command || null, u.model || null, u.input || 0, u.output || 0, u.cacheRead || 0, u.cacheWrite || 0]
      );
    }
  } catch (err) {
    console.error('recordUsage failed:', err.message);
  }
}

// Consumo do mes corrente de um usuario (input + output, ignorando cache-read pra ser conservador)
export async function getMonthlyUsage(userId) {
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
       FROM token_usage
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [userId]
    );
    return Number(r.rows[0]?.total || 0);
  } catch (err) {
    console.error('getMonthlyUsage failed:', err.message);
    return 0;
  }
}

// Detalhamento por usuario (admin) — mes corrente
export async function getUsageBreakdown(userId) {
  try {
    const r = await pool.query(
      `SELECT command, model,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output,
              COUNT(*) AS calls
       FROM token_usage
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())
       GROUP BY command, model
       ORDER BY SUM(input_tokens + output_tokens) DESC`,
      [userId]
    );
    return r.rows;
  } catch (err) {
    console.error('getUsageBreakdown failed:', err.message);
    return [];
  }
}
