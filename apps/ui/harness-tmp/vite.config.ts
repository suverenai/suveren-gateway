import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: { alias: [{ find: /^(\.\.\/)+contexts\/AuthContext$/, replacement: path.resolve(__dirname, 'auth-stub.tsx') }] },
  server: { port: 5877, strictPort: true, fs: { allow: ['../..', '../../../..'] } },
});
