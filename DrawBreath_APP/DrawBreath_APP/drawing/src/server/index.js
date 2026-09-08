const app = require('./app'); const config = require('./config'); const { pool } = require('./db');
if (!config.databaseUrl) console.warn('[configuration] DATABASE_URL is not set.');
if (config.jwtSecret.length < 32) console.warn('[configuration] JWT_SECRET should contain at least 32 characters.');
const server = app.listen(config.port, () => console.log(`${config.displayName} is running at http://localhost:${config.port}`));
const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
