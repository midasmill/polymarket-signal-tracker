/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (CORRECTED)
=========================== */

import fetch from "node-fetch";

/**
 * Run the Market NO Extremes scanner
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase 
 */
export async function runMarketNoExtremes(supabase) {
  try {
    console.log("🔥 Market NO Extremes scanner starting...");

    // ------------------------------
    // SETTINGS (adjust for testing)
    // ------------------------------
    const NO_MAX = 0.999;       // TEST: include high NO prices for now
    const HOURS_MAX = 48;       // TEST: include markets ending within 48h
    const HOURS_MIN = 0.1;      // exclude already ended
    const MIN_VOLUME = 100000;  // overhyped filter
    const MIN_LIQUIDITY = 50000;

    // ------------------------------
    // FETCH markets from Polymarket Gamma API
    // ------------------------------
    const url = `https://gamma-api.polymarket.com/markets?closed=false&volume_num_min=${MIN_VOLUME}&liquidity_num_min=${MIN_LIQUIDITY}&limit=100`;
    const res = await fetch(url);
    const markets = await res.json();

    if (!markets || !markets.length) {
      console.log("⚠️ No markets returned from API");
      return;
    }

    // ------------------------------
    // FILTER markets
    // ------------------------------
    const now = Date.now();
    const filtered = markets.filter(m => {
      if (!m.active) return false;

      // Parse outcomePrices string
      let prices = [];
      try {
        prices = JSON.parse(m.outcomePrices || "[]");
      } catch (e) {
        console.log(m.slug, "skipped: failed to parse outcomePrices");
        return false;
      }

      if (!prices[1]) {
        console.log(m.slug, "skipped: missing NO price");
        return false;
      }

      const yesPrice = Number(prices[0]);
      const noPrice = Number(prices[1]);
      const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;

      // Debug logging
      console.log(
        m.slug,
        "| NO:", noPrice,
        "| YES:", yesPrice,
        "| hoursLeft:", hoursLeft.toFixed(1)
      );

      if (Number.isNaN(noPrice)) {
        console.log(m.slug, "skipped: NO price is NaN");
        return false;
      }
      if (noPrice > NO_MAX) {
        console.log(m.slug, "skipped: NO too high", noPrice);
        return false;
      }
      if (hoursLeft > HOURS_MAX || hoursLeft <= HOURS_MIN) {
        console.log(m.slug, "skipped: hoursLeft filter", hoursLeft.toFixed(1));
        return false;
      }

      return true;
    });

    if (!filtered.length) {
      console.log("⚠️ No markets passed the filters");
      return;
    }

    console.log(`✅ ${filtered.length} markets passed filters`);

    // ------------------------------
    // INSERT into Supabase table
    // ------------------------------
    for (const m of filtered) {
      const prices = JSON.parse(m.outcomePrices);
      const yesPrice = Number(prices[0]);
      const noPrice = Number(prices[1]);
      const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;

      const insertData = {
        polymarket_id: m.id,
        market_id: m.id,
        question: m.question,
        market_name: m.events?.[0]?.title || m.question,
        no_price: noPrice,
        yes_price: yesPrice,
        end_at: m.endDate,
        hours_to_resolution: hoursLeft
      };

      const { error } = await supabase
        .from("market_no_extremes")
        .insert([insertData]);

      if (error) console.error("❌ Insert error for", m.slug, error);
      else console.log("🟢 Inserted", m.slug);
    }

    console.log("🔥 Market NO Extremes scanner done.");
  } catch (err) {
    console.error("🔥 Scanner error:", err);
  }
}
