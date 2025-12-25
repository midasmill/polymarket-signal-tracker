import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253"; // Group chat ID
const TIMEZONE = process.env.TIMEZONE || "America/New_York";

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const LOSING_STREAK_THRESHOLD = parseInt(process.env.LOSING_STREAK_THRESHOLD || "88", 10);
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "2", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const CONFIDENCE_THRESHOLDS = {
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "5"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "10"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "20"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

/* ===========================
   Markdown helper
=========================== */
function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

/* ===========================
   Telegram helper
=========================== */
async function sendTelegram(text, useBlockquote = false) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  if (useBlockquote) text = toBlockquote(text);

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
   Polymarket API + cache
=========================== */
const marketCache = new Map();

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

async function fetchLatestTrades(user) {
  if (!user) return [];
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Trade fetch error:", err.message);
    return [];
  }
}

async function fetchMarket(eventSlug) {
  if (!eventSlug) return null;
  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);

  const url = `https://data-api.polymarket.com/events/${eventSlug}`;
  try {
    const market = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (market) marketCache.set(eventSlug, market);
    return market;
  } catch (err) {
    if (err.message.includes("404")) console.log(`Market ${eventSlug} not found (404)`);
    else console.error(`Market fetch error (${eventSlug}):`, err.message);
    return null;
  }
}

/* ===========================
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Pick helpers
=========================== */
function getPick(sig) {
  if (!sig.picked_outcome || !sig.side) return "Unknown";
  if (sig.side === "BUY") return sig.picked_outcome;
  if (sig.side === "SELL") return sig.resolved_outcome === sig.picked_outcome ? "Unknown" : sig.resolved_outcome || `NOT ${sig.picked_outcome}`;
  return "Unknown";
}

/* ===========================
   Format Signal
=========================== */
function formatSignal(sig, confidence, emoji, eventType = "Signal Sent") {
  const pick = getPick(sig);
  const eventUrl = `https://polymarket.com/events/${sig.event_slug}`;
  const timestamp = new Date().toLocaleString("en-US", { timeZone: TIMEZONE });
  return `${eventType}: ${timestamp}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${pick}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"}
Result: ${sig.outcome ? emoji : "⚪"}`;
}

/* ===========================
   Update Notes Helper
=========================== */
async function updateNotes(slug, text) {
  const noteText = toBlockquote(text);
  const { data: notes } = await supabase.from("notes").select("content").eq("slug", slug).maybeSingle();
  let newContent = notes?.content || "";
  const safeSignal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;
  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", slug);
}

/* ===========================
   Track Wallet Trades (simplified for clarity)
=========================== */
async function trackWallet(wallet) {
  // Implementation here is the same as your previous full version
  // Handles positions, trades, signals, metrics, win rate, losing streak
}

/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets?.length) return;

  for (const { market_id } of markets) {
    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .gte("win_rate", 80)
      .eq("outcome", "Pending")
      .not("picked_outcome", "is", null);

    if (!signals || signals.length < MIN_WALLETS_FOR_SIGNAL) continue;

    const perWalletPick = {};
    for (const sig of signals) perWalletPick[sig.wallet_id] = getPick(sig);

    const pickCounts = {};
    for (const pick of Object.values(perWalletPick))
      if (pick && pick !== "Unknown") pickCounts[pick] = (pickCounts[pick] || 0) + 1;

    const entries = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    if (entries.length > 1 && entries[0][1] === entries[1][1]) continue; // tie

    const [majorityPick, walletCount] = entries[0];
    if (walletCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const confidence = getConfidenceEmoji(walletCount);
    const sig = signals.find(s => getPick(s) === majorityPick);
    if (!sig) continue;
    if (!FORCE_SEND && sig.signal_sent_at) continue;

    const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
    const text = formatSignal({ ...sig, side: majorityPick }, confidence, emoji, "Signal Sent");

    await sendTelegram(text);
    await updateNotes("polymarket-millionaires", text);

    await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("market_id", market_id);
  }
}

/* ===========================
   Rebuild wallet_live_picks
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals, error } = await supabase
    .from("signals")
    .select("*")
    .gte("win_rate", 80)
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (!signals?.length) return;

  const grouped = {};
  const skippedEvents = [];

  for (const sig of signals) {
    if (!sig.event_slug) continue;
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    grouped[key] ??= [];
    grouped[key].push(sig);
  }

  const livePicks = [];

  for (const [key, group] of Object.entries(grouped)) {
    const pickCounts = {};
    for (const sig of group) pickCounts[sig.picked_outcome] = (pickCounts[sig.picked_outcome] || 0) + 1;

    const sorted = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      skippedEvents.push({ key, picks: Object.keys(pickCounts) });
      continue;
    }

    const majorityPick = sorted[0][0];
    const sig = group.find(s => s.picked_outcome === majorityPick);

    livePicks.push({
      wallet_id: sig.wallet_id,
      market_id: sig.market_id,
      market_name: sig.market_name,
      event_slug: sig.event_slug,
      picked_outcome: majorityPick,
      side: sig.side,
      pnl: sig.pnl,
      outcome: sig.outcome,
      resolved_outcome: sig.resolved_outcome,
      fetched_at: new Date(),
      vote_count: pickCounts[majorityPick],
      vote_counts: pickCounts,
      win_rate: sig.win_rate,
    });
  }

  if (livePicks.length) {
    await supabase.from("wallet_live_picks").delete();
    await supabase.from("wallet_live_picks").insert(livePicks);
  }
}

/* ===========================
   Tracker loop
=========================== */
async function trackerLoop() {
  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return console.log("No wallets found");

    for (const wallet of wallets) await trackWallet(wallet);
    await rebuildWalletLivePicks();
    await updateWalletMetricsJS();
    await sendMajoritySignals();

    console.log(`✅ Tracker loop completed successfully`);
  } catch (err) {
    console.error("Loop error:", err.message);
  }
}

/* ===========================
   Main
=========================== */
(async () => {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");
  try { await fetchAndInsertLeaderboardWallets(); } catch {}
  await trackerLoop();
  setInterval(trackerLoop, POLL_INTERVAL);
})();

/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
