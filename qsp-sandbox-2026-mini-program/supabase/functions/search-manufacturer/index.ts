/**
 * Manufacturer / factory web lookup on Supabase Edge.
 * Fetches public web snippets (Jina reader + DuckDuckGo HTML), then NVIDIA LLM
 * extracts legal company name + address candidates.
 *
 * Secret: NVIDIA_API_KEY
 * Frontend: POST JSON { query } → /functions/v1/search-manufacturer
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1/chat/completions";
const LLM_MODEL = "meta/llama-3.1-8b-instruct";

type ManufacturerHit = {
  name: string;
  address: string;
  source: string;
  confidence?: string;
};

function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    origin &&
      (origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.includes("vercel.app") ||
        origin.includes("github.io"))
      ? origin
      : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function nvidiaChat(payload: Record<string, unknown>): Promise<string> {
  const apiKey = Deno.env.get("NVIDIA_API_KEY") || "";
  if (!apiKey) throw new Error("missing_nvidia_key");
  const res = await fetch(NVIDIA_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 400);
    throw new Error(`upstream_http_${res.status}:${errBody}`);
  }
  const body = await res.json();
  const choices = body?.choices || [];
  if (!choices.length) return "";
  return String(choices[0]?.message?.content || "").trim();
}

function parseJsonFromLlm(text: string): Record<string, unknown> {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("invalid_llm_json");
  }
}

function normalizeQuery(raw: string): string {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/plain, text/html, */*",
        "User-Agent": "QIMA-MiniProgram-ManufacturerLookup/1.0",
      },
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, 14000);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function gatherWebContext(query: string): Promise<{ text: string; sources: string[] }> {
  const q = encodeURIComponent(query + " manufacturer OR factory OR 公司 OR 有限公司 address OR 地址");
  const sources: string[] = [];
  const chunks: string[] = [];

  const ddg = `https://html.duckduckgo.com/html/?q=${q}`;
  const jinaDdg = `https://r.jina.ai/http://html.duckduckgo.com/html/?q=${q}`;
  const jinaWiki =
    `https://r.jina.ai/https://en.wikipedia.org/w/index.php?search=${
      encodeURIComponent(query)
    }`;

  const [ddgText, jinaText, wikiText] = await Promise.all([
    fetchText(ddg, 10000),
    fetchText(jinaDdg, 14000),
    fetchText(jinaWiki, 10000),
  ]);

  if (ddgText && ddgText.length > 200) {
    sources.push("duckduckgo");
    chunks.push("【DuckDuckGo】\n" + stripHtml(ddgText).slice(0, 5000));
  }
  if (jinaText && jinaText.length > 200) {
    sources.push("jina_ddg");
    chunks.push("【Web reader】\n" + jinaText.slice(0, 5000));
  }
  if (wikiText && wikiText.length > 200 && !/did not match any|no results/i.test(wikiText)) {
    sources.push("wikipedia");
    chunks.push("【Wikipedia】\n" + wikiText.slice(0, 3000));
  }

  return { text: chunks.join("\n\n").slice(0, 12000), sources };
}

function stripHtml(html: string): string {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHit(raw: Record<string, unknown>): ManufacturerHit | null {
  const name = String(raw.name || raw.company || raw.manufacturer || "").trim();
  let address = String(raw.address || raw.addr || "").trim();
  if (!name || name.length < 2 || name.length > 120) return null;
  if (/^(n\/?a|unknown|null|none)$/i.test(name)) return null;
  if (address.length > 200) address = address.slice(0, 200);
  if (/^(n\/?a|unknown|null|none)$/i.test(address)) address = "";
  // Reject junk that is clearly not a company
  if (/^(http|www\.|select|click|more results)/i.test(name)) return null;
  return {
    name,
    address,
    source: "web",
    confidence: String(raw.confidence || "").trim() || undefined,
  };
}

async function extractCompanies(
  query: string,
  context: string,
): Promise<ManufacturerHit[]> {
  if (!context || context.length < 80) return [];
  const prompt =
    "You extract manufacturer / factory company records from noisy web search text.\n" +
    "Return ONLY valid JSON (no markdown):\n" +
    '{"results":[{"name":"legal company name","address":"full address if available","confidence":"high|medium|low"}]}\n' +
    "Rules:\n" +
    "- Prefer legal registered names (… Co., Ltd. / …有限公司).\n" +
    "- Address should include city/region when possible; else empty string.\n" +
    "- Max 5 results, most relevant first.\n" +
    "- Do not invent companies not supported by the text.\n" +
    "- If nothing usable, return {\"results\":[]}.\n\n" +
    `User query: ${query}\n\nWeb text:\n${context.slice(0, 9000)}`;

  const raw = await nvidiaChat({
    model: LLM_MODEL,
    messages: [
      { role: "system", content: "You are a careful company-data extractor. Output JSON only." },
      { role: "user", content: prompt },
    ],
    max_tokens: 700,
    temperature: 0.1,
    stream: false,
  });

  try {
    const parsed = parseJsonFromLlm(raw);
    const arr = Array.isArray(parsed.results) ? parsed.results : [];
    const out: ManufacturerHit[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const hit = sanitizeHit(item as Record<string, unknown>);
      if (hit) out.push(hit);
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Small offline enrichment so demos still work when the web fetch is blocked. */
function localEnrichment(query: string): ManufacturerHit[] {
  const q = query.toLowerCase();
  const catalog: ManufacturerHit[] = [
    {
      name: "Shenzhen Zhichuang Co., Ltd.",
      address: "Bao'an District, Shenzhen, Guangdong, China",
      source: "catalog",
    },
    {
      name: "Qiming Toy Supplier Co., Ltd.",
      address: "Dongguan, Guangdong, China",
      source: "catalog",
    },
    {
      name: "QIMA Toy Factory",
      address: "Dongguan, Guangdong, China",
      source: "catalog",
    },
    {
      name: "Hangzhou QIMA Testing Services Co., Ltd.",
      address: "Hangzhou, Zhejiang, China",
      source: "catalog",
    },
  ];
  return catalog.filter((item) => {
    if (item.name.toLowerCase().includes(q)) return true;
    if (item.address.toLowerCase().includes(q)) return true;
    const tokens = q.split(/[\s,，]+/).filter((t) => t.length >= 2);
    return tokens.some((t) => item.name.toLowerCase().includes(t));
  }).slice(0, 3);
}

function dedupeHits(hits: ManufacturerHit[]): ManufacturerHit[] {
  const seen = new Set<string>();
  const out: ManufacturerHit[] = [];
  for (const h of hits) {
    const key = h.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out.slice(0, 6);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, origin);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const query = normalizeQuery(String((body as { query?: string }).query || ""));
    if (query.length < 2) {
      return jsonResponse({ error: "empty_query", results: [] }, 400, origin);
    }

    const { text, sources } = await gatherWebContext(query);
    let results: ManufacturerHit[] = [];
    if (text) {
      results = await extractCompanies(query, text);
    }
    const local = localEnrichment(query);
    results = dedupeHits([...results, ...local]);

    return jsonResponse(
      {
        query,
        results,
        sources,
        source: results.some((r) => r.source === "web") ? "web_ai" : "catalog",
      },
      200,
      origin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("search-manufacturer failed", msg);
    return jsonResponse({ error: msg || "search_failed", results: [] }, 500, origin);
  }
});
