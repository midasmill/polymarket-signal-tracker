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
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "5"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "10"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "20"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

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
   Wallet Helpers
=========================== */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  const { data: signals } = await supabase
    .from("signals")
    .select("picked_outcome, amount, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;
  const totals = {};
  for (const sig of signals) {
    if (!sig.picked_outcome) continue;
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + (sig.amount || 0);
  }

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) return null;

  const majorityPick = sorted[0][0];
  const majoritySignal = signals.find(s => s.picked_outcome === majorityPick);
  return majoritySignal?.outcome || null;
}

async function countWalletDailyLosses(walletId) {
  const start = new Date(); start.setHours(0,0,0,0);
  const end = new Date(); end.setHours(23,59,59,999);
  const { data: events } = await supabase
    .from("signals")
    .select("event_slug")
    .eq("wallet_id", walletId)
    .eq("outcome", "LOSS")
    .gte("outcome_at", start.toISOString())
    .lte("outcome_at", end.toISOString());

  if (!events?.length) return 0;
  let lossCount = 0;
  for (const eventSlug of [...new Set(events.map(e => e.event_slug).filter(Boolean))]) {
    if (await resolveWalletEventOutcome(walletId, eventSlug) === "LOSS") lossCount++;
  }
  return lossCount;
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
      const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });

      if (!Array.isArray(data) || data.length === 0) break;
      allPositions.push(...data);

      if (data.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error(`Failed to fetch positions for wallet ${userId} at offset ${offset}:`, err.message);
      break;
    }
  }

  return allPositions;
}

/* ===========================
   Fetch latest trades
=========================== */
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

/* ===========================
   Track Wallet (Gamma API)
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

  // 2️⃣ Process positions (only unresolved markets)
  for (const pos of positions) {
    const txHash = pos.asset;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;

    const market = await fetchMarket(pos.eventSlug || pos.slug);
    if (!market || market.closed) continue; // only unresolved markets

    const existingSig = existingSignals.find(s => s.tx_hash === txHash);
    if (existingSig) continue; // already tracked

    const eventStartAt = market?.eventStartAt ? new Date(market.eventStartAt) : null;

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
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      amount: pos.amount || 0,
      created_at: new Date(pos.timestamp * 1000 || Date.now()),
      event_start_at: eventStartAt,
    });
  }

  // 3️⃣ Process unresolved trades (filter duplicates)
  for (const trade of trades) {
    const txHash = trade.asset;
    if (!liveConditionIds.has(trade.conditionId)) continue;
    if (existingTxs.has(txHash)) continue;

    const pos = positionMap.get(txHash);
    if (!pos || typeof pos.cashPnl === "number") continue;

    const pickedOutcome = trade.outcome || `OPTION_${trade.outcomeIndex}`;
    const market = await fetchMarket(pos?.eventSlug || pos?.slug);
    if (!market || market.closed) continue;

    const eventStartAt = market?.eventStartAt ? new Date(market.eventStartAt) : null;

    allNewSignals.push({
      wallet_id: wallet.id,
      signal: pos?.title || trade.title,
      market_name: pos?.title || trade.title,
      market_id: trade.conditionId,
      event_slug: trade.eventSlug || trade.slug,
      side: trade.side?.toUpperCase() || "BUY",
      picked_outcome: pickedOutcome,
      tx_hash: txHash,
      pnl: pos?.cashPnl ?? null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      amount: pos?.amount || trade.amount || 0,
      created_at: new Date((pos?.timestamp || trade.timestamp) * 1000 || Date.now()),
      event_start_at: eventStartAt,
    });
  }

  if (allNewSignals.length) {
    await supabase.from("signals").insert(allNewSignals);
    console.log(`Inserted ${allNewSignals.length} new signals for wallet ${wallet.id}`);
  }
}
/* ===========================
   Format Signal Helper
=========================== */
function getPick(sig) {
  if (!sig.picked_outcome || !sig.side) return "Unknown";
  if (sig.side === "BUY") return sig.picked_outcome;
  if (sig.side === "SELL") return sig.resolved_outcome === sig.picked_outcome ? "Unknown" : sig.resolved_outcome || `NOT ${sig.picked_outcome}`;
  return "Unknown";
}

/* ===========================
   Process & Send Signals
=========================== */
async function processAndSendSignals(batchSize = 5, batchDelay = 1000) {
  const { data: livePicks } = await supabase.from("wallet_live_picks").select("*");
  if (!livePicks?.length) return;

  const grouped = new Map();
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pick);
  }

  const signalsToSend = [];
  for (const [key, picks] of grouped.entries()) {
    const walletCount = picks.length;
    const confidence = getConfidenceEmoji(walletCount);
    if (!confidence) continue;

    const sig = picks[0];
    signalsToSend.push({
      market_id: sig.market_id,
      picked_outcome: sig.picked_outcome,
      wallets: picks.map(p => p.wallet_id),
      confidence,
      text: `📊 Market Event: ${sig.market_name}\nPrediction: ${sig.picked_outcome}\nConfidence: ${confidence}\nSignal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`,
    });

    await supabase.from("signals")
      .update({ signal_sent_at: new Date() })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }

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
    if (i + batchSize < signalsToSend.length) await new Promise(r => setTimeout(r, batchDelay));
  }
}

/* ===========================
   Update Wallet Metrics
=========================== */
async function updateWalletMetricsJS() {
  const { data: wallets } = await supabase.from("wallets").select("id, paused");
  if (!wallets?.length) return;

  for (const wallet of wallets) {
    try {
      const { data: resolvedSignals } = await supabase
        .from("signals")
        .select("event_slug, outcome")
        .eq("wallet_id", wallet.id)
        .in("outcome", ["WIN", "LOSS"]);

      const uniqueEvents = [...new Set(resolvedSignals.map(s => s.event_slug).filter(Boolean))];

      let wins = 0, losses = 0;
      for (const eventSlug of uniqueEvents) {
        const result = await resolveWalletEventOutcome(wallet.id, eventSlug);
        if (result === "WIN") wins++;
        if (result === "LOSS") losses++;
      }

      const total = wins + losses;
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
      const dailyLosses = await countWalletDailyLosses(wallet.id);
      const shouldPause = dailyLosses >= 3;

      await supabase.from("wallets")
        .update({ win_rate: winRate, paused: shouldPause ? true : wallet.paused, last_checked: new Date() })
        .eq("id", wallet.id);

      if (shouldPause) console.log(`⏸ Wallet ${wallet.id} paused (lost ${dailyLosses} events today)`);

    } catch (err) {
      console.error(`Wallet ${wallet.id} update failed:`, err.message);
    }
  }
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return;

    await Promise.allSettled(wallets.map(trackWallet));
    await rebuildWalletLivePicks();
    await processAndSendSignals();
    await updateWalletMetricsJS();

    console.log(`✅ Tracker loop completed successfully`);
  } catch (err) {
    console.error("Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  await fetchAndInsertLeaderboardWallets().catch(err => console.error(err));
  await trackerLoop();

  setInterval(trackerLoop, POLL_INTERVAL);

  cron.schedule("0 7 * * *", async () => {
    console.log("📅 Daily cron running...");
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();
  }, { timezone: TIMEZONE });

  setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket tracker running\n");
  }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
}

main();
