/** Chunked to stay under the JS argument-count limit that a spread over a
 *  whole file's bytes would hit. One copy, this had grown to four. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Tolerates data-URL prefixes and whitespace, matching the upstream
 *  portable-filesystem decoder. */
export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
  const binary = atob(normalized.replace(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
