import { defineConfig } from 'tsdown'

/** Keep sidecar provider and guardian-process entrypoints independently loadable under plain Node.js. */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    invariant: 'lib/types/invariant.js',
    guardian: 'lib/types/guardian.js',
    host: 'lib/types/host.js',
    'macos-capsule': 'lib/types/macos-capsule.js',
    protocol: 'lib/types/protocol.js',
    supervisor: 'lib/types/supervisor.js',
    'windows-koffi': 'lib/types/windows-koffi.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
