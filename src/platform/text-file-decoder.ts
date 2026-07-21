export type DetectedTextEncoding = "utf8" | "utf16le" | "utf16be";

export function decodeTextBuffer(buffer: Buffer): { text: string; encoding: DetectedTextEncoding } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: stripBom(buffer.toString("utf16le")), encoding: "utf16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: stripBom(decodeUtf16Be(buffer.subarray(2))), encoding: "utf16be" };
  }

  const sampleLength = Math.min(buffer.length, 512);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  const pairCount = Math.max(1, Math.floor(sampleLength / 2));
  if (oddNulls / pairCount > 0.2 && oddNulls > evenNulls * 2) {
    return { text: stripBom(buffer.toString("utf16le")), encoding: "utf16le" };
  }
  if (evenNulls / pairCount > 0.2 && evenNulls > oddNulls * 2) {
    return { text: stripBom(decodeUtf16Be(buffer)), encoding: "utf16be" };
  }
  return { text: stripBom(buffer.toString("utf8")), encoding: "utf8" };
}

function decodeUtf16Be(buffer: Buffer): string {
  const length = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString("utf16le");
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
