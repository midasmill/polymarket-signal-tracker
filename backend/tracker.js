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
const LOSING_STREAK_THRESHOLD = parseInt(process.env.LOSING_STREAK_THRESHOLD || "3", 10);
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

process.on("unhandledRejection", err => {
  console.error("🔥 Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("🔥 Uncaught exception:", err);
});


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
   Vote counting
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

    // Fetch unresolved picks ignoring paused status
    await trackWallet({ ...updated, paused: false, forceFetch: true });
  }
}


/* ===========================
   Fetch wallet positions safely
========================== */
async function fetchWalletPositions(userId) {
  if (!userId) return [];
  const url = `https://data-api.polymarket.com/positions?user=${userId}&limit=100&sizeThreshold=1&sortBy=CURRENT&sortDirection=DESC`;
  try {
    const data = await fetchWithRetry(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      3, // retries
      2000 // 2s delay
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`Failed to fetch positions for wallet ${userId}:`, err.message);
    return [];
  }
}

/* ===========================
   Track Wallet Trades (with trades API for unresolved)
========================== */
async function trackWallet(wallet) {
const userId = wallet.polymarket_proxy_wallet;
if (!userId) {
  console.warn(`Wallet ${wallet.id} has no polymarket_proxy_wallet, skipping`);
  return;
}

  // 0️⃣ Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
    wallet.paused = false;
    console.log(`Wallet ${wallet.id} auto-unpaused (winRate=${wallet.win_rate.toFixed(2)}%)`);
  }

  // Skip fetching if still paused
  if (wallet.paused) return;

  // 1️⃣ Fetch wallet positions (optional, for resolved info)
  const positions = await fetchWalletPositions(userId);
  console.log(`Fetched ${positions.length} positions for wallet ${userId}`);

  // 2️⃣ Fetch trades from trades API (unresolved picks)
  const tradesUrl = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${userId}`;
  let trades = [];
  try {
    trades = await fetchWithRetry(tradesUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    trades = Array.isArray(trades) ? trades : [];
    console.log(`Fetched ${trades.length} trades for wallet ${userId}`);
  } catch (err) {
    console.error(`Failed to fetch trades for wallet ${userId}:`, err.message);
  }

  // 3️⃣ Fetch existing signals
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("id, tx_hash, market_id, outcome")
    .eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignals?.map(s => s.tx_hash));

  // 4️⃣ Process positions for resolved signals
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
      await supabase
        .from("signals")
        .update({ pnl, outcome, resolved_outcome: resolvedOutcome, outcome_at: pnl !== null ? new Date() : null })
        .eq("id", existingSig.id);
    } else if (!existingTxs.has(pos.asset)) {
      await supabase.from("signals").insert({
        wallet_id: wallet.id,
        signal: pos.title,
        market_name: pos.title,
        market_id: marketId,
        event_slug: pos.eventSlug || pos.slug,
        side: pos.side?.toUpperCase() || "BUY",
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

// 5️⃣ Process unresolved trades from trades API safely

// Build a set of live conditionIds from unresolved positions
const liveConditionIds = new Set(
  positions
    .filter(p => p.cashPnl === null)
    .map(p => p.conditionId)
);

// Only insert trades that are truly unresolved
const unresolvedTrades = trades.filter(t => {
  // Must still exist as a live position
  if (!liveConditionIds.has(t.conditionId)) return false;

  // Skip if already inserted
  if (existingTxs.has(t.asset)) return false;

  // Extra safety: if position exists but is resolved, skip
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
  console.log(`Inserted ${tradeRows.length} truly unresolved trades for wallet ${wallet.id}`);
}

  // 6️⃣ Compute wallet metrics from resolved signals
  const { data: resolvedSignals } = await supabase
    .from("signals")
    .select("outcome, created_at")
    .eq("wallet_id", wallet.id)
    .in("outcome", ["WIN", "LOSS"])
    .order("created_at", { ascending: true });

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

  // 8️⃣ Determine pause status
  const paused = losingStreak >= LOSING_STREAK_THRESHOLD || winRate < 80;

  // 9️⃣ Update wallet metrics
  const { error } = await supabase
    .from("wallets")
    .update({
      losing_streak: losingStreak,
      win_rate: winRate,
      live_picks: livePicksCount,
      paused,
      last_checked: new Date(),
    })
    .eq("id", wallet.id);

  if (error) console.error(`Wallet ${wallet.id} update failed:`, error);
  else console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicksCount}, paused: ${paused}`);
}

/* ===========================
   Rebuild live picks from unresolved signals
========================== */
async function rebuildWalletLivePicks() {
  console.log("🔄 Rebuilding wallet_live_picks from signals...");

  // Clear table
  await supabase.from("wallet_live_picks").delete().neq("wallet_id", 0);

  // Fetch all pending signals
  const { data: pendingSignals, error } = await supabase
    .from("signals")
    .select(`
      wallet_id,
      market_id,
      market_name,
      picked_outcome,
      side
    `)
    .eq("outcome", "Pending");

  if (error) {
    console.error("Failed to fetch pending signals:", error);
    return;
  }

  if (!pendingSignals.length) {
    console.log("No pending signals found.");
    return;
  }

  const rows = pendingSignals.map(s => ({
    wallet_id: s.wallet_id,
    market_id: s.market_id,
    market_name: s.market_name,
    picked_outcome: s.picked_outcome,
    side: s.side,
    pnl: null,
    outcome: "Pending",
    resolved_outcome: null,
    fetched_at: new Date()
  }));

  await supabase.from("wallet_live_picks").insert(rows);

  console.log(`✅ Inserted ${rows.length} live picks`);
}

/* ===========================
   Update Wallet Metrics
========================== */
async function updateWalletMetricsJS() {
  try {
    // 1️⃣ Fetch all wallets
    const { data: wallets, error: walletsErr } = await supabase.from("wallets").select("id");
    if (walletsErr) {
      console.error("Failed to fetch wallets:", walletsErr);
      return;
    }
    if (!wallets?.length) return console.log("No wallets found");

    for (const wallet of wallets) {
      // 2️⃣ Fetch resolved signals (WIN/LOSS) for this wallet
      const { data: resolvedSignals, error: signalsErr } = await supabase
        .from("signals")
        .select("outcome, created_at")
        .eq("wallet_id", wallet.id)
        .in("outcome", ["WIN", "LOSS"])
        .order("created_at", { ascending: true });

      if (signalsErr) {
        console.error(`Failed to fetch resolved signals for wallet ${wallet.id}:`, signalsErr);
        continue;
      }

      // Win rate
      const totalResolved = resolvedSignals?.length || 0;
      const wins = resolvedSignals?.filter(s => s.outcome === "WIN").length || 0;
      const winRate = totalResolved > 0 ? (wins / totalResolved) * 100 : 0;

      // Consecutive losing streak from most recent resolved signal
      let losingStreak = 0;
      if (resolvedSignals?.length) {
        for (let i = resolvedSignals.length - 1; i >= 0; i--) {
          if (resolvedSignals[i].outcome === "LOSS") losingStreak++;
          else break; // streak ends at first WIN
        }
      }

      // Live/unresolved picks
const { data: liveSignals } = await supabase
  .from("signals")
  .select("id")
  .eq("wallet_id", wallet.id)
  .eq("outcome", "Pending");

      if (liveErr) {
        console.error(`Failed to fetch live signals for wallet ${wallet.id}:`, liveErr);
      }
      const livePicksCount = liveSignals?.length || 0;

      // Pause status
      const paused = losingStreak >= LOSING_STREAK_THRESHOLD || winRate < 80;

      // 3️⃣ Update wallet with error check
      const { data, error } = await supabase
        .from("wallets")
        .update({
          win_rate: winRate,
          losing_streak: losingStreak,
          live_picks: livePicks,
          paused,
          last_checked: new Date()
        })
        .eq("id", wallet.id);

      if (error) console.error(`Wallet ${wallet.id} update failed:`, error);
      else console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicks}, paused: ${paused}`);
    }

    console.log("✅ Wallet metrics updated successfully.");
  } catch (err) {
    console.error("Error updating wallet metrics:", err.message);
  }
}

/* ===========================
   Send Result Notes
=========================== */
async function sendResultNotes(sig, result) {
  const counts = await getMarketVoteCounts(sig.market_id);
  const confidence = getMajorityConfidence(counts);
  const emoji = RESULT_EMOJIS[result] || "⚪";
  const text = formatSignal(sig, confidence, emoji, "Result Received");

  await sendTelegram(text);
  await updateNotes("polymarket-millionaires", text);
}

/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets?.length) return;

  for (const { market_id } of markets) {
    const { data: signals } = await supabase.from("signals").select("*").eq("market_id", market_id);
     .eq("outcome", "Pending")
    if (!signals || signals.length < MIN_WALLETS_FOR_SIGNAL) continue;

    const perWalletPick = {};
    for (const sig of signals) perWalletPick[sig.wallet_id] = getPick(sig);

    const pickCounts = {};
    for (const pick of Object.values(perWalletPick)) if (pick && pick !== "Unknown") pickCounts[pick] = (pickCounts[pick] || 0) + 1;

    const entries = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    if (entries.length > 1 && entries[0][1] === entries[1][1]) continue; // tie

    const [majorityPick, walletCount] = entries[0];
    if (walletCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const confidence = getConfidenceEmoji(walletCount);
    const sig = signals.find(s => getPick(s) === majorityPick);
    if (!sig) continue;
    if (!FORCE_SEND && sig.signal_sent_at) continue;

    const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
    const text = formatSignal({ ...sig, side: majorityPick }, confidence, emoji, "Signal Sent");

    await sendTelegram(text);
    await updateNotes("polymarket-millionaires", text);

    await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("market_id", market_id);
  }
}

/* ===========================
   Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalFetched = 0;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (const period of timePeriods) {
    try {
      const url = `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=50`;
      const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      console.log(`[LEADERBOARD][${period}] Fetched=${data.length}`);

      totalFetched += data.length;

      for (const entry of data) {
        // Skip wallets without proxy or failing filters
        if (!entry.proxyWallet) {
          console.log(`Skipping wallet: missing proxyWallet (user=${entry.userName})`);
          totalSkipped++;
          continue;
        }
        if (entry.pnl < 1000) {
          console.log(`Skipping wallet ${entry.proxyWallet}: pnl ${entry.pnl} < 1000`);
          totalSkipped++;
          continue;
        }
        if (entry.vol >= 10 * entry.pnl) {
          console.log(`Skipping wallet ${entry.proxyWallet}: vol ${entry.vol} >= 10 * pnl ${entry.pnl}`);
          totalSkipped++;
          continue;
        }

        // Check if wallet already exists
        const { data: existing } = await supabase.from("wallets")
.select("id")
.eq("polymarket_proxy_wallet", entry.proxyWallet)
.maybeSingle();


        if (existing) {
          console.log(`Skipping wallet ${entry.proxyWallet}: already exists`);
          totalSkipped++;
          continue;
        }

        // Insert wallet paused by default
        await supabase.from("wallets").insert({
          polymarket_proxy_wallet: entry.proxyWallet,
          polymarket_username: null, // optional, DO NOT rely on it
          last_checked: new Date(),
          paused: true,      // start paused
          losing_streak: 0,
          win_rate: 0
        });

        console.log(`Inserted wallet ${entry.proxyWallet} (user=${entry.userName})`);
        totalInserted++;
      } // end inner for
    } catch (err) {
      console.error(`Failed to fetch leaderboard (${period}):`, err.message);
    }
  } // end outer for

  console.log(`Leaderboard fetch complete.
Total fetched: ${totalFetched}
Total inserted: ${totalInserted}
Total skipped: ${totalSkipped}`);
}

/* ===========================
   Daily Summary
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const startYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

  const { data: ySignals } = await supabase.from("signals").select("*")
    .gte("created_at", startYesterday.toISOString())
    .lte("created_at", endYesterday.toISOString());

  const { data: allSignals } = await supabase.from("signals").select("*");
  const pendingSignals = allSignals.filter(s => s.outcome === "Pending");

  let summaryText = `Yesterday's results:\n`;
  if (!ySignals.length) summaryText += `0 predictions yesterday.\n`;
  else ySignals.forEach(s => summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${RESULT_EMOJIS[s.outcome] || "⚪"}\n`);

  summaryText += `\nPending picks:\n`;
  if (!pendingSignals.length) summaryText += `0 predictions pending ⚪\n`;
  else pendingSignals.forEach(s => summaryText += `${s.signal} - ${s.side} - Pending ⚪\n`);

  await sendTelegram(toBlockquote(summaryText), true);
  await supabase.from("notes").update({ content: toBlockquote(summaryText), public: true }).eq("slug", "polymarket-millionaires");

  await fetchAndInsertLeaderboardWallets();
}

/* ===========================
   Cron daily at 7am
=========================== */
cron.schedule("0 7 * * *", () => {
  console.log("Running daily summary + leaderboard + new wallets fetch...");
  sendDailySummary();
}, { timezone: TIMEZONE });


/* ===========================
   Heartbeat
=========================== */

setInterval(() => {
  console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`);
}, 60_000); // every 60 seconds

/* ===========================
   Tracker Loop
=========================== */
async function trackerLoop() {
  try {
    // 1️⃣ Fetch all wallets
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return console.log("No wallets found");

    console.log(`[${new Date().toISOString()}] Tracking ${wallets.length} wallets...`);

    // 2️⃣ Track each wallet (fetch positions & update signals)
    for (const wallet of wallets) {
      try {
        await trackWallet(wallet);
      } catch (err) {
        console.error(`Error tracking wallet ${wallet.id}:`, err.message);
      }
    }

    // 3️⃣ Recalculate wallet metrics (win_rate, losing streak, paused)
    try {
      await updateWalletMetricsJS();
    } catch (err) {
      console.error("Error updating wallet metrics:", err.message);
    }

    // 4️⃣ Send majority signals
    try {
      await sendMajoritySignals();
    } catch (err) {
      console.error("Error sending majority signals:", err.message);
    }

          // after all wallets are tracked
await rebuildWalletLivePicks();


    console.log(`✅ Tracker loop completed successfully`);
  } catch (err) {
    console.error("Loop error:", err.message);
    // Telegram notifications are disabled to avoid spamming
    // await sendTelegram(`Tracker loop error: ${err.message}`);


  }
}

/* ===========================
   Main Function
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // Fetch leaderboard wallets once at startup
  try {
    await fetchAndInsertLeaderboardWallets();
  } catch (err) {
    console.error("Failed to fetch leaderboard wallets:", err.message);
  }

  // Run tracker loop immediately
  await trackerLoop();

  // Repeat tracker loop every POLL_INTERVAL milliseconds
  setInterval(trackerLoop, POLL_INTERVAL);
}

// Run main on startup
main();

   
/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));

