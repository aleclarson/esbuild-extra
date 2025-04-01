import { BuildExtensions, MetafileExtensions } from './types'

declare module 'esbuild' {
  interface PluginBuild extends BuildExtensions {}
  interface Metafile extends MetafileExtensions {}
}

export {}
