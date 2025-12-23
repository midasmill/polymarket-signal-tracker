import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253"; // Group chat ID
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

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", PUSH: "⚪", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

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
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

/* ===========================
   Polymarket API with retries + cache
=========================== */
const marketCache = new Map();

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data;
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
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
  const entries = Object.entries(CONFIDENCE_THRESHOLDS)
    .sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) {
    if (count >= threshold) return emoji;
  }
  return "";
}

function getMajoritySide(counts) {
  if (!counts || Object.keys(counts).length === 0) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length < 1) return null;
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null; // tie
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts || Object.keys(counts).length === 0) return "";
  const max = Math.max(...Object.values(counts));
  return getConfidenceEmoji(max);
}

/* ===========================
   Safe counts helper
=========================== */
async function getSafeMarketVoteCounts(marketId) {
  const counts = await getMarketVoteCounts(marketId);
  if (!counts || Object.keys(counts).length === 0) return {};
  return counts;
}

/* ===========================
   Market vote counts
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

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue; // tie → skip
    counts[sides[0][0]] = (counts[sides[0][0]] || 0) + 1;
  }

  return counts;
}

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;

  console.log("Fetching trades for proxy wallet:", wallet.polymarket_proxy_wallet);
  const trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
  if (!trades.length) return;

  let insertedCount = 0;
  for (const trade of trades) {
    if (trade.proxyWallet && trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

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
      slug: trade.slug,
      side: String(trade.outcome).toUpperCase(),
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
      last_confidence_sent: "",
    });

    insertedCount++;
  }

  if (insertedCount > 0) console.log(`Inserted ${insertedCount} new trades for wallet ${wallet.id}`);
  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Resolve outcomes & handle losing streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
  if (!pending?.length) return;

  const marketIds = [...new Set(pending.map(s => s.market_id))];
  const markets = await Promise.all(marketIds.map(id => fetchMarket(id)));
  const marketMap = Object.fromEntries(markets.map(m => [m?.id, m]));

  let resolvedAny = false;
  for (const sig of pending) {
    const market = marketMap[sig.market_id];
    if (!market || !market.resolved) continue;

    const winningSide = String(market.winningOutcome || "").toUpperCase();
    if (!winningSide) continue;

    const result = sig.side === winningSide ? "WIN" : (market.cancelled ? "PUSH" : "LOSS");

    await supabase.from("signals").update({ outcome: result, outcome_at: new Date() }).eq("id", sig.id);

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
    await sendResultNotes(sig, result);
  }

  if (resolvedAny) {
    try {
      await sendMajoritySignals();
    } catch (err) {
      console.error("Error sending majority signals:", err.message);
    }
  }
}

/* ===========================
   Notes helper
=========================== */
async function sendResultNotes(sig, result) {
  const counts = await getSafeMarketVoteCounts(sig.market_id);
  const confidence = getMajorityConfidence(counts);

  const emoji = RESULT_EMOJIS[result] || "⚪";
  const eventUrl = `https://polymarket.com/events/${sig.slug}`;

  const rawNoteText = `Result Received: ${new Date().toLocaleString()}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${sig.side}
Confidence: ${confidence}
Outcome: ${sig.side}
Result: ${result} ${emoji}`;

  const noteText = toBlockquote(rawNoteText);

  await sendTelegram(noteText);

  const { data: notes } = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();
  let newContent = notes?.content || "";
  const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
  if (regex.test(newContent)) {
    newContent = newContent.replace(regex, noteText);
  } else {
    newContent += newContent ? `\n\n${noteText}` : noteText;
  }

  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
}

/* ===========================
   Send majority signals (updated to handle confidence changes and result)
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getSafeMarketVoteCounts(market_id);
    if (!Object.keys(counts).length) continue;

    const side = getMajoritySide(counts);
    if (!side) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    const { data: signals } = await supabase.from("signals").select("*").eq("market_id", market_id).eq("side", side).order("id", { ascending: true });
    if (!signals?.length) continue;

    // Send message if confidence changed or result updated or not sent yet
    const sig = signals[0];
    if (sig.last_confidence_sent !== confidence || sig.outcome !== "Pending" || !sig.signal_sent_at) {
      const eventUrl = `https://polymarket.com/events/${sig.slug}`;
      const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";

      const rawNoteText = `Signal Sent: ${new Date().toLocaleString()}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${sig.side}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"} ${emoji}`;

      const noteText = toBlockquote(rawNoteText);
      await sendTelegram(noteText);

      // update notes
      const { data: notes } = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();
      let newContent = notes?.content || "";
      const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
      if (regex.test(newContent)) {
        newContent = newContent.replace(regex, noteText);
      } else {
        newContent += newContent ? `\n\n${noteText}` : noteText;
      }
      await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");

      // mark all relevant signals as sent
      const sigIds = signals.map(x => x.id);
      await supabase.from("signals").update({ signal_sent_at: new Date(), last_confidence_sent: confidence }).in("id", sigIds);
    }
  }
}

/* ===========================
   Daily Summary
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const startYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

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

  let summaryText = `📊 DAILY SUMMARY (${now.toLocaleDateString()})\n`;
  summaryText += `All-time (W-L): ${allWins}-${allLosses}\n`;
  summaryText += `Yesterday (${yesterday.toLocaleDateString()}) (W-L): ${yWins}-${yLosses}\n`;
  summaryText += `Pending: ${pendingSignals.length}\n\n`;

  summaryText += `Yesterday's results:\n`;
  ySignals.forEach(s => {
    const emoji = RESULT_EMOJIS[s.outcome] || "⚪";
    summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${emoji}\n`;
  });

  summaryText += `\nPending picks:\n`;
  pendingSignals.forEach(s => {
    summaryText += `${s.signal} - ${s.side} - Pending ⚪\n`;
  });

  await sendTelegram(toBlockquote(summaryText));
  await supabase.from("notes").update({ content: toBlockquote(summaryText), public: true }).eq("slug", "polymarket-millionaires");
}

// Cron daily at 7am ET
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
      if (!wallets?.length) return;

      console.log("Wallets loaded:", wallets.length);

      await Promise.all(wallets.map(trackWallet));
      await updatePendingOutcomes();
    } catch (e) {
      console.error("Loop error:", e);
      await sendTelegram(`Tracker loop error: ${e.message}`);
    }
  }, POLL_INTERVAL);
}

main();
