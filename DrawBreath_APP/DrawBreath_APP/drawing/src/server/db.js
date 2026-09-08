const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.databaseUrl || undefined, options: `-c search_path=${config.schema},public`, max: 15, application_name: 'task_platform' });
pool.on('error', (error) => console.error('[database]', error.message));
module.exports = { pool, query: (...args) => pool.query(...args) };
