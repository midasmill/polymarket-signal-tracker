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
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "10", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ===========================
   🔥 START HTTP SERVER IMMEDIATELY
=========================== */
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`✅ HTTP server listening on port ${PORT}`);
});

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
      const market = await fetchMarketSafe(sig.event_slug);
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
   Resolve Markets (FINAL — Safe & Deterministic)
   - Updates signals outcomes
   - Updates wallet_live_picks outcomes ONLY if row already exists
   - NEVER creates or mutates votes/wallets
=========================== */
async function resolveMarkets() {
  // 1️⃣ Fetch unresolved signals with a valid event_slug
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

  // 3️⃣ Resolve each event
  for (const [eventSlug, sigs] of Object.entries(signalsByEvent)) {
    try {
      const market = await fetchMarketSafe(eventSlug);
      if (!market || !market.outcome) continue;

      const winningOutcome = market.outcome;

      for (const sig of sigs) {
        const result = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";

        // Skip if already resolved correctly
        if (
          sig.outcome === result &&
          sig.resolved_outcome === winningOutcome
        ) {
          continue;
        }

        // 4️⃣ Update signals table (source of truth)
        const { error: updateSignalError } = await supabase
          .from("signals")
          .update({
            outcome: result,
            resolved_outcome: winningOutcome,
            outcome_at: new Date()
          })
          .eq("id", sig.id);

        if (updateSignalError) {
          console.error(
            `❌ Failed updating signal ${sig.id}:`,
            updateSignalError.message
          );
          continue;
        }

        // 5️⃣ Update wallet_live_picks ONLY if it already exists
        const { data: existingPick, error: pickError } = await supabase
          .from("wallet_live_picks")
          .select("id")
          .eq("market_id", sig.market_id)
          .eq("picked_outcome", sig.picked_outcome)
          .maybeSingle();

        if (pickError) {
          console.error(
            `❌ Error fetching wallet_live_pick for market ${sig.market_id}:`,
            pickError.message
          );
          continue;
        }

        // IMPORTANT: do nothing if rebuild never created this pick
        if (!existingPick) continue;

        const { error: updatePickError } = await supabase
          .from("wallet_live_picks")
          .update({
            outcome: result,
            resolved_outcome: winningOutcome
          })
          .eq("id", existingPick.id);

        if (updatePickError) {
          console.error(
            `❌ Failed updating wallet_live_pick ${existingPick.id}:`,
            updatePickError.message
          );
        }
      }
    } catch (err) {
      console.error(
        `❌ Failed processing signals for event ${eventSlug}:`,
        err.message
      );
    }
  }

  console.log("✅ Markets resolved safely (signals + existing wallet_live_picks only)");
}

/* ===========================
   Resolve Wallet Event Outcome (PnL-weighted & deterministic)
=========================== */
async function resolveWalletEventOutcome(walletId, eventSlug) {
  // 1️⃣ Fetch resolved signals (WIN / LOSS) for this wallet/event
  const { data: signals } = await supabase
    .from("signals")
    .select("picked_outcome, outcome, pnl")
    .eq("wallet_id", walletId)
    .eq("event_slug", eventSlug)
    .in("outcome", ["WIN", "LOSS"]);

  if (!signals?.length) return null;

  // 2️⃣ Aggregate total PnL per picked outcome
  const totals = {};
  for (const sig of signals) {
    if (!sig.picked_outcome || sig.pnl == null) continue;
    totals[sig.picked_outcome] = (totals[sig.picked_outcome] || 0) + Number(sig.pnl);
  }

  const outcomeKeys = Object.keys(totals);
  if (!outcomeKeys.length) return null;

  // 3️⃣ Check for hedges: ignore events where multiple sides are near-equal (<5% diff)
  if (outcomeKeys.length > 1) {
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const [topOutcome, topAmount] = sorted[0];
    const secondAmount = sorted[1]?.[1] ?? 0;
    if (secondAmount > 0 && topAmount / secondAmount < 1.05) return null;
  }

  // 4️⃣ Determine net pick: outcome with highest total PnL
  const sortedTotals = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const [netPick] = sortedTotals[0];

  // 5️⃣ Return the resolved outcome of the net pick
  const majoritySignal = signals.find(s => s.picked_outcome === netPick);
  return majoritySignal?.outcome || null;
}

/* ===========================
   Count Wallet Daily Losses (PnL-aware, per-event)
=========================== */
async function countWalletDailyLosses(walletId) {
  // Start & end of today
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // 1️⃣ Fetch all signals for this wallet that resolved today
  const { data: signals } = await supabase
    .from("signals")
    .select("event_slug, picked_outcome, outcome, pnl")
    .eq("wallet_id", walletId)
    .in("outcome", ["WIN", "LOSS"])
    .gte("outcome_at", start.toISOString())
    .lte("outcome_at", end.toISOString());

  if (!signals?.length) return 0;

  // 2️⃣ Get unique events
  const uniqueEvents = [...new Set(signals.map(s => s.event_slug).filter(Boolean))];
  if (!uniqueEvents.length) return 0;

  let lossCount = 0;

  // 3️⃣ Check net outcome per event
  for (const eventSlug of uniqueEvents) {
    const netOutcome = await resolveWalletEventOutcome(walletId, eventSlug);
    if (netOutcome === "LOSS") lossCount++;
  }

  return lossCount;
}

/* ===========================
   Fetch Leaderboard Wallets (with PnL & volume filters)
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["SPORTS"];
  const periods = ["DAY", "WEEK", "MONTH", "ALL"];

  for (const category of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=20`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });

        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet) continue;

// Skip if PnL < 88,888 or volume exceeds 2× PnL
const MIN_PNL = 88888;
const MAX_VOL_MULTIPLIER = 2;

if ((entry.pnl || 0) < MIN_PNL || (entry.vol || 0) > MAX_VOL_MULTIPLIER * (entry.pnl || 0)) continue;

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
   Track Wallet (Net-Pick / Auto-Resolve Safe + Warning)
=========================== */
async function resolveMarketIdFromSlug(eventSlug) {
  if (!eventSlug) return null;

  if (marketCache.has(eventSlug)) return marketCache.get(eventSlug);

  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${eventSlug}`);
    if (!res.ok) return null;

    const market = await res.json();
    const resolved = {
      market_id: String(market.id),
      polymarket_id: Number(market.id),
      market
    };

    marketCache.set(eventSlug, resolved);
    return resolved;
  } catch (err) {
    console.error(`❌ Failed resolving market for slug ${eventSlug}:`, err);
    return null;
  }
}

async function trackWallet(wallet, forceRebuild = false) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) return;

  // Auto-unpause if win_rate >= 50
  if (wallet.paused && wallet.win_rate >= 50) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // 1️⃣ Fetch wallet positions
  const positions = await fetchWalletPositions(proxyWallet);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing signals to avoid duplicates
  const { data: existingSignals = [] } = await supabase
    .from("signals")
    .select("*")
    .eq("wallet_id", wallet.id);
  const existingTxs = new Set((existingSignals || []).map(s => s.tx_hash));

  // 3️⃣ Aggregate PnL per wallet/event/outcome
  const walletEventMap = new Map();

  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;

    const effectivePnl = pos.cashPnl ?? 0;
    if (!forceRebuild && effectivePnl < 1000 && !pos.resolvedOutcome) continue;

    // Determine picked outcome
    let pickedOutcome;
    const sideValue = (pos.side || "BUY").toUpperCase();
    if (pos.title?.includes(" vs. ")) {
      const [teamA, teamB] = pos.title.split(" vs. ").map(s => s.trim());
      pickedOutcome = sideValue === "BUY" ? teamA : teamB;
    } else if (/Over|Under/i.test(pos.title)) {
      pickedOutcome = sideValue === "BUY" ? "OVER" : "UNDER";
    } else if (pos.resolvedOutcome) {
      pickedOutcome = pos.resolvedOutcome;
    } else {
      pickedOutcome = sideValue === "BUY" ? "YES" : "NO";
    }

    if (!pickedOutcome) {
      console.warn(`Skipping position with undefined outcome: wallet=${wallet.id}, pos=${JSON.stringify(pos)}`);
      continue;
    }

    // Make tx_hash unique with timestamp
    const syntheticTx = [proxyWallet, pos.asset || "", pos.timestamp || "", effectivePnl, Date.now()].join("-");
    if (!forceRebuild && existingTxs.has(syntheticTx)) continue;

    // Resolve market info
    const marketInfo = await resolveMarketIdFromSlug(eventSlug);

    const key = `${wallet.id}||${eventSlug}`;
    if (!walletEventMap.has(key)) {
      walletEventMap.set(key, {
        picks: {},
        market_id: marketInfo?.market_id || null,
        polymarket_id: marketInfo?.polymarket_id || null,
        market_name: marketInfo?.market?.question || pos.title || null,
        market: marketInfo?.market || null,   // ✅ store full market
        event_slug: eventSlug,
        resolved_outcome: pos.resolvedOutcome ?? null,
        outcome_at: pos.outcomeTimestamp ?? null,
        tx_hashes: new Set()
      });
    } else if (marketInfo?.market) {
      // Upgrade existing entry if market not set yet
      const entry = walletEventMap.get(key);
      if (!entry.market) {
        entry.market = marketInfo.market;
        entry.market_id = marketInfo.market_id;
        entry.polymarket_id = marketInfo.polymarket_id;
        entry.market_name = marketInfo.market.question || entry.market_name;
      }
    }

    const entry = walletEventMap.get(key);
    entry.picks[pickedOutcome] = (entry.picks[pickedOutcome] || 0) + Number(effectivePnl);
    entry.tx_hashes.add(syntheticTx);
    if (pos.resolvedOutcome) entry.resolved_outcome = pos.resolvedOutcome;
  }

// 4️⃣ Compute net pick per wallet/event safely
const netSignals = [];
for (const [key, data] of walletEventMap.entries()) {
  const sorted = Object.entries(data.picks).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) continue;

  const wallet_id = parseInt(key.split("||")[0]);
  const picked_outcome = sorted[0][0];
  const pnl = sorted[0][1];

  // Determine side safely
  let side;
  if (/YES|NO|OVER|UNDER/i.test(picked_outcome)) {
    side = picked_outcome.toUpperCase();
  } else {
    const teams = data.market_name?.split(" vs. ").map(s => s.trim());
    side = teams?.[0] === picked_outcome ? "BUY" : "SELL";
  }

  // Compute outcome as Pending/WIN/LOSS
  let outcome = "Pending";
  if (data.resolved_outcome) {
    outcome = data.resolved_outcome === picked_outcome ? "WIN" : "LOSS";
  }

  // Determine event_start_at (use gameStartTime, fallback to events[0].startTime)
  let eventStartAt = null;
  if (data.market?.gameStartTime) {
    eventStartAt = new Date(data.market.gameStartTime);
  } else if (data.market?.events?.[0]?.startTime) {
    eventStartAt = new Date(data.market.events[0].startTime);
  }

  // ✅ Skip signals with missing market_id
  if (!data.market_id) {
    console.warn(
      `⚠️ Skipping signal for wallet=${wallet_id}, eventSlug=${data.event_slug}, picked_outcome=${picked_outcome}: missing market_id`
    );
    continue;
  }

  // Add safe signal to array
  netSignals.push({
    wallet_id,
    market_id: data.market_id,
    polymarket_id: data.polymarket_id,
    market_name: data.market_name || "UNKNOWN",
    event_slug: data.event_slug,

    picked_outcome,
    signal: picked_outcome,
    side: side || "BUY",

    pnl,
    amount: Math.abs(pnl) || null,

    outcome,
    resolved_outcome: data.resolved_outcome ?? null,
    outcome_at: data.outcome_at ?? null,

    win_rate: wallet.win_rate,
    created_at: new Date(),

    event_start_at: eventStartAt,
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

  // 6️⃣ Deduplicate before upsert
  const seenSignals = new Set();
  const dedupedSignals = netSignals.filter(s => {
    const key = `${s.wallet_id}||${s.event_slug}||${s.picked_outcome}||${s.tx_hash}`;
    if (seenSignals.has(key)) return false;
    seenSignals.add(key);
    return true;
  });

  try {
    const { error } = await supabase
      .from("signals")
      .upsert(dedupedSignals, {
        onConflict: ["wallet_id", "event_slug", "picked_outcome"]
      });

    if (error) console.error(`❌ Failed upserting signals for wallet ${wallet.id}:`, error.message);
    else console.log(`✅ Upserted ${dedupedSignals.length} net signal(s) for wallet ${wallet.id}`);
  } catch (err) {
    console.error(`❌ Unexpected upsert error for wallet ${wallet.id}:`, err.message);
  }

  // 7️⃣ Check for warning based on recent PnL or consecutive losses
  const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const { data: recentSignals = [] } = await supabase
    .from("signals")
    .select("pnl")
    .eq("wallet_id", wallet.id)
    .gte("created_at", TWO_DAYS_AGO);

  const totalPnl = (recentSignals || []).reduce((sum, s) => sum + Number(s.pnl || 0), 0);

  const { data: lastSignals = [] } = await supabase
    .from("signals")
    .select("pnl")
    .eq("wallet_id", wallet.id)
    .order("created_at", { ascending: false })
    .limit(10);

  let consecutiveLosses = 0;
  for (const sig of (lastSignals || [])) {
    if ((sig.pnl || 0) < 0) consecutiveLosses++;
    else break;
  }

  if (totalPnl < 0 || consecutiveLosses >= 3) {
    const warningMessage = `Warning: totalPnL=${totalPnl.toFixed(2)}, consecutiveLosses=${consecutiveLosses}`;
    await supabase
      .from("wallets")
      .update({ warning: warningMessage, warning_logged_at: new Date() })
      .eq("id", wallet.id);

    console.log(`⚠️ Wallet ${wallet.id} warning: ${warningMessage}`);
  } else if (wallet.warning) {
    await supabase
      .from("wallets")
      .update({ warning: null, warning_logged_at: null })
      .eq("id", wallet.id);
  }

  // 8️⃣ Update wallet event exposure
  const affectedEvents = [...new Set(dedupedSignals.map(s => s.event_slug))];
  for (const eventSlug of affectedEvents) {
    const totals = await getWalletOutcomeTotals(wallet.id, eventSlug);
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;

    const [netOutcome, netAmount] = entries[0];
    const secondAmount = entries[1]?.[1] ?? 0;
    if (secondAmount > 0 && netAmount / secondAmount < 1.05) continue;

    const marketId = dedupedSignals.find(s => s.event_slug === eventSlug)?.market_id || null;

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

  // 9️⃣ Auto-resolve pending signals
  await autoResolvePendingSignals();

   // --- Insert or upsert signals first ---
await safeInsert("signals", dedupedSignals, {
  upsertColumns: ["wallet_id", "event_slug", "picked_outcome"]
});

// --- Then rebuild live picks/pending safely ---
await safeRebuildLivePicks();

}

/* ===========================
   Safe Insert / Upsert Helper (Verbose + Robust)
=========================== */
async function safeInsert(table, rows, options = {}) {
  if (!rows || !rows.length) return;

  const { upsertColumns = [] } = options;

  try {
    const { error } = await supabase
      .from(table)
      .upsert(rows, {
        onConflict: upsertColumns.length ? upsertColumns : undefined,
        // Optional: return nothing to avoid large responses
        returning: "minimal",
      });

    if (error) {
      console.error(`❌ safeInsert failed for table ${table}:`);
      console.error("Full error object:", JSON.stringify(error, null, 2));
    } else {
      console.log(`✅ Inserted/Upserted ${rows.length} rows into ${table}`);
    }
  } catch (err) {
    console.error(`❌ Exception in safeInsert for table ${table}:`, err.message);
  }
}

/* ===========================
   Universal Market Cache & Fetch (Includes Closed + Resolved)
=========================== */
const marketCache = new Map();

async function fetchMarketSafe({ event_slug, polymarket_id, market_id }, bypassCache = false) {
  if (!event_slug && !polymarket_id && !market_id) return null;
  const cacheKey = event_slug || polymarket_id || market_id;
  if (!bypassCache && marketCache.has(cacheKey)) return marketCache.get(cacheKey);

  try {
    let url = event_slug
      ? `https://gamma-api.polymarket.com/markets/slug/${event_slug}`
      : polymarket_id
      ? `https://gamma-api.polymarket.com/markets/${polymarket_id}`
      : `https://gamma-api.polymarket.com/markets/${market_id}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Polymarket-Tracker/1.0", Accept: "application/json" }
    });
    if (!res.ok) return null;

    const market = await res.json();

    // --- Normalize gameStartTime ---
    // Many APIs use eventTime, startTime, or similar
    market.gameStartTime =
      market.gameStartTime || market.eventTime || market.startTime || null;

    // Auto-detect winner for closed markets if missing
    if (!market.outcome && market.closed && market.outcomePrices && market.outcomes) {
      try {
        let prices = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        let outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
        if (!Array.isArray(prices) && typeof prices === "object") prices = Object.values(prices);
        const winnerIndex = prices.findIndex(p => Number(p) === 1);
        if (winnerIndex !== -1) market.outcome = outcomes[winnerIndex];
      } catch (err) {
        console.error("Market winner parse error:", err.message);
      }
    }

    marketCache.set(cacheKey, market);
    return market;
  } catch (err) {
    console.error("Market fetch error:", err.message);
    return null;
  }
}

/* ===========================
   Rebuild Wallet Live Picks & Pending (Patched + Preserve Resolved + Confidence Stars)
=========================== */
async function rebuildWalletLivePicks(forceRebuild = false) {
  const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "5", 10);
  const marketInfoMap = new Map();

  const CONFIDENCE_THRESHOLDS = {
    "⭐": 10,
    "⭐⭐": 20,
    "⭐⭐⭐": 30,
    "⭐⭐⭐⭐": 40,
    "⭐⭐⭐⭐⭐": 50
  };

  function normalizeOutcome(pickedOutcome, market) {
    if (!pickedOutcome) return "UNKNOWN";
    const trimmed = pickedOutcome.trim();
    const upper = trimmed.toUpperCase();

    // Moneyline normalization
    if (market?.outcomes?.length === 2 && market.sportsMarketType === "moneyline") {
      const [team0, team1] = market.outcomes;
      if (upper === "YES" || upper === "OVER") return team0;
      if (upper === "NO" || upper === "UNDER") return team1;
      if (team0.toUpperCase() === upper) return team0;
      if (team1.toUpperCase() === upper) return team1;
      return trimmed;
    }

    const match = Array.isArray(market?.outcomes)
      ? market.outcomes.find(o => o.toUpperCase() === upper)
      : null;

    return match || trimmed;
  }

  function determineSide(outcome, market) {
    if (!market?.outcomes?.length) return "BUY";
    const [team0] = market.outcomes;
    return outcome === team0 ? "BUY" : "SELL";
  }

  function determineOutcomeStatus(pickedOutcome, resolvedOutcome) {
    if (!resolvedOutcome) return "PENDING";
    return pickedOutcome === resolvedOutcome ? "WIN" : "LOSS";
  }

  function getConfidenceStars(voteCount) {
    let stars = "⭐"; // default 1 star
    for (const [s, threshold] of Object.entries(CONFIDENCE_THRESHOLDS)) {
      if (voteCount >= threshold) stars = s;
    }
    return stars;
  }

  // --- Fetch all signals ---
  const { data: signals, error } = await supabase.from("signals").select("*");
  if (error) return console.error("❌ Failed fetching signals:", error.message);
  if (!signals?.length) return console.log("✅ No signals found");

  console.log(`🔹 Total signals: ${signals.length}`);

  const walletMarketMap = new Map();

  // --- Aggregate PnL per wallet per market ---
  for (const sig of signals) {
    if (!sig.wallet_id || !sig.market_id) continue;

    if (!marketInfoMap.has(sig.market_id)) {
      let market = null;
      try {
        market = await fetchMarketSafe({
          polymarket_id: sig.polymarket_id,
          market_id: sig.market_id,
          event_slug: sig.event_slug
        });
      } catch (err) {
        console.warn(`⚠️ Failed fetching market ${sig.market_id}:`, err.message);
      }

      marketInfoMap.set(sig.market_id, {
        market_name: market?.question || sig.market_name || "UNKNOWN",
        event_slug: market?.slug || sig.event_slug || "UNKNOWN",
        resolved_outcome: sig.resolved_outcome || market?.outcome || null,
        polymarket_id: sig.polymarket_id ? Number(sig.polymarket_id) : null,
        market_url: market?.slug ? `https://polymarket.com/markets/${market.slug}` : null,
        outcomes: market?.outcomes || [],
        sportsMarketType: market?.sportsMarketType || null,
        gameStartTime: sig.event_start_at || null
      });
    }

    const info = marketInfoMap.get(sig.market_id);
    const normalized = normalizeOutcome(sig.picked_outcome, info);
    const key = `${sig.wallet_id}_${sig.market_id}`;

    if (!walletMarketMap.has(key)) walletMarketMap.set(key, {});
    const walletEntry = walletMarketMap.get(key);
    walletEntry[normalized] = (walletEntry[normalized] || 0) + Number(sig.pnl || 0);
  }

  // --- Determine dominant outcome per wallet ---
  const walletDominantMap = new Map();
  for (const [key, outcomeMap] of walletMarketMap.entries()) {
    let dominantOutcome = null;
    let maxPnl = -Infinity;
    for (const [outcome, pnl] of Object.entries(outcomeMap)) {
      if (pnl > maxPnl) {
        maxPnl = pnl;
        dominantOutcome = outcome;
      }
    }
    walletDominantMap.set(key, dominantOutcome);
  }

  // --- Aggregate wallet counts per market & outcome ---
  const marketNetPickMap = new Map();
  for (const [key, dominantOutcome] of walletDominantMap.entries()) {
    const [wallet_id, market_id] = key.split("_");
    if (!marketNetPickMap.has(market_id)) marketNetPickMap.set(market_id, {});
    const outcomes = marketNetPickMap.get(market_id);
    if (!outcomes[dominantOutcome]) outcomes[dominantOutcome] = { walletIds: new Set(), totalPnl: 0 };
    outcomes[dominantOutcome].walletIds.add(Number(wallet_id));
    outcomes[dominantOutcome].totalPnl += walletMarketMap.get(key)[dominantOutcome];
  }

  // --- Normalize YES/NO for moneyline ---
  for (const [market_id, outcomes] of marketNetPickMap.entries()) {
    const info = marketInfoMap.get(market_id);
    if (info?.outcomes?.length === 2) {
      const keys = Object.keys(outcomes);
      for (const key of keys) {
        const normalizedKey = normalizeOutcome(key, { outcomes: info.outcomes, sportsMarketType: "moneyline" });
        if (normalizedKey !== key) {
          if (!outcomes[normalizedKey]) outcomes[normalizedKey] = { walletIds: new Set(), totalPnl: 0 };
          for (const w of outcomes[key].walletIds) outcomes[normalizedKey].walletIds.add(w);
          outcomes[normalizedKey].totalPnl += outcomes[key].totalPnl;
          delete outcomes[key];
        }
      }
    }
  }

  // --- Fetch existing picks to preserve resolved outcomes ---
  const { data: existingPicks } = await supabase.from("wallet_live_picks").select("*");
  const existingMap = new Map();
  for (const pick of existingPicks || []) {
    const key = `${pick.market_id}_${pick.picked_outcome}`;
    existingMap.set(key, pick);
  }

  // --- Build final live picks ---
  const finalLive = [];
  for (const [market_id, outcomes] of marketNetPickMap.entries()) {
    const info = marketInfoMap.get(market_id);

    for (const [outcome, data] of Object.entries(outcomes)) {
      if (data.walletIds.size < MIN_WALLETS_FOR_SIGNAL) continue;

      const key = `${market_id}_${outcome}`;
      let resolvedOutcome = info?.resolved_outcome || null;
      let status = determineOutcomeStatus(outcome, resolvedOutcome);

      // Preserve existing resolved outcome from DB
      if (existingMap.has(key)) {
        resolvedOutcome = existingMap.get(key).resolved_outcome || resolvedOutcome;
        status = determineOutcomeStatus(outcome, resolvedOutcome);
      }

      finalLive.push({
        market_id,
        wallet_id: null,
        market_name: info?.market_name || "UNKNOWN",
        event_slug: info?.event_slug || "UNKNOWN",
        polymarket_id: info?.polymarket_id,
        market_url: info?.market_url,
        gameStartTime: info?.gameStartTime,
        picked_outcome: outcome || "UNKNOWN",
        side: determineSide(outcome, info),
        wallets: Array.from(data.walletIds),
        vote_count: data.walletIds.size,
        vote_counts: Object.fromEntries(Array.from(data.walletIds).map(id => [id, 1])),
        pnl: Number(data.totalPnl),
        outcome: status,
        resolved_outcome: resolvedOutcome,
        fetched_at: new Date(),
        confidence: getConfidenceStars(data.walletIds.size) // ⭐ rating
      });
    }
  }

  // --- Build and deduplicate pending picks ---
  const finalPending = [];
  const seenPendingKeys = new Set();

  for (const sig of signals.filter(s => s.wallet_id && s.market_id && !s.resolved_outcome)) {
    const info = marketInfoMap.get(sig.market_id);
    const normalized = normalizeOutcome(sig.picked_outcome, info);
    const key = `${sig.market_id}_${sig.wallet_id}_${normalized}`;
    if (seenPendingKeys.has(key)) continue;
    seenPendingKeys.add(key);

    finalPending.push({
      market_id: sig.market_id,
      wallet_id: sig.wallet_id,
      market_name: info?.market_name || "UNKNOWN",
      event_slug: info?.event_slug || "UNKNOWN",
      polymarket_id: info?.polymarket_id,
      market_url: info?.market_url,
      gameStartTime: info?.gameStartTime,
      picked_outcome: normalized || "UNKNOWN",
      side: determineSide(normalized, info),
      wallets: [sig.wallet_id],
      vote_count: 1,
      vote_counts: { [sig.wallet_id]: 1 },
      pnl: Number(sig.pnl || 0),
      outcome: "PENDING",
      resolved_outcome: null,
      fetched_at: new Date(),
      confidence: "⭐"
    });
  }

  // --- Insert into tables ---
  await safeInsert("wallet_live_picks", finalLive, { upsertColumns: ["market_id", "picked_outcome"] });
  await safeInsert("wallet_live_pending", finalPending);

  console.log(`✅ Wallet live picks and pending rebuilt: ${finalLive.length} live picks, ${finalPending.length} pending`);
}


/* ===========================
   Fetch Wallet Activity (DATA-API, Robust)
=========================== */
async function fetchWalletPositions(proxyWallet, retries = 3, delayMs = 2000) {
  if (!proxyWallet) throw new Error("Proxy wallet required");

  const url = `https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&user=${proxyWallet}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Polymarket-Tracker/1.0",
          "Accept": "application/json"
        },
        timeout: 10000 // 10s timeout
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (!Array.isArray(data)) return [];

      // Map API data to tracker positions
      return data.map(item => ({
        asset: item.transactionHash || "",
        polymarket_id: item.id || "",       // ✅ updated: use Polymarket API ID
        market_id: item.conditionId || "",  // optional: keep original conditionId if needed
        eventSlug: item.eventSlug || item.slug || "",
        title: item.title || "",
        slug: item.slug || "",
        timestamp: item.timestamp || Math.floor(Date.now() / 1000),
        side: item.side || "BUY",
        cashPnl: Number(item.usdcSize ?? item.size ?? 0),
        resolvedOutcome: item.resolvedOutcome || null, // if available
        outcomeTimestamp: item.outcomeTimestamp || null,
      }));

    } catch (err) {
      console.warn(`⚠️ Attempt ${attempt} failed fetching activity for ${proxyWallet}: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      console.error(`❌ Activity fetch failed (fetchWalletPositions) for ${proxyWallet} after ${retries} attempts`);
      return [];
    }
  }
}

// --- Debounced rebuild helper to avoid overlapping runs ---
let rebuildLock = false;

async function safeRebuildLivePicks(forceRebuild = false) {
  if (rebuildLock) return; // skip if a rebuild is already running
  rebuildLock = true;

  try {
    console.log("🔄 Rebuilding wallet_live_picks and wallet_live_pending...");
    await rebuildWalletLivePicks(forceRebuild);
    console.log("✅ Rebuild complete.");
  } catch (err) {
    console.error("❌ Error during rebuild:", err.message);
  } finally {
    rebuildLock = false;
  }
}


/* ===========================
   Notes Update Helper (with link + event start)
=========================== */
async function updateNotes(slug, pick, confidenceEmoji) {
  const eventName = pick.market_name || pick.event_slug || "UNKNOWN";
  const eventUrl = pick.market_url ? `(${pick.market_url})` : "";
  const eventTime = pick.event_start_at || pick.gameStartTime
    ? new Date(pick.event_start_at || pick.gameStartTime).toLocaleString()
    : "N/A";

  // Build the text
  const text = `⚡️ NEW MARKET PREDICTION
Market Event: ${eventName} ${eventUrl}
Event Start: ${eventTime}
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
   Notes Update Helper (Result, replace previous prediction, with link + event start)
=========================== */
async function updateNotesWithResult(slug, pick, confidenceEmoji) {
  const outcomeEmoji =
    pick.outcome === "WIN" ? "✅" :
    pick.outcome === "LOSS" ? "❌" :
    "";

  const eventName = pick.market_name || pick.event_slug || "UNKNOWN";
  const eventUrl = pick.market_url ? `(${pick.market_url})` : "";
  const eventTime = pick.event_start_at || pick.gameStartTime
    ? new Date(pick.event_start_at || pick.gameStartTime).toLocaleString()
    : "N/A";

  const resultText = `⚡️ RESULT FOR MARKET PREDICTION
Market Event: ${eventName} ${eventUrl}
Event Start: ${eventTime}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Outcome: ${pick.outcome} ${outcomeEmoji}`;

  // Fetch current note content
  const { data: note } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", slug)
    .maybeSingle();

  let newContent = note?.content || "";

  // Regex to find previous NEW MARKET PREDICTION block for this pick
  const escapedEvent = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedOutcome = (pick.picked_outcome || "UNKNOWN").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const regex = new RegExp(
    `⚡️ NEW MARKET PREDICTION\\s*Market Event: ${escapedEvent}.*\\s*Prediction: ${escapedOutcome}[\\s\\S]*?(?=(\\n\\n⚡️|$))`,
    "g"
  );

  if (regex.test(newContent)) {
    newContent = newContent.replace(regex, resultText);
  } else {
    newContent += newContent ? `\n\n${resultText}` : resultText;
  }

  // Update Supabase
  await supabase
    .from("notes")
    .update({ content: newContent, public: true })
    .eq("slug", slug);
}

/* ===========================
   Returns the wallet's NET picked_outcome for an event
   based on total $ amount per side.
   Hedged events (<5% difference) return null safely.
=========================== */
async function getWalletNetPick(walletId, eventSlug) {
  const totals = await getWalletOutcomeTotals(walletId, eventSlug);

  const entries = Object.entries(totals);
  if (entries.length === 0) return null;

  // Sort by total descending
  entries.sort((a, b) => b[1] - a[1]);

  const [topOutcome, topAmount] = entries[0];
  const secondAmount = entries[1]?.[1] ?? 0;

  // Ignore near-equal hedges (<5%)
  if (secondAmount > 0 && topAmount / secondAmount < 1.05) {
    // ⚠️ Hedged event — return null, don't count as win/loss
    return null;
  }

  return topOutcome;
}

/* ===========================
   Wallet Metrics Update
   Auto-pauses wallet if daily loss % exceeds threshold
=========================== */
async function updateWalletMetricsJS() {
  const DAILY_LOSS_PERCENT_LIMIT = 0.5; // 50% losses triggers pause

  const { data: wallets } = await supabase.from("wallets").select("*");
  if (!wallets?.length) return;

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  for (const wallet of wallets) {
    // --- Fetch today's resolved signals for this wallet ---
    const { data: resolvedSignals } = await supabase
      .from("signals")
      .select("event_slug, picked_outcome, outcome")
      .eq("wallet_id", wallet.id)
      .gte("outcome_at", startOfDay.toISOString())
      .lte("outcome_at", endOfDay.toISOString())
      .in("outcome", ["WIN", "LOSS"]);

    if (!resolvedSignals?.length) continue;

    // --- Group by event and compute net pick outcome ---
    const eventsMap = new Map();
    for (const sig of resolvedSignals) {
      if (!sig.event_slug) continue;
      if (!eventsMap.has(sig.event_slug)) eventsMap.set(sig.event_slug, []);
      eventsMap.get(sig.event_slug).push(sig);
    }

    let losses = 0;
    let total = 0;

    for (const [eventSlug, signalsForEvent] of eventsMap.entries()) {
      // Get wallet net pick for this event
      const netPick = await getWalletNetPick(wallet.id, eventSlug);

      // Skip hedged events or unresolved net pick
      if (!netPick) continue;

      const sig = signalsForEvent.find(s => s.picked_outcome === netPick);
      if (!sig) continue;

      total++;
      if (sig.outcome === "LOSS") losses++;
    }

    if (total === 0) continue;

    const lossPercent = losses / total;
    const winRate = Math.round(((total - losses) / total) * 100);

    // --- Auto-pause wallet if loss % exceeds threshold ---
    const shouldPause = lossPercent >= DAILY_LOSS_PERCENT_LIMIT;

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
   Send Signals to Telegram + Notes
   (Patched: Skip already sent, preserve resolved outcomes)
=========================== */
async function processAndSendSignals() {
  const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "5", 10);
  const FORCE_SEND = false;

  const { data: livePicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .is("resolved_outcome", null); // only unresolved

  if (error) return console.error("❌ Failed fetching wallet_live_picks:", error.message);
  if (!livePicks?.length) return;

  for (const pick of livePicks) {
    if (!pick.wallets || pick.wallets.length === 0) continue;
    if (pick.vote_count < MIN_WALLETS_FOR_SIGNAL) continue;
    if (pick.last_confidence_sent && !FORCE_SEND) continue;

    const confidenceEmoji = getConfidenceEmoji(pick.confidence || pick.vote_count);
    const eventName = pick.market_name || pick.event_slug || "UNKNOWN";
    const eventUrl = pick.market_url || "";
    const eventTime = pick.event_start_at || pick.gameStartTime
      ? new Date(pick.event_start_at || pick.gameStartTime).toLocaleString()
      : "N/A";

    const text = `⚡️ NEW MARKET PREDICTION
Market Event: ${eventName}${eventUrl ? ` (${eventUrl})` : ""}
Event Start: ${eventTime}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}`;

    try {
      await sendTelegram(text, false);
      await updateNotes("midas-sports", pick, confidenceEmoji);

      // Patch: only update last_confidence_sent & signal_sent_at; preserve resolved outcome
      await supabase
        .from("wallet_live_picks")
        .update({
          last_confidence_sent: new Date(),
          signal_sent_at: pick.signal_sent_at || new Date(), // do not overwrite if already set
        })
        .eq("market_id", pick.market_id)
        .eq("picked_outcome", pick.picked_outcome);

      console.log(`🚀 Sent signal for market ${pick.market_id} (${pick.picked_outcome})`);
    } catch (err) {
      console.error(`❌ Failed sending signal for market ${pick.market_id}:`, err.message);
    }
  }
}


/* ===========================
   Send Results to Telegram + Notes
   (Patched: Skip duplicates, preserve outcome/resolved_outcome)
=========================== */
async function processAndSendResults() {
  const { data: resolvedPicks, error } = await supabase
    .from("wallet_live_picks")
    .select("*")
    .not("resolved_outcome", "is", null);

  if (error) return console.error("❌ Failed fetching resolved picks:", error.message);
  if (!resolvedPicks?.length) return;

  for (const pick of resolvedPicks) {
    if (!pick.signal_sent_at) continue; // only picks that were sent as signal
    if (pick.result_sent_at) continue; // only send once

    // Patch: Use resolved outcome as authoritative
    const resolvedOutcome = pick.resolved_outcome;
    const outcome = pick.outcome || (pick.picked_outcome === resolvedOutcome ? "WIN" : "LOSS");

    const confidenceEmoji = getConfidenceEmoji(pick.confidence || pick.vote_count);
    const outcomeEmoji = outcome === "WIN" ? "✅" : "❌";

    const eventName = pick.market_name || pick.event_slug || "UNKNOWN";
    const eventUrl = pick.market_url || "";
    const eventTime = pick.event_start_at || pick.gameStartTime
      ? new Date(pick.event_start_at || pick.gameStartTime).toLocaleString()
      : "N/A";

    const text = `⚡️ RESULT FOR MARKET PREDICTION
Market Event: ${eventName}${eventUrl ? ` (${eventUrl})` : ""}
Event Start: ${eventTime}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Outcome: ${outcome} ${outcomeEmoji}`;

    try {
      await sendTelegram(text, false);
      await updateNotesWithResult("midas-sports", pick, confidenceEmoji);

      // Patch: Only set outcome and result_sent_at; preserve resolved_outcome
      await supabase
        .from("wallet_live_picks")
        .update({
          outcome,
          result_sent_at: new Date()
        })
        .eq("id", pick.id);

      console.log(`✅ Sent RESULT for market ${pick.market_id} (${pick.picked_outcome})`);
    } catch (err) {
      console.error(`❌ Failed sending RESULT for market ${pick.market_id}:`, err.message);
    }
  }
}

/* ===========================
   Force Resolve Pending Markets
=========================== */
async function forceResolvePendingMarkets() {
  const { data: pendingSignals, error } = await supabase
    .from("signals")
    .select("*")
    .ilike("outcome", "pending");

  if (error) {
    console.error("❌ Failed fetching pending signals:", error.message);
    return;
  }

  if (!pendingSignals?.length) {
    console.log("✅ No pending signals to resolve");
    return;
  }

  const eventSlugs = [...new Set(pendingSignals.map(s => s.event_slug).filter(Boolean))];

  for (const slug of eventSlugs) {
    try {
      const market = await fetchMarketSafe({ event_slug: slug }, true);
      if (!market || !market.outcome) continue;

      const winningOutcome = market.outcome;

      // Update signals
      for (const sig of pendingSignals.filter(s => s.event_slug === slug)) {
        const newOutcome = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";
        await supabase
          .from("signals")
          .update({
            outcome: newOutcome,
            resolved_outcome: winningOutcome,
            outcome_at: new Date()
          })
          .eq("id", sig.id);
      }

      console.log(`✅ Resolved market ${slug} with outcome: ${winningOutcome}`);
    } catch (err) {
      console.error(`❌ Error resolving event ${slug}:`, err.message);
    }
  }

  // Rebuild picks after force resolve
  try {
    await rebuildWalletLivePicks(true);
  } catch (err) {
    console.error("❌ Failed rebuilding wallet live picks:", err.message);
  }

  console.log(`🚀 Force-resolve complete for ${eventSlugs.length} market(s)`);
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning = false;

async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    // 0️⃣ Check if signals table is empty → full rebuild if needed
    let forceRebuildSignals = true;
    try {
      const { data: allSignals, error: sigError } = await supabase.from("signals").select("id").limit(1);
      if (!sigError) forceRebuildSignals = !allSignals?.length;
    } catch (err) {
      console.error("❌ Error checking signals:", err);
      forceRebuildSignals = true;
    }

    // 1️⃣ Fetch all active wallets
    let wallets = [];
    try {
      const { data, error } = await supabase.from("wallets").select("*");
      if (!error && data?.length) wallets = data;
      if (!wallets.length) return;
    } catch (err) {
      console.error("❌ Failed fetching wallets:", err);
      return;
    }

    // 2️⃣ Track each wallet
    await Promise.allSettled(wallets.map(wallet =>
      trackWallet(wallet, forceRebuildSignals)
        .catch(err => console.error(`❌ Failed tracking wallet ${wallet.id}:`, err))
    ));

    // 3️⃣ Force resolve pending markets **before rebuilding picks**
    try {
      await forceResolvePendingMarkets();
    } catch (err) {
      console.error("❌ Failed in forceResolvePendingMarkets:", err);
    }

    // 4️⃣ Rebuild wallet live picks and pending (preserves resolved)
    try {
      await rebuildWalletLivePicks(forceRebuildSignals);
    } catch (err) {
      console.error("❌ Failed rebuilding wallet live picks:", err);
    }

    // 5️⃣ Resolve markets
    try {
      await resolveMarkets();
    } catch (err) {
      console.error("❌ Failed in resolveMarkets:", err);
    }

    // 6️⃣ Process and send results
    try {
      await processAndSendResults();
    } catch (err) {
      console.error("❌ Failed in processAndSendResults:", err);
    }

    // 7️⃣ Process and send signals
    try {
      await processAndSendSignals();
    } catch (err) {
      console.error("❌ Failed in processAndSendSignals:", err);
    }

    // 8️⃣ Update wallet metrics
    try {
      await updateWalletMetricsJS();
    } catch (err) {
      console.error("❌ Failed in updateWalletMetricsJS:", err);
    }

  } catch (err) {
    console.error("❌ Tracker loop failed:", err);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try {
    await fetchAndInsertLeaderboardWallets(safeInsert);
  } catch (err) {
    console.error("❌ Failed initial leaderboard fetch:", err);
  }

  await trackerLoop();

  // Continuous polling
  setInterval(trackerLoop, POLL_INTERVAL);

  // Daily cron: leaderboard refresh + rebuild picks
  cron.schedule("0 7 * * *", async () => {
    console.log("📅 Daily cron running...");
    try {
      await fetchAndInsertLeaderboardWallets(safeInsert);
      await trackerLoop();
      await rebuildWalletLivePicks(true); // force rebuild preserves resolved outcomes
    } catch (err) {
      console.error("❌ Daily cron failed:", err);
    }
  }, { timezone: TIMEZONE });

  // Heartbeat
  setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);
}

main();
