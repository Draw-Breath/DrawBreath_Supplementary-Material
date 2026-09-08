const configured = String(import.meta.env.BASE_URL || '/').replace(/\/$/, '');
export const basePath = configured === '/' ? '' : configured;
export const withBase = (path) => `${basePath}${path.startsWith('/') ? path : `/${path}`}`;
