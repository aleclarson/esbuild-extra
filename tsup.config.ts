import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/global.ts'],
  format: ['esm'],
  dts: true,
})
