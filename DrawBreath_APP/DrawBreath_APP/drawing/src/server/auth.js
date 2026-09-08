const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { pool } = require('./db');
function hashPassword(value, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(String(value), salt, 64).toString('hex')}`; }
function verifyPassword(value, stored) { const [salt, expectedHex] = String(stored || '').split(':'); if (!salt || !expectedHex) return false; const actual = crypto.scryptSync(String(value), salt, 64); const expected = Buffer.from(expectedHex, 'hex'); return actual.length === expected.length && crypto.timingSafeEqual(actual, expected); }
function tokenFor(id, role, extra = {}) { return jwt.sign({ sub: id, role, ...extra }, config.jwtSecret, { expiresIn: role === 'teacher' ? '12h' : '8h' }); }
function requireRole(role) { return async (req, res, next) => { try { const raw = String(req.headers.authorization || ''); const claims = jwt.verify(raw.startsWith('Bearer ') ? raw.slice(7) : '', config.jwtSecret); if (claims.role !== role) throw new Error('role mismatch'); if (role === 'teacher') { const active = await pool.query('SELECT 1 FROM staff_users WHERE id = $1', [claims.sub]); if (!active.rowCount) throw new Error('account missing'); } if (role === 'student') { const active = await pool.query('SELECT session_version FROM participants WHERE id = $1', [claims.sub]); if (!active.rowCount || Number(active.rows[0].session_version) !== Number(claims.sessionVersion || 1)) throw new Error('session replaced'); } req.auth = claims; next(); } catch (_error) { res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); } }; }
module.exports = { hashPassword, verifyPassword, tokenFor, requireRole };
