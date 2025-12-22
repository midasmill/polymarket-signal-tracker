import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

/* =========================
   ENV
========================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Telegram config required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const POLL_INTERVAL = 30 * 1000;
const MAX_LOSING_STREAK = 3;

/* =========================
   Telegram
========================= */
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

/* =========================
   Polymarket API
========================= */
async function fetchWalletTrades(wallet) {
  const res = await fetch(`https://polymarket.com/api/trades?user=${wallet}`);
  return res.ok ? res.json() : [];
}

async function fetchMarket(marketId) {
  const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
  return res.ok ? res.json() : null;
}

/* =========================
   Confidence helpers
========================= */
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

/* =========================
   Vote counting logic
========================= */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId)
    .eq("outcome", "Pending");

  if (!signals || signals.length === 0) return null;

  const walletVotes = {};

  for (const sig of signals) {
    walletVotes[sig.wallet_id] ||= { YES: 0, NO: 0 };
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
  return null;
}

function getMajorityConfidence(votes) {
  if (!votes) return "⭐";
  const count = Math.max(votes.yesVotes, votes.noVotes);
  return getConfidenceEmoji(count);
}

/* =========================
   Track wallet trades
========================= */
async function trackWallet(wallet) {
  if (wallet.paused) return;

  console.log("Fetching trades for:", wallet.wallet_address);
  const trades = await fetchWalletTrades(wallet.wallet_address);

  if (!trades || trades.length === 0) return;

  for (const trade of trades) {
    const { data: exists } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (exists) continue;

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

/* =========================
   Send majority confidence updates
========================= */
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id")
    .group("market_id");

  if (!markets) return;

  for (const m of markets) {
    const votes = await getMarketVoteCounts(m.market_id);
    const majoritySide = getMajoritySide(votes);
    if (!majoritySide) continue;

    const confidence = getMajorityConfidence(votes);

    const { data: last } = await supabase
      .from("signals")
      .select("last_confidence_sent")
      .eq("market_id", m.market_id)
      .eq("side", majoritySide)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prev = confidenceToNumber(last?.last_confidence_sent || "⭐");
    const curr = confidenceToNumber(confidence);

    if (curr > prev) {
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

/* =========================
   Notes feed
========================= */
async function updateNotesFeed() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!signals) return;

  const content = [];

  for (const sig of signals) {
    const votes = await getMarketVoteCounts(sig.market_id);
    const side = getMajoritySide(votes) || sig.side;
    const confidence = getMajorityConfidence(votes);
    const time = new Date(sig.created_at).toLocaleString("en-US");

    content.push(`
      <p>
        Signal Sent: ${time}<br>
        Market: ${sig.signal}<br>
        Prediction: ${side}<br>
        Outcome: ${sig.outcome}<br>
        Confidence: ${confidence}
      </p>
    `);
  }

  await supabase
    .from("notes")
    .update({ content: content.join(""), public: true })
    .eq("slug", "polymarket-millionaires");
}

/* =========================
   Resolve outcomes + auto-pause
========================= */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pending?.length) return;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winningSide =
      market.winningOutcome === "Yes" ? "YES" : "NO";

    const isWin = sig.side === winningSide;
    const result = isWin ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({
        outcome: result,
        outcome_at: new Date()
      })
      .eq("id", sig.id);

    const { data: wallet } = await supabase
      .from("wallets")
      .select("losing_streak, paused")
      .eq("id", sig.wallet_id)
      .single();

    if (!wallet) continue;

    const newStreak = isWin ? 0 : (wallet.losing_streak || 0) + 1;
    const shouldPause = newStreak >= MAX_LOSING_STREAK;

    await supabase
      .from("wallets")
      .update({
        losing_streak: newStreak,
        paused: shouldPause ? true : wallet.paused
      })
      .eq("id", sig.wallet_id);

    if (shouldPause && !wallet.paused) {
      await sendTelegram(
        `Wallet auto-paused 🚫\nReason: ${newStreak} consecutive losses`
      );
    }
  }

  await sendMajoritySignals();
  await updateNotesFeed();
}

/* =========================
   Main loop
========================= */
async function main() {
  console.log("🚀 Polymarket tracker live (REAL DATA)");

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase
        .from("wallets")
        .select("*");

      console.log("WALLETS LOADED:", wallets?.length);

      for (const wallet of wallets || []) {
        await trackWallet(wallet);
      }

      await updatePendingOutcomes();
    } catch (err) {
      console.error("Loop error:", err);
    }
  }, POLL_INTERVAL);
}

main();
