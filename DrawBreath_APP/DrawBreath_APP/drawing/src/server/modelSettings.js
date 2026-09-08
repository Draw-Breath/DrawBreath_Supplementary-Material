const crypto = require('crypto');
const config = require('./config');
const { pool } = require('./db');
const key = crypto.createHash('sha256').update(config.jwtSecret).digest();
function encrypt(value) { if (!value) return ''; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.'); }
function decrypt(value) { if (!value) return ''; const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64url')); const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'); }
async function runtimeModel(ownerId) { const result = await pool.query('SELECT * FROM model_nodes WHERE owner_id = $1 AND enabled = true ORDER BY priority, created_at, id LIMIT 1', [ownerId]); if (!result.rowCount) return { apiKey: config.aiApiKey, baseUrl: config.aiBaseUrl, model: config.aiModel, nodeId: '', source: 'environment' }; const row = result.rows[0]; return { apiKey: decrypt(row.encrypted_api_key), baseUrl: row.base_url.replace(/\/$/, ''), model: row.model_name, nodeId: row.id, source: 'model-node' }; }
module.exports = { decrypt, encrypt, runtimeModel };
