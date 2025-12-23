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
const TELEGRAM_CHAT_ID = "-4911183253";
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
   Polymarket API
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
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
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
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([aKey, aVal], [bKey, bVal]) => bVal - aVal);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Market vote counts
   (safely count only wallets that meet pnl/volume/winrate)
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!signals?.length) return null;

  const perWallet = {};
  for (const s of signals) {
    if (!s?.wallet_id || !s?.side) continue;
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length === 0) continue;
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue; // tie votes = skip
    counts[sides[0][0]] = (counts[sides[0][0]] || 0) + 1;
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts || Object.keys(counts).length === 0) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null; // tie
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts || Object.values(counts).length === 0) return "";
  return getConfidenceEmoji(Math.max(...Object.values(counts)));
}

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused) return;

  let trades = [];
  let identityUsed = null;

  if (wallet.polymarket_proxy_wallet) {
    console.log(`Wallet ${wallet.id}: trying proxy wallet ${wallet.polymarket_proxy_wallet}`);
    trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
    if (trades.length > 0) identityUsed = "proxy";
  }

  if (trades.length === 0 && wallet.polymarket_username) {
    console.log(`Wallet ${wallet.id}: proxy empty, trying username ${wallet.polymarket_username}`);
    trades = await fetchLatestTrades(wallet.polymarket_username);
    if (trades.length > 0) identityUsed = "username";
  }

  if (!trades || trades.length === 0) {
    console.log(`Wallet ${wallet.id}: skipped (no trades via proxy or username)`);
    await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
    return;
  }

  console.log(`Wallet ${wallet.id}: ${trades.length} trades found using ${identityUsed}`);
  let insertedCount = 0;
  for (const trade of trades) {
    if (!trade) continue;

    // Ensure proxy wallet matches
    if (identityUsed === "proxy" &&
        trade.proxyWallet &&
        trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) {
      continue;
    }

    // Check if signal already exists
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
      market_id: trade.conditionId,
      side: String(trade.outcome).toUpperCase(),
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date((trade.timestamp || Date.now()/1000) * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
    });

    insertedCount++;
  }

  if (insertedCount > 0) console.log(`Inserted ${insertedCount} new trades for wallet ${wallet.id}`);
  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Format Signal for Telegram / Notes
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
   Pre-signals (near-threshold)
=========================== */
async function updatePreSignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets?.length) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    if (!counts) continue;

    const side = getMajoritySide(counts);
    if (!side) continue;

    const maxCount = Math.max(...Object.values(counts));
    if (maxCount > 0 && maxCount < MIN_WALLETS_FOR_SIGNAL) {
      const { data: existing } = await supabase
        .from("pre_signals")
        .select("id")
        .eq("market_id", market_id)
        .eq("side", side)
        .maybeSingle();

      if (!existing) {
        const { data: sig } = await supabase
          .from("signals")
          .select("*")
          .eq("market_id", market_id)
          .eq("side", side)
          .limit(1)
          .maybeSingle();

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
   Leaderboard Wallet Fetch
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const timePeriods = ["DAY","WEEK","MONTH","ALL"];
  let totalInserted = 0;

  for (const period of timePeriods) {
    let fetched = 0, passed = 0, inserted = 0, duplicates = 0;

    try {
      const url = `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=300`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      fetched = data?.length || 0;
      console.log(`[LEADERBOARD][${period}] Fetched=${fetched}`);

      for (const entry of data) {
        if (!entry?.proxyWallet) continue;

        // PNL / Volume filter
        if ((entry.pnl || 0) > 1000 && (entry.vol || 0) >= 0.17 * (entry.pnl || 1)) {
          passed++;

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .or(`polymarket_proxy_wallet.eq.${entry.proxyWallet},polymarket_username.eq.${entry.userName}`)
            .maybeSingle();

          if (existing) { duplicates++; continue; }

          try {
            await supabase.from("wallets").insert({
              polymarket_proxy_wallet: entry.proxyWallet,
              polymarket_username: entry.userName || entry.proxyWallet,
              last_checked: new Date(),
              paused: false,
            });
            inserted++; totalInserted++;
          } catch (err) { console.error("Insert wallet failed:", err.message); }
        }
      }

    } catch (err) { console.error(`Failed to fetch leaderboard (${period}):`, err.message); }

    console.log(`[LEADERBOARD][${period}] Passed=${passed} Inserted=${inserted} Duplicates=${duplicates}`);
  }

  console.log(`Leaderboard fetch complete. Total new wallets inserted: ${totalInserted}`);
}

/* ===========================
   Main Loop
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");
  await fetchAndInsertLeaderboardWallets();

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets?.length) return;

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
