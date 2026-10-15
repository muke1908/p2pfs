import type { StateStore } from '../config/state.js';
import { AppError } from '../security/auth.js';

export const MAX_WHITEPAD_LENGTH = 1_000_000;
export interface SharedWhitepad {
  content: string;
  revision: number;
  updated: number;
}

export function isWhitepad(value: unknown): value is SharedWhitepad {
  if (!value || typeof value !== 'object') return false;
  const pad = value as Record<string, unknown>;
  return (
    typeof pad.content === 'string' &&
    pad.content.length <= MAX_WHITEPAD_LENGTH &&
    Number.isSafeInteger(pad.revision) &&
    Number(pad.revision) >= 0 &&
    Number.isSafeInteger(pad.updated) &&
    Number(pad.updated) >= 0
  );
}

export class Whitepad {
  private current: SharedWhitepad;
  private tail: Promise<void> = Promise.resolve();

  constructor(private store: StateStore) {
    this.current = store.state.whitepad;
  }

  get(): SharedWhitepad {
    return { ...this.current };
  }

  async update(content: string, revision: number): Promise<SharedWhitepad> {
    const operation = this.tail.then(async () => {
      if (revision !== this.current.revision)
        throw new AppError(
          409,
          'The whitepad changed in another window. Keep your text or use the saved text.',
        );
      const next = {
        content,
        revision: revision + 1,
        updated: Date.now(),
      };
      if (!isWhitepad(next))
        throw new AppError(
          400,
          'Whitepad text must be at most 1,000,000 characters.',
        );
      if (content === this.current.content) return this.get();
      this.store.state.whitepad = next;
      try {
        await this.store.save();
        this.current = next;
      } catch (error) {
        this.store.state.whitepad = this.current;
        throw error;
      }
      return this.get();
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
