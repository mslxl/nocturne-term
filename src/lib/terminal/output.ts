export type TerminalOutputOrderingState = {
  nextOutputSequence: bigint;
  pendingOutput: Map<string, string>;
};

export type SequencedTerminalOutput = {
  sequence: string;
  backlog: boolean;
  data: string;
};

export function orderedTerminalOutputChunks(
  state: TerminalOutputOrderingState,
  event: SequencedTerminalOutput,
  decoder: TextDecoder,
): string[] {
  const eventSequence = BigInt(event.sequence);
  if (event.backlog && eventSequence > state.nextOutputSequence) {
    state.nextOutputSequence = eventSequence;
  }
  if (eventSequence > state.nextOutputSequence) {
    state.pendingOutput.set(event.sequence, event.data);
    return [];
  }
  const chunks: string[] = [];
  const firstChunk = decodeOrderedOutput(state, event.data, eventSequence, decoder);
  if (firstChunk) chunks.push(firstChunk);
  prunePendingOutput(state);
  while (true) {
    const nextSequenceKey = state.nextOutputSequence.toString();
    const nextData = state.pendingOutput.get(nextSequenceKey);
    if (nextData === undefined) break;
    state.pendingOutput.delete(nextSequenceKey);
    const nextChunk = decodeOrderedOutput(state, nextData, state.nextOutputSequence, decoder);
    if (nextChunk) chunks.push(nextChunk);
    prunePendingOutput(state);
  }
  return chunks;
}

function prunePendingOutput(state: TerminalOutputOrderingState) {
  for (const [sequence, data] of state.pendingOutput) {
    if (BigInt(sequence) + BigInt(base64DecodedByteLength(data)) <= state.nextOutputSequence) {
      state.pendingOutput.delete(sequence);
    }
  }
}

function decodeOrderedOutput(
  state: TerminalOutputOrderingState,
  data: string,
  sequence: bigint,
  decoder: TextDecoder,
): string {
  const nextSequence = state.nextOutputSequence;
  const length = base64DecodedByteLength(data);
  const eventEnd = sequence + BigInt(length);
  if (eventEnd <= nextSequence) return "";
  const start = sequence < nextSequence ? Number(nextSequence - sequence) : 0;
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length - start);
  for (let index = start; index < binary.length; index += 1) {
    bytes[index - start] = binary.charCodeAt(index);
  }
  state.nextOutputSequence = eventEnd;
  return decoder.decode(bytes, { stream: true });
}

function base64DecodedByteLength(data: string): number {
  return atob(data).length;
}
