/**
 * Pure syntax highlighting for fenced code blocks. No runtime imports, so it
 * is testable with plain Node and safe for both plugin runtimes. The design is
 * a small scanner over language families rather than a full grammar.
 */

export type CodeTokenType = "plain" | "keyword" | "string" | "comment" | "number" | "function" | "type" | "added" | "removed" | "meta" | "tag";
export type CodeToken = { type: CodeTokenType; text: string };

const C_TEMPLATE = 0;
const C_QUOTES = 1;
const C_DOUBLE = 2;
const HASH_QUOTES = 3;
const PYTHON = 4;
const POWERSHELL = 5;
const JSON_PROFILE = 6;
const SQL = 7;
const PHP = 8;
const INI = 9;
const DOCKERFILE = 10;
const HTML = 11;
const CSS = 12;

type Profile =
  | typeof C_TEMPLATE
  | typeof C_QUOTES
  | typeof C_DOUBLE
  | typeof HASH_QUOTES
  | typeof PYTHON
  | typeof POWERSHELL
  | typeof JSON_PROFILE
  | typeof SQL
  | typeof PHP
  | typeof INI
  | typeof DOCKERFILE
  | typeof HTML
  | typeof CSS;
type PackedFamily = readonly [keywords: string, builtins: string, profile: Profile];

/** Word lists stay packed until the first fenced block for that language. */
const PACKED_FAMILIES: Record<string, PackedFamily> = {
  js: [`abstract as async await break case catch class const constructor continue debugger default delete do else enum export extends false finally for from func function get go goto if implements import in instanceof interface internal is let lock mut namespace new null nullptr operator out override package private protected pub public readonly ref return sealed self set sizeof static struct super switch template this throw throws trait true try type typedef typeof union unsafe use using val var virtual void volatile where while with yield undefined NaN console`, "", C_TEMPLATE],
  go: [`package import func type struct interface map chan go defer select switch case default fallthrough for range if else return var const break continue goto nil true false string int int64 int32 int16 int8 uint uint64 uint32 uintptr byte rune float64 float32 complex64 complex128 bool error any`, `make len cap append copy new delete panic recover print println close min max clear`, C_TEMPLATE],
  cs: [`using namespace class struct interface record enum static public private protected internal readonly override virtual sealed abstract async await var new return if else switch case default for foreach while do break continue try catch finally throw null true false void bool string int long double float decimal object this base get set partial out ref is as where yield global file required init scoped nint nuint sbyte short ushort uint ulong nameof typeof sizeof checked unchecked lock params when event delegate explicit implicit unmanaged record`, `Console Math Environment Task List Dictionary HashSet Enumerable String Int32 Int64 Double Boolean Object Exception`, C_QUOTES],
  java: [`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed yield permits true false null`, `String Integer Long Boolean Double Character Math System Objects Optional Arrays Collections List Map Set ArrayList HashMap HashSet`, C_QUOTES],
  c: [`#include #define #pragma #ifndef #endif #ifdef int char void long short unsigned signed float double struct union enum typedef static extern const volatile register return if else switch case default for while do break continue goto sizeof NULL`, "", C_QUOTES],
  cpp: [`#include #define #pragma class struct template typename namespace using public private protected virtual override inline constexpr static const auto new delete nullptr true false return if else switch case default for while do break continue try catch throw operator friend explicit enum union`, "", C_QUOTES],
  rust: [`fn let mut const static struct enum trait impl for in while loop if else match return break continue pub crate mod use as where unsafe async await move dyn ref self Self true false Some None Ok Err Vec String u8 u32 u64 usize i32 i64 isize f32 f64 bool char str`, "", C_DOUBLE],
  python: [`def class import from as return if elif else for while break continue pass with try except finally raise yield lambda global nonlocal assert del in is not and or True False None async await match case self print len range str int float bool list dict set tuple`, "", PYTHON],
  sh: [`if then elif else fi for while until do done case esac in function return export source local set unset shift trap exit echo cd printf read test eval exec`, "", HASH_QUOTES],
  ps: [`function param if elseif else switch foreach for while do until return throw try catch finally begin process end class enum break continue in true false null`, "", POWERSHELL],
  ruby: [`def end class module if elsif else unless while until for in do then return yield begin rescue ensure raise case when break next redo retry self nil true false and or not require puts print`, "", HASH_QUOTES],
  json: [`true false null`, "", JSON_PROFILE],
  yaml: [`true false null yes no on off`, "", HASH_QUOTES],
  sql: [`SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT CREATE TABLE ALTER DROP AND OR NOT NULL AS DISTINCT UNION CASE WHEN THEN ELSE END PRIMARY KEY WITH RETURNING TRUE FALSE`, "", SQL],
  swift: [`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is nil rethrows super self Self throw throws try await async true false some any`, `print String Int Double Bool Array Dictionary Set Optional`, C_DOUBLE],
  php: [`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null int string bool float array void mixed`, `strlen count array_map array_filter implode explode preg_match preg_replace sprintf printf json_encode json_decode var_dump print_r str_replace trim date time`, PHP],
  dart: [`abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return sealed set show static super switch sync this throw true try typedef var void while with yield int double num bool String List Map Set Object`, `print main runApp setState build initState dispose`, C_QUOTES],
  toml: [`true false`, "", HASH_QUOTES],
  ini: [`true false`, "", INI],
  dockerfile: [`FROM AS RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL true false`, "", DOCKERFILE],
  html: ["", "", HTML],
  css: ["", "", CSS],
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
  "c#": "cs",
  "csharp": "cs",
  "h": "c",
  "c++": "cpp",
  "cc": "cpp",
  "cxx": "cpp",
  "hpp": "cpp",
  "rs": "rust",
  "py": "python",
  "bash": "sh",
  "shell": "sh",
  "zsh": "sh",
  "console": "sh",
  "terminal": "sh",
  "shellsession": "sh",
  "jvm": "java",
  "kotlin": "java",
  "kt": "java",
  "scala": "java",
  "groovy": "java",
  "powershell": "ps",
  "pwsh": "ps",
  "ps1": "ps",
  "rb": "ruby",
  "jsonc": "json",
  "json5": "json",
  "yml": "yaml",
  "patch": "diff",
  "xml": "html",
  "svg": "html",
  "xhtml": "html",
  "vue": "html",
  "scss": "css",
  "less": "css",
  "flutter": "dart",
  "cfg": "ini",
  "conf": "ini",
  "properties": "ini",
  "docker": "dockerfile",
  "containerfile": "dockerfile",
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
  builtinSet: Set<string>;
  /** HTML mode: tag names, attributes and text need structural context. */
  isHtml?: boolean;
  /** CSS mode: brace depth separates selectors from properties. */
  isCss?: boolean;
  inTag?: boolean;
  firstWordInTag?: boolean;
};

type ScannerTemplate = Omit<Scanner, "inTag" | "firstWordInTag">;
const scannerTemplates = new Map<string, ScannerTemplate>();
let scannerTemplateBuilds = 0;

function words(packed: string): string[] {
  return packed.length > 0 ? packed.split(" ") : [];
}

function profile(kind: Profile): Pick<
  ScannerTemplate,
  "lineComments" | "blockComments" | "stringDelims" | "tripleStringDelims" | "caseInsensitive"
> {
  switch (kind) {
    case C_TEMPLATE:
      return { lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'", "`"], caseInsensitive: false };
    case C_QUOTES:
      return { lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"], caseInsensitive: false };
    case C_DOUBLE:
      return { lineComments: ["//"], blockComments: [["/*", "*/"]], stringDelims: ["\""], caseInsensitive: false };
    case HASH_QUOTES:
      return { lineComments: ["#"], blockComments: [], stringDelims: ["\"", "'"], caseInsensitive: false };
    case PYTHON:
      return { lineComments: ["#"], blockComments: [], stringDelims: ["\"", "'"], tripleStringDelims: [["\"\"\"", "\"\"\""], ["'''", "'''"]], caseInsensitive: false };
    case POWERSHELL:
      return { lineComments: ["#"], blockComments: [["<#", "#>"]], stringDelims: ["\"", "'"], caseInsensitive: true };
    case JSON_PROFILE:
      return { lineComments: [], blockComments: [], stringDelims: ["\""], caseInsensitive: false };
    case SQL:
      return { lineComments: ["--"], blockComments: [["/*", "*/"]], stringDelims: [], caseInsensitive: true };
    case PHP:
      return { lineComments: ["//", "#"], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"], caseInsensitive: false };
    case INI:
      return { lineComments: ["#", ";"], blockComments: [], stringDelims: ["\""], caseInsensitive: false };
    case DOCKERFILE:
      return { lineComments: ["#"], blockComments: [], stringDelims: ["\""], caseInsensitive: false };
    case HTML:
      return { lineComments: [], blockComments: [["<!--", "-->"]], stringDelims: ["\"", "'"], caseInsensitive: false };
    case CSS:
      return { lineComments: [], blockComments: [["/*", "*/"]], stringDelims: ["\"", "'"], caseInsensitive: false };
  }
}

function scannerTemplate(language: string): ScannerTemplate | null {
  const cached = scannerTemplates.get(language);
  if (cached) return cached;
  const packed = PACKED_FAMILIES[language];
  if (!packed) return null;
  const config = profile(packed[2]);
  const normalize = (word: string): string => config.caseInsensitive ? word.toLowerCase() : word;
  const template: ScannerTemplate = {
    ...config,
    keywordSet: new Set(words(packed[0]).map(normalize)),
    builtinSet: new Set(words(packed[1]).map(normalize)),
    isHtml: language === "html",
    isCss: language === "css",
  };
  scannerTemplates.set(language, template);
  scannerTemplateBuilds += 1;
  return template;
}

export function syntaxScannerCacheDiagnostics(): {
  entries: number;
  builds: number;
  languages: string[];
} {
  return {
    entries: scannerTemplates.size,
    builds: scannerTemplateBuilds,
    languages: [...scannerTemplates.keys()],
  };
}

export function clearSyntaxScannerCache(): void {
  scannerTemplates.clear();
  scannerTemplateBuilds = 0;
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
  const template = scannerTemplate(normalized);
  if (!template) {
    return code.split("\n").map((line) => [{ type: "plain" as const, text: line }]);
  }
  // Per-highlight structural state stays isolated; the expensive word sets
  // and delimiter profiles are immutable and shared by language.
  const scanner: Scanner = {
    ...template,
    inTag: false,
    firstWordInTag: false,
  };

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
      } else if (scanner.builtinSet.has(probe)) {
        push("function", word);
      } else if (isCall) {
        push("function", word);
      } else if (word.startsWith("$")) {
        push("keyword", word);
      } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) {
        // SCREAMING_SNAKE constants read like literal values.
        push("number", word);
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
