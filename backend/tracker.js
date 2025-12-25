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
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

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
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

/* ===========================
   Polymarket API helpers with retries + cache
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

  const url = `https://data-api.polymarket.com/events/${eventSlug}`;
  try {
    const market = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (market) marketCache.set(eventSlug, market);
    return market;
  } catch (err) {
    if (err.message.includes("404")) console.log(`Market ${eventSlug} not found (404)`);
    else console.error(`Market fetch error (${eventSlug}):`, err.message);
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
   Vote counting helpers
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase.from("signals").select("wallet_id, side").eq("market_id", marketId);
  if (!signals?.length) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue; // tie per wallet
    counts[sides[0][0]] = (counts[sides[0][0]] || 0) + 1;
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "";
  return getConfidenceEmoji(Math.max(...Object.values(counts)));
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
   Unpause Wallet
=========================== */
async function unpauseAndFetchWallet(wallet) {
  const { data: updated, error } = await supabase
    .from("wallets")
    .select("*")
    .eq("id", wallet.id)
    .maybeSingle();

  if (error || !updated) return;

  if (updated.win_rate >= 80 && updated.paused) {
    const { error: updateErr } = await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);

    if (updateErr) {
      console.error(`Failed to unpause wallet ${wallet.id}:`, updateErr.message);
      return;
    }

    console.log(`Wallet ${wallet.id} unpaused (win_rate=${updated.win_rate.toFixed(2)}%)`);
    await trackWallet({ ...updated, paused: false, force_fetch: true });
  }
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

  console.log(`Fetched ${allPositions.length} total positions for wallet ${userId}`);
  return allPositions;
}

/* ===========================
   Track Wallet Trades (safe & complete)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`Wallet ${wallet.id} has no polymarket_proxy_wallet, skipping`);
    return;
  }

  // 0️⃣ Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
    wallet.paused = false;
    console.log(`Wallet ${wallet.id} auto-unpaused (winRate=${wallet.win_rate.toFixed(2)}%)`);
  }

  // Skip if still paused unless force_fetch
  if (wallet.paused && !wallet.force_fetch) return;

  // 1️⃣ Fetch positions
  let positions = [];
  try {
    positions = await fetchWalletPositions(proxyWallet);
    console.log(`Fetched ${positions.length} positions for wallet ${proxyWallet}`);
  } catch (err) {
    console.error(`Failed to fetch positions for wallet ${proxyWallet}:`, err.message);
  }

  // 2️⃣ Fetch trades
  let trades = [];
  try {
    const tradesUrl = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${proxyWallet}`;
    trades = await fetchWithRetry(tradesUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    trades = Array.isArray(trades) ? trades : [];
    console.log(`Fetched ${trades.length} trades for wallet ${proxyWallet}`);
  } catch (err) {
    console.error(`Failed to fetch trades for wallet ${proxyWallet}:`, err.message);
  }

  // 3️⃣ Fetch existing signals
  const { data: existingSignals } = await supabase.from("signals").select("id, tx_hash, market_id, outcome").eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignals?.map(s => s.tx_hash));

  // 4️⃣ Process positions (resolved + unresolved)
  for (const pos of positions) {
    const marketId = pos.conditionId;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    const pnl = pos.cashPnl ?? null;

    let outcome = "Pending";
    let resolvedOutcome = null;
    if (pnl !== null) {
      if (pnl > 0) {
        outcome = "WIN";
        resolvedOutcome = pickedOutcome;
      } else {
        outcome = "LOSS";
        resolvedOutcome = pos.oppositeOutcome || pickedOutcome;
      }
    }

    const existingSig = existingSignals.find(s => s.market_id === marketId);
    if (existingSig) {
      await supabase.from("signals").update({ pnl, outcome, resolved_outcome: resolvedOutcome, outcome_at: pnl !== null ? new Date() : null }).eq("id", existingSig.id);
    } else if (!existingTxs.has(pos.asset)) {
      await supabase.from("signals").insert({
        wallet_id: wallet.id,
        signal: pos.title,
        market_name: pos.title,
        market_id: marketId,
        event_slug: pos.eventSlug || pos.slug,
        side: pos.side?.toUpperCase() || "BUY",
        win_rate: wallet.win_rate,
        picked_outcome: pickedOutcome,
        tx_hash: pos.asset,
        pnl,
        outcome,
        resolved_outcome: resolvedOutcome,
        outcome_at: pnl !== null ? new Date() : null,
        created_at: new Date(pos.timestamp * 1000 || Date.now()),
      });
    }
  }

  // 5️⃣ Process unresolved trades
  const liveConditionIds = new Set(positions.filter(p => p.cashPnl === null).map(p => p.conditionId));
  const unresolvedTrades = trades.filter(t => {
    if (!liveConditionIds.has(t.conditionId)) return false;
    if (existingTxs.has(t.asset)) return false;
    const pos = positions.find(p => p.asset === t.asset);
    if (pos && typeof pos.cashPnl === "number") return false;
    return true;
  });

  const tradeRows = unresolvedTrades.map(trade => ({
    wallet_id: wallet.id,
    signal: trade.title,
    market_name: trade.title,
    market_id: trade.conditionId,
    event_slug: trade.eventSlug || trade.slug,
    side: trade.side?.toUpperCase() || "BUY",
    picked_outcome: trade.outcome || `OPTION_${trade.outcomeIndex}`,
    tx_hash: trade.asset,
    pnl: null,
    outcome: "Pending",
    resolved_outcome: null,
    outcome_at: null,
    created_at: new Date(trade.timestamp * 1000 || Date.now()),
  }));

  if (tradeRows.length) {
    await supabase.from("signals").insert(tradeRows);
    console.log(`Inserted ${tradeRows.length} unresolved trades for wallet ${wallet.id}`);
  }

  // 6️⃣ Compute wallet metrics from resolved signals
  const { data: resolvedSignals } = await supabase.from("signals").select("outcome, created_at").eq("wallet_id", wallet.id).in("outcome", ["WIN", "LOSS"]).order("created_at", { ascending: true });

  let losingStreak = 0;
  if (resolvedSignals?.length) {
    for (let i = resolvedSignals.length - 1; i >= 0; i--) {
      if (resolvedSignals[i].outcome === "LOSS") losingStreak++;
      else break;
    }
  }

  const totalResolved = resolvedSignals?.length || 0;
  const wins = resolvedSignals?.filter(s => s.outcome === "WIN").length || 0;
  const winRate = totalResolved > 0 ? (wins / totalResolved) * 100 : 0;

  const { count: livePicksCount } = await supabase.from("signals").select("*", { count: "exact", head: true }).eq("wallet_id", wallet.id).eq("outcome", "Pending");

  let pausedStatus;
  if (wallet.force_fetch) pausedStatus = wallet.paused;
  else pausedStatus = losingStreak >= LOSING_STREAK_THRESHOLD || winRate < 80;

  await supabase.from("wallets").update({ losing_streak: losingStreak, win_rate: winRate, live_picks: livePicksCount, paused: pausedStatus, last_checked: new Date() }).eq("id", wallet.id);

  if (wallet.force_fetch) await supabase.from("wallets").update({ force_fetch: false }).eq("id", wallet.id);

  console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicksCount}, paused: ${pausedStatus}`);
}
/* ===========================
   Update Wallet Metrics JS
=========================== */
async function updateWalletMetricsJS() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  for (const wallet of wallets) {
    await trackWallet(wallet);
  }
}

/* ===========================
   Send Result Notes
=========================== */
async function sendResultNotes() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "WIN")
    .or("outcome.eq.LOSS")
    .order("outcome_at", { ascending: false })
    .limit(10);

  if (!signals?.length) return;

  for (const sig of signals) {
    const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
    const confidence = getConfidenceEmoji(1); // Default, can customize
    const msg = formatSignal(sig, confidence, emoji, "Result Update");
    await updateNotes(sig.event_slug, msg);
  }
}

/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id").group("market_id");
  if (!markets?.length) return;

  for (const m of markets) {
    const counts = await getMarketVoteCounts(m.market_id);
    if (!counts) continue;

    const majoritySide = getMajoritySide(counts);
    if (!majoritySide) continue;

    const confidence = getMajorityConfidence(counts);
    const emoji = RESULT_EMOJIS.Pending;
    const { data: sig } = await supabase
      .from("signals")
      .select("*")
      .eq("market_id", m.market_id)
      .eq("side", majoritySide)
      .limit(1)
      .maybeSingle();

    if (!sig) continue;
    const msg = formatSignal(sig, confidence, emoji, "Majority Signal");
    await updateNotes(sig.event_slug, msg);

    if (FORCE_SEND || Object.values(counts).reduce((a, b) => a + b, 0) >= MIN_WALLETS_FOR_SIGNAL) {
      await sendTelegram(msg, true);
    }
  }
}

/* ===========================
   Fetch & Insert Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  for (const wallet of wallets) {
    await trackWallet(wallet);
  }
}

/* ===========================
   Rebuild Wallet Live Picks
=========================== */
async function rebuildWalletLivePicks() {
  const { data: wallets } = await supabase.from("wallets").select("*").gte("win_rate", 80);
  if (!wallets?.length) return;

  const livePicks = [];

  for (const wallet of wallets) {
    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .eq("wallet_id", wallet.id)
      .eq("outcome", "Pending");

    if (!signals?.length) continue;

    const seenMarkets = new Set();
    for (const s of signals) {
      if (seenMarkets.has(s.market_id)) continue;
      seenMarkets.add(s.market_id);

      livePicks.push({
        wallet_id: wallet.id,
        picked_outcome: s.picked_outcome,
        market_id: s.market_id,
        created_at: new Date(),
      });
    }
  }

  if (livePicks.length) {
    await supabase.from("wallet_live_picks").delete().neq("wallet_id", -1);
    await supabase.from("wallet_live_picks").insert(livePicks);
    console.log(`Rebuilt wallet_live_picks: ${livePicks.length} rows`);
  }
}

/* ===========================
   Tracker Loop
=========================== */
async function trackerLoop() {
  try {
    console.log("=== Tracker loop started ===");
    await fetchAndInsertLeaderboardWallets();
    await rebuildWalletLivePicks();
    await sendMajoritySignals();
    await sendResultNotes();
    console.log("=== Tracker loop completed ===");
  } catch (err) {
    console.error("Tracker loop error:", err.message);
  } finally {
    setTimeout(trackerLoop, POLL_INTERVAL);
  }
}

/* ===========================
   Render HTTP Server (Always On)
=========================== */
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket Tracker is running ✅");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(process.env.PORT || 10000, () => {
  console.log(`Tracker HTTP server listening on port ${process.env.PORT || 10000}`);
});

/* ===========================
   Main
=========================== */
(async function main() {
  console.log("Polymarket Tracker starting... 🚀");

  // Start the first loop immediately
  trackerLoop();

  // Cron for daily rebuild (optional)
  cron.schedule("0 0 * * *", async () => {
    console.log("Daily rebuild of live picks starting...");
    await rebuildWalletLivePicks();
  }, { timezone: TIMEZONE });
})();
