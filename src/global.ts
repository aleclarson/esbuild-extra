import { BuildExtensions } from './types'

declare module 'esbuild' {
  interface PluginBuild extends BuildExtensions {}
}

export {}
