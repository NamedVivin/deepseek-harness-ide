import { defineConfig } from 'tsdown'

const HOST_DEPENDENCY = /^(?:node:|@deepseek-ai\/)/u

/** Electron main is self-contained, while the pure Node sidecar resolves its external deploy closure. */
export default defineConfig([
  {
    entry: { main: 'lib/types/src/main.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: {
      alwaysBundle: [/^@deepseek-ai\//u],
      neverBundle: ['electron'],
    },
    dts: false,
    clean: false,
  },
  {
    entry: { sidecar: 'lib/types/src/sidecar.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: { neverBundle: [HOST_DEPENDENCY] },
    dts: false,
    clean: false,
  },
  {
    entry: { guardian: 'lib/types/src/guardian.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: { neverBundle: [HOST_DEPENDENCY] },
    dts: false,
    clean: false,
  },
  {
    entry: { preload: 'lib/types/src/preload.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: {
      alwaysBundle: [/^@deepseek-ai\//u],
      neverBundle: ['electron'],
    },
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
])
