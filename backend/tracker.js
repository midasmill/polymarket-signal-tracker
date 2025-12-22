import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// ---------------------------
// ENV
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Telegram config required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const POLL_INTERVAL = 30 * 1000;

// ---------------------------
// Telegram
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
async function fetchWalletTrades(walletAddress) {
  const res = await fetch(`https://polymarket.com/api/trades?user=${walletAddress}`);
  return res.ok ? res.json() : [];
}

async function fetchUserTrades(userId) {
  if (!userId) return [];
  const res = await fetch(`https://polymarket.com/api/users/${userId}/trades`);
  return res.ok ? res.json() : [];
}

async function fetchMarket(marketId) {
  const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
  return res.ok ? res.json() : null;
}

// ---------------------------
// Confidence helper
// ---------------------------
function getConfidenceEmoji(count) {
  if (count > 50) return "⭐⭐⭐⭐⭐";
  if (count > 35) return "⭐⭐⭐⭐";
  if (count > 25) return "⭐⭐⭐";
  if (count > 15) return "⭐⭐";
  if (count > 5) return "⭐";
  return "";
}

function confidenceToNumber(conf) {
  const mapping = { "⭐": 1, "⭐⭐": 2, "⭐⭐⭐": 3, "⭐⭐⭐⭐": 4, "⭐⭐⭐⭐⭐": 5 };
  return mapping[conf] || 0;
}

// ---------------------------
// Count votes per market
// ---------------------------
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .eq("market_id", marketId);

  if (!signals || signals.length === 0) return null;

  const walletVotes = {}; // walletId -> { YES: 0|1, NO: 0|1 }

  for (const sig of signals) {
    walletVotes[sig.wallet_id] = walletVotes[sig.wallet_id] || { YES: 0, NO: 0 };
    walletVotes[sig.wallet_id][sig.side] = 1;
  }

  let yesVotes = 0;
  let noVotes = 0;

  for (const v of Object.values(walletVotes)) {
    if (v.YES && v.NO) {
      yesVotes += 0.5;
      noVotes += 0.5;
    } else if (v.YES) {
      yesVotes += 1;
    } else if (v.NO) {
      noVotes += 1;
    }
  }

  return { yesVotes, noVotes };
}

function getMajoritySide(votes) {
  if (!votes) return null;
  if (votes.yesVotes > votes.noVotes) return "YES";
  if (votes.noVotes > votes.yesVotes) return "NO";
  return null; // tie
}

function getMajorityConfidence(votes) {
  if (!votes) return "";
  const count = Math.max(votes.yesVotes, votes.noVotes);
  return getConfidenceEmoji(count);
}

// ---------------------------
// Track wallet/user
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) return;

  console.log("Fetching trades for wallet/user:", wallet.wallet_address);

  const trades = wallet.polymarket_user_id
    ? await fetchUserTrades(wallet.polymarket_user_id)
    : await fetchWalletTrades(wallet.wallet_address);

  if (!trades || trades.length === 0) {
    console.log("NO TRADES for", wallet.wallet_address);
    return;
  }

  for (const trade of trades) {
    // Prevent duplicate per tradeId
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existing) continue;

    const side = trade.outcome === "Yes" ? "YES" : "NO";

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.marketQuestion,
      side,
      market_id: trade.marketId,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp)
    });
  }
}

// ---------------------------
// Send majority signals with confidence updates
// ---------------------------
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id")
    .group("market_id");

  for (const m of markets) {
    const votes = await getMarketVoteCounts(m.market_id);
    const majoritySide = getMajoritySide(votes);
    if (!majoritySide) continue; // tie, skip

    const confidence = getMajorityConfidence(votes);

    // Check last confidence sent
    const { data: last } = await supabase
      .from("signals")
      .select("last_confidence_sent")
      .eq("market_id", m.market_id)
      .eq("side", majoritySide)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastSentNum = confidenceToNumber(last?.last_confidence_sent || "");
    const currentNum = confidenceToNumber(confidence);

    if (currentNum > lastSentNum) {
      // Update last_confidence_sent for all signals with this market + side
      await supabase
        .from("signals")
        .update({ last_confidence_sent: confidence })
        .eq("market_id", m.market_id)
        .eq("side", majoritySide);

      // Send Telegram update
      await sendTelegram(
        `Confidence Update:\nMarket: ${m.market_id}\nPrediction: ${majoritySide}\nConfidence: ${confidence}`
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
    const votes = await getMarketVoteCounts(sig.market_id);
    const majoritySide = getMajoritySide(votes) || sig.side;
    const confidence = getMajorityConfidence(votes);
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
// Resolve outcomes
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

    const winningSide = market.winningOutcome === "Yes" ? "YES" : "NO";
    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({ outcome: result, outcome_at: new Date() })
      .eq("id", sig.id);

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

  // Initial fetch for all wallets
  const { data: wallets } = await supabase.from("wallets").select("*");
  console.log("WALLETS LOADED:", wallets?.length);
  console.log("WALLET ADDRESSES:", wallets?.map(w => w.wallet_address));

  for (const wallet of wallets) {
    await trackWallet(wallet);
  }

  // Calculate confidence immediately after startup
  await sendMajoritySignals();
  await updateNotesFeed();

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");

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
