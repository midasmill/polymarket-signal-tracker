import pkg from "pg";
const { Pool } = pkg;
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV & DB
=========================== */
const COCKROACHDB_URL = process.env.COCKROACHDB_URL;
if (!COCKROACHDB_URL) throw new Error("COCKROACHDB_URL required");

const pool = new Pool({
  connectionString: COCKROACHDB_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

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

/* ===========================
   Global Crash Logger
=========================== */
process.on("unhandledRejection", err => console.error("🔥 Unhandled rejection:", err));
process.on("uncaughtException", err => console.error("🔥 Uncaught exception:", err));

/* ===========================
   Get Eligible Wallets
=========================== */
async function getEligibleWallets(minWinRate = WIN_RATE_THRESHOLD) {
  const { rows } = await query(
    `SELECT id, win_rate FROM wallets WHERE paused = false AND win_rate >= $1`,
    [minWinRate]
  );
  return rows || [];
}

/* ===========================
   Markdown Helper
=========================== */
function toBlockquote(text) {
  return text.split("\n").map(line => `> ${line}`).join("\n");
}

/* ===========================
   Telegram Helper
=========================== */
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
async function getMarketVoteCounts(marketSlug) {
  const { rows } = await query(
    `SELECT wallet_id, side, picked_outcome, event_slug
     FROM signals
     WHERE market_slug = $1 AND outcome = 'Pending' AND picked_outcome IS NOT NULL`,
    [marketSlug]
  );
  if (!rows?.length) return {};

  const grouped = {};
  for (const sig of rows) {
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
    for (const sig of group) counts[sig.side] = (counts[sig.side] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;
    perWallet[walletId][sorted[0][0]] = (perWallet[walletId][sorted[0][0]] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet))
    for (const [side, count] of Object.entries(votes))
      counts[side] = (counts[side] || 0) + count;

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

  // Fetch existing content
  const { rows } = await query(`SELECT content FROM notes WHERE slug = $1`, [slug]);
  let newContent = rows?.[0]?.content || "";

  const safeSignal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");

  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;

  await query(`UPDATE notes SET content = $1, public = true WHERE slug = $2`, [newContent, slug]);
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
      const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
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
   Reprocess Resolved Picks (Optimized)
=========================== */
async function reprocessResolvedPicks() {
  console.log("🔄 Reprocessing all resolved picks...");
  try {
    const { rows: wallets } = await query(`SELECT id, polymarket_proxy_wallet FROM wallets`);
    if (!wallets?.length) return console.log("No wallets found for reprocessing.");

    for (const wallet of wallets) {
      if (!wallet.polymarket_proxy_wallet) continue;
      const positions = await fetchWalletPositions(wallet.polymarket_proxy_wallet);
      console.log(`Fetched ${positions.length} positions for wallet ${wallet.id}`);

      for (const pos of positions) {
        const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
        const marketSlug = pos.slug || pos.eventSlug;
        const pnl = pos.cashPnl ?? null;
        const { outcome, resolvedOutcome } = determineOutcome(pos);

        await query(
          `UPDATE signals
           SET pnl = $1,
               outcome = $2,
               resolved_outcome = $3,
               outcome_at = $4
           WHERE wallet_id = $5 AND market_slug = $6 AND picked_outcome = $7`,
          [pnl, outcome, resolvedOutcome, pnl !== null ? new Date() : null, wallet.id, marketSlug, pickedOutcome]
        );
      }
    }

    console.log("⚡ Finished reprocessing resolved picks.");
  } catch (err) {
    console.error("Error reprocessing resolved picks:", err.message);
  }
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

  if (wallet.paused && wallet.win_rate >= WIN_RATE_THRESHOLD) {
    await query(`UPDATE wallets SET paused = false WHERE id = $1`, [wallet.id]);
    wallet.paused = false;
    console.log(`Wallet ${wallet.id} auto-unpaused (winRate=${wallet.win_rate.toFixed(2)}%)`);
  }

  if (wallet.paused && !wallet.force_fetch) return;

  let positions = [];
  try { positions = await fetchWalletPositions(proxyWallet); } catch (err) { console.error(err.message); }

  let trades = [];
  try {
    trades = await fetchLatestTrades(proxyWallet);
  } catch (err) { console.error(err.message); }

  const existingSignalsRes = await query(
    `SELECT id, tx_hash, market_slug, outcome FROM signals WHERE wallet_id = $1`,
    [wallet.id]
  );
  const existingSignals = existingSignalsRes.rows || [];
  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));

  // Process positions
  for (const pos of positions) {
    const marketSlug = pos.slug || pos.eventSlug;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    const pnl = pos.cashPnl ?? null;
    const { outcome, resolvedOutcome } = determineOutcome(pos);

    const existingSig = existingSignals.find(s => s.market_slug === marketSlug);
    if (existingSig) {
      await query(
        `UPDATE signals
         SET pnl = $1, outcome = $2, resolved_outcome = $3, outcome_at = $4
         WHERE id = $5`,
        [pnl, outcome, resolvedOutcome, pnl !== null ? new Date() : null, existingSig.id]
      );
    } else if (!existingTxs.has(pos.asset)) {
      await query(
        `INSERT INTO signals (wallet_id, signal, market_name, market_slug, event_slug, side, picked_outcome, opposite_outcome, tx_hash, pnl, outcome, resolved_outcome, outcome_at, win_rate, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          wallet.id,
          pos.title,
          pos.title,
          marketSlug,
          pos.eventSlug || pos.slug,
          pos.side?.toUpperCase() || "BUY",
          pickedOutcome,
          pos.oppositeOutcome || null,
          pos.asset,
          pnl,
          outcome,
          resolvedOutcome,
          pnl !== null ? new Date() : null,
          wallet.win_rate,
          new Date(pos.timestamp * 1000 || Date.now())
        ]
      );
    }
  }

  // Process unresolved trades
  const liveConditionSlugs = new Set(positions.filter(p => p.cashPnl === null).map(p => p.slug || p.eventSlug));
  const unresolvedTrades = trades.filter(t => {
    if (!liveConditionSlugs.has(t.slug || t.eventSlug)) return false;
    if (existingTxs.has(t.asset)) return false;
    const pos = positions.find(p => p.asset === t.asset);
    if (pos && typeof pos.cashPnl === "number") return false;
    return true;
  });

  if (unresolvedTrades.length) {
    for (const trade of unresolvedTrades) {
      const marketSlug = trade.slug || trade.eventSlug;
      const pickedOutcome = trade.outcome || `OPTION_${trade.outcomeIndex}`;
      await query(
        `INSERT INTO signals (wallet_id, signal, market_name, market_slug, event_slug, side, picked_outcome, tx_hash, pnl, outcome, resolved_outcome, outcome_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          wallet.id,
          trade.title,
          trade.title,
          marketSlug,
          trade.eventSlug || trade.slug,
          trade.side?.toUpperCase() || "BUY",
          pickedOutcome,
          trade.asset,
          null,
          "Pending",
          null,
          null,
          new Date(trade.timestamp * 1000 || Date.now())
        ]
      );
    }
    console.log(`Inserted ${unresolvedTrades.length} unresolved trades for wallet ${wallet.id}`);
    try { await rebuildWalletLivePicks(); } catch (err) { console.error(err.message); }
  }
}
/* ===========================
   Update Wallet Metrics
=========================== */
async function updateWalletMetricsJS() {
  try {
    const { rows: wallets } = await query(`SELECT * FROM wallets`);
    if (!wallets?.length) return console.log("No wallets found");

    for (const wallet of wallets) {
      try {
        // 1️⃣ Fetch resolved signals
        const { rows: resolvedSignals } = await query(
          `SELECT market_slug, picked_outcome, outcome, created_at
           FROM signals
           WHERE wallet_id = $1 AND outcome = ANY($2)
           ORDER BY created_at ASC`,
          [wallet.id, ["WIN", "LOSS"]]
        );

        // 2️⃣ Aggregate per market to handle multiple picks
        const perMarket = {};
        for (const sig of resolvedSignals) {
          if (!perMarket[sig.market_slug]) perMarket[sig.market_slug] = [];
          perMarket[sig.market_slug].push(sig);
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

        // 3️⃣ Compute losing streak
        let losingStreak = 0;
        for (let i = resolvedSignals.length - 1; i >= 0; i--) {
          if (resolvedSignals[i].outcome === "LOSS") losingStreak++;
          else break;
        }

        // 4️⃣ Count live picks
        const { rows: liveRows } = await query(
          `SELECT COUNT(*)::int AS count
           FROM signals
           WHERE wallet_id = $1 AND outcome = 'Pending'`,
          [wallet.id]
        );
        const livePicksCount = liveRows[0]?.count || 0;

        // 5️⃣ Determine paused
        const paused = losingStreak >= LOSING_STREAK_THRESHOLD || winRate < WIN_RATE_THRESHOLD;

        // 6️⃣ Update wallet
        await query(
          `UPDATE wallets
           SET win_rate = $1,
               losing_streak = $2,
               live_picks = $3,
               paused = $4,
               last_checked = $5
           WHERE id = $6`,
          [winRate, losingStreak, livePicksCount, paused, new Date(), wallet.id]
        );

        console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicksCount}, paused: ${paused}`);
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
  try {
    // Get vote counts
    const { rows: signals } = await query(
      `SELECT wallet_id, side, picked_outcome, event_slug
       FROM signals
       WHERE market_slug = $1 AND outcome = 'Pending' AND picked_outcome IS NOT NULL`,
      [sig.market_slug]
    );

    if (!signals?.length) return;

    const grouped = {};
    for (const s of signals) {
      if (!s.event_slug) continue;
      const key = `${s.wallet_id}||${s.event_slug}`;
      grouped[key] ??= [];
      grouped[key].push(s);
    }

    const perWallet = {};
    for (const [key, group] of Object.entries(grouped)) {
      const walletId = group[0].wallet_id;
      perWallet[walletId] ??= {};
      const counts = {};
      for (const s of group) counts[s.side] = (counts[s.side] || 0) + 1;
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue;
      perWallet[walletId][sorted[0][0]] = (perWallet[walletId][sorted[0][0]] || 0) + 1;
    }

    const counts = {};
    for (const votes of Object.values(perWallet)) {
      for (const [side, count] of Object.entries(votes)) counts[side] = (counts[side] || 0) + count;
    }

    const confidence = getConfidenceEmoji(Math.max(...Object.values(counts)));
    const emoji = RESULT_EMOJIS[result] || "⚪";
    const text = formatSignal(sig, confidence, emoji, "Result Received");

    await sendTelegram(text);
    await updateNotes("polymarket-millionaires", text);
  } catch (err) {
    console.error("sendResultNotes error:", err.message);
  }
}
/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  try {
    const { rows: livePicks } = await query(
      `SELECT * FROM wallet_live_picks WHERE outcome = 'Pending'`
    );

    if (!livePicks?.length) return console.log("No live picks to process.");

    // Group by market_slug + picked_outcome
    const grouped = {};
    for (const pick of livePicks) {
      const key = `${pick.market_slug}||${pick.picked_outcome}`;
      grouped[key] ??= [];
      grouped[key].push(pick);
    }

    for (const picks of Object.values(grouped)) {
      if (picks.length < 2) continue; // confidence threshold

      const sig = picks[0];
      const confidence = getConfidenceEmoji(picks.length);
      const text = `Market: ${sig.market_name}\nPick: ${sig.picked_outcome}\nConfidence: ${confidence}`;

      await sendTelegram(text);
      await updateNotes("polymarket-millionaires", text);

      await query(
        `UPDATE signals
         SET signal_sent_at = $1
         WHERE market_slug = $2`,
        [new Date(), sig.market_slug]
      );

      console.log(`✅ Sent majority signal for market ${sig.market_name} (confidence: ${picks.length})`);
    }
  } catch (err) {
    console.error("sendMajoritySignals error:", err.message);
  }
}

/* ===========================
   Rebuild wallet_live_picks
=========================== */
async function rebuildWalletLivePicks() {
  console.log("Rebuilding wallet_live_picks...");

  try {
    const { rows: allWallets } = await query(`SELECT id, win_rate, paused FROM wallets`);
    if (!allWallets?.length) return console.log("No wallets found.");

    const eligibleWallets = allWallets.filter(w => !w.paused && w.win_rate >= WIN_RATE_THRESHOLD);
    if (!eligibleWallets.length) return console.log("No eligible wallets.");

    const eligibleIds = eligibleWallets.map(w => w.id);

    const { rows: signals } = await query(
      `SELECT * FROM signals
       WHERE wallet_id = ANY($1) AND outcome = 'Pending' AND picked_outcome IS NOT NULL`,
      [eligibleIds]
    );
    if (!signals?.length) return console.log("No pending signals.");

    const perWalletEvent = {};
    for (const sig of signals) {
      if (!sig.event_slug) continue;
      const key = `${sig.wallet_id}||${sig.event_slug}`;
      perWalletEvent[key] ??= {};
      perWalletEvent[key][sig.picked_outcome] = (perWalletEvent[key][sig.picked_outcome] || 0) + 1;
    }

    const livePicks = [];

    for (const [key, counts] of Object.entries(perWalletEvent)) {
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
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
        market_slug: sig.market_slug,
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

    // Aggregate vote_count
    const grouped = {};
    for (const pick of livePicks) {
      const key = `${pick.market_slug}||${pick.picked_outcome}`;
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

    // Clear table and insert
    await query(`DELETE FROM wallet_live_picks`);
    for (const pick of finalLivePicks) {
      await query(
        `INSERT INTO wallet_live_picks
         (wallet_id, market_slug, market_name, event_slug, picked_outcome, side, pnl, outcome, resolved_outcome, fetched_at, vote_count, win_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [pick.wallet_id, pick.market_slug, pick.market_name, pick.event_slug, pick.picked_outcome, pick.side, pick.pnl, pick.outcome, pick.resolved_outcome, pick.fetched_at, pick.vote_count, pick.win_rate]
      );
    }
    console.log(`Inserted ${finalLivePicks.length} live picks`);
  } catch (err) {
    console.error("rebuildWalletLivePicks error:", err.message);
  }
}

/* ===========================
   Fetch wallet live picks
=========================== */
async function fetchWalletLivePicks(walletId) {
  try {
    const { rows } = await query(
      `SELECT * FROM wallet_live_picks
       WHERE wallet_id = $1
       ORDER BY vote_count DESC, fetched_at DESC`,
      [walletId]
    );
    return rows || [];
  } catch (err) {
    console.error(`Failed to fetch live picks for wallet ${walletId}:`, err.message);
    return [];
  }
}

/* ===========================
   Bulk Unpause Wallets
=========================== */
async function bulkUnpauseWallets() {
  try {
    const { rows } = await query(
      `UPDATE wallets
       SET paused = false
       WHERE win_rate >= $1 AND paused = true
       RETURNING id`,
      [WIN_RATE_THRESHOLD]
    );
    console.log(`✅ Bulk unpaused ${rows.length} wallets over threshold`);
  } catch (err) {
    console.error("Failed to bulk unpause wallets:", err.message);
  }
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning = false;
async function trackerLoop() {
  if (isTrackerRunning) return console.log("⏳ Tracker loop already running");
  isTrackerRunning = true;

  try {
    const { rows: wallets } = await query(`SELECT * FROM wallets`);
    if (!wallets?.length) return console.log("No wallets found");

    console.log(`[${new Date().toISOString()}] Tracking ${wallets.length} wallets...`);

    for (const wallet of wallets) {
      try { await trackWallet(wallet); } 
      catch (err) { console.error(`Error tracking wallet ${wallet.id}:`, err.message); }
    }

    if (process.env.REPROCESS === "true") {
      console.log("⚡ REPROCESS flag detected — updating resolved picks...");
      await reprocessResolvedPicks();
      console.log("⚡ Finished reprocessing resolved picks.");
    }

    await rebuildWalletLivePicks();
    await updateWalletMetricsJS();
    await sendMajoritySignals();

    console.log("✅ Tracker loop completed successfully");
  } catch (err) {
    console.error("Tracker loop error:", err.message);
  } finally {
    isTrackerRunning = false;
  }
}

/* ===========================
   Main Function
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  try { await fetchAndInsertLeaderboardWallets(); } 
  catch (err) { console.error("Failed to fetch leaderboard wallets:", err.message); }

  await trackerLoop();
  setInterval(trackerLoop, POLL_INTERVAL);
}

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
setInterval(() => console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));

main();
