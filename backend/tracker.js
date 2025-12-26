import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253"; // Group chat ID
const TIMEZONE = process.env.TIMEZONE || "America/New_York";

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const LOSING_STREAK_THRESHOLD = parseInt(process.env.LOSING_STREAK_THRESHOLD || "88", 10);
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "2", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const WIN_RATE_THRESHOLD = parseInt(process.env.WIN_RATE_THRESHOLD || "0");

const CONFIDENCE_THRESHOLDS = {
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "5"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "10"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "20"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => {
  console.error("🔥 Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("🔥 Uncaught exception:", err);
});

/* ===========================
   Get Eligible Wallets
=========================== */
async function getEligibleWallets(minWinRate = WIN_RATE_THRESHOLD) {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, win_rate")
    .eq("paused", false)
    .gte("win_rate", WIN_RATE_THRESHOLD);

  if (error || !data?.length) return [];
  return data;
}

/* ===========================
   Markdown helper
=========================== */
function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

/* ===========================
   Telegram helper
=========================== */
async function sendTelegram(text, useBlockquote = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (useBlockquote) text = toBlockquote(text);

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

/* ===========================
   Polymarket API with retries + cache
=========================== */
const marketCache = new Map();

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

async function fetchLatestTrades(user) {
  if (!user) return [];
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Trade fetch error:", err.message);
    return [];
  }
}

async function fetchMarket(eventSlug) {
  if (!eventSlug) return null;
  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);

  const url = `https://gamma-api.polymarket.com/markets/slug/${eventSlug}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });

    if (!res.ok) {
      if (res.status === 404) console.log(`Market ${eventSlug} not found (404)`);
      else console.error(`Market fetch error (${eventSlug}): HTTP ${res.status}`);
      return null;
    }

    const market = await res.json();
    if (market) marketCache.set(eventSlug, market);
    return market;
  } catch (err) {
    console.error(`Market fetch error (${eventSlug}):`, err.message);
    return null;
  }
}

/* ===========================
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Pick helpers
=========================== */
function derivePickedOutcome(trade) {
  if (trade.outcome) return trade.outcome;
  if (typeof trade.outcomeIndex === "number") return `OPTION_${trade.outcomeIndex}`;
  return null;
}

function getPick(sig) {
  if (!sig.picked_outcome || !sig.side) return "Unknown";
  if (sig.side === "BUY") return sig.picked_outcome;
  if (sig.side === "SELL") return sig.resolved_outcome === sig.picked_outcome ? "Unknown" : sig.resolved_outcome || `NOT ${sig.picked_outcome}`;
  return "Unknown";
}

/* ===========================
   Resolve wallet event outcome (amount-weighted)
=========================== */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  if (!walletId || !eventSlug) return null;

  const { data: signals, error } = await supabase
    .from("signals")
    .select("picked_outcome, amount, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (error || !signals?.length) return null;

  // 1️⃣ Sum amount per picked_outcome
  const totals = {};
  for (const sig of signals) {
    if (!sig.picked_outcome) continue;
    const amt = sig.amount || 0;
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + amt;
  }

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  // 2️⃣ Tie or invalid → ignore event
  if (!sorted.length) return null;
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;

  const majorityPick = sorted[0][0];

  // 3️⃣ Find outcome for that majority pick
  const majoritySignal = signals.find(
    s => s.picked_outcome === majorityPick
  );

  if (!majoritySignal) return null;

  return majoritySignal.outcome; // "WIN" or "LOSS"
}

/* ===========================
   Count wallet losing events today
=========================== */
async function countWalletDailyLosses(walletId, timezone = "UTC") {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  // 1️⃣ Get distinct events that resolved today
  const { data: events, error } = await supabase
    .from("signals")
    .select("event_slug")
    .eq("wallet_id", walletId)
    .eq("outcome", "LOSS")
    .gte("outcome_at", startOfDay.toISOString())
    .lte("outcome_at", endOfDay.toISOString());

  if (error || !events?.length) return 0;

  const uniqueEvents = [...new Set(events.map(e => e.event_slug).filter(Boolean))];

  // 2️⃣ Resolve each event properly
  let lossCount = 0;

  for (const eventSlug of uniqueEvents) {
    const result = await resolveWalletEventOutcome(walletId, eventSlug);
    if (result === "LOSS") lossCount++;
  }

  return lossCount;
}

/* ===========================
   Format Signal
=========================== */
function formatSignal(sig, confidence, emoji, eventType = "Signal Sent") {
  const pick = getPick(sig);
  const eventUrl = `https://polymarket.com/events/${sig.event_slug}`;
  const timestamp = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  return `${eventType}: ${timestamp}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${pick}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"}
Result: ${sig.outcome ? emoji : "⚪"}`;
}

/* ===========================
   Update Notes Helper
=========================== */
async function updateNotes(slug, text) {
  const noteText = toBlockquote(text);
  const { data: notes } = await supabase.from("notes").select("content").eq("slug", slug).maybeSingle();
  let newContent = notes?.content || "";
  const safeSignal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;
  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", slug);
}

/* ===========================
   Optimized rebuildWalletLivePicks
=========================== */
async function rebuildWalletLivePicks() {
  console.log("Rebuilding wallet_live_picks incrementally...");

  // 1️⃣ Fetch unresolved signals with wallet info
  const { data: signals, error } = await supabase
    .from("signals")
    .select("*, wallets(id, win_rate)")
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (error || !signals?.length) return console.log("No pending signals to process.");

  // 2️⃣ Aggregate majority pick per wallet per event
  const walletEventMap = new Map();
  for (const sig of signals) {
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    const map = walletEventMap.get(key) || {};
    map[sig.picked_outcome] = (map[sig.picked_outcome] || 0) + (sig.amount || 0);
    walletEventMap.set(key, map);
  }

  const livePicksMap = new Map();

  for (const [key, totals] of walletEventMap.entries()) {
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) continue;

    const majorityOutcome = sorted[0][0];
    const [walletId, eventSlug] = key.split("||");

    const sig = signals.find(s => s.wallet_id == walletId && s.event_slug === eventSlug && s.picked_outcome === majorityOutcome);
    if (!sig) continue;

    const liveKey = `${sig.market_id}||${majorityOutcome}`;
    const existing = livePicksMap.get(liveKey) || { wallets: [], vote_count: 0 };
    existing.wallets.push(sig.wallet_id);
    existing.vote_count++;
    existing.market_id = sig.market_id;
    existing.market_name = sig.market_name;
    existing.event_slug = sig.event_slug;
    livePicksMap.set(liveKey, existing);
  }

  // 3️⃣ Upsert into wallet_live_picks
  const finalLivePicks = Array.from(livePicksMap.values()).map(p => ({
    ...p,
    fetched_at: new Date(),
  }));

  if (finalLivePicks.length) {
    // Use upsert to avoid full table delete
    await supabase
      .from("wallet_live_picks")
      .upsert(finalLivePicks, { onConflict: ["market_id", "picked_outcome"] });
  }

  console.log(`✅ Rebuilt wallet_live_picks (${finalLivePicks.length} rows)`);
}

/* ===========================
   Determine outcome
=========================== */
function determineOutcome(pos) {
  if (typeof pos.cashPnl === "number") {
    return {
      outcome: pos.cashPnl > 0 ? "WIN" : "LOSS",
      resolvedOutcome: pos.outcome || `OPTION_${pos.outcomeIndex}`
    };
  }

  return { outcome: "Pending", resolvedOutcome: null };
}

/* ===========================
   Fetch wallet positions safely
=========================== */
async function fetchWalletPositions(userId) {
  if (!userId) return [];

  const allPositions = [];
  let limit = 100;
  let offset = 0;

  while (true) {
    const url = `https://data-api.polymarket.com/positions?user=${userId}&limit=${limit}&offset=${offset}&sizeThreshold=1&sortBy=CURRENT&sortDirection=DESC`;

    try {
      const data = await fetchWithRetry(
        url,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
      );

      if (!Array.isArray(data) || data.length === 0) break;

      allPositions.push(...data);

      if (data.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error(`Failed to fetch positions for wallet ${userId} at offset ${offset}:`, err.message);
      break;
    }
  }

  console.log(`Fetched ${allPositions.length} total positions for wallet ${userId}`);
  return allPositions;
}

/* ===========================
   Optimized trackWallet (Gamma API)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`Wallet ${wallet.id} has no polymarket_proxy_wallet, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
  }

  // 1️⃣ Fetch positions & trades concurrently
  const [positions, trades] = await Promise.all([
    fetchWalletPositions(proxyWallet),
    fetchLatestTrades(proxyWallet),
  ]);

  const positionMap = new Map(positions.map(p => [p.asset, p]));
  const liveConditionIds = new Set(positions.filter(p => p.cashPnl === null).map(p => p.conditionId));

  const { data: existingSignals = [] } = await supabase
    .from("signals")
    .select("*")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const allNewSignals = [];

  // 2️⃣ Process positions
  for (const pos of positions) {
    const txHash = pos.asset;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;

    // Fetch market via Gamma API
    const market = await fetchMarket(pos.eventSlug || pos.slug);
    if (!market) continue;

    if (!market.active && !market.closed) continue; // skip markets not open/resolved

    const resolvedOutcome = market.closed ? pickedOutcome : null;
    const outcome = market.closed ? pickedOutcome : "Pending";

    const existingSig = existingSignals.find(s => s.tx_hash === txHash);

    if (existingSig) {
      await supabase
        .from("signals")
        .update({
          pnl: pos.cashPnl ?? null,
          outcome,
          resolved_outcome: resolvedOutcome,
          outcome_at: pos.cashPnl !== null ? new Date() : null,
        })
        .eq("id", existingSig.id);
    } else if (!existingTxs.has(txHash)) {
      allNewSignals.push({
        wallet_id: wallet.id,
        signal: pos.title,
        market_name: pos.title,
        market_id: pos.conditionId,
        event_slug: pos.eventSlug || pos.slug,
        side: pos.side?.toUpperCase() || "BUY",
        picked_outcome: pickedOutcome,
        tx_hash: txHash,
        pnl: pos.cashPnl ?? null,
        outcome,
        resolved_outcome: resolvedOutcome,
        outcome_at: pos.cashPnl !== null ? new Date() : null,
        win_rate: wallet.win_rate,
        amount: pos.amount || 0,
        created_at: new Date(pos.timestamp * 1000 || Date.now()),
      });
    }
  }

  // 3️⃣ Process unresolved trades
  for (const trade of trades) {
    const txHash = trade.asset;
    if (!liveConditionIds.has(trade.conditionId)) continue;
    if (existingTxs.has(txHash)) continue;

    const pos = positionMap.get(txHash);
    if (pos && typeof pos.cashPnl === "number") continue;

    const market = await fetchMarket(trade.eventSlug || trade.slug);
    if (!market || !market.active) continue; // only active markets

    allNewSignals.push({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      event_slug: trade.eventSlug || trade.slug,
      side: trade.side?.toUpperCase() || "BUY",
      picked_outcome: trade.outcome || `OPTION_${trade.outcomeIndex}`,
      tx_hash: txHash,
      pnl: null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      amount: trade.amount || 0,
      created_at: new Date(trade.timestamp * 1000 || Date.now()),
    });
  }

  if (allNewSignals.length) {
    await supabase.from("signals").insert(allNewSignals);
    console.log(`Inserted ${allNewSignals.length} new signals for wallet ${wallet.id}`);
  }
}

/* ===========================
   Update Wallet Metrics
=========================== */
async function updateWalletMetricsJS() {
  console.log("🔄 Updating wallet metrics...");

  const { data: wallets, error: walletsErr } = await supabase
    .from("wallets")
    .select("id, paused");

  if (walletsErr || !wallets?.length) {
    console.error("Failed to fetch wallets:", walletsErr?.message);
    return;
  }

  for (const wallet of wallets) {
    try {
      // 1️⃣ Recalculate WIN / LOSS counts (event-level)
      const { data: resolvedSignals, error: sigErr } = await supabase
        .from("signals")
        .select("event_slug, outcome")
        .eq("wallet_id", wallet.id)
        .in("outcome", ["WIN", "LOSS"]);

      if (sigErr) {
        console.error(`Signals fetch failed for wallet ${wallet.id}`, sigErr.message);
        continue;
      }

      const uniqueEvents = [
        ...new Set(resolvedSignals.map(s => s.event_slug).filter(Boolean)),
      ];

      let wins = 0;
      let losses = 0;

      for (const eventSlug of uniqueEvents) {
        const result = await resolveWalletEventOutcome(wallet.id, eventSlug);
        if (result === "WIN") wins++;
        if (result === "LOSS") losses++;
      }

      const total = wins + losses;
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

      // 2️⃣ DAILY LOSS PAUSE LOGIC (ONLY RULE)
      const dailyLosses = await countWalletDailyLosses(wallet.id);
      const shouldPause = dailyLosses >= 3;

      // 3️⃣ Update wallet
await supabase
  .from("wallets")
  .update({
    win_rate: winRate,
    paused: shouldPause ? true : wallet.paused,
    last_checked: new Date(),
  })
  .eq("id", wallet.id);


      if (shouldPause) {
        console.log(
          `⏸ Wallet ${wallet.id} paused (lost ${dailyLosses} events today)`
        );
      }

    } catch (err) {
      console.error(`Wallet ${wallet.id} update failed:`, err.message);
    }
  }

  console.log("✅ Wallet metrics update complete");
}

/* ===========================
   Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","SPORTS"];
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalFetched = 0, totalInserted = 0, totalSkipped = 0;

  for (const category of categories) {
    for (const period of timePeriods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        totalFetched += data.length;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl < 1000000 || entry.vol >= 2 * entry.pnl) {
            totalSkipped++;
            continue;
          }

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();

          if (existing) { totalSkipped++; continue; }

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

          totalInserted++;

          try {
            await trackWallet({ ...insertedWallet, force_fetch: true });
          } catch (err) {
            console.error(`Failed to fetch historical trades for wallet ${proxyWallet}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Failed to fetch leaderboard (${category}/${period}):`, err.message);
      }
    }
  }

  console.log(`Leaderboard fetch complete. Total fetched: ${totalFetched}, Total inserted: ${totalInserted}, Total skipped: ${totalSkipped}`);
}

/* ===========================
   Process & Send Signals (New + Resolved)
=========================== */
async function processAndSendSignals(batchSize = 5, batchDelay = 1000) {
  console.log("📡 Processing new majority signals and resolved results...");

  // 1️⃣ Fetch all live picks
  const { data: livePicks, error: livePicksErr } = await supabase
    .from("wallet_live_picks")
    .select("*");

  if (livePicksErr) return console.error("Failed to fetch live picks:", livePicksErr.message);

  // 2️⃣ Group by market_id + picked_outcome
  const grouped = new Map();
  for (const pick of livePicks || []) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pick);
  }

  const signalsToSend = [];

  // 3️⃣ Prepare new majority signals
  for (const [key, picks] of grouped.entries()) {
    const walletCount = picks.length;

    // Determine confidence emoji
    let confidence = "";
    for (const [emoji, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a)) {
      if (walletCount >= threshold) {
        confidence = emoji;
        break;
      }
    }
    if (!confidence) continue; // skip if below min threshold

    const sig = picks[0]; // representative pick

    signalsToSend.push({
      market_id: sig.market_id,
      picked_outcome: sig.picked_outcome,
      wallets: picks.map(p => p.wallet_id),
      confidence,
      text: `📊 Market Event: ${sig.market_name}
Prediction: ${sig.picked_outcome}
Confidence: ${confidence}
Signal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`,
    });

    // Update signals table with signal_sent_at
    await supabase
      .from("signals")
      .update({ signal_sent_at: new Date() })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }

  // 4️⃣ Send new majority signals in batches
  for (let i = 0; i < signalsToSend.length; i += batchSize) {
    const batch = signalsToSend.slice(i, i + batchSize);
    await Promise.all(batch.map(async sig => {
      try {
        await sendTelegram(sig.text);
        await updateNotes("polymarket-millionaires", sig.text);
        console.log(`✅ Sent new signal for market ${sig.market_id} (${sig.picked_outcome})`);
      } catch (err) {
        console.error(`Failed to send signal for market ${sig.market_id}:`, err.message);
      }
    }));
    if (i + batchSize < signalsToSend.length) await new Promise(res => setTimeout(res, batchDelay));
  }

  // 5️⃣ Reprocess resolved picks (only for signals that were sent)
  const { data: sentSignals } = await supabase
    .from("signals")
    .select("*")
    .not("signal_sent_at", "is", null)
    .in("outcome", ["WIN", "LOSS", "Pending"]); // include newly resolved

  for (const sig of sentSignals || []) {
    // Only send result notes if signal_sent_at exists
    await sendResultNotes(sig, sig.outcome);
  }

  console.log(`✅ Signals processed: ${signalsToSend.length} new + ${sentSignals?.length || 0} resolved`);
}

/* ===========================
   Optimized Tracker Loop
=========================== */
let isTrackerRunning = false;

async function trackerLoop() {
  if (isTrackerRunning) {
    console.log("⏳ Tracker loop already running, skipping this cycle...");
    return;
  }
  isTrackerRunning = true;

  try {
    // 1️⃣ Fetch all wallets
    const { data: wallets, error: walletsErr } = await supabase.from("wallets").select("*");
    if (walletsErr) return console.error("Failed to fetch wallets:", walletsErr.message);
    if (!wallets?.length) return console.log("No wallets found");

    console.log(`[${new Date().toISOString()}] Tracking ${wallets.length} wallets concurrently...`);

    // 2️⃣ Track wallets concurrently
    const walletPromises = wallets.map(wallet =>
      trackWallet(wallet).catch(err =>
        console.error(`Error tracking wallet ${wallet.id}:`, err.message)
      )
    );
    await Promise.allSettled(walletPromises);

    // 3️⃣ Rebuild live picks
    await rebuildWalletLivePicks();

    // 4️⃣ Process & send new majority signals + resolved results
    await processAndSendSignals();

    // 5️⃣ Update wallet metrics (win_rate, paused, daily losses)
    await updateWalletMetricsJS();

    console.log("✅ Tracker loop completed successfully");
  } catch (err) {
    console.error("Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Function
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try {
    // 1️⃣ Fetch leaderboard wallets on startup
    await fetchAndInsertLeaderboardWallets();
  } catch (err) {
    console.error("Failed to fetch leaderboard wallets:", err.message);
  }

  // 2️⃣ Run tracker loop immediately once
  await trackerLoop();

  // 3️⃣ Schedule periodic tracker execution
  setInterval(trackerLoop, POLL_INTERVAL);

  // 4️⃣ Daily cron job (7am)
  cron.schedule("0 7 * * *", async () => {
    console.log("Running daily summary + leaderboard + new wallets fetch...");
    try {
      await fetchAndInsertLeaderboardWallets();
      await trackerLoop();
      // Optional: sendDailySummary();
    } catch (err) {
      console.error("Daily cron job failed:", err.message);
    }
  }, { timezone: TIMEZONE });

  // 5️⃣ Heartbeat log
  setInterval(() => {
    console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`);
  }, 60_000);

  // 6️⃣ Keep Render happy
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket tracker running\n");
  }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
}

// Run main on startup
main();

/* ===========================
   Cron daily at 7am
=========================== */
cron.schedule("0 7 * * *", () => {
  console.log("Running daily summary + leaderboard + new wallets fetch...");
// sendDailySummary();
}, { timezone: TIMEZONE });

/* ===========================
   Heartbeat
=========================== */
setInterval(() => {
  console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`);
}, 60_000);

/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));

// Run main on startup
main();
