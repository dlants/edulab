import { expect, it } from "vitest";
import {
  interactionAddresses,
  type ThreadSnapshot,
  threadSnapshots,
} from "./persistence.ts";
import type { Anchor, ThreadId } from "./selection.ts";
import { type Socket, Thread } from "./thread.ts";
import { ThreadTree } from "./threads.ts";

const socket: Socket = { send() {}, addEventListener() {} };

function anchorInto(thread: ThreadId, msg: number): Anchor {
  return {
    thread,
    start: { msg, offset: 0 },
    end: { msg, offset: 5 },
  };
}

/** A root with three committed turns and two learning children, the second
 * of them active. */
function setup() {
  const root = new Thread(socket, {
    initialTurns: [
      { role: "user", content: "sample ask" },
      { role: "assistant", content: "sample reply" },
      { role: "user", content: "my own follow up" },
    ],
  });
  const tree = new ThreadTree(socket, root, () => {});
  const first = tree.open(anchorInto(tree.root, 1), { type: "explain" });
  const second = tree.open(anchorInto(tree.root, 2), { type: "quiz" });
  tree.get(tree.root).activeChild = second;
  tree.get(tree.root).draft = "half typed";
  return { tree, first, second };
}

function restore(tree: ThreadTree): {
  tree: ThreadTree;
  snapshots: ThreadSnapshot[];
} {
  const snapshots = JSON.parse(
    JSON.stringify(threadSnapshots(tree)),
  ) as ThreadSnapshot[];
  return {
    snapshots,
    tree: ThreadTree.restore(
      socket,
      snapshots,
      tree.root,
      tree.nextThreadId,
      () => {},
      (s) =>
        new Thread(socket, {
          system: s.system,
          seed: s.seed,
          initialTurns: s.log,
        }),
    ),
  };
}

it("round-trips a tree with its structure, drafts and transcripts", () => {
  const { tree, first, second } = setup();
  const restored = restore(tree).tree;

  expect(restored.root).toBe(tree.root);
  expect(restored.path(second)).toEqual(tree.path(second));
  expect(restored.marks(tree.root)).toEqual(tree.marks(tree.root));
  expect(restored.get(tree.root).activeChild).toBe(second);
  expect(restored.get(tree.root).draft).toBe("half typed");
  for (const id of [tree.root, first, second]) {
    expect(restored.get(id).thread.messages).toEqual(
      tree.get(id).thread.messages,
    );
    expect(restored.get(id).thread.seed).toEqual(tree.get(id).thread.seed);
  }
});

it("does not re-mint an id over a restored one", () => {
  const { tree } = setup();
  const restored = restore(tree).tree;
  const child = restored.open(anchorInto(restored.root, 0), {
    type: "explain",
  });
  expect(child).toBe("t3");
});

it("lists the root's interactions first, then each child's seeded ask", () => {
  const { tree, first, second } = setup();
  const { snapshots } = restore(tree);

  expect(interactionAddresses(snapshots, tree.root, true, 1)).toEqual([
    { thread: tree.root, index: 0 },
    { thread: tree.root, index: 2 },
    { thread: first, index: 0 },
    { thread: second, index: 0 },
  ]);
});

it("excludes the sample's own turns unless a build was started", () => {
  const { tree, first, second } = setup();
  const { snapshots } = restore(tree);

  expect(interactionAddresses(snapshots, tree.root, false, 1)).toEqual([
    { thread: tree.root, index: 2 },
    { thread: first, index: 0 },
    { thread: second, index: 0 },
  ]);
});
