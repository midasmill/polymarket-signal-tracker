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
  // 1. Fetch all signals for this market
  const { data: signals } = await supabase.from("signals").select("id, side").eq("market_id", marketId);
  if (!signals?.length) return null;

  const signalIds = signals.map(s => s.id);

  // 2. Fetch all signal_wallets for these signals
  const { data: sw } = await supabase
    .from("signal_wallets")
    .select("wallet_id, signal_id")
    .in("signal_id", signalIds);

  if (!sw?.length) return null;

  // 3. Map wallet_id -> side counts
  const perWallet = {};
  for (const row of sw) {
    const signal = signals.find(s => s.id === row.signal_id);
    if (!signal) continue;
    perWallet[row.wallet_id] ??= {};
    perWallet[row.wallet_id][signal.side] = (perWallet[row.wallet_id][signal.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue; // tie
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
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;

  const trades = await fetchLatestTrades(wallet);
  if (!trades.length) return;

  let insertedCount = 0;
  for (const trade of trades) {
    if (trade.proxyWallet && trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

    // Get or insert signal
    const { data: existingSignal } = await supabase
      .from("signals")
      .select("id")
      .eq("market_id", trade.conditionId)
      .maybeSingle();

    let signalId;
    if (!existingSignal) {
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
    } else {
      signalId = existingSignal.id;
    }

    // Check if wallet already has this trade
    const { data: existingSW } = await supabase
      .from("signal_wallets")
      .select("id")
      .eq("signal_id", signalId)
      .eq("wallet_id", wallet.id)
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();

    if (existingSW) continue;

    await supabase.from("signal_wallets").insert({
      signal_id: signalId,
      wallet_id: wallet.id,
      tx_hash: trade.transactionHash,
      wallet_count: 1,
    });

    insertedCount++;
  }

  if (insertedCount > 0) console.log(`Inserted ${insertedCount} new trades for wallet ${wallet.id}`);

  await supabase
    .from("wallets")
    .update({ last_checked: new Date(), last_fetch_timestamp: new Date() })
    .eq("id", wallet.id);
}

/* ===========================
   Tracker main loop
=========================== */
async function mainLoop() {
  console.log("🚀 Polymarket tracker live");

  while (true) {
    const start = Date.now();
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (wallets?.length) {
        await Promise.all(wallets.map(trackWallet));
      }
      // You can call updatePendingOutcomes() and sendMajoritySignals() here too
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
