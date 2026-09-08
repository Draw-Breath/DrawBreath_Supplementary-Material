const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');
module.exports = defineConfig({ base: process.env.VITE_BASE_PATH || '/', plugins: [react()], server: { port: 5300, proxy: { '/api': { target: 'http://localhost:3300', changeOrigin: true }, '/uploads': { target: 'http://localhost:3300', changeOrigin: true } } }, build: { outDir: 'dist', emptyOutDir: true } });
