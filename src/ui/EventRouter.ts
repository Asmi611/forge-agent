/**
 * EventRouter.ts -- the ONE place that turns engine events into things the user sees.
 * It only talks to a small `RouterSink`, so it is unit tested with a fake sink.
 * Rules: a run always ends back at "idle"; one failing event never kills the stream;
 * errors are shown in plain words (raw text only goes to the log).
 */
import type { EngineEvent, FileProposal } from '../types/contract';
import { MAX_RETRIES, friendlyError, type StatusState } from './routerModel';

export interface RouterSink {
  log(line: string): void;
  token(text: string): void;
  setStatus(state: StatusState): void;
  setModel(name: string): void;
  toast(level: 'info' | 'warning' | 'error', text: string): void;
  addProposal(p: FileProposal): void;
  removeProposal(id: string): void;
  openReview(firstProposalId: string | undefined): void;
  clearReview(): void;
}

export class EventRouter {
  private batchId: string | undefined;
  private proposals = 0;

  constructor(private readonly sink: RouterSink) {}

  /** Returns (and forgets) the batch waiting for review, so reviewDone is sent exactly once per batch. */
  takeBatch(): string | undefined {
    const id = this.batchId;
    this.batchId = undefined;
    return id;
  }

  async consume(stream: AsyncIterable<EngineEvent>): Promise<void> {
    this.proposals = 0;
    this.batchId = undefined;
    this.sink.setStatus({ kind: 'running' });
    try {
      for await (const e of stream) {
        try {
          this.handle(e);
        } catch (err) {
          this.sink.log(`router error on ${e.type}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.sink.log(`stream error: ${err instanceof Error ? err.message : String(err)}`);
      this.sink.toast('error', 'Something went wrong. Nothing was changed. Try again.');
    } finally {
      this.batchId = undefined;
      this.sink.setStatus({ kind: 'idle' });
    }
  }

  private handle(e: EngineEvent): void {
    const s = this.sink;
    switch (e.type) {
      case 'run.started': s.setModel(e.model); s.setStatus({ kind: 'running' }); s.log(`run started (${e.mode}, model ${e.model})`); break;
      case 'token': s.token(e.text); break;
      case 'tool.call': s.log(`tool: ${e.tool} ${JSON.stringify(e.args)}${e.thread === 'main' ? '' : ` [${e.thread}]`}`); break;
      case 'tool.result': s.log(`  ${e.ok ? 'ok' : 'FAILED'}: ${e.summary}`); break;
      case 'context.report': s.log(`files chosen: ${e.items.map((i) => `${i.path} (${i.reason})`).join('; ')}`); break;
      case 'subagent': s.log(`sub-agent ${e.threadId} ${e.state}${e.label ? ` (${e.label})` : ''}`); break;
      case 'budget': s.log(`context used: ${e.usedTokens}/${e.limitTokens} tokens`); break;
      case 'command.requested': s.log(`command requested: ${e.display}`); break;
      case 'proposal.created': this.proposals++; s.addProposal(e.proposal); s.log(`proposal: ${e.proposal.path} (${e.proposal.hunks.length} change${e.proposal.hunks.length === 1 ? '' : 's'})`); break;
      case 'review.required':
        this.batchId = e.batchId;
        s.setStatus({ kind: 'reviewing', files: e.proposalIds.length });
        s.openReview(e.proposalIds[0]);
        break;
      case 'proposal.discarded': s.removeProposal(e.proposalId); s.log(`proposal discarded (${e.reason})`); break;
      case 'retry': s.setStatus({ kind: 'retrying', attempt: e.attempt, max: MAX_RETRIES }); s.log(`retry ${e.attempt}/${MAX_RETRIES} in ${e.delayMs} ms (${e.kind})`); break;
      case 'failover':
        s.setModel(e.to);
        s.setStatus({ kind: 'running' });
        s.toast('warning', `The main model had a problem, so Forge switched to the backup model (${e.to}) and is carrying on.`);
        s.log(`failover ${e.from} -> ${e.to} (${e.reason})`);
        break;
      case 'run.completed':
        this.batchId = undefined;
        s.log(`run completed${e.summary ? `: ${e.summary}` : ''}`);
        if (this.proposals === 0) s.toast('info', 'Forge: no changes proposed.');
        break;
      case 'run.cancelled': this.batchId = undefined; s.clearReview(); s.log('run cancelled'); s.toast('info', 'Forge stopped. Nothing was changed.'); break;
      case 'run.failed': this.batchId = undefined; s.clearReview(); s.log(`run failed: ${e.error.kind}: ${e.error.message}`); s.toast('error', friendlyError(e.error)); break;
      default: break; // unknown events are ignored
    }
  }
}
