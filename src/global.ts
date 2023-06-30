import { BuildExtensions } from './types'

declare module 'esbuild' {
  interface PluginBuild extends BuildExtensions {}
  interface Metafile {
    watchFiles: string[]
    watchDirs: string[]
  }
}

export {}
