/**
 * Pure syntax highlighting for fenced code blocks. No runtime imports, so it
 * is testable with plain Node and safe for both plugin runtimes. The design is
 * a small scanner over language families rather than a full grammar.
 */

export type CodeTokenType = "plain" | "keyword" | "string" | "comment" | "number" | "function" | "type" | "added" | "removed" | "meta" | "tag";
export type CodeToken = { type: CodeTokenType; text: string };

type Family = {
  keywords: string[];
  lineComments?: string[];
  blockComments?: [string, string][];
  stringDelims?: string[];
  tripleStringDelims?: [string, string][];
  caseInsensitive?: boolean;
};

const FAMILIES: Record<string, Family> = {
  "js": { keywords: ["abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "constructor", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "func", "function", "get", "go", "goto", "if", "implements", "import", "in", "instanceof", "interface", "internal", "is", "let", "lock", "mut", "namespace", "new", "null", "nullptr", "operator", "out", "override", "package", "private", "protected", "pub", "public", "readonly", "ref", "return", "sealed", "self", "set", "sizeof", "static", "struct", "super", "switch", "template", "this", "throw", "throws", "trait", "true", "try", "type", "typedef", "typeof", "union", "unsafe", "use", "using", "val", "var", "virtual", "void", "volatile", "where", "while", "with", "yield", "undefined", "NaN", "console"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'", "`"] },
  "ts": { keywords: ["abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "constructor", "continue", "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "func", "function", "get", "go", "goto", "if", "implements", "import", "in", "instanceof", "interface", "internal", "is", "let", "lock", "mut", "namespace", "new", "null", "nullptr", "operator", "out", "override", "package", "private", "protected", "pub", "public", "readonly", "ref", "return", "sealed", "self", "set", "sizeof", "static", "struct", "super", "switch", "template", "this", "throw", "throws", "trait", "true", "try", "type", "typedef", "typeof", "union", "unsafe", "use", "using", "val", "var", "virtual", "void", "volatile", "where", "while", "with", "yield", "interface", "type", "declare", "keyof", "infer", "unknown", "never", "any", "satisfies"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'", "`"] },
  "go": { keywords: ["package", "import", "func", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "switch", "case", "default", "fallthrough", "for", "range", "if", "else", "return", "var", "const", "break", "continue", "goto", "nil", "true", "false", "string", "int", "int64", "int32", "uint", "byte", "rune", "float64", "float32", "bool", "error", "any"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'", "`"] },
  "cs": { keywords: ["using", "namespace", "class", "struct", "interface", "record", "enum", "static", "public", "private", "protected", "internal", "readonly", "override", "virtual", "sealed", "abstract", "async", "await", "var", "new", "return", "if", "else", "switch", "case", "default", "for", "foreach", "while", "do", "break", "continue", "try", "catch", "finally", "throw", "null", "true", "false", "void", "bool", "string", "int", "long", "double", "float", "decimal", "object", "this", "base", "get", "set", "partial", "out", "ref", "is", "as", "where", "yield"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"] },
  "c": { keywords: ["#include", "#define", "#pragma", "#ifndef", "#endif", "#ifdef", "int", "char", "void", "long", "short", "unsigned", "signed", "float", "double", "struct", "union", "enum", "typedef", "static", "extern", "const", "volatile", "register", "return", "if", "else", "switch", "case", "default", "for", "while", "do", "break", "continue", "goto", "sizeof", "NULL"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"] },
  "cpp": { keywords: ["#include", "#define", "#pragma", "class", "struct", "template", "typename", "namespace", "using", "public", "private", "protected", "virtual", "override", "inline", "constexpr", "static", "const", "auto", "new", "delete", "nullptr", "true", "false", "return", "if", "else", "switch", "case", "default", "for", "while", "do", "break", "continue", "try", "catch", "throw", "operator", "friend", "explicit", "enum", "union"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"] },
  "rust": { keywords: ["fn", "let", "mut", "const", "static", "struct", "enum", "trait", "impl", "for", "in", "while", "loop", "if", "else", "match", "return", "break", "continue", "pub", "crate", "mod", "use", "as", "where", "unsafe", "async", "await", "move", "dyn", "ref", "self", "Self", "true", "false", "Some", "None", "Ok", "Err", "Vec", "String", "u8", "u32", "u64", "usize", "i32", "i64", "isize", "f32", "f64", "bool", "char", "str"], lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\""] },
  "python": { keywords: ["def", "class", "import", "from", "as", "return", "if", "elif", "else", "for", "while", "break", "continue", "pass", "with", "try", "except", "finally", "raise", "yield", "lambda", "global", "nonlocal", "assert", "del", "in", "is", "not", "and", "or", "True", "False", "None", "async", "await", "match", "case", "self", "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple"], lineComments: ["#"], stringDelims: ["\"", "'"], tripleStringDelims: [["\"\"\"", "\"\"\""], ["'''", "'''"]] },
  "sh": { keywords: ["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "export", "source", "local", "set", "unset", "shift", "trap", "exit", "echo", "cd", "printf", "read", "test", "eval", "exec"], lineComments: ["#"], stringDelims: ["\"", "'"] },
  "ps": { keywords: ["function", "param", "if", "elseif", "else", "switch", "foreach", "for", "while", "do", "until", "return", "throw", "try", "catch", "finally", "begin", "process", "end", "class", "enum", "break", "continue", "in", "true", "false", "null"], lineComments: ["#"], blockComments: [["<#", "#>"]], stringDelims: ["\"", "'"], caseInsensitive: true },
  "ruby": { keywords: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "then", "return", "yield", "begin", "rescue", "ensure", "raise", "case", "when", "break", "next", "redo", "retry", "self", "nil", "true", "false", "and", "or", "not", "require", "puts", "print"], lineComments: ["#"], stringDelims: ["\"", "'"] },
  "json": { keywords: ["true", "false", "null"], stringDelims: ["\""] },
  "yaml": { keywords: ["true", "false", "null", "yes", "no", "on", "off"], lineComments: ["#"], stringDelims: ["\"", "'"] },
  "sql": { keywords: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "CREATE", "TABLE", "ALTER", "DROP", "AND", "OR", "NOT", "NULL", "AS", "DISTINCT", "UNION", "CASE", "WHEN", "THEN", "ELSE", "END", "PRIMARY", "KEY", "WITH", "RETURNING", "TRUE", "FALSE"], lineComments: ["--"], blockComments: [["/*", "*/"]], caseInsensitive: true },
  "diff": { keywords: [] },
  "html": { keywords: [], lineComments: [], blockComments: [["<!--", "-->"]], stringDelims: ["\"", "'"] },
  "css": { keywords: [], lineComments: [], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"] },
};

const ALIASES: Record<string, string> = {
  "javascript": "js",
  "jsx": "js",
  "mjs": "js",
  "node": "js",
  "typescript": "js",
  "tsx": "js",
  "ts": "js",
  "golang": "go",
  "go": "go",
  "c#": "cs",
  "csharp": "cs",
  "cs": "cs",
  "c": "c",
  "h": "c",
  "c++": "cpp",
  "cpp": "cpp",
  "cc": "cpp",
  "cxx": "cpp",
  "hpp": "cpp",
  "rust": "cpp",
  "rs": "cpp",
  "python": "python",
  "py": "python",
  "bash": "sh",
  "sh": "sh",
  "shell": "sh",
  "zsh": "sh",
  "console": "sh",
  "terminal": "sh",
  "shellsession": "sh",
  "powershell": "ps",
  "pwsh": "ps",
  "ps1": "ps",
  "ruby": "ruby",
  "rb": "ruby",
  "json": "json",
  "jsonc": "json",
  "json5": "json",
  "yaml": "yaml",
  "yml": "yaml",
  "sql": "sql",
  "diff": "diff",
  "patch": "diff",
  "html": "html",
  "xml": "html",
  "svg": "html",
  "xhtml": "html",
  "vue": "html",
  "css": "css",
  "scss": "css",
  "less": "css",
};

export function normalizeLanguage(language: string): string {
  const key = language.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

type Scanner = {
  keywordSet: Set<string>;
  lineComments: string[];
  blockComments: [string, string][];
  stringDelims: string[];
  tripleStringDelims?: [string, string][];
  caseInsensitive: boolean;
  /** HTML mode: tag names, attributes and text need structural context. */
  isHtml?: boolean;
  /** CSS mode: brace depth separates selectors from properties. */
  isCss?: boolean;
  inTag?: boolean;
  firstWordInTag?: boolean;
};

function buildScanner(family: Family): Scanner {
  return {
    keywordSet: new Set(family.keywords.map((keyword) => (family.caseInsensitive ? keyword.toLowerCase() : keyword))),
    lineComments: family.lineComments ?? [],
    blockComments: family.blockComments ?? [],
    stringDelims: family.stringDelims ?? [],
    tripleStringDelims: family.tripleStringDelims,
    caseInsensitive: family.caseInsensitive ?? false,
    isHtml: normalizedHtml(family),
    isCss: normalizedCss(family),
    inTag: false,
    firstWordInTag: false,
  };
}

function normalizedHtml(family: Family): boolean {
  return family.keywords.length === 0 && family.blockComments?.[0]?.[0] === "<!--";
}

function normalizedCss(family: Family): boolean {
  return family.keywords.length === 0 && family.blockComments?.[0]?.[0] === "/*";
}

function isKeyword(scanner: Scanner, word: string): boolean {
  const probe = scanner.caseInsensitive ? word.toLowerCase() : word;
  return scanner.keywordSet.has(probe);
}

/** Highlights code into per-line tokens. Pure and language-aware. */
export function highlightCode(code: string, language: string): CodeToken[][] {
  const normalized = normalizeLanguage(language);
  if (normalized === "diff") {
    return code.split("\n").map((line) => {
      if (line.startsWith("+")) return [{ type: "added" as const, text: line }];
      if (line.startsWith("-")) return [{ type: "removed" as const, text: line }];
      if (line.startsWith("@@") || line.startsWith("**")) return [{ type: "meta" as const, text: line }];
      return [{ type: "plain" as const, text: line }];
    });
  }
  const family = FAMILIES[normalized];
  if (!family) {
    return code.split("\n").map((line) => [{ type: "plain" as const, text: line }]);
  }
  const scanner = buildScanner(family);

  const lines: CodeToken[][] = [];
  let current: CodeToken[] = [];
  let inBlockComment: [string, string] | null = null;
  let braceDepth = 0;

  const push = (type: CodeTokenType, text: string): void => {
    if (text.length === 0) return;
    const parts = text.split("\n");
    for (let part = 0; part < parts.length; part += 1) {
      if (part > 0) {
        lines.push(current);
        current = [];
      }
      const previous = current[current.length - 1];
      if (previous && previous.type === type) {
        previous.text += parts[part];
      } else {
        current.push({ type, text: parts[part] });
      }
    }
  };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (code[i] === "\n") {
      lines.push(current);
      current = [];
      i += 1;
      continue;
    }
    if (inBlockComment) {
      const end = rest.indexOf(inBlockComment[1]);
      if (end === -1) {
        push("comment", rest);
        i += rest.length;
        continue;
      }
      push("comment", rest.slice(0, end + inBlockComment[1].length));
      i += end + inBlockComment[1].length;
      inBlockComment = null;
      continue;
    }
    const openDelim = scanner.stringDelims.find((candidate) => rest.startsWith(candidate));
    if (openDelim) {
      let j = i + openDelim.length;
      while (j < code.length && code[j] !== openDelim) {
        if (code[j] === "\\") j += 2;
        else j += 1;
      }
      const consumed = j < code.length ? code.slice(i, j + openDelim.length) : rest;
      // JSON object keys read better in the type color than as plain strings.
      const isJsonKey = normalized === "json" && /^\s*:/.test(code.slice(i + consumed.length));
      push(isJsonKey ? "type" : "string", consumed);
      i += consumed.length;
      continue;
    }
    const tripleMatch = scanner.tripleStringDelims?.find((pair) => rest.startsWith(pair[0]));
    if (tripleMatch) {
      const end = code.indexOf(tripleMatch[1], i + tripleMatch[0].length);
      const consumed = end === -1 ? rest : code.slice(i, end + tripleMatch[1].length);
      push("string", consumed);
      i += consumed.length;
      continue;
    }
    const blockStart = scanner.blockComments.find((pair) => rest.startsWith(pair[0]));
    if (blockStart) {
      inBlockComment = blockStart;
      continue;
    }
    const linePrefix = scanner.lineComments.find((prefix) => rest.startsWith(prefix));
    if (linePrefix) {
      const end = rest.indexOf("\n");
      push("comment", end === -1 ? rest : rest.slice(0, end));
      i += end === -1 ? rest.length : end;
      continue;
    }
    if (/^\d/.test(rest)) {
      const numberMatch = /^\d[\d_.]*[a-zA-Z]*/.exec(rest)!;
      push("number", numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    // CSS names contain hyphens (max-width, font-family): match them whole.
    const wordMatch = scanner.isCss
      ? /^[A-Za-z-][A-Za-z0-9-]*/.exec(rest)
      : /^[A-Za-z_#$][A-Za-z0-9_#$]*/.exec(rest);
    if (wordMatch) {
      const word = wordMatch[0];
      const probe = scanner.caseInsensitive ? word.toLowerCase() : word;
      const isCall = /^\s*\(/.test(code.slice(i + word.length));
      if (scanner.isHtml) {
        if (!scanner.inTag) {
          push("plain", word);
        } else if (scanner.firstWordInTag) {
          push("tag", word);
          scanner.firstWordInTag = false;
        } else if (/^\s*=/.test(code.slice(i + word.length))) {
          push("type", word);
        } else {
          push("plain", word);
        }
      } else if (scanner.isCss) {
        if (/^\s*:/.test(code.slice(i + word.length))) {
          // Property name inside a rule.
          push("function", word);
        } else if (braceDepth === 0) {
          push("type", word);
        } else {
          push("plain", word);
        }
      } else if (isKeyword(scanner, word)) {
        push("keyword", word);
      } else if (isCall) {
        push("function", word);
      } else if (word.startsWith("$")) {
        push("keyword", word);
      } else if (/^[A-Z]/.test(word)) {
        push("type", word);
      } else {
        push("plain", word);
      }
      i += word.length;
      continue;
    }
    // Shell/PowerShell flags (-v, --force) get their own accent.
    if ((normalized === "sh" || normalized === "ps") && /^-{1,2}[A-Za-z]/.test(rest)) {
      const flagMatch = /^-{1,2}[A-Za-z][\w-]*/.exec(rest)!;
      push("meta", flagMatch[0]);
      i += flagMatch[0].length;
      continue;
    }
    if (scanner.isHtml && rest.startsWith("<")) {
      if (rest.startsWith("<!")) {
        const end = rest.indexOf(">");
        const consumed = end === -1 ? rest : rest.slice(0, end + 1);
        push("meta", consumed);
        i += consumed.length;
        continue;
      }
      push("plain", "<");
      scanner.inTag = true;
      scanner.firstWordInTag = true;
      i += 1;
      continue;
    }
    if (scanner.isHtml && rest.startsWith(">")) {
      push("plain", ">");
      scanner.inTag = false;
      i += 1;
      continue;
    }
    if (scanner.isCss && rest[0] === "{") {
      braceDepth += 1;
      push("plain", "{");
      i += 1;
      continue;
    }
    if (scanner.isCss && rest[0] === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      push("plain", "}");
      i += 1;
      continue;
    }
    push("plain", rest[0]);
    i += 1;
  }
  lines.push(current);
  return lines;
}
