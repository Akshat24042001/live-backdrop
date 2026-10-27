// One interface over several AI providers: pick(provider, ...) -> parsed JSON highlight.
// Claude uses the official Anthropic SDK; the others are plain HTTPS calls to their public APIs.
import Anthropic from '@anthropic-ai/sdk';
import { fetch, Agent } from 'undici';

// Keep HTTPS connections to the AI open between calls. A cold connection (DNS + TLS) cost ~3 s on the
// first highlight of a talk; a warm one costs nothing. See warm() below.
const agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 8 });

export const PROVIDERS = {
  xai: { label: 'Grok (xAI)', key: 'xai', defaultModel: 'grok-4.20-0309-non-reasoning', console: 'https://console.x.ai' },
  groq: { label: 'Groq (fastest)', key: 'groq', defaultModel: 'openai/gpt-oss-120b', console: 'https://console.groq.com/keys' },
  claude: { label: 'Claude (Anthropic)', key: 'anthropic', defaultModel: 'claude-haiku-5-5', console: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', key: 'openai', defaultModel: 'gpt-6-luna', console: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini (Google)', key: 'gemini', defaultModel: 'gemini-3-flash-preview', console: 'https://aistudio.google.com/apikey' },
};

// One conversation id per server run: lets xAI route every call to the same cache.
const CONV_ID = `backdrop-${Date.now().toString(36)}`;

export class ProviderError extends Error {
  constructor(provider, status, msg) { super(`${PROVIDERS[provider]?.label || provider}: ${status ? status + ' ' : ''}${msg}`); this.status = status; }
}

async function http(provider, url, init, timeoutMs) {
  let res;
  try { res = await fetch(url, { ...init, dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new ProviderError(provider, 0, e.name === 'TimeoutError' ? 'timed out' : 'no connection (' + (e.cause?.code || e.message) + ')'); }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || text.slice(0, 200);
    const said = typeof msg === 'string' ? msg : JSON.stringify(msg);
    // A 403 is not always a bad key: xAI answers 403 when the account is out of credits. Say which.
    // (A 429 is a rate limit even when its text links to a billing page.)
    const why = (res.status === 402 || res.status === 403) && /credit|spending limit|billing|quota|balance/i.test(said) ? 'OUT OF CREDITS or spending limit reached — top up the account'
      : res.status === 401 || res.status === 403 ? 'invalid API key' : said;
    throw new ProviderError(provider, res.status, why);
  }
  return json;
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

const clients = new Map();
const anthropicFor = (key) => { if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key })); return clients.get(key); };

// Some models reject optional tuning fields (reasoning effort, thinking). Retry once without them.
async function withFallback(primary, plain) {
  try { return await primary(); } catch (e) { if (e.status === 400 && plain) return plain(); throw e; }
}

export async function pick(provider, { key, model, system, user, schema, timeoutMs = 12000 }) {
  if (!key) throw new ProviderError(provider, 0, 'API key not set (Engines tab)');
  model = model || PROVIDERS[provider].defaultModel;

  if (provider === 'claude') {
    const client = anthropicFor(key);
    const call = (extra) => client.messages.create(
      { model, max_tokens: 1024, ...extra, system, messages: [{ role: 'user', content: user }], output_config: { effort: 'low', format: { type: 'json_schema', schema } } },
      { timeout: timeoutMs, maxRetries: 1 },
    );
    let res;
    try { res = await withFallback(() => call(model.startsWith('claude-haiku') ? { thinking: { type: 'disabled' } } : {}), () => call({})); }
    catch (e) { throw new ProviderError(provider, e.status || 0, e instanceof Anthropic.AuthenticationError ? 'invalid API key' : String(e.message || e).slice(0, 200)); }
    if (res.stop_reason === 'refusal') return { status: 'skip', highlight: '', keyword: '', kind: 'none' };
    return parseJson(res.content.find((b) => b.type === 'text')?.text);
  }

  if (provider === 'xai') {
    // max_tokens caps a runaway answer (a full reply with three extra points is ~300 tokens).
    const body = (fmt) => JSON.stringify({ model, temperature: 0.1, max_tokens: 600, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: fmt });
    // xAI caches a repeated prompt start automatically; this header sends our calls to the same server so the
    // cache is hit (docs.x.ai, "Maximizing cache hits"). The long system prompt is then not re-read every sentence.
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-grok-conv-id': CONV_ID };
    const go = (fmt) => http(provider, 'https://api.x.ai/v1/chat/completions', { method: 'POST', headers, body: body(fmt) }, timeoutMs);
    const res = await withFallback(() => go({ type: 'json_schema', json_schema: { name: 'highlight', schema, strict: true } }), () => go({ type: 'json_object' }));
    const out = parseJson(res.choices?.[0]?.message?.content);
    Object.defineProperty(out, 'usage', { value: { prompt: res.usage?.prompt_tokens, cached: res.usage?.prompt_tokens_details?.cached_tokens, out: res.usage?.completion_tokens }, enumerable: false });
    return out;
  }

  if (provider === 'groq') {
    // Groq runs open models on very fast hardware. gpt-oss reasons briefly; keep that low for latency.
    const body = (fmt, extra) => JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: fmt, ...extra });
    const go = (fmt, extra = {}) => http(provider, 'https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body(fmt, extra) }, timeoutMs);
    const reasoning = /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : /qwen3/.test(model) ? { reasoning_effort: 'none' } : {};
    const res = await withFallback(() => go({ type: 'json_schema', json_schema: { name: 'highlight', schema, strict: true } }, reasoning), () => go({ type: 'json_object' }));
    return parseJson(res.choices?.[0]?.message?.content);
  }

  if (provider === 'openai') {
    const go = (extra) => http(provider, 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions: system, input: user, text: { format: { type: 'json_schema', name: 'highlight', schema, strict: true } }, ...extra }),
    }, timeoutMs);
    const res = await withFallback(() => go({ reasoning: { effort: 'none' } }), () => go({}));
    const text = res.output_text || res.output?.flatMap((o) => o.content || []).find((c) => c.type === 'output_text')?.text;
    return parseJson(text);
  }

  if (provider === 'gemini') {
    // Gemini's responseSchema enforces JSON structure like json_schema for other providers.
    // It must not contain "additionalProperties" (not supported by this API).
    const stripSchema = (s) => {
      if (!s || typeof s !== 'object') return s;
      const { additionalProperties: _, ...rest } = s;
      return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, Array.isArray(v) ? v.map(stripSchema) : (v && typeof v === 'object' ? stripSchema(v) : v)]));
    };
    const responseSchema = schema ? stripSchema(schema) : undefined;
    const go = (extra) => http(provider, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json', ...(responseSchema ? { responseSchema } : {}), ...extra } }),
    }, timeoutMs);
    const res = await withFallback(() => go({ thinkingConfig: { thinkingBudget: 0 } }), () => go({}));
    return parseJson(res.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join(''));
  }

  throw new Error('Unknown AI provider ' + provider);
}

export async function listModels(provider, key) {
  if (!key) throw new ProviderError(provider, 0, 'API key not set');
  if (provider === 'claude') {
    const out = [];
    for await (const m of anthropicFor(key).models.list()) out.push(m.id);
    return out;
  }
  if (provider === 'groq') return (await http(provider, 'https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } }, 10000)).data.map((m) => m.id).filter((id) => !/whisper|tts|guard|orpheus|playai/i.test(id)).sort();
  if (provider === 'xai') return (await http(provider, 'https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } }, 10000)).data.map((m) => m.id);
  if (provider === 'openai') return (await http(provider, 'https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }, 10000)).data.map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort();
  if (provider === 'gemini') {
    const res = await http(provider, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } }, 10000);
    return res.models.filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  }
  return [];
}

// Open (or keep open) the connection to a provider without spending tokens: listing models is free.
export async function warm(provider, key) {
  if (!key || !PROVIDERS[provider] || provider === 'claude') return;
  const t0 = Date.now();
  try { await listModels(provider, key); return Date.now() - t0; } catch { return -1; }
}
