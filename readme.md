# esbuild-extra

The lighter alternative to `@chialab/esbuild-rna` that extends `esbuild` plugins with the following new features:

- `onTransform` build hook for co-operative file transformation (with sourcemap support)
- `emitChunk` and `emitFile` build methods for dynamically generated outputs
- `resolveLocallyFirst` build method for path resolution where local files are preferred, but plugin-resolved paths are used otherwise

That's it, for now!

This package is ~15x smaller than `@chialab/esbuild-rna` according to PackagePhobia (see ~400 KB [here](https://packagephobia.com/result?p=esbuild-extra) and ~6 MB [here](https://packagephobia.com/result?p=%40chialab%2Fesbuild-rna)).

## Usage

Apart from TypeScript typings, the only exports are `wrapPlugins` and `getBuildExtensions`.

The `wrapPlugins` function can be used by build tools to provide the features of `esbuild-extra` to every esbuild plugin. In this case, I also recommend importing `esbuild-extra/global` inan ambient `.d.ts` file to transparently propagate our `PluginBuild` extensions to downstream TypeScript users.

```ts
import { wrapPlugins } from 'esbuild-extra'

// It returns a new object where everything is identical except the plugins are wrapped!
esbuildOptions = wrapPlugins(esbuildOptions)
```

If you're writing a standalone esbuild plugin, you'll want to use `getBuildExtensions` instead. Just note that your plugin won't play nicely with other plugins with `onLoad` hooks if they don't also use this package (but everything works fine if the other plugin isn't trying to load the files you want to transform).

```ts
import { getBuildExtensions } from 'esbuild-extra'

export default {
  name: 'my-esbuild-plugin',
  setup(build) {
    const { onTransform } = getBuildExtensions(build, 'my-esbuild-plugin')

    onTransform({ loaders: ['tsx'] }, async (args) => {
      // Transform args.code and return a { code, map } object when you're ready!
    })
  }
}
```

## JS plugins for TypeScript files

Here's one last cool thing about this package (that not even `@chialab/esbuild-rna` supports). If your plugin uses a JavaScript parser that doesn't support TypeScript syntax, no problem. Just filter with `{ loaders: ['js', 'jsx'] }` and your plugin will still run for TypeScript files! What happens is that `esbuild-extra` will transform TypeScript files into JavaScript when it notices an `onTransform` hook that works with JavaScript files only. Plugins that work with TypeScript will run before any JavaScript plugins, but the order of JavaScript plugins will be otherwise preserved.

## Prior art

- [@chialab/esbuild-rna](https://github.com/chialab/rna/tree/main/packages/esbuild-rna)

## License

MIT
