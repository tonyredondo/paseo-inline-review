export type StableParagraphDiagnostics = {
  updates: number;
  fullRebuilds: number;
  inspectedCharacters: number;
  materializedCharacters: number;
};

/**
 * Incremental counterpart to splitParagraphs for append-only assistant text.
 * Complete lines are inspected once; a non-append edit rebuilds the state.
 * The open paragraph is still materialized on every update because its text is
 * the value React renders, while completed paragraph strings remain stable.
 */
export function createStableParagraphs() {
  let previousText = "";
  let processedOffset = 0;
  let committed: string[] = [];
  let currentLines: string[] = [];
  let inFence = false;
  let fenceLength = 3;
  let lastResult: string[] = [];
  let hasUpdated = false;
  const diagnostics: StableParagraphDiagnostics = {
    updates: 0,
    fullRebuilds: 0,
    inspectedCharacters: 0,
    materializedCharacters: 0,
  };

  function reset(): void {
    processedOffset = 0;
    committed = [];
    currentLines = [];
    inFence = false;
    fenceLength = 3;
  }

  function commitCurrent(): void {
    if (currentLines.length === 0) return;
    const chunk = currentLines.join("\n").trim();
    if (chunk.length > 0) committed.push(chunk);
    currentLines = [];
  }

  function processCompleteLine(line: string): void {
    const fence = /^\s*(`{3,})/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLength = fence[1].length;
      } else if (fence[1].length >= fenceLength) {
        inFence = false;
      }
      currentLines.push(line);
      return;
    }
    if (!inFence && line.trim().length === 0) {
      commitCurrent();
      return;
    }
    currentLines.push(line);
  }

  function update(text: string): string[] {
    diagnostics.updates += 1;
    if (hasUpdated && text === previousText) return lastResult;
    if (!hasUpdated || !text.startsWith(previousText)) {
      reset();
      diagnostics.fullRebuilds += 1;
    }
    hasUpdated = true;

    let cursor = processedOffset;
    for (let newline = text.indexOf("\n", cursor); newline !== -1; newline = text.indexOf("\n", cursor)) {
      const line = text.slice(cursor, newline);
      diagnostics.inspectedCharacters += line.length + 1;
      processCompleteLine(line);
      cursor = newline + 1;
    }
    processedOffset = cursor;

    const suffix = text.slice(processedOffset);
    const pendingLines = suffix.length > 0 ? [...currentLines, suffix] : currentLines;
    const pending = pendingLines.length > 0 ? pendingLines.join("\n").trim() : "";
    diagnostics.materializedCharacters += pending.length;
    lastResult = pending.length > 0 ? [...committed, pending] : [...committed];
    previousText = text;
    return lastResult;
  }

  return {
    update,
    diagnostics(): StableParagraphDiagnostics {
      return { ...diagnostics };
    },
  };
}
