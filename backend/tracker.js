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
  "⭐": 2,
  "⭐⭐": 5,
  "⭐⭐⭐": 10,
  "⭐⭐⭐⭐": 20,
  "⭐⭐⭐⭐⭐": 50
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
  if (useBlockquote) {
    text = text.split("\n").map(line => `> ${line}`).join("\n"); // only apply if true
  }
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
   Resolve Wallet Event Outcome
=========================== */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  const { data: signals } = await supabase
    .from("signals")
    .select("picked_outcome, outcome")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;

  // Count total per picked_outcome
const totals = {};
for (const sig of signals) {
  if (!sig.picked_outcome) continue;
  totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + 1;
}

  // If wallet has picks on both sides, ignore this event
  if (Object.keys(totals).length > 1) return null;

  // Otherwise, return the single outcome
  const majorityPick = Object.keys(totals)[0];
  const majoritySignal = signals.find(s => s.picked_outcome === majorityPick);
  return majoritySignal?.outcome || null;
}

/* ===========================
   Resolve Markets
=========================== */
async function resolveMarkets() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending")
    .not("event_slug", "is", null);

  if (!pending?.length) return;

  for (const sig of pending) {
    const market = await fetchMarket(sig.event_slug);
    if (!market?.resolved) continue;

    const winningOutcome = market.outcome;
    const result = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome,
        outcome_at: new Date()
      })
      .eq("id", sig.id);

    await supabase
      .from("wallet_live_picks")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome
      })
      .eq("market_id", sig.market_id)
      .eq("picked_outcome", sig.picked_outcome);
  }
}

/* ===========================
   Count Wallet Daily Losses
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
    const result = await resolveWalletEventOutcome(walletId, eventSlug);
    if (result === "LOSS") lossCount++;
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
   Track Wallet (FIXED: insert signals even if market not found)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.log(`[SKIP] Wallet ${wallet.id} has no proxyWallet`);
    return;
  }

  console.log(`[TRACK] Processing wallet ${wallet.id} (${proxyWallet})`);

  // Auto-unpause if paused and win_rate >= 80
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
    console.log(`[AUTO-UNPAUSE] Wallet ${wallet.id} paused -> false (win_rate ${wallet.win_rate})`);
  }

  // 1️⃣ Fetch positions
  const positions = await fetchWalletPositions(proxyWallet);
  if (!positions?.length) {
    console.log(`[SKIP] Wallet ${wallet.id} has no positions`);
    return;
  }
  console.log(`[POSITIONS] Wallet ${wallet.id} fetched ${positions.length} positions`);

  // 2️⃣ Fetch existing signals
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("tx_hash, event_slug, picked_outcome")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const existingPairs = new Set(existingSignals.map(s => `${s.event_slug}||${s.picked_outcome}`));

  const newSignals = [];

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    // 3️⃣ Calculate amount with fallback
    let amount = Number(pos.usdcSize ?? pos.size ?? pos.amount ?? pos.cashPnl) || 1000;

    const sideValue = pos.side?.toUpperCase() || "BUY";
    let pickedOutcome;
    if (pos.title?.includes(" vs. ")) {
      const [a, b] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? a : b;
    } else if (/Over|Under/i.test(pos.title)) {
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else {
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    const txHash = [proxyWallet, pos.transactionHash ?? pos.asset, pos.timestamp, amount].join("-");

    // Skip duplicates only
    if (existingTxs.has(txHash) || existingPairs.has(`${eventSlug}||${pickedOutcome}`)) {
      console.log(`[SKIP] Wallet ${wallet.id} duplicate tx/event`);
      continue;
    }

    // 4️⃣ Fetch market, but do not skip if null
    const market = await fetchMarket(eventSlug);
    if (!market) {
      console.warn(`[WARN] Wallet ${wallet.id} event ${eventSlug} market not found or closed, inserting signal anyway`);
    }

    // 5️⃣ Push new signal
    newSignals.push({
      wallet_id: wallet.id,
      market_id: pos.conditionId,
      market_name: pos.title || eventSlug,
      event_slug: eventSlug,
      picked_outcome: pickedOutcome,
      side: sideValue,
      tx_hash: txHash,
      amount,
      outcome: "Pending",
      win_rate: wallet.win_rate,
      created_at: new Date(pos.timestamp * 1000),
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null
    });

    console.log(`[NEW SIGNAL] Wallet ${wallet.id} event ${eventSlug} -> ${pickedOutcome} amount ${amount}`);
  }

  if (!newSignals.length) {
    console.log(`[INFO] Wallet ${wallet.id} no new signals to insert`);
    return;
  }

  // 6️⃣ Upsert all new signals
  await supabase.from("signals").upsert(newSignals, {
    onConflict: ["wallet_id", "event_slug", "picked_outcome"]
  });
  console.log(`[UPSERT] Wallet ${wallet.id} inserted/updated ${newSignals.length} signals`);

  // 7️⃣ Update wallet event exposure
  const affectedEvents = [...new Set(newSignals.map(s => s.event_slug))];
  for (const eventSlug of affectedEvents) {
    const totals = await getWalletOutcomeTotals(wallet.id, eventSlug);
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;

    const [netOutcome, netAmount] = entries[0];
    const secondAmount = entries[1]?.[1] ?? 0;

    if (secondAmount > 0 && netAmount / secondAmount < 1.05) {
      console.log(`[EXPOSURE SKIP] Wallet ${wallet.id} event ${eventSlug} near-equal hedge`);
      continue;
    }

    await supabase.from("wallet_event_exposure").upsert({
      wallet_id: wallet.id,
      event_slug: eventSlug,
      net_outcome: netOutcome,
      net_amount: netAmount,
      totals,
      updated_at: new Date()
    });
    console.log(`[EXPOSURE] Wallet ${wallet.id} event ${eventSlug} net ${netOutcome} amount ${netAmount}`);
  }
}


/* ===========================
   Get Wallet Outcome Totals (fallback applied)
=========================== */
async function getWalletOutcomeTotals(walletId, eventSlug) {
  const { data, error } = await supabase
    .from("signals")
    .select("picked_outcome, amount")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (error || !data?.length) return {};

  const totals = {};
  for (const sig of data) {
    let amt = Number(sig.amount);
    if (!amt || amt < 1000) amt = 1000; // fallback to minimum bet
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + amt;
  }
  return totals;
}

/* ===========================
   Get Wallet Net Pick (uses totals with fallback)
=========================== */
async function getWalletNetPick(walletId, eventSlug, options = {}) {
  const { minTotal = 1000, dominanceRatio = 1.05 } = options;

  const totals = await getWalletOutcomeTotals(walletId, eventSlug);
  const entries = Object.entries(totals);
  if (!entries.length) return null;

  const totalExposure = Object.values(totals).reduce((sum, v) => sum + v, 0);
  if (totalExposure < minTotal) return null;

  entries.sort((a, b) => b[1] - a[1]);
  const [topOutcome, topAmount] = entries[0];
  const secondAmount = entries[1]?.[1] ?? 0;

  if (secondAmount > 0 && topAmount / secondAmount < dominanceRatio) return null;

  return topOutcome;
}

/* ===========================
   Rebuild Wallet Live Picks (ALLOW missing markets)
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals, error } = await supabase
    .from("signals")
    .select(`
      wallet_id,
      event_slug,
      market_id,
      market_name,
      amount,
      wallets!inner (
        paused,
        win_rate
      )
    `)
    .eq("outcome", "Pending")
    .eq("wallets.paused", false)
    .gte("wallets.win_rate", WIN_RATE_THRESHOLD)
    .gte("amount", 1000);

  if (error) { 
    console.error("❌ Failed fetching signals:", error.message); 
    return; 
  }
  if (!signals?.length) { 
    console.log("⚪ No pending signals found"); 
    return; 
  }

  // 1️⃣ Group signals by wallet + event
  const walletEventMap = new Map();
  for (const sig of signals) {
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    if (!walletEventMap.has(key)) walletEventMap.set(key, []);
    walletEventMap.get(key).push(sig);
  }

  // 2️⃣ Resolve net pick per wallet/event
  const resolvedPicks = await Promise.all([...walletEventMap.values()].map(async walletSignals => {
    const { wallet_id, event_slug, market_id, market_name } = walletSignals[0];
    const netPick = await getWalletNetPick(wallet_id, event_slug);
    if (!netPick) { 
      console.log(`[SKIP] Wallet ${wallet_id} event ${event_slug} has no net pick`); 
      return null; 
    }
    console.log(`[NET PICK] Wallet ${wallet_id} event ${event_slug} -> ${netPick}`);
    return {
      wallet_id,
      event_slug,
      market_id,
      market_name: market_name || event_slug, // fallback if missing
      picked_outcome: netPick
    };
  }));

  // 3️⃣ Aggregate picks across wallets
  const livePicksMap = new Map();
  for (const r of resolvedPicks) {
    if (!r) continue;
    const key = `${r.event_slug}||${r.picked_outcome}`;
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, {
        event_slug: r.event_slug,
        market_id: r.market_id,
        market_name: r.market_name,
        picked_outcome: r.picked_outcome,
        wallets: [],
        vote_count: 0
      });
    }
    const entry = livePicksMap.get(key);
    entry.wallets.push(r.wallet_id);
    entry.vote_count++;
  }

  // 4️⃣ Filter by minimum wallets and confidence
  const finalLivePicks = [];
  for (const p of livePicksMap.values()) {
    if (p.vote_count < MIN_WALLETS_FOR_SIGNAL) { 
      console.log(`[SKIP] Event ${p.event_slug} outcome ${p.picked_outcome} vote_count ${p.vote_count} < MIN_WALLETS_FOR_SIGNAL`);
      continue; 
    }

    let confidence = null;
    for (const [stars, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort((a,b)=>b[1]-a[1])) {
      if (p.vote_count >= threshold) { confidence = stars; break; }
    }
    if (!confidence) { 
      console.log(`[SKIP] Event ${p.event_slug} outcome ${p.picked_outcome} vote_count ${p.vote_count} below confidence thresholds`);
      continue; 
    }

    finalLivePicks.push({ ...p, confidence, fetched_at: new Date() });
    console.log(`[LIVE PICK] Event ${p.event_slug} outcome ${p.picked_outcome} confidence ${confidence} vote_count ${p.vote_count}`);
  }

  // 5️⃣ Upsert final live picks
  if (!finalLivePicks.length) { 
    console.log("⚪ No live picks to upsert"); 
    return; 
  }

  const { error: upsertError } = await supabase
    .from("wallet_live_picks")
    .upsert(finalLivePicks, { onConflict: ["event_slug", "picked_outcome"] });

  if (upsertError) console.error("❌ Failed upserting wallet_live_picks:", upsertError.message);
  else console.log(`✅ Wallet live picks rebuilt (${finalLivePicks.length})`);
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
   Fetch Wallet Activity (DATA-API)
=========================== */
async function fetchWalletPositions(proxyWallet) {
  if (!proxyWallet) throw new Error("Proxy wallet required");

  try {
    const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    // Map API data to tracker positions
    return data.map(item => ({
      asset: item.transactionHash || "",       // original tx hash
      conditionId: item.conditionId || "",    // market id
      eventSlug: item.eventSlug || item.slug || "", // event slug
      title: item.title || "",
      slug: item.slug || "",
      timestamp: item.timestamp || Math.floor(Date.now() / 1000),
      side: item.side || "BUY",               // default to BUY if missing
      cashPnl: Number(item.usdcSize ?? item.size ?? 0), // can adjust later
    }));
  } catch (err) {
    console.error(`❌ Activity fetch failed (fetchWalletPositions) for ${proxyWallet}`, err.message);
    return [];
  }
}

/* ===========================
   Notes Update Helper (new lines)
=========================== */
async function updateNotes(slug, text) {
  const noteText = text.split("\n").join("\n"); // preserve line breaks
  const { data: notes } = await supabase.from("notes").select("content").eq("slug", slug).maybeSingle();
  let newContent = notes?.content || "";

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
      const netPick = await getWalletNetPick(wallet.id, eventSlug);
if (!netPick) continue;

const sig = signalsForEvent.find(s => s.picked_outcome === netPick);
if (!sig) continue;

if (sig.outcome === "WIN") wins++;
if (sig.outcome === "LOSS") losses++;


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
   Signal Processing + Telegram Sending (Fixed)
=========================== */
async function processAndSendSignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*");

  if (error) {
    console.error("❌ Failed fetching wallet_live_picks:", error.message);
    return;
  }

  if (!livePicks?.length) return;

  for (const pick of livePicks) {
    // ✅ Must have wallets
    if (!pick.wallets || pick.wallets.length === 0) continue;

    // ✅ Enforce minimum wallets
    if (pick.vote_count < MIN_WALLETS_FOR_SIGNAL) continue;

    // ✅ Prevent duplicate alerts unless forced
    if (pick.last_confidence_sent && !FORCE_SEND) continue;

    const confidenceEmoji = getConfidenceEmoji(pick.vote_count);

    const text = `⚡️ Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Signal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`;

    try {
      await sendTelegram(text, false);
      await updateNotes("midas-sports", text);

      console.log(
        `✅ Sent signal for market ${pick.market_id} (${pick.picked_outcome})`
      );

      // ✅ Mark as sent (atomic per pick)
      await supabase
        .from("wallet_live_picks")
        .update({
          last_confidence_sent: new Date(),
          signal_sent_at: new Date()
        })
        .eq("market_id", pick.market_id)
        .eq("picked_outcome", pick.picked_outcome);

    } catch (err) {
      console.error(
        `❌ Failed sending signal for market ${pick.market_id}:`,
        err.message
      );
    }
  }
}

/* ===========================
   Tracker Loop (Enhanced)
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    // 1️⃣ Fetch all active wallets
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("*");

    if (walletsError) {
      console.error("❌ Failed fetching wallets:", walletsError.message);
      return;
    }
    if (!wallets?.length) return;

    // 2️⃣ Track wallets concurrently
    await Promise.allSettled(wallets.map(trackWallet));

    // 3️⃣ Rebuild live picks from updated signals
    await rebuildWalletLivePicks();

    await resolveMarkets(); 

    // 4️⃣ Process and send signals
    await processAndSendSignals();

    // 5️⃣ Update wallet metrics (win_rate, paused, daily losses)
    await updateWalletMetricsJS();

  } catch (err) {
    console.error("❌ Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // 1️⃣ Initial fetch leaderboard and wallet tracking
  await fetchAndInsertLeaderboardWallets().catch(err => console.error(err));
  await trackerLoop();

  // 2️⃣ Set continuous polling
  setInterval(trackerLoop, POLL_INTERVAL);

  // 3️⃣ Daily cron for leaderboard refresh
  cron.schedule("0 7 * * *", async () => {
    console.log("📅 Daily cron running...");
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();
  }, { timezone: TIMEZONE });

  // 4️⃣ Heartbeat log
  setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

  // 5️⃣ Simple HTTP server for health check
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket tracker running\n");
  }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
}

main();
