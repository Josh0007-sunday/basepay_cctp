import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill'
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill'
import inject from '@rollup/plugin-inject'
import * as buffer from 'buffer'

if (typeof globalThis !== 'undefined') {
  globalThis.Buffer = buffer.Buffer;
}

export default defineConfig({
  define: {
    'process.env': process.env || {},
    global: 'globalThis',
  },
  plugins: [
    react(),
    tailwindcss(),
    NodeGlobalsPolyfillPlugin({
      buffer: true,
      process: true,
    }),
    NodeModulesPolyfillPlugin(),
    inject({
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
        'process.env': '{}',
      },
    },
    include: ['buffer'],
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      process: 'process/browser',
    },
  },
  build: {
    commonjsOptions: {
      include: [/buffer/, /node_modules/],
    },
  },
})