/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE)
=========================== */

import fetch from "node-fetch";

// ---------------- Constants ----------------
const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const NOTES_SLUG = "polymarket-millionaires";

const NO_MAX = 0.10;       // NO <= 10%
const HOURS_MAX = 6;       // Ends in less than 6 hours
const HOURS_MIN = 0.1;     // Filter out already ending markets
const FETCH_LIMIT = 500;   // Max markets per fetch

const MIN_VOLUME = 100_000;   // Overhyped filter
const MIN_LIQUIDITY = 50_000; // Overhyped filter

// ---------------- Fetch markets ----------------
export async function fetchActiveMarkets() {
  const url = `${GAMMA_API}?closed=false&volume_num_min=${MIN_VOLUME}&liquidity_num_min=${MIN_LIQUIDITY}&limit=${FETCH_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API failed: ${res.status}`);
  return res.json();
}

// ---------------- Filter NO extremes ----------------
export function filterNoExtremes(markets) {
  const now = Date.now();

  return markets.filter(m => {
    if (!m.active || !m.endDate || !m.outcomePrices) return false;

    // NO is second outcome
    const noPrice = Number(m.outcomePrices[1]);
    if (Number.isNaN(noPrice) || noPrice > NO_MAX) return false;

    // Ends in <6 hours
    const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;
    if (hoursLeft > HOURS_MAX || hoursLeft <= HOURS_MIN) return false;

    // Extra overhyped checks
    if ((m.volumeNum || 0) < MIN_VOLUME) return false;
    if ((m.liquidityNum || 0) < MIN_LIQUIDITY) return false;

    return true;
  });
}

// ---------------- Insert snapshot rows ----------------
export async function insertNoExtremes(markets, supabase) {
  if (!markets.length) return;

  const rows = markets.map(m => ({
    polymarket_id: m.id,
    market_id: m.marketId || m.id,
    condition_id: m.conditionId,
    event_slug: m.slug,
    question: m.question,
    market_name: m.title || m.question,
    market_type: m.marketType || null,
    category: m.category || null,
    event_start_at: m.startDate,
    market_end_at: m.endDate,
    hours_to_resolution: (new Date(m.endDate) - Date.now()) / 36e5,
    yes_price: m.outcomePrices[0],
    no_price: m.outcomePrices[1],
    volume: m.volumeNum,
    liquidity: m.liquidityNum,
    open_interest: m.openInterest || 0,
    is_active: true
  }));

  await supabase.from("market_no_extremes").insert(rows);
}

// ---------------- Publish top markets to Notes ----------------
export async function publishNoExtremesToNotes(markets, supabase) {
  if (!markets.length) return;

  const body = markets
    .sort((a, b) => {
      const noDiff = a.outcomePrices[1] - b.outcomePrices[1];
      if (noDiff !== 0) return noDiff;            // lowest NO first
      return (b.volumeNum || 0) - (a.volumeNum || 0); // then highest volume
    })
    .slice(0, 10)
    .map((m, i) => {
      const hoursLeft = ((new Date(m.endDate) - Date.now()) / 36e5).toFixed(1);
      return `${i + 1}. [${m.title || m.question}](https://polymarket.com/market/${m.slug})\n` +
             `• NO: ${(m.outcomePrices[1] * 100).toFixed(1)}%\n` +
             `• Ends in: ${hoursLeft}h`;
    })
    .join("\n\n");

  await supabase.from("notes").insert([{
    slug: NOTES_SLUG,
    title: "🚨 NO @ 0–10% (Ending <6h, Overhyped)",
    body,
    created_at: new Date()
  }]);
}

// ---------------- Public entry point ----------------
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
