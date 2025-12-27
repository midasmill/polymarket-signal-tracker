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
    .select("picked_outcome, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;

  // Ignore wallets with both YES and NO for the same event
  const pickedOutcomes = new Set(signals.map(s => s.picked_outcome).filter(Boolean));
  if (pickedOutcomes.size > 1) return null;

  // Count one vote per picked_outcome
  const totals = {};
  for (const sig of signals) {
    if (!sig.picked_outcome) continue;
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + 1;
  }

  // Determine majority pick
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) return null;

  const majorityPick = sorted[0][0];
  const majoritySignal = signals.find(s => s.picked_outcome === majorityPick);
  return majoritySignal?.outcome || null;
}

/* ===========================
   Count Daily Wallet Losses
=========================== */
async function countWalletDailyLosses(walletId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);

  const { data: events } = await supabase
    .from("signals")
    .select("event_slug")
    .eq("wallet_id", walletId)
    .eq("outcome", "LOSS")
    .gte("outcome_at", start.toISOString())
    .lte("outcome_at", end.toISOString());

  if (!events?.length) return 0;

  let lossCount = 0;
  const uniqueEvents = [...new Set(events.map(e => e.event_slug).filter(Boolean))];

  for (const eventSlug of uniqueEvents) {
    const outcome = await resolveWalletEventOutcome(walletId, eventSlug);
    if (outcome === "LOSS") lossCount++;
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
async function fetchWalletActivities(proxyWallet, retries = 3) {
  if (!proxyWallet) return [];

  const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });

      if (res.status === 404) {
        console.warn(`❌ Activity fetch 404 for wallet ${proxyWallet}`);
        return [];
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data;

    } catch (err) {
      console.error(`❌ Activity fetch attempt ${attempt} failed for wallet ${proxyWallet}: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  console.error(`❌ Activity fetch failed after ${retries} attempts for wallet ${proxyWallet}`);
  return [];
}

/* ===========================
   Track Wallet (Enhanced)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`[TRACK] Wallet ${wallet.id} has no proxy, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
  }

  // 1️⃣ Fetch wallet activities
  let positions = [];
  try {
    positions = await fetchWalletPositions(proxyWallet);
  } catch (err) {
    console.error(`❌ Activity fetch failed for ${proxyWallet}:`, err.message);
    return;
  }

  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals once
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

    // 3️⃣ Skip if wallet already has a signal for this event
    if (existingEvents.has(eventSlug)) continue;

    // 4️⃣ Fetch market metadata
    const market = await fetchMarket(eventSlug);
    if (!market) continue; // skip closed / invalid markets

    // 5️⃣ Determine picked_outcome based on market type
    let pickedOutcome;
    const side = pos.side?.toUpperCase();
    const title = pos.title || "";

    if (market?.outcomes?.length === 2 && ["YES","NO"].includes(market.outcomes[0].name.toUpperCase())) {
      // YES/NO market
      pickedOutcome = side === "BUY" ? "YES" : "NO";
    } else if (title.includes("O/U") || title.match(/over/i) || title.match(/under/i)) {
      // Over/Under market
      if (side === "BUY") pickedOutcome = title.toLowerCase().includes("over") ? "OVER" : "UNDER";
      else if (side === "SELL") pickedOutcome = title.toLowerCase().includes("over") ? "UNDER" : "OVER";
    } else if (market?.outcomes?.length > 1) {
      // Team-based / multi-outcome market
      // Map side to first/second outcome
      pickedOutcome = side === "BUY" ? market.outcomes[0].name : market.outcomes[1].name;
    } else {
      // fallback: use side directly
      pickedOutcome = side;
    }

    // 6️⃣ Generate synthetic unique tx
    const syntheticTx = [proxyWallet, pos.asset, pos.timestamp, pos.amount].join("-");

    if (existingTxs.has(syntheticTx)) continue;

    // 7️⃣ Push new signal
    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,
      side: pos.side || null,
      picked_outcome: pickedOutcome,
      tx_hash: syntheticTx,
      pnl: pos.cashPnl ?? null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(pos.timestamp ? pos.timestamp * 1000 : Date.now()),
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null
    });
  }

  // 8️⃣ Insert new signals
  if (!newSignals.length) return;

  const { error } = await supabase
    .from("signals")
    .insert(newSignals);

  if (error) {
    console.error(`❌ Failed inserting/upserting signals for wallet ${wallet.id}:`, error.message);
  } else {
    console.log(`✅ Inserted ${newSignals.length} new signal(s) for wallet ${wallet.id}`);
  }
}

/* ===========================
   Fetch Wallet Positions (DATA-API)
=========================== */
async function fetchWalletPositions(proxyWallet) {
  if (!proxyWallet) throw new Error("Missing proxyWallet");

  try {
    const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    });

    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    // Map API response to your expected "position" format
    return data.map(item => ({
      asset: item.asset || "",
      timestamp: item.timestamp || Date.now() / 1000,
      conditionId: item.conditionId || null,
      title: item.title || "",
      slug: item.slug || null,
      eventSlug: item.eventSlug || null,
      side: item.side || "",        // can be BUY/SELL or other strings
      cashPnl: item.usdcSize ?? null,
      amount: item.size ?? null
    }));

  } catch (err) {
    console.error(`❌ Activity fetch failed (fetchWalletPositions) for ${proxyWallet}:`, err.message);
    return [];
  }
}

/* ===========================
   Wallet Live Picks Rebuild (Enhanced)
=========================== */
async function rebuildWalletLivePicks() {
  // 1️⃣ Fetch all pending signals
  const { data: signals } = await supabase
    .from("signals")
    .select("*, wallets(id, win_rate)")
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (!signals?.length) return;

  // 2️⃣ Map market_id + picked_outcome → aggregated data
  const livePicksMap = new Map();

  for (const sig of signals) {
    const key = `${sig.market_id}||${sig.picked_outcome}`;
    
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, {
        wallets: [],
        wallet_set: new Set(),
        vote_count: 0,
        market_id: sig.market_id,
        market_name: sig.market_name,
        event_slug: sig.event_slug,
        picked_outcome: sig.picked_outcome,
        side: sig.side || null,
        pnl: 0,
        confidence: 1
      });
    }

    const entry = livePicksMap.get(key);

    if (!entry.wallet_set.has(sig.wallet_id)) {
      entry.wallets.push(sig.wallet_id);
      entry.wallet_set.add(sig.wallet_id);
      entry.vote_count++;
      entry.pnl += Number(sig.pnl || 0);
    }
  }

  // 3️⃣ Prepare final live picks array
  const finalLivePicks = Array.from(livePicksMap.values()).map(p => ({
    wallet_id: p.wallets[0] || null, // main wallet
    wallets: p.wallets,
    vote_count: p.vote_count,
    market_id: p.market_id,
    market_name: p.market_name,
    event_slug: p.event_slug,
    picked_outcome: p.picked_outcome,
    side: p.side,
    pnl: p.pnl,
    confidence: p.vote_count, // can map to ⭐ later
    fetched_at: new Date()
  }));

  if (!finalLivePicks.length) return;

  // 4️⃣ Upsert live picks with unique constraint
  const { error } = await supabase
    .from("wallet_live_picks")
    .upsert(finalLivePicks, { onConflict: ["market_id", "picked_outcome"] });

  if (error) {
    console.error("❌ Failed upserting wallet live picks:", error.message);
  } else {
    console.log(`✅ Rebuilt wallet_live_picks: ${finalLivePicks.length} entries`);
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
    // Fetch resolved signals for this wallet
    const { data: resolvedSignals } = await supabase
      .from("signals")
      .select("event_slug, picked_outcome, outcome")
      .eq("wallet_id", wallet.id)
      .in("outcome", ["WIN", "LOSS"]);

    if (!resolvedSignals?.length) continue;

    // Group signals by event
    const eventsMap = new Map();
    for (const sig of resolvedSignals) {
      if (!sig.event_slug) continue;
      if (!eventsMap.has(sig.event_slug)) eventsMap.set(sig.event_slug, []);
      eventsMap.get(sig.event_slug).push(sig);
    }

    let wins = 0, losses = 0;

    for (const [eventSlug, signalsForEvent] of eventsMap.entries()) {
      // Skip wallets that have both sides for this event
      const pickedOutcomes = new Set(signalsForEvent.map(s => s.picked_outcome).filter(Boolean));
      if (pickedOutcomes.size > 1) continue;

      // Determine majority outcome for this wallet/event
      const outcome = signalsForEvent[0]?.outcome || null;
      if (outcome === "WIN") wins++;
      if (outcome === "LOSS") losses++;
    }

    const total = wins + losses;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

    // Count daily losses safely
    const dailyLosses = await countWalletDailyLosses(wallet.id);
    const shouldPause = dailyLosses >= 3;

    await supabase
      .from("wallets")
      .update({
        win_rate: winRate,
        paused: shouldPause ? true : wallet.paused,
        last_checked: new Date()
      })
      .eq("id", wallet.id);
  }
}

/* ===========================
   Signal Processing + Telegram Update (Enhanced)
=========================== */
async function processAndSendSignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks } = await supabase
    .from("wallet_live_picks")
    .select("*");

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
    const walletCount = picks[0].vote_count || picks.length;
    const confidence = getConfidenceEmoji(walletCount); // ⭐ based on thresholds
    if (!confidence) continue; // skip if below threshold

    const sig = picks[0]; // representative pick
    const text = `📊 Market Event: ${sig.market_name}
Prediction: ${sig.picked_outcome}
Confidence: ${confidence}
Signal Sent: ${new Date().toLocaleString("en-US",{timeZone:TIMEZONE})}`;

    signalsToSend.push({
      market_id: sig.market_id,
      picked_outcome: sig.picked_outcome,
      text,
      wallet_ids: sig.wallets
    });

    // 4️⃣ Mark signals as sent
    await supabase
      .from("signals")
      .update({ signal_sent_at: new Date() })
      .in("wallet_id", sig.wallets)
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }

  // 5️⃣ Send signals to Telegram
  for (const sig of signalsToSend) {
    try {
      await sendTelegram(sig.text);
      await updateNotes("polymarket-millionaires", sig.text); // blockquote format
      console.log(`✅ Sent signal for market ${sig.market_id}`);
    } catch (err) {
      console.error(`❌ Failed to send signal for market ${sig.market_id}:`, err.message);
    }
  }
}

/* ===========================
   Tracker Loop (Patched)
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return;

    // Track all wallets
    await Promise.allSettled(wallets.map(trackWallet));

    // Rebuild live picks safely
    await rebuildWalletLivePicks();

    // Process and send signals
    await processAndSendSignals();

    // Update wallet metrics (win_rate, paused)
    await updateWalletMetricsJS();
  } catch (err) {
    console.error("Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
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
