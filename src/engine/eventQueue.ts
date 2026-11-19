/**
 * Single-consumer FIFO event queue with authoritative epoch gating.
 *
 * Implements in-memory sequential queuing for EngineEvents yielded
 * by SessionOrchestrator to UI/CLI consumers.
 */

import type { EngineEvent, TerminalEvent } from '../types/contract.ts';

/**
 * Type guard identifying whether an EngineEvent is a TerminalEvent.
 */
export function isTerminalEvent(event: EngineEvent): event is TerminalEvent {
  return (
    event.type === 'run.completed' ||
    event.type === 'run.cancelled' ||
    event.type === 'run.failed'
  );
}

/**
 * Single-consumer asynchronous FIFO queue with authoritative epoch filtering.
 *
 * Guarantees:
 * 1. Strict FIFO event delivery to a single consumer.
 * 2. Stale event rejection: events pushed by background producers whose epoch
 *    does not match the authoritative epoch are discarded immediately.
 * 3. Authoritative terminal delivery: `pushTerminal()` bypasses producer epoch checks
 *    so terminal events are delivered during run finalization even if the epoch
 *    was incremented to cancel background streams.
 * 4. Terminal invariant: at most one terminal event can ever be queued or delivered;
 *    any subsequent events are rejected.
 * 5. Idempotent closure: `close()` drains existing items, then terminates iteration.
 * 6. Immediate consumer termination: iterator `return()` terminates iteration immediately,
 *    safely resolving any pending `next()` and guaranteeing all subsequent `next()` calls
 *    return `{ done: true, value: undefined }` without draining residual buffer.
 */
export class SingleConsumerEventQueue implements AsyncIterable<EngineEvent> {
  private readonly buffer: EngineEvent[] = [];
  private pendingConsumer: ((result: IteratorResult<EngineEvent>) => void) | null = null;
  private isClosed = false;
  private hasTerminal = false;
  private hasDeliveredTerminal = false;
  private consumerActive = false;
  private isIteratorReturned = false;

  constructor(private readonly getAuthoritativeEpoch: () => number) {}

  /**
   * Enqueues an event from a producer matching the authoritative epoch.
   * Rejects events if closed, if a terminal event was already accepted, or if epoch mismatches.
   */
  public push(event: EngineEvent, producerEpoch: number): boolean {
    if (this.isClosed || this.hasTerminal) {
      return false;
    }

    if (producerEpoch !== this.getAuthoritativeEpoch()) {
      return false;
    }

    if (isTerminalEvent(event)) {
      this.hasTerminal = true;
    }

    if (this.pendingConsumer) {
      const resolve = this.pendingConsumer;
      this.pendingConsumer = null;
      if (isTerminalEvent(event)) {
        this.hasDeliveredTerminal = true;
      }
      resolve({ done: false, value: event });
      return true;
    }

    this.buffer.push(event);
    return true;
  }

  /**
   * Enqueues an authoritative terminal event during run finalization.
   * Bypasses producer epoch checks, but enforces single-terminal and closed-queue invariants.
   */
  public pushTerminal(event: TerminalEvent): boolean {
    if (this.isClosed || this.hasTerminal) {
      return false;
    }

    this.hasTerminal = true;

    if (this.pendingConsumer) {
      const resolve = this.pendingConsumer;
      this.pendingConsumer = null;
      this.hasDeliveredTerminal = true;
      resolve({ done: false, value: event });
      return true;
    }

    this.buffer.push(event);
    return true;
  }

  /**
   * Idempotently closes the queue.
   * Buffered events remain consumable. Once drained, subsequent reads finish cleanly.
   */
  public close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;

    if (this.pendingConsumer) {
      const resolve = this.pendingConsumer;
      this.pendingConsumer = null;
      resolve({ done: true, value: undefined });
    }
  }

  /**
   * Number of events currently buffered in memory.
   */
  public get length(): number {
    return this.buffer.length;
  }

  /**
   * Whether the queue has been closed.
   */
  public get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Whether the consumer iterator has called return() to terminate iteration early.
   */
  public get returned(): boolean {
    return this.isIteratorReturned;
  }

  /**
   * Whether a terminal event has been accepted into the queue.
   */
  public get terminalEnqueued(): boolean {
    return this.hasTerminal;
  }

  /**
   * Asynchronous iterator interface for single-consumer consumption.
   */
  public [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
    if (this.consumerActive) {
      throw new Error('SingleConsumerEventQueue allows only one active consumer iterator');
    }
    this.consumerActive = true;

    return {
      next: async (): Promise<IteratorResult<EngineEvent>> => {
        if (this.isIteratorReturned || this.hasDeliveredTerminal) {
          return { done: true, value: undefined };
        }

        if (this.buffer.length > 0) {
          const event = this.buffer.shift()!;
          if (isTerminalEvent(event)) {
            this.hasDeliveredTerminal = true;
          }
          return { done: false, value: event };
        }

        if (this.isClosed) {
          return { done: true, value: undefined };
        }

        if (this.pendingConsumer) {
          throw new Error('Concurrent next() calls on SingleConsumerEventQueue are not supported');
        }

        return new Promise<IteratorResult<EngineEvent>>((resolve) => {
          this.pendingConsumer = resolve;
        });
      },

      return: async (): Promise<IteratorResult<EngineEvent>> => {
        this.isIteratorReturned = true;
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}
