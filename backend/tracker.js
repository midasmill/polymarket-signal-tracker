import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// ---------------------------
// ENV
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Supabase keys required");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error("Telegram config required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const POLL_INTERVAL = 30 * 1000;
const LOSING_STREAK_THRESHOLD = 3;

// ---------------------------
// Telegram helper
// ---------------------------
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

// ---------------------------
// Polymarket API
// ---------------------------
async function fetchWalletTrades(username, offset = 0, limit = 100) {
  const url = `https://data-api.polymarket.com/trades?user=${username}&takerOnly=true&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url);

    // Check content type
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`Non-JSON response for ${username} at offset ${offset}:`, await res.text());
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data;
  } catch (err) {
    console.error(`Error fetching trades for ${username}:`, err.message);
    return [];
  }
}

async function fetchMarket(marketId) {
  try {
    const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data || null;
  } catch (err) {
    console.error(`Error fetching market ${marketId}:`, err.message);
    return null;
  }
}

// ---------------------------
// Confidence helpers
// ---------------------------
function getConfidenceEmoji(count) {
  if (count > 50) return "⭐⭐⭐⭐⭐";
  if (count > 35) return "⭐⭐⭐⭐";
  if (count > 25) return "⭐⭐⭐";
  if (count > 15) return "⭐⭐";
  if (count > 3) return "⭐";
  return "";
}

function confidenceToNumber(conf) {
  return (conf.match(/⭐/g) || []).length;
}

// ---------------------------
// Market vote counts
// ---------------------------
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .eq("market_id", marketId);

  if (!signals || signals.length === 0) return null;

  const walletVotes = {};
  for (const sig of signals) {
    walletVotes[sig.wallet_id] = walletVotes[sig.wallet_id] || {};
    walletVotes[sig.wallet_id][sig.side] = 1;
  }

  const counts = {};
  for (const v of Object.values(walletVotes)) {
    for (const side of Object.keys(v)) {
      counts[side] = (counts[side] || 0) + 1;
    }
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "⭐";
  const maxCount = Math.max(...Object.values(counts));
  return getConfidenceEmoji(maxCount);
}

// ---------------------------
// Track wallet trades
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_username) return;

  console.log("Fetching trades for wallet/user:", wallet.wallet_address);

  let offset = 0;
  const limit = 100;
  let allTrades = [];

  while (true) {
    const trades = await fetchWalletTrades(wallet.polymarket_username, offset, limit);
    if (!trades || trades.length === 0) break;
    allTrades.push(...trades);
    if (trades.length < limit) break; // stop when no more pages
    offset += limit;
  }

  if (allTrades.length === 0) {
    console.log("NO TRADES for", wallet.wallet_address);
    return;
  }

  for (const trade of allTrades) {
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();
    if (existing) continue;

    // ---------------------------
    // Smart outcome mapping
    // ---------------------------
    let side;
    const outcome = trade.outcome;

    if (outcome.toUpperCase() === "YES" || outcome.toUpperCase() === "NO") {
      side = outcome.toUpperCase();
    } else if (outcome.toUpperCase() === "UP") {
      side = "UP";
    } else if (outcome.toUpperCase() === "DOWN") {
      side = "DOWN";
    } else {
      side = outcome; // sports team or custom outcome
    }

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      side,
      market_id: trade.conditionId,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      last_confidence_sent: ""
    });
  }
}

// ---------------------------
// Send majority signals with confidence
// ---------------------------
async function sendMajoritySignals() {
  const { data: signals } = await supabase
    .from("signals")
    .select("market_id")
    .order("market_id", { ascending: true });

  const uniqueMarkets = [...new Set(signals.map(s => s.market_id))];

  for (const marketId of uniqueMarkets) {
    const counts = await getMarketVoteCounts(marketId);
    const majoritySide = getMajoritySide(counts);
    if (!majoritySide) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    const { data: last } = await supabase
      .from("signals")
      .select("last_confidence_sent")
      .eq("market_id", marketId)
      .eq("side", majoritySide)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastSentNum = confidenceToNumber(last?.last_confidence_sent || "");
    const currentNum = confidenceToNumber(confidence);

    if (currentNum > lastSentNum) {
      await supabase
        .from("signals")
        .update({ last_confidence_sent: confidence })
        .eq("market_id", marketId)
        .eq("side", majoritySide);

      await sendTelegram(
        `Confidence Update:\nMarket: ${marketId}\nPrediction: ${majoritySide}\nConfidence: ${confidence}`
      );
    }
  }
}

// ---------------------------
// Update Notes feed
// ---------------------------
async function updateNotesFeed() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .order("created_at", { ascending: false });

  if (!signals) return;

  const MAX_SIGNALS = 50;
  const contentArray = [];

  for (const sig of signals.slice(0, MAX_SIGNALS)) {
    const counts = await getMarketVoteCounts(sig.market_id);
    const majoritySide = getMajoritySide(counts) || sig.side;
    const confidence = getMajorityConfidence(counts);
    const outcomeText = sig.outcome || "Pending";
    const timestamp = new Date(sig.created_at).toLocaleString("en-US");

    contentArray.push(
      `<p>
         Signal Sent: ${timestamp}<br>
         Market: ${sig.signal}<br>
         Prediction: ${majoritySide}<br>
         Outcome: ${outcomeText}<br>
         Confidence: ${confidence}
       </p>`
    );
  }

  await supabase
    .from("notes")
    .update({ content: contentArray.join(""), public: true })
    .eq("slug", "polymarket-millionaires");
}

// ---------------------------
// Resolve outcomes & handle losing streaks
// ---------------------------
async function updatePendingOutcomes() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pending?.length) return;

  let resolvedAny = false;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winningSide = market.winningOutcome.toUpperCase() === "YES" ? "YES" : market.winningOutcome;
    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({ outcome: result, outcome_at: new Date() })
      .eq("id", sig.id);

    const { data: walletData } = await supabase
      .from("wallets")
      .select("*")
      .eq("id", sig.wallet_id)
      .single();

    if (result === "LOSS") {
      const newStreak = (walletData.losing_streak || 0) + 1;
      await supabase
        .from("wallets")
        .update({ losing_streak: newStreak })
        .eq("id", sig.wallet_id);

      if (newStreak >= LOSING_STREAK_THRESHOLD) {
        await supabase
          .from("wallets")
          .update({ paused: true })
          .eq("id", sig.wallet_id);

        await sendTelegram(
          `Wallet paused due to losing streak:\nWallet ID: ${sig.wallet_id}\nConsecutive Losses: ${newStreak}`
        );
      }
    } else if (result === "WIN") {
      await supabase
        .from("wallets")
        .update({ losing_streak: 0 })
        .eq("id", sig.wallet_id);
    }

    resolvedAny = true;
  }

  if (resolvedAny) {
    await updateNotesFeed();
    await sendMajoritySignals();
  }
}

// ---------------------------
// Main loop
// ---------------------------
async function main() {
  console.log("🚀 Polymarket tracker live (REAL DATA)");

  setInterval(async () => {
    try {
      const { data: wallets, error } = await supabase.from("wallets").select("*");
      if (error) {
        console.error("Wallet fetch error:", error);
        return;
      }

      console.log("WALLETS LOADED:", wallets?.length);
      console.log("WALLET ADDRESSES:", wallets?.map(w => w.wallet_address));

      for (const wallet of wallets) {
        await trackWallet(wallet);
      }

      await updatePendingOutcomes();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
