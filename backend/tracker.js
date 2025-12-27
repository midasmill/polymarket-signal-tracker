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
   Fetch Leaderboard Wallets (with PnL & volume filters)
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","SPORTS"];
  const periods = ["DAY","WEEK"];
  for (const cat of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${cat}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl < 1000000 || entry.vol >= 2 * entry.pnl) continue;

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();
          if (existing) continue;

          const { data: insertedWallet } = await supabase
            .from("wallets")
            .insert({
              polymarket_proxy_wallet: proxyWallet,
              polymarket_username: entry.userName || null,
              last_checked: new Date(),
              paused: false,
              losing_streak: 0,
              win_rate: 0,
              force_fetch: true,
            })
            .select("*")
            .single();

          // Track wallet immediately
          await trackWallet(insertedWallet);
        }

      } catch (err) {
        console.error(`Leaderboard fetch failed (${cat}/${period}):`, err.message);
      }
    }
  }
}

/* ===========================
   Fetch Wallet Activity (DATA-API)
=========================== */
async function fetchWalletPositions(proxyWallet) {
  try {
    const url =
      `https://data-api.polymarket.com/activity` +
      `?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      console.error(`❌ Activity fetch failed (${res.status}) for ${proxyWallet}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter(a =>
        a.type === "TRADE" &&           // only real trades
        a.side &&                       // BUY / SELL
        a.conditionId &&
        (a.eventSlug || a.slug)
      )
      .map(a => ({
        asset: a.asset,                        // outcome token
        conditionId: a.conditionId,            // market id
        eventSlug: a.eventSlug || a.slug,
        side: a.side,                          // BUY / SELL
        amount: Number(a.size || a.usdcSize) || 0,
        cashPnl: null,                         // not in activity
        timestamp: a.timestamp,                // already seconds
        title: a.title
      }));

  } catch (err) {
    console.error("❌ fetchWalletPositions error:", err.message);
    return [];
  }
}

/* ===========================
   Track Wallet
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`Wallet ${wallet.id} has no proxy, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // Fetch positions from Polymarket
const positions = await fetchWalletPositions(proxyWallet);

console.log(
  `[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`
);

if (!positions?.length) return;

  // Fetch existing signals ONCE
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("tx_hash, event_slug")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const existingEvents = new Set(existingSignals.map(s => s.event_slug));

  const newSignals = [];

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    // 1️⃣ Enforce 1 signal per wallet per event
    if (existingEvents.has(eventSlug)) continue;

    // 2️⃣ Determine side
    let pickedOutcome;
    if (pos.side?.toUpperCase() === "BUY") pickedOutcome = "YES";
    else if (pos.side?.toUpperCase() === "SELL") pickedOutcome = "NO";
    else continue;

    // 3️⃣ Generate a REAL unique trade id
    const syntheticTx = [
      proxyWallet,
      pos.asset,
      pos.timestamp,
      pos.amount
    ].join("-");

    if (existingTxs.has(syntheticTx)) continue;

    // 4️⃣ Fetch market & skip closed
    const market = await fetchMarket(eventSlug);
    if (!market) continue;

    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,

      side: pos.side.toUpperCase(),
      picked_outcome: pickedOutcome,

      tx_hash: syntheticTx,

      pnl: pos.cashPnl ?? null,
      amount: pos.amount || 0,

      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,

      win_rate: wallet.win_rate,

      created_at: new Date(
        pos.timestamp ? pos.timestamp * 1000 : Date.now()
      ),

      event_start_at: market.eventStartAt
        ? new Date(market.eventStartAt)
        : null
    });
  }

  if (!newSignals.length) return;

  const { error } = await supabase
    .from("signals")
    .insert(newSignals);

  if (error) {
    console.error(
      `❌ Failed inserting signals for wallet ${wallet.id}:`,
      error.message
    );
  } else {
    console.log(
      `✅ Inserted ${newSignals.length} new signal(s) for wallet ${wallet.id}`
    );  
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
   Signal Processing + Notes Update
=========================== */
async function processAndSendSignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks } = await supabase.from("wallet_live_picks").select("*");
  if (!livePicks?.length) return;

  // 2️⃣ Group by market_id + picked_outcome
  const grouped = new Map();
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pick);
  }

  const signalsToSend = [];

  // 3️⃣ Prepare signals
  for (const [key, picks] of grouped.entries()) {
    const walletCount = picks.length;
    const confidence = getConfidenceEmoji(walletCount);
    if (!confidence) continue; // skip if below threshold

    const sig = picks[0]; // representative pick
    const text = `📊 Market Event: ${sig.market_name}
Prediction: ${sig.picked_outcome}
Confidence: ${confidence}
Signal Sent: ${new Date().toLocaleString("en-US",{timeZone:TIMEZONE})}`;

    signalsToSend.push({ market_id: sig.market_id, picked_outcome: sig.picked_outcome, text });

    // mark signals as sent
    await supabase
      .from("signals")
      .update({ signal_sent_at: new Date() })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }

  // 4️⃣ Send signals & update Notes
  for (const sig of signalsToSend) {
    try {
      await sendTelegram(sig.text);
      await updateNotes("polymarket-millionaires", sig.text); // line breaks included
      console.log(`✅ Sent signal for market ${sig.market_id}`);
    } catch (err) {
      console.error(`Failed to send signal for market ${sig.market_id}:`, err.message);
    }
  }
}

/* ===========================
   Notes Update Helper (new lines)
=========================== */
async function updateNotes(slug, text) {
  const noteText = text
    .split("\n")
    .map(line => `> ${line}`) // blockquote for readability
    .join("\n");

  const { data: notes } = await supabase.from("notes").select("content").eq("slug", slug).maybeSingle();
  let newContent = notes?.content || "";

  // append new signal with a line break
  newContent += newContent ? `\n\n${noteText}` : noteText;

  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", slug);
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
    await fetchWalletPositions();
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
