/** The engine kit as the running service makes it: on its own folder, with the real check. */

import { EngineKit, engineRoot } from "./kit.js";
import { engineSelfCheck } from "./selfCheck.js";
import { EngineStore } from "./store.js";

export function newEngineKit(home: string): EngineKit {
  const root = engineRoot(home);
  return new EngineKit({ root, selfCheck: engineSelfCheck(new EngineStore(root)) });
}
