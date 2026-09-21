/** File naming rules and limits shared by uploads, attachments and downloads. */

import { basename, extname } from "node:path";

/** Uploaded attachments land here, relative to the task's working directory. */
export const ATTACH_DIR = "in";
/** Executors put deliverables for the user here; copied to $AGENTSWITCH_HOME/artifacts/<taskId>/ before an ephemeral cwd is deleted. */
export const OUT_DIR = "out";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;
export const MAX_NAME_LENGTH = 120;
export const UPLOAD_TTL_MS = 24 * 3600_000;
export const ARTIFACT_TTL_MS = 7 * 86400_000;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".avif"]);
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".bmp": "image/bmp", ".heic": "image/heic", ".avif": "image/avif",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json",
  ".csv": "text/csv; charset=utf-8", ".html": "text/html; charset=utf-8", ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Basename only, no control characters or path separators, never a dotfile, bounded length. */
export function safeName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f/]/g, "_").trim();
  const noDot = base.startsWith(".") ? "_" + base.slice(1) : base;
  if (!noDot) return "file";
  if (noDot.length <= MAX_NAME_LENGTH) return noDot;
  const ext = extname(noDot).slice(0, 16);
  return noDot.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

export const isImage = (name: string): boolean => IMAGE_EXT.has(extname(name).toLowerCase());
export const contentType = (name: string): string => TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
