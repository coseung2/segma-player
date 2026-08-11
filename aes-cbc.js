// Minimal AES-128/192/256 CBC decryption used as a fallback when WebCrypto
// rejects a segment (some HLS encoders omit the final PKCS#7 padding block).

function galoisMultiply(a, b) {
  let result = 0;
  while (b > 0) {
    if (b & 1) result ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1b;
    b >>= 1;
  }
  return result;
}

function buildSBoxes() {
  const box = new Uint8Array(256);
  const inverseBox = new Uint8Array(256);
  const inverse = new Uint8Array(256);
  for (let value = 1; value < 256; value += 1) {
    for (let candidate = 1; candidate < 256; candidate += 1) {
      if (galoisMultiply(value, candidate) === 1) {
        inverse[value] = candidate;
        break;
      }
    }
  }
  for (let value = 0; value < 256; value += 1) {
    const inv = inverse[value];
    let transformed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      let parity = (inv >> bit) & 1;
      for (let offset = 1; offset <= 4; offset += 1) {
        parity ^= (inv >> ((bit + 8 - offset) & 7)) & 1;
      }
      parity ^= (0x63 >> bit) & 1;
      transformed |= parity << bit;
    }
    box[value] = transformed;
    inverseBox[transformed] = value;
  }
  return { box, inverseBox };
}

const { box, inverseBox } = buildSBoxes();
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d, 0x9a];

function expandKey(keyBytes) {
  const nk = keyBytes.byteLength / 4;
  const nr = nk + 6;
  const words = [];
  for (let index = 0; index < nk; index += 1) {
    words.push([
      keyBytes[index * 4],
      keyBytes[index * 4 + 1],
      keyBytes[index * 4 + 2],
      keyBytes[index * 4 + 3],
    ]);
  }
  for (let index = nk; index < 4 * (nr + 1); index += 1) {
    let temp = words[index - 1].slice();
    if (index % nk === 0) {
      temp = [
        box[temp[1]] ^ RCON[index / nk - 1],
        box[temp[2]],
        box[temp[3]],
        box[temp[0]],
      ];
    } else if (nk > 6 && index % nk === 4) {
      temp = temp.map((value) => box[value]);
    }
    words.push([
      words[index - nk][0] ^ temp[0],
      words[index - nk][1] ^ temp[1],
      words[index - nk][2] ^ temp[2],
      words[index - nk][3] ^ temp[3],
    ]);
  }
  return { words, nr };
}

function addRoundKey(state, roundKey) {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      state[row][column] ^= roundKey[column * 4 + row];
    }
  }
}

function inverseSubBytes(state) {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      state[row][column] = inverseBox[state[row][column]];
    }
  }
}

function inverseShiftRows(state) {
  for (let row = 1; row < 4; row += 1) {
    const original = state[row].slice();
    for (let column = 0; column < 4; column += 1) {
      state[row][column] = original[(column + 4 - row) % 4];
    }
  }
}

function inverseMixColumns(state) {
  for (let column = 0; column < 4; column += 1) {
    const a0 = state[0][column];
    const a1 = state[1][column];
    const a2 = state[2][column];
    const a3 = state[3][column];
    state[0][column] = galoisMultiply(a0, 14) ^ galoisMultiply(a1, 11) ^ galoisMultiply(a2, 13) ^ galoisMultiply(a3, 9);
    state[1][column] = galoisMultiply(a0, 9) ^ galoisMultiply(a1, 14) ^ galoisMultiply(a2, 11) ^ galoisMultiply(a3, 13);
    state[2][column] = galoisMultiply(a0, 13) ^ galoisMultiply(a1, 9) ^ galoisMultiply(a2, 14) ^ galoisMultiply(a3, 11);
    state[3][column] = galoisMultiply(a0, 11) ^ galoisMultiply(a1, 13) ^ galoisMultiply(a2, 9) ^ galoisMultiply(a3, 14);
  }
}

function decryptBlock(block, { words, nr }) {
  const state = [];
  for (let row = 0; row < 4; row += 1) {
    const column = [];
    for (let columnIndex = 0; columnIndex < 4; columnIndex += 1) {
      column.push(block[columnIndex * 4 + row]);
    }
    state.push(column);
  }
  addRoundKey(state, words.slice(4 * nr, 4 * nr + 4).flat());
  for (let round = nr - 1; round >= 1; round -= 1) {
    inverseShiftRows(state);
    inverseSubBytes(state);
    addRoundKey(state, words.slice(4 * round, 4 * round + 4).flat());
    inverseMixColumns(state);
  }
  inverseShiftRows(state);
  inverseSubBytes(state);
  addRoundKey(state, words.slice(0, 4).flat());

  const output = new Uint8Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      output[column * 4 + row] = state[row][column];
    }
  }
  return output;
}

export function aesCbcDecrypt(ciphertext, keyBytes, iv) {
  if (keyBytes.byteLength !== 16 && keyBytes.byteLength !== 24 && keyBytes.byteLength !== 32) {
    throw new Error("AES 키 길이가 올바르지 않습니다.");
  }
  const data = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  if (data.byteLength === 0 || data.byteLength % 16 !== 0) {
    throw new Error("암호문 길이가 올바르지 않습니다.");
  }
  const keySchedule = expandKey(keyBytes);
  const result = new Uint8Array(data.byteLength);
  let previous = iv;
  for (let offset = 0; offset < data.byteLength; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    const decrypted = decryptBlock(block, keySchedule);
    for (let index = 0; index < 16; index += 1) {
      result[offset + index] = decrypted[index] ^ previous[index];
    }
    previous = block;
  }
  return result;
}
