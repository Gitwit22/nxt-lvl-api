import multer from "multer";
import path from "path";
import type { Request } from "express";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, UPLOAD_DIR } from "./core/config/env.js";

export const uploadStorage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb) => cb(null, UPLOAD_DIR),
  filename: (_req: Request, file: Express.Multer.File, cb) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${stamp}-${safe}`);
  },
});

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
): void {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(
      Object.assign(new Error(`File type '${file.mimetype}' is not permitted`), {
        status: 415,
      }),
    );
    return;
  }
  const ext = path.extname(file.originalname).toLowerCase();
  const dangerousExtensions = new Set([
    ".exe", ".bat", ".cmd", ".sh", ".ps1", ".msi", ".dll", ".so",
    ".bin", ".com", ".vbs", ".js", ".ts", ".py", ".php", ".rb",
  ]);
  if (dangerousExtensions.has(ext)) {
    cb(Object.assign(new Error(`File extension '${ext}' is not permitted`), { status: 415 }));
    return;
  }
  cb(null, true);
}

export const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});
