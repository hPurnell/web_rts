/**
 * RefPack, the LZ77 variant EA compresses map files with.
 *
 * Generals `.map` files are wrapped in an `EAR\0` container holding a RefPack
 * stream. Four command forms, distinguished by the top bits of the first byte;
 * each carries a count of literal bytes to copy straight through and, except
 * for the literal-run and terminator forms, a back-reference into what has
 * already been written.
 *
 * Verified against the shipped maps: the decompressed output begins with the
 * `CkMp` magic and matches the length the container declares, which between
 * them make a wrong decoder very hard to miss.
 */

/** `EAR\0`, the container Generals wraps a compressed map in. */
const EAR_MAGIC = 0x45415200;
/** RefPack's own two-byte signature. */
const REFPACK_MAGIC = 0x10fb;

export function isRefPack(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.readUInt32BE(0) === EAR_MAGIC;
}

/**
 * Unwrap an `EAR\0` container and decompress what is inside.
 *
 * Returns the buffer unchanged when it is not wrapped, so a caller can hand
 * over whatever it read without checking first: some maps ship uncompressed.
 */
export function decompressMap(buffer: Buffer): Buffer {
  if (!isRefPack(buffer)) return buffer;
  const declared = buffer.readUInt32LE(4);
  return refpack(buffer.subarray(8), declared);
}

export function refpack(input: Buffer, expectedSize?: number): Buffer {
  let at = 0;
  const signature = input.readUInt16BE(0);
  at += 2;
  if ((signature & 0x3fff) !== REFPACK_MAGIC) {
    throw new Error(`not a RefPack stream: signature 0x${signature.toString(16)}`);
  }

  // Bit 0x8000 means the sizes are four bytes rather than three; bit 0x0100
  // means a compressed size precedes the uncompressed one.
  const wide = (signature & 0x8000) !== 0;
  const fieldSize = wide ? 4 : 3;
  if ((signature & 0x0100) !== 0) at += fieldSize; // skip the compressed size

  let size = 0;
  for (let i = 0; i < fieldSize; i++) size = (size << 8) | (input[at++] as number);

  const out = Buffer.alloc(expectedSize ?? size);
  let write = 0;

  /** Literal bytes straight from the stream. */
  const literal = (count: number): void => {
    for (let i = 0; i < count && at < input.length; i++) {
      out[write++] = input[at++] as number;
    }
  };

  /**
   * A back-reference. Copied byte by byte on purpose: runs may overlap the
   * output cursor, which is how RefPack encodes a repeat, and a bulk copy
   * would take the pre-overlap bytes instead of the ones just written.
   */
  const reference = (offset: number, count: number): void => {
    let from = write - offset;
    for (let i = 0; i < count; i++) {
      out[write++] = (out[from++] as number) ?? 0;
    }
  };

  for (;;) {
    if (at >= input.length || write >= out.length) break;
    const command = input[at++] as number;

    if ((command & 0x80) === 0) {
      // 0x00..0x7f: two bytes, short reference.
      const second = input[at++] as number;
      literal(command & 0x03);
      reference((((command & 0x60) << 3) | second) + 1, ((command & 0x1c) >> 2) + 3);
    } else if ((command & 0x40) === 0) {
      // 0x80..0xbf: three bytes, medium reference.
      const second = input[at++] as number;
      const third = input[at++] as number;
      literal((second >> 6) & 0x03);
      reference((((second & 0x3f) << 8) | third) + 1, (command & 0x3f) + 4);
    } else if ((command & 0x20) === 0) {
      // 0xc0..0xdf: four bytes, long reference.
      const second = input[at++] as number;
      const third = input[at++] as number;
      const fourth = input[at++] as number;
      literal(command & 0x03);
      reference(
        (((command & 0x10) << 12) | (second << 8) | third) + 1,
        (((command & 0x0c) << 6) | fourth) + 5,
      );
    } else if (command < 0xfc) {
      // 0xe0..0xfb: a run of literals, four at a time.
      literal(((command & 0x1f) << 2) + 4);
    } else {
      // 0xfc..0xff: the end, with up to three trailing literals.
      literal(command & 0x03);
      break;
    }
  }

  return out;
}
