import pkg from "pg";
const { Pool } = pkg;

import fetch from "node-fetch";
import cron from "node-cron";
import http from "http";

/* ===========================
   ENV
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
const TELEGRAM_CHAT_ID = "-4911183253"; 
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
Market Event: [${sig.market_name}](${eventUrl})
Prediction: ${pick}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"}
Result: ${sig.outcome ? emoji : "⚪"}`;
}

/* ===========================
   Update Notes
=========================== */
async function updateNotes(slug, text) {
  const noteText = toBlockquote(text);
  const { rows: notesRows } = await query(
    `SELECT content FROM notes WHERE slug=$1 LIMIT 1`,
    [slug]
  );
  let newContent = notesRows?.[0]?.content || "";
  const safeSignal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");
  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;
  await query(`UPDATE notes SET content=$1, public=true WHERE slug=$2`, [newContent, slug]);
}

/* ===========================
   Determine outcome of a position
=========================== */
function determineOutcome(pos) {
  let outcome = "Pending";
  let resolvedOutcome = null;

  if (pos.resolved === true) {
    if (pos.cashPnl > 0) outcome = "WIN", resolvedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    else outcome = "LOSS", resolvedOutcome = pos.oppositeOutcome || (pos.outcome || `OPTION_${pos.outcomeIndex}`);
  }
  return { outcome, resolvedOutcome };
}

/* ===========================
   Fetch wallet positions
=========================== */
async function fetchWalletPositions(userId) {
  if (!userId) return [];
  const allPositions = [];
  let limit = 100, offset = 0;

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
  return allPositions;
}

/* ===========================
   Track Wallet
=========================== */
async function trackWallet(wallet) {
  const proxyWallet = wallet.polymarket_proxy_wallet;
  if (!proxyWallet) return;

  if (wallet.paused && wallet.win_rate >= WIN_RATE_THRESHOLD) {
    await query(`UPDATE wallets SET paused=false WHERE id=$1`, [wallet.id]);
    wallet.paused = false;
  }

  if (wallet.paused && !wallet.force_fetch) return;

  const positions = await fetchWalletPositions(proxyWallet);
  const trades = await fetchLatestTrades(proxyWallet);

  // existing signals
  const { rows: existingSignals } = await query(
    `SELECT id, tx_hash, market_slug, outcome FROM signals WHERE wallet_id=$1`,
    [wallet.id]
  );
  const existingTxs = new Set(existingSignals.map(s => s.tx_hash));

  for (const pos of positions) {
    const marketSlug = pos.slug || pos.conditionId;
    const pickedOutcome = pos.outcome || `OPTION_${pos.outcomeIndex}`;
    const pnl = pos.cashPnl ?? null;
    const { outcome, resolvedOutcome } = determineOutcome(pos);

    const existingSig = existingSignals.find(s => s.market_slug === marketSlug);
    if (existingSig) {
      await query(
        `UPDATE signals SET pnl=$1, outcome=$2, resolved_outcome=$3, outcome_at=$4 WHERE id=$5`,
        [pnl, outcome, resolvedOutcome, pnl !== null ? new Date() : null, existingSig.id]
      );
    } else if (!existingTxs.has(pos.asset)) {
      await query(
        `INSERT INTO signals 
        (wallet_id, signal, market_name, market_slug, event_slug, side, picked_outcome, opposite_outcome, tx_hash, pnl, outcome, resolved_outcome, outcome_at, win_rate, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [wallet.id, pos.title, pos.title, marketSlug, pos.eventSlug || pos.slug, pos.side?.toUpperCase()||"BUY", pickedOutcome, pos.oppositeOutcome||null, pos.asset, pnl, outcome, resolvedOutcome, pnl!==null?new Date():null, wallet.win_rate, new Date(pos.timestamp*1000||Date.now())]
      );
    }
  }
}
/* ===========================
   Rebuild wallet_live_picks
=========================== */
async function rebuildWalletLivePicks() {
  console.log("Rebuilding wallet_live_picks...");
  const { rows: allWallets } = await query(`SELECT id, win_rate, paused FROM wallets`);
  if (!allWallets?.length) return console.log("No wallets found");

  const eligibleWallets = allWallets.filter(w => !w.paused && w.win_rate >= WIN_RATE_THRESHOLD);
  if (!eligibleWallets.length) return console.log("No eligible wallets");

  const eligibleIds = eligibleWallets.map(w => w.id);
  const { rows: signals } = await query(
    `SELECT * FROM signals WHERE wallet_id = ANY($1) AND outcome='Pending' AND picked_outcome IS NOT NULL`,
    [eligibleIds]
  );
  if (!signals?.length) return console.log("No pending signals");

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
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) continue; // tie skip

    const majorityPick = sorted[0][0];
    const [walletId, eventSlug] = key.split("||");
    const sig = signals.find(s => s.wallet_id == walletId && s.event_slug === eventSlug && s.picked_outcome === majorityPick);
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

  await query(`DELETE FROM wallet_live_picks`);
  if (finalLivePicks.length) {
    for (const pick of finalLivePicks) {
      await query(
        `INSERT INTO wallet_live_picks
        (wallet_id, market_slug, market_name, event_slug, picked_outcome, side, pnl, outcome, resolved_outcome, fetched_at, vote_count, win_rate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          pick.wallet_id, pick.market_slug, pick.market_name, pick.event_slug, pick.picked_outcome,
          pick.side, pick.pnl, pick.outcome, pick.resolved_outcome, pick.fetched_at, pick.vote_count, pick.win_rate
        ]
      );
    }
  }
  console.log(`Inserted ${finalLivePicks.length} live picks`);
}

/* ===========================
   Send Majority Signals
=========================== */
async function sendMajoritySignals() {
  const { rows: livePicks } = await query(`SELECT * FROM wallet_live_picks WHERE outcome='Pending'`);
  if (!livePicks?.length) return console.log("No live picks to process");

  const grouped = {};
  for (const pick of livePicks) {
    const key = `${pick.market_slug}||${pick.picked_outcome}`;
    grouped[key] ??= [];
    grouped[key].push(pick);
  }

  for (const picks of Object.values(grouped)) {
    const walletCount = picks.length;
    if (walletCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const sig = picks[0]; // safe
    const confidence = getConfidenceEmoji(walletCount);
    const text = formatSignal(sig, confidence, "⭐", "Signal Sent");

    try {
      await sendTelegram(text);
      await updateNotes("polymarket-millionaires", text);
      await query(`UPDATE signals SET signal_sent_at=$1 WHERE market_slug=$2`, [new Date(), sig.market_slug]);
      console.log(`✅ Sent majority signal for market ${sig.market_name} (confidence: ${walletCount})`);
    } catch (err) {
      console.error(`Failed to send signal for market ${sig.market_name}:`, err.message);
    }
  }
}

/* ===========================
   Update Wallet Metrics
=========================== */
async function updateWalletMetricsJS() {
  const { rows: wallets } = await query(`SELECT * FROM wallets`);
  if (!wallets?.length) return console.log("No wallets found");

  for (const wallet of wallets) {
    try {
      const { rows: resolvedSignals } = await query(
        `SELECT market_slug, picked_outcome, outcome, created_at
         FROM signals
         WHERE wallet_id=$1 AND outcome=ANY($2::text[])
         ORDER BY created_at ASC`,
        [wallet.id, ["WIN","LOSS"]]
      );

      const perMarket = {};
      for (const sig of resolvedSignals) {
        perMarket[sig.market_slug] ??= [];
        perMarket[sig.market_slug].push(sig);
      }

      let marketWins = 0;
      for (const marketSignals of Object.values(perMarket)) {
        const counts = {};
        for (const sig of marketSignals) {
          counts[sig.picked_outcome] = (counts[sig.picked_outcome] || 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
        if (sorted.length>1 && sorted[0][1]===sorted[1][1]) continue;
        const majorityPick = sorted[0][0];
        const majoritySig = marketSignals.find(s=>s.picked_outcome===majorityPick);
        if (!majoritySig) continue;
        if (majoritySig.outcome==="WIN") marketWins++;
      }

      const winRate = Object.keys(perMarket).length>0 ? (marketWins/Object.keys(perMarket).length)*100 : 0;

      let losingStreak = 0;
      for (let i=resolvedSignals.length-1;i>=0;i--) {
        if (resolvedSignals[i].outcome==="LOSS") losingStreak++;
        else break;
      }

      const { rows: liveRows } = await query(
        `SELECT COUNT(*) AS count FROM signals WHERE wallet_id=$1 AND outcome='Pending'`,
        [wallet.id]
      );
      const livePicksCount = parseInt(liveRows?.[0]?.count||0,10);
      const paused = losingStreak>=LOSING_STREAK_THRESHOLD || winRate<WIN_RATE_THRESHOLD;

      await query(
        `UPDATE wallets SET win_rate=$1, losing_streak=$2, live_picks=$3, paused=$4, last_checked=$5 WHERE id=$6`,
        [winRate, losingStreak, livePicksCount, paused, new Date(), wallet.id]
      );
      console.log(`Wallet ${wallet.id} — winRate: ${winRate.toFixed(2)}%, losingStreak: ${losingStreak}, livePicks: ${livePicksCount}, paused: ${paused}`);
    } catch (err) {
      console.error(`Error updating wallet ${wallet.id}:`, err.message);
    }
  }
}

/* ===========================
   Leaderboard fetch
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const categories = ["OVERALL","POLITICS","SPORTS","CRYPTO","CULTURE","MENTIONS","WEATHER","ECONOMICS","TECH","FINANCE"];
  const timePeriods = ["DAY","WEEK","MONTH","ALL"];

  for (const category of categories) {
    for (const period of timePeriods) {
      try {
        const url = `https://data-api.polymarket.com/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=PNL&limit=50`;
        const data = await fetchWithRetry(url);
        if (!Array.isArray(data)) continue;

        for (const entry of data) {
          const proxyWallet = entry.proxyWallet;
          if (!proxyWallet || entry.pnl<100000 || entry.vol>=10*entry.pnl) continue;

          const { rows: existing } = await query(
            `SELECT id FROM wallets WHERE polymarket_proxy_wallet=$1 LIMIT 1`, [proxyWallet]
          );
          if (existing?.length) continue;

          const insertedWallet = await query(
            `INSERT INTO wallets
            (polymarket_proxy_wallet, polymarket_username, last_checked, paused, losing_streak, win_rate, force_fetch)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [proxyWallet, entry.userName||null, new Date(), false, 0, 0, true]
          );

          try { await trackWallet(insertedWallet.rows[0]); }
          catch(err){ console.error(`Failed historical fetch for ${proxyWallet}:`, err.message); }
        }
      } catch(err){ console.error(`Leaderboard fetch ${category}/${period} failed:`, err.message); }
    }
  }
}

/* ===========================
   Tracker Loop
=========================== */
let isTrackerRunning=false;
async function trackerLoop() {
  if (isTrackerRunning) return console.log("Tracker loop already running");
  isTrackerRunning=true;

  try {
    const { rows: wallets } = await query(`SELECT * FROM wallets`);
    if (!wallets?.length) return console.log("No wallets");

    for (const wallet of wallets) await trackWallet(wallet);
    await rebuildWalletLivePicks();
    await updateWalletMetricsJS();
    await sendMajoritySignals();
    console.log("✅ Tracker loop completed");
  } catch(err){ console.error("Tracker loop error:", err.message); }
  finally{ isTrackerRunning=false; }
}



(async () => {
  try {
    const { rows } = await query(`SELECT NOW()`);
    console.log("✅ Connected to CockroachDB, time:", rows[0].now);
  } catch (err) {
    console.error("❌ CockroachDB connection failed:", err.message);
  }
})();

/* ===========================
   Main Function
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");
  await fetchAndInsertLeaderboardWallets();
  await trackerLoop();
  setInterval(trackerLoop,POLL_INTERVAL);
}

main();

/* ===========================
   Cron + Heartbeat
=========================== */
cron.schedule("0 7 * * *",()=>{ console.log("Daily leaderboard + summary..."); }, {timezone: TIMEZONE});
setInterval(()=>console.log(`[HEARTBEAT] Tracker alive @ ${new Date().toISOString()}`), 60_000);

const PORT = process.env.PORT||3000;
http.createServer((req,res)=>{
  res.writeHead(200,{"Content-Type":"text/plain"});
  res.end("Polymarket tracker running\n");
}).listen(PORT,()=>console.log(`Tracker listening on port ${PORT}`));
