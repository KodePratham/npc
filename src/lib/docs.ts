const PER_LINK_CHAR_LIMIT = 20_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    });
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export interface DocResult {
  url: string;
  text: string;
  error: string | null;
}

export async function fetchDoc(url: string): Promise<DocResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (template-intent-bot docs importer)",
        accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { url, text: "", error: `HTTP ${res.status}` };
    const raw = await res.text();
    const isHtml = /<html|<body|<div|<p[\s>]/i.test(raw);
    const text = (isHtml ? htmlToText(raw) : raw.trim()).slice(0, PER_LINK_CHAR_LIMIT);
    return { url, text, error: text ? null : "No readable text" };
  } catch (err) {
    return { url, text: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fetch all links in parallel. Failures are reported in `error`, never thrown. */
export async function fetchDocs(urls: string[]): Promise<DocResult[]> {
  return Promise.all(urls.map(fetchDoc));
}
