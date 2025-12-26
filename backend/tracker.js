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

const WIN_RATE_THRESHOLD = parseInt(process.env.WIN_RATE_THRESHOLD || "70");

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
   Reprocess Resolved Picks (Optimized)
=========================== */
async function reprocessResolvedPicks() {
  console.log("🔄 Reprocessing all resolved picks...");

  try {
    // 1️⃣ Fetch all wallets
    const { data: wallets, error: walletsErr } = await supabase
      .from("wallets")
      .select("id, polymarket_proxy_wallet");

    if (walletsErr) return console.error("Failed to fetch wallets:", walletsErr.message);
    if (!wallets?.length) return console.log("No wallets found for reprocessing.");

    // 2️⃣ Loop over wallets
    for (const wallet of wallets) {
      if (!wallet.polymarket_proxy_wallet) continue;

      // 3️⃣ Fetch all positions from Polymarket
      const positions = await fetchWalletPositions(wallet.polymarket_proxy_wallet);
      console.log(`Fetched ${positions.length} positions for wallet ${wallet.id}`);

      // 4️⃣ Update each position's signal in parallel
      await Promise.all(
        positions.map(async (pos) => {
          const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
          const marketId = pos.conditionId;
          const pnl = pos.cashPnl ?? null;

          // ✅ Use helper to determine outcome/resolved outcome
          const { outcome, resolvedOutcome } = determineOutcome(pos);

          // 5️⃣ Update only the exact signal row in DB
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
        })
      );
    }

    console.log("⚡ Finished reprocessing resolved picks.");
  } catch (err) {
    console.error("Error reprocessing resolved picks:", err.message);
  }
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

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`Wallet ${wallet.id} has no polymarket_proxy_wallet, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= WIN_RATE_THRESHOLD
  if (wallet.paused && wallet.win_rate >= WIN_RATE_THRESHOLD) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
    wallet.paused = false;
    console.log(`Wallet ${wallet.id} auto-unpaused (winRate=${wallet.win_rate.toFixed(2)}%)`);
  }

  if (wallet.paused && !wallet.force_fetch) return;

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

  // 4️⃣ Process positions
  for (const pos of positions) {
    const marketId = pos.conditionId;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    const pnl = pos.cashPnl ?? null;

    let outcome = "Pending";
    let resolvedOutcome = null;

({ outcome, resolvedOutcome } = determineOutcome(pos));

    const existingSig = existingSignals.find(s => s.market_id === marketId);
    if (existingSig) {
      await supabase
        .from("signals")
        .update({ pnl, outcome, resolved_outcome: resolvedOutcome, outcome_at: pnl !== null ? new Date() : null })
        .eq("id", existingSig.id);
    } else if (!existingTxs.has(pos.asset)) {
await supabase.from("signals").insert({
  wallet_id: wallet.id,
  signal: pos.title,
  market_name: pos.title,
  market_id: pos.conditionId,
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
  }

  // 5️⃣ Process unresolved trades
  const liveConditionIds = new Set(positions.filter(p => p.cashPnl === null).map(p => p.conditionId));
  const unresolvedTrades = trades.filter(t => {
    if (!liveConditionIds.has(t.conditionId)) return false;
    if (existingTxs.has(t.asset)) return false;
    const pos = positions.find(p => p.asset === t.asset);
    if (pos && typeof pos.cashPnl === "number") return false;
    return true;
  });

  if (unresolvedTrades.length) {
    const tradeRows = unresolvedTrades.map(trade => ({
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
      created_at: new Date(trade.timestamp * 1000 || Date.now()),
    }));

    await supabase.from("signals").insert(tradeRows);
    console.log(`Inserted ${tradeRows.length} unresolved trades for wallet ${wallet.id}`);

    try {
      await rebuildWalletLivePicks();
      console.log(`wallet_live_picks rebuilt after inserting trades for wallet ${wallet.id}`);
    } catch (err) {
      console.error(`Failed to rebuild wallet_live_picks:`, err.message);
    }
  }

  // 6️⃣ Compute wallet metrics
  const { data: resolvedSignals } = await supabase
    .from("signals")
    .select("market_id, picked_outcome, outcome, created_at")
    .eq("wallet_id", wallet.id)
    .in("outcome", ["WIN", "LOSS"])
    .order("created_at", { ascending: true });

  // Guard: resolvedSignals might be empty
  if (!resolvedSignals?.length) resolvedSignals = [];

  // Aggregate resolved signals per market
  const perMarket = {};
  for (const sig of resolvedSignals) {
    if (!sig.market_id) continue;
    perMarket[sig.market_id] ??= [];
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
    if (!sorted.length) continue; // <-- SAFE GUARD
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue; // tie → skip

    const majorityPick = sorted[0][0];
    const majoritySig = marketSignals.find(s => s.picked_outcome === majorityPick);
    if (!majoritySig) continue;

    if (majoritySig.outcome === "WIN") marketWins++;
  }

  const winRate = totalMarkets > 0 ? (marketWins / totalMarkets) * 100 : 0;

  // 7️⃣ Count live picks
  const { count: livePicksCount } = await supabase
    .from("signals")
    .select("*", { count: "exact", head: true })
    .eq("wallet_id", wallet.id)
    .eq("outcome", "Pending");

  // 8️⃣ Determine pause status
  let pausedStatus = wallet.force_fetch
    ? wallet.paused
    : (winRate < WIN_RATE_THRESHOLD || (resolvedSignals?.length && resolvedSignals[resolvedSignals.length - 1].outcome === "LOSS"));

  // 9️⃣ Update wallet metrics
  await supabase
    .from("wallets")
    .update({
      losing_streak: resolvedSignals?.filter(s => s.outcome === "LOSS").length || 0,
      win_rate: winRate,
      live_picks: livePicksCount,
      paused: pausedStatus,
      last_checked: new Date(),
    })
    .eq("id", wallet.id);

  if (wallet.force_fetch) {
    await supabase.from("wallets").update({ force_fetch: false }).eq("id", wallet.id);
  }

  console.log(
    `Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, livePicks: ${livePicksCount}, paused: ${pausedStatus}`
  );
}


/* ===========================
   Update Wallet Metrics
=========================== */
async function updateWalletMetricsJS() {
  try {
    const { data: wallets, error: walletsErr } = await supabase.from("wallets").select("*");
    if (walletsErr) { console.error("Failed to fetch wallets:", walletsErr); return; }
    if (!wallets?.length) return console.log("No wallets found");

    for (const wallet of wallets) {
      try {
        // 1️⃣ Fetch resolved signals
        const { data: resolvedSignals, error: signalsErr } = await supabase
          .from("signals")
          .select("market_id, picked_outcome, outcome, created_at")
          .eq("wallet_id", wallet.id)
          .in("outcome", ["WIN", "LOSS"])
          .order("created_at", { ascending: true });

        if (signalsErr) {
          console.error(`Failed to fetch resolved signals for wallet ${wallet.id}:`, signalsErr);
          continue; // ✅ valid inside for-of
        }

        // 2️⃣ Aggregate per market to handle multiple picks
        const perMarket = {};
        for (const sig of resolvedSignals) {
          if (!perMarket[sig.market_id]) perMarket[sig.market_id] = [];
          perMarket[sig.market_id].push(sig);
        }

        let marketWins = 0;
        const totalMarkets = Object.keys(perMarket).length;

        for (const marketSignals of Object.values(perMarket)) {
          // Count votes per picked_outcome
          const counts = {};
          for (const sig of marketSignals) {
            if (!sig.picked_outcome) continue;
            counts[sig.picked_outcome] = (counts[sig.picked_outcome] || 0) + 1;
          }

          // Determine majority pick
          const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue; // tie → skip market

          const majorityPick = sorted[0][0];
          const majoritySig = marketSignals.find(s => s.picked_outcome === majorityPick);
          if (!majoritySig) continue;

          if (majoritySig.outcome === "WIN") marketWins++;
        }

        const winRate = totalMarkets > 0 ? (marketWins / totalMarkets) * 100 : 0;

        // 3️⃣ Compute losing streak
        let losingStreak = 0;
        for (let i = resolvedSignals.length - 1; i >= 0; i--) {
          if (resolvedSignals[i].outcome === "LOSS") losingStreak++;
          else break;
        }

        // 4️⃣ Count live picks
        const { data: liveSignals, error: liveSignalsErr } = await supabase
          .from("signals")
          .select("id")
          .eq("wallet_id", wallet.id)
          .eq("outcome", "Pending");

        if (liveSignalsErr) console.error(`Failed to fetch live signals for wallet ${wallet.id}:`, liveSignalsErr.message);
        const livePicksCount = liveSignals?.length || 0;

        // 5️⃣ Determine paused
        const paused = losingStreak >= LOSING_STREAK_THRESHOLD || winRate < WIN_RATE_THRESHOLD;

        // 6️⃣ Update wallet
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
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .eq("outcome", "Pending");

  if (error) return console.error("Failed to fetch live picks:", error.message);
  if (!livePicks?.length) return console.log("No live picks to process.");

  // Group by market_id + picked_outcome
  const grouped = {};
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    grouped[key] ??= [];
    grouped[key].push(pick);
  }

  for (const picks of Object.values(grouped)) {
    if (!picks.length) continue; // guard
    const walletCount = picks.length;
    if (walletCount < 2) continue; // need >=2 wallets for confidence 2

    const sig = picks[0]; // safe, picks.length >= 2
    const confidence = getConfidenceEmoji(walletCount); // user-defined emoji function
    const text = `Market: ${sig.market_name}\nPick: ${sig.picked_outcome}\nConfidence: ${confidence}`;

    try {
      await sendTelegram(text);
      await updateNotes("polymarket-millionaires", text);
      await supabase
        .from("signals")
        .update({ signal_sent_at: new Date() })
        .eq("market_id", sig.market_id);
      console.log(`✅ Sent majority signal for market ${sig.market_name} (confidence: ${walletCount})`);
    } catch (err) {
      console.error(`Failed to send signal for market ${sig.market_name}:`, err.message);
    }
  }
}



/* ===========================
   Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","POLITICS","SPORTS","CRYPTO","CULTURE","MENTIONS","WEATHER","ECONOMICS","TECH","FINANCE"];
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
          if (!proxyWallet || entry.pnl < 100000 || entry.vol >= 10 * entry.pnl) {
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
   Rebuild wallet_live_picks (with detailed debug logs)
=========================== */
async function rebuildWalletLivePicks() {
  console.log("Rebuilding wallet_live_picks...");
  console.log("WIN_RATE_THRESHOLD:", WIN_RATE_THRESHOLD);

  // 1️⃣ Fetch all wallets
  const { data: allWallets, error: walletsErr } = await supabase
    .from("wallets")
    .select("id, win_rate, paused");
  if (walletsErr) return console.error("Failed to fetch wallets:", walletsErr.message);

  if (!allWallets?.length) return console.log("No wallets found.");

  console.log(`Total wallets fetched: ${allWallets.length}`);

  // 2️⃣ Filter eligible wallets and log skipped ones
  const eligibleWallets = allWallets.filter(w => {
    const eligible = !w.paused && w.win_rate >= WIN_RATE_THRESHOLD;
    if (!eligible) {
      console.log(`Skipping wallet ${w.id} — paused: ${w.paused}, win_rate: ${w.win_rate}`);
    }
    return eligible;
  });

  if (!eligibleWallets.length) return console.log("No eligible wallets to process.");
  console.log("Eligible wallets:", eligibleWallets.map(w => `${w.id}:${w.win_rate}`));

  const eligibleIds = eligibleWallets.map(w => w.id);

  // 3️⃣ Fetch unresolved signals for eligible wallets
  const { data: signals, error: signalsErr } = await supabase
    .from("signals")
    .select("*")
    .in("wallet_id", eligibleIds)
    .eq("outcome", "Pending")
    .not("picked_outcome", "is", null);

  if (signalsErr) return console.error("Failed to fetch signals:", signalsErr.message);
  if (!signals?.length) return console.log("No pending signals to process.");

  console.log(`Total pending signals fetched: ${signals.length}`);

  // 4️⃣ Group by wallet + event to calculate majority pick
  const perWalletEvent = {};
  for (const sig of signals) {
    if (!sig.event_slug) {
      console.log(`Skipping signal ${sig.id} — missing event_slug`);
      continue;
    }
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    perWalletEvent[key] ??= {};
    perWalletEvent[key][sig.picked_outcome] = (perWalletEvent[key][sig.picked_outcome] || 0) + 1;
  }

  const livePicks = [];

  for (const [key, counts] of Object.entries(perWalletEvent)) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
      console.log(`Tie detected, skipping wallet/event: ${key}`, counts);
      continue; // skip tie
    }

    const majorityPick = sorted[0][0];
    const [walletId, eventSlug] = key.split("||");

    const sig = signals.find(s =>
      s.wallet_id == walletId &&
      s.event_slug === eventSlug &&
      s.picked_outcome === majorityPick
    );

    if (!sig) {
      console.log(`No matching signal found for wallet/event/majorityPick: ${walletId}/${eventSlug}/${majorityPick}`);
      continue;
    }

    console.log(`Adding live pick: wallet ${walletId}, event ${eventSlug}, majorityPick ${majorityPick}`);

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
      vote_count: 1,
      win_rate: sig.win_rate || 0
    });
  }

  // 5️⃣ Aggregate vote_count across wallets
  const grouped = {};
  for (const pick of livePicks) {
    const key = `${pick.market_id}||${pick.picked_outcome}`;
    grouped[key] ??= [];
    grouped[key].push(pick);
  }

  const finalLivePicks = [];
  for (const picks of Object.values(grouped)) {
    const voteCount = picks.length;
    picks.forEach(p => p.vote_count = voteCount);
    finalLivePicks.push(...picks);
  }

  console.log(`Final live picks to insert: ${finalLivePicks.length}`);

  // 6️⃣ Clear table and insert
  await supabase.from("wallet_live_picks").delete();
  if (finalLivePicks.length) {
    await supabase.from("wallet_live_picks").insert(finalLivePicks);
    console.log(`Inserted ${finalLivePicks.length} live picks`);
  }
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
