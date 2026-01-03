/* ===========================
   Market NO Extremes Scanner
   DEBUG-READY VERSION
=========================== */

import fetch from "node-fetch";

/**
 * Run the Market NO Extremes scanner with full logging
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function runMarketNoExtremes(supabase) {
  console.log("🟢 Market NO Extremes scanner loaded");

  try {
    console.log("🔥 Scanner starting...");

    // ------------------------------
    // SETTINGS
    // ------------------------------
    const NO_MAX = 0.999;       // DEBUG: allow high NO to see results
    const HOURS_MAX = 48;       // DEBUG: allow markets ending in next 48h
    const HOURS_MIN = 0.1;      // exclude already ended
    const MIN_VOLUME = 100000;  // only overhyped markets
    const MIN_LIQUIDITY = 50000;

    // ------------------------------
    // FETCH markets from Polymarket Gamma API
    // ------------------------------
    const url = `https://gamma-api.polymarket.com/markets?closed=false&volume_num_min=${MIN_VOLUME}&liquidity_num_min=${MIN_LIQUIDITY}&limit=100`;
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

    console.log(`🔹 Fetched ${markets.length} markets from API`);

    // ------------------------------
    // FILTER markets
    // ------------------------------
    const now = Date.now();
    const filtered = markets.filter(m => {
      if (!m.active) {
        console.log(m.slug, "skipped: inactive");
        return false;
      }

      // Parse outcomePrices
      let prices = [];
      try {
        prices = JSON.parse(m.outcomePrices || "[]");
      } catch {
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

      if (Number.isNaN(noPrice)) {
        console.log(m.slug, "skipped: NO price is NaN");
        return false;
      }
      if (noPrice > NO_MAX) {
        console.log(m.slug, `skipped: NO too high (${noPrice})`);
        return false;
      }
      if (hoursLeft > HOURS_MAX || hoursLeft <= HOURS_MIN) {
        console.log(m.slug, `skipped: hoursLeft filter (${hoursLeft.toFixed(1)}h)`);
        return false;
      }

      console.log("✅ Market passed filter:", m.slug, "| NO:", noPrice, "| hoursLeft:", hoursLeft.toFixed(1));
      return true;
    });

    console.log(`🔹 ${filtered.length} markets passed filters`);

    if (!filtered.length) {
      console.log("⚠️ No markets to insert into Supabase");
      return;
    }

    // ------------------------------
    // INSERT into Supabase
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
        hours_to_resolution: hoursLeft,
      };

      const { error } = await supabase
        .from("market_no_extremes")
        .insert([insertData]);

      if (error) console.error("❌ Insert error for", m.slug, error);
      else console.log("🟢 Inserted into Supabase:", m.slug);
    }

    console.log("🔥 Scanner finished");
  } catch (err) {
    console.error("🔥 Scanner error:", err);
  }
}
