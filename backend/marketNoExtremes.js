/* ===========================
   Market NO Extremes Scanner
   PRODUCTION-READY
=========================== */

import fetch from "node-fetch";

/**
 * Run the Market NO Extremes scanner
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {function} sendToNotes - function to send formatted notes
 */
export async function runMarketNoExtremes(supabase, sendToNotes) {
  console.log("🟢 Market NO Extremes scanner started");

  try {
    // ------------------------------
    // SETTINGS
    // ------------------------------
    const NO_MAX = 0.10;      // NO ≤ 10%
    const HOURS_MAX = 6;      // ending within next 6 hours
    const HOURS_MIN = 0;      // exclude already ended
    const MIN_VOLUME = 100000;   // overhyped threshold
    const MIN_LIQUIDITY = 50000;

    const now = Date.now();

    // ------------------------------
    // FETCH markets from Polymarket Gamma API
    // ------------------------------
    const url = `https://gamma-api.polymarket.com/markets?closed=false&volume_num_min=${MIN_VOLUME}&liquidity_num_min=${MIN_LIQUIDITY}&limit=200`;
    console.log("🌐 Fetching markets from:", url);

    const res = await fetch(url);
    if (!res.ok) {
      console.error("❌ API request failed:", res.status, res.statusText);
      return;
    }

    const markets = await res.json();
    if (!markets || !markets.length) {
      console.log("⚠️ No markets returned from API");
      return;
    }

    console.log(`🔹 Fetched ${markets.length} markets`);

    // ------------------------------
    // FILTER markets
    // ------------------------------
    const filtered = markets.filter(m => {
      if (!m.active) return false;

      let prices;
      try {
        prices = JSON.parse(m.outcomePrices || "[]");
      } catch {
        return false;
      }

      if (!prices[1]) return false; // ensure NO exists
      const noPrice = Number(prices[1]);
      const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;

      return noPrice <= NO_MAX && hoursLeft <= HOURS_MAX && hoursLeft > HOURS_MIN;
    });

    console.log(`🔹 ${filtered.length} markets passed filters`);

    if (!filtered.length) return;

    // ------------------------------
    // INSERT into Supabase
    // ------------------------------
    const insertPromises = filtered.map(async (m, index) => {
      const prices = JSON.parse(m.outcomePrices);
      const noPrice = Number(prices[1]);
      const yesPrice = Number(prices[0]);
      const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;

      const insertData = {
        polymarket_id: m.id,
        market_id: m.id,
        question: m.question,
        market_name: m.events?.[0]?.title || m.question,
        no_price: noPrice,
        yes_price: yesPrice,
        end_at: m.endDate,
        hours_to_resolution: hoursLeft,
      };

      const { error } = await supabase
        .from("market_no_extremes")
        .insert([insertData]);

      if (error) console.error("❌ Insert error for", m.slug, error);
      else console.log(`🟢 Inserted: ${m.slug}`);

      return { index: index + 1, market: m, noPrice, hoursLeft };
    });

    const results = await Promise.all(insertPromises);

    // ------------------------------
    // SEND formatted summary to Notes
    // ------------------------------
    if (sendToNotes) {
      const summary = results.map(r => {
        const link = `https://polymarket.com/market/${r.market.slug}`;
        return `${r.index}. [${r.market.question}](${link})\n• NO: ${(r.noPrice * 100).toFixed(1)}%\n• Ends in: ${r.hoursLeft.toFixed(1)}h`;
      }).join("\n\n");

      console.log("📝 Sending summary to Notes...");
      await sendToNotes(summary, "polymarket-millionaires");
    }

    console.log("🔥 Market NO Extremes scanner finished");
  } catch (err) {
    console.error("🔥 Scanner error:", err);
  }
}
