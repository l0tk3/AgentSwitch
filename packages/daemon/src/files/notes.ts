/** The attachments paragraph appended to what the router and the executor read. */

import { formatBytes, OUT_DIR } from "./names.js";
import type { Attachment } from "./uploads.js";

export function attachmentsNote(attachments: readonly Attachment[]): string {
  if (!attachments.length) return "";
  const lines = attachments.map((a) => `- ${a.path} (${formatBytes(a.size)}, ${a.type})`);
  return `\n\nAttached files (paths relative to the working directory; read them, they are part of the task):\n${lines.join("\n")}\nAnything the user should get back as a file goes in ./${OUT_DIR}/ (images, documents, exports).`;
}
