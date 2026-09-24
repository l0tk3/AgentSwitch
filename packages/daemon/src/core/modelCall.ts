/** One text-only model call: a `Router` turns a system text and a task into raw model text; parsing and policy live
 *  elsewhere. Every model role uses this shape (dispatcher, planner, loop, supervisor, summarizer, sealer, credential
 *  repair), so it sits below all of them; the implementations are router/routers/*. */

export type RouterInput = {
  readonly task: string;
  readonly cwd: string;
  readonly system: string;
  readonly previousError?: string;
};

export type RouterReply = {
  readonly text: string;
  readonly elapsedMs: number;
};

export interface Router {
  readonly name: string;
  route(input: RouterInput, signal: AbortSignal): Promise<RouterReply>;
}
