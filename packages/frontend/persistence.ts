import type Anthropic from "@anthropic-ai/sdk";
import type { GraphChange, GraphSnapshot } from "./graph.ts";
import type { SampleId } from "./samples/index.ts";
import type { ThreadId } from "./selection.ts";
import { type MessageIdx, projectLog, trimUnansweredTools } from "./thread.ts";
import type { Origin, ThreadTree } from "./threads.ts";
import type { Build } from "./view.ts";

export const VERSION = 1;

export type ThreadSnapshot = {
  id: ThreadId;
  origin: Origin | null;
  system: string;
  /** Held apart from `log` because `Thread` does: it is turn 0 of the wire
   * log and is never rendered, so restoring it as an ordinary turn would put
   * it in the transcript. */
  seed: string | Anthropic.ContentBlockParam[] | undefined;
  /** The committed turns after the seed. */
  log: Anthropic.MessageParam[];
  children: ThreadId[];
  activeChild: ThreadId | null;
  draft: string;
};

/** One finished graph update, keyed by the interaction that caused it.
 * Running updates are omitted, which is what makes them re-enqueue. */
export type UpdateSnapshot = {
  thread: ThreadId;
  index: MessageIdx;
  changes: ReadonlyArray<GraphChange>;
};

export type Snapshot = {
  version: number;
  sample: SampleId | undefined;
  threads: ThreadSnapshot[];
  nextThreadId: number;
  root: ThreadId;
  graph: GraphSnapshot;
  updates: UpdateSnapshot[];
  build: Build;
};

/** The tree, flattened. Logs are trimmed to stay API-valid, so a refresh
 * mid-tool-call cannot persist a call the model can never answer. */
export function threadSnapshots(tree: ThreadTree): ThreadSnapshot[] {
  return tree.nodes().map((node) => ({
    id: node.id,
    origin: node.origin,
    system: node.thread.systemPrompt,
    seed: node.thread.seed,
    log: trimUnansweredTools(node.thread.log),
    children: [...node.children],
    activeChild: node.activeChild,
    draft: node.draft,
  }));
}

export type InteractionAddress = { thread: ThreadId; index: MessageIdx };

/** Every user turn in the tree - the addresses a graph update is keyed by -
 * root first and then the remaining threads in id order, each in message
 * order, which is the order a rebuild has to replay them in.
 *
 * `sampleTurnCount` is how many of the root's interactions came from the
 * canned transcript; they are only in scope once a build has been asked for. */
export function interactionAddresses(
  threads: ReadonlyArray<ThreadSnapshot>,
  root: ThreadId,
  includeSampleTurns: boolean,
  sampleTurnCount: number,
): InteractionAddress[] {
  const ordered = [
    ...threads.filter((t) => t.id === root),
    ...threads.filter((t) => t.id !== root),
  ];
  const out: InteractionAddress[] = [];
  for (const thread of ordered) {
    const isRoot = thread.id === root;
    let seen = 0;
    projectLog(thread.log).forEach((message, i) => {
      if (message.type !== "text" || message.role !== "user") return;
      const sampleTurn = isRoot && seen < sampleTurnCount;
      seen++;
      if (sampleTurn && !includeSampleTurns) return;
      out.push({ thread: thread.id, index: i as MessageIdx });
    });
  }
  return out;
}
