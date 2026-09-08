const fs = require('fs');

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (!Number.isFinite(length) || length < 2) break;
    offset += length + 2;
  }
  return null;
}

function webpDimensions(buffer) {
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buffer.length >= 30) return {
    width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3)
  };
  if (kind === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ' && buffer.length >= 30) return {
    width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff
  };
  return null;
}

function readImageDimensions(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  let dimensions = null;
  if (mimeType === 'image/png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (mimeType === 'image/jpeg' && buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    dimensions = jpegDimensions(buffer);
  } else if (mimeType === 'image/webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    dimensions = webpDimensions(buffer);
  }
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error('The uploaded image dimensions could not be read.');
  const longest = Math.max(dimensions.width, dimensions.height);
  const scale = longest > 2400 ? 2400 / longest : 1;
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale))
  };
}

module.exports = { readImageDimensions };
