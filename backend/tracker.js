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
   Total $ Amount per Picked Outcome for a Wallet on a Specific Event
=========================== */
async function getWalletOutcomeTotals(walletId, eventSlug) {
  const { data, error } = await supabase
    .from("signals")
    .select("picked_outcome, pnl")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .not("picked_outcome", "is", null)
    .not("pnl", "is", null);

  if (error || !data?.length) return {};

  const totals = {};

  for (const sig of data) {
    totals[sig.picked_outcome] =
      (totals[sig.picked_outcome] || 0) + Number(sig.pnl);
  }

  return totals;
}

/* ===========================
   Returns the wallet's NET picked_outcome for an event based on total $ per side
=========================== */
async function getWalletNetPick(walletId, eventSlug) {
  const totals = await getWalletOutcomeTotals(walletId, eventSlug);

  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  // Sort by total desc
  entries.sort((a, b) => b[1] - a[1]);

  const [topOutcome, topAmount] = entries[0];
  const secondAmount = entries[1]?.[1] ?? 0;

  // Optional safety: ignore near-equal hedges (<5%)
  if (secondAmount > 0 && topAmount / secondAmount < 1.05) {
    return null;
  }

  return topOutcome;
}

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
   Resolve Markets (Fixed for multiple wallets)
=========================== */
async function resolveMarkets() {
  // 1️⃣ Fetch all pending signals
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending")
    .not("event_slug", "is", null);

  if (!pending?.length) return;

  // 2️⃣ Group by market_id + picked_outcome
  const marketOutcomeMap = new Map();
  for (const sig of pending) {
    if (!sig.picked_outcome) continue;
    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!marketOutcomeMap.has(key)) marketOutcomeMap.set(key, []);
    marketOutcomeMap.get(key).push(sig);
  }

  // 3️⃣ Process each group
  for (const [key, signalsGroup] of marketOutcomeMap.entries()) {
    const { event_slug, market_id, picked_outcome } = signalsGroup[0];

    const market = await fetchMarket(event_slug);
    if (!market?.resolved) continue;

    const winningOutcome = market.outcome;
    const result = picked_outcome === winningOutcome ? "WIN" : "LOSS";

    // 4️⃣ Update all signals in this group
    const ids = signalsGroup.map(s => s.id);
    await supabase
      .from("signals")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome,
        outcome_at: new Date()
      })
      .in("id", ids);

    // 5️⃣ Update wallet_live_picks
    await supabase
      .from("wallet_live_picks")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome,
        vote_count: signalsGroup.length
      })
      .eq("market_id", market_id)
      .eq("picked_outcome", picked_outcome);

    console.log(
      `✅ Resolved market ${market_id} | Pick: ${picked_outcome} | Result: ${result} | Wallets: ${signalsGroup.length}`
    );
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
   Track Wallet (Enhanced / Fixed)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`[TRACK] Wallet ${wallet.id} has no proxy, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // 1️⃣ Fetch positions from Polymarket
  const positions = await fetchWalletPositions(proxyWallet);
  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals ONCE
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("tx_hash, event_slug, picked_outcome")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));

  const newSignals = [];

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    // ✅ MIN SIZE FILTER ($1,000)
    if ((pos.cashPnl ?? 0) < 1000) continue;

    // 3️⃣ Determine picked_outcome
    let pickedOutcome;
    const sideValue = pos.side?.toUpperCase() || "BUY";

    if (pos.title?.includes(" vs. ")) {
      const [teamA, teamB] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(pos.title)) {
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else {
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    // ✅ Skip ONLY if SAME wallet already picked SAME outcome for this event
    const alreadyPickedSameSide = existingSignals.some(
      s =>
        s.event_slug === eventSlug &&
        s.picked_outcome === pickedOutcome
    );
    if (alreadyPickedSameSide) continue;

    // 4️⃣ Generate synthetic tx hash
    const syntheticTx = [
      proxyWallet,
      pos.asset,
      pos.timestamp,
      pos.cashPnl
    ].join("-");

    if (existingTxs.has(syntheticTx)) continue;

    // 5️⃣ Fetch market (skip closed)
    const market = await fetchMarket(eventSlug);
    if (!market) continue;

    // 6️⃣ Push signal
    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,
      side: sideValue,
      picked_outcome: pickedOutcome,
      tx_hash: syntheticTx,
      pnl: pos.cashPnl,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(
        pos.timestamp ? pos.timestamp * 1000 : Date.now()
      ),
      event_start_at: market?.eventStartAt
        ? new Date(market.eventStartAt)
        : null
    });
  }

  if (!newSignals.length) return;

  // 7️⃣ Insert signals
  const { error } = await supabase
    .from("signals")
    .upsert(newSignals);

  if (error) {
    console.error(
      `❌ Failed inserting/upserting signals for wallet ${wallet.id}:`,
      error.message
    );
  } else {
    console.log(
      `✅ Inserted ${newSignals.length} new signal(s) for wallet ${wallet.id}`
    );
  }

// 8️⃣ Update wallet event exposure (PER EVENT)
const affectedEvents = [
  ...new Set(newSignals.map(s => s.event_slug))
];

for (const eventSlug of affectedEvents) {
  const totals = await getWalletOutcomeTotals(wallet.id, eventSlug);
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (!entries.length) continue;

  const [netOutcome, netAmount] = entries[0];

  // Optional hedge ignore (<5% difference)
  const secondAmount = entries[1]?.[1] ?? 0;
  if (secondAmount > 0 && netAmount / secondAmount < 1.05) continue;

  // Get market_id safely
  const marketId =
    newSignals.find(s => s.event_slug === eventSlug)?.market_id || null;

  await supabase
    .from("wallet_event_exposure")
    .upsert({
      wallet_id: wallet.id,
      event_slug: eventSlug,
      market_id: marketId,
      totals,
      net_outcome: netOutcome,
      net_amount: netAmount,
      updated_at: new Date()
    });
}
   
}

/* ===========================
   Rebuild Wallet Live Picks
=========================== */
async function rebuildWalletLivePicks() {
  const { data: signals, error } = await supabase
    .from("signals")
    .select("wallet_id, market_id, market_name, event_slug, picked_outcome")
    .eq("outcome", "Pending");

  if (error) return console.error("❌ Failed fetching signals:", error.message);
  if (!signals?.length) return console.log("⚠️ No pending signals found.");

  // Aggregate picks per market + outcome
  const livePicksMap = new Map();

  for (const sig of signals) {
    if (!sig.wallet_id || !sig.picked_outcome) continue;

    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, {
        market_id: sig.market_id,
        market_name: sig.market_name,
        event_slug: sig.event_slug,
        picked_outcome: sig.picked_outcome,
        wallets: [],
        vote_count: 0
      });
    }

    const entry = livePicksMap.get(key);
    if (!entry.wallets.includes(sig.wallet_id)) {
      entry.wallets.push(sig.wallet_id);
      entry.vote_count++;
    }
  }

  console.log("🏗️ Candidate live picks:");
  for (const p of livePicksMap.values()) {
    console.log(`Market: ${p.market_id}, Outcome: ${p.picked_outcome}, Wallets: ${p.wallets.join(", ")}, Vote Count: ${p.vote_count}`);
  }

  // Filter by min wallets & compute confidence
  const finalLivePicks = [];
  for (const pick of livePicksMap.values()) {
    if (pick.vote_count < MIN_WALLETS_FOR_SIGNAL) {
      console.log(`❌ Pick skipped (vote_count < MIN_WALLETS_FOR_SIGNAL): ${pick.market_id} - ${pick.picked_outcome}`);
      continue;
    }

    let confidence = null;
    for (const [stars, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort((a, b) => b[1] - a[1])) {
      if (pick.vote_count >= threshold) {
        confidence = stars;
        break;
      }
    }

    if (!confidence) {
      console.log(`❌ Pick skipped (no confidence matched): ${pick.market_id} - ${pick.picked_outcome}, Votes: ${pick.vote_count}`);
      continue;
    }

    finalLivePicks.push({ ...pick, confidence, fetched_at: new Date() });
    console.log(`✅ Pick ready: ${pick.market_id} - ${pick.picked_outcome}, Votes: ${pick.vote_count}, Confidence: ${confidence}`);
  }

  if (!finalLivePicks.length) return console.log("⚠️ No picks passed thresholds.");

  // Upsert picks and merge wallets safely
  for (const pick of finalLivePicks) {
    const { data: existing } = await supabase
      .from("wallet_live_picks")
      .select("wallets, vote_count")
      .eq("market_id", pick.market_id)
      .eq("picked_outcome", pick.picked_outcome)
      .single()
      .catch(() => null);

    const mergedWallets = existing?.wallets ? Array.from(new Set([...existing.wallets, ...pick.wallets])) : pick.wallets;

    await supabase
      .from("wallet_live_picks")
      .upsert({
        ...pick,
        wallets: mergedWallets,
        vote_count: mergedWallets.length
      }, { onConflict: ["market_id", "picked_outcome"] });
  }

  console.log(`✅ Wallet live picks rebuilt (${finalLivePicks.length})`);
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

    // ✅ Ensure we don’t skip picks accidentally
    const lastSent = pick.signal_sent_at ? new Date(pick.signal_sent_at) : null;
    if (lastSent && !FORCE_SEND) continue;

    // 2️⃣ Compute confidence emoji
    const confidenceEmoji = getConfidenceEmoji(pick.vote_count);

    // 3️⃣ Construct message
    const text = `⚡️ Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Wallets: ${pick.wallets.join(", ")}
Vote Count: ${pick.vote_count}
Signal Sent: ${new Date().toLocaleString("en-US", { timeZone: TIMEZONE })}`;

    try {
      // 4️⃣ Send Telegram
      await sendTelegram(text, false);

      // 5️⃣ Update Notes
      await updateNotes("midas-sports", text);

      console.log(`✅ Sent signal for market ${pick.market_id} (${pick.picked_outcome})`);

      // 6️⃣ Mark as sent
      await supabase
        .from("wallet_live_picks")
        .update({
          signal_sent_at: new Date(),
          last_confidence_sent: confidenceEmoji
        })
        .eq("market_id", pick.market_id)
        .eq("picked_outcome", pick.picked_outcome);

    } catch (err) {
      console.error(`❌ Failed sending signal for market ${pick.market_id}:`, err.message);
    }
  }
}

/* ===========================
   Tracker Loop (Optimized for Multi-Wallet Picks)
=========================== */
let isTrackerRunning = false;

async function trackerLoop() {
  if (isTrackerRunning) return; // prevent overlapping runs
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

    // 2️⃣ Track wallets concurrently: fetch new positions & insert signals
    await Promise.allSettled(wallets.map(trackWallet));

    // 3️⃣ Rebuild wallet live picks from signals
    await rebuildWalletLivePicks(); // groups multiple wallets per pick

    // 4️⃣ Process live picks: send Telegram & Notes notifications
    await processAndSendSignals();

    // 5️⃣ Resolve markets: update signals & wallet_live_picks outcomes
    await resolveMarkets(); // now multi-wallet picks are handled

    // 6️⃣ Update wallet metrics: win_rate, losing streaks, auto-pause
    await updateWalletMetricsJS();

    console.log(`[TRACKER] Loop complete @ ${new Date().toISOString()}`);
  } catch (err) {
    console.error("❌ Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry (Optimized)
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try {
    // 1️⃣ Initial leaderboard fetch and wallet tracking
    await fetchAndInsertLeaderboardWallets().catch(err => console.error("❌ Leaderboard fetch failed:", err));
    await trackerLoop();

    // 2️⃣ Continuous polling of tracker loop
    setInterval(() => trackerLoop().catch(err => console.error("❌ Tracker loop error:", err)), POLL_INTERVAL);

    // 3️⃣ Daily cron for leaderboard refresh + tracker run (7:00 AM TIMEZONE)
    cron.schedule("0 7 * * *", async () => {
      console.log("📅 Daily cron running...");
      await fetchAndInsertLeaderboardWallets().catch(err => console.error("❌ Daily leaderboard fetch failed:", err));
      await trackerLoop().catch(err => console.error("❌ Tracker loop error (cron):", err));
    }, { timezone: TIMEZONE });

    // 4️⃣ Heartbeat log every 60 seconds
    setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

    // 5️⃣ Simple HTTP server for health check
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Polymarket tracker running\n");
    }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));

  } catch (err) {
    console.error("❌ Main entry failed:", err.message);
  }
}

main();
