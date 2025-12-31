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
   Returns total $ amount picked pere outcome for a wallet for an event
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
   Returns wallet's NET picked_outcome for an event based on total $ amount per side
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
    marketCache.set(eventSlug, market);

    // ✅ Determine winning outcome for resolved/closed markets
    if (market.closed && market.automaticallyResolved) {
      // Outcomes array is ["USC","TCU"], description explains rules
      // Check which side won using market.description or market.events[0].score
      const event = market.events?.[0];
      if (event) {
        const outcomes = market.outcomes || [];
        // Example rule: if score shows USC won, pick "USC"
        if (event.score) {
          const [scoreA, scoreB] = event.score.split("-").map(Number);
          if (scoreA > scoreB) market.outcome = outcomes[0]; // first outcome wins
          else if (scoreB > scoreA) market.outcome = outcomes[1]; // second outcome wins
          else market.outcome = null; // tie, optional
        }
      }
    }

    return market;
  } catch (err) {
    console.error(`❌ fetchMarket failed for ${eventSlug}:`, err.message);
    return null;
  }
}

function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(([, a], [, b]) => b - a);
  for (const [emoji, threshold] of entries) if (count >= threshold) return emoji;
  return "";
}

/* ===========================
   Notes Update Helper (with proper line breaks)
=========================== */
async function updateNotes(slug, marketId, pickedOutcome, text) {
  const anchor = buildNotesAnchor(marketId, pickedOutcome);
  const block = `${anchor}\n${text.trim()}`;

  // Fetch existing notes
  const { data: notes } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", slug)
    .maybeSingle();

  let content = notes?.content || "";

  const anchorRegex = new RegExp(
    `${anchor}[\\s\\S]*?(?=<!-- MARKET:|$)`,
    "g"
  );

  if (anchorRegex.test(content)) {
    // 🔁 Replace existing block
    content = content.replace(anchorRegex, `${block}\n\n`);
  } else {
    // 🆕 Append new block
    content += content ? `\n\n${block}` : block;
  }

  await supabase
    .from("notes")
    .update({ content, public: true })
    .eq("slug", slug);
}

function buildNotesAnchor(marketId, pickedOutcome) {
  return `<!-- MARKET:${marketId}:${pickedOutcome} -->`;
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
   Resolve Market + Send Notifications (No Duplicates)
=========================== */
async function resolveMarkets() {
  const { data: pending, error } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending")
    .not("event_slug", "is", null);

  if (error || !pending?.length) return;

  // 1️⃣ Deduplicate by market
  const seenMarkets = new Set();

  for (const sig of pending) {
    if (seenMarkets.has(sig.market_id)) continue;
    seenMarkets.add(sig.market_id);

    const market = await fetchMarket(sig.event_slug);
    if (!market) continue;

    const isResolved =
      market.closed &&
      (market.automaticallyResolved || market.events?.[0]?.ended);

    if (!isResolved) continue;

    let winningOutcome = market.outcome;

    // 2️⃣ Fallback resolution
    if (!winningOutcome && market.events?.[0]?.score && market.outcomes?.length >= 2) {
      const [a, b] = market.events[0].score.split("-").map(Number);
      if (a > b) winningOutcome = market.outcomes[0];
      else if (b > a) winningOutcome = market.outcomes[1];
    }

    if (!winningOutcome) {
      console.warn(`⚠️ Could not determine winning outcome for market ${sig.market_id}`);
      continue;
    }

    const now = new Date();

    // 3️⃣ Update ALL related signals atomically
    const { data: signalsToResolve } = await supabase
      .from("signals")
      .select("id,picked_outcome")
      .eq("market_id", sig.market_id)
      .eq("outcome", "Pending");

    for (const s of signalsToResolve || []) {
      const result =
        s.picked_outcome.trim().toUpperCase() ===
        winningOutcome.trim().toUpperCase()
          ? "WIN"
          : "LOSS";

      await supabase
        .from("signals")
        .update({
          outcome: result,
          resolved_outcome: winningOutcome,
          outcome_at: now
        })
        .eq("id", s.id);
    }

    // 4️⃣ Update wallet_live_picks result (no notification yet)
    const { data: livePick } = await supabase
      .from("wallet_live_picks")
      .select("*")
      .eq("market_id", sig.market_id)
      .single();

    if (!livePick) continue;

    const result =
      livePick.picked_outcome.trim().toUpperCase() ===
      winningOutcome.trim().toUpperCase()
        ? "WIN"
        : "LOSS";

    await supabase
      .from("wallet_live_picks")
      .update({
        outcome: result,
        resolved_outcome: winningOutcome
      })
      .eq("id", livePick.id);

    console.log(`✅ Resolved market ${sig.market_id}: ${winningOutcome}`);

    // 5️⃣ Atomic notification lock
    const { data: locked } = await supabase
      .from("wallet_live_picks")
      .update({ resolved_sent_at: now })
      .eq("id", livePick.id)
      .is("resolved_sent_at", null)
      .select("id")
      .single();

    if (!locked) {
      console.log(`⚪ Resolved alert already sent, skipping.`);
      continue;
    }

    // 6️⃣ Send notification + edit Notes
    try {
      const outcomeEmoji = RESULT_EMOJIS[result] || "";
      const text = `📢 MARKET PREDICTION RESOLVED
Market Event: ${sig.market_name || sig.event_slug}
Prediction: ${livePick.picked_outcome}
Result: ${result} ${outcomeEmoji}
Resolved At: ${now.toLocaleString("en-US", {
        timeZone: "America/New_York"
      })} EST`;

      await sendTelegram(text, false);

      await updateNotes(
        "midas-sports",
        sig.market_id,
        livePick.picked_outcome,
        text.trim()
      );

      console.log(`✅ Sent resolved notification for market ${sig.market_id}`);
    } catch (err) {
      console.error(
        `❌ Failed resolved notification for market ${sig.market_id}:`,
        err.message
      );
    }
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
   Fetch Wallet Activity (DATA-API)
=========================== */
async function fetchWalletActivity(proxyWallet, retries = 3) {
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
   Track Wallet (Enhanced / Safe)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`[TRACK] Wallet ${wallet.id} has no proxy, skipping`);
    return 0; // return 0 signals
  }

  // Auto-unpause if win_rate >= 80%
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
    console.log(`[TRACK] Wallet ${wallet.id} auto-unpaused (win_rate=${wallet.win_rate})`);
  }

  // 1️⃣ Fetch positions from Polymarket
  const positions = await fetchWalletActivity(proxyWallet);
  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return 0;

  // 2️⃣ Fetch existing signals ONCE
  const { data: existingSignals = [] } = await supabase
    .from("signals")
    .select("wallet_id, event_slug, picked_outcome, tx_hash")
    .eq("wallet_id", wallet.id);

  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));
  const existingEventOutcome = new Set(
    existingSignals.map(s => `${s.event_slug}||${s.picked_outcome}`)
  );

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

    // ✅ Skip if SAME wallet already picked SAME outcome for this event
    if (existingEventOutcome.has(`${eventSlug}||${pickedOutcome}`)) continue;

    // 4️⃣ Generate synthetic tx hash
    const syntheticTx = [
      proxyWallet,
      pos.asset || "",
      pos.timestamp || Date.now(),
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
      event_start_at: market?.eventStartAt ? new Date(market.eventStartAt) : null
    });
  }

  if (!newSignals.length) {
    console.log(`[TRACK] Wallet ${wallet.id} has no new signals to insert`);
    return 0;
  }

  // 7️⃣ Upsert signals safely with unique constraint
  const { error, data } = await supabase
    .from("signals")
    .upsert(newSignals, {
      onConflict: ["wallet_id", "event_slug", "picked_outcome"]
    });

  if (error) {
    console.error(
      `❌ Failed inserting/upserting signals for wallet ${wallet.id}:`,
      error.message
    );
    return 0;
  } else {
    console.log(
      `✅ Wallet ${wallet.id} inserted/updated ${data.length} signal(s)`
    );
    return data.length; // return number of signals inserted
  }
}

/* ===========================
   Wallet Metrics Update
=========================== */
async function updateWalletMetricsJS() {
  const { data: wallets, error } = await supabase
    .from("wallets")
    .select("*");

  if (error || !wallets?.length) return;

  for (const wallet of wallets) {
    // 1️⃣ Fetch resolved signals for this wallet
    const { data: resolvedSignals } = await supabase
      .from("signals")
      .select("event_slug, picked_outcome, outcome")
      .eq("wallet_id", wallet.id)
      .in("outcome", ["WIN", "LOSS"]);

    if (!resolvedSignals?.length) continue;

    // 2️⃣ Group signals by event
    const eventsMap = new Map();
    for (const sig of resolvedSignals) {
      if (!sig.event_slug) continue;
      if (!eventsMap.has(sig.event_slug)) {
        eventsMap.set(sig.event_slug, []);
      }
      eventsMap.get(sig.event_slug).push(sig);
    }

    let wins = 0;
    let losses = 0;

    // 3️⃣ Resolve net pick per event
    for (const [eventSlug, signalsForEvent] of eventsMap.entries()) {
      const netPick = await getWalletNetPick(wallet.id, eventSlug);
      if (!netPick) continue;

      const sig = signalsForEvent.find(
        s => s.picked_outcome === netPick
      );
      if (!sig) continue;

      if (sig.outcome === "WIN") wins++;
      if (sig.outcome === "LOSS") losses++;
    }

    // 4️⃣ Compute final metrics ONCE
    const total = wins + losses;
    const winRate = total > 0
      ? Math.round((wins / total) * 100)
      : 0;

    // 5️⃣ Count daily losses once
    const dailyLosses = await countWalletDailyLosses(wallet.id);
    const shouldPause = dailyLosses >= 3;

    // 6️⃣ Single wallet update
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
   Rebuild Wallet Live Picks + Send Signals
=========================== */
async function rebuildAndSendLivePicks() {
  console.log("🔄 Rebuilding wallet live picks and sending signals...");

  // 1️⃣ Fetch all pending signals with wallet info
  const { data: signals, error } = await supabase
    .from("signals")
    .select(`
      wallet_id,
      market_id,
      market_name,
      event_slug,
      picked_outcome,
      pnl,
      wallets!inner (
        paused,
        win_rate
      )
    `)
    .eq("outcome", "Pending");

  if (error) {
    console.error("❌ Failed fetching signals:", error.message);
    return;
  }
  if (!signals?.length) {
    console.log("⚪ No pending signals found.");
    return;
  }

  console.log(`📊 Fetched ${signals.length} pending signals.`);

  // 2️⃣ Aggregate picks per market/outcome (eligible wallets only)
  const picksMap = new Map();
  for (const sig of signals) {
    if (sig.wallets.paused || sig.wallets.win_rate < WIN_RATE_THRESHOLD || (sig.pnl ?? 0) < 1000)
      continue;

    const key = `${sig.market_id}||${sig.picked_outcome}`;
    if (!picksMap.has(key)) picksMap.set(key, { ...sig, wallets: [], vote_count: 0 });
    const pick = picksMap.get(key);

    pick.wallets.push(sig.wallet_id);
    pick.vote_count++;
  }

  // 3️⃣ Filter by MIN_WALLETS_FOR_SIGNAL and prepare final picks
  const finalPicks = [];
  for (const pick of picksMap.values()) {
    if (pick.vote_count < MIN_WALLETS_FOR_SIGNAL) {
      console.log(`⚠️ Skipping ${pick.event_slug} (${pick.picked_outcome}) — only ${pick.vote_count} wallet(s) eligible.`);
      continue;
    }

    finalPicks.push({
      market_id: pick.market_id,
      market_name: pick.market_name,
      event_slug: pick.event_slug,
      picked_outcome: pick.picked_outcome,
      wallets: pick.wallets,
      vote_count: pick.vote_count,
      confidence: pick.vote_count,
      fetched_at: new Date()
    });

    console.log(`🏆 Final pick ${pick.event_slug}: ${pick.picked_outcome} (${pick.vote_count} wallets)`);
  }

  if (!finalPicks.length) {
    console.log("⚪ No final live picks to upsert.");
    return;
  }

  // 4️⃣ Fetch existing live picks once
  const { data: existingPicks } = await supabase
    .from("wallet_live_picks")
    .select("*");

  const existingMap = new Map(
    (existingPicks || []).map(p => [`${p.market_id}||${p.picked_outcome}`, p])
  );

  // 5️⃣ Upsert picks while preserving notification flags
  const upserts = finalPicks.map(pick => {
    const existing = existingMap.get(`${pick.market_id}||${pick.picked_outcome}`);
    return {
      ...pick,
      signal_sent_at: existing?.signal_sent_at ?? null,
      last_confidence_sent: existing?.last_confidence_sent ?? null,
      result_sent_at: existing?.result_sent_at ?? null,
      resolved_sent_at: existing?.resolved_sent_at ?? null,
      outcome: existing?.outcome ?? null,
      resolved_outcome: existing?.resolved_outcome ?? null,
      outcome_at: existing?.outcome_at ?? null
    };
  });

  await supabase
    .from("wallet_live_picks")
    .upsert(upserts, { onConflict: ["market_id", "picked_outcome"] });

  console.log(`✅ Wallet live picks rebuilt (${finalPicks.length} final picks).`);

  // 6️⃣ Send notifications for picks that haven't been sent
  const now = new Date();
  for (const pick of upserts) {
    if ((FORCE_SEND || !pick.signal_sent_at) && pick.vote_count >= MIN_WALLETS_FOR_SIGNAL) {
      if (FORCE_SEND) console.warn(`⚠️ FORCE_SEND ENABLED — resending signal for ${pick.event_slug}`);
      const confidenceEmoji = getConfidenceEmoji(pick.vote_count);

      const text = `⚡️ NEW MARKET PREDICTION
Market Event: ${pick.market_name || pick.event_slug}
Prediction: ${pick.picked_outcome || "UNKNOWN"}
Confidence: ${confidenceEmoji}
Signal Sent: ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} EST`;

      try {
        await sendTelegram(text, false);
        await updateNotes("midas-sports", pick.market_id, pick.picked_outcome, text.trim());

        // Mark as sent
        await supabase
          .from("wallet_live_picks")
          .update({ signal_sent_at: now, last_confidence_sent: now })
          .eq("market_id", pick.market_id)
          .eq("picked_outcome", pick.picked_outcome);

        console.log(`✅ Sent signal for market ${pick.market_id} (${pick.picked_outcome})`);
      } catch (err) {
        console.error(`❌ Failed sending signal for market ${pick.market_id}:`, err.message);
      }
    }
  }
}

/* ===========================
   Fetch Leaderboard Wallets (with PnL & volume filters)
   Returns array of inserted wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL", "SPORTS"];
  const periods = ["DAY", "WEEK"];
  const insertedWallets = [];

  for (const cat of categories) {
    for (const period of periods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${cat}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl < 1000000 || entry.vol >= 2 * entry.pnl) continue;

          // Check if wallet already exists
          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .eq("polymarket_proxy_wallet", proxyWallet)
            .maybeSingle();
          if (existing) continue;

          // Insert new wallet
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

          console.log(`🆕 New wallet added: ${proxyWallet} (${entry.userName || "unknown"})`);

          // Add to array for main tracking
          insertedWallets.push(insertedWallet);
        }

      } catch (err) {
        console.error(`Leaderboard fetch failed (${cat}/${period}):`, err.message);
      }
    }
  }

  return insertedWallets;
}

/* ===========================
   Tracker Loop (Enhanced with Signal Count + Total)
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return;
  isTrackerRunning = true;

  try {
    console.log("🔄 Tracker loop started...");

    // 1️⃣ Fetch all active wallets
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("*");

    if (walletsError) {
      console.error("❌ Failed fetching wallets:", walletsError.message);
      return;
    }
    if (!wallets?.length) {
      console.log("⚪ No wallets to track.");
      return;
    }

    // 2️⃣ Track wallets concurrently and log signals fetched
    let totalSignals = 0;
    await Promise.all(
      wallets.map(async (wallet) => {
        const count = await trackWallet(wallet);
        console.log(`[TRACK] Wallet ${wallet.id} (${wallet.polymarket_proxy_wallet}) fetched ${count} new signal(s)`);
        totalSignals += count;
      })
    );

    // 3️⃣ Rebuild wallet live picks AND send signals in one step
    await rebuildAndSendLivePicks();

    // 4️⃣ Resolve resolved markets
    await resolveMarkets();

    // 5️⃣ Update wallet metrics (win_rate, paused, daily losses)
    await updateWalletMetricsJS();

    console.log(`✅ Tracker loop completed. Total new signals fetched: ${totalSignals}`);

  } catch (err) {
    console.error("❌ Tracker loop failed:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Entry (Enhanced Logging)
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // 1️⃣ Initial leaderboard fetch
  console.log("📥 Fetching leaderboard wallets...");
  const newWallets = await fetchAndInsertLeaderboardWallets();

  if (newWallets?.length) {
    console.log(`📊 Total new leaderboard wallets inserted: ${newWallets.length}`);
  } else {
    console.log("⚪ No new leaderboard wallets inserted.");
  }

  // 2️⃣ Track all wallets immediately
  await trackerLoop();

  // 3️⃣ Continuous polling
  setInterval(trackerLoop, POLL_INTERVAL);

  // 4️⃣ Daily cron for leaderboard refresh
  cron.schedule("0 7 * * *", async () => {
    console.log("📅 Daily cron running...");
    const dailyNewWallets = await fetchAndInsertLeaderboardWallets();
    if (dailyNewWallets?.length) {
      console.log(`📊 Daily new wallets inserted: ${dailyNewWallets.length}`);
    }
    await trackerLoop();
  }, { timezone: TIMEZONE });

  // 5️⃣ Heartbeat log every 60 seconds
  setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

  // 6️⃣ HTTP server for health check
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Polymarket tracker running\n");
  }).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
}
