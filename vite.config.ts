import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss(), cloudflare()],
      // Keep the build single-page-only.  The offline license-admin utility is
      // deliberately not an application entry point and must never be deployed
      // with the customer-facing static assets.
      build: {
        rollupOptions: {
          input: path.resolve(__dirname, 'index.html'),
          output: {
            manualChunks(id) {
              if (id.includes('@google/genai') || id.includes('protobufjs')) return 'ai-sdk';
              if (id.includes('react-dom') || id.includes('/react/')) return 'react-vendor';
            },
          },
        },
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
});
