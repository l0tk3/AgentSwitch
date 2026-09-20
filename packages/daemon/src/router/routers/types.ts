/** A router turns a task into raw model text; parsing and policy live elsewhere. */

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
