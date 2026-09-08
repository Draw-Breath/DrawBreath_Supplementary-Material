const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
module.exports = {
  port: Math.max(1, Number(process.env.PORT) || 3300),
  databaseUrl: String(process.env.DATABASE_URL || ''),
  schema: String(process.env.PGSCHEMA || 'task_platform').replace(/[^a-zA-Z0-9_]/g, '') || 'task_platform',
  jwtSecret: String(process.env.JWT_SECRET || 'development-only-secret-change-me'),
  teacherUsername: String(process.env.TEACHER_USERNAME || 'teacher'),
  teacherPassword: String(process.env.TEACHER_PASSWORD || 'change-me'),
  teacherDisplayName: String(process.env.TEACHER_DISPLAY_NAME || 'Teacher'),
  displayName: String(process.env.APP_DISPLAY_NAME || 'DrawBreath'),
  homeUrl: String(process.env.APP_HOME_URL || 'http://localhost:3100'),
  basePath: `/${String(process.env.APP_BASE_PATH || '').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, ''),
  uploadRoot: path.resolve(String(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'storage', 'uploads'))),
  aiApiKey: String(process.env.OPENAI_API_KEY || ''),
  aiBaseUrl: String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  aiModel: String(process.env.OPENAI_MODEL || 'gpt-5.5')
};
