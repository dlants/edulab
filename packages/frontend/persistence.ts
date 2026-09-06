import type Anthropic from "@anthropic-ai/sdk";
import type { GraphChange, GraphSnapshot, KnowledgeGraph } from "./graph.ts";
import type { SampleId } from "./samples/index.ts";
import type { ThreadId } from "./selection.ts";
import type { Message, MessageIdx } from "./thread.ts";
import { projectLog, trimUnansweredTools } from "./thread.ts";
import type { Origin, ThreadTree } from "./threads.ts";
import type { Build } from "./view.ts";

export const VERSION = 2;

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
  /** The update thread's own transcript, kept so the prompt and the model's
   * work can still be reviewed after a reload. */
  messages: ReadonlyArray<Message>;
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

/** The localStorage key, so nothing else can pass a bare string to the store. */
export type StorageKey = string & { readonly __brand: "StorageKey" };

/** One key per sample - switching sample is already a page load, so it picks
 * up that sample's state and nothing else. The version is part of the key, so
 * a bump orphans old data rather than having to migrate it. */
export function storageKey(sample: SampleId | undefined): StorageKey {
  return `edulab:v${VERSION}:${sample ?? "own"}` as StorageKey;
}

/** All-or-nothing: a parse failure, a version mismatch or a shape mismatch
 * drops the whole key and the caller starts fresh. */
export function loadSnapshot(sample: SampleId | undefined): Snapshot | null {
  const key = storageKey(sample);
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!wellFormed(parsed)) throw new Error("shape mismatch");
    return parsed;
  } catch (e) {
    console.warn("dropping unreadable snapshot", e);
    window.localStorage.removeItem(key);
    return null;
  }
}

function wellFormed(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<Snapshot>;
  return (
    s.version === VERSION &&
    Array.isArray(s.threads) &&
    s.threads.every((t) => typeof t?.id === "string" && Array.isArray(t.log)) &&
    typeof s.nextThreadId === "number" &&
    typeof s.root === "string" &&
    typeof s.graph === "object" &&
    s.graph !== null &&
    Array.isArray(s.graph.nodes) &&
    Array.isArray(s.graph.edges) &&
    typeof s.graph.next === "number" &&
    Array.isArray(s.updates) &&
    typeof s.build === "object" &&
    s.build !== null &&
    typeof s.build.type === "string" &&
    (s.build.type === "idle" || Array.isArray(s.build.failures))
  );
}

let pending: ReturnType<typeof setTimeout> | undefined;

/** Trailing-debounced: `sync()` runs on every streamed token, and serializing
 * the tree per token is pure waste. */
export function saveSnapshot(snapshot: Snapshot): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = undefined;
    const key = storageKey(snapshot.sample);
    try {
      window.localStorage.setItem(key, JSON.stringify(snapshot));
    } catch (e) {
      // The prototype keeps running, it just stops persisting.
      console.warn("could not persist", e);
      window.localStorage.removeItem(key);
    }
  }, SAVE_DELAY_MS);
}

const SAVE_DELAY_MS = 500;

export function clearSnapshot(sample: SampleId | undefined): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
  window.localStorage.removeItem(storageKey(sample));
}

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

export function toSnapshot(args: {
  sample: SampleId | undefined;
  tree: ThreadTree;
  graph: KnowledgeGraph;
  updates: ReadonlyArray<UpdateSnapshot>;
  build: Build;
}): Snapshot {
  return {
    version: VERSION,
    sample: args.sample,
    threads: threadSnapshots(args.tree),
    nextThreadId: args.tree.nextThreadId,
    root: args.tree.root,
    graph: args.graph.snapshot(),
    updates: [...args.updates],
    build: args.build,
  };
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
