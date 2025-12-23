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
   Telegram
=========================== */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

/* ===========================
   Polymarket API
=========================== */
async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json"
    }
  });

  if (!res.ok) {
    console.error("Trade fetch failed:", res.status);
    return null;
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    console.error("Non-JSON response (Cloudflare block likely)");
    return null;
  }

  try {
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

/* ===========================
   Market Vote Counts
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!signals || signals.length === 0) return null;

  const perWallet = {};

  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.keys(votes);
    if (sides.length !== 1) continue; // conflicted wallet → ignore
    const side = sides[0];
    counts[side] = (counts[side] || 0) + 1;
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
  if (!counts) return "";
  const max = Math.max(...Object.values(counts));
  return getConfidenceEmoji(max);
}

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused) return;
  if (!wallet.polymarket_proxy_wallet) return;

  console.log("Fetching trades for proxy wallet:", wallet.polymarket_proxy_wallet);

  const trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
  if (!trades || trades.length === 0) return;

  for (const trade of trades) {
    if (
      trade.proxyWallet &&
      trade.proxyWallet.toLowerCase() !==
        wallet.polymarket_proxy_wallet.toLowerCase()
    ) {
      continue;
    }

    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existing) {
      console.log("Reached known tx, stopping");
      break;
    }

    const side = String(trade.outcome).toUpperCase();

    const { error } = await supabase.from("signals").insert({
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
      tx_hashes: [trade.transactionHash]
    });

    if (error) {
      console.error("INSERT ERROR:", error);
      return;
    }

    console.log("Inserted trade:", trade.transactionHash);
  }

  await supabase
    .from("wallets")
    .update({ last_checked: new Date() })
    .eq("id", wallet.id);
}

/* ===========================
   Resolve Outcomes & Losing Streaks
=========================== */
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

    const winningSide = String(market.winningOutcome || "").toUpperCase();
    if (!winningSide) continue;

    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({ outcome: result, outcome_at: new Date() })
      .eq("id", sig.id);

    const { data: wallet } = await supabase
      .from("wallets")
      .select("*")
      .eq("id", sig.wallet_id)
      .single();

    if (result === "LOSS") {
      const streak = (wallet.losing_streak || 0) + 1;
      await supabase
        .from("wallets")
        .update({ losing_streak: streak })
        .eq("id", wallet.id);

      if (streak >= LOSING_STREAK_THRESHOLD) {
        await supabase
          .from("wallets")
          .update({ paused: true })
          .eq("id", wallet.id);

        await sendTelegram(
          `Wallet paused due to losing streak:\nWallet ID: ${wallet.id}\nLosses: ${streak}`
        );
      }
    } else {
      await supabase
        .from("wallets")
        .update({ losing_streak: 0 })
        .eq("id", wallet.id);
    }

    resolvedAny = true;
  }

  if (resolvedAny) {
    await sendMajoritySignals();
  }
}

/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id", { distinct: true });

  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    const side = getMajoritySide(counts);
    if (!side) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    await sendTelegram(
      `Market Signal Update:\nMarket: ${market_id}\nPrediction: ${side}\nConfidence: ${confidence}`
    );
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
