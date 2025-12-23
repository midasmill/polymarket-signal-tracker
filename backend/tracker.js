import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const POLL_INTERVAL = 30 * 1000;
const LOSING_STREAK_THRESHOLD = 3;

/* ===========================
   Telegram Helper
=========================== */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

/* ===========================
   Polymarket API
=========================== */
async function fetchLatestTrades(proxyWallet) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${proxyWallet}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json"
      }
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function fetchMarket(marketId) {
  try {
    const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ===========================
   Confidence Helpers
=========================== */
function getConfidenceEmoji(voteCount) {
  if (voteCount > 50) return "⭐⭐⭐⭐⭐";
  if (voteCount > 35) return "⭐⭐⭐⭐";
  if (voteCount > 25) return "⭐⭐⭐";
  if (voteCount > 15) return "⭐⭐";
  if (voteCount > 3) return "⭐";
  return "";
}

function confidenceToNumber(conf) {
  return (conf.match(/⭐/g) || []).length;
}

/* ===========================
   Market Vote Counts
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
    perWallet[s.wallet_id][s.side] = (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  // Handle conflicting trades: 0.5/0.5 count if multiple sides per wallet
  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.keys(votes);
    if (sides.length === 1) {
      const side = sides[0];
      counts[side] = (counts[side] || 0) + 1;
    } else if (sides.length === 2) {
      // conflict → count 0.5 per side
      for (const side of sides) {
        counts[side] = (counts[side] || 0) + 0.5;
      }
    }
  }
  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "";
  const maxVotes = Math.max(...Object.values(counts));
  return getConfidenceEmoji(maxVotes);
}

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;

  console.log("Fetching trades for proxy wallet:", wallet.polymarket_proxy_wallet);
  const trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
  if (!trades || trades.length === 0) return;

  for (const trade of trades) {
    if (trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existing) continue; // already recorded

    const side = String(trade.outcome).toUpperCase();

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      side,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
      last_confidence_sent: ""
    });

    console.log("Inserted trade:", trade.transactionHash);
  }

  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Update Pending Outcomes & Losing Streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
  if (!pending?.length) return;

  let resolvedAny = false;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winningSide = String(market.winningOutcome).toUpperCase();
    if (!winningSide) continue;

    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase.from("signals").update({
      outcome: result,
      outcome_at: new Date()
    }).eq("id", sig.id);

    const { data: wallet } = await supabase.from("wallets").select("*").eq("id", sig.wallet_id).single();

    if (result === "LOSS") {
      const streak = (wallet.losing_streak || 0) + 1;
      await supabase.from("wallets").update({ losing_streak: streak }).eq("id", wallet.id);
      if (streak >= LOSING_STREAK_THRESHOLD && !wallet.paused) {
        await supabase.from("wallets").update({ paused: true }).eq("id", wallet.id);
        await sendTelegram(`Wallet paused due to losing streak:\nWallet ID: ${wallet.id}\nLosses: ${streak}`);
      }
    }

    resolvedAny = true;

    // Send outcome received to Notes + Telegram
    await sendSignalToNotesAndTelegram(sig, result, winningSide);
  }

  if (resolvedAny) await sendMajoritySignals();
}

/* ===========================
   Send Signals to Notes + Telegram
=========================== */
async function sendSignalToNotesAndTelegram(signal, result = null, winningSide = null) {
  const counts = await getMarketVoteCounts(signal.market_id);
  const majoritySide = getMajoritySide(counts);
  const confidence = getMajorityConfidence(counts);
  if (!confidence || confidenceToNumber(confidence) === 0) return;

  const timestamp = new Date().toLocaleString("en-US");

  let message = "";
  if (!result) {
    // New signal
    message = `Signal Sent: ${timestamp}\nMarket Event: ${signal.market_name}\nPrediction: ${majoritySide}\nConfidence: ${confidence}`;
  } else {
    // Outcome received
    message = `Result Received: ${timestamp}\nMarket Event: ${signal.market_name}\nPrediction: ${majoritySide}\nConfidence: ${confidence}\nOutcome: ${winningSide}\nResult: ${result}`;
  }

  await sendTelegram(message);

  // Update Notes
  const { data: noteData } = await supabase.from("notes").select("content").eq("slug", "polymarket-millionaires").single();
  const contentArray = noteData?.content ? noteData.content.split("<hr>") : [];
  contentArray.unshift(`<p>${message}</p>`);
  if (contentArray.length > 50) contentArray.splice(50); // max 50 signals
  await supabase.from("notes").update({ content: contentArray.join("<hr>") }).eq("slug", "polymarket-millionaires");
}

/* ===========================
   Send Majority Signals (Confidence Updates)
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    const side = getMajoritySide(counts);
    if (!side) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence || confidenceToNumber(confidence) === 0) continue;

    // Check if confidence increased
    const { data: lastSent } = await supabase.from("signals")
      .select("last_confidence_sent, created_at, market_name")
      .eq("market_id", market_id)
      .eq("side", side)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (confidenceToNumber(confidence) > confidenceToNumber(lastSent?.last_confidence_sent || "")) {
      // Update last_confidence_sent
      await supabase.from("signals").update({ last_confidence_sent: confidence }).eq("market_id", market_id).eq("side", side);

      const updateMessage = `Signal Update: ${new Date().toLocaleString("en-US")}\nRationale: Increased Confidence Level\nSignal Sent: ${new Date(lastSent.created_at).toLocaleString("en-US")}\nMarket Event: ${lastSent.market_name}\nPrediction: ${side}\nConfidence: ${confidence}`;
      await sendTelegram(updateMessage);

      // Update Notes
      const { data: noteData } = await supabase.from("notes").select("content").eq("slug", "polymarket-millionaires").single();
      const contentArray = noteData?.content ? noteData.content.split("<hr>") : [];
      contentArray.unshift(`<p>${updateMessage}</p>`);
      if (contentArray.length > 50) contentArray.splice(50);
      await supabase.from("notes").update({ content: contentArray.join("<hr>") }).eq("slug", "polymarket-millionaires");
    }
  }
}

/* ===========================
   Main Loop
=========================== */
async function main() {
  console.log("🚀 Polymarket tracker live");

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets) return;
      console.log("Wallets loaded:", wallets.length);

      for (const wallet of wallets) await trackWallet(wallet);
      await updatePendingOutcomes();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
