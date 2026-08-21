import { cfg } from '../config.js';
import { callAi, extractJson } from '../ai/client.js';

export interface LlmVerdict {
  legacyId: string | null;
  confidence: number;
  reject: string | null;
  note?: string;
}

const SYSTEM = `You disambiguate trading-card marketplace listings against a fixed checklist.

You will be given one listing title and up to 5 candidate cards from the checklist.
Pick the single candidate the listing is actually selling, or reject the listing.

Reject (set "reject") when the listing is any of:
- lot            : multiple cards sold together
- reprint        : unlicensed reprint, novelty, ACEO, custom art
- custom         : hand-made or fan-made
- break_slot     : a spot in a group break / "pick your team" / random
- sealed_product : packs, boxes, tins, cases
- sticker        : Panini sticker album, Adrenalyn, Match Attax (NOT trading cards)
- not_a_card     : jersey, poster, figure, other merch
- wrong_player   : the listing is a real single card but none of the candidates is it

Rules:
- The card number in the title is strong evidence. If the title says #214 and no
  candidate has card_number 214, that is usually wrong_player, not a loose match.
- "Rated Rookie" / "RR" implies subset RR.
- A parallel or serial number (/25, 1/1, Gold, Holo) does NOT change which card it
  is — only which version. Still pick the base checklist entry.
- A grade (PSA 10, BGS 9.5) does NOT change which card it is.
- Do not guess. Confidence below 0.7 means the caller drops the comp, which is the
  correct outcome for a genuinely ambiguous title. A wrong match corrupts a price.

Respond with JSON only:
{"legacyId": "<candidate legacy_id or null>", "confidence": 0.0-1.0, "reject": "<reason or null>", "note": "<max 12 words>"}`;

export async function llmAdjudicate(
  title: string,
  candidates: Array<{
    legacy_id: string; product_code: string; section: string;
    card_number: string; player: string; team: string | null; subset: string;
  }>,
): Promise<LlmVerdict | null> {
  if (!candidates.length) return null;

  const table = candidates
    .map((c) =>
      `- legacy_id=${c.legacy_id} | product=${c.product_code === 'A' ? 'Donruss Road to WC 25/26' : 'Panini WC 2026'}` +
      ` | section=${c.section} | number=${c.card_number} | player=${c.player}` +
      ` | team=${c.team ?? '?'}${c.subset ? ` | subset=${c.subset}` : ''}`,
    )
    .join('\n');

  const res = await callAi({
    model: cfg.AI_MATCH_MODEL,
    system: SYSTEM,
    user: `LISTING TITLE:\n${title}\n\nCANDIDATES:\n${table}`,
    maxTokens: 200,
    temperature: 0,
    purpose: 'match',
  });
  if (!res) return null;

  const j = extractJson<LlmVerdict>(res.text);
  if (!j) return null;

  const conf = Number(j.confidence);
  return {
    legacyId: typeof j.legacyId === 'string' ? j.legacyId : null,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    reject: typeof j.reject === 'string' && j.reject !== 'null' ? j.reject : null,
    note: j.note,
  };
}
