import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV & CONFIG
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253";
const TIMEZONE = process.env.TIMEZONE || "America/New_York";

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const WIN_RATE_THRESHOLD = parseInt(process.env.WIN_RATE_THRESHOLD || "0", 10);
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "2", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

/* ===========================
   Helpers
=========================== */
const marketCache = new Map();

function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

async function sendTelegram(text, useBlockquote = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (useBlockquote) text = toBlockquote(text);
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

async function fetchMarket(eventSlug) {
  if (!eventSlug) return null;
  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${eventSlug}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const market = await res.json();
    // Skip closed markets
    if (market.closed) return null;
    marketCache.set(eventSlug, market);
    return market;
  } catch { return null; }
}

function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Wallet Helpers (Enhanced)
=========================== */

/**
 * Resolve the majority outcome for a wallet for a given event.
 * Ignores events where the wallet has conflicting picks (both sides).
 */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  const { data: signals } = await supabase
    .from("signals")
    .select("picked_outcome, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;

  // Count total per picked_outcome
const totals = {};
for (const sig of signals) {
  if (!sig.picked_outcome) continue;
  totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + 1;
}

  // If wallet has picks on both sides, ignore this event
  if (Object.keys(totals).length > 1) return null;

  // Otherwise, return the single outcome
  const majorityPick = Object.keys(totals)[0];
  const majoritySignal = signals.find(s => s.picked_outcome === majorityPick);
  return majoritySignal?.outcome || null;
}

/**
 * Count the number of losses for a wallet today.
 * Excludes events where wallet has both sides.
 */
async function countWalletDailyLosses(walletId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);

  const { data: events } = await supabase
    .from("signals")
    .select("event_slug")
    .eq("wallet_id", walletId)
    .eq("outcome", "LOSS")
    .gte("outcome_at", start.toISOString())
    .lte("outcome_at", end.toISOString());

  if (!events?.length) return 0;

  let lossCount = 0;
  const uniqueEvents = [...new Set(events.map(e => e.event_slug).filter(Boolean))];

  for (const eventSlug of uniqueEvents) {
    const result = await resolveWalletEventOutcome(walletId, eventSlug);
    if (result === "LOSS") lossCount++;
  }

  return lossCount;
}

/* ===========================
   Fetch Leaderboard Wallets (with PnL & volume filters)
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","SPORTS"];
  const periods = ["DAY","WEEK"];
  for (const cat of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${cat}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl < 1000000 || entry.vol >= 2 * entry.pnl) continue;

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();
          if (existing) continue;

          const { data: insertedWallet } = await supabase
            .from("wallets")
            .insert({
              polymarket_proxy_wallet: proxyWallet,
              polymarket_username: entry.userName || null,
              last_checked: new Date(),
              paused: false,
              losing_streak: 0,
              win_rate: 0,
              force_fetch: true,
            })
            .select("*")
            .single();

          // Track wallet immediately
          await trackWallet(insertedWallet);
        }

      } catch (err) {
        console.error(`Leaderboard fetch failed (${cat}/${period}):`, err.message);
      }
    }
  }
}

/* ===========================
   Fetch Wallet Activity (DATA-API)
=========================== */
async function fetchWalletActivities(proxyWallet, retries = 3) {
  if (!proxyWallet) return [];

  const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });

      if (res.status === 404) {
        console.warn(`❌ Activity fetch 404 for wallet ${proxyWallet}`);
        return [];
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data;

    } catch (err) {
      console.error(`❌ Activity fetch attempt ${attempt} failed for wallet ${proxyWallet}: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  console.error(`❌ Activity fetch failed after ${retries} attempts for wallet ${proxyWallet}`);
  return [];
}

/* ===========================
   Track Wallet (Enhanced)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`[TRACK] Wallet ${wallet.id} has no proxy, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // 1️⃣ Fetch positions from Polymarket
  const positions = await fetchWalletPositions(proxyWallet);
  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals once
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("tx_hash, event_slug")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const existingEvents = new Set(existingSignals.map(s => s.event_slug));

  const newSignals = [];

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    // 3️⃣ Skip if wallet already has a signal for this event
    if (existingEvents.has(eventSlug)) continue;

    // 4️⃣ Determine picked_outcome
    let pickedOutcome;
    let sideValue = pos.side?.toUpperCase() || "BUY";

    // Handle different market types
    if (pos.title?.includes(" vs. ")) {
      // Team market (sports game)
      const [teamA, teamB] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(pos.title)) {
      // Over/Under market
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else {
      // Default Yes/No binary
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    // 5️⃣ Generate synthetic tx hash for uniqueness
    const syntheticTx = [
      proxyWallet,
      pos.asset,
      pos.timestamp,
      pos.amount
    ].join("-");

    if (existingTxs.has(syntheticTx)) continue;

    // 6️⃣ Fetch market (skip if closed)
    const market = await fetchMarket(eventSlug);
    if (!market) continue;

    // 7️⃣ Push new signal
    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,
      side: sideValue,
      picked_outcome: pickedOutcome,
      tx_hash: syntheticTx,
      pnl: pos.cashPnl ?? null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(pos.timestamp ? pos.timestamp * 1000 : Date.now()),
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null
    });
  }

  if (!newSignals.length) return;

  // 8️⃣ Insert signals
  const { error } = await supabase
    .from("signals")
    .insert(newSignals);

  if (error) {
    console.error(`❌ Failed inserting/upserting signals for wallet ${wallet.id}:`, error.message);
  } else {
    console.log(`✅ Inserted ${newSignals.length} new signal(s) for wallet ${wallet.id}`);
  }
}

/* ===========================
   Confidence
=========================== */

const CONFIDENCE_THRESHOLDS = {
  "⭐": 2,
  "⭐⭐": 5,
  "⭐⭐⭐": 10,
  "⭐⭐⭐⭐": 20,
  "⭐⭐⭐⭐⭐": 50
};

/* ===========================
   Rebuild Wallet Live Picks
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (!signals?.length) return;

  const livePicksMap = new Map();

  for (const sig of signals) {
    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, {
        wallets: [],
        vote_count: 0,
        market_id: sig.market_id,
        market_name: sig.market_name,
        event_slug: sig.event_slug,
        picked_outcome: sig.picked_outcome
      });
    }

    const entry = livePicksMap.get(key);
    entry.wallets.push(sig.wallet_id);
    entry.vote_count++;
  }

  const finalLivePicks = [];

  for (const p of livePicksMap.values()) {
    const voteCount = p.vote_count;

    // Determine confidence based on number of wallets
    let confidence = null;
    for (const [stars, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort((a, b) => b[1] - a[1])) {
      if (voteCount >= threshold) {
        confidence = stars;
        break;
      }
    }

    if (!confidence) continue; // skip if below 1⭐ threshold

    finalLivePicks.push({
      ...p,
      confidence,
      fetched_at: new Date()
    });
  }

  if (!finalLivePicks.length) return;

  const { error } = await supabase
    .from("wallet_live_picks")
    .upsert(finalLivePicks, { onConflict: ["market_id", "picked_outcome"] });

  if (error) {
    console.error("❌ Failed upserting wallet live picks:", error.message);
  } else {
    console.log(`✅ Wallet live picks rebuilt (${finalLivePicks.length} picks)`);
  }
}

/* ===========================
   Fetch Wallet Activity (DATA-API)
=========================== */
async function fetchWalletPositions(proxyWallet) {
  if (!proxyWallet) throw new Error("Proxy wallet required");

  try {
    const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    // Map API data to tracker positions
    return data.map(item => ({
      asset: item.transactionHash || "",       // original tx hash
      conditionId: item.conditionId || "",    // market id
      eventSlug: item.eventSlug || item.slug || "", // event slug
      title: item.title || "",
      slug: item.slug || "",
      timestamp: item.timestamp || Math.floor(Date.now() / 1000),
      side: item.side || "BUY",               // default to BUY if missing
      cashPnl: Number(item.usdcSize ?? item.size ?? 0), // can adjust later
    }));
  } catch (err) {
    console.error(`❌ Activity fetch failed (fetchWalletPositions) for ${proxyWallet}`, err.message);
    return [];
  }
}

/* ===========================
   Notes Update Helper (new lines)
=========================== */
async function updateNotes(slug, text) {
  const noteText = text
    .split("\n")
    .map(line => `> ${line}`) // blockquote for readability
    .join("\n");

  const { data: notes } = await supabase.from("notes").select("content").eq("slug", slug).maybeSingle();
  let newContent = notes?.content || "";

  // append new signal with a line break
  newContent += newContent ? `\n\n${noteText}` : noteText;

  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", slug);
}


/* ===========================
   Wallet Metrics Update
=========================== */
async function updateWalletMetricsJS() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  for (const wallet of wallets) {
    // Fetch resolved signals for this wallet
    const { data: resolvedSignals } = await supabase
      .from("signals")
      .select("event_slug, picked_outcome, outcome")
      .eq("wallet_id", wallet.id)
      .in("outcome", ["WIN", "LOSS"]);

    if (!resolvedSignals?.length) continue;

    // Group signals by event
    const eventsMap = new Map();
    for (const sig of resolvedSignals) {
      if (!sig.event_slug) continue;
      if (!eventsMap.has(sig.event_slug)) eventsMap.set(sig.event_slug, []);
      eventsMap.get(sig.event_slug).push(sig);
    }

    let wins = 0, losses = 0;

    for (const [eventSlug, signalsForEvent] of eventsMap.entries()) {
      // Skip wallets that have both sides for this event
      const pickedOutcomes = new Set(signalsForEvent.map(s => s.picked_outcome).filter(Boolean));
      if (pickedOutcomes.size > 1) continue;

      // Determine majority outcome for this wallet/event
      const outcome = signalsForEvent[0]?.outcome || null;
      if (outcome === "WIN") wins++;
      if (outcome === "LOSS") losses++;
    }

    const total = wins + losses;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

    // Count daily losses safely
    const dailyLosses = await countWalletDailyLosses(wallet.id);
    const shouldPause = dailyLosses >= 3;

    await supabase
      .from("wallets")
      .update({
        win_rate: winRate,
        paused: shouldPause ? true : wallet.paused,
        last_checked: new Date()
      })
      .eq("id", wallet.id);
  }
}

/* ===========================
   Signal Processing + Telegram Sending (Patched)
=========================== */
async function processAndSendSignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks } = await supabase
    .from("wallet_live_picks")
    .select("*");

  if (!livePicks?.length) return;

  const signalsToSend = [];

  for (const pick of livePicks) {
    // ✅ Skip if no wallets
    if (!pick.wallets?.length) continue;

    // 2️⃣ Calculate confidence emoji based on wallet count
    const confidenceEmoji = getConfidenceEmoji(pick.vote_count);

    // 3️⃣ Compose message
    const text = `⚡️ Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Signal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`;

    signalsToSend.push({
      market_id: pick.market_id,
      picked_outcome: pick.picked_outcome,
      text,
    });
  }

  // 4️⃣ Send signals & update Notes
  for (const sig of signalsToSend) {
    try {
      await sendTelegram(sig.text, true); // blockquote formatting
      await updateNotes("polymarket-millionaires", sig.text);
      console.log(`✅ Sent signal for market ${sig.market_id}`);
    } catch (err) {
      console.error(`❌ Failed to send signal for market ${sig.market_id}:`, err.message);
    }

    // 5️⃣ Mark as sent
    await supabase
      .from("wallet_live_picks")
      .update({ last_confidence_sent: new Date() })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }
}

/* ===========================
   Tracker Loop (Enhanced)
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    // 1️⃣ Fetch all active wallets
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("*");

    if (walletsError) {
      console.error("❌ Failed fetching wallets:", walletsError.message);
      return;
    }
    if (!wallets?.length) return;

    // 2️⃣ Track wallets concurrently
    await Promise.allSettled(wallets.map(trackWallet));

    // 3️⃣ Rebuild live picks from updated signals
    await rebuildWalletLivePicks();

    // 4️⃣ Process and send signals
    await processAndSendSignals();

    // 5️⃣ Update wallet metrics (win_rate, paused, daily losses)
    await updateWalletMetricsJS();

  } catch (err) {
    console.error("❌ Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // 1️⃣ Initial fetch leaderboard and wallet tracking
  await fetchAndInsertLeaderboardWallets().catch(err => console.error(err));
  await trackerLoop();

  // 2️⃣ Set continuous polling
  setInterval(trackerLoop, POLL_INTERVAL);

  // 3️⃣ Daily cron for leaderboard refresh
  cron.schedule("0 7 * * *", async () => {
    console.log("📅 Daily cron running...");
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();
  }, { timezone: TIMEZONE });

  // 4️⃣ Heartbeat log
  setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

  // 5️⃣ Simple HTTP server for health check
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket tracker running\n");
  }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
}

main();
