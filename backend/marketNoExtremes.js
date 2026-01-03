/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE)
=========================== */

import fetch from "node-fetch";
import { supabase } from "./supabaseClient.js";
import { sendToNotes } from "./notes.js";

const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const NOTES_SLUG = "polymarket-millionaires";

// ---------------- Constants ----------------
const NO_MAX = 0.10;        // NO 0–10%
const HOURS_MAX = 6;        // <6 hours remaining
const HOURS_MIN = 0.10;     // ~6 minutes safety buffer
const FETCH_LIMIT = 500;    // Number of markets to fetch
const MIN_VOLUME = 100_000; // Overhyped filter: minimum volume
const MIN_LIQUIDITY = 50_000; // Overhyped filter: minimum liquidity

// ---------------- Fetch active markets ----------------
async function fetchActiveMarkets() {
  const res = await fetch(
    `${GAMMA_API}?active=true&limit=${FETCH_LIMIT}`
  );

  if (!res.ok) {
    throw new Error(`Gamma API failed: ${res.status}`);
  }

  return res.json();
}

// ---------------- Filter NO @ 0–10% + <6h + overhyped ----------------
function filterNoExtremes(markets) {
  const now = Date.now();

  return markets.filter(m => {
    if (!m.active || !m.endDate) return false;

    const hours = (new Date(m.endDate).getTime() - now) / 36e5;

    if (hours <= HOURS_MIN || hours > HOURS_MAX) return false;

    const no = Number(m.outcomes?.[1]?.price);
    if (Number.isNaN(no) || no > NO_MAX) return false;

    // Overhyped filter: ensure enough money is on the market
    if ((m.volume || 0) < MIN_VOLUME) return false;
    if ((m.liquidity || 0) < MIN_LIQUIDITY) return false;

    return true;
  });
}

// ---------------- Insert snapshot rows into Supabase ----------------
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
    hours_to_resolution: (new Date(m.endDate) - Date.now()) / 36e5,

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

// ---------------- Publish top markets to Notes ----------------
async function publishNoExtremes(markets) {
  if (!markets.length) return;

  const body = markets
    .sort((a, b) => a.outcomes[1].price - b.outcomes[1].price)
    .slice(0, 10)
    .map((m, i) => (
      `${i + 1}. [${m.title || m.question}](https://polymarket.com/market/${m.slug})\n` +
      `• NO: ${(m.outcomes[1].price * 100).toFixed(1)}%\n` +
      `• Ends in: ${((new Date(m.endDate) - Date.now()) / 36e5).toFixed(1)}h`
    ))
    .join("\n\n");

  await sendToNotes({
    slug: NOTES_SLUG,
    title: "🚨 NO @ 0–10% (Ending <6h, Overhyped)",
    body
  });
}

// ---------------- Public entry point ----------------
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
