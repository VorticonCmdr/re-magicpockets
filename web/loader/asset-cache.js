// filename -> depacked-and-decoded resource, lazy + memoized. This is the one place that ties
// together "read raw bytes from an asset-source.js Map" + "RNC-depack" + "format-decode", so the
// engine only ever asks for e.g. getPak('blocks1.pak', palette) and gets back decoded tiles --
// it never sees a compressed byte or calls rncUnpack itself.

'use strict';

import { rncUnpack, crc16arc } from '../core/rnc.js';
import { decodePak } from '../core/pak.js';
import { decodePap } from '../core/pap.js';
import { decodeLevelScript } from '../core/pin-level-script.js';
import { decodePinSoundBank } from '../core/pin-sound.js';

export class AssetCache {
  /** @param {Map<string, () => Promise<Uint8Array>>} source from asset-source.js */
  constructor(source) {
    this.source = source;
    this.rawCache = new Map(); // filename -> Promise<Uint8Array> (depacked)
    this.decodedCache = new Map(); // "kind:filename:extra" -> decoded object
  }

  has(filename) {
    return this.source.has(filename.toLowerCase());
  }

  /** RNC-depacked bytes for `filename`, CRC-verified against the header, cached after first read. */
  async getRaw(filename) {
    const key = filename.toLowerCase();
    if (this.rawCache.has(key)) return this.rawCache.get(key);
    const promise = (async () => {
      const load = this.source.get(key);
      if (!load) throw new Error(`asset not found: ${filename}`);
      const compressed = await load();
      const result = rncUnpack(compressed);
      if (result === null) {
        // Not RNC-compressed (shouldn't happen for this project's data/*, but don't hide it).
        return compressed;
      }
      const actualCrc = crc16arc(result.data);
      if (actualCrc !== result.unpackedCrc || result.data.length !== result.unpackedLen) {
        throw new Error(
          `${filename}: RNC depack failed verification (crc ${actualCrc.toString(16)} vs ` +
            `${result.unpackedCrc.toString(16)}, len ${result.data.length} vs ${result.unpackedLen})`
        );
      }
      return result.data;
    })();
    this.rawCache.set(key, promise);
    return promise;
  }

  /** Decoded tile atlas for a .pak file under the given palette (array of [r,g,b] triples). */
  async getPak(filename, palette) {
    const key = `pak:${filename.toLowerCase()}`;
    if (this.decodedCache.has(key)) return this.decodedCache.get(key);
    const raw = await this.getRaw(filename);
    const decoded = decodePak(filename, raw, palette);
    this.decodedCache.set(key, decoded);
    return decoded;
  }

  /** Decoded 128x128 tile-index grid for a .pap file. */
  async getPap(filename) {
    const key = `pap:${filename.toLowerCase()}`;
    if (this.decodedCache.has(key)) return this.decodedCache.get(key);
    const raw = await this.getRaw(filename);
    const decoded = decodePap(raw);
    this.decodedCache.set(key, decoded);
    return decoded;
  }

  /** Decoded sub-levels + entity-placement records for a level-script .pin file. */
  async getLevelScript(filename) {
    const key = `levelscript:${filename.toLowerCase()}`;
    if (this.decodedCache.has(key)) return this.decodedCache.get(key);
    const raw = await this.getRaw(filename);
    const decoded = decodeLevelScript(raw);
    this.decodedCache.set(key, decoded);
    return decoded;
  }

  /** Decoded resource-offset table (sound-effect bank or single song) for a sound .pin file. */
  async getPinSoundBank(filename) {
    const key = `pinsound:${filename.toLowerCase()}`;
    if (this.decodedCache.has(key)) return this.decodedCache.get(key);
    const raw = await this.getRaw(filename);
    const decoded = decodePinSoundBank(raw);
    if (!decoded) throw new Error(`${filename}: doesn't look like a resource-offset table`);
    this.decodedCache.set(key, decoded);
    return decoded;
  }
}
