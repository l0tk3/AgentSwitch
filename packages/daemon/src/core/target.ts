/** One model on one agent, as the catalog names it (models/targets.ts). */

import { z } from "zod";

export const TargetRef = z.object({ harness: z.string().min(1), model: z.string().min(1) });
export type TargetRef = z.infer<typeof TargetRef>;
