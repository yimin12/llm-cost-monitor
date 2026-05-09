import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'

// Encrypted-on-disk storage for the Google refresh_token. We use Electron's
// `safeStorage` API — it wraps the macOS Keychain / Linux libsecret / Windows
// DPAPI. The encrypted ciphertext lands in a small file under userData; the
// decryption key never leaves the OS keystore.
//
// Why a file under userData instead of system Keychain directly?
// `safeStorage` doesn't expose a "named secret" API on its own — it just
// encrypts a Buffer and gives you bytes back. We persist those bytes ourselves.
// The OS keystore still backs the key.

const TOKEN_FILE_NAME = 'refresh-token.bin'

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE_NAME)
}

export class KeychainStore {
  private readonly path: string

  constructor(filePath: string = tokenPath()) {
    this.path = filePath
  }

  get isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async writeRefreshToken(token: string): Promise<void> {
    if (!this.isAvailable) {
      throw new Error(
        'safeStorage encryption unavailable on this platform — refresh token NOT persisted',
      )
    }
    const cipher = safeStorage.encryptString(token)
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, cipher, { mode: 0o600 })
  }

  async readRefreshToken(): Promise<string | null> {
    if (!this.isAvailable) return null
    let cipher: Buffer
    try {
      cipher = await readFile(this.path)
    } catch {
      return null
    }
    try {
      return safeStorage.decryptString(cipher)
    } catch (err) {
      console.warn(`keychain: refresh token decrypt failed (${(err as Error).message}); discarding`)
      return null
    }
  }

  async deleteRefreshToken(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      /* already gone */
    }
  }
}
