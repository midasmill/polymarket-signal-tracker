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

const CONFIDENCE_THRESHOLDS = {
  "⭐": 2,
  "⭐⭐": 5,
  "⭐⭐⭐": 10,
  "⭐⭐⭐⭐": 20,
  "⭐⭐⭐⭐⭐": 50
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

/**
 * Returns total $ amount picked per outcome
 * for a wallet on a specific event
 */
async function getWalletOutcomeTotals(walletId, eventSlug) {
  const { data, error } = await supabase
    .from("signals")
    .select("picked_outcome, pnl")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .not("picked_outcome", "is", null)
    .not("pnl", "is", null);

  if (error || !data?.length) return {};

  const totals = {};

  for (const sig of data) {
    totals[sig.picked_outcome] =
      (totals[sig.picked_outcome] || 0) + Number(sig.pnl);
  }

  return totals;
}

/**
 * Returns the wallet's NET picked_outcome for an event
 * based on total $ amount per side
 *
 * Example:
 *  YES: 3000
 *  NO:  2900
 *  => YES
 */
async function getWalletNetPick(walletId, eventSlug) {
  const totals = await getWalletOutcomeTotals(walletId, eventSlug);

  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  // Sort by total desc
  entries.sort((a, b) => b[1] - a[1]);

  const [topOutcome, topAmount] = entries[0];
  const secondAmount = entries[1]?.[1] ?? 0;

  // Optional safety: ignore near-equal hedges (<5%)
  if (secondAmount > 0 && topAmount / secondAmount < 1.05) {
    return null;
  }

  return topOutcome;
}

/* ===========================
   Helpers
=========================== */
const marketCache = new Map();

function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

async function sendTelegram(text, useBlockquote = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (useBlockquote) {
    text = text.split("\n").map(line => `> ${line}`).join("\n"); // only apply if true
  }
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
    marketCache.set(eventSlug, market);

    // ✅ Determine winning outcome for resolved/closed markets
    if (market.closed && market.automaticallyResolved) {
      // Outcomes array is ["USC","TCU"], description explains rules
      // Check which side won using market.description or market.events[0].score
      const event = market.events?.[0];
      if (event) {
        const outcomes = market.outcomes || [];
        // Example rule: if score shows USC won, pick "USC"
        if (event.score) {
          const [scoreA, scoreB] = event.score.split("-").map(Number);
          if (scoreA > scoreB) market.outcome = outcomes[0]; // first outcome wins
          else if (scoreB > scoreA) market.outcome = outcomes[1]; // second outcome wins
          else market.outcome = null; // tie, optional
        }
      }
    }

    return market;
  } catch (err) {
    console.error(`❌ fetchMarket failed for ${eventSlug}:`, err.message);
    return null;
  }
}


function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Resolve Wallet Event Outcome
=========================== */
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

/* ===========================
   Resolve Market
=========================== */
async function resolveMarkets() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending")
    .not("event_slug", "is", null);

  if (!pending?.length) return;

  for (const sig of pending) {
    const market = await fetchMarket(sig.event_slug);
    if (!market) continue;

    const isResolved = market.closed && (market.automaticallyResolved || market.events?.[0]?.ended);
    if (!isResolved) continue;

    let winningOutcome = market.outcome;

    // Fallback: determine outcome from event score / outcomes array
    if (!winningOutcome && market.events?.[0]) {
      const event = market.events[0];
      const outcomes = market.outcomes || [];

      if (event.score) {
        const [scoreA, scoreB] = event.score.split("-").map(Number);
        if (outcomes.length >= 2) {
          if (scoreA > scoreB) winningOutcome = outcomes[0];
          else if (scoreB > scoreA) winningOutcome = outcomes[1];
          else winningOutcome = null;
        }
      }
    }

    if (!winningOutcome) {
      console.warn(`⚠️ Could not determine winning outcome for market ${sig.market_id}`);
      continue;
    }

    const result = sig.picked_outcome.trim().toUpperCase() === winningOutcome.trim().toUpperCase() ? "WIN" : "LOSS";

    // Update signals table
    await supabase
      .from("signals")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome,
        outcome_at: new Date()
      })
      .eq("id", sig.id);

    // Update wallet_live_picks
    await supabase
      .from("wallet_live_picks")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome
      })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);

    console.log(`✅ Resolved market ${sig.market_id}: ${sig.picked_outcome} → ${result} (${winningOutcome})`);
  }
}

/* ===========================
   Count Wallet Daily Losses
=========================== */
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
   Track Wallet (Enhanced / Safe)
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
    console.log(`[TRACK] Wallet ${wallet.id} auto-unpaused (win_rate=${wallet.win_rate})`);
  }

  // 1️⃣ Fetch positions from Polymarket
  const positions = await fetchWalletPositions(proxyWallet);
  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals ONCE
  const { data: existingSignals = [] } = await supabase
    .from("signals")
    .select("wallet_id, event_slug, picked_outcome, tx_hash")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const existingEventOutcome = new Set(
    existingSignals.map(s => `${s.event_slug}||${s.picked_outcome}`)
  );

  const newSignals = [];

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    // ✅ MIN SIZE FILTER ($1,000)
    if ((pos.cashPnl ?? 0) < 1000) continue;

    // 3️⃣ Determine picked_outcome
    let pickedOutcome;
    const sideValue = pos.side?.toUpperCase() || "BUY";

    if (pos.title?.includes(" vs. ")) {
      const [teamA, teamB] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(pos.title)) {
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else {
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    // ✅ Skip if SAME wallet already picked SAME outcome for this event
    if (existingEventOutcome.has(`${eventSlug}||${pickedOutcome}`)) continue;

    // 4️⃣ Generate synthetic tx hash
    const syntheticTx = [
      proxyWallet,
      pos.asset || "",
      pos.timestamp || Date.now(),
      pos.cashPnl
    ].join("-");

    if (existingTxs.has(syntheticTx)) continue;

    // 5️⃣ Fetch market (skip closed)
    const market = await fetchMarket(eventSlug);
    if (!market) continue;

    // 6️⃣ Push signal
    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,
      side: sideValue,
      picked_outcome: pickedOutcome,
      tx_hash: syntheticTx,
      pnl: pos.cashPnl,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(
        pos.timestamp ? pos.timestamp * 1000 : Date.now()
      ),
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null
    });
  }

  if (!newSignals.length) {
    console.log(`[TRACK] Wallet ${wallet.id} has no new signals to insert`);
    return;
  }

  // 7️⃣ Upsert signals safely with unique constraint
  const { error, data } = await supabase
    .from("signals")
    .upsert(newSignals, {
      onConflict: ["wallet_id", "event_slug", "picked_outcome"]
    });

  if (error) {
    console.error(
      `❌ Failed inserting/upserting signals for wallet ${wallet.id}:`,
      error.message
    );
  } else {
    console.log(
      `✅ Wallet ${wallet.id} inserted/updated ${data.length} signal(s)`
    );
  }
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
      const netPick = await getWalletNetPick(wallet.id, eventSlug);
if (!netPick) continue;

const sig = signalsForEvent.find(s => s.picked_outcome === netPick);
if (!sig) continue;

if (sig.outcome === "WIN") wins++;
if (sig.outcome === "LOSS") losses++;


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
   Rebuild Wallet Live Picks (Multi-Wallet Fixed)
=========================== */
async function rebuildWalletLivePicks() {
  console.log("🔄 Rebuilding wallet live picks (safe multi-wallet)...");

  // 1️⃣ Fetch all pending signals with wallets info
  const { data: signals, error } = await supabase
    .from("signals")
    .select(`
      wallet_id,
      market_id,
      market_name,
      event_slug,
      picked_outcome,
      pnl,
      wallets!inner (
        paused,
        win_rate
      )
    `)
    .eq("outcome", "Pending");

  if (error) {
    console.error("❌ Failed fetching signals:", error.message);
    return;
  }

  if (!signals?.length) {
    console.log("⚪ No pending signals found.");
    return;
  }

  console.log(`📊 Fetched ${signals.length} pending signals.`);

  // 2️⃣ Group signals by market + event
  const eventMap = new Map();
  for (const sig of signals) {
    const key = `${sig.market_id}||${sig.event_slug}`;
    if (!eventMap.has(key)) eventMap.set(key, []);
    eventMap.get(key).push(sig);
  }

  const livePicksMap = new Map();

  // 3️⃣ Process each event group
  for (const [key, eventSignals] of eventMap.entries()) {
    const { market_id, market_name, event_slug } = eventSignals[0];

    // Count picks per outcome **only for eligible wallets**
    const outcomeCounts = {};
    const walletList = {};
    for (const sig of eventSignals) {
      if (sig.wallets.paused) continue;
      if (sig.wallets.win_rate < WIN_RATE_THRESHOLD) continue;
      if ((sig.pnl ?? 0) < 1000) continue;

      outcomeCounts[sig.picked_outcome] = (outcomeCounts[sig.picked_outcome] || 0) + 1;
      if (!walletList[sig.picked_outcome]) walletList[sig.picked_outcome] = [];
      walletList[sig.picked_outcome].push(sig.wallet_id);
    }

    if (!Object.keys(outcomeCounts).length) continue;

    // Pick outcome with most votes
    const sorted = Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1]);
    const [netPick, voteCount] = sorted[0];

    if (voteCount < MIN_WALLETS_FOR_SIGNAL) {
      console.log(`⚠️ Skipping ${event_slug} (${netPick}) — only ${voteCount} wallet(s) eligible.`);
      continue;
    }

    const pickKey = `${market_id}||${netPick}`;
    livePicksMap.set(pickKey, {
      market_id,
      market_name,
      event_slug,
      picked_outcome: netPick,
      wallets: walletList[netPick] || [],
      vote_count: voteCount
    });

    console.log(`✅ Event ${event_slug} net pick: ${netPick} (${voteCount} wallet(s))`);
  }

  // 4️⃣ Assign confidence (integer) and prepare final picks
  const finalLivePicks = [];
  for (const pick of livePicksMap.values()) {
    let confidence = pick.vote_count; // store as integer
    finalLivePicks.push({
      ...pick,
      confidence,
      wallets: `{${pick.wallets.join(",")}}`, // convert JS array to Postgres array
      fetched_at: new Date()
    });

    console.log(`🏆 Final pick ${pick.event_slug}: ${pick.picked_outcome} (${pick.vote_count} wallets, confidence: ${confidence})`);
  }

  if (!finalLivePicks.length) {
    console.log("⚪ No final live picks to upsert.");
    return;
  }

  // 5️⃣ Upsert into wallet_live_picks
  try {
    await supabase
      .from("wallet_live_picks")
      .upsert(finalLivePicks, {
        onConflict: ["market_id", "picked_outcome"]
      });

    console.log(`✅ Wallet live picks rebuilt (${finalLivePicks.length} final picks).`);
  } catch (err) {
    console.error("❌ Failed upserting wallet_live_picks:", err.message);
  }
}

/* ===========================
   Signal Processing + Telegram Sending (Fixed)
=========================== */
async function processAndSendSignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*");

  if (error) {
    console.error("❌ Failed fetching wallet_live_picks:", error.message);
    return;
  }

  if (!livePicks?.length) return;

  for (const pick of livePicks) {
    // ✅ Must have wallets
    if (!pick.wallets || pick.wallets.length === 0) continue;

    // ✅ Enforce minimum wallets
    if (pick.vote_count < MIN_WALLETS_FOR_SIGNAL) continue;

    // ✅ Prevent duplicate alerts unless forced
    if (pick.last_confidence_sent && !FORCE_SEND) continue;

    const confidenceEmoji = getConfidenceEmoji(pick.vote_count);

    const text = `⚡️ Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Signal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`;

    try {
      await sendTelegram(text, false);
      await updateNotes("midas-sports", text);

      console.log(
        `✅ Sent signal for market ${pick.market_id} (${pick.picked_outcome})`
      );

      // ✅ Mark as sent (atomic per pick)
      await supabase
        .from("wallet_live_picks")
        .update({
          last_confidence_sent: new Date(),
          signal_sent_at: new Date()
        })
        .eq("market_id", pick.market_id)
        .eq("picked_outcome", pick.picked_outcome);

    } catch (err) {
      console.error(
        `❌ Failed sending signal for market ${pick.market_id}:`,
        err.message
      );
    }
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

    await resolveMarkets(); 

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
