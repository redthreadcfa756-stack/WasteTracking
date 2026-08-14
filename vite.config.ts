import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildId = new Date().toISOString();

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId),
  },
  plugins: [
    react(),
    {
      name: 'build-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify({ buildId })}\n`,
        });
      },
    },
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@firebase/firestore') || id.includes('/node_modules/firebase/firestore')) return 'firebase-firestore';
          if (id.includes('/node_modules/@firebase/auth') || id.includes('/node_modules/firebase/auth')) return 'firebase-auth';
          if (id.includes('/node_modules/@firebase/') || id.includes('/node_modules/firebase/')) return 'firebase-core';
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom')) return 'react';
          if (id.includes('/node_modules/lucide-react')) return 'icons';
          return undefined;
        },
      },
    },
  },
});
