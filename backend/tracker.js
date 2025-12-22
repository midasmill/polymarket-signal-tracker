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
const LOSING_STREAK_THRESHOLD = 3;

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
async function fetchWalletTrades(username) {
  const res = await fetch(`https://polymarket.com/api/trades?user=${username}`);
  return res.ok ? res.json() : [];
}

async function fetchMarket(marketId) {
  const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
  return res.ok ? res.json() : null;
}

// ---------------------------
// Confidence helpers
// ---------------------------
function getConfidenceEmoji(count) {
  if (count > 50) return "⭐⭐⭐⭐⭐";
  if (count > 35) return "⭐⭐⭐⭐";
  if (count > 25) return "⭐⭐⭐";
  if (count > 15) return "⭐⭐";
  if (count > 5) return "⭐";
  return "⭐";
}

function confidenceToNumber(conf) {
  const map = { "⭐": 1, "⭐⭐": 2, "⭐⭐⭐": 3, "⭐⭐⭐⭐": 4, "⭐⭐⭐⭐⭐": 5 };
  return map[conf] || 0;
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

  let yesVotes = 0, noVotes = 0;
  for (const v of Object.values(walletVotes)) {
    if (v.YES && v.NO) { yesVotes += 0.5; noVotes += 0.5; }
    else if (v.YES) yesVotes += 1;
    else if (v.NO) noVotes += 1;
  }

  return { yesVotes, noVotes };
}

function getMajoritySide(votes) {
  if (!votes) return null;
  if (votes.yesVotes > votes.noVotes) return "YES";
  if (votes.noVotes > votes.yesVotes) return "NO";
  return null;
}

function getMajorityConfidence(votes) {
  if (!votes) return "⭐";
  const count = Math.max(votes.yesVotes, votes.noVotes);
  return getConfidenceEmoji(count);
}

// ---------------------------
// Track wallet
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) return;

  if (!wallet.polymarket_username) return;

  console.log("Fetching trades for wallet/user:", wallet.wallet_address);
  const trades = await fetchWalletTrades(wallet.polymarket_username);

  if (!trades || trades.length === 0) {
    console.log("NO TRADES for", wallet.wallet_address);
    return;
  }

  for (const trade of trades) {
    // Prevent duplicate per trade
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
      wallet_count: 1,
      created_at: new Date(trade.timestamp)
    });
  }
}

// ---------------------------
// Send majority signals
// ---------------------------
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id")
    .distinct();

  for (const m of markets) {
    const votes = await getMarketVoteCounts(m.market_id);
    const majoritySide = getMajoritySide(votes);
    if (!majoritySide) continue;

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

    const lastSentNum = confidenceToNumber(last?.last_confidence_sent || "⭐");
    const currentNum = confidenceToNumber(confidence);

    if (currentNum > lastSentNum) {
      await supabase
        .from("signals")
        .update({ last_confidence_sent: confidence })
        .eq("market_id", m.market_id)
        .eq("side", majoritySide);

      await sendTelegram(
        `Confidence Update:\nMarket: ${m.market_id}\nPrediction: ${majoritySide}\nConfidence: ${confidence}`
      );
    }
  }
}

// ---------------------------
// Notes feed
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
// Resolve outcomes & auto-pause wallets
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

    // Update wallet losing streak
    const { data: wallet } = await supabase
      .from("wallets")
      .select("*")
      .eq("id", sig.wallet_id)
      .maybeSingle();

    if (wallet) {
      let losing_streak = wallet.losing_streak || 0;
      if (result === "LOSS") {
        losing_streak += 1;
        if (losing_streak >= LOSING_STREAK_THRESHOLD && !wallet.paused) {
          await supabase
            .from("wallets")
            .update({ paused: true, losing_streak })
            .eq("id", wallet.id);
          console.log(`Wallet ${wallet.wallet_address} auto-paused after ${losing_streak} losses`);
          await sendTelegram(
            `⚠️ Wallet paused: ${wallet.polymarket_username}\nLosing streak: ${losing_streak}`
          );
        } else {
          await supabase
            .from("wallets")
            .update({ losing_streak })
            .eq("id", wallet.id);
        }
      } else {
        await supabase
          .from("wallets")
          .update({ losing_streak: 0 })
          .eq("id", wallet.id);
      }
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

  // Initial fetch of unresolved trades for all wallets
  const { data: wallets } = await supabase.from("wallets").select("*");
  for (const wallet of wallets) {
    await trackWallet(wallet);
  }

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
