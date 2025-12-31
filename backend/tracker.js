import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";
import { createClient } from "@supabase/supabase-js";

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
  // Check cache
  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);

  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${eventSlug}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return null;

    const market = await res.json();

    // Cache it even if closed/resolved
    marketCache.set(eventSlug, market);

    return market;
  } catch (err) {
    console.error(`❌ Fetch error for ${eventSlug}:`, err.message);
    return null;
  }
}

function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Track Wallet (One pick per wallet per event)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) return console.warn(`[TRACK] Wallet ${wallet.id} has no proxy`);

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
  }

  let positions = [];
  try {
    positions = await fetchWalletPositions(proxyWallet);
  } catch (err) {
    console.error(`[TRACK] Failed fetching positions for wallet ${wallet.id}:`, err.message);
    return;
  }

  if (!positions.length) return;

  // Fetch existing signals safely
  let existingSignals = [];
  try {
    const res = await supabase
      .from("signals")
      .select("tx_hash, event_slug, picked_outcome")
      .eq("wallet_id", wallet.id);
    existingSignals = res.data || [];
  } catch {
    existingSignals = [];
  }

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const walletEventTotals = {}; // aggregate wagers per event

  // --- Step 1: Aggregate positions per wallet/event ---
  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;
    if ((pos.cashPnl ?? 0) < 1000) continue; // MIN SIZE

    const side = (pos.side || "BUY").toUpperCase();

    // Determine preliminary picked outcome
    let pickedOutcome = "YES";
    const marketName = pos.title || "";
    if (marketName.includes(" vs. ")) {
      const [teamA, teamB] = marketName.split(" vs. ").map(s => s.trim());
      pickedOutcome = side === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(marketName)) {
      pickedOutcome = side === "BUY" ? "OVER" : "UNDER";
    } else {
      pickedOutcome = side === "BUY" ? "YES" : "NO";
    }

    const key = `${wallet.id}||${eventSlug}`;
    if (!walletEventTotals[key]) walletEventTotals[key] = {};
    walletEventTotals[key][pickedOutcome] = (walletEventTotals[key][pickedOutcome] || 0) + (pos.cashPnl ?? 0);
  }

  // --- Step 2: Determine net pick per wallet/event ---
  const newSignals = [];
  for (const [key, outcomes] of Object.entries(walletEventTotals)) {
    const [walletId, eventSlug] = key.split("||");

    const [netOutcome, netAmount] = Object.entries(outcomes).sort((a, b) => b[1] - a[1])[0];
    if (!netOutcome) continue;

    // Skip duplicate in same wallet
    if (existingSignals.some(s => s.event_slug === eventSlug && s.picked_outcome === netOutcome)) continue;

    const pos = positions.find(p => (p.eventSlug || p.slug) === eventSlug);
    if (!pos) continue;

    const syntheticTx = [proxyWallet, pos.asset, pos.timestamp, netAmount].join("-");
    if (existingTxs.has(syntheticTx)) continue;

    // Fetch market to get event start
    let market = null;
    try {
      market = await fetchMarket(eventSlug);
    } catch {}
    if (!market) continue;

    newSignals.push({
      wallet_id: wallet.id,
      signal: pos.title,
      market_name: pos.title,
      market_id: pos.conditionId,
      event_slug: eventSlug,
      side: netOutcome,
      picked_outcome: netOutcome,
      tx_hash: syntheticTx,
      pnl: netAmount,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(pos.timestamp ? pos.timestamp * 1000 : Date.now()),
      event_start_at: market.eventStartAt ? new Date(market.eventStartAt) : null
    });
  }

  // --- Step 3: Insert signals safely ---
  if (newSignals.length) {
    try {
      await supabase
        .from("signals")
        .upsert(newSignals, {
          onConflict: ["wallet_id", "event_slug", "picked_outcome"]
        });
      console.log(`[TRACK] Wallet ${wallet.id} inserted/upserted ${newSignals.length} signal(s)`);
    } catch (err) {
      console.error(`[TRACK] Failed inserting signals for wallet ${wallet.id}:`, err.message);
    }
  }

  // --- Step 4: Update wallet event exposure ---
  const events = [...new Set(newSignals.map(s => s.event_slug))];
  for (const eventSlug of events) {
    const totals = await getWalletOutcomeTotals(wallet.id, eventSlug);
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;

    const [netOutcome, netAmount] = entries[0];
    const secondAmount = entries[1]?.[1] ?? 0;
    if (secondAmount > 0 && netAmount / secondAmount < 1.05) continue;

    const marketId = newSignals.find(s => s.event_slug === eventSlug)?.market_id || null;
    try {
      await supabase.from("wallet_event_exposure").upsert({
        wallet_id: wallet.id,
        event_slug: eventSlug,
        market_id: marketId,
        totals,
        net_outcome: netOutcome,
        net_amount: netAmount,
        updated_at: new Date()
      });
    } catch (err) {
      console.error(`[TRACK] Failed updating wallet exposure for ${wallet.id} / ${eventSlug}:`, err.message);
    }
  }
}

/* ===========================
   Optimized Rebuild & Resolve Wallet Live Picks
=========================== */
async function processWalletLivePicks(maxRetries = 3, retryDelayMs = 5000) {
  const marketCache = new Map(); // Cache markets by market_id or event_slug

  // --- 0️⃣ Normalize old wallet_live_picks (YES/NO → team or OVER/UNDER) ---
  const { data: oldPicks, error: oldError } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .in("picked_outcome", ["YES", "NO"]);

  if (!oldError && oldPicks?.length) {
    for (const pick of oldPicks) {
      let normalizedOutcome = pick.picked_outcome.trim().toUpperCase();
      let market = marketCache.get(pick.market_id);
      if (!market) {
        try {
          market = await fetchMarket(pick.market_id);
          marketCache.set(pick.market_id, market);
        } catch {}
      }

      if (market && (normalizedOutcome === "YES" || normalizedOutcome === "NO")) {
        if (market.name?.includes(" vs. ")) {
          const [teamA, teamB] = market.name.split(" vs. ").map(s => s.trim());
          normalizedOutcome = normalizedOutcome === "YES" ? teamA : teamB;
        } else if (/Over|Under/i.test(market?.name || "")) {
          normalizedOutcome = normalizedOutcome === "YES" ? "OVER" : "UNDER";
        }

        try {
          await supabase
            .from("wallet_live_picks")
            .update({ picked_outcome: normalizedOutcome })
            .eq("market_id", pick.market_id)
            .eq("picked_outcome", pick.picked_outcome);
          console.log(`[NORMALIZE] Updated ${pick.market_id} pick ${pick.picked_outcome} → ${normalizedOutcome}`);
        } catch (err) {
          console.error(`❌ Failed normalizing old pick ${pick.market_id}:`, err.message);
        }
      }
    }
  }

  // --- 1️⃣ Fetch pending signals ---
  const { data: signals, error: sigError } = await supabase
    .from("signals")
    .select(`
      wallet_id,
      market_id,
      market_name,
      event_slug,
      picked_outcome,
      pnl,
      wallets!inner(paused)
    `)
    .eq("outcome", "Pending")
    .eq("wallets.paused", false);

  if (sigError) return console.error("❌ Failed fetching signals:", sigError.message);
  if (!signals?.length) return console.log("ℹ️ No active pending signals found.");

  // --- 2️⃣ Aggregate per wallet per event (highest pnl) ---
  const walletEventMap = {}; // { walletId||eventSlug : {pickedOutcome, pnl, market_id, market_name} }
  for (const sig of signals) {
    if (!sig.wallet_id || !sig.event_slug) continue;
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    if (!walletEventMap[key] || sig.pnl > walletEventMap[key].pnl) {
      walletEventMap[key] = {
        picked_outcome: sig.picked_outcome,
        pnl: sig.pnl,
        market_id: sig.market_id,
        market_name: sig.market_name
      };
    }
  }

  // --- 3️⃣ Aggregate picks by market + normalized outcome ---
  const livePicksMap = new Map();
  for (const pick of Object.values(walletEventMap)) {
    let normalizedOutcome = pick.picked_outcome.trim().toUpperCase();

    let market = marketCache.get(pick.market_id);
    if (!market) {
      try {
        market = await fetchMarket(pick.market_id);
        marketCache.set(pick.market_id, market);
      } catch {
        market = null;
      }
    }

    if (normalizedOutcome === "YES" || normalizedOutcome === "NO") {
      if (market?.name?.includes(" vs. ")) {
        const [teamA, teamB] = market.name.split(" vs. ").map(s => s.trim());
        normalizedOutcome = normalizedOutcome === "YES" ? teamA : teamB;
      } else if (/Over|Under/i.test(market?.name || "")) {
        normalizedOutcome = normalizedOutcome === "YES" ? "OVER" : "UNDER";
      }
    }

    const key = `${pick.market_id || pick.market_name}||${normalizedOutcome}`;
    if (!livePicksMap.has(key)) {
      livePicksMap.set(key, {
        market_id: pick.market_id,
        market_name: pick.market_name,
        event_slug: pick.event_slug,
        market_url: pick.market_name ? `https://polymarket.com/market/${pick.market_name}` : null,
        picked_outcome: normalizedOutcome,
        wallets: new Set()
      });
    }
    livePicksMap.get(key).wallets.add(pick.wallet_id);
  }

  // --- 4️⃣ Filter picks and calculate confidence ---
  const finalLivePicks = [];
  for (const pick of livePicksMap.values()) {
    const walletIds = [...pick.wallets];
    const voteCount = walletIds.length;
    if (voteCount < MIN_WALLETS_FOR_SIGNAL) continue;

    let confidenceNum = 1;
    const sortedThresholds = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
    for (const [, threshold] of sortedThresholds) {
      if (voteCount >= threshold) {
        confidenceNum = threshold;
        break;
      }
    }

    finalLivePicks.push({
      market_id: pick.market_id,
      market_name: pick.market_name,
      event_slug: pick.event_slug,
      market_url: pick.market_url,
      picked_outcome: pick.picked_outcome,
      wallets: walletIds,
      vote_count: voteCount,
      confidence: confidenceNum,
      fetched_at: new Date()
    });
  }

  // --- 5️⃣ Upsert picks & send new signals ---
  if (finalLivePicks.length) {
    const { data: existingPicks } = await supabase
      .from("wallet_live_picks")
      .select("market_id, picked_outcome, event_slug");

    const existingKeys = new Set((existingPicks || []).map(p => `${p.market_id}||${p.picked_outcome}||${p.event_slug}`));

    for (const pick of finalLivePicks) {
      const key = `${pick.market_id}||${pick.picked_outcome}||${pick.event_slug}`;
      try {
        await supabase
          .from("wallet_live_picks")
          .upsert(pick, { onConflict: ["market_id", "picked_outcome", "event_slug"] });

        console.log(`[LIVE PICK] ${pick.market_name} | ${pick.picked_outcome} | Wallets: ${pick.vote_count}`);

        if (!existingKeys.has(key)) {
          const newTradeText = `⚡️ NEW TRADE SIGNAL
Market Event: [${pick.market_name || pick.event_slug}](${pick.market_url})
Prediction: ${pick.picked_outcome}
Confidence: ${pick.confidence || "⭐"}`;

          await sendTelegram(newTradeText, false);
          await updateNotes("midas-sports", newTradeText);
        }
      } catch (err) {
        console.error(`❌ Error processing live pick ${pick.market_id}/${pick.picked_outcome}:`, err.message);
      }
    }
  }

  // --- 6️⃣ Resolve outcomes for pending wallet_live_picks ---
  const { data: livePicksPending, error: liveError } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .eq("outcome", "Pending");

  if (liveError) return console.error("❌ Failed fetching wallet_live_picks:", liveError.message);

  let resolvedCount = 0;
  const resolvedMarkets = [];
  const stillPending = [];

  for (const pick of livePicksPending) {
    const { market_id, picked_outcome, event_slug } = pick;
    let market = marketCache.get(market_id) || null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!market) {
          market = await fetchMarket(event_slug);
          marketCache.set(market_id, market);
        }
        if (!market || !(market.umaResolutionStatus === "resolved" || market.automaticallyResolved)) {
          console.log(`⚠️ Attempt ${attempt}: Market ${market_id} (${event_slug}) not resolved yet`);
        } else break;
      } catch (err) {
        console.error(`❌ Attempt ${attempt}: Failed fetching market ${event_slug}:`, err.message);
      }
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, retryDelayMs));
    }

    if (!market || !(market.umaResolutionStatus === "resolved" || market.automaticallyResolved)) {
      stillPending.push({ market_id, event_slug });
      continue;
    }

    let outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    let outcomePrices = Array.isArray(market.outcomePrices) ? market.outcomePrices.map(p => String(p)) : [];

    let winnerIndex = outcomePrices.indexOf("1");
    if (winnerIndex < 0) winnerIndex = outcomePrices.indexOf(1);

    let winningOutcome = (winnerIndex >= 0 ? outcomes[winnerIndex] : null) || market.automaticallyResolvedOutcome || null;

    if (!winningOutcome) {
      stillPending.push({ market_id, event_slug });
      continue;
    }

    const result = pick.picked_outcome === winningOutcome ? "WIN" : "LOSS";
    const resultEmoji = RESULT_EMOJIS[result] || "";

    try {
      await supabase
        .from("wallet_live_picks")
        .update({ outcome: result, resolved_outcome: winningOutcome })
        .eq("market_id", market_id)
        .eq("picked_outcome", pick.picked_outcome);

      resolvedCount += 1;
      resolvedMarkets.push({
        market_id,
        event_slug,
        picked_outcome: pick.picked_outcome,
        result,
        wallet_count: pick.wallets?.length || 1
      });

      const resolvedDate = new Date(market.resolvedAt || market.endDate).toLocaleString("en-US", { timeZone: TIMEZONE, hour12: true });
      const tradeResultText = `📈 TRADE RESULT ALERT
Market Event: [${market.name || event_slug}](https://polymarket.com/market/${event_slug})
Prediction: ${pick.picked_outcome}
Result: ${result} ${resultEmoji}
Event Resolved: ${resolvedDate}`;

      await sendTelegram(tradeResultText, false);
      await updateNotes("midas-sports", tradeResultText);
    } catch (err) {
      console.error(`❌ Failed updating wallet_live_picks for ${market_id}:`, err.message);
      stillPending.push({ market_id, event_slug });
    }
  }

  // --- 7️⃣ Daily summary ---
  console.log("📊 Daily Resolution Summary");
  console.log(`Signals Resolved Today: ${resolvedCount}`);
  if (resolvedMarkets.length) {
    console.log("✅ Resolved Markets:");
    resolvedMarkets.forEach(m => console.log(`- Market ${m.market_id} (${m.event_slug}): ${m.result} (${m.picked_outcome}) | Wallets: ${m.wallet_count}`));
  }
  if (stillPending.length) {
    console.log("⚠️ Pending Markets:");
    stillPending.forEach(m => console.log(`- Market ${m.market_id} (${m.event_slug})`));
  }
}

/* ===========================
   Process & Send Signals (ALERTS REMOVED, LOGGING ONLY)
=========================== */
async function processAndSendSignals() {
  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*");

  if (error) {
    console.error("❌ Failed fetching wallet_live_picks:", error.message);
    return { sent: 0 };
  }
  if (!livePicks?.length) return { sent: 0 };

  let sentCount = 0;

  for (const pick of livePicks) {
    // Convert numeric confidence to emoji only for display
    const confidenceEmoji = Object.entries(CONFIDENCE_THRESHOLDS)
      .find(([, threshold]) => threshold === pick.confidence)?.[0]
      || getConfidenceEmoji(pick.vote_count);

    const marketLabel = pick.market_name || pick.event_slug || "Market";
    const marketLink = pick.market_url || (pick.event_slug ? `https://polymarket.com/market/${pick.event_slug}` : null);

    // Logging only — do not send alerts here
    console.log(`[LIVE PICK] ${marketLabel} | Outcome: ${pick.picked_outcome} | Wallets: ${pick.vote_count} | Confidence: ${confidenceEmoji}`);
  }

  return { sent: sentCount };
}

/* ===========================
   Send Daily Summary
=========================== */
async function sendDailySummary() {
  const yesterdayStart = new Date();
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);

  const yesterdayEnd = new Date();
  yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
  yesterdayEnd.setHours(23, 59, 59, 999);

  // Fetch all resolved signals sent yesterday
  const { data: signals } = await supabase
    .from("wallet_live_picks")
    .select("market_name, picked_outcome, outcome, vote_count, confidence, signal_sent_at")
    .gte("signal_sent_at", yesterdayStart.toISOString())
    .lte("signal_sent_at", yesterdayEnd.toISOString());

  if (!signals?.length) {
    console.log("📊 Daily Summary: No signals sent yesterday.");
    return;
  }

  let wins = 0, losses = 0;

  for (const sig of signals) {
    if (sig.outcome === "WIN") wins++;
    else if (sig.outcome === "LOSS") losses++;
  }

  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;

  const summaryText = `📊 Daily Summary
🗓 Date: ${yesterdayStart.toLocaleDateString()}
Signals Sent: ${signals.length}
Wins: ${wins}
Losses: ${losses}
Win Rate: ${winRate}%`;

  // 1️⃣ Send to Telegram
  try {
    await sendTelegram(summaryText, false);
  } catch (err) {
    console.error("❌ Failed sending daily summary to Telegram:", err.message);
  }

  // 2️⃣ Update Notes
  try {
    await updateNotes("midas-sports", summaryText);
  } catch (err) {
    console.error("❌ Failed updating Notes with daily summary:", err.message);
  }

  // 3️⃣ Log to console
  console.log(summaryText);
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
   Notes Update Helper (with proper line breaks)
=========================== */
async function updateNotes(slug, text) {
  // Normalize internal line breaks
  const noteText = text.split("\n").join("\n");

  // Fetch existing notes content
  const { data: notes } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", slug)
    .maybeSingle();

  let newContent = notes?.content || "";

  // Add 2 newlines between alerts to separate them visually
  newContent += newContent ? `\n\n${noteText}` : noteText;

  // Update back to Supabase
  await supabase
    .from("notes")
    .update({ content: newContent, public: true })
    .eq("slug", slug);
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
   Tracker Loop (SAFE + STABLE)
=========================== */
let isTrackerRunning = false;

async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    // 1️⃣ Fetch wallets
    const { data: wallets, error } = await supabase
      .from("wallets")
      .select("*");

    if (error) {
      console.error("❌ Failed fetching wallets:", error.message);
      return;
    }
    if (!wallets?.length) return;

    // 2️⃣ Track wallets (never let one crash the loop)
    await Promise.allSettled(wallets.map(wallet => trackWallet(wallet)));

    // 3️⃣ Rebuild live picks
    await processWalletLivePicks();

    // Optional debug count
    const { data: livePicks } = await supabase
      .from("wallet_live_picks")
      .select("market_id");

    const rebuiltCount = livePicks?.length || 0;
     
    // 4️⃣ Send alerts (NO RETURN EXPECTED)
    await processAndSendSignals();

    // 5️⃣ Update wallet metrics
    await updateWalletMetricsJS();

    console.log(
      `[TRACKER SUMMARY] ${rebuiltCount} live picks | ${wallets.length} wallets @ ${new Date().toISOString()}`
    );

  } catch (err) {
    console.error("❌ Tracker loop failed:", err);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry (STABLE)
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try {
    // Initial bootstrap
    await fetchAndInsertLeaderboardWallets();
    await trackerLoop();

    // Polling loop
    setInterval(() => {
      trackerLoop().catch(err =>
        console.error("❌ Tracker loop error:", err)
      );
    }, POLL_INTERVAL);

    // Daily cron
    cron.schedule(
      "0 7 * * *",
      async () => {
        console.log("📅 Daily cron running...");
        await fetchAndInsertLeaderboardWallets();
        await trackerLoop();

        // 📝 Send daily summary
        try {
          await sendDailySummary();
        } catch (err) {
          console.error("❌ Failed sending daily summary:", err.message);
        }
      },
      { timezone: TIMEZONE }
    );

    // Heartbeat
    setInterval(() => {
      console.log(`[HEARTBEAT] Alive @ ${new Date().toISOString()}`);
    }, 60_000);

    // Health server
    const PORT = process.env.PORT || 3000;
    http
      .createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Polymarket tracker running\n");
      })
      .listen(PORT, () =>
        console.log(`🩺 Health server listening on ${PORT}`)
      );

  } catch (err) {
    console.error("❌ Main failed:", err);
  }
}

main();
