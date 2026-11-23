/** The old dispatch (the composer that sends a task, follow-ups, answers and approvals for its tasks, hand-offs,
 *  ratings, archiving a topic, the approval policy) is off while the new dispatch is tested (2026-11-24, the repo
 *  owner: disabled now, not deleted). The daemon refuses those requests with HTTP 410 `old_dispatch_off`; the console
 *  shows the controls disabled with this note, and still lists and opens the old tasks. Turn the whole thing back on
 *  by setting OLD_DISPATCH_OFF to false. */
import { esc } from "./api.js";

export const OLD_DISPATCH_OFF = true;

/** What the views and actions read. Tests that exercise the old dispatch turn it back on with `setOldDispatchOff`. */
let off = OLD_DISPATCH_OFF;
export const oldDispatchOff = () => off;
export const setOldDispatchOff = (value) => { off = !!value; };

export const OLD_DISPATCH_NOTE = "旧调度已停用，新调度测试中。";

/** `disabled title="…"` for a control of the old dispatch while it is off, else nothing. */
export const offAttrs = () => (off ? ` disabled title="${esc(OLD_DISPATCH_NOTE)}" aria-disabled="true"` : "");

/** In place of the composer: what is off, and the way to the terminals. */
export const offNotice = () => `<section class="compose off-notice" role="status"><div class="l1"><span class="dz" aria-hidden="true"></span><b>Dispatch Off</b><span class="faint">${esc(OLD_DISPATCH_NOTE)}</span><span class="sp"></span><a href="/ui/terminal.html" class="out">Terminals ↗</a></div><div class="faint small">旧任务仍可查看。</div></section>`;

/** A small note beside a control that is off. */
export const offNote = () => `<div class="note off-note" role="note">${esc(OLD_DISPATCH_NOTE)}</div>`;
