import esbuild from 'esbuild'

type Promisable<T> = T | Promise<T>

export interface BuildExtensions extends Pick<esbuild.PluginBuild, 'onLoad'> {
  getLoader(id: string): esbuild.Loader | undefined
  isEmittedPath(id: string): boolean

  resolveLocallyFirst(
    path: string,
    options?: esbuild.ResolveOptions
  ): Promise<esbuild.ResolveResult>

  load(
    args: { path: string } & Partial<esbuild.OnLoadArgs>
  ): Promise<esbuild.OnLoadResult>

  onTransform(
    options: OnTransformOptions,
    callback: (
      args: OnTransformArgs
    ) => Promisable<OnTransformResult | null | undefined>
  ): void

  emitChunk(options: EmitChunkOptions): Promise<Chunk>
  emitFile(path: string, contents?: string | Buffer): Promise<File>

  RESOLVED_AS_FILE: 1
  RESOLVED_AS_MODULE: 2
}

export interface OnTransformOptions
  extends Omit<esbuild.OnLoadOptions, 'filter'> {
  filter?: RegExp
  loaders?: esbuild.Loader[]
  extensions?: string[]
}

export interface OnTransformArgs extends esbuild.OnLoadArgs {
  code: string
  loader: esbuild.Loader
  /** Exists if the file extension has changed. */
  initialPath?: string
}

export interface OnTransformResult {
  code?: string
  map?: any
  loader?: esbuild.Loader
  resolveDir?: string
  errors?: esbuild.Message[]
  warnings?: esbuild.Message[]
  watchFiles?: string[]
  pluginData?: Record<string, any>
}

export interface EmitChunkOptions
  extends Omit<
    esbuild.BuildOptions,
    'chunkName' | 'entryNames' | 'globalName' | 'metafile' | 'outfile'
  > {
  path: string
  contents?: string | Buffer
}

export interface Chunk extends esbuild.BuildResult {
  id: string
  path: string
  filePath: string
  metafile: esbuild.Metafile
}

export interface File extends esbuild.BuildResult {
  id: string
  path: string
  filePath: string
  metafile: esbuild.Metafile
}
