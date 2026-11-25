// Minimal protobuf encoder/decoder - just enough for the Doubao interpretation (AST) messages.
// Wire types: 0 = varint, 2 = length-delimited (string / bytes / nested message).

function varint(n) {
  const out = [];
  n = Number(n);
  while (n > 0x7f) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

// Encodes a message from a list of [fieldNumber, value] pairs.
// Value types: number/boolean -> varint, string/Buffer -> bytes, array -> nested message.
export function encode(fields) {
  const parts = [];
  for (const [field, value] of fields) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(varint(field * 8), varint(Number(value)));
    } else {
      const bytes = Array.isArray(value) ? encode(value) : Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      parts.push(varint(field * 8 + 2), varint(bytes.length), bytes);
    }
  }
  return Buffer.concat(parts);
}

// Decodes into { fieldNumber: [values...] }; varints become numbers, everything else Buffers.
export function decode(buf) {
  const fields = {};
  let pos = 0;
  const readVarint = () => {
    let result = 0;
    let mult = 1;
    let byte;
    do {
      byte = buf[pos++];
      result += (byte & 0x7f) * mult;
      mult *= 128;
    } while (byte & 0x80);
    return result;
  };
  while (pos < buf.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const len = readVarint();
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) { value = buf.readDoubleLE(pos); pos += 8; }
    else if (wire === 5) { value = buf.readFloatLE(pos); pos += 4; }
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
    (fields[field] ??= []).push(value);
  }
  return fields;
}

export const str = (fields, n) => (fields[n]?.[0] ? fields[n][0].toString('utf8') : '');
export const num = (fields, n) => fields[n]?.[0] ?? 0;
