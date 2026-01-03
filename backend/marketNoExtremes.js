/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE)
=========================== */

import fetch from "node-fetch";

// ---------------- Constants ----------------
const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const NOTES_SLUG = "polymarket-millionaires";

const NO_MAX = 0.10;
const HOURS_MAX = 6;
const HOURS_MIN = 0.10;
const FETCH_LIMIT = 500;

const MIN_VOLUME = 100_000;
const MIN_LIQUIDITY = 50_000;

/* ---------------- Fetch active markets ---------------- */
async function fetchActiveMarkets() {
  const res = await fetch(`${GAMMA_API}?active=true&limit=${FETCH_LIMIT}`);
  if (!res.ok) throw new Error(`Gamma API failed: ${res.status}`);
  return res.json();
}

/* ---------------- Filter NO @ 0–10% + <6h + overhyped ---------------- */
function filterNoExtremes(markets) {
  const now = Date.now();
  return markets.filter(m => {
    if (!m.active || !m.endDate) return false;
    const hours = (new Date(m.endDate).getTime() - now) / 36e5;
    if (hours <= HOURS_MIN || hours > HOURS_MAX) return false;
    const no = Number(m.outcomes?.[1]?.price);
    if (Number.isNaN(no) || no > NO_MAX) return false;
    if ((m.volume || 0) < MIN_VOLUME) return false;
    if ((m.liquidity || 0) < MIN_LIQUIDITY) return false;
    return true;
  });
}

/* ---------------- Insert snapshot rows ---------------- */
async function insertNoExtremes(markets, supabase) {
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
  await supabase.from("market_no_extremes").insert(rows);
}

/* ---------------- Publish top markets to Notes table ---------------- */
async function publishNoExtremesToNotes(markets, supabase) {
  if (!markets.length) return;

  const body = markets
    .sort((a, b) => a.outcomes[1].price - b.outcomes[1].price)
    .slice(0, 10)
    .map((m, i) =>
      `${i + 1}. [${m.title || m.question}](https://polymarket.com/market/${m.slug})\n` +
      `• NO: ${(m.outcomes[1].price * 100).toFixed(1)}%\n` +
      `• Ends in: ${((new Date(m.endDate) - Date.now()) / 36e5).toFixed(1)}h`
    )
    .join("\n\n");

  await supabase.from("notes").insert([{
    slug: NOTES_SLUG,
    title: "🚨 NO @ 0–10% (Ending <6h, Overhyped)",
    body,
    created_at: new Date()
  }]);
}

/* ---------------- Public entry point ---------------- */
export async function runMarketNoExtremes(supabase) {
  try {
    const markets = await fetchActiveMarkets();
    const extremes = filterNoExtremes(markets);

    await insertNoExtremes(extremes, supabase);
    await publishNoExtremesToNotes(extremes, supabase);

  } catch (err) {
    console.error("Market NO extremes error:", err);
  }
}
