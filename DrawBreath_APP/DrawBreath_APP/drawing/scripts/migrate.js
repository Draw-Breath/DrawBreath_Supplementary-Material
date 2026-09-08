const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../src/server/config');
const { pool } = require('../src/server/db');

async function main() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
  await pool.query(`SET search_path TO "${config.schema}", public`);
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = path.join(__dirname, '..', 'migrations');
  const filenames = fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of filenames) {
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = await pool.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [filename]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== checksum) throw new Error(`Migration changed after it was applied: ${filename}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, checksum]);
      await client.query('COMMIT');
      console.log(`Applied ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
