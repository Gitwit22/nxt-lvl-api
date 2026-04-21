/**
 * R2StorageAdapter
 *
 * Wraps the low-level r2.ts utilities behind the StorageAdapter interface.
 * Requires an explicit R2ConnectionConfig so it works with either the
 * global env credentials OR per-tenant manually configured credentials.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageAdapter, StorageUploadResult } from "./adapter.js";

export interface R2AdapterConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** Optional permanent public URL base (e.g. https://pub-xxx.r2.dev). */
  publicUrl?: string;
}

export class R2StorageAdapter implements StorageAdapter {
  readonly backendId: string;
  private readonly config: R2AdapterConfig;
  private readonly client: S3Client;

  constructor(config: R2AdapterConfig, label = "r2") {
    this.config = config;
    this.backendId = label;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<StorageUploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    const fileUrl = this.config.publicUrl
      ? `${this.config.publicUrl.replace(/\/$/, "")}/${key}`
      : key;
    return { key, fileUrl };
  }

  async delete(locator: string): Promise<boolean> {
    const key = this._resolveKey(locator);
    if (!key) return false;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: key }),
    );
    return true;
  }

  async getDownloadUrl(
    locator: string,
    options?: { filename?: string; disposition?: "attachment" | "inline"; expiresIn?: number },
  ): Promise<string> {
    const key = this._resolveKey(locator) || locator;
    const disposition = options?.disposition ?? "attachment";
    const expiresIn = options?.expiresIn ?? 3600;
    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      ...(options?.filename
        ? {
            ResponseContentDisposition: `${disposition}; filename="${options.filename.replace(/"/g, "")}"`,
          }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  ownsKey(key: string): boolean {
    // R2 keys are relative (no leading slash) and not absolute local paths.
    return !!key && !key.startsWith("/") && !key.startsWith("\\");
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _resolveKey(locator: string): string {
    const value = locator.trim();
    if (!value) return "";

    if (value.startsWith("http://") || value.startsWith("https://")) {
      try {
        const parsed = new URL(value);
        if (this.config.publicUrl) {
          const base = new URL(this.config.publicUrl);
          if (parsed.host !== base.host) return "";
          const publicPrefix = base.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
          const rawPath = parsed.pathname.replace(/^\/+/, "");
          if (!publicPrefix) return rawPath;
          if (rawPath === publicPrefix) return "";
          if (rawPath.startsWith(`${publicPrefix}/`)) return rawPath.slice(publicPrefix.length + 1);
          return "";
        }
        return parsed.pathname.replace(/^\/+/, "");
      } catch {
        return "";
      }
    }

    return value.replace(/^\/+/, "");
  }
}
