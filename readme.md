# esbuild-extra

The lighter alternative to `@chialab/esbuild-rna` that extends `esbuild` plugins with the following new features:

- `onTransform` build hook for co-operative file transformation (with sourcemap support)
- `onResolved` build hook for manipulation of `onResolve` results
- `load` build method for loading a file via `onLoad` and `onTransform` hooks
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

    onTransform({ loaders: ['tsx'] }, async args => {
      // Transform args.code and return a { code, map } object when you're ready!
    })
  },
}
```

### onTransform hooks

Here are some tips about the `onTransform` feature.

- If no `namespace` is defined for an `onTransform` hook, it will be applied to every compatible file regardless of the file's namespace. You can use `namespace: "file"` to only affect real files without a custom namespace.

- If an `onTransform` hook is targeted at `.js` files, it will also be applied to `.jsx`, `.ts`, and `.tsx` files, but only after any `onTransform` hooks targeting those specific extensions are applied and also after the file is transpiled to plain JavaScript. Similarly, this works for `onTransform` hooks targeting `.jsx` files or `.ts` files (both applied to `.tsx` files after transpilation).

## Prior art

- [@chialab/esbuild-rna](https://github.com/chialab/rna/tree/main/packages/esbuild-rna)

## License

MIT
