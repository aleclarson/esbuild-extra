import { BuildExtensions } from './types'

declare module 'esbuild' {
  interface PluginBuild extends BuildExtensions {}
  interface Metafile {
    watchFiles: Map<string, Set<string>>
    watchDirs: Map<string, Set<string>>
  }
}

export {}
