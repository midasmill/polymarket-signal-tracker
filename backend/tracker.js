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
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "10", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const CONFIDENCE_THRESHOLDS = {
  "⭐": 10,
  "⭐⭐": 20,
  "⭐⭐⭐": 30,
  "⭐⭐⭐⭐": 40,
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
   Returns total $ amount picked per outcome for a wallet on a specific event
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
   Returns the wallet's NET picked_outcome for an event based on total $ amount per side
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



function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

async function autoResolvePendingSignals() {
  // 1️⃣ Fetch all pending signals
  const { data: pendingSignals, error: fetchError } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (fetchError) {
    console.error("❌ Failed fetching pending signals:", fetchError.message);
    return;
  }

  if (!pendingSignals?.length) return;

  let resolvedCount = 0;

  // Group signals by market & outcome to count votes
  const voteMap = new Map();
  for (const sig of pendingSignals) {
    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!voteMap.has(key)) voteMap.set(key, { walletIds: new Set(), signals: [] });
    const entry = voteMap.get(key);
    entry.walletIds.add(sig.wallet_id);
    entry.signals.push(sig);
  }

  for (const sig of pendingSignals) {
    try {
      const market = await fetchMarket(sig.event_slug);
      if (!market || !market.outcome) continue;

      const winningOutcome = market.outcome;
      const result = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";

      // 2️⃣ Update the signal regardless of vote count
      const { error: updateSignalError } = await supabase
        .from("signals")
        .update({
          outcome: result,
          resolved_outcome: winningOutcome,
          outcome_at: new Date()
        })
        .eq("id", sig.id);

      if (updateSignalError) {
        console.error(`❌ Failed updating signal ${sig.id}:`, updateSignalError.message);
        continue;
      }

      // 3️⃣ Only update/insert wallet_live_picks if vote count >= MIN_WALLETS_FOR_SIGNAL
      const voteEntry = voteMap.get(`${sig.market_id}||${sig.picked_outcome}`);
      if (voteEntry.walletIds.size < MIN_WALLETS_FOR_SIGNAL) continue;

      const { data: existingPick, error: existingError } = await supabase
        .from("wallet_live_picks")
        .select("*")
        .eq("market_id", sig.market_id)
        .eq("picked_outcome", sig.picked_outcome)
        .maybeSingle();

      if (existingError) {
        console.error(`❌ Error fetching wallet_live_pick for market ${sig.market_id}:`, existingError.message);
        continue;
      }

      if (existingPick) {
        // Merge wallet IDs and update outcome
        const updatedWallets = Array.from(new Set([...(existingPick.wallets || []), ...voteEntry.walletIds]));
        const { error: updatePickError } = await supabase
          .from("wallet_live_picks")
          .update({
            vote_count: updatedWallets.length,
            wallets: updatedWallets,
            outcome: result,
            resolved_outcome: winningOutcome
          })
          .eq("id", existingPick.id);

        if (updatePickError) {
          console.error(`❌ Failed updating wallet_live_pick ${existingPick.id}:`, updatePickError.message);
          continue;
        }
      } else {
        // Insert new live pick
        const { error: insertPickError } = await supabase
          .from("wallet_live_picks")
          .insert({
            market_id: sig.market_id,
            picked_outcome: sig.picked_outcome,
            vote_count: voteEntry.walletIds.size,
            wallets: Array.from(voteEntry.walletIds),
            outcome: result,
            resolved_outcome: winningOutcome,
            fetched_at: new Date(),
            market_name: sig.market_name,
            event_slug: sig.event_slug
          });

        if (insertPickError) {
          console.error(`❌ Failed inserting wallet_live_pick for market ${sig.market_id}:`, insertPickError.message);
          continue;
        }
      }

      resolvedCount++;
    } catch (err) {
      console.error(`❌ Error processing signal ${sig.id}:`, err.message);
    }
  }

  console.log(`✅ Auto-resolved ${resolvedCount} pending signal(s)`);
}

/* ===========================
   Fetch Market (Includes Closed + Resolved)
=========================== */
const marketCache = new Map();

async function fetchMarket(eventSlug, bypassCache = false) {
  if (!eventSlug) return null;

  // 1️⃣ Return cached market if available
  if (!bypassCache && marketCache.has(eventSlug)) {
    return marketCache.get(eventSlug);
  }

  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets/slug/${eventSlug}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      }
    );

    if (res.status === 404) {
      console.warn(`⚠️ Market not found: ${eventSlug}`);
      return null;
    }

    if (!res.ok) {
      console.error(`❌ Failed to fetch market ${eventSlug}: HTTP ${res.status}`);
      return null;
    }

    const market = await res.json();

    // 2️⃣ Auto-resolve outcome for closed markets
    if (
      !market.outcome &&
      market.closed &&
      market.outcomePrices &&
      market.outcomes
    ) {
      try {
        const prices = JSON.parse(market.outcomePrices);
        const outcomes = JSON.parse(market.outcomes);

        const winnerIndex = prices.findIndex(p => Number(p) === 1);
        if (winnerIndex !== -1) {
          market.outcome = outcomes[winnerIndex];
        } else {
          console.warn(`⚠️ Could not determine winner for ${eventSlug}`);
        }
      } catch (err) {
        console.error(`❌ Failed to parse outcomes for ${eventSlug}:`, err.message);
      }
    }

    // 3️⃣ Cache and return market
    marketCache.set(eventSlug, market);
    return market;

  } catch (err) {
    console.error(`❌ Failed to fetch market ${eventSlug}:`, err.message);
    return null;
  }
}

/* ===========================
   Resolve Markets (Fixed & Robust)
=========================== */
async function resolveMarkets() {
  // 1️⃣ Fetch all signals with a valid event_slug
  const { data: signals, error: fetchError } = await supabase
    .from("signals")
    .select("*")
    .not("event_slug", "is", null);

  if (fetchError) {
    console.error("❌ Failed fetching signals:", fetchError.message);
    return;
  }

  if (!signals?.length) return;

  // 2️⃣ Group signals by event_slug
  const signalsByEvent = signals.reduce((acc, sig) => {
    if (!acc[sig.event_slug]) acc[sig.event_slug] = [];
    acc[sig.event_slug].push(sig);
    return acc;
  }, {});

  for (const [eventSlug, sigs] of Object.entries(signalsByEvent)) {
    try {
      const market = await fetchMarket(eventSlug);
      if (!market || !market.outcome) continue; // skip unresolved markets

      const winningOutcome = market.outcome;

      for (const sig of sigs) {
        const result = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";

        // Skip if already up-to-date
        if (sig.outcome === result && sig.resolved_outcome === winningOutcome) continue;

        // 3️⃣ Update the signals table
        const { error: updateSignalError } = await supabase
          .from("signals")
          .update({
            outcome: result,
            resolved_outcome: winningOutcome,
            outcome_at: new Date()
          })
          .eq("id", sig.id);

        if (updateSignalError) {
          console.error(`❌ Failed updating signal ${sig.id}:`, updateSignalError.message);
          continue;
        }

        // 4️⃣ Upsert wallet_live_picks table
        const { data: existingPick, error: existingError } = await supabase
          .from("wallet_live_picks")
          .select("*")
          .eq("market_id", sig.market_id)
          .eq("picked_outcome", sig.picked_outcome)
          .maybeSingle(); // returns null if no row

        if (existingError) {
          console.error(`❌ Error fetching wallet_live_pick for market ${sig.market_id}:`, existingError.message);
          continue;
        }

        if (existingPick) {
          // Update existing pick
          const updatedWallets = Array.from(new Set([...(existingPick.wallets || []), sig.wallet_id]));
          const { error: updatePickError } = await supabase
            .from("wallet_live_picks")
            .update({
              vote_count: updatedWallets.length,
              wallets: updatedWallets,
              outcome: result,
              resolved_outcome: winningOutcome
            })
            .eq("id", existingPick.id);

          if (updatePickError) {
            console.error(`❌ Failed updating wallet_live_pick ${existingPick.id}:`, updatePickError.message);
          }
        } else {
          // Insert new pick
          const { error: insertPickError } = await supabase
            .from("wallet_live_picks")
            .insert({
              wallet_id: sig.wallet_id,
              market_id: sig.market_id,
              picked_outcome: sig.picked_outcome,
              side: sig.side || null,
              pnl: sig.pnl || 0,
              outcome: result,
              resolved_outcome: winningOutcome,
              vote_count: 1,
              wallets: [sig.wallet_id],
              market_name: sig.market_name,
              event_slug: sig.event_slug,
              fetched_at: new Date(),
              signal_sent_at: sig.signal_sent_at || null
            });

          if (insertPickError) {
            console.error(`❌ Failed inserting wallet_live_pick for signal ${sig.id}:`, insertPickError.message);
          }
        }
      }
    } catch (err) {
      console.error(`❌ Failed processing signals for event ${eventSlug}:`, err.message);
    }
  }

  console.log(`✅ All markets resolved and wallet_live_picks updated`);
}

/* ===========================
   Force Resolve Pending Markets
=========================== */
async function forceResolvePendingMarkets() {
  // 1️⃣ Fetch all Pending signals
  const { data: pendingSignals } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pendingSignals?.length) return;

  const eventSlugs = [...new Set(pendingSignals.map(s => s.event_slug).filter(Boolean))];

  for (const slug of eventSlugs) {
    // Fetch fresh market data, ignore cache
    const market = await fetchMarket(slug, true);
    if (!market || !market.outcome) continue;

    const winningOutcome = market.outcome;

    // Update all signals for this event
    await supabase
      .from("signals")
      .update({
        outcome: supabase.raw("CASE WHEN picked_outcome = ? THEN 'WIN' ELSE 'LOSS' END", [winningOutcome]),
        resolved_outcome: winningOutcome,
        outcome_at: new Date()
      })
      .eq("event_slug", slug);

    // Rebuild wallet_live_picks for this market
    await rebuildWalletLivePicks(true);
  }

  console.log(`✅ Force-resolved ${eventSlugs.length} pending markets`);
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
  const categories = ["OVERALL", "SPORTS"];
  const periods = ["DAY", "WEEK"];

  for (const category of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });

        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet) continue;

          // Skip if PnL < 1,000,000 or volume too high
          if ((entry.pnl || 0) < 1000000 || (entry.vol || 0) >= 2 * (entry.pnl || 0)) continue;

          // Check if wallet already exists
          const { data: existingWallet, error: checkError } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();

          if (checkError) {
            console.error(`❌ Supabase check failed for ${proxyWallet}:`, checkError.message);
            continue;
          }

          if (existingWallet) continue;

          // Insert new wallet
          const { data: insertedWallet, error: insertError } = await supabase
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
            .maybeSingle();

          if (insertError || !insertedWallet) {
            console.error(`❌ Failed inserting wallet ${proxyWallet}:`, insertError?.message || "No wallet returned");
            continue;
          }

          // Track wallet immediately
          try {
            await trackWallet(insertedWallet);
          } catch (trackErr) {
            console.error(`❌ Tracking wallet failed for ${proxyWallet}:`, trackErr.message);
          }
        }

      } catch (err) {
        console.error(`❌ Leaderboard fetch failed (${category}/${period}):`, err.message);
      }
    }
  }

  console.log("✅ Leaderboard wallets fetched and tracked successfully");
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
   Track Wallet (Net-Pick / Auto-Resolve)
=========================== */
async function trackWallet(wallet, forceRebuild = false) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) return;

  // Auto-unpause if win_rate >= 80
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // 1️⃣ Fetch wallet positions
  const positions = await fetchWalletPositions(proxyWallet);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals (to skip duplicates if not forceRebuild)
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("*")
    .eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));

  // 3️⃣ Aggregate PnL per wallet/event/outcome
  const walletEventMap = new Map();
  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug || (pos.cashPnl ?? 0) < 1000) continue;

    let pickedOutcome;
    const sideValue = (pos.side || "BUY").toUpperCase();
    if (pos.title?.includes(" vs. ")) {
      const [teamA, teamB] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(pos.title)) {
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else {
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    const syntheticTx = [proxyWallet, pos.asset, pos.timestamp, pos.cashPnl].join("-");
    if (!forceRebuild && existingTxs.has(syntheticTx)) continue;

    const key = `${wallet.id}||${eventSlug}`;
    if (!walletEventMap.has(key)) {
      walletEventMap.set(key, {
        picks: {},
        market_id: pos.conditionId,
        market_name: pos.title,
        event_slug: eventSlug,
        resolved_outcome: pos.resolvedOutcome ?? null,
        outcome_at: pos.outcomeTimestamp ?? null,
        tx_hashes: new Set()
      });
    }

    const entry = walletEventMap.get(key);
    entry.picks[pickedOutcome] = (entry.picks[pickedOutcome] || 0) + Number(pos.cashPnl || 0);
    entry.tx_hashes.add(syntheticTx);
    if (pos.resolvedOutcome) entry.resolved_outcome = pos.resolvedOutcome;
  }

  // 4️⃣ Compute net pick per wallet/event
  const netSignals = [];
  for (const [key, data] of walletEventMap.entries()) {
    const sorted = Object.entries(data.picks).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;

    const wallet_id = parseInt(key.split("||")[0]);
    const picked_outcome = sorted[0][0];
    const pnl = sorted[0][1];

    let side;
    if (/YES|NO|OVER|UNDER/i.test(picked_outcome)) {
      side = picked_outcome.toUpperCase();
    } else {
      const teams = data.market_name?.split(" vs. ").map(s => s.trim());
      side = teams?.[0] === picked_outcome ? "BUY" : "SELL";
    }

    const existing = existingSignals.find(s =>
      s.wallet_id === wallet_id && s.event_slug === data.event_slug && s.picked_outcome === picked_outcome
    );
    const outcome = (!forceRebuild && existing?.outcome !== "Pending")
      ? existing.outcome
      : data.resolved_outcome ?? "Pending";

    netSignals.push({
      wallet_id,
      market_id: data.market_id,
      market_name: data.market_name,
      event_slug: data.event_slug,
      picked_outcome,
      pnl,
      side,
      outcome,
      resolved_outcome: data.resolved_outcome ?? null,
      outcome_at: data.outcome_at ?? null,
      win_rate: wallet.win_rate,
      created_at: new Date(),
      event_start_at: null,
      tx_hash: Array.from(data.tx_hashes)[0]
    });
  }

  if (!netSignals.length) return;

  // 5️⃣ Delete old signals that are not net pick
  for (const sig of netSignals) {
    await supabase
      .from("signals")
      .delete()
      .eq("wallet_id", sig.wallet_id)
      .eq("event_slug", sig.event_slug)
      .neq("picked_outcome", sig.picked_outcome);
  }

  // 6️⃣ Upsert net signals safely
  try {
    const { error } = await supabase
      .from("signals")
      .upsert(netSignals, {
        onConflict: ["wallet_id", "event_slug", "picked_outcome"]
      });

    if (error) console.error(`❌ Failed upserting signals for wallet ${wallet.id}:`, error.message);
    else console.log(`✅ Upserted ${netSignals.length} net signal(s) for wallet ${wallet.id}`);
  } catch (err) {
    console.error(`❌ Unexpected upsert error for wallet ${wallet.id}:`, err.message);
  }

  // 7️⃣ Update wallet event exposure
  const affectedEvents = [...new Set(netSignals.map(s => s.event_slug))];
  for (const eventSlug of affectedEvents) {
    const totals = await getWalletOutcomeTotals(wallet.id, eventSlug);
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;

    const [netOutcome, netAmount] = entries[0];
    const secondAmount = entries[1]?.[1] ?? 0;
    if (secondAmount > 0 && netAmount / secondAmount < 1.05) continue;

    const marketId = netSignals.find(s => s.event_slug === eventSlug)?.market_id || null;

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

  // 8️⃣ Auto-resolve pending signals
  await autoResolvePendingSignals();
}

/* ===========================
   Rebuild Wallet Live Picks
   (Filtered by Vote Threshold + Canonical Slugs + Batched)
=========================== */
const invalidMarketSlugs = new Map(); // slug => reason

function getResolvedOutcomeFromMarket(market) {
  if (!market || !market.closed || !market.outcomes || !market.outcomePrices) return null;
  try {
    const outcomes = JSON.parse(market.outcomes);
    const idx = market.outcomePrices.findIndex(p => Number(p) === 1);
    if (idx === -1) return null;
    return outcomes[idx];
  } catch (err) {
    console.error("❌ Failed parsing market outcomes:", err);
    return null;
  }
}

// Wallet eligibility
function checkWalletCriteria(wallet) {
  const MIN_NET_PNL = 1000;
  const MAX_DAILY_LOSS_PERCENT = 0.3;
  const MAX_LOSING_STREAK = 3;
  const MIN_WIN_RATE = 0.7;
  const MIN_PICK_VALUE = 1000;

  const history = wallet.history || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayPnls = wallet.dailyPnls?.filter(d => d.date === today) || [];
  const dailyLossPercent = wallet.totalNetPnl
    ? todayPnls.reduce((acc, p) => (p.pnl < 0 ? acc + Math.abs(p.pnl) : acc), 0) / wallet.totalNetPnl
    : 0;

  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].pnl < 0) streak++;
    else break;
  }

  const winRate = history.length ? history.filter(p => p.pnl > 0).length / history.length : 0;

  const reasons = [];
  if (wallet.totalNetPnl < MIN_NET_PNL) reasons.push("Low net PnL");
  if (dailyLossPercent > MAX_DAILY_LOSS_PERCENT) reasons.push(`Daily loss ${Math.round(dailyLossPercent*100)}%`);
  if (streak > MAX_LOSING_STREAK) reasons.push(`Losing streak ${streak}`);
  if (winRate < MIN_WIN_RATE) reasons.push(`Win rate ${Math.round(winRate*100)}%`);
  if ((history?.[history.length-1]?.pnl || 0) < MIN_PICK_VALUE) reasons.push(`Last pick <${MIN_PICK_VALUE}`);

  return { passed: reasons.length === 0, reasons };
}

async function rebuildWalletLivePicks(forceRebuild = false) {
  // 1️⃣ Fetch wallets
  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return console.log("⚠️ No wallets found");

  const activeWallets = [];
  for (const wallet of wallets) {
    const { passed } = checkWalletCriteria(wallet);
    if (wallet.paused && passed) {
      await supabase.from("wallets").update({ paused: false }).eq("id", wallet.id);
      activeWallets.push(wallet);
    } else if (!wallet.paused && !passed) {
      await supabase.from("wallets").update({ paused: true }).eq("id", wallet.id);
    } else if (!wallet.paused && passed) {
      activeWallets.push(wallet);
    }
  }
  if (!activeWallets.length) return console.log("⚠️ No active wallets");

  // 2️⃣ Fetch eligible signals
  const { data: signals, error } = await supabase
    .from("signals")
    .select("wallet_id, market_id, market_name, event_slug, picked_outcome, pnl, resolved_outcome")
    .in("wallet_id", activeWallets.map(w => w.id))
    .gte("pnl", 1000); // only picks over $1000

  if (error) return console.error("❌ Failed fetching signals:", error.message);
  if (!signals?.length) return console.log("⚠️ No signals for active wallets");

  // 3️⃣ Compute wallet dominant picks
  const walletNetPickMap = new Map();
  for (const sig of signals) {
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    if (!walletNetPickMap.has(key)) {
      walletNetPickMap.set(key, {
        picks: {},
        market_id: sig.market_id,
        resolved_outcome: sig.resolved_outcome || null,
        event_slug: sig.event_slug
      });
    }
    const entry = walletNetPickMap.get(key);
    entry.picks[sig.picked_outcome] = (entry.picks[sig.picked_outcome] || 0) + Number(sig.pnl || 0);
    if (sig.resolved_outcome) entry.resolved_outcome = sig.resolved_outcome;
  }

  const walletFinalPicks = [];
  for (const [key, data] of walletNetPickMap.entries()) {
    const sorted = Object.entries(data.picks).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;
    walletFinalPicks.push({
      wallet_id: parseInt(key.split("||")[0]),
      market_id: data.market_id,
      picked_outcome: sorted[0][0],
      pnl: sorted[0][1],
      resolved_outcome: data.resolved_outcome,
      event_slug: data.event_slug
    });
  }
  if (!walletFinalPicks.length) return;

  // 4️⃣ Aggregate picks per market
  const marketNetPickMap = new Map();
  for (const pick of walletFinalPicks) {
    const marketKey = pick.market_id;
    if (!marketNetPickMap.has(marketKey)) marketNetPickMap.set(marketKey, { outcomes: {}, event_slug: pick.event_slug });
    const entry = marketNetPickMap.get(marketKey);
    if (!entry.outcomes[pick.picked_outcome]) {
      entry.outcomes[pick.picked_outcome] = { totalPnl: 0, walletIds: new Set(), resolved_outcome: pick.resolved_outcome };
    }
    const outcomeData = entry.outcomes[pick.picked_outcome];
    outcomeData.totalPnl += pick.pnl;
    outcomeData.walletIds.add(pick.wallet_id);
    if (!outcomeData.resolved_outcome && pick.resolved_outcome) outcomeData.resolved_outcome = pick.resolved_outcome;
  }

  // 5️⃣ Fetch existing picks
  const marketIds = Array.from(marketNetPickMap.keys());
  const { data: existingPicks } = await supabase.from("wallet_live_picks").select("*").in("market_id", marketIds);

  // 6️⃣ Fetch canonical slugs concurrently
  const marketResolvedMap = {};
  const marketIdToSlug = new Map();
  const BATCH_SIZE = 50;

  await Promise.all(
    walletFinalPicks.map(async pick => {
      const marketId = pick.market_id;
      if (marketResolvedMap[marketId]) return;

      let slug = pick.event_slug;
      try {
        const market = await fetchMarket(slug);
        if (!market) throw new Error("404 Not Found");

        slug = market.slug; // canonical slug
        marketIdToSlug.set(marketId, slug);

        await supabase.from("signals")
          .update({ event_slug: slug })
          .eq("market_id", marketId)
          .catch(() => null);

        const resolved = getResolvedOutcomeFromMarket(market);
        if (!resolved) throw new Error("Could not determine winner");
        marketResolvedMap[marketId] = resolved;

      } catch (err) {
        invalidMarketSlugs.set(slug, err.message);
        await supabase.from("skipped_markets")
          .insert({ slug, reason: err.message, fetched_at: new Date() })
          .catch(() => null);
      }
    })
  );

  // 7️⃣ Build final picks & signals batch (vote threshold enforced)
  const finalLivePicks = [];
  const signalsToUpsert = [];

  for (const [market_id, entry] of marketNetPickMap.entries()) {
    const sortedOutcomes = Object.entries(entry.outcomes).sort((a, b) => b[1].totalPnl - a[1].totalPnl);
    if (!sortedOutcomes.length) continue;

    const [dominantOutcome, data] = sortedOutcomes[0];
    const voteCount = data.walletIds.size;

    // ✅ Skip picks below threshold BEFORE upsert
    if (voteCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const existing = existingPicks?.find(e => e.market_id === market_id && e.picked_outcome === dominantOutcome);
    if (existing) {
      (existing.wallets || []).forEach(w => data.walletIds.add(w));
      data.totalPnl += Number(existing.pnl || 0);
      if (!data.resolved_outcome && existing.resolved_outcome) data.resolved_outcome = existing.resolved_outcome;
    }

    const resolved = data.resolved_outcome || marketResolvedMap[market_id] || null;

    finalLivePicks.push({
      market_id,
      picked_outcome: dominantOutcome,
      wallets: Array.from(data.walletIds),
      vote_count: voteCount,
      pnl: data.totalPnl,
      resolved_outcome: resolved,
      fetched_at: new Date()
    });

    if (resolved) {
      data.walletIds.forEach(wallet_id => {
        signalsToUpsert.push({ wallet_id, market_id, resolved_outcome: resolved });
      });
    }
  }

  if (!finalLivePicks.length) return console.log("⚠️ No picks above vote threshold");

  // 8️⃣ Delete any lingering picks below threshold
  await supabase.from("wallet_live_picks")
    .delete()
    .lt("vote_count", MIN_WALLETS_FOR_SIGNAL);

  // 9️⃣ Batch upsert wallet_live_picks
  for (let i = 0; i < finalLivePicks.length; i += BATCH_SIZE) {
    const batch = finalLivePicks.slice(i, i + BATCH_SIZE);
    await supabase.from("wallet_live_picks")
      .upsert(batch, { onConflict: ["market_id", "picked_outcome"] });
  }

  // 🔟 Batch upsert resolved signals
  if (signalsToUpsert.length) {
    const uniqueSignals = [];
    const seen = new Set();
    for (const s of signalsToUpsert) {
      const key = `${s.wallet_id}||${s.market_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSignals.push(s);
      }
    }

    for (let i = 0; i < uniqueSignals.length; i += BATCH_SIZE) {
      const batch = uniqueSignals.slice(i, i + BATCH_SIZE);
      await supabase.from("signals")
        .upsert(batch, { onConflict: ["wallet_id", "market_id"] });
    }
  }

  if (invalidMarketSlugs.size) {
    console.warn("⚠️ Skipped markets:", Array.from(invalidMarketSlugs.entries()));
  }

  console.log(`✅ Wallet live picks rebuilt & batch synced (${finalLivePicks.length})`);
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
async function updateNotes(slug, pick, confidenceEmoji) {
  // Build the text for this pick
  const text = `⚡️ NEW MARKET PREDICTION
Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}`;

  // Fetch current note content
  const { data: note } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", slug)
    .maybeSingle();

  // Append new note with 2 line breaks
  let newContent = note?.content || "";
  newContent += newContent ? `\n\n${text}` : text;

  // Update Supabase
  await supabase
    .from("notes")
    .update({ content: newContent, public: true })
    .eq("slug", slug);
}

/* ===========================
   Notes Update Helper (Result)
=========================== */
async function updateNotesWithResult(slug, pick, confidenceEmoji) {
  const outcomeEmoji =
    pick.outcome === "WIN" ? "✅" :
    pick.outcome === "LOSS" ? "❌" :
    "";

  const text = `⚡️ RESULT FOR MARKET PREDICTION
Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Outcome: ${pick.outcome} ${outcomeEmoji}`;

  const { data: note } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", slug)
    .maybeSingle();

  let newContent = note?.content || "";
  newContent += newContent ? `\n\n${text}` : text;

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

    const text = `⚡️ NEW MARKET PREDICTION
Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}`;

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
   Result Processing + Telegram + Notes
=========================== */
async function processAndSendResults() {
  const { data: resolvedPicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .not("resolved_outcome", "is", null); // <- changed from .in("outcome", ...)

  if (error) {
    console.error("❌ Failed fetching resolved picks:", error.message);
    return;
  }

  if (!resolvedPicks?.length) return;

  for (const pick of resolvedPicks) {
    // ✅ Must have been sent as a signal first
    if (!pick.signal_sent_at) continue;

    // ✅ Prevent duplicate result alerts
    if (pick.result_sent_at) continue;

    // Determine outcome safely
    const outcome = pick.outcome || 
      (pick.picked_outcome === pick.resolved_outcome ? "WIN" : "LOSS");

    const confidenceEmoji = getConfidenceEmoji(pick.vote_count);
    const outcomeEmoji = outcome === "WIN" ? "✅" : "❌";

    const text = `⚡️ RESULT FOR MARKET PREDICTION
Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Outcome: ${outcome} ${outcomeEmoji}`;

    try {
      await sendTelegram(text, false);
      await updateNotesWithResult("midas-sports", { ...pick, outcome }, confidenceEmoji);

      await supabase
        .from("wallet_live_picks")
        .update({ result_sent_at: new Date(), outcome }) // also update outcome if missing
        .eq("id", pick.id);

      console.log(
        `✅ Sent RESULT for market ${pick.market_id} (${pick.picked_outcome})`
      );

    } catch (err) {
      console.error(
        `❌ Failed sending RESULT for market ${pick.market_id}:`,
        err.message
      );
    }
  }
}

/* ===========================
   Tracker Loop (Enhanced, Safe)
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
    await rebuildWalletLivePicks(true);

    // 4️⃣ Force resolve pending markets safely
    try {
      await forceResolvePendingMarkets();
    } catch (err) {
      console.error("❌ Failed in forceResolvePendingMarkets:", err.message);
    }

    // 5️⃣ Resolve markets safely
    try {
      await resolveMarkets();
    } catch (err) {
      console.error("❌ Failed in resolveMarkets:", err.message);
    }

    // 6️⃣ Process and send results safely
    try {
      await processAndSendResults();
    } catch (err) {
      console.error("❌ Failed in processAndSendResults:", err.message);
    }

    // 7️⃣ Process and send signals safely
    try {
      await processAndSendSignals();
    } catch (err) {
      console.error("❌ Failed in processAndSendSignals:", err.message);
    }

    // 8️⃣ Update wallet metrics safely
    try {
      await updateWalletMetricsJS();
    } catch (err) {
      console.error("❌ Failed in updateWalletMetricsJS:", err.message);
    }

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
