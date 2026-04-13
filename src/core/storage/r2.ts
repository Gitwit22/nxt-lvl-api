import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  STORAGE_BACKEND,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
} from "../config/env.js";

/**
 * Returns true only when STORAGE_BACKEND=r2 AND all required credentials are present.
 * This is the single source of truth for which storage path to use.
 */
export function isR2Configured(): boolean {
  return (
    STORAGE_BACKEND === "r2" &&
    !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME)
  );
}

/**
 * R2 keys are relative paths like "uploads/org-id/timestamp-file.pdf".
 * Local absolute paths always start with "/" on Linux (Render).
 */
export function isR2Key(filePath: string): boolean {
  return !filePath.startsWith("/");
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

/**
 * Upload a buffer to R2.
 * Returns the public URL if R2_PUBLIC_URL is set, otherwise returns the key.
 * The key (not the URL) is what gets stored as `filePath` in the DB.
 */
export async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ key: string; fileUrl: string }> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  const fileUrl = R2_PUBLIC_URL
    ? `${R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`
    : key; // will be served via signed URL; placeholder stored in DB

  return { key, fileUrl };
}

/**
 * Download an R2 object into a Buffer.
 */
export async function downloadFromR2(key: string): Promise<Buffer> {
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Generate a time-limited signed download URL for an R2 object.
 * Defaults to 1 hour. Pass a filename to set Content-Disposition.
 */
export async function getR2SignedDownloadUrl(
  key: string,
  filename?: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    ...(filename
      ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"` }
      : {}),
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}
