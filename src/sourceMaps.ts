import remapping, {
  DecodedSourceMap,
  RawSourceMap,
} from '@ampproject/remapping'
import * as convertSourceMap from 'convert-source-map'
import * as fs from 'fs'
import * as path from 'path'

// based on https://github.com/sveltejs/svelte/blob/abf11bb02b2afbd3e4cac509a0f70e318c306364/src/compiler/utils/mapped_code.ts#L221
const nullSourceMap: RawSourceMap = {
  names: [],
  sources: [],
  mappings: '',
  version: 3,
}

export function combineSourcemaps(
  filename: string,
  sourcemapList: Array<DecodedSourceMap | RawSourceMap>
): RawSourceMap {
  if (
    sourcemapList.length === 0 ||
    sourcemapList.every(m => m.sources.length === 0)
  ) {
    return { ...nullSourceMap }
  }

  // We don't declare type here so we can convert/fake/map as RawSourceMap
  let map //: SourceMap
  let mapIndex = 1
  const useArrayInterface =
    sourcemapList.slice(0, -1).find(m => m.sources.length !== 1) === undefined
  if (useArrayInterface) {
    map = remapping(sourcemapList, () => null)
  } else {
    map = remapping(sourcemapList[0], function loader(sourcefile) {
      if (sourcefile === filename && sourcemapList[mapIndex]) {
        return sourcemapList[mapIndex++]
      } else {
        return { ...nullSourceMap }
      }
    })
  }
  if (!map.file) {
    delete map.file
  }

  return map as RawSourceMap
}

export function appendInlineSourceMap(code: string, map: any): string {
  return code + '\n//# sourceMappingURL=' + mapToDataUrl(map)
}

function mapToDataUrl(map: any): string {
  return (
    'data:application/json;charset=utf-8;base64,' +
    Buffer.from(JSON.stringify(map)).toString('base64')
  )
}

export function loadSourceMap(code: string, file: string): any {
  let converter = convertSourceMap.fromSource(code)
  try {
    converter ||= convertSourceMap.fromMapFileSource(code, ref =>
      fs.readFileSync(path.resolve(file, '..', ref), 'utf8')
    )
  } catch {}
  return converter?.toObject()
}
