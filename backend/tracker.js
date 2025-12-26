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

const WIN_RATE_THRESHOLD = parseInt(process.env.WIN_RATE_THRESHOLD || "0");

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
process.on("unhandledRejection", err => {
  console.error("🔥 Unhandled rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("🔥 Uncaught exception:", err);
});

/* ===========================
   Get Eligible Wallets
=========================== */
async function getEligibleWallets(minWinRate = WIN_RATE_THRESHOLD) {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, win_rate")
    .eq("paused", false)
    .gte("win_rate", WIN_RATE_THRESHOLD);

  if (error || !data?.length) return [];
  return data;
}


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
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
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
   Vote counting
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals, error } = await supabase
    .from("signals")
    .select("wallet_id, side, picked_outcome, event_slug")
    .eq("market_id", marketId)
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (error || !signals?.length) return {};

  const grouped = {};
  for (const sig of signals) {
    if (!sig.event_slug) continue;
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    grouped[key] ??= [];
    grouped[key].push(sig);
  }

  const perWallet = {};
  for (const [key, group] of Object.entries(grouped)) {
    const walletId = group[0].wallet_id;
    perWallet[walletId] ??= {};
    const counts = {};
    for (const sig of group) {
      counts[sig.side] = (counts[sig.side] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;
    perWallet[walletId][sorted[0][0]] = (perWallet[walletId][sorted[0][0]] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    for (const [side, count] of Object.entries(votes)) {
      counts[side] = (counts[side] || 0) + count;
    }
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts || !Object.keys(counts).length) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts || !Object.values(counts).length) return "";
  return getConfidenceEmoji(Math.max(...Object.values(counts)));
}
/* ===========================
   Pick helpers
=========================== */
function derivePickedOutcome(trade) {
  if (trade.outcome) return trade.outcome;
  if (typeof trade.outcomeIndex === "number") return `OPTION_${trade.outcomeIndex}`;
  return null;
}

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
   Determine outcome of a position
=========================== */
function determineOutcome(pos) {
  let outcome = "Pending";
  let resolvedOutcome = null;

  if (pos.resolved === true) {
    if (pos.cashPnl > 0) {
      outcome = "WIN";
      resolvedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    } else {
      outcome = "LOSS";
      resolvedOutcome = pos.oppositeOutcome || (pos.outcome || `OPTION_${pos.outcomeIndex}`);
    }
  }

  return { outcome, resolvedOutcome };
}

/* ===========================
   Rebuild wallet_live_picks (All wallets, amount-weighted votes)
=========================== */
async function rebuildWalletLivePicks() {
  console.log("Rebuilding wallet_live_picks (all wallets, amount-weighted)...");

  // 1️⃣ Fetch all wallets
  const { data: allWallets, error: walletsErr } = await supabase
    .from("wallets")
    .select("id, win_rate, paused");
  if (walletsErr) return console.error("Failed to fetch wallets:", walletsErr.message);
  if (!allWallets?.length) return console.log("No wallets found.");

  console.log(`Total wallets fetched: ${allWallets.length}`);
  const allWalletIds = allWallets.map(w => w.id);

  // 2️⃣ Fetch all unresolved signals
  const { data: signals, error: signalsErr } = await supabase
    .from("signals")
    .select("*")
    .in("wallet_id", allWalletIds)
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (signalsErr) return console.error("Failed to fetch signals:", signalsErr.message);
  if (!signals?.length) return console.log("No pending signals to process.");

  console.log(`Total pending signals fetched: ${signals.length}`);

  // 3️⃣ Group by wallet + event_slug to calculate weighted vote
  const perWalletEvent = {};
  for (const sig of signals) {
    if (!sig.event_slug) continue;
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    perWalletEvent[key] ??= {};

    // accumulate amount per side
    const amount = sig.amount || 0; // make sure your signals table has an 'amount' column
    perWalletEvent[key][sig.picked_outcome] = (perWalletEvent[key][sig.picked_outcome] || 0) + amount;
  }

  // 4️⃣ Determine each wallet's majority pick by total amount
  const livePicks = [];
  for (const [key, totals] of Object.entries(perWalletEvent)) {
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    // skip tie (same total amount)
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;

    const majorityPick = sorted[0][0];
    const [walletId, eventSlug] = key.split("||");

    const sig = signals.find(s =>
      s.wallet_id == walletId &&
      s.event_slug === eventSlug &&
      s.picked_outcome === majorityPick
    );
    if (!sig) continue;

    livePicks.push({
      wallet_id: parseInt(walletId),
      market_id: sig.market_id,
      market_name: sig.market_name,
      event_slug: sig.event_slug,
      picked_outcome: majorityPick,
      side: sig.side,
      pnl: sig.pnl,
      outcome: sig.outcome,
      resolved_outcome: sig.resolved_outcome,
      fetched_at: new Date(),
      vote_count: 1, // 1 wallet = 1 vote
      win_rate: sig.win_rate || 0
    });
  }

  // 5️⃣ Aggregate vote counts across wallets and assign confidence
  const grouped = {};
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    grouped[key] ??= [];
    grouped[key].push(pick);
  }

  const finalLivePicks = [];
  for (const picks of Object.values(grouped)) {
    const voteCount = picks.length;

    // Assign confidence emoji
    let confidence = "";
    for (const [emoji, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a)) {
      if (voteCount >= threshold) {
        confidence = emoji;
        break;
      }
    }

    // Skip picks that do not meet minimum threshold
    if (!confidence) continue;

    picks.forEach(p => {
      p.vote_count = voteCount;
      p.confidence = confidence;
    });

    finalLivePicks.push(...picks);
  }

  console.log(`Final live picks to insert: ${finalLivePicks.length}`);

  // 6️⃣ Clear table and insert
  await supabase.from("wallet_live_picks").delete();
  if (finalLivePicks.length) {
    await supabase.from("wallet_live_picks").insert(finalLivePicks);
    console.log(`Inserted ${finalLivePicks.length} live picks with confidence.`);
  }

  console.log("✅ rebuildWalletLivePicks completed — wallets remain unpaused.");
}


/* ===========================
   Reprocess Resolved Picks + Send Results
=========================== */
async function reprocessResolvedPicks() {
  console.log("Reprocessing resolved picks...");

  const { data: wallets, error: walletsErr } = await supabase
    .from("wallets")
    .select("id, polymarket_proxy_wallet");

  if (walletsErr) return console.error("Failed to fetch wallets:", walletsErr.message);
  if (!wallets?.length) return console.log("No wallets found for reprocessing.");

  for (const wallet of wallets) {
    if (!wallet.polymarket_proxy_wallet) continue;

    const positions = await fetchWalletPositions(wallet.polymarket_proxy_wallet);
    console.log(`Fetched ${positions.length} positions for wallet ${wallet.id}`);

    for (const pos of positions) {
      const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
      const marketId = pos.conditionId;
      const pnl = pos.cashPnl ?? null;

      const { outcome, resolvedOutcome } = determineOutcome(pos);

      const { data: existingSigs } = await supabase
        .from("signals")
        .select("*")
        .eq("wallet_id", wallet.id)
        .eq("market_id", marketId)
        .eq("picked_outcome", pickedOutcome);

      if (existingSigs?.length) {
        await supabase
          .from("signals")
          .update({
            pnl,
            outcome,
            resolved_outcome: resolvedOutcome,
            outcome_at: pnl !== null ? new Date() : null
          })
          .eq("wallet_id", wallet.id)
          .eq("market_id", marketId)
          .eq("picked_outcome", pickedOutcome);
      } else {
        await supabase.from("signals").insert({
          wallet_id: wallet.id,
          signal: pos.title,
          market_name: pos.title,
          market_id: marketId,
          event_slug: pos.eventSlug || pos.slug,
          side: pos.side?.toUpperCase() || "BUY",
          picked_outcome: pickedOutcome,
          opposite_outcome: pos.oppositeOutcome || null,
          tx_hash: pos.asset,
          pnl,
          outcome,
          resolved_outcome: resolvedOutcome,
          outcome_at: pnl !== null ? new Date() : null,
          win_rate: wallet.win_rate,
          created_at: new Date(pos.timestamp * 1000 || Date.now()),
        });
      }

      // ✅ Send result Notes + Telegram if resolved
      if (outcome !== "Pending") {
        await sendResultNotes({
          market_id: marketId,
          signal: pos.title,
          market_name: pos.title,
          picked_outcome: pickedOutcome,
          event_slug: pos.eventSlug || pos.slug
        }, outcome);
      }
    }
  }

  console.log("Finished reprocessing resolved picks.");
}


/* ===========================
   Fetch wallet positions safely
=========================== */
async function fetchWalletPositions(userId) {
  if (!userId) return [];

  const allPositions = [];
  let limit = 100;
  let offset = 0;

  while (true) {
    const url = `https://data-api.polymarket.com/positions?user=${userId}&limit=${limit}&offset=${offset}&sizeThreshold=1&sortBy=CURRENT&sortDirection=DESC`;

    try {
      const data = await fetchWithRetry(
        url,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
      );

      if (!Array.isArray(data) || data.length === 0) break;

      allPositions.push(...data);

      if (data.length < limit) break;
      offset += limit;
    } catch (err) {
      console.error(`Failed to fetch positions for wallet ${userId} at offset ${offset}:`, err.message);
      break;
    }
  }

  console.log(`Fetched ${allPositions.length} total positions for wallet ${userId}`);
  return allPositions;
}

async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`Wallet ${wallet.id} has no polymarket_proxy_wallet, skipping`);
    return;
  }

  // 1️⃣ Fetch positions
  let positions = [];
  try { positions = await fetchWalletPositions(proxyWallet); } catch (err) {
    console.error(`Failed to fetch positions for wallet ${proxyWallet}:`, err.message);
  }

  // 2️⃣ Fetch trades
  let trades = [];
  try {
    const tradesUrl = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${proxyWallet}`;
    trades = await fetchWithRetry(tradesUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    trades = Array.isArray(trades) ? trades : [];
  } catch (err) {
    console.error(`Failed to fetch trades for wallet ${proxyWallet}:`, err.message);
  }

  // 3️⃣ Existing signals
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("id, tx_hash, market_id, outcome")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals?.map(s => s.tx_hash));

  // 4️⃣ Process positions and unresolved trades
  const allNewSignals = [];

  for (const pos of positions) {
    const marketId = pos.conditionId;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    const pnl = pos.cashPnl ?? null;

    const { outcome, resolvedOutcome } = determineOutcome(pos);

    const existingSig = existingSignals.find(s => s.market_id === marketId);
    if (existingSig) {
      await supabase
        .from("signals")
        .update({
          pnl,
          outcome,
          resolved_outcome: resolvedOutcome,
          outcome_at: pnl !== null ? new Date() : null
        })
        .eq("id", existingSig.id);
    } else if (!existingTxs.has(pos.asset)) {
      allNewSignals.push({
        wallet_id: wallet.id,
        signal: pos.title,
        market_name: pos.title,
        market_id: marketId,
        event_slug: pos.eventSlug || pos.slug,
        side: pos.side?.toUpperCase() || "BUY",
        picked_outcome: pickedOutcome,
        opposite_outcome: pos.oppositeOutcome || null,
        tx_hash: pos.asset,
        pnl,
        outcome,
        resolved_outcome: resolvedOutcome,
        outcome_at: pnl !== null ? new Date() : null,
        win_rate: wallet.win_rate,
        amount: pos.amount || 0,
        created_at: new Date(pos.timestamp * 1000 || Date.now()),
      });
    }
  }

  const liveConditionIds = new Set(positions.filter(p => p.cashPnl === null).map(p => p.conditionId));
  const unresolvedTrades = trades.filter(t => {
    if (!liveConditionIds.has(t.conditionId)) return false;
    if (existingTxs.has(t.asset)) return false;
    const pos = positions.find(p => p.asset === t.asset);
    if (pos && typeof pos.cashPnl === "number") return false;
    return true;
  });

  unresolvedTrades.forEach(trade => {
    allNewSignals.push({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      event_slug: trade.eventSlug || trade.slug,
      side: trade.side?.toUpperCase() || "BUY",
      picked_outcome: trade.outcome || `OPTION_${trade.outcomeIndex}`,
      tx_hash: trade.asset,
      pnl: null,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      amount: trade.amount || 0,
      created_at: new Date(trade.timestamp * 1000 || Date.now()),
    });
  });

  if (allNewSignals.length) {
    await supabase.from("signals").insert(allNewSignals);
    console.log(`Inserted ${allNewSignals.length} new signals for wallet ${wallet.id}`);
  }
}

async function updateWalletMetricsJS() {
  try {
    const { data: wallets, error: walletsErr } = await supabase.from("wallets").select("*");
    if (walletsErr) { console.error("Failed to fetch wallets:", walletsErr); return; }
    if (!wallets?.length) return console.log("No wallets found");

    for (const wallet of wallets) {
      try {
        const { data: resolvedSignals, error: signalsErr } = await supabase
          .from("signals")
          .select("market_id, picked_outcome, outcome, created_at")
          .eq("wallet_id", wallet.id)
          .in("outcome", ["WIN", "LOSS"])
          .order("created_at", { ascending: true });

        if (signalsErr) {
          console.error(`Failed to fetch resolved signals for wallet ${wallet.id}:`, signalsErr);
          continue;
        }

        // Aggregate per market
        const perMarket = {};
        for (const sig of resolvedSignals) {
          if (!perMarket[sig.market_id]) perMarket[sig.market_id] = [];
          perMarket[sig.market_id].push(sig);
        }

        let marketWins = 0;
        const totalMarkets = Object.keys(perMarket).length;

        for (const marketSignals of Object.values(perMarket)) {
          const counts = {};
          for (const sig of marketSignals) {
            if (!sig.picked_outcome) continue;
            counts[sig.picked_outcome] = (counts[sig.picked_outcome] || 0) + 1;
          }

          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;

          const majorityPick = sorted[0][0];
          const majoritySig = marketSignals.find(s => s.picked_outcome === majorityPick);
          if (!majoritySig) continue;

          if (majoritySig.outcome === "WIN") marketWins++;
        }

        const winRate = totalMarkets > 0 ? (marketWins / totalMarkets) * 100 : 0;

        // Losing streak calculation remains but does not affect pause
        let losingStreak = 0;
        for (let i = resolvedSignals.length - 1; i >= 0; i--) {
          if (resolvedSignals[i].outcome === "LOSS") losingStreak++;
          else break;
        }

        const { data: liveSignals, error: liveSignalsErr } = await supabase
          .from("signals")
          .select("id")
          .eq("wallet_id", wallet.id)
          .eq("outcome", "Pending");

        if (liveSignalsErr) console.error(`Failed to fetch live signals for wallet ${wallet.id}:`, liveSignalsErr.message);
        const livePicksCount = liveSignals?.length || 0;

        // ✅ Never auto-pause
        const paused = wallet.paused; 

        const { error: updateErr } = await supabase
          .from("wallets")
          .update({
            win_rate: winRate,
            losing_streak: losingStreak,
            live_picks: livePicksCount,
            paused,
            last_checked: new Date()
          })
          .eq("id", wallet.id);

        if (updateErr) console.error(`Wallet ${wallet.id} update failed:`, updateErr);
        else console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicksCount}, paused: ${paused}`);
      } catch (walletErr) {
        console.error(`Error processing wallet ${wallet.id}:`, walletErr.message);
      }
    }

    console.log("✅ Wallet metrics updated successfully.");
  } catch (err) {
    console.error("Error updating wallet metrics:", err.message);
  }
}


/* ===========================
   Send Result Notes
=========================== */
async function sendResultNotes(sig, result) {
  const counts = await getMarketVoteCounts(sig.market_id);
  const confidence = getMajorityConfidence(counts);
  const emoji = RESULT_EMOJIS[result] || "⚪";
  const text = formatSignal(sig, confidence, emoji, "Result Received");

  await sendTelegram(text);
  await updateNotes("polymarket-millionaires", text);
}

/* ===========================
   Send Majority Signals (Final with CONFIDENCE_THRESHOLDS)
=========================== */
async function sendMajoritySignals() {
  // 1️⃣ Fetch all live picks
  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .eq("outcome", "Pending");

  if (error) return console.error("Failed to fetch live picks:", error.message);
  if (!livePicks?.length) return console.log("No live picks to process.");

  // 2️⃣ Group by market_id + picked_outcome
  const grouped = {};
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    grouped[key] ??= [];
    grouped[key].push(pick);
  }

  // 3️⃣ Loop over grouped picks
  for (const [key, picks] of Object.entries(grouped)) {
    const walletCount = picks.length;

    // 4️⃣ Determine confidence emoji from thresholds
    let confidence = "";
    for (const [emoji, threshold] of Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a)) {
      if (walletCount >= threshold) {
        confidence = emoji;
        break;
      }
    }

    // ✅ Only send if meets at least the minimum threshold (⭐)
    if (!confidence) continue;

    const sig = picks[0]; // representative pick
    const text = `Market: ${sig.market_name}\nPick: ${sig.picked_outcome}\nConfidence: ${confidence}`;

    try {
      // 5️⃣ Send Telegram message
      await sendTelegram(text);

      // 6️⃣ Update Notes page
      await updateNotes("polymarket-millionaires", text);

      // 7️⃣ Mark signal as sent (prevent duplicate sends)
      await supabase
        .from("signals")
        .update({ signal_sent_at: new Date() })
        .eq("market_id", sig.market_id)
        .eq("picked_outcome", sig.picked_outcome);

      console.log(`✅ Sent majority signal for market ${sig.market_name} (wallets: ${walletCount}, confidence: ${confidence})`);
    } catch (err) {
      console.error(`Failed to send signal for market ${sig.market_name}:`, err.message);
    }
  }
}

/* ===========================
   Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","SPORTS"];
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalFetched = 0, totalInserted = 0, totalSkipped = 0;

  for (const category of categories) {
    for (const period of timePeriods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        totalFetched += data.length;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl < 1000000 || entry.vol >= 2 * entry.pnl) {
            totalSkipped++;
            continue;
          }

          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();

          if (existing) { totalSkipped++; continue; }

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

          totalInserted++;

          try {
            await trackWallet({ ...insertedWallet, force_fetch: true });
          } catch (err) {
            console.error(`Failed to fetch historical trades for wallet ${proxyWallet}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Failed to fetch leaderboard (${category}/${period}):`, err.message);
      }
    }
  }

  console.log(`Leaderboard fetch complete. Total fetched: ${totalFetched}, Total inserted: ${totalInserted}, Total skipped: ${totalSkipped}`);
}

/* ===========================
   Fetch wallet live picks
=========================== */
async function fetchWalletLivePicks(walletId) {
  const { data, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .eq("wallet_id", walletId)
    .order("vote_count", { ascending: false })
    .order("fetched_at", { ascending: false });

  if (error) { console.error(`Failed to fetch live picks for wallet ${walletId}:`, error.message); return []; }
  return data || [];
}

/* ===========================
   Bulk Unpause Wallets
=========================== */
async function bulkUnpauseWallets() {
  const { error, data } = await supabase
    .from("wallets")
    .update({ paused: false })
    .gte("win_rate", WIN_RATE_THRESHOLD)
    .eq("paused", true);

  if (error) console.error("Failed to bulk unpause wallets:", error.message);
  else console.log(`✅ Bulk unpaused ${data?.length || 0} wallets over threshold`);
}

let isTrackerRunning = false; // prevents overlapping loops

/* ===========================
   Tracker Loop
=========================== */
async function trackerLoop() {
  if (isTrackerRunning) {
    console.log("⏳ Tracker loop already running, skipping this cycle...");
    return;
  }
  isTrackerRunning = true;

  try {
    const { data: wallets } = await supabase.from("wallets").select("*");
    if (!wallets?.length) return console.log("No wallets found");

    console.log(`[${new Date().toISOString()}] Tracking ${wallets.length} wallets...`);

    // 1️⃣ Track each wallet
    for (const wallet of wallets) {
      try { 
        await trackWallet(wallet); 
      } catch (err) { 
        console.error(`Error tracking wallet ${wallet.id}:`, err.message); 
      }
    }

    // 2️⃣ Optional: Reprocess resolved picks
    if (process.env.REPROCESS === "true") {
      console.log("⚡ REPROCESS flag detected — updating resolved picks...");
      await reprocessResolvedPicks();
      console.log("⚡ Finished reprocessing resolved picks.");
    }

    // 3️⃣ Rebuild live picks
    await rebuildWalletLivePicks();

    // 4️⃣ Update wallet metrics
    await updateWalletMetricsJS();

    // 5️⃣ Send majority signals
    await sendMajoritySignals();

    console.log("✅ Tracker loop completed successfully");
  } catch (err) {
    console.error("Loop error:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Function
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try {
    await fetchAndInsertLeaderboardWallets();
  } catch (err) {
    console.error("Failed to fetch leaderboard wallets:", err.message);
  }

  // Run tracker loop immediately once
  await trackerLoop();

  // Then schedule periodic execution
  setInterval(trackerLoop, POLL_INTERVAL);
}

// Start the tracker
main();


/* ===========================
   Cron daily at 7am
=========================== */
cron.schedule("0 7 * * *", () => {
  console.log("Running daily summary + leaderboard + new wallets fetch...");
  sendDailySummary();
}, { timezone: TIMEZONE });

/* ===========================
   Heartbeat
=========================== */
setInterval(() => {
  console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`);
}, 60_000);

/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));

// Run main on startup
main();
