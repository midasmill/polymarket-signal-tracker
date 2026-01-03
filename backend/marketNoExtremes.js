/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE)
=========================== */

import fetch from "node-fetch";
import { supabase } from "./supabaseClient.js";
import { sendToNotes } from "./notes.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const NOTES_SLUG = "polymarket-millionaires";

const NO_MAX = 0.10;
const HOURS_MAX = 12;
const HOURS_MIN = 0.25;
const FETCH_LIMIT = 500;

/* ---------------------------
   Fetch active markets
--------------------------- */
async function fetchActiveMarkets() {
  const res = await fetch(
    `${GAMMA_API}?active=true&limit=${FETCH_LIMIT}`
  );

  if (!res.ok) {
    throw new Error(`Gamma API failed: ${res.status}`);
  }

  return res.json();
}

/* ---------------------------
   Filter NO @ 0–10% ending soon
--------------------------- */
function filterNoExtremes(markets) {
  const now = Date.now();

  return markets.filter(m => {
    if (!m.active || !m.endDate) return false;

    const hours =
      (new Date(m.endDate).getTime() - now) / 36e5;

    if (hours <= HOURS_MIN || hours > HOURS_MAX) return false;

    const yes = Number(m.outcomes?.[0]?.price);
    const no  = Number(m.outcomes?.[1]?.price);

    if (Number.isNaN(no)) return false;

    return no >= 0 && no <= NO_MAX;
  });
}

/* ---------------------------
   Insert snapshot rows
--------------------------- */
async function insertNoExtremes(markets) {
  if (!markets.length) return;

  const rows = markets.map(m => ({
    polymarket_id: m.id,
    market_id: m.marketId,
    condition_id: m.conditionId,
    event_slug: m.slug,

    question: m.question,
    market_name: m.title,
    market_type: m.marketType,
    category: m.category,

    event_start_at: m.startDate,
    market_end_at: m.endDate,
    hours_to_resolution:
      (new Date(m.endDate) - Date.now()) / 36e5,

    yes_price: m.outcomes?.[0]?.price,
    no_price: m.outcomes?.[1]?.price,

    volume: m.volume,
    liquidity: m.liquidity,
    open_interest: m.openInterest,

    is_active: true
  }));

  await supabase
    .from("market_no_extremes")
    .insert(rows);
}

/* ---------------------------
   Publish to Notes
--------------------------- */
async function publishNoExtremes(markets) {
  if (!markets.length) return;

  const body = markets
    .sort((a, b) => a.outcomes[1].price - b.outcomes[1].price)
    .slice(0, 10)
    .map((m, i) => (
      `${i + 1}. **${m.title || m.question}**\n` +
      `• NO: ${(m.outcomes[1].price * 100).toFixed(1)}%\n` +
      `• Ends in: ${(
        (new Date(m.endDate) - Date.now()) / 36e5
      ).toFixed(1)}h\n` +
      `• https://polymarket.com/market/${m.slug}`
    ))
    .join("\n\n");

  await sendToNotes({
    slug: NOTES_SLUG,
    title: "🚨 NO @ 0–10% (Ending <12h)",
    body
  });
}

/* ---------------------------
   Public entry point
--------------------------- */
export async function runMarketNoExtremes() {
  try {
    const markets = await fetchActiveMarkets();
    const extremes = filterNoExtremes(markets);

    await insertNoExtremes(extremes);
    await publishNoExtremes(extremes);

  } catch (err) {
    console.error("Market NO extremes error:", err);
  }
}
