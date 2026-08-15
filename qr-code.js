// Minimal QR Code encoder (byte mode, error correction level M, versions 1-10).
// The extension cannot pull in a remote library, and the store package audit
// rejects dynamic imports, so the payment QR is generated locally from this
// module. Ten versions cover a Tron address and a `tron:` payment URI with room
// to spare; anything longer throws instead of silently truncating.

const EC_LEVEL_M = 0;
const BYTE_MODE = 4;

// [total codewords, EC codewords per block, group 1 blocks, group 2 blocks]
// Group 2 blocks always hold exactly one more data codeword than group 1.
const VERSIONS = Object.freeze([
  null,
  { total: 26, ecPerBlock: 10, group1: 1, group2: 0 },
  { total: 44, ecPerBlock: 16, group1: 1, group2: 0 },
  { total: 70, ecPerBlock: 26, group1: 1, group2: 0 },
  { total: 100, ecPerBlock: 18, group1: 2, group2: 0 },
  { total: 134, ecPerBlock: 24, group1: 2, group2: 0 },
  { total: 172, ecPerBlock: 16, group1: 4, group2: 0 },
  { total: 196, ecPerBlock: 18, group1: 4, group2: 0 },
  { total: 242, ecPerBlock: 22, group1: 2, group2: 2 },
  { total: 292, ecPerBlock: 22, group1: 3, group2: 2 },
  { total: 346, ecPerBlock: 26, group1: 4, group2: 1 },
]);

const ALIGNMENT_CENTERS = Object.freeze([
  null, [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]);

// Remainder bits appended after the final codeword, per version.
const REMAINDER_BITS = Object.freeze([0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0]);

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255];
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generatorPolynomial(degree) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] ^= poly[position];
      next[position + 1] ^= gfMultiply(poly[position], EXP[index]);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data, ecLength) {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let index = 0; index < ecLength; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function dataCapacityBytes(version) {
  const spec = VERSIONS[version];
  const dataCodewords = spec.total - spec.ecPerBlock * (spec.group1 + spec.group2);
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
}

function smallestVersion(byteLength) {
  for (let version = 1; version < VERSIONS.length; version += 1) {
    if (byteLength <= dataCapacityBytes(version)) return version;
  }
  throw new Error("qr-content-too-long");
}

function utf8Bytes(text) {
  return [...new TextEncoder().encode(String(text))];
}

function buildCodewords(bytes, version) {
  const spec = VERSIONS[version];
  const blockCount = spec.group1 + spec.group2;
  const dataCodewords = spec.total - spec.ecPerBlock * blockCount;
  const bits = [];
  const push = (value, length) => {
    for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >> shift) & 1);
  };

  push(BYTE_MODE, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a byte boundary.
  const capacityBits = dataCodewords * 8;
  for (let index = 0; index < 4 && bits.length < capacityBits; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    codewords.push(byte);
  }
  // Alternating pad codewords fill the remaining data capacity.
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(PAD[padIndex % 2]);
    padIndex += 1;
  }

  const group1Size = Math.floor(dataCodewords / blockCount);
  const blocks = [];
  let cursor = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const size = index < spec.group1 ? group1Size : group1Size + 1;
    blocks.push(codewords.slice(cursor, cursor + size));
    cursor += size;
  }
  const ecBlocks = blocks.map((block) => errorCorrection(block, spec.ecPerBlock));

  // Interleave data codewords, then EC codewords.
  const result = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let position = 0; position < longest; position += 1) {
    for (const block of blocks) {
      if (position < block.length) result.push(block[position]);
    }
  }
  for (let position = 0; position < spec.ecPerBlock; position += 1) {
    for (const block of ecBlocks) result.push(block[position]);
  }
  return result;
}

function bchFormatBits(data, generator, generatorBitLength) {
  let value = data << (generatorBitLength - 1);
  const top = 1 << (generatorBitLength + generatorBitLength - 2);
  for (let bit = top; bit >= (1 << (generatorBitLength - 1)); bit >>= 1) {
    if (value & bit) value ^= generator * (bit / (1 << (generatorBitLength - 1)));
  }
  return value;
}

function formatInformation(mask) {
  const data = (EC_LEVEL_M << 3) | mask;
  let value = data << 10;
  for (let bit = 1 << 14; bit >= 1 << 10; bit >>= 1) {
    if (value & bit) value ^= 0x537 * (bit >> 10);
  }
  return ((data << 10) | value) ^ 0x5412;
}

function versionInformation(version) {
  let value = version << 12;
  for (let bit = 1 << 17; bit >= 1 << 12; bit >>= 1) {
    if (value & bit) value ^= 0x1f25 * (bit >> 12);
  }
  return (version << 12) | value;
}

function blankMatrix(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(matrix, row, column) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const y = row + dy;
      const x = column + dx;
      if (y < 0 || x < 0 || y >= matrix.length || x >= matrix.length) continue;
      const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
      matrix[y][x] = ring === 2 || ring > 3 ? 0 : 1;
    }
  }
}

function placeAlignment(matrix, row, column) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      matrix[row + dy][column + dx] = Math.max(Math.abs(dy), Math.abs(dx)) === 1 ? 0 : 1;
    }
  }
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const bit = index % 2 === 0 ? 1 : 0;
    matrix[6][index] = bit;
    matrix[index][6] = bit;
  }

  const centers = ALIGNMENT_CENTERS[version];
  for (const row of centers) {
    for (const column of centers) {
      // Alignment patterns never overlap the three finder patterns.
      const nearFinder = (row <= 8 && column <= 8)
        || (row <= 8 && column >= size - 9)
        || (row >= size - 9 && column <= 8);
      if (!nearFinder) placeAlignment(matrix, row, column);
    }
  }

  // Dark module plus the reserved format-information strips.
  matrix[size - 8][8] = 1;
  for (let index = 0; index <= 8; index += 1) {
    if (matrix[8][index] === -1) matrix[8][index] = 0;
    if (matrix[index][8] === -1) matrix[index][8] = 0;
  }
  // Second format copy: 8 modules along row 8 (columns size-8..size-1) and 8
  // along column 8 (rows size-8..size-1, where row size-8 is the dark module).
  for (let index = 0; index < 8; index += 1) {
    if (matrix[8][size - 1 - index] === -1) matrix[8][size - 1 - index] = 0;
    if (matrix[size - 1 - index][8] === -1) matrix[size - 1 - index][8] = 0;
  }

  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const y = Math.floor(index / 3);
      const x = index % 3;
      matrix[size - 11 + x][y] = 0;
      matrix[y][size - 11 + x] = 0;
    }
  }
}

function reservedMap(version, size) {
  const probe = blankMatrix(size);
  placeFunctionPatterns(probe, version);
  return probe.map((row) => Array.from(row, (cell) => cell !== -1));
}

function placeData(matrix, reserved, codewords, version) {
  const size = matrix.length;
  const bits = [];
  for (const codeword of codewords) {
    for (let shift = 7; shift >= 0; shift -= 1) bits.push((codeword >> shift) & 1);
  }
  for (let index = 0; index < REMAINDER_BITS[version]; index += 1) bits.push(0);

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 holds the vertical timing pattern, so the two-module column pair
    // shifts left by one once it reaches it. Without this the pair would land on
    // (7,6) and then skip column 5 entirely, shifting every later codeword.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset;
        // The zig-zag direction alternates per column pair.
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - step : step;
        if (reserved[row][column]) continue;
        matrix[row][column] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
  }
  return bitIndex;
}

function maskBit(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function applyMask(matrix, reserved, mask) {
  const size = matrix.length;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (reserved[row][column]) continue;
      if (maskBit(mask, row, column)) matrix[row][column] ^= 1;
    }
  }
}

function placeFormatInformation(matrix, mask) {
  const size = matrix.length;
  const bits = formatInformation(mask);
  // The strip is written most-significant bit first, which is the order real
  // decoders expect; reading it back with the reverse order yields a mask and EC
  // level that no scanner agrees with.
  const bitAt = (index) => (bits >> (14 - index)) & 1;

  for (let index = 0; index <= 5; index += 1) matrix[8][index] = bitAt(index);
  matrix[8][7] = bitAt(6);
  matrix[8][8] = bitAt(7);
  matrix[7][8] = bitAt(8);
  for (let index = 9; index <= 14; index += 1) matrix[14 - index][8] = bitAt(index);

  // Second copy is split unevenly: bits 0-6 run upward in column 8 from the
  // bottom edge (7 modules, stopping just short of the dark module), and bits
  // 7-14 run rightward along row 8 to the right edge (8 modules). Giving each
  // side 8 modules loses bit 7 and yields a symbol whose format strip decodes to
  // the wrong mask, so the split is verified against a reference encoder.
  for (let index = 0; index <= 6; index += 1) matrix[size - 1 - index][8] = bitAt(index);
  for (let index = 7; index <= 14; index += 1) matrix[8][size - 15 + index] = bitAt(index);

  matrix[size - 8][8] = 1;
}

function placeVersionInformation(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  const bits = versionInformation(version);
  for (let index = 0; index < 18; index += 1) {
    const bit = (bits >> index) & 1;
    const y = Math.floor(index / 3);
    const x = index % 3;
    matrix[size - 11 + x][y] = bit;
    matrix[y][size - 11 + x] = bit;
  }
}

function runPenalty(line) {
  let penalty = 0;
  let runValue = line[0];
  let runLength = 1;
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === runValue) {
      runLength += 1;
    } else {
      if (runLength >= 5) penalty += runLength - 2;
      runValue = line[index];
      runLength = 1;
    }
  }
  if (runLength >= 5) penalty += runLength - 2;
  return penalty;
}

function finderPenalty(line) {
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  let penalty = 0;
  for (let index = 0; index + 7 <= line.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < 7; offset += 1) {
      if (line[index + offset] !== pattern[offset]) { match = false; break; }
    }
    if (!match) continue;
    const before = line.slice(Math.max(0, index - 4), index);
    const after = line.slice(index + 7, index + 11);
    if (before.length === 4 && before.every((cell) => cell === 0)) penalty += 40;
    if (after.length === 4 && after.every((cell) => cell === 0)) penalty += 40;
  }
  return penalty;
}

function maskPenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;

  for (let row = 0; row < size; row += 1) {
    const line = Array.from({ length: size }, (_unused, column) => matrix[row][column]);
    penalty += runPenalty(line);
    penalty += finderPenalty(line);
  }
  for (let column = 0; column < size; column += 1) {
    const line = Array.from({ length: size }, (_unused, row) => matrix[row][column]);
    penalty += runPenalty(line);
    penalty += finderPenalty(line);
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const first = matrix[row][column];
      if (first === matrix[row][column + 1]
        && first === matrix[row + 1][column]
        && first === matrix[row + 1][column + 1]) {
        penalty += 3;
      }
    }
  }

  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) dark += matrix[row][column];
  }
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

// Returns { version, size, mask, modules } where `modules` is a size x size
// array of 0/1 rows. The caller adds the quiet zone when rendering. `forceMask`
// pins the mask pattern instead of picking the lowest-penalty one; it exists so
// tests can compare a symbol against a reference encoder mask-for-mask.
export function encodeQr(text, { forceMask = null } = {}) {
  const bytes = utf8Bytes(text);
  if (!bytes.length) throw new Error("qr-content-empty");
  const version = smallestVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version);
  const reserved = reservedMap(version, size);

  const masks = forceMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  let best = null;
  for (const mask of masks) {
    const matrix = blankMatrix(size);
    placeFunctionPatterns(matrix, version);
    placeData(matrix, reserved, codewords, version);
    applyMask(matrix, reserved, mask);
    placeFormatInformation(matrix, mask);
    placeVersionInformation(matrix, version);
    const penalty = maskPenalty(matrix);
    if (!best || penalty < best.penalty) {
      best = { penalty, mask, matrix };
    }
  }

  return {
    version,
    size,
    mask: best.mask,
    modules: best.matrix.map((row) => Array.from(row)),
  };
}

export function qrCapacityBytes(version) {
  if (!VERSIONS[version]) return 0;
  return dataCapacityBytes(version);
}
