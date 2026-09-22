import { parseBlocks, parseInline, type Block, type InlineToken } from "../shared/markdown-parse.ts";

export type CompiledMarkdown = {
  blocks: Block[];
  inline(text: string): InlineToken[];
};

type CacheEntry = { document: CompiledMarkdown; characters: number };
const completed = new Map<string, CacheEntry>();
const MAX_CACHE_CHARACTERS = 2_000_000;
let cachedCharacters = 0;
let hits = 0;
let misses = 0;

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function createDocument(text: string, refs?: Map<string, string>): CompiledMarkdown {
  const inline = new Map<string, InlineToken[]>();
  return {
    blocks: parseBlocks(text),
    inline(value: string): InlineToken[] {
      const cached = inline.get(value);
      if (cached) return cached;
      const tokens = parseInline(value, refs);
      inline.set(value, tokens);
      return tokens;
    },
  };
}

export function compileMarkdown(
  text: string,
  refs?: Map<string, string>,
  completedIdentity?: string,
): CompiledMarkdown {
  if (!completedIdentity) {
    misses += 1;
    return createDocument(text, refs);
  }
  const refsKey = refs ? [...refs].map(([key, value]) => `${key}=${value}`).join("\u0001") : "";
  const key = `${completedIdentity}:${hashText(text)}:${hashText(refsKey)}`;
  const cached = completed.get(key);
  if (cached) {
    hits += 1;
    completed.delete(key);
    completed.set(key, cached);
    return cached.document;
  }
  misses += 1;
  const document = createDocument(text, refs);
  const characters = text.length + refsKey.length;
  completed.set(key, { document, characters });
  cachedCharacters += characters;
  while (cachedCharacters > MAX_CACHE_CHARACTERS && completed.size > 0) {
    const oldest = completed.keys().next().value as string | undefined;
    if (!oldest) break;
    const removed = completed.get(oldest);
    completed.delete(oldest);
    cachedCharacters -= removed?.characters ?? 0;
  }
  return document;
}

export function clearMarkdownCache(): void {
  completed.clear();
  cachedCharacters = 0;
  hits = 0;
  misses = 0;
}

export function markdownCacheDiagnostics() {
  return { entries: completed.size, cachedCharacters, hits, misses };
}
