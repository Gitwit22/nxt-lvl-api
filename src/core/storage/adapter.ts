/**
 * Storage adapter interface.
 *
 * All storage backends implement this interface so upload, delete, download,
 * and URL generation use the same code path regardless of backend.
 */

export interface StorageUploadResult {
  /** The stable key/path to store in the DB (R2 key or absolute local path). */
  key: string;
  /** Public URL for direct access, or the key itself when signed URLs are required. */
  fileUrl: string;
}

export interface StorageAdapter {
  /** Backend identifier for logging. */
  readonly backendId: string;

  /** Upload a file buffer and return the stored key + URL. */
  upload(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<StorageUploadResult>;

  /**
   * Delete a stored file.
   * @param key - The key/path returned by `upload`.
   * @returns `true` if deleted, `false` if not found / skipped.
   */
  delete(key: string): Promise<boolean>;

  /**
   * Resolve a time-limited download URL for key.
   * For public buckets this may be a permanent URL.
   */
  getDownloadUrl(
    key: string,
    options?: {
      filename?: string;
      disposition?: "attachment" | "inline";
      expiresIn?: number;
    },
  ): Promise<string>;

  /**
   * Return `true` if this adapter handles the given key/locator
   * (used to decide whether a stored filePath belongs to this backend).
   */
  ownsKey(key: string): boolean;
}
