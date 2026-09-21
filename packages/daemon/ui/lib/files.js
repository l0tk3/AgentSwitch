/** Attachments on the client side: pending files before submit, upload, size and type helpers. */

import { esc } from "./api.js";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/i;
export const isImage = (name) => IMAGE_RE.test(name);

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Wrap File objects with a preview URL; the URL is revoked when the entry is dropped. */
export const toPending = (files) => [...files].map((file) => ({ file, url: isImage(file.name) ? URL.createObjectURL(file) : null }));
export const releasePending = (list) => list.forEach((p) => p.url && URL.revokeObjectURL(p.url));

/** POST /uploads with every pending file; resolves to the staged ids in order. */
export async function uploadPending(list) {
  if (!list.length) return [];
  const form = new FormData();
  for (const p of list) form.append("files", p.file, p.file.name);
  const r = await fetch("/uploads", { method: "POST", body: form });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "上传失败 HTTP " + r.status);
  return d.files.map((f) => f.id);
}

/** Pending list under a composer: thumbnails for images, name + size for the rest, a remove button each. */
export function pendingList(list) {
  if (!list.length) return "";
  const items = list.map((p, i) => `<div class="attach">${p.url ? `<img src="${p.url}" alt="">` : `<span class="attach-ico">📄</span>`}<span class="ellipsis">${esc(p.file.name)}</span><span class="dim">${fmtSize(p.file.size)}</span><button class="small" data-pending-remove="${i}" title="移除">×</button></div>`).join("");
  return `<div class="attach-list">${items}</div>`;
}

/** Files of a task (attachments or outputs), images inline, everything downloadable. */
export function fileList(taskId, files, emptyText) {
  if (!files.length) return `<div class="dim">${esc(emptyText)}</div>`;
  const href = (p) => `/tasks/${encodeURIComponent(taskId)}/files/${p.split("/").map(encodeURIComponent).join("/")}`;
  return files.map((f) => {
    const name = f.path.split("/").pop();
    return `<div class="file">${isImage(name) ? `<a href="${href(f.path)}" target="_blank"><img src="${href(f.path)}" alt="${esc(name)}"></a>` : ""}
      <div class="row"><a class="grow ellipsis" href="${href(f.path)}" download="${esc(name)}">${esc(f.path)}</a><span class="dim">${fmtSize(f.size)}</span></div></div>`;
  }).join("");
}
