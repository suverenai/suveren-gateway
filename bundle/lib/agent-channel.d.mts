export interface AgentChannel {
  ready: Promise<void>;
  send(obj: unknown): void;
  close(conn: number): void;
  stop(): void;
}
export declare function startAgentChannel(opts: {
  brokerPath: string;
  socketPath: string;
  pinPath: string;
  onMessage: (msg: any, reply: (data: unknown) => void, conn: number) => void;
  onRefused?: (verdict: string) => void;
  onExit?: (code: number | null) => void;
  spawnFn?: typeof import('node:child_process').spawn;
}): AgentChannel;
export declare function createAgentHandler(opts: {
  version: string;
  isLocked: () => boolean;
}): (msg: any, reply: (data: unknown) => void) => void;
