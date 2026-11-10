import type { CloudPublishAssetPlatform } from '@zennotes/shared-domain/cloud-publish-uploads'
import { secureDirectUploadUrl, type MobileObjectUpload } from './mobile-direct-upload'

/** A file in the open vault, fingerprinted natively: its bytes never enter
 *  the WebView. */
export interface MobilePublishFileFingerprint {
  uri: string
  sha256: string
  byteLength: number
}

/** How a staged publish reaches the vault's files on this device. */
export interface MobilePublishAssetFiles {
  /** Native SHA-256 and length of a local vault file, or null when the vault
   *  is remote (its files only arrive as bytes). */
  fingerprint(vaultRelativePath: string): Promise<MobilePublishFileFingerprint | null>
  readBase64(vaultRelativePath: string): Promise<string>
}

type MobilePublishAssetHandle = { uri: string } | { base64: string }

/**
 * The phone side of a staged publish (publishWithStagedUploads in
 * shared-domain): a local vault's attachments are hashed and streamed to
 * their presigned URLs by the native uploader, as sync's large files are, so
 * a 100 MB note never passes through JavaScript. A remote vault's files come
 * over its server as base64 and are hashed here.
 */
export function mobilePublishAssetPlatform(
  files: MobilePublishAssetFiles,
  uploadObject: MobileObjectUpload
): CloudPublishAssetPlatform<MobilePublishAssetHandle> {
  return {
    async describe(asset) {
      const local = await files.fingerprint(asset.path)
      if (local) return { byteLength: local.byteLength, sha256: local.sha256, handle: { uri: local.uri } }
      const base64 = await files.readBase64(asset.path)
      const bytes = base64Bytes(base64)
      return { byteLength: bytes.byteLength, sha256: await sha256Hex(bytes), handle: { base64 } }
    },
    async upload(target, asset) {
      const headers = { ...target.headers }
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = asset.mime
      }
      const request = { url: secureDirectUploadUrl(target.url), method: 'PUT' as const, headers, byteLength: asset.byteLength }
      await uploadObject('uri' in asset.handle
        ? { ...request, uri: asset.handle.uri, sha256: asset.sha256 }
        : { ...request, base64: asset.handle.base64, sha256: asset.sha256 })
    },
    readBase64: (asset) => files.readBase64(asset.path)
  }
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
