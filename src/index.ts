import * as crypto from 'crypto'
import enhancedResolve from 'enhanced-resolve'
import * as esbuild from 'esbuild'
import * as fs from 'fs'
import * as path from 'path'
import * as tsconfck from 'tsconfck'
import {
  appendInlineSourceMap,
  combineSourcemaps,
  loadSourceMap,
} from './sourceMaps'
import {
  BuildExtensions,
  Chunk,
  EmitChunkOptions,
  File,
  OnTransformArgs,
  OnTransformOptions,
  MetafileExtensions,
} from './types'

export * from './types'

const kBuildExtensions = Symbol.for('esbuild-extra:extensions')

export function wrapPlugins<Options extends esbuild.BuildOptions>(
  options: Options
): Options {
  return {
    ...options,
    plugins: options.plugins?.map(plugin => ({
      name: plugin.name,
      setup(build) {
        Object.assign(build, getBuildExtensions(build, plugin.name))
        return plugin.setup(build)
      },
    })),
  }
}

type LoadParams = Parameters<esbuild.PluginBuild['onLoad']>
type TransformParams = Parameters<BuildExtensions['onTransform']>
type ResolveParams = Parameters<esbuild.PluginBuild['onResolve']>
type ResolvedParams = Parameters<BuildExtensions['onResolved']>

type LoadRule = [pluginName: string, ...params: LoadParams]
type TransformRule = [pluginName: string, ...params: TransformParams]
type ResolveRule = [pluginName: string, ...params: ResolveParams]
type ResolvedRule = [pluginName: string, ...params: ResolvedParams]

export function getBuildExtensions(
  pluginBuild: esbuild.PluginBuild,
  pluginName: string
): BuildExtensions {
  // If the pluginBuild already has the extensions, return it.
  if ('onTransform' in (pluginBuild as any)) {
    return pluginBuild as any
  }

  const { initialOptions } = pluginBuild

  let extensions:
    | ((
        pluginBuild: esbuild.PluginBuild,
        pluginName: string
      ) => BuildExtensions)
    | undefined = Reflect.get(initialOptions, kBuildExtensions)

  if (!extensions) {
    const onLoadRules: LoadRule[] = []
    const onTransformRules: TransformRule[] = []
    const onResolveRulesMap = new Map<string | undefined, ResolveRule[]>()
    const onResolvedRules: ResolvedRule[] = []

    let globalWatchFiles: MapOfSets<string, string> | undefined
    let globalWatchDirs: MapOfSets<string, string> | undefined
    if (initialOptions.metafile) {
      pluginBuild.onStart(() => {
        globalWatchFiles = new Map()
        globalWatchDirs = new Map()
      })
      pluginBuild.onEnd(result => {
        const metafile = result.metafile as (esbuild.Metafile & MetafileExtensions) | undefined
        if (metafile) {
          metafile.watchFiles = globalWatchFiles!
          metafile.watchDirs = globalWatchDirs!
        }
      })
    }

    const loaders: Record<string, esbuild.Loader> = {
      '.js': 'js',
      '.jsx': 'jsx',
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.mjs': 'js',
      '.cjs': 'js',
      '.mts': 'ts',
      '.cts': 'ts',
      ...initialOptions.loader,
    }

    const getLoader = (id: string) => {
      return loaders[path.extname(id)]
    }

    const extsByLoader = Object.entries(loaders).reduce(
      (acc, [ext, loader]) => {
        acc[loader] ||= []
        acc[loader].push(ext)
        return acc
      },
      {} as Record<esbuild.Loader, string[]>
    )

    async function load(
      partialArgs: { path: string } & Partial<esbuild.OnLoadArgs>
    ): Promise<esbuild.OnLoadResult> {
      const args: esbuild.OnLoadArgs = {
        namespace: 'file',
        pluginData: undefined,
        suffix: '',
        ...partialArgs,
      }

      let result: esbuild.OnLoadResult | null | void = null
      let errors: esbuild.Message[] = []

      for (const [pluginName, options, callback] of onLoadRules) {
        if (args.namespace !== (options.namespace ?? 'file')) {
          continue
        }

        if (!options.filter.test(args.path)) {
          continue
        }

        try {
          result = await callback(args)
          if (result) {
            break
          }
        } catch (error: any) {
          errors.push({
            id: 'load-error',
            pluginName,
            text: error.message,
            location: null,
            notes: [],
            detail: error,
          })
        }
      }

      if (!result) {
        try {
          result = {
            contents: fs.readFileSync(args.path),
            loader: getLoader(args.path),
          }
        } catch {}
      }

      return {
        ...result,
        errors,
      }
    }

    function coalesceWatchedPaths(
      relatedPath: string,
      result: {
        watchFiles?: string[]
        watchDirs?: string[]
      }
    ) {
      if (globalWatchFiles) {
        result.watchFiles?.forEach(file =>
          addToMappedSet(globalWatchFiles!, file, relatedPath)
        )
      }
      if (globalWatchDirs) {
        result.watchDirs?.forEach(dir =>
          addToMappedSet(globalWatchDirs!, dir, relatedPath)
        )
      }
    }

    type TransformArgs =
      | (esbuild.OnLoadResult & {
          path: string
          isResult: true
          namespace?: string
          suffix?: string
        })
      | (esbuild.OnLoadArgs & {
          loader?: undefined
          isResult?: undefined
          resolveDir?: undefined
          errors?: undefined
          warnings?: undefined
          watchFiles?: undefined
          watchDirs?: undefined
        })

    async function transform(
      args: TransformArgs
    ): Promise<esbuild.OnLoadResult> {
      const loadResult = args.isResult
        ? omitKeys(args, ['isResult', 'path', 'suffix', 'namespace'])
        : await load(args)

      if (!loadResult.contents) {
        coalesceWatchedPaths(args.path, loadResult)
        return loadResult
      }

      const {
        errors = [],
        warnings = [],
        watchFiles = [],
        watchDirs = [],
      } = args

      let initialCode!: string
      let loader: esbuild.Loader | undefined
      let transformArgs: OnTransformArgs | undefined
      let jsTransforms: Set<TransformRule> | undefined
      let jsxTransforms: Set<TransformRule> | undefined
      let resolveDir = loadResult.resolveDir ?? args.resolveDir
      let maps: any[] = []

      const isNamespaceCompatible = ({
        namespace = '*',
      }: OnTransformOptions) => {
        if (namespace === '*') {
          return true
        }
        if ((args.namespace ?? 'file') === namespace) {
          return true
        }
        return false
      }

      const applyTransformRule = async (
        rule: TransformRule,
        rules?: Set<TransformRule>
      ): Promise<esbuild.Message | void> => {
        const [pluginName, options, callback] = rule

        if (!isNamespaceCompatible(options)) {
          return
        }

        const filePath = transformArgs?.path ?? args.path
        loader ||= getLoader(filePath) || 'file'

        const filter = options.filter!
        if (!filter.test(filePath)) {
          if (loader == 'ts' || loader == 'jsx') {
            if (filter.test(filePath + '.js')) {
              jsTransforms ||= new Set()
              jsTransforms.add(rule)
            }
          } else if (loader == 'tsx') {
            if (filter.test(filePath + '.jsx')) {
              jsxTransforms ||= new Set()
              jsxTransforms.add(rule)
            } else if (filter.test(filePath + '.js')) {
              jsTransforms ||= new Set()
              jsTransforms.add(rule)
            }
          }
          return
        }

        // If a plugin handles the TS->JS or JSX->JS transform, we still
        // need to maintain the order in which plugins are applied.
        if (loader == 'js' && jsTransforms && rules != jsTransforms) {
          // If a rule is applied to both JS and JSX, add it to only the
          // JSX queue.
          if (!jsxTransforms || !jsxTransforms.has(rule)) {
            jsTransforms.add(rule)
          }
          return
        }
        if (loader == 'jsx' && jsxTransforms && !rules) {
          jsxTransforms.add(rule)
          return
        }

        transformArgs ||= {
          path: args.path,
          code: (initialCode = decodeContents(loadResult.contents!)),
          loader,
          namespace: args.namespace ?? 'file',
          pluginData: loadResult.pluginData || args.pluginData || {},
          suffix: args.suffix || '',
        }

        try {
          const result = await callback(transformArgs)
          if (result) {
            if (result.code != null) {
              transformArgs.code = result.code
            }
            if (result.loader && result.loader != transformArgs.loader) {
              loader = transformArgs.loader = result.loader

              const exts = extsByLoader[loader]
              if (exts) {
                transformArgs.initialPath = args.path
                transformArgs.path = args.path + exts[0]
              }
            }
            if (result.warnings) {
              warnings.push(...result.warnings)
            }
            if (result.errors) {
              errors.push(...result.errors)
            }
            if (result.map) {
              maps.push(result.map)
            }
            if (result.watchFiles) {
              watchFiles.push(...result.watchFiles)
            }
            if (result.watchDirs) {
              watchDirs.push(...result.watchDirs)
            }
            if (result.resolveDir != null) {
              resolveDir = result.resolveDir
            }
            if (result.pluginData) {
              transformArgs.pluginData ||= {}
              Object.assign(transformArgs.pluginData, result.pluginData)
            }
          }
        } catch (error: any) {
          return {
            id: 'transform-error',
            pluginName,
            text: error.message,
            location: error.location || null,
            notes: [],
            detail: error,
          }
        }
      }

      transform: {
        for (const rule of onTransformRules) {
          const error = await applyTransformRule(rule)
          if (error) {
            errors.push(error)
            break transform
          }
        }
        if (jsTransforms || jsxTransforms) {
          let tsconfigPath: string | undefined
          let tsconfigRaw: string | undefined
          if (/\.[mc]?tsx?$/.test(args.path)) {
            try {
              tsconfigPath = await tsconfck.find(args.path, {
                root: process.cwd(),
              })
              tsconfigRaw = fs.readFileSync(tsconfigPath, 'utf8')
            } catch {}
          }

          const createEsbuildRule = (
            options?: esbuild.TransformOptions
          ): TransformRule => [
            'esbuild-extra:transform',
            { filter: /.*/ },
            async args => {
              const result = await esbuild.transform(args.code, {
                format: 'esm',
                sourcemap: true,
                platform: 'neutral',
                sourcefile: args.path,
                loader: args.loader,
                tsconfigRaw,
                ...options,
              })
              return {
                code: result.code,
                map: JSON.parse(result.map),
                loader: args.loader == 'tsx' ? 'jsx' : 'js',
                warnings: result.warnings,
              }
            },
          ]

          // Compile TSX to JSX.
          if (jsxTransforms) {
            const error = await applyTransformRule(
              createEsbuildRule({ jsx: 'preserve' }),
              jsxTransforms
            )
            if (error) {
              errors.push(error)
              break transform
            }
            for (const rule of jsxTransforms) {
              const error = await applyTransformRule(rule, jsxTransforms)
              if (error) {
                errors.push(error)
                break transform
              }
            }
            // Unset this to ensure the next applyTransformRule call below isn't added to this.
            jsxTransforms = undefined
          }

          // Compile TS & JSX to JS.
          if (tsconfigRaw || jsTransforms) {
            const error = await applyTransformRule(
              createEsbuildRule({
                // This ensures the tsconfig.json is respected in cases
                // where a TypeScript file has had ".jsx" appended to
                // its transformArgs path.
                sourcefile: args.path,
                loader: getLoader(args.path),
              }),
              jsTransforms
            )
            if (error) {
              errors.push(error)
              break transform
            }
          }

          if (jsTransforms) {
            for (const rule of jsTransforms) {
              const error = await applyTransformRule(rule, jsTransforms)
              if (error) {
                errors.push(error)
                break transform
              }
            }
          }
        }
      }

      if (watchFiles.length || watchDirs.length) {
        coalesceWatchedPaths(args.path, { watchFiles, watchDirs })
      }

      // No code transformation was applied
      if (!transformArgs || transformArgs.code === initialCode) {
        return {
          ...loadResult,
          pluginData: transformArgs?.pluginData || loadResult.pluginData,
          resolveDir,
          watchFiles,
          watchDirs,
          warnings,
          errors,
        }
      }

      const inputSourcemap = loadSourceMap(initialCode, args.path)
      if (inputSourcemap) {
        maps.unshift(inputSourcemap)
      }

      const transformedCode = transformArgs.code
      const combinedMap =
        maps.length > 1
          ? combineSourcemaps(args.path, [...maps].reverse())
          : maps[0]

      if (combinedMap) {
        const pathToSourceRoot = sourceRoot || path.dirname(args.path)
        const pathToWorkingDir = path.relative(pathToSourceRoot, absWorkingDir)

        combinedMap.sources = combinedMap.sources.map((source: string) => {
          let src = path.relative(pathToSourceRoot, source)
          if (!src.startsWith('..')) {
            return src
          }
          src = path.relative(absWorkingDir, source)
          if (src.startsWith('..')) {
            return source
          }
          return path.join(pathToWorkingDir, src)
        })

        if (sourceRoot) {
          combinedMap.sourceRoot = sourceRoot
        }
      }

      return {
        contents: combinedMap
          ? appendInlineSourceMap(transformedCode, combinedMap)
          : transformedCode,
        loader: transformArgs.loader,
        pluginData: transformArgs.pluginData,
        resolveDir,
        watchFiles,
        watchDirs,
        warnings,
        errors,
      }
    }

    const chunks = new Map<string, Chunk>()
    const files = new Map<string, File>()

    pluginBuild.onStart(() => {
      chunks.clear()
      files.clear()
    })

    if (!initialOptions.write) {
      pluginBuild.onEnd(result => {
        const outputFiles = result.outputFiles!
        for (const chunk of chunks.values()) {
          for (const outputFile of chunk.outputFiles!) {
            outputFiles.push(outputFile)
          }
        }
        for (const file of files.values()) {
          for (const outputFile of file.outputFiles!) {
            outputFiles.push(outputFile)
          }
        }
      })
    }

    const isEmittedPath = (id: string) => {
      for (const chunk of chunks.values()) {
        if (chunk.id === id) {
          return true
        }
      }
      for (const file of files.values()) {
        if (file.id === id) {
          return true
        }
      }
      return false
    }

    const emitChunk = async (chunkOptions: EmitChunkOptions) => {
      const format = chunkOptions.format || initialOptions.format

      const config = {
        ...initialOptions,
        format,
        outdir: chunkOptions.outdir
          ? path.resolve(outdir || absWorkingDir, chunkOptions.outdir)
          : outdir,
        bundle: chunkOptions.bundle ?? initialOptions.bundle,
        splitting:
          format === 'esm'
            ? chunkOptions.splitting ?? initialOptions.splitting
            : false,
        platform: chunkOptions.platform ?? initialOptions.platform,
        target: chunkOptions.target ?? initialOptions.target,
        plugins: chunkOptions.plugins ?? initialOptions.plugins,
        external: chunkOptions.external ?? initialOptions.external,
        jsxFactory:
          'jsxFactory' in chunkOptions
            ? chunkOptions.jsxFactory
            : initialOptions.jsxFactory,
        entryNames: initialOptions.chunkNames || initialOptions.entryNames,
        write: chunkOptions.write ?? initialOptions.write ?? true,
        globalName: undefined,
        outfile: undefined,
        metafile: true,
      } satisfies esbuild.BuildOptions

      Object.defineProperty(config, 'chunk', {
        enumerable: false,
        value: true,
      })

      if (chunkOptions.contents) {
        delete config.entryPoints
        config.stdin = {
          sourcefile: chunkOptions.path,
          contents: chunkOptions.contents.toString(),
          resolveDir: sourceRoot || absWorkingDir,
        }
      } else {
        config.entryPoints = [chunkOptions.path]
      }

      if (config.define) {
        delete config.define['this']
      }

      const result = await esbuild.build(config)
      const outputs = result.metafile.outputs
      const outFile = Object.entries(outputs)
        .filter(([output]) => !output.endsWith('.map'))
        .find(([output]) => outputs[output].entryPoint)

      if (!outFile) {
        throw new Error('Unable to locate build artifacts')
      }

      const resolvedOutputFile = path.resolve(outFile[0])
      const buffer = result.outputFiles
        ? result.outputFiles[0].contents
        : fs.readFileSync(resolvedOutputFile)

      const chunkResult: Chunk = {
        ...result,
        id: hash(buffer),
        path: path.relative(outdir || absWorkingDir, resolvedOutputFile),
        filePath: resolvedOutputFile,
      }

      chunks.set(chunkOptions.path, chunkResult)
      return chunkResult
    }

    const resolveEmittedFile = (
      pattern: string,
      filePath: string,
      buffer: Buffer
    ) => {
      outbase ||= getOutBase(absWorkingDir, initialOptions)

      const dir = path.relative(outbase, path.dirname(filePath))
      const name = path.basename(filePath)

      return path.resolve(
        outdir || sourceRoot || absWorkingDir,
        computeName(pattern, dir, name, buffer)
      )
    }

    const emitFile = async (source: string, buffer?: string | Buffer) => {
      let watchFiles: MapOfSets<string, string> | undefined
      let watchDirs: MapOfSets<string, string> | undefined

      if (!buffer) {
        const result = await load({
          pluginData: null,
          namespace: 'file',
          suffix: '',
          path: source,
        })
        coalesceWatchedPaths(source, result)
        if (result.contents) {
          buffer = Buffer.from(result.contents as Uint8Array)
        } else {
          buffer = fs.readFileSync(source)
        }
      } else if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer)
      }

      const outputFile = resolveEmittedFile(assetNames, source, buffer)
      const bytes = buffer.length
      const write = initialOptions.write ?? true
      if (write) {
        fs.mkdirSync(path.dirname(outputFile), {
          recursive: true,
        })
        fs.writeFileSync(outputFile, buffer)
      }

      const outputFiles = !write
        ? [createOutputFile(outputFile, Buffer.from(buffer))]
        : undefined

      const result = createResult(outputFiles, {
        inputs: {
          [path.relative(absWorkingDir, source)]: {
            bytes,
            imports: [],
          },
        },
        outputs: {
          [path.relative(absWorkingDir, outputFile)]: {
            bytes,
            inputs: {
              [path.relative(absWorkingDir, source)]: {
                bytesInOutput: bytes,
              },
            },
            imports: [],
            exports: [],
            entryPoint: path.relative(absWorkingDir, source),
          },
        },
        watchFiles: watchFiles || new Map(),
        watchDirs: watchDirs || new Map(),
      })

      const fileResult: File = {
        ...result,
        id: hash(buffer),
        path: path.relative(outdir || absWorkingDir, outputFile),
        filePath: outputFile,
      }

      files.set(source, fileResult)
      return fileResult
    }

    const nodeResolve = enhancedResolve.create({
      extensions: initialOptions.resolveExtensions || [
        '.tsx',
        '.ts',
        '.jsx',
        '.js',
        '.css',
        '.json',
      ],
    })

    const postResolve = async (
      args: esbuild.OnResolveArgs,
      resolved: esbuild.OnResolveResult & {
        path: string
        pluginName: string
      }
    ): Promise<esbuild.OnResolveResult> => {
      const { namespace = 'file' } = resolved
      for (const rule of onResolvedRules) {
        const options = rule[1]
        if (!options.filter.test(resolved.path)) {
          continue
        }
        if (namespace !== (options.namespace ?? 'file')) {
          continue
        }
        const onResolved = rule[2]
        const result = await onResolved(args, resolved)
        if (result) {
          resolved = {
            ...resolved,
            ...result,
            errors: mergeArrays(resolved.errors, result.errors),
            warnings: mergeArrays(resolved.warnings, result.warnings),
          }
        }
      }
      coalesceWatchedPaths(args.importer + '->' + args.path, resolved)
      return resolved
    }

    const resolveFile = async (args: esbuild.OnResolveArgs) => {
      const resolvedPath = await new Promise<string>((setResult, setError) => {
        nodeResolve(args.resolveDir, args.path, (error, result) =>
          error ? setError(error) : setResult(result as string)
        )
      })
      return postResolve(args, {
        path: resolvedPath,
        pluginName: 'node-resolve',
      })
    }

    let {
      absWorkingDir = process.cwd(),
      outfile,
      outdir = outfile ? path.dirname(outfile) : undefined,
      outbase,
      sourceRoot,
      assetNames = '[dir]/[name]',
    } = initialOptions

    if (outdir) {
      outdir = path.resolve(absWorkingDir, outdir)
    }
    if (sourceRoot) {
      sourceRoot = path.resolve(absWorkingDir, sourceRoot)
    }

    const RESOLVED_AS_FILE = 1
    const RESOLVED_AS_MODULE = 2

    extensions = (pluginBuild, pluginName) => {
      const onResolve = pluginBuild.onResolve.bind(pluginBuild)
      const onLoad = pluginBuild.onLoad.bind(pluginBuild)

      return {
        RESOLVED_AS_FILE,
        RESOLVED_AS_MODULE,
        getLoader,
        isEmittedPath,
        emitChunk,
        emitFile,
        async resolveLocallyFirst(path, options = {}) {
          const isLocalSpecifier =
            path.startsWith('./') || path.startsWith('../')
          if (!isLocalSpecifier) {
            // force local file resolution first
            const result = await pluginBuild.resolve(`./${path}`, options)

            if (result.path) {
              return {
                ...result,
                pluginData: RESOLVED_AS_FILE,
              }
            }
          }

          const result = await pluginBuild.resolve(path, options)
          if (result.path) {
            return {
              ...result,
              pluginData: isLocalSpecifier
                ? RESOLVED_AS_FILE
                : RESOLVED_AS_MODULE,
            }
          }

          return result
        },
        onResolve(options, callback) {
          const namespace = options.namespace ?? 'file'

          let onResolveRules = onResolveRulesMap.get(namespace) || []
          if (!onResolveRules.length) {
            onResolveRulesMap.set(namespace, onResolveRules)
          }

          // This 1-based index is used to detect the last onResolve hook.
          const index = onResolveRules.push([pluginName, options, callback])

          onResolve(options, async args => {
            const result = await callback(args)
            if (result && result.path) {
              result.pluginName ||= pluginName
              return postResolve(args, result as any)
            }
            // If not the last rule, skip the fallback resolver.
            if (index < onResolveRules.length) {
              return null
            }
            // Resolve as a file but still use postResolve.
            if (namespace === 'file') {
              return resolveFile(args)
            }
            return null
          })
        },
        onResolved(options, callback) {
          onResolvedRules.push([pluginName, options, callback])

          const namespace = options.namespace ?? 'file'
          const onResolveRules = onResolveRulesMap.get(namespace) || []
          if (!onResolveRules.length) {
            onResolveRulesMap.set(namespace, onResolveRules)

            const index = onResolveRules.push([pluginName, options, null!])
            onResolve(options, args => {
              if (index < onResolveRules.length) {
                return null
              }
              return resolveFile(args)
            })
          }
        },
        async load(args) {
          const result = await load(args)
          return transform({
            ...result,
            path: args.path,
            suffix: args.suffix,
            namespace: args.namespace,
            isResult: true,
          })
        },
        onLoad(options, callback) {
          onLoad(options, args => this.load(args))
          onLoadRules.push([pluginName, options, callback])
        },
        onTransform({ loaders, extensions, ...options }, callback) {
          const patterns: string[] = []

          if (options.filter) {
            patterns.push(options.filter.source)
          }

          if (extensions) {
            patterns.push(joinRegexSources(extensions) + '$')
          }

          // Load patterns are used to ensure a TypeScript file is
          // matched for a JS transform, even if no TS transforms exist.
          const loadPatterns: string[] = []

          if (loaders) {
            let js = false,
              jsx = false,
              ts = false,
              tsx = false

            const extensions: string[] = []
            for (const loader of loaders) {
              extensions.push(...extsByLoader[loader])

              if (loader === 'js') js = true
              else if (loader === 'jsx') jsx = true
              else if (loader === 'ts') ts = true
              else if (loader === 'tsx') tsx = true
            }
            patterns.push(
              `\\.${joinRegexSources(
                extensions.map(ext => ext.replace('.', ''))
              )}$`
            )

            const loadExtensions: string[] = []
            if (js || jsx) {
              if (!jsx) {
                loadExtensions.push(...extsByLoader.jsx)
              }
              if (!tsx) {
                loadExtensions.push(...extsByLoader.tsx)
              }
              if (!ts && js) {
                loadExtensions.push(...extsByLoader.ts)
              }
            }
            if (loadExtensions.length) {
              loadPatterns.push(
                `\\.${joinRegexSources(
                  [...extensions, ...loadExtensions].map(ext =>
                    ext.replace('.', '')
                  )
                )}$`
              )
            }
          }

          if (patterns.length) {
            options.filter = new RegExp(joinRegexSources(patterns))
            onTransformRules.push([pluginName, options, callback])

            if (loadPatterns.length) {
              const filter = new RegExp(joinRegexSources(loadPatterns))
              onLoad({ ...options, filter }, args => transform(args))
            } else {
              onLoad(options as any, args => transform(args))
            }
          }
        },
      }
    }

    Reflect.set(initialOptions, kBuildExtensions, extensions)
  }

  return extensions(pluginBuild, pluginName)
}

function joinRegexSources(sources: string[]) {
  return sources.length > 1 ? `(${sources.join('|')})` : sources[0]
}

function decodeContents(contents: string | Uint8Array) {
  if (typeof contents == 'string') {
    return contents
  }
  const decoder = new TextDecoder('utf8')
  return decoder.decode(contents)
}

function hash(buffer: string | Buffer | Uint8Array) {
  const hash = crypto.createHash('sha1')
  hash.update(
    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as Uint8Array)
  )
  return hash.digest('hex').substring(0, 8)
}

function computeName(
  pattern: string,
  dir: string,
  name: string,
  buffer: Buffer | string
): string {
  return `${pattern
    .replace('[name]', () => path.basename(name, path.extname(name)))
    .replace('[ext]', () => path.extname(name))
    .replace(/(\/)?\[dir\](\/)?/, (_, leadingSlash, trailingSlash) => {
      if (dir) {
        return `${leadingSlash || ''}${dir}${trailingSlash || ''}`
      }
      if (!leadingSlash && trailingSlash) {
        return ''
      }
      return leadingSlash || ''
    })
    .replace('[dir]', dir)
    .replace('[hash]', () => hash(buffer))}${path.extname(name)}`
}

function getOutBase(absWorkingDir: string, options: esbuild.BuildOptions) {
  if (options.outbase) {
    return options.outbase
  }

  const entryPoints = options.entryPoints || []
  if (!entryPoints.length) {
    return absWorkingDir
  }

  const separator = /\/+|\\+/

  return (
    (Array.isArray(entryPoints)
      ? entryPoints.map(entry => (typeof entry == 'string' ? entry : entry.out))
      : Object.values(entryPoints)
    )
      .map(entry =>
        path.dirname(path.resolve(absWorkingDir, entry)).split(separator)
      )
      .reduce((result, chunk) => {
        const len = Math.min(chunk.length, result.length)
        for (let i = 0; i < len; i++) {
          if (chunk[i] !== result[i]) {
            return result.splice(0, i)
          }
        }
        return result.splice(0, len)
      })
      .join(path.sep) || path.sep
  )
}

function createOutputFile(path: string, contents: Buffer): esbuild.OutputFile {
  return {
    path,
    contents,
    get text() {
      return contents.toString()
    },
  }
}

type Metafile = esbuild.Metafile & {
  watchFiles: MapOfSets<string, string>
  watchDirs: MapOfSets<string, string>
}

function createResult(
  outputFiles: esbuild.OutputFile[] | undefined,
  metafile: Metafile
) {
  return {
    errors: [] as esbuild.Message[],
    warnings: [] as esbuild.Message[],
    outputFiles,
    metafile,
    mangleCache: undefined,
  } satisfies esbuild.BuildResult
}

function omitKeys<T extends object, P extends keyof T>(
  obj: T,
  props: P[]
): Omit<T, P> {
  const result: any = {}
  for (const prop of Object.keys(obj)) {
    if (!props.includes(prop as P)) {
      result[prop] = obj[prop as keyof T]
    }
  }
  return result
}

function mergeArrays<T>(a: T[] | undefined, b: T[] | undefined) {
  if (!a) return b
  if (!b) return a
  return [...a, ...b]
}

type MapOfSets<Key, Value> = Map<Key, Set<Value>>

function addToMappedSet<Key, Value>(
  map: Map<Key, Set<Value>>,
  key: Key,
  value: Value
) {
  let set = map.get(key)
  if (!set) {
    map.set(key, (set = new Set()))
  }
  set.add(value)
}
