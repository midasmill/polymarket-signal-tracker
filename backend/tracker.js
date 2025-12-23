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
const FORCE_SEND = process.env.FORCE_SEND === "true";

const CONFIDENCE_THRESHOLDS = {
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "15"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "25"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "35"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Helpers
=========================== */
function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "MarkdownV2" }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

/* ===========================
   Polymarket API + cache
=========================== */
const marketCache = new Map();
const MARKET_CACHE_TTL = 1000 * 60 * 60; // 1 hour

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

async function fetchLatestTrades(wallet) {
  const lastFetch = wallet.last_fetch_timestamp || 0;
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${wallet.polymarket_proxy_wallet}&since=${Math.floor(new Date(lastFetch).getTime() / 1000)}`;
  try {
    const data = await fetchWithRetry(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`Trade fetch error for wallet ${wallet.id}:`, err.message);
    return [];
  }
}

async function fetchMarket(marketId) {
  const cached = marketCache.get(marketId);
  if (cached && Date.now() - cached.timestamp < MARKET_CACHE_TTL) return cached.data;

  try {
    const market = await fetchWithRetry(`https://polymarket.com/api/markets/${marketId}`);
    if (market) marketCache.set(marketId, { data: market, timestamp: Date.now() });
    return market;
  } catch (err) {
    console.error("Market fetch error:", err.message);
    return null;
  }
}

/* ===========================
   Confidence
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

async function getMarketVoteCounts(marketId) {
  const { data: votes } = await supabase
    .from("signal_wallets as sw")
    .select("wallet_id, signals(side)")
    .eq("signals.market_id", marketId)
    .limit(1000);

  if (!votes?.length) return null;

  const perWallet = {};
  for (const v of votes) {
    perWallet[v.wallet_id] ??= {};
    perWallet[v.wallet_id][v.signals.side] = (perWallet[v.wallet_id][v.signals.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;
    counts[sorted[0][0]] = (counts[sorted[0][0]] || 0) + 1;
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
  return sorted[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "";
  return getConfidenceEmoji(Math.max(...Object.values(counts)));
}

/* ===========================
   Notes helper
=========================== */
async function updateNotes(noteText, sigSignal) {
  const { data: notes } = await supabase
    .from("notes")
    .select("id, content")
    .eq("slug", "polymarket-millionaires")
    .maybeSingle();

  let content = notes?.content || "";
  const safeSignal = escapeMarkdown(sigSignal);
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
  if (regex.test(content)) content = content.replace(regex, noteText);
  else content += content ? `\n\n${noteText}` : noteText;

  await supabase.from("notes").update({ content, public: true }).eq("slug", "polymarket-millionaires");
}

/* ===========================
   Track Wallet Trades with retry
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;

  const trades = await fetchLatestTrades(wallet);
  if (!trades.length) return;

  let insertedCount = 0;

  for (const trade of trades) {
    if (trade.proxyWallet && trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

    let success = false;
    let attempts = 0;
    const maxRetries = 3;

    while (!success && attempts < maxRetries) {
      try {
        attempts++;

        // Check if already exists
        const { data: existingSW } = await supabase
          .from("signal_wallets")
          .select("id")
          .eq("wallet_id", wallet.id)
          .eq("tx_hash", trade.transactionHash)
          .maybeSingle();
        if (existingSW) break;

        // Get or insert signal
        let signalId;
        const { data: existingSignal } = await supabase
          .from("signals")
          .select("id")
          .eq("market_id", trade.conditionId)
          .maybeSingle();

        if (existingSignal) signalId = existingSignal.id;
        else {
          const { data: newSignal } = await supabase
            .from("signals")
            .insert({
              wallet_count: 1,
              market_id: trade.conditionId,
              market_name: trade.title,
              slug: trade.slug,
              signal: trade.title,
              side: String(trade.outcome).toUpperCase(),
              outcome: "Pending",
              created_at: new Date(trade.timestamp * 1000),
            })
            .select("id")
            .single();
          signalId = newSignal.id;
        }

        // Insert into signal_wallets
        await supabase.from("signal_wallets").insert({
          signal_id: signalId,
          wallet_id: wallet.id,
          tx_hash: trade.transactionHash,
          wallet_count: 1,
        });

        insertedCount++;
        success = true;
      } catch (err) {
        console.error(`Failed to insert signal for trade (attempt ${attempts}):`, trade, err.message);
        if (attempts < maxRetries) await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  if (insertedCount > 0) console.log(`Inserted ${insertedCount} new trades for wallet ${wallet.id}`);

  await supabase
    .from("wallets")
    .update({ last_checked: new Date(), last_fetch_timestamp: new Date() })
    .eq("id", wallet.id);
}

/* ===========================
   Resolve outcomes & losing streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
  if (!pending?.length) return;

  const marketIds = [...new Set(pending.map(s => s.market_id))];
  const markets = await Promise.all(marketIds.map(id => fetchMarket(id)));
  const marketMap = Object.fromEntries(markets.map(m => [m?.id, m]));

  for (const sig of pending) {
    try {
      const market = marketMap[sig.market_id];
      if (!market || !market.resolved) continue;

      const winningSide = String(market.winningOutcome || "").toUpperCase();
      if (!winningSide) continue;

      const result = sig.side === winningSide ? "WIN" : (market.cancelled ? "PUSH" : "LOSS");
      await supabase.from("signals").update({ outcome: result, outcome_at: new Date() }).eq("id", sig.id);

      // Losing streak
      const { data: wallet } = await supabase.from("wallets").select("*").eq("id", sig.wallet_id).maybeSingle();
      if (!wallet) continue;

      if (result === "LOSS") {
        const streak = (wallet.losing_streak || 0) + 1;
        await supabase.from("wallets").update({ losing_streak: streak }).eq("id", wallet.id);
        if (streak >= LOSING_STREAK_THRESHOLD) {
          await supabase.from("wallets").update({ paused: true }).eq("id", wallet.id);
          await sendTelegram(`Wallet paused due to losing streak:\nWallet ID: ${wallet.id}\nLosses: ${streak}`);
        }
      }

      await sendResultNotes(sig, result);
    } catch (err) {
      console.error("Error resolving signal:", err.message);
    }
  }

  await sendMajoritySignals();
}

/* ===========================
   Send notes & signals
=========================== */
async function sendResultNotes(sig, result) {
  const counts = await getMarketVoteCounts(sig.market_id);
  const confidence = getMajorityConfidence(counts);
  const emoji = RESULT_EMOJIS[result] || "⚪";
  const eventUrl = `https://polymarket.com/events/${sig.slug}`;

  const rawNoteText = `Result Received: ${new Date().toLocaleString()}
Market Event: [${escapeMarkdown(sig.signal)}](${escapeMarkdown(eventUrl)})
Prediction: ${escapeMarkdown(sig.side)}
Confidence: ${confidence}
Outcome: ${escapeMarkdown(sig.side)}
Result: ${result} ${emoji}`;

  const noteText = toBlockquote(rawNoteText);

  await sendTelegram(noteText);
  await updateNotes(noteText, sig.signal);
}

async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    try {
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
        const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";

        const rawNoteText = `Signal Sent: ${new Date().toLocaleString()}
Market Event: [${escapeMarkdown(sig.signal)}](${escapeMarkdown(eventUrl)})
Prediction: ${escapeMarkdown(sig.side)}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"} ${emoji}`;

        const noteText = toBlockquote(rawNoteText);

        await sendTelegram(noteText);
        await updateNotes(noteText, sig.signal);

        await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("id", sig.id);
      }
    } catch (err) {
      console.error("Error sending majority signals:", err.message);
    }
  }
}

/* ===========================
   Daily Summary
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  const startYesterday = new Date(yesterday);
  startYesterday.setHours(0, 0, 0, 0);
  const endYesterday = new Date(yesterday);
  endYesterday.setHours(23, 59, 59, 999);

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

  const msg = toBlockquote(summaryText);
  await sendTelegram(msg);
  await supabase.from("notes").update({ content: msg, public: true }).eq("slug", "polymarket-millionaires");
}

/* ===========================
   Cron for daily summary
=========================== */
cron.schedule("0 7 * * *", () => {
  console.log("Sending daily summary...");
  sendDailySummary();
}, { timezone: TIMEZONE });

/* ===========================
   Main async loop
=========================== */
async function mainLoop() {
  console.log("🚀 Polymarket tracker live");

  while (true) {
    const start = Date.now();
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (wallets?.length) {
        await Promise.all(wallets.map(trackWallet));
        await updatePendingOutcomes();
      }
    } catch (err) {
      console.error("Tracker loop error:", err);
      await sendTelegram(`Tracker loop error: ${err.message}`);
    }

    const elapsed = Date.now() - start;
    const wait = Math.max(POLL_INTERVAL - elapsed, 1000);
    await new Promise(r => setTimeout(r, wait));
  }
}

mainLoop();
