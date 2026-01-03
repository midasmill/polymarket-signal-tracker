/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE)
=========================== */

import fetch from "node-fetch";

/**
 * Run the Market NO Extremes scanner
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {function} sendToNotes - optional, function to send formatted notes
 * @param {function} sendToTelegram - optional, function to send summary to Telegram
 */
export async function runMarketNoExtremes(supabase, sendToNotes, sendToTelegram) {
  console.log("🟢 Market NO Extremes scanner started");

  try {
    const NO_MAX = 0.10;       // NO ≤ 10%
    const MIN_VOLUME = 5000;  // Overhyped filter: minimum volume
    const MIN_LIQUIDITY = 1000;
    const LIMIT = 500;

    const now = Date.now();

    // ------------------------------
    // FETCH markets from Polymarket Gamma API
    // ------------------------------
    const url = `https://gamma-api.polymarket.com/markets?closed=false&volume_num_min=${MIN_VOLUME}&liquidity_num_min=${MIN_LIQUIDITY}&limit=${LIMIT}`;
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
    // FILTER markets: NO ≤ 10% AND not expired
    // ------------------------------
    const filtered = markets.filter(m => {
      if (!m.active) return false;

      let prices = [];
      try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
      if (!prices[1]) return false;

      const noPrice = Number(prices[1]);

      const hoursLeft = m.endDate ? ((new Date(m.endDate) - now) / 1000 / 3600) : -1;
      if (hoursLeft <= 0) return false; // skip expired

      return noPrice <= NO_MAX;
    });

    console.log(`🔹 ${filtered.length} markets passed NO ≤ 10% filter`);
    if (!filtered.length) return;

    // ------------------------------
    // INSERT into Supabase table (skip duplicates)
    // ------------------------------
    const newMarkets = [];
    for (let i = 0; i < filtered.length; i++) {
      const m = filtered[i];
      let prices = [];
      try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
      const yesPrice = Number(prices[0] || 0);
      const noPrice = Number(prices[1] || 0);
      const hoursLeft = m.endDate ? ((new Date(m.endDate) - now) / 1000 / 3600) : null;

      // Check for duplicates by polymarket_id
      const { data: existing } = await supabase
        .from("market_no_extremes")
        .select("id")
        .eq("polymarket_id", parseInt(m.id))
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`⚠️ Skipping duplicate: ${m.slug}`);
        continue;
      }

      const insertData = {
        polymarket_id: parseInt(m.id),
        condition_id: m.conditionId || null,
        market_id: m.id,
        event_slug: m.slug,
        question: m.question,
        market_name: m.events?.[0]?.title || m.question,
        market_type: null,
        category: null,
        event_start_at: m.startDate ? new Date(m.startDate) : null,
        market_end_at: m.endDate ? new Date(m.endDate) : null,
        hours_to_resolution: hoursLeft,
        yes_price: yesPrice,
        no_price: noPrice,
        volume: m.volumeNum ? Number(m.volumeNum) : null,
        liquidity: m.liquidityNum ? Number(m.liquidityNum) : null,
        open_interest: null,
        is_active: m.active,
        is_resolved: false,
        fetched_at: new Date()
      };

      const { error } = await supabase
        .from("market_no_extremes")
        .insert([insertData]);

      if (error) console.error("❌ Insert error:", error, insertData);
      else {
        console.log(`🟢 Inserted: ${m.slug}`);
        newMarkets.push(m);
      }
    }

    // ------------------------------
    // FORMAT summary for Notes/Telegram (only new markets)
    // ------------------------------
    if (newMarkets.length && (sendToNotes || sendToTelegram)) {
      const summary = newMarkets.map((m, idx) => {
        let prices = [];
        try { prices = JSON.parse(m.outcomePrices || "[]"); } catch {}
        const yesPrice = Number(prices[0] || 0);
        const noPrice = Number(prices[1] || 0);
        const hoursLeft = m.endDate ? ((new Date(m.endDate) - now) / 1000 / 3600).toFixed(1) : "?";

        const marketSlug = m.events?.[0]?.slug || m.slug;
        const link = `https://polymarket.com/market/${marketSlug}`;

        return `${idx + 1}. [${m.question}](${link})\n• YES: ${(yesPrice*100).toFixed(1)}% | NO: ${(noPrice*100).toFixed(1)}%\n• Ends in: ${hoursLeft}h`;
      }).join("\n\n");

      if (sendToNotes) {
        console.log("📝 Sending summary to Notes...");
        await sendToNotes(summary, "polymarket-millionaires");
      }

      if (sendToTelegram) {
        console.log("📲 Sending summary to Telegram...");
        await sendToTelegram(summary);
      }
    }

    console.log("🔥 Market NO Extremes scanner finished");

  } catch (err) {
    console.error("🔥 Scanner error:", err);
  }
}
