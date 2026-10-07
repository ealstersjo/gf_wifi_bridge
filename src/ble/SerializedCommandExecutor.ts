import {GrainfatherState} from '../protocol/GrainfatherState';

export interface CommandStatus {
  state: 'IDLE' | 'PENDING' | 'CONFIRMED' | 'FAILED';
  description?: string;
  detail?: string;
}

interface CommandSpec {
  description: string;
  payload: Uint8Array;
  confirmationSource: 'X' | 'Y' | 'T' | 'W';
  isConfirmed: (state: GrainfatherState) => boolean;
}

interface PendingCommand extends CommandSpec {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** One in-flight write, confirmed only by later controller notifications. */
export class SerializedCommandExecutor {
  private pending: PendingCommand | null = null;

  constructor(
    private readonly isConnected: () => boolean,
    private readonly write: (payload: Uint8Array) => Promise<void>,
    private readonly onStatus: (status: CommandStatus) => void,
    private readonly timeoutMs = 6_000,
  ) {}

  execute(spec: CommandSpec): Promise<void> {
    if (!this.isConnected()) {
      const error = new Error('G30 is not connected and ready for commands');
      this.onStatus({state: 'FAILED', description: spec.description, detail: error.message});
      return Promise.reject(error);
    }
    if (this.pending) {
      return Promise.reject(new Error(`Command already pending: ${this.pending.description}`));
    }

    return new Promise<void>((resolve, reject) => {
      let pending: PendingCommand;
      const timeout = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        const error = new Error('Timed out waiting for controller confirmation');
        this.onStatus({state: 'FAILED', description: spec.description, detail: error.message});
        reject(error);
      }, this.timeoutMs);
      pending = {...spec, resolve, reject, timeout};
      this.pending = pending;
      this.onStatus({state: 'PENDING', description: spec.description});

      this.write(spec.payload).catch(cause => {
        if (this.pending !== pending) return;
        clearTimeout(this.pending.timeout);
        this.pending = null;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.onStatus({state: 'FAILED', description: spec.description, detail: error.message});
        reject(error);
      });
    });
  }

  observe(state: GrainfatherState, source: 'X' | 'Y' | 'T' | 'W'): void {
    if (
      !this.pending ||
      this.pending.confirmationSource !== source ||
      !this.pending.isConfirmed(state)
    ) return;
    const completed = this.pending;
    clearTimeout(completed.timeout);
    this.pending = null;
    this.onStatus({state: 'CONFIRMED', description: completed.description});
    completed.resolve();
  }

  cancel(detail: string): void {
    if (!this.pending) return;
    const cancelled = this.pending;
    clearTimeout(cancelled.timeout);
    this.pending = null;
    const error = new Error(detail);
    this.onStatus({state: 'FAILED', description: cancelled.description, detail});
    cancelled.reject(error);
  }
}
