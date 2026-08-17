import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-client-connection-desktop', [
  'lib/types/index.js',
  'lib/types/invariant.js',
], {
  companions: [{
    name: '@deepseek-ai/dsh-client-connection-desktop/adapter',
    entry: { adapter: 'lib/types/adapter.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }],
})
