import { LocalFile, GenericFilehandle } from 'generic-filehandle2'

// const COMPRESSED_POSITION = 0
const UNCOMPRESSED_POSITION = 1

const TWO_PWR_16_DBL = 1 << 16
const TWO_PWR_32_DBL = TWO_PWR_16_DBL * TWO_PWR_16_DBL

// extracted from long.js, license Apache 2.0 https://github.com/dcodeIO/long.js
function longFromBytesUnsignedLE(bytes: Uint8Array) {
  const low =
    bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)
  const high =
    bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)
  return (high >>> 0) * TWO_PWR_32_DBL + (low >>> 0)
}

export default class GziIndex {
  filehandle: GenericFilehandle

  index?: Promise<[number, number][]>

  constructor({
    filehandle,
    path,
  }: {
    filehandle?: GenericFilehandle
    path?: string
  }) {
    if (filehandle) {
      this.filehandle = filehandle
    } else if (path) {
      this.filehandle = new LocalFile(path)
    } else {
      throw new TypeError('either filehandle or path must be defined')
    }
  }

  _getIndex() {
    if (!this.index) {
      this.index = this._readIndex().catch((e: unknown) => {
        this.index = undefined
        throw e
      })
    }
    return this.index
  }

  async _readIndex(): Promise<[number, number][]> {
    const buf = await this.filehandle.read(8, 0)
    const numEntries = longFromBytesUnsignedLE(buf.subarray(0, 8))
    if (!numEntries) {
      return [[0, 0]]
    }

    const entries = new Array(numEntries + 1)
    entries[0] = [0, 0]

    // TODO rewrite this to make an index-index that stays in memory
    const bufSize = 8 * 2 * numEntries
    if (bufSize > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('integer overflow')
    }
    const buf2 = await this.filehandle.read(bufSize, 8)
    for (let entryNumber = 0; entryNumber < numEntries; entryNumber += 1) {
      const compressedPosition = longFromBytesUnsignedLE(
        buf2.subarray(entryNumber * 16, entryNumber * 16 + 8),
      )
      const uncompressedPosition = longFromBytesUnsignedLE(
        buf2.subarray(entryNumber * 16 + 8, entryNumber * 16 + 16),
      )
      entries[entryNumber + 1] = [compressedPosition, uncompressedPosition]
    }

    return entries
  }

  async getLastBlock() {
    const entries = await this._getIndex()
    return entries.at(-1)
  }

  async getRelevantBlocksForRead(length: number, position: number) {
    const endPosition = position + length
    if (length === 0) {
      return []
    }
    const entries = await this._getIndex()
    const relevant = []

    // binary search to find the block that the
    // read starts in and extend forward from that
    const compare = (entry: [number, number], nextEntry?: [number, number]) => {
      const uncompressedPosition = entry[UNCOMPRESSED_POSITION]
      const nextUncompressedPosition = nextEntry
        ? nextEntry[UNCOMPRESSED_POSITION]
        : Infinity
      if (
        uncompressedPosition <= position &&
        nextUncompressedPosition > position
      ) {
        // block overlaps read start
        return 0
      } else if (uncompressedPosition < position) {
        // block is before read start
        return -1
      } else {
        // block is after read start
        return 1
      }
    }

    let lowerBound = 0
    let upperBound = entries.length - 1
    let searchPosition = Math.floor(entries.length / 2)

    let comparison = compare(
      entries[searchPosition]!,
      entries[searchPosition + 1],
    )
    while (comparison !== 0) {
      if (comparison > 0) {
        upperBound = searchPosition - 1
      } else if (comparison < 0) {
        lowerBound = searchPosition + 1
      }
      searchPosition = Math.ceil((upperBound - lowerBound) / 2) + lowerBound
      comparison = compare(
        entries[searchPosition]!,
        entries[searchPosition + 1],
      )
    }

    // here's where we read forward
    relevant.push(entries[searchPosition])
    let i = searchPosition + 1
    for (; i < entries.length; i += 1) {
      relevant.push(entries[i])
      if (entries[i]![UNCOMPRESSED_POSITION] >= endPosition) {
        break
      }
    }
    if (relevant[relevant.length - 1]![UNCOMPRESSED_POSITION] < endPosition) {
      relevant.push([])
    }
    return relevant
  }
}
