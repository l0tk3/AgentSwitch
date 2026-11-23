/** The old dispatch (tasks the router routes to an executor, the assistant, task pages; docs/dispatch-v0.md) is off
 *  while its replacement, built on Chat Rooms, is tested (user decision, 2026-11-24): turned off, not deleted. Its
 *  submitting routes refuse with 410; reading old tasks and threads stays. Set this to false to bring it back. */
export const OLD_DISPATCH_OFF = true;

/** What a refused submission says (and its machine-readable code). */
export const OLD_DISPATCH_OFF_ERROR = "旧调度已停用，新调度测试中";
export const OLD_DISPATCH_OFF_CODE = "old_dispatch_off";
export const oldDispatchOffBody = { error: OLD_DISPATCH_OFF_ERROR, code: OLD_DISPATCH_OFF_CODE } as const;

/** Whether the old dispatch is off for these dependencies: `oldDispatchOff` (tests of the engine set it false), else the
 *  constant. */
export function oldDispatchOff(deps: { readonly oldDispatchOff?: boolean }): boolean {
  return deps.oldDispatchOff ?? OLD_DISPATCH_OFF;
}
