/**
 * LocalStorageAdapter
 *
 * Writes files to the local filesystem (dev-only fallback).
 * getDownloadUrl returns an API-relative path that the Express layer serves.
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import type { StorageAdapter, StorageUploadResult } from "./adapter.js";
import { UPLOAD_DIR, BACKEND_URL } from "../config/env.js";

function buildFileUrl(relativePath: string): string {
  if (BACKEND_URL && !BACKEND_URL.startsWith("http://localhost")) {
    return `${BACKEND_URL.replace(/\/$/, "")}${relativePath}`;
  }
  return relativePath;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly backendId = "local";

  async upload(key: string, buffer: Buffer, _contentType: string): Promise<StorageUploadResult> {
    // `key` here is the desired filename (not a full path).
    const localPath = path.join(UPLOAD_DIR, key);
    await fsPromises.mkdir(path.dirname(localPath), { recursive: true });
    await fsPromises.writeFile(localPath, buffer);
    return {
      key: localPath,
      fileUrl: buildFileUrl(`/uploads/${key}`),
    };
  }

  async delete(filePath: string): Promise<boolean> {
    if (!filePath.startsWith("/") && !filePath.startsWith("\\")) return false;
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  async getDownloadUrl(filePath: string): Promise<string> {
    const filename = path.basename(filePath);
    return buildFileUrl(`/uploads/${filename}`);
  }

  ownsKey(key: string): boolean {
    return key.startsWith("/") || key.startsWith("\\");
  }
}
