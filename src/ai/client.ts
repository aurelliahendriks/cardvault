import Anthropic from '@anthropic-ai/sdk';
import { cfg, hasAI } from '../config.js';
import { q } from '../db.js';
import { log } from '../logger.js';

let client: Anthropic | null = null;

export function ai(): Anthropic | null {
  if (!hasAI()) return null;
  client ??= new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 3 });
  return client;
}

// Rough per-million-token USD prices, used only for the local budget guard.
// Adjust if your pricing differs; it never affects behaviour beyond the cap.
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-5': { in: 3.0, out: 15.0 },
  'claude-opus-4-5': { in: 5.0, out: 25.0 },
};

let spendCache: { at: number; usd: number } = { at: 0, usd: 0 };

async function monthSpendUsd(): Promise<number> {
  if (Date.now() - spendCache.at < 60_000) return spendCache.usd;
  const rows = await q<{ model: string; ti: number; to: number }>(
    `SELECT model, COALESCE(SUM(tokens_in),0)::float AS ti, COALESCE(SUM(tokens_out),0)::float AS to_
       FROM ai_queries WHERE asked_at >= date_trunc('month', now()) GROUP BY model`,
  ).catch(() => []);
  let usd = 0;
  for (const r of rows as any[]) {
    const p = PRICE[r.model] ?? { in: 3, out: 15 };
    usd += (Number(r.ti) / 1e6) * p.in + (Number(r.to_ ?? r.to) / 1e6) * p.out;
  }
  spendCache = { at: Date.now(), usd };
  return usd;
}

export async function budgetOk(): Promise<boolean> {
  if (cfg.AI_MONTHLY_BUDGET_USD <= 0) return true;
  const spent = await monthSpendUsd();
  if (spent >= cfg.AI_MONTHLY_BUDGET_USD) {
    log.warn({ spent, cap: cfg.AI_MONTHLY_BUDGET_USD }, 'AI monthly budget exhausted — falling back to deterministic paths');
    return false;
  }
  return true;
}

export interface AiCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  ms: number;
}

/** Single-shot text call with usage accounting. Returns null if AI is off or over budget. */
export async function callAi(opts: {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** label recorded in ai_queries for cost attribution */
  purpose: string;
}): Promise<AiCallResult | null> {
  const c = ai();
  if (!c) return null;
  if (!(await budgetOk())) return null;

  const model = opts.model ?? cfg.AI_MODEL;
  const t0 = Date.now();
  try {
    const res = await c.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    });
    const ms = Date.now() - t0;
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    await q(
      `INSERT INTO ai_queries (question, answer, model, tokens_in, tokens_out, ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [`[${opts.purpose}] ${opts.user.slice(0, 500)}`, text.slice(0, 4000), model,
       res.usage.input_tokens, res.usage.output_tokens, ms],
    ).catch(() => {});
    spendCache.at = 0;

    return { text, tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens, model, ms };
  } catch (e: any) {
    log.error({ err: e.message, purpose: opts.purpose }, 'AI call failed');
    await q(`INSERT INTO ai_queries (question, model, error) VALUES ($1,$2,$3)`,
      [`[${opts.purpose}]`, model, e.message]).catch(() => {});
    return null;
  }
}

/** Pull the first JSON object/array out of a model response. */
export function extractJson<T = any>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  // walk to the matching close so trailing prose doesn't break the parse
  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) as T; } catch { return null; }
      }
    }
  }
  return null;
}
