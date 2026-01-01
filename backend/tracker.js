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
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "3", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true";

const CONFIDENCE_THRESHOLDS = {
  "⭐": 3,
  "⭐⭐": 10,
  "⭐⭐⭐": 15,
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
   Resolve Markets (Fixed)
=========================== */
async function resolveMarkets() {
  // 1️⃣ Fetch all signals linked to events with a resolved outcome
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .not("event_slug", "is", null);

  if (!signals?.length) return;

  // 2️⃣ Group signals by event_slug
  const signalsByEvent = signals.reduce((acc, sig) => {
    if (!acc[sig.event_slug]) acc[sig.event_slug] = [];
    acc[sig.event_slug].push(sig);
    return acc;
  }, {});

  for (const [eventSlug, sigs] of Object.entries(signalsByEvent)) {
    const market = await fetchMarket(eventSlug);
    if (!market || !market.outcome) continue; // skip if no outcome yet
    const winningOutcome = market.outcome;

    for (const sig of sigs) {
      const result = sig.picked_outcome === winningOutcome ? "WIN" : "LOSS";

      // 3️⃣ Update signals table
      await supabase
        .from("signals")
        .update({
          outcome: result,
          resolved_outcome: winningOutcome,
          outcome_at: new Date()
        })
        .eq("id", sig.id);

      // 4️⃣ Upsert/update wallet_live_picks table safely
      //    Aggregate vote_count & wallets array if multiple wallets picked same outcome
      const { data: existingPick } = await supabase
        .from("wallet_live_picks")
        .select("*")
        .eq("market_id", sig.market_id)
        .eq("picked_outcome", sig.picked_outcome)
        .single()
        .catch(() => ({ data: null }));

      if (existingPick) {
        // Update existing row
        const updatedWallets = Array.from(new Set([...existingPick.wallets, sig.wallet_id]));
        await supabase
          .from("wallet_live_picks")
          .update({
            vote_count: updatedWallets.length,
            wallets: updatedWallets,
            outcome: result,
            resolved_outcome: winningOutcome,
            result_sent_at: new Date()
          })
          .eq("id", existingPick.id);
      } else {
        // Insert new row
        await supabase
          .from("wallet_live_picks")
          .insert({
            wallet_id: sig.wallet_id,
            market_id: sig.market_id,
            picked_outcome: sig.picked_outcome,
            side: sig.side,
            pnl: sig.pnl,
            outcome: result,
            resolved_outcome: winningOutcome,
            vote_count: 1,
            wallets: [sig.wallet_id],
            market_name: sig.market_name,
            event_slug: sig.event_slug,
            fetched_at: new Date(),
            result_sent_at: new Date(),
            signal_sent_at: sig.signal_sent_at
          });
      }
    }
  }

  console.log(`✅ All markets resolved and wallet_live_picks updated`);
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
   Track Wallet (Net-Pick / Fixed / Update Existing Signals)
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) {
    console.warn(`[TRACK] Wallet ${wallet.id} has no proxy, skipping`);
    return;
  }

  // Auto-unpause if win_rate >= 80
  if (wallet.paused && wallet.win_rate >= 80) {
    await supabase
      .from("wallets")
      .update({ paused: false })
      .eq("id", wallet.id);
  }

  // 1️⃣ Fetch positions
  const positions = await fetchWalletPositions(proxyWallet);
  console.log(`[TRACK] Wallet ${wallet.id} fetched ${positions.length} activities`);
  if (!positions?.length) return;

  // 2️⃣ Fetch existing tx hashes once
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("tx_hash")
    .eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));

  // 3️⃣ Aggregate PNL per wallet/event per outcome
  const walletEventMap = new Map();
  for (const pos of positions) {
    const eventSlug = pos.eventSlug || pos.slug;
    if (!eventSlug) continue;
    if ((pos.cashPnl ?? 0) < 1000) continue; // min size filter

    // Determine picked_outcome
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

    // Generate synthetic tx hash
    const syntheticTx = [proxyWallet, pos.asset, pos.timestamp, pos.cashPnl].join("-");
    if (existingTxs.has(syntheticTx)) continue;

    // Aggregate per wallet/event
    const key = `${wallet.id}||${eventSlug}`;
    if (!walletEventMap.has(key)) {
      walletEventMap.set(key, {
        picks: {},
        market_id: pos.conditionId,
        market_name: pos.title,
        event_slug: eventSlug
      });
    }

    const entry = walletEventMap.get(key);
    entry.picks[pickedOutcome] = (entry.picks[pickedOutcome] || 0) + Number(pos.cashPnl || 0);
  }

  // 4️⃣ Compute net pick per wallet/event
  const netSignals = [];
  for (const [key, data] of walletEventMap.entries()) {
    const sorted = Object.entries(data.picks).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;

    const wallet_id = parseInt(key.split("||")[0]);
    const picked_outcome = sorted[0][0];
    const pnl = sorted[0][1];

    // Determine side based on outcome type
    let side;
    if (/YES|NO/i.test(picked_outcome)) {
      side = picked_outcome.toUpperCase();
    } else if (/OVER|UNDER/i.test(picked_outcome)) {
      side = picked_outcome.toUpperCase();
    } else {
      const teams = data.market_name?.split(" vs. ").map(s => s.trim());
      side = teams?.[0] === picked_outcome ? "BUY" : "SELL";
    }

    netSignals.push({
      wallet_id,
      market_id: data.market_id,
      market_name: data.market_name,
      event_slug: data.event_slug,
      picked_outcome,
      pnl,
      signal: data.market_name || picked_outcome || "UNKNOWN",
      side,
      outcome: "Pending",
      resolved_outcome: null,
      outcome_at: null,
      win_rate: wallet.win_rate,
      created_at: new Date(),
      event_start_at: null,
      tx_hash: [proxyWallet, data.market_id, picked_outcome].join("-") // optional unique hash
    });
  }

  if (!netSignals.length) return;

  // 5️⃣ DELETE old signals that are NOT the net pick
  for (const sig of netSignals) {
    await supabase
      .from("signals")
      .delete()
      .eq("wallet_id", sig.wallet_id)
      .eq("event_slug", sig.event_slug)
      .neq("picked_outcome", sig.picked_outcome);
  }

  // 6️⃣ Upsert net signals (update existing or insert new)
  for (const sig of netSignals) {
    const { data: existing } = await supabase
      .from("signals")
      .select("*")
      .eq("wallet_id", sig.wallet_id)
      .eq("event_slug", sig.event_slug)
      .eq("picked_outcome", sig.picked_outcome)
      .single()
      .catch(() => null);

    if (existing) {
      await supabase
        .from("signals")
        .update({
          pnl: sig.pnl,
          side: sig.side,
          signal: sig.signal,
          win_rate: sig.win_rate,
          created_at: sig.created_at
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("signals").insert([sig]);
    }
  }

  console.log(`✅ Upserted ${netSignals.length} net signal(s) for wallet ${wallet.id}`);

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
}


/* ===========================
   Rebuild Wallet Live Picks (Dominant Net Pick Per Market – Merge Existing & Min Wallets)
=========================== */
async function rebuildWalletLivePicks() {
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
    .eq("outcome", "Pending")
    .eq("wallets.paused", false)
    .gte("wallets.win_rate", WIN_RATE_THRESHOLD)
    .gte("pnl", 1000);

  if (error || !signals?.length) return;

  // 1️⃣ Compute net pick per wallet per event
  const walletNetPickMap = new Map();
  for (const sig of signals) {
    const key = `${sig.wallet_id}||${sig.event_slug}`;
    if (!walletNetPickMap.has(key)) {
      walletNetPickMap.set(key, {
        picks: {},
        market_id: sig.market_id,
        market_name: sig.market_name,
        event_slug: sig.event_slug
      });
    }
    const entry = walletNetPickMap.get(key);
    entry.picks[sig.picked_outcome] = (entry.picks[sig.picked_outcome] || 0) + Number(sig.pnl || 0);
  }

  // 2️⃣ Determine each wallet's net pick
  const walletFinalPicks = [];
  for (const [key, data] of walletNetPickMap.entries()) {
    const sorted = Object.entries(data.picks).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) continue;

    walletFinalPicks.push({
      wallet_id: parseInt(key.split("||")[0]),
      market_id: data.market_id,
      market_name: data.market_name,
      event_slug: data.event_slug,
      picked_outcome: sorted[0][0],
      pnl: sorted[0][1]
    });
  }

  // 3️⃣ Aggregate across wallets per market
  const marketNetPickMap = new Map();
  for (const pick of walletFinalPicks) {
    const marketKey = pick.market_id;
    if (!marketNetPickMap.has(marketKey)) {
      marketNetPickMap.set(marketKey, {
        market_id: pick.market_id,
        market_name: pick.market_name,
        event_slug: pick.event_slug,
        outcomes: {}
      });
    }
    const entry = marketNetPickMap.get(marketKey);

    if (!entry.outcomes[pick.picked_outcome]) {
      entry.outcomes[pick.picked_outcome] = { totalPnl: 0, walletIds: new Set() };
    }

    entry.outcomes[pick.picked_outcome].totalPnl += pick.pnl;
    entry.outcomes[pick.picked_outcome].walletIds.add(pick.wallet_id);
  }

  // 4️⃣ Merge with existing wallet_live_picks and apply minimum wallet filter
  const finalLivePicks = [];
  for (const entry of marketNetPickMap.values()) {
    // Fetch existing live picks for this market
    const { data: existing } = await supabase
      .from("wallet_live_picks")
      .select("*")
      .eq("market_id", entry.market_id);

    // Merge wallets & PNL if same outcome exists
    const mergedOutcomes = { ...entry.outcomes };
    if (existing?.length) {
      for (const ex of existing) {
        const outcome = ex.picked_outcome;
        if (!mergedOutcomes[outcome]) {
          mergedOutcomes[outcome] = { totalPnl: 0, walletIds: new Set() };
        }
        ex.wallets?.forEach(w => mergedOutcomes[outcome].walletIds.add(w));
        mergedOutcomes[outcome].totalPnl += Number(ex.pnl || 0);
      }
    }

    // Choose dominant outcome (largest total PNL)
    const sortedOutcomes = Object.entries(mergedOutcomes)
      .sort((a, b) => b[1].totalPnl - a[1].totalPnl);
    if (!sortedOutcomes.length) continue;

    const [dominantOutcome, data] = sortedOutcomes[0];
    const voteCount = data.walletIds.size;

    // 🔹 Skip if fewer wallets than minimum required
    if (voteCount < MIN_WALLETS_FOR_SIGNAL) continue;

    // Compute confidence
    let confidence = 1;
    for (const [stars, threshold] of Object.entries(CONFIDENCE_THRESHOLDS)
      .sort((a, b) => b[1] - a[1])) {
      if (voteCount >= threshold) {
        confidence = stars.length;
        break;
      }
    }

    finalLivePicks.push({
      market_id: entry.market_id,
      market_name: entry.market_name,
      event_slug: entry.event_slug,
      picked_outcome: dominantOutcome,
      wallets: Array.from(data.walletIds),
      vote_count: voteCount,
      pnl: data.totalPnl,
      confidence,
      fetched_at: new Date()
    });
  }

  // 5️⃣ Upsert merged live picks
  for (const pick of finalLivePicks) {
    await supabase
      .from("wallet_live_picks")
      .upsert(pick, { onConflict: ["market_id", "picked_outcome"] });
  }

  console.log(`✅ Wallet live picks rebuilt and merged (${finalLivePicks.length})`);
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
