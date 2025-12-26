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
    // Skip closed markets
    if (market.closed) return null;
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
   Fetch Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","SPORTS"];
  const periods = ["DAY","WEEK","MONTH","ALL"];
  for (const cat of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${cat}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet) continue;

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();
          if (existing) continue;

          const { data: insertedWallet } = await supabase
            .from("wallets")
            .insert({ polymarket_proxy_wallet: proxyWallet, polymarket_username: entry.userName || null, last_checked: new Date(), paused: false, losing_streak: 0, win_rate: 0, force_fetch: true })
            .select("*").single();

          // Track wallet immediately
          await trackWallet(insertedWallet);
        }

      } catch (err) { console.error(`Leaderboard fetch failed (${cat}/${period}):`, err.message); }
    }
  }
}

/* ===========================
   Track Wallet
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) return console.warn(`Wallet ${wallet.id} has no proxy, skipping`);

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
  }

  // Fetch positions
  const positions = await fetchWalletPositions(proxyWallet);
  if (!positions.length) return;

  const allNewSignals = [];
  const existingSignalsRes = await supabase.from("signals").select("tx_hash, event_slug, picked_outcome").eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignalsRes.data.map(s => s.tx_hash));

  for (const pos of positions) {
    if (existingTxs.has(pos.asset)) continue;

    const market = await fetchMarket(pos.eventSlug || pos.slug);
    if (!market) continue; // skip closed markets

    // Reduce picks to 1 YES / 1 NO max
    let outcomePick;
    if (pos.side?.toUpperCase() === "BUY") outcomePick = "YES";
    else if (pos.side?.toUpperCase() === "SELL") outcomePick = "NO";
    else continue;

    // Keep only first YES or NO per event
    const existingEventSignal = allNewSignals.find(s => s.event_slug === pos.eventSlug);
    if (existingEventSignal) {
      // Already have one YES and/or NO
      if (existingEventSignal.picked_outcome === outcomePick) continue; // skip duplicates
      // Add opposite pick if only one exists → creates tie
      existingEventSignal.picked_outcome = "TIE";
      continue;
    }

    allNewSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: pos.eventSlug || pos.slug,
      side: pos.side?.toUpperCase() || "BUY",
      picked_outcome: outcomePick,
      tx_hash: pos.asset,
      pnl: pos.cashPnl ?? null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      amount: pos.amount || 0,
      created_at: new Date(pos.timestamp * 1000 || Date.now()),
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null,
    });
  }

  if (allNewSignals.length) {
    await supabase.from("signals").insert(allNewSignals);
    console.log(`Inserted ${allNewSignals.length} new signals for wallet ${wallet.id}`);
  }
}

/* ===========================
   Wallet Live Picks Rebuild
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*, wallets(id, win_rate)")
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (!signals?.length) return;

  const livePicksMap = new Map();

  for (const sig of signals) {
    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, { wallets: [], vote_count: 0, market_id: sig.market_id, market_name: sig.market_name, event_slug: sig.event_slug });
    }

    const entry = livePicksMap.get(key);
    entry.wallets.push(sig.wallet_id);
    entry.vote_count++;
  }

  const finalLivePicks = Array.from(livePicksMap.values()).map(p => ({ ...p, fetched_at: new Date() }));
  if (finalLivePicks.length) {
    await supabase.from("wallet_live_picks").upsert(finalLivePicks, { onConflict: ["market_id", "picked_outcome"] });
  }
}

/* ===========================
   Signal Processing
=========================== */
async function processAndSendSignals() {
  const { data: livePicks } = await supabase.from("wallet_live_picks").select("*");
  if (!livePicks?.length) return;

  const grouped = new Map();
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pick);
  }

  const signalsToSend = [];

  for (const [key, picks] of grouped.entries()) {
    const walletCount = picks.length;
    const confidence = getConfidenceEmoji(walletCount);
    if (!confidence) continue;
    const sig = picks[0];

    signalsToSend.push({
      market_id: sig.market_id,
      picked_outcome: sig.picked_outcome,
      wallets: picks.map(p=>p.wallets).flat(),
      confidence,
      text: `📊 Market Event: ${sig.market_name}\nPrediction: ${sig.picked_outcome}\nConfidence: ${confidence}\nSignal Sent: ${new Date().toLocaleString("en-US",{timeZone:TIMEZONE})}`,
    });

    await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("market_id",sig.market_id).eq("picked_outcome",sig.picked_outcome);
  }

  for (const sig of signalsToSend) {
    await sendTelegram(sig.text);
  }
}

/* ===========================
   Wallet Metrics Update
=========================== */
async function updateWalletMetricsJS() {
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  for (const wallet of wallets) {
    const { data: resolvedSignals } = await supabase.from("signals").select("event_slug,outcome").eq("wallet_id",wallet.id).in("outcome",["WIN","LOSS"]);
    const uniqueEvents = [...new Set(resolvedSignals?.map(s=>s.event_slug).filter(Boolean))];

    let wins=0, losses=0;
    for (const eventSlug of uniqueEvents) {
      const result = await resolveWalletEventOutcome(wallet.id,eventSlug);
      if (result==="WIN") wins++;
      if (result==="LOSS") losses++;
    }

    const total = wins+losses;
    const winRate = total>0 ? Math.round((wins/total)*100) : 0;
    const dailyLosses = await countWalletDailyLosses(wallet.id);
    const shouldPause = dailyLosses>=3;

    await supabase.from("wallets").update({ win_rate: winRate, paused: shouldPause?true:wallet.paused, last_checked: new Date() }).eq("id", wallet.id);
  }
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning=false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning=true;

  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return;

    await Promise.allSettled(wallets.map(trackWallet));
    await rebuildWalletLivePicks();
    await processAndSendSignals();
    await updateWalletMetricsJS();

  } catch (err) { console.error("Tracker loop failed:", err.message); }
  finally { isTrackerRunning=false; }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");
  await fetchAndInsertLeaderboardWallets().catch(err=>console.error(err));
  await trackerLoop();
  setInterval(trackerLoop,POLL_INTERVAL);

  cron.schedule("0 7 * * *", async ()=>{
    console.log("📅 Daily cron running...");
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();
  },{timezone:TIMEZONE});

  setInterval(()=>console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`),60_000);

  const PORT = process.env.PORT||3000;
  http.createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end("Polymarket tracker running\n");}).listen(PORT,()=>console.log(`Tracker listening on port ${PORT}`));
}

main();
