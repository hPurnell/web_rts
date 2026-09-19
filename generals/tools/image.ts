/**
 * Decoding the game's textures and writing PNGs.
 *
 * Generals ships DXT-compressed DDS and uncompressed TGA. Both are decoded to
 * RGBA here and written out as PNG.
 *
 * No image library: DXT and TGA decoding are each about fifty lines, PNG
 * writing is a zlib stream in a container, and `node:zlib` is already there.
 * The root plan's rule is not to add a dependency without saying what it
 * replaces, and "an afternoon of well-understood block decoding" is not a good
 * enough reason to take one on.
 *
 * PLAN.md G3 asks for KTX2 with Basis compression, which stays compressed in
 * VRAM and is the right end state. That needs an encoder binary; PNG is what
 * gets a tank on screen, and the swap is confined to `writePng` below.
 */
import { deflateSync } from 'node:zlib';

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits per channel, top row first. */
  readonly data: Buffer;
}

// --------------------------------------------------------------------- DDS

const DDS_MAGIC = 0x20534444; // 'DDS ' little-endian

/** Expand an RGB565 colour into 8-bit components. */
function rgb565(value: number): [number, number, number] {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  // Replicate the high bits into the low ones, so 0x1f maps to 255 not 248.
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * Decode one 4x4 DXT colour block into an RGBA destination.
 *
 * DXT1 has two modes chosen by comparing the endpoints: with c0 > c1 the block
 * interpolates four opaque colours, otherwise three plus transparent black.
 * DXT3 and DXT5 always use the four-colour mode and carry alpha separately.
 */
function decodeColourBlock(
  src: Buffer,
  at: number,
  out: Buffer,
  width: number,
  height: number,
  bx: number,
  by: number,
  opaque: boolean,
): void {
  const c0 = src.readUInt16LE(at);
  const c1 = src.readUInt16LE(at + 2);
  const bits = src.readUInt32LE(at + 4);

  const colours: [number, number, number, number][] = [];
  const [r0, g0, b0] = rgb565(c0);
  const [r1, g1, b1] = rgb565(c1);
  colours.push([r0, g0, b0, 255], [r1, g1, b1, 255]);

  if (c0 > c1 || opaque) {
    colours.push([
      Math.round((2 * r0 + r1) / 3),
      Math.round((2 * g0 + g1) / 3),
      Math.round((2 * b0 + b1) / 3),
      255,
    ]);
    colours.push([
      Math.round((r0 + 2 * r1) / 3),
      Math.round((g0 + 2 * g1) / 3),
      Math.round((b0 + 2 * b1) / 3),
      255,
    ]);
  } else {
    colours.push([
      Math.round((r0 + r1) / 2),
      Math.round((g0 + g1) / 2),
      Math.round((b0 + b1) / 2),
      255,
    ]);
    colours.push([0, 0, 0, 0]);
  }

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const px = bx + x;
      const py = by + y;
      if (px >= width || py >= height) continue;
      const index = (bits >> (2 * (4 * y + x))) & 3;
      const colour = colours[index] as [number, number, number, number];
      const offset = (py * width + px) * 4;
      out[offset] = colour[0];
      out[offset + 1] = colour[1];
      out[offset + 2] = colour[2];
      // DXT3/DXT5 have already written alpha; DXT1 owns it.
      if (opaque === false) out[offset + 3] = colour[3];
    }
  }
}

/** DXT5's interpolated alpha: two endpoints and 3-bit indices. */
function decodeAlphaBlock(
  src: Buffer,
  at: number,
  out: Buffer,
  width: number,
  height: number,
  bx: number,
  by: number,
): void {
  const a0 = src[at] as number;
  const a1 = src[at + 1] as number;
  const alphas: number[] = [a0, a1];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) alphas.push(Math.round(((7 - i) * a0 + i * a1) / 7));
  } else {
    for (let i = 1; i <= 4; i++) alphas.push(Math.round(((5 - i) * a0 + i * a1) / 5));
    alphas.push(0, 255);
  }

  // Six bytes of 3-bit indices, read as a 48-bit little-endian field.
  let low = 0;
  for (let i = 0; i < 3; i++) low |= (src[at + 2 + i] as number) << (8 * i);
  let high = 0;
  for (let i = 0; i < 3; i++) high |= (src[at + 5 + i] as number) << (8 * i);

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const px = bx + x;
      const py = by + y;
      if (px >= width || py >= height) continue;
      const bit = 3 * (4 * y + x);
      const index = bit < 24 ? (low >> bit) & 7 : (high >> (bit - 24)) & 7;
      out[(py * width + px) * 4 + 3] = alphas[index] as number;
    }
  }
}

export function decodeDds(buffer: Buffer): Image {
  if (buffer.readUInt32LE(0) !== DDS_MAGIC) throw new Error('not a DDS file');
  const height = buffer.readUInt32LE(12);
  const width = buffer.readUInt32LE(16);
  const fourCC = buffer.toString('latin1', 84, 88);
  const pixelFlags = buffer.readUInt32LE(80);

  const data = Buffer.alloc(width * height * 4, 255);
  let at = 128;

  if (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5') {
    const blockBytes = fourCC === 'DXT1' ? 8 : 16;
    for (let by = 0; by < height; by += 4) {
      for (let bx = 0; bx < width; bx += 4) {
        if (at + blockBytes > buffer.length) break;
        if (fourCC === 'DXT5') {
          decodeAlphaBlock(buffer, at, data, width, height, bx, by);
          decodeColourBlock(buffer, at + 8, data, width, height, bx, by, true);
        } else if (fourCC === 'DXT3') {
          // Four bits of explicit alpha per texel.
          for (let y = 0; y < 4; y++) {
            const row = buffer.readUInt16LE(at + y * 2);
            for (let x = 0; x < 4; x++) {
              const px = bx + x;
              const py = by + y;
              if (px >= width || py >= height) continue;
              const nibble = (row >> (4 * x)) & 0xf;
              data[(py * width + px) * 4 + 3] = (nibble << 4) | nibble;
            }
          }
          decodeColourBlock(buffer, at + 8, data, width, height, bx, by, true);
        } else {
          decodeColourBlock(buffer, at, data, width, height, bx, by, false);
        }
        at += blockBytes;
      }
    }
    return { width, height, data };
  }

  // Uncompressed. Generals uses a few of these; assume 32-bit BGRA or 24-bit BGR.
  if ((pixelFlags & 0x40) !== 0) {
    const bits = buffer.readUInt32LE(88);
    const bytes = bits / 8;
    for (let i = 0; i < width * height; i++) {
      const src = at + i * bytes;
      if (src + bytes > buffer.length) break;
      data[i * 4] = buffer[src + 2] as number;
      data[i * 4 + 1] = buffer[src + 1] as number;
      data[i * 4 + 2] = buffer[src] as number;
      data[i * 4 + 3] = bytes === 4 ? (buffer[src + 3] as number) : 255;
    }
    return { width, height, data };
  }

  throw new Error(`unsupported DDS format: ${JSON.stringify(fourCC)}`);
}

// --------------------------------------------------------------------- TGA

export function decodeTga(buffer: Buffer): Image {
  const idLength = buffer[0] as number;
  const colourMapType = buffer[1] as number;
  const imageType = buffer[2] as number;
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const depth = buffer[16] as number;
  const descriptor = buffer[17] as number;

  if (colourMapType !== 0) throw new Error('paletted TGA is not supported');
  if (imageType !== 2 && imageType !== 10) throw new Error(`unsupported TGA type ${imageType}`);

  const bytes = depth / 8;
  const data = Buffer.alloc(width * height * 4, 255);
  let at = 18 + idLength;

  const pixels: number[][] = [];
  if (imageType === 10) {
    // Run-length encoded: a packet header byte, high bit meaning "repeat".
    while (pixels.length < width * height && at < buffer.length) {
      const header = buffer[at++] as number;
      const count = (header & 0x7f) + 1;
      if ((header & 0x80) !== 0) {
        const pixel = [...buffer.subarray(at, at + bytes)];
        at += bytes;
        for (let i = 0; i < count; i++) pixels.push(pixel);
      } else {
        for (let i = 0; i < count; i++) {
          pixels.push([...buffer.subarray(at, at + bytes)]);
          at += bytes;
        }
      }
    }
  } else {
    for (let i = 0; i < width * height && at + bytes <= buffer.length; i++) {
      pixels.push([...buffer.subarray(at, at + bytes)]);
      at += bytes;
    }
  }

  // Bit 5 of the descriptor sets the origin: unset means the first row stored
  // is the *bottom* of the image, which is the usual case and needs flipping.
  const bottomUp = (descriptor & 0x20) === 0;
  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i] as number[];
    const x = i % width;
    const y = Math.floor(i / width);
    const row = bottomUp ? height - 1 - y : y;
    const offset = (row * width + x) * 4;
    data[offset] = pixel[2] ?? 0;
    data[offset + 1] = pixel[1] ?? 0;
    data[offset + 2] = pixel[0] ?? 0;
    data[offset + 3] = bytes === 4 ? (pixel[3] ?? 255) : 255;
  }

  return { width, height, data };
}

/** Decode whichever of the two formats this buffer holds. */
export function decodeImage(buffer: Buffer, name: string): Image {
  if (buffer.length > 4 && buffer.readUInt32LE(0) === DDS_MAGIC) return decodeDds(buffer);
  if (name.toLowerCase().endsWith('.tga')) return decodeTga(buffer);
  throw new Error(`cannot decode ${name}`);
}

// --------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

/** Write an RGBA image as a PNG. */
export function writePng(image: Image): Buffer {
  const { width, height, data } = image;

  // One filter byte per scanline. Filter 0 (none) keeps this simple; zlib
  // still gets most of the win on the kind of art this pipeline handles.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
