/* ===========================
   Market NO Extremes Scanner
   ADD-ON MODULE (SAFE, DEBUG READY)
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
    const NO_MAX = 0.999;       // TEST: catch even high-NO markets
    const HOURS_MAX = 48;       // TEST: include markets ending within 48h
    const HOURS_MIN = 0.1;      // exclude already ended
    const MIN_VOLUME = 100000;  // filter overhyped
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
      const noPrice = Number(m.outcomePrices?.[1]);
      const yesPrice = Number(m.outcomePrices?.[0]);
      const hoursLeft = (new Date(m.endDate).getTime() - now) / 36e5;

      // Log every market for debugging
      console.log(
        m.slug,
        "NO:", noPrice,
        "YES:", yesPrice,
        "hoursLeft:", hoursLeft.toFixed(1)
      );

      if (!m.active) {
        console.log(m.slug, "skipped: inactive");
        return false;
      }
      if (Number.isNaN(noPrice)) {
        console.log(m.slug, "skipped: invalid NO price");
        return false;
      }
      if (noPrice > NO_MAX) {
        console.log(m.slug, "skipped: NO too high", noPrice);
        return false;
      }
      if (hoursLeft > HOURS_MAX || hoursLeft <= HOURS_MIN) {
        console.log(m.slug, "skipped: hoursLeft", hoursLeft.toFixed(1));
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
      const noPrice = Number(m.outcomePrices[1]);
      const yesPrice = Number(m.outcomePrices[0]);
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
