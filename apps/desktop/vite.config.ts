import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite'
import webConfig from '../web/vite.config.ts'

const root = fileURLToPath(new URL('.', import.meta.url))

/** Build the same shell kernel for a relative, signed custom-protocol origin. */
export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const shared = typeof webConfig === 'function' ? await webConfig(env) : await webConfig
  return mergeConfig(shared, {
    root,
    base: './',
    publicDir: false,
    build: {
      outDir: 'renderer',
      emptyOutDir: true,
      sourcemap: false,
    },
  })
})
