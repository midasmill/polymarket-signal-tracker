import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import { utcToZonedTime } from "date-fns-tz";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const POLL_INTERVAL = 30 * 1000;
const LOSING_STREAK_THRESHOLD = 3;
const MIN_WALLETS_FOR_SIGNAL = 2; // production mode threshold
const FORCE_SEND = true; // send all eligible signals

const TIMEZONE = "America/New_York";
const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌" };

/* ===========================
   Telegram helper
=========================== */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
}

/* ===========================
   Polymarket API
=========================== */
async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error("Trade fetch error:", err.message);
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
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  if (count > 50) return "⭐⭐⭐⭐⭐";
  if (count > 35) return "⭐⭐⭐⭐";
  if (count > 25) return "⭐⭐⭐";
  if (count > 15) return "⭐⭐";
  if (count >= MIN_WALLETS_FOR_SIGNAL) return "⭐";
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

  if (!signals || signals.length === 0) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes);
    sides.sort((a, b) => b[1] - a[1]);
    const side = sides[0][0];
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
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;
  console.log("Fetching trades for proxy wallet:", wallet.polymarket_proxy_wallet);

  const trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
  if (!trades || trades.length === 0) return;

  for (const trade of trades) {
    if (trade.proxyWallet && trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("market_id", trade.conditionId)
      .eq("side", trade.outcome)
      .eq("signal", trade.title)
      .maybeSingle();

    if (existing) continue;

    const side = String(trade.outcome).toUpperCase();

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      slug: trade.slug, // store slug for link
      side,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
    });

    console.log("Inserted trade:", trade.transactionHash);
  }

  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Resolve outcomes & handle losing streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
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

    const counts = await getMarketVoteCounts(sig.market_id);
    const confidence = getMajorityConfidence(counts);
    const emoji = RESULT_EMOJIS[result] || "";
    const eventUrl = `https://polymarket.com/events/${sig.slug}`;

    const noteText = `Result Received: ${new Date().toLocaleString()}\n` +
                     `Market Event: [${sig.signal}](${eventUrl})\n` +
                     `Prediction: ${sig.side}\n` +
                     `Confidence: ${confidence}\n` +
                     `Outcome: ${winningSide}\n` +
                     `Result: ${result} ${emoji}`;

    await sendTelegram(noteText);

    const { data: notes } = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();
    let newContent = notes ? notes.content : "";
    const regex = new RegExp(`.*\\[${sig.signal}\\]\\(.*\\).*`, "g");
    if (regex.test(newContent)) {
      newContent = newContent.replace(regex, noteText);
    } else {
      newContent += newContent ? `\n\n${noteText}` : noteText;
    }
    await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
  }

  if (resolvedAny) {
    await sendMajoritySignals();
  }
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

    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .eq("market_id", market_id)
      .eq("side", side);

    if (!signals) continue;

    for (const sig of signals) {
      if (!FORCE_SEND && sig.signal_sent_at) continue;

      const eventUrl = `https://polymarket.com/events/${sig.slug}`;
      const noteText = `Signal Sent: ${new Date().toLocaleString()}\n` +
                       `Market Event: [${sig.signal}](${eventUrl})\n` +
                       `Prediction: ${sig.side}\n` +
                       `Confidence: ${confidence}\n` +
                       `Outcome: ${sig.outcome || "Pending"}`;

      await sendTelegram(noteText);

      const { data: notes } = await supabase
        .from("notes")
        .select("id, content")
        .eq("slug", "polymarket-millionaires")
        .maybeSingle();
      let newContent = notes ? notes.content : "";
      const regex = new RegExp(`.*\\[${sig.signal}\\]\\(.*\\).*`, "g");
      if (regex.test(newContent)) {
        newContent = newContent.replace(regex, noteText);
      } else {
        newContent += newContent ? `\n\n${noteText}` : noteText;
      }
      await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");

      await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("id", sig.id);
    }
  }
}

/* ===========================
   Daily Summary at 7am ET
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const todayET = utcToZonedTime(now, TIMEZONE);
  const yesterdayET = new Date(todayET);
  yesterdayET.setDate(todayET.getDate() - 1);
  const startYesterday = new Date(yesterdayET.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterdayET.setHours(23, 59, 59, 999));

  const { data: allSignals } = await supabase.from("signals").select("*");
  const allWins = allSignals.filter(s => s.outcome === "WIN").length;
  const allLosses = allSignals.filter(s => s.outcome === "LOSS").length;

  const { data: ySignals } = await supabase
    .from("signals")
    .select("*")
    .gte("created_at", startYesterday.toISOString())
    .lte("created_at", endYesterday.toISOString());

  const yWins = ySignals.filter(s => s.outcome === "WIN").length;
  const yLosses = ySignals.filter(s => s.outcome === "LOSS").length;
  const pendingSignals = allSignals.filter(s => s.outcome === "Pending");

  let summaryText = `📊 DAILY SUMMARY (${todayET.toLocaleDateString()})\n`;
  summaryText += `All-time (W-L): ${allWins}-${allLosses}\n`;
  summaryText += `Yesterday (${yesterdayET.toLocaleDateString()}) (W-L): ${yWins}-${yLosses}\n`;
  summaryText += `Pending: ${pendingSignals.length}\n\n`;

  summaryText += `Yesterday's results:\n`;
  ySignals.forEach(s => {
    const emoji = RESULT_EMOJIS[s.outcome] || "";
    summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${emoji}\n`;
  });

  summaryText += `\nPending picks:\n`;
  pendingSignals.forEach(s => {
    summaryText += `${s.signal} - ${s.side} - Pending\n`;
  });

  await sendTelegram(summaryText);

  const newContent = summaryText; // overwrite previous Notes content
  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
}

// Cron: run daily at 7am ET
cron.schedule("0 7 * * *", () => {
  console.log("Sending daily summary...");
  sendDailySummary();
}, { timezone: TIMEZONE });

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
