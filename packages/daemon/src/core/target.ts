/** A selectable executor: one model on one harness. The identity every layer passes around (catalog, decisions, track
 *  record, thread handoffs); the catalog itself is router/targets.ts. */

import { z } from "zod";

export const TargetRef = z.object({ harness: z.string().min(1), model: z.string().min(1) });
export type TargetRef = z.infer<typeof TargetRef>;
