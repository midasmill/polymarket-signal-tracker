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
async function fetchWalletTrades(userIdentifier) {
  try {
    const res = await fetch(`https://polymarket.com/api/trades?user=${userIdentifier}`);
    if (!res.ok) return [];
    const data = await res.json();

    console.log(`Fetched ${data.length} trades for ${userIdentifier}`);
    if (data.length > 0) console.log("Sample trade:", JSON.stringify(data[0], null, 2));

    return data;
  } catch (err) {
    console.error("Error fetching trades:", err);
    return [];
  }
}

async function fetchMarket(marketId) {
  try {
    const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    console.error("Error fetching market:", err);
    return null;
  }
}

// ---------------------------
// Confidence helper
// ---------------------------
function getConfidenceEmoji(count) {
  if (count >= 10) return "⭐⭐⭐";
  if (count >= 5) return "⭐⭐";
  return "⭐";
}

function confidenceToNumber(conf) {
  if (conf === "⭐") return 1;
  if (conf === "⭐⭐") return 2;
  if (conf === "⭐⭐⭐") return 3;
  return 0;
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
  if (!votes) return "⭐";
  const count = Math.max(votes.yesVotes, votes.noVotes);
  return getConfidenceEmoji(count);
}

// ---------------------------
// Track wallet
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) return;

  const userIdentifier = wallet.polymarket_user_id || wallet.wallet_address;

  console.log(`Fetching trades for wallet/user: ${userIdentifier}`);

  const trades = await fetchWalletTrades(userIdentifier);

  if (!trades || trades.length === 0) {
    console.log("NO TRADES for", userIdentifier);
    return;
  }

  for (const trade of trades) {
    if (trade.outcomeResolved) continue;

    // Prevent duplicate per transaction hash
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
      created_at: new Date(trade.timestamp),
      last_confidence_sent: "⭐"
    });
  }
}

// ---------------------------
// Send majority signals / confidence
// ---------------------------
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id")
    .group("market_id");

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
// Resolve outcomes & auto-pause losing wallets
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

    // Update losing streak & auto-pause
    const { data: walletData } = await supabase
      .from("wallets")
      .select("*")
      .eq("id", sig.wallet_id)
      .maybeSingle();

    if (!walletData) continue;

    if (result === "LOSS") {
      const newStreak = (walletData.losing_streak || 0) + 1;
      const pause = newStreak >= LOSING_STREAK_THRESHOLD;
      await supabase
        .from("wallets")
        .update({ losing_streak: newStreak, paused: pause })
        .eq("id", sig.wallet_id);
    } else {
      await supabase.from("wallets").update({ losing_streak: 0 }).eq("id", sig.wallet_id);
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
      const { data: wallets } = await supabase.from("wallets").select("*");
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
