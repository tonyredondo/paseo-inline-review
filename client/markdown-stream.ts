function sameDefinitions(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [label, target] of right) {
    if (left.get(label) !== target) return false;
  }
  return true;
}

const fencePattern = /^\s*(`{3,})/;
const referencePattern = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/;

type ReferenceScanState = {
  inFence: boolean;
  fenceLength: number;
};

function scanReferenceLine(
  line: string,
  state: ReferenceScanState,
  references: Map<string, string>,
): void {
  const fence = fencePattern.exec(line);
  if (fence) {
    if (!state.inFence) {
      state.inFence = true;
      state.fenceLength = fence[1].length;
    } else if (fence[1].length >= state.fenceLength) {
      state.inFence = false;
    }
    return;
  }
  if (state.inFence) return;
  const match = referencePattern.exec(line);
  if (match) references.set(match[1].toLowerCase(), match[2].trim());
}

/**
 * Keeps reference-link identity stable while streaming text appends ordinary
 * paragraphs. Markdown renderers use the map as a memo dependency, so
 * publishing a fresh equivalent map would invalidate every existing block.
 */
export function createStableReferenceDefinitions() {
  let current: Map<string, string> | null = null;
  let previousText: string | null = null;
  let committedEnd = 0;
  let committed = new Map<string, string>();
  let committedState: ReferenceScanState = { inFence: false, fenceLength: 3 };
  let parses = 0;
  let publications = 0;
  let inspectedCharacters = 0;
  let fullScans = 0;

  function scanCompleteLines(text: string, completeEnd: number): void {
    while (committedEnd < completeEnd) {
      const newline = text.indexOf("\n", committedEnd);
      if (newline < 0 || newline >= completeEnd) break;
      const line = text.slice(committedEnd, newline);
      inspectedCharacters += newline - committedEnd + 1;
      scanReferenceLine(line, committedState, committed);
      committedEnd = newline + 1;
    }
  }

  function scan(text: string): Map<string, string> {
    if (previousText === null || !text.startsWith(previousText)) {
      fullScans += 1;
      committedEnd = 0;
      committed = new Map<string, string>();
      committedState = { inFence: false, fenceLength: 3 };
    }
    const completeEnd = text.lastIndexOf("\n") + 1;
    scanCompleteLines(text, completeEnd);

    const next = new Map(committed);
    if (committedEnd < text.length) {
      const trailing = text.slice(committedEnd);
      inspectedCharacters += trailing.length;
      scanReferenceLine(trailing, { ...committedState }, next);
    }
    previousText = text;
    return next;
  }

  return {
    update(text: string): Map<string, string> {
      parses += 1;
      const next = scan(text);
      if (current && sameDefinitions(current, next)) return current;
      current = next;
      publications += 1;
      return current;
    },
    diagnostics(): {
      parses: number;
      publications: number;
      inspectedCharacters: number;
      fullScans: number;
    } {
      return { parses, publications, inspectedCharacters, fullScans };
    },
  };
}
