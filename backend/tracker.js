import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV & CONFIG
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253";
const TIMEZONE = process.env.TIMEZONE || "America/New_York";

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const WIN_RATE_THRESHOLD = parseInt(process.env.WIN_RATE_THRESHOLD || "0", 10);
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

/* ===========================
   Helpers
=========================== */
const marketCache = new Map();

function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

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

async function fetchMarket(eventSlug) {
  if (!eventSlug) return null;
  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${eventSlug}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const market = await res.json();
    marketCache.set(eventSlug, market);
    return market;
  } catch { return null; }
}

function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Wallet Helpers
=========================== */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  const { data: signals } = await supabase
    .from("signals")
    .select("picked_outcome, amount, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;

  const totals = {};
  for (const sig of signals) {
    if (!sig.picked_outcome) continue;
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + (sig.amount || 0);
  }

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) return null;

  const majorityPick = sorted[0][0];
  const majoritySignal = signals.find(s => s.picked_outcome === majorityPick);
  return majoritySignal?.outcome || null;
}

async function countWalletDailyLosses(walletId) {
  const start = new Date(); start.setHours(0,0,0,0);
  const end = new Date(); end.setHours(23,59,59,999);
  const { data: events } = await supabase
    .from("signals")
    .select("event_slug")
    .eq("wallet_id", walletId)
    .eq("outcome", "LOSS")
    .gte("outcome_at", start.toISOString())
    .lte("outcome_at", end.toISOString());
  if (!events?.length) return 0;

  let lossCount = 0;
  for (const eventSlug of [...new Set(events.map(e => e.event_slug).filter(Boolean))]) {
    if (await resolveWalletEventOutcome(walletId, eventSlug) === "LOSS") lossCount++;
  }
  return lossCount;
}

/* ===========================
   Wallet Live Picks Rebuild
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals } = await supabase.from("signals").select("*, wallets(id, win_rate)").eq("outcome", "Pending").not("picked_outcome", "is", null);
  if (!signals?.length) return;

  const walletEventMap = new Map();
  for (const sig of signals) {
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    const map = walletEventMap.get(key) || {};
    map[sig.picked_outcome] = (map[sig.picked_outcome] || 0) + (sig.amount || 0);
    walletEventMap.set(key, map);
  }

  const livePicksMap = new Map();
  for (const [key, totals] of walletEventMap.entries()) {
    const sorted = Object.entries(totals).sort((a,b)=>b[1]-a[1]);
    if (!sorted.length || (sorted.length>1 && sorted[0][1]===sorted[1][1])) continue;
    const majorityOutcome = sorted[0][0];
    const [walletId, eventSlug] = key.split("||");
    const sig = signals.find(s=>s.wallet_id==walletId && s.event_slug===eventSlug && s.picked_outcome===majorityOutcome);
    if (!sig) continue;

    const liveKey = `${sig.market_id}||${majorityOutcome}`;
    const existing = livePicksMap.get(liveKey) || { wallets: [], vote_count: 0 };
    existing.wallets.push(sig.wallet_id);
    existing.vote_count++;
    existing.market_id = sig.market_id;
    existing.market_name = sig.market_name;
    existing.event_slug = sig.event_slug;
    livePicksMap.set(liveKey, existing);
  }

  const finalLivePicks = Array.from(livePicksMap.values()).map(p=>({...p, fetched_at: new Date()}));
  if (finalLivePicks.length) await supabase.from("wallet_live_picks").upsert(finalLivePicks,{onConflict:["market_id","picked_outcome"]});
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return;

    await Promise.allSettled(wallets.map(trackWallet));
    await rebuildWalletLivePicks();
    await processAndSendSignals();
    await updateWalletMetricsJS();

  } catch (err) { console.error("Tracker loop failed:", err.message); }
  finally { isTrackerRunning = false; }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");
  await fetchAndInsertLeaderboardWallets().catch(err=>console.error(err));
  await trackerLoop();
  setInterval(trackerLoop, POLL_INTERVAL);

  cron.schedule("0 7 * * *", async ()=>{
    console.log("📅 Daily cron running...");
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();
  }, { timezone: TIMEZONE });

  setInterval(()=>console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

  const PORT = process.env.PORT || 3000;
  http.createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("Polymarket tracker running\n");}).listen(PORT,()=>console.log(`Tracker listening on port ${PORT}`));
}

main();
