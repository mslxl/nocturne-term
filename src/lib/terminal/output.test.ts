import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderedTerminalOutputChunks, type TerminalOutputOrderingState } from "./output";

describe("terminal output ordering", () => {
  it("waits for startup backlog before writing later live output", () => {
    const state = createState();
    const decoder = new TextDecoder();

    assert.deepEqual(chunks(state, { sequence: "6", backlog: false, text: " world" }, decoder), []);
    assert.deepEqual(chunks(state, { sequence: "0", backlog: true, text: "hello " }, decoder), ["hello ", " world"]);
    assert.equal(state.nextOutputSequence, 12n);
    assert.equal(state.pendingOutput.size, 0);
  });

  it("drops overlapping duplicate live output after backlog flushes", () => {
    const state = createState();
    const decoder = new TextDecoder();

    assert.deepEqual(chunks(state, { sequence: "6", backlog: false, text: "world" }, decoder), []);
    assert.deepEqual(chunks(state, { sequence: "0", backlog: true, text: "hello world" }, decoder), ["hello world"]);
    assert.deepEqual(chunks(state, { sequence: "6", backlog: false, text: "world" }, decoder), []);
    assert.equal(state.pendingOutput.size, 0);
  });

  it("accepts a trimmed backlog when the original beginning was discarded", () => {
    const state = createState();
    const decoder = new TextDecoder();

    assert.deepEqual(chunks(state, { sequence: "512", backlog: true, text: "tail" }, decoder), ["tail"]);
    assert.equal(state.nextOutputSequence, 516n);
  });
});

function createState(): TerminalOutputOrderingState {
  return { nextOutputSequence: 0n, pendingOutput: new Map() };
}

function chunks(
  state: TerminalOutputOrderingState,
  event: { sequence: string; backlog: boolean; text: string },
  decoder: TextDecoder,
) {
  return orderedTerminalOutputChunks(
    state,
    {
      sequence: event.sequence,
      backlog: event.backlog,
      data: Buffer.from(event.text).toString("base64"),
    },
    decoder,
  );
}
