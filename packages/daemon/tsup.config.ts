import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/main.ts'],
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: true,
    target: 'node20',
    outDir: 'dist',
  },
  {
    entry: ['src/modeswitch-helper.ts'],
    format: ['cjs'],
    splitting: false,
    sourcemap: true,
    dts: true,
    target: 'node20',
    outDir: 'dist',
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: ['src/ipc/client.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: true,
    dts: true,
    target: 'node20',
    outDir: 'dist/ipc',
  },
])
