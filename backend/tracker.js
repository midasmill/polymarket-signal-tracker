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

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn("Telegram config missing. Alerts disabled.");
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
async function fetchWalletTrades(proxyWallet, offset = 0, limit = 100) {
  const url = `https://data-api.polymarket.com/trades?user=${proxyWallet}&takerOnly=true&limit=${limit}&offset=${offset}`;
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return [];
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`Non-JSON response for ${proxyWallet}: Cloudflare block?`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`Error fetching trades for ${proxyWallet}:`, err.message);
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
    .select("wallet_id, outcome_id")
    .eq("market_id", marketId);

  if (!signals || signals.length === 0) return null;

  const perWallet = {};
  for (const sig of signals) {
    perWallet[sig.wallet_id] ??= {};
    perWallet[sig.wallet_id][sig.outcome_id] = 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const outcomes = Object.keys(votes);
    if (outcomes.length !== 1) continue; // conflicted wallet → ignore
    const outcome = outcomes[0];
    counts[outcome] = (counts[outcome] || 0) + 1;
  }

  return counts;
}

function getMajorityOutcome(counts) {
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
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;

  console.log("Fetching trades for wallet:", wallet.polymarket_proxy_wallet);

  let offset = 0;
  const limit = 100;
  const allTrades = [];

  while (true) {
    const trades = await fetchWalletTrades(wallet.polymarket_proxy_wallet, offset, limit);
    if (!trades || trades.length === 0) break;

    allTrades.push(...trades);
    if (trades.length < limit) break;
    offset += limit;
  }

  if (!allTrades.length) return;

  for (const trade of allTrades) {
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existing) continue;

    // Determine side / outcome
    let side = trade.outcome?.toUpperCase() || trade.side?.toUpperCase() || "UNKNOWN";
    let outcome_id = trade.outcome || trade.side || "UNKNOWN";

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      side,
      outcome_id,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
      last_confidence_sent: ""
    });
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
    await updateNotesFeed();
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
    const majorityOutcome = getMajorityOutcome(counts);
    if (!majorityOutcome) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    const { data: last } = await supabase
      .from("signals")
      .select("last_confidence_sent")
      .eq("market_id", market_id)
      .eq("outcome_id", majorityOutcome)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastNum = confidenceToNumber(last?.last_confidence_sent || "");
    const currentNum = confidenceToNumber(confidence);

    if (currentNum > lastNum) {
      await supabase
        .from("signals")
        .update({ last_confidence_sent: confidence })
        .eq("market_id", market_id)
        .eq("outcome_id", majorityOutcome);

      await sendTelegram(
        `Market Signal Update:\nMarket: ${market_id}\nPrediction: ${majorityOutcome}\nConfidence: ${confidence}`
      );
    }
  }
}

/* ===========================
   Update Notes Feed
=========================== */
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
    const majorityOutcome = getMajorityOutcome(counts) || sig.outcome_id;
    const confidence = getMajorityConfidence(counts);
    const outcomeText = sig.outcome || "Pending";
    const timestamp = new Date(sig.created_at).toLocaleString("en-US");

    contentArray.push(
      `<p>
         Signal Sent: ${timestamp}<br>
         Market: ${sig.signal}<br>
         Prediction: ${majorityOutcome}<br>
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
