import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http"; // <- only here, remove any other import


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
const FORCE_SEND = process.env.FORCE_SEND === "true" || true;

const CONFIDENCE_THRESHOLDS = {
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "15"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "25"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "35"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Markdown helper
=========================== */
function toBlockquote(text) {
  return text
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");
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


async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Trade fetch error:", err.message);
    return [];
  }
}

async function fetchMarket(marketId) {
  if (marketCache.has(marketId)) return marketCache.get(marketId);
  try {
    const market = await fetchWithRetry(`https://polymarket.com/api/markets/${marketId}`);
    if (market) marketCache.set(marketId, market);
    return market;
  } catch (err) {
    console.error("Market fetch error:", err.message);
    return null;
  }
}

/* ===========================
   One-time populate VW for all wallets + auto-pause
=========================== */
async function populateAllWalletWinRates() {
  console.log("Starting VW population for all wallets...");

  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets || wallets.length === 0) {
    console.log("No wallets found.");
    return;
  }

  for (const wallet of wallets) {
    try {
      const vw = await calculateVolumeWeightedWinRate(wallet);
      if (vw === null) {
        console.log(`Wallet ${wallet.id}: no resolved trades found.`);
        continue;
      }

      // Update wallet's win_rate
      await supabase
        .from("wallets")
        .update({ win_rate: vw })
        .eq("id", wallet.id);

      console.log(`Wallet ${wallet.id}: VW updated to ${(vw * 100).toFixed(1)}%`);

      // Auto-pause if VW < 80%
      if (vw < 0.8 && !wallet.paused) {
        await supabase
          .from("wallets")
          .update({ paused: true })
          .eq("id", wallet.id);
        console.log(`Wallet ${wallet.id} paused due to VW < 80%`);
      }

    } catch (err) {
      console.error(`Failed to calculate VW for wallet ${wallet.id}:`, err.message);
    }
  }

  console.log("VW population complete.");
}

/* ===========================
   VW Helpers
=========================== */
const resolutionCache = new Map();

/* ===========================
   Fetch trades with retries
=========================== */
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

/* ===========================
   Fetch all BUY CASH trades for a wallet/identity
=========================== */

async function fetchAllBuyCashTrades(identity) {
  if (!identity) return [];

  let all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url =
      `https://data-api.polymarket.com/trades?user=${identity}` +
      `&side=BUY&takerOnly=true&filterType=CASH&limit=${limit}&offset=${offset}`;

    let page;
    try {
      // Use your existing fetchWithRetry helper: retries 5x, 1500ms delay
      page = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 5, 1500);
    } catch (err) {
      console.error(`Failed to fetch trades for identity ${identity} (offset ${offset}):`, err.message);
      break; // skip this identity for now
    }

    if (!Array.isArray(page) || page.length === 0) break;

    all.push(...page);
    if (page.length < limit) break;
    offset += limit;

    // slight delay to reduce connection drops
    await new Promise(r => setTimeout(r, 200));
  }

  return all;
}


/* ===========================
   Fetch market resolution
=========================== */
const marketResolutionCache = new Map();

async function fetchMarketResolution(conditionId) {
  if (marketResolutionCache.has(conditionId)) return marketResolutionCache.get(conditionId);

  try {
    const market = await fetchWithRetry(`https://polymarket.com/api/markets/${conditionId}`);
    if (!market || !market.resolved) return null;

    const winningSide = String(market.winningOutcome || "").toUpperCase();
    marketResolutionCache.set(conditionId, winningSide);
    return winningSide;
  } catch (err) {
    console.error("Market resolution fetch error:", err.message);
    return null;
  }
}

/* ===========================
   Calculate Volume-Weighted Win Rate
=========================== */
async function calculateVolumeWeightedWinRate(wallet) {
  let trades = [];
  try {
    trades = await fetchAllBuyCashTrades(wallet.polymarket_proxy_wallet || wallet.polymarket_username);
  } catch (err) {
    console.error(`Trade fetch failed for wallet ${wallet.id}:`, err.message);
    return null; // skip this wallet for now
  }

  if (!trades.length) return null;

  let totalVolume = 0;
  let winningVolume = 0;

  for (const t of trades) {
    let resolvedSide;
    try {
      resolvedSide = await fetchMarketResolution(t.conditionId);
    } catch (err) {
      console.error(`Market resolution failed for ${t.conditionId}:`, err.message);
      continue;
    }
    if (!resolvedSide) continue;

    totalVolume += t.size;
    if (t.side.toUpperCase() === resolvedSide.toUpperCase()) winningVolume += t.size;
  }

  return totalVolume > 0 ? winningVolume / totalVolume : null;
}


/* ===========================
   Track wallet trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused) return;

  let trades = [];
  let identityUsed = null;

  if (wallet.polymarket_proxy_wallet) {
    trades = await fetchAllBuyCashTrades(wallet.polymarket_proxy_wallet);
    if (trades.length > 0) identityUsed = "proxy";
  }

   
  if (trades.length === 0 && wallet.polymarket_username) {
    trades = await fetchAllBuyCashTrades(wallet.polymarket_username);
    if (trades.length > 0) identityUsed = "username";
  }

  if (trades.length === 0) {
    console.log(`Wallet ${wallet.id}: skipped (no trades)`);
    await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
    return;
  }

  console.log(`Wallet ${wallet.id}: ${trades.length} trades found using ${identityUsed}`);

   
  for (const trade of trades) {
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("market_id", trade.conditionId)
      .eq("wallet_id", wallet.id)
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existing) continue;

     
    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,   // store conditionId
      side: String(trade.outcome).toUpperCase(),
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash]
    });
  }

  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Daily VW Calculation + Auto-pause
=========================== */
async function dailyVolumeWeightedCheck() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  console.log(`Calculating VW for ${wallets.length} wallets...`);

  for (const wallet of wallets) {
    const vw = await calculateVolumeWeightedWinRate(wallet);
    if (vw === null) continue;

    console.log(`Wallet ${wallet.id}: VW = ${(vw * 100).toFixed(2)}%`);

    if (vw < 0.8) {
      console.log(`Wallet ${wallet.id} paused (VW < 80%)`);
      await supabase.from("wallets").update({ paused: true, win_rate: vw }).eq("id", wallet.id);
    } else {
      await supabase.from("wallets").update({ win_rate: vw }).eq("id", wallet.id);
    }
  }
}




/* ===========================
   Daily Leaderboard + Pre-Signals
=========================== */
async function runDailyUpdate() {
  const now = new Date();
     console.log(`\n=== Daily Polymarket Update (${now.toLocaleString()}) ===`);

   
  // 1️⃣ Leaderboard fetch
  console.log("-- Fetching new leaderboard wallets --");
  await updateLeaderboard();
  await fetchAndInsertLeaderboardWallets();
  console.log("-- Leaderboard Update Complete --\n");

  // 2️⃣ Pre-signals update
    console.log("-- Updating Pre-Signals --");
  await updatePreSignals();
  console.log("-- Pre-Signals Update Complete --\n");

  console.log(`=== Daily Update Complete (${new Date().toLocaleString()}) ===\n`);
}


/* ===========================
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(
    ([, a], [, b]) => b - a
  );
  for (const [emoji, threshold] of entries) {
    if (count >= threshold) return emoji;
  }
  return "";
}

/* ===========================
   Market vote counts
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!signals || !signals.length) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] =
      (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue;
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
   Format Signal
=========================== */
function formatSignal(sig, confidence, emoji, eventType = "Signal Sent") {
  const eventUrl = `https://polymarket.com/events/${sig.market_id}`;
  return `${eventType}: ${new Date().toLocaleString()}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${sig.side}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"}
Result: ${sig.outcome ? emoji : "⚪"}`;
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

  const noteText = toBlockquote(text);
  const { data: notes } = await supabase
    .from("notes")
    .select("id, content")
    .eq("slug", "polymarket-millionaires")
    .maybeSingle();

  let newContent = notes?.content || "";
  const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");

  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;

  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
}

/* ===========================
   Resolve outcomes & losing streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
  if (!pending?.length) return;

  const marketIds = [...new Set(pending.map(s => s.market_id))];
  const markets = await Promise.all(marketIds.map(id => fetchMarket(id)));
  const marketMap = Object.fromEntries(markets.map(m => [m?.id, m]));

  let resolvedAny = false;

  for (const sig of pending) {
    const market = marketMap[sig.market_id];
    if (!market || !market.resolved) continue;

    const winningSide = String(market.winningOutcome || "").toUpperCase();
    if (!winningSide) continue;

    const result = sig.side === winningSide ? "WIN" : market.cancelled ? "PUSH" : "LOSS";

    await supabase.from("signals").update({ outcome: result, outcome_at: new Date() }).eq("id", sig.id);

    const { data: wallet } = await supabase.from("wallets").select("*").eq("id", sig.wallet_id).single();

    if (result === "LOSS") {
      const streak = (wallet.losing_streak || 0) + 1;
      await supabase.from("wallets").update({ losing_streak: streak }).eq("id", wallet.id);

      if (streak >= LOSING_STREAK_THRESHOLD) {
        await supabase.from("wallets").update({ paused: true }).eq("id", wallet.id);
        await sendTelegram(`Wallet paused due to losing streak:\nWallet ID: ${wallet.id}\nLosses: ${streak}`);
      }
    }

    resolvedAny = true;
    await sendResultNotes(sig, result);
  }

  if (resolvedAny) await sendMajoritySignals();
}



/* ===========================
   Daily wallet VW update + auto-pause
=========================== */

async function updateWalletWinRates() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  console.log(`\n=== Volume-Weighted Win Rate Update (${new Date().toLocaleString()}) ===`);

  for (const wallet of wallets) {
    try {
      const vw = await calculateVolumeWeightedWinRate(wallet);

      if (vw === null) {
        console.log(`Wallet ${wallet.id}: no resolved trades, skipping`);
        continue;
      }

      const shouldPause = vw < 0.80;

      await supabase
        .from("wallets")
        .update({
          win_rate: vw,
          paused: shouldPause
        })
        .eq("id", wallet.id);

      console.log(
        `Wallet ${wallet.id}: VW=${(vw * 100).toFixed(2)}% | ` +
        `${shouldPause ? "PAUSED" : "ACTIVE"}`
      );

    } catch (err) {
      console.error(`VW calc failed for wallet ${wallet.id}:`, err.message);
    }
  }

  console.log(`=== VW Update Complete ===\n`);
}





/* ===========================
   Send majority signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    const side = getMajoritySide(counts);
    if (!side) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    const { data: signals } = await supabase.from("signals").select("*").eq("market_id", market_id).eq("side", side);
    if (!signals) continue;

    for (const sig of signals) {
      if (!FORCE_SEND && sig.signal_sent_at) continue;

      const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
      const text = formatSignal(sig, confidence, emoji, "Signal Sent");

      await sendTelegram(text);

      const noteText = toBlockquote(text);
      const { data: notes } = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();

      let newContent = notes?.content || "";
      const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");

      if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
      else newContent += newContent ? `\n\n${noteText}` : noteText;

      await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
      await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("id", sig.id);
    }
  }
}

/* ===========================
   Pre-signals (near-threshold)
=========================== */
async function updatePreSignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    if (!counts) continue;

    const side = getMajoritySide(counts);
    if (!side) continue;

    const maxCount = Math.max(...Object.values(counts));
    if (maxCount > 0 && maxCount < MIN_WALLETS_FOR_SIGNAL) {
      const { data: existing } = await supabase.from("pre_signals").select("id").eq("market_id", market_id).eq("side", side).maybeSingle();
      if (!existing) {
        const { data: sig } = await supabase.from("signals").select("*").eq("market_id", market_id).eq("side", side).limit(1).maybeSingle();
        if (sig) {
          await supabase.from("pre_signals").insert({
            market_id,
            market_name: sig.market_name,
            side,
            wallet_count: maxCount,
            confidence: getConfidenceEmoji(maxCount),
            signal: sig.signal,
          });
        }
      }
    }
  }
}


/* ===========================
   Fetch new leaderboard wallets from Polymarket
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalInserted = 0;

  for (const period of timePeriods) {
    let fetched = 0;
    let passed = 0;
    let inserted = 0;
    let duplicates = 0;

    try {
      const url = `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=50`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      fetched = data.length;
      console.log(`[LEADERBOARD][${period}] Fetched=${fetched}`);

      for (const entry of data) {
        // Skip entries without proxyWallet
        if (!entry.proxyWallet) continue;

        // PnL and volume filter
        if (entry.pnl >= 100 && entry.vol < 6 * entry.pnl) {
          passed++;

          // Insert only if not already in wallets table
          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .or(
              `polymarket_proxy_wallet.eq.${entry.proxyWallet},polymarket_username.eq.${entry.userName}`
            )
            .maybeSingle();

          if (existing) {
            duplicates++;
            continue;
          }

          try {
            await supabase.from("wallets").insert({
              polymarket_proxy_wallet: entry.proxyWallet,
              polymarket_username: entry.userName,
              last_checked: new Date(),
              paused: false,
            });
            inserted++;
            totalInserted++;
          } catch (err) {
            console.error("Insert wallet failed:", err.message);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to fetch leaderboard (${period}):`, err.message);
    }

    console.log(
      `[LEADERBOARD][${period}] Passed=${passed} Inserted=${inserted} Duplicates=${duplicates}`
    );
  }

  console.log(`Leaderboard fetch complete. Total new wallets inserted: ${totalInserted}`);
}




/* ===========================
   Daily Summary + Leaderboard
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const startYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

  const { data: allSignals } = await supabase.from("signals").select("*");
  const { data: ySignals } = await supabase
    .from("signals")
    .select("*")
    .gte("created_at", startYesterday.toISOString())
    .lte("created_at", endYesterday.toISOString());

  const pendingSignals = allSignals.filter(s => s.outcome === "Pending");

  let summaryText = `Yesterday's results:\n`;

  if (!ySignals || ySignals.length === 0) summaryText += `0 predictions yesterday.\n`;
  else ySignals.forEach(s => summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${RESULT_EMOJIS[s.outcome] || "⚪"}\n`);

  summaryText += `\nPending picks:\n`;
  if (!pendingSignals || pendingSignals.length === 0) summaryText += `0 predictions pending ⚪\n`;
  else pendingSignals.forEach(s => summaryText += `${s.signal} - ${s.side} - Pending ⚪\n`);

  await sendTelegram(toBlockquote(summaryText), true);
  await supabase
    .from("notes")
    .update({ content: toBlockquote(summaryText), public: true })
    .eq("slug", "polymarket-millionaires");

  // Update wallet VW, leaderboard and fetch new wallets
  await updateWalletWinRates();
  await updateLeaderboard();
  await fetchAndInsertLeaderboardWallets();
}

/* ===========================
   Cron daily at 7am ET
=========================== */
cron.schedule("0 7 * * *", () => {
   runDailyUpdate().catch(err => console.error("Daily update failed:", err.message));
  console.log("Running daily summary + leaderboard + new wallets fetch...");
  sendDailySummary();
}, { timezone: TIMEZONE });

/* ===========================
   Main Loop
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // Insert new leaderboard wallets immediately on deploy
  await fetchAndInsertLeaderboardWallets();

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets?.length) return;

      console.log("Wallets loaded:", wallets.length);

      await Promise.all(wallets.map(trackWallet));
      await updatePendingOutcomes();
      await updatePreSignals();
    } catch (e) {
      console.error("Loop error:", e);
      await sendTelegram(`Tracker loop error: ${e.message}`);
    }
  }, POLL_INTERVAL);
}

main();

// Run once on deploy / manually
populateAllWalletWinRates()
  .then(() => console.log("All wallets processed"))
  .catch(err => console.error("Error populating VW:", err));


/* ===========================
   Keep Render happy by binding to a port
=========================== */
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => {
  console.log(`Tracker listening on port ${PORT}`);
});
