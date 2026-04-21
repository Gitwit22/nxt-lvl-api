import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  STORAGE_BACKEND,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
  R2_DEFAULT_PREFIX,
} from "../config/env.js";

export interface R2ConnectionConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl?: string;
}

export interface R2EnvMetadata {
  available: boolean;
  configuredForActiveBackend: boolean;
  bucketName: string;
  accountId: string;
  endpoint: string;
  publicUrl: string;
  defaultPrefix: string;
}

export interface R2ProbeResult {
  success: boolean;
  message: string;
  key?: string;
  step?: "write" | "read" | "verify" | "delete";
  error?: string;
}

function normalizePrefix(prefix: string): string {
  return prefix
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normalizeProbePrefix(prefix?: string): string {
  const resolved = normalizePrefix(prefix || R2_DEFAULT_PREFIX || "");
  return resolved ? `${resolved}/` : "";
}

function streamToBuffer(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  return (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
}

function createClient(config: R2ConnectionConfig): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function getEnvConnectionConfig(): R2ConnectionConfig {
  return {
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucketName: R2_BUCKET_NAME,
    publicUrl: R2_PUBLIC_URL,
  };
}

export function isR2EnvAvailable(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME);
}

export function getR2EnvMetadata(): R2EnvMetadata {
  const available = isR2EnvAvailable();
  return {
    available,
    configuredForActiveBackend: STORAGE_BACKEND === "r2" && available,
    bucketName: R2_BUCKET_NAME,
    accountId: R2_ACCOUNT_ID,
    endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "",
    publicUrl: R2_PUBLIC_URL,
    defaultPrefix: normalizePrefix(R2_DEFAULT_PREFIX),
  };
}

/**
 * Returns true only when STORAGE_BACKEND=r2 AND all required credentials are present.
 * This is the single source of truth for which storage path to use.
 */
export function isR2Configured(): boolean {
  return STORAGE_BACKEND === "r2" && isR2EnvAvailable();
}

/**
 * R2 keys are relative paths like "uploads/org-id/timestamp-file.pdf".
 * Local absolute paths always start with "/" on Linux (Render).
 */
export function isR2Key(filePath: string): boolean {
  return !filePath.startsWith("/");
}

function resolveR2ObjectKey(locator: string): string {
  const value = locator.trim();
  if (!value) return "";

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const parsed = new URL(value);

      if (R2_PUBLIC_URL) {
        const publicBase = new URL(R2_PUBLIC_URL);
        if (parsed.host !== publicBase.host) {
          return "";
        }

        const publicPrefix = publicBase.pathname.replace(/\/+$/, "").replace(/^\/+/, "");
        const rawPath = parsed.pathname.replace(/^\/+/, "");
        if (!publicPrefix) {
          return rawPath;
        }

        if (rawPath === publicPrefix) {
          return "";
        }

        if (rawPath.startsWith(`${publicPrefix}/`)) {
          return rawPath.slice(publicPrefix.length + 1);
        }

        return "";
      }

      return parsed.pathname.replace(/^\/+/, "");
    } catch {
      return "";
    }
  }

  return value.replace(/^\/+/, "");
}

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = createClient(getEnvConnectionConfig());
  }
  return _client;
}

export async function probeR2Connection(options?: {
  prefix?: string;
  config?: R2ConnectionConfig;
}): Promise<R2ProbeResult> {
  const config = options?.config || getEnvConnectionConfig();
  if (!config.accountId || !config.accessKeyId || !config.secretAccessKey || !config.bucketName) {
    return {
      success: false,
      step: "write",
      message: "R2 credentials are incomplete.",
      error: "missing_r2_configuration",
    };
  }

  const client = options?.config ? createClient(config) : getClient();
  const prefix = normalizeProbePrefix(options?.prefix);
  const key = `${prefix}.connection-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const payload = Buffer.from(`community-chronicle-r2-probe:${Date.now()}`, "utf8");
  let writeSucceeded = false;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucketName,
        Key: key,
        Body: payload,
        ContentType: "text/plain",
      }),
    );
    writeSucceeded = true;
  } catch (error) {
    return {
      success: false,
      key,
      step: "write",
      message: "Failed to write probe object to R2.",
      error: error instanceof Error ? error.message : "unknown_write_error",
    };
  }

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      }),
    );
    const body = await streamToBuffer(response.Body as AsyncIterable<Uint8Array>);
    if (!body.equals(payload)) {
      return {
        success: false,
        key,
        step: "verify",
        message: "Probe object verification failed after read.",
        error: "probe_content_mismatch",
      };
    }
  } catch (error) {
    return {
      success: false,
      key,
      step: "read",
      message: "Failed to read probe object from R2.",
      error: error instanceof Error ? error.message : "unknown_read_error",
    };
  }

  if (writeSucceeded) {
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: config.bucketName,
          Key: key,
        }),
      );
    } catch (error) {
      return {
        success: false,
        key,
        step: "delete",
        message: "Probe object was written and read, but cleanup failed.",
        error: error instanceof Error ? error.message : "unknown_delete_error",
      };
    }
  }

  return {
    success: true,
    key,
    message: "R2 connection test succeeded with write/read/delete probe.",
  };
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
  options?: {
    bucketName?: string;
  },
): Promise<{ key: string; fileUrl: string }> {
  const bucketName = options?.bucketName || R2_BUCKET_NAME;
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucketName,
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
  const bucketName = R2_BUCKET_NAME;
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
  );
  return streamToBuffer(response.Body as AsyncIterable<Uint8Array>);
}

/**
 * Delete an R2 object by key or URL-like locator.
 * Returns false when the locator cannot be resolved to this configured bucket.
 */
export async function deleteFromR2(
  locator: string,
  options?: {
    bucketName?: string;
  },
): Promise<boolean> {
  const key = resolveR2ObjectKey(locator);
  if (!key) {
    return false;
  }

  const bucketName = options?.bucketName || R2_BUCKET_NAME;

  await getClient().send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
  );

  return true;
}

/**
 * Generate a time-limited signed download URL for an R2 object.
 * Defaults to 1 hour. Pass a filename to set Content-Disposition.
 */
export async function getR2SignedDownloadUrl(
  key: string,
  options?: {
    filename?: string;
    expiresIn?: number;
    disposition?: "attachment" | "inline";
    bucketName?: string;
  },
): Promise<string> {
  const filename = options?.filename;
  const expiresIn = options?.expiresIn ?? 3600;
  const disposition = options?.disposition ?? "attachment";
  const bucketName = options?.bucketName || R2_BUCKET_NAME;

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ...(filename
      ? { ResponseContentDisposition: `${disposition}; filename="${filename.replace(/"/g, "")}"` }
      : {}),
  });
  return getSignedUrl(getClient(), command, { expiresIn });
}
