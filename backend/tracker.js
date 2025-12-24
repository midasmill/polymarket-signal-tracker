import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import cron from "node-cron";
import http from "http"; // <- only here, remove any other import


/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = "-4911183253"; // Group chat ID
const TIMEZONE = process.env.TIMEZONE || "America/New_York";

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "30000", 10);
const LOSING_STREAK_THRESHOLD = parseInt(process.env.LOSING_STREAK_THRESHOLD || "3", 10);
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "2", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true" || true;

const CONFIDENCE_THRESHOLDS = {
  "⭐": MIN_WALLETS_FOR_SIGNAL,
  "⭐⭐": parseInt(process.env.CONF_2 || "15"),
  "⭐⭐⭐": parseInt(process.env.CONF_3 || "25"),
  "⭐⭐⭐⭐": parseInt(process.env.CONF_4 || "35"),
  "⭐⭐⭐⭐⭐": parseInt(process.env.CONF_5 || "50"),
};

const RESULT_EMOJIS = { WIN: "✅", LOSS: "❌", Pending: "⚪" };

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);



/* ===========================
   Markdown helper
=========================== */
function toBlockquote(text) {
  return text
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");
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
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const data = await fetchWithRetry(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
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
    const market = await fetchWithRetry(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });

    if (market) marketCache.set(eventSlug, market);
    return market;
  } catch (err) {
    if (err.message.includes("404")) {
      console.log(`Market ${eventSlug} not found (404)`);
    } else {
      console.error(`Market fetch error (${eventSlug}):`, err.message);
    }
    return null;
  }
}




/* ===========================
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  const entries = Object.entries(CONFIDENCE_THRESHOLDS).sort(
    ([, a], [, b]) => b - a
  );
  for (const [emoji, threshold] of entries) {
    if (count >= threshold) return emoji;
  }
  return "";
}

/* ===========================
   Market vote counts
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!signals || !signals.length) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] =
      (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue;
    counts[sides[0][0]] = (counts[sides[0][0]] || 0) + 1;
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "";
  return getConfidenceEmoji(Math.max(...Object.values(counts)));
}


/* ===========================
   Helper to get actual pick
=========================== */
function getPick(sig) {
  if (!sig.picked_outcome || !sig.side) return "Unknown";

  if (sig.side === "BUY") {
    return sig.picked_outcome;
  }

  // SELL → opposite outcome
  if (sig.side === "SELL") {
    if (!sig.resolved_outcome) return `NOT ${sig.picked_outcome}`;
    return sig.resolved_outcome === sig.picked_outcome
      ? "Unknown"
      : sig.resolved_outcome;
  }

  return "Unknown";
}


/* ===========================
   Format Signal for Telegram/Notes
=========================== */
function formatSignal(sig, confidence, emoji, eventType = "Signal Sent") {
  const pick = getPick(sig);
  const eventUrl = `https://polymarket.com/events/${sig.market_id}`;

  return `${eventType}: ${new Date().toLocaleString()}
Market Event: [${sig.signal}](${eventUrl})
Prediction: ${pick}
Confidence: ${confidence}
Outcome: ${sig.outcome || "Pending"}
Result: ${sig.outcome ? emoji : "⚪"}`;
}

/* ===========================
   Track Wallet Trades (Resolved + Pending with pick)
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused) return;

  let trades = [];
  let identityUsed = null;

  if (wallet.polymarket_proxy_wallet) {
    trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
    if (trades.length > 0) identityUsed = "proxy";
  }

  if (trades.length === 0 && wallet.polymarket_username) {
    trades = await fetchLatestTrades(wallet.polymarket_username);
    if (trades.length > 0) identityUsed = "username";
  }

  if (trades.length === 0) {
    await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
    return;
  }

  for (const trade of trades) {
    if (identityUsed === "proxy" &&
        trade.proxyWallet &&
        trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) {
      continue;
    }

    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("market_id", trade.eventSlug)
      .eq("wallet_id", wallet.id)
      .eq("tx_hash", trade.transactionHash)
      .maybeSingle();
    if (existing) continue;

    let pnl = trade.pnl ?? null;
    let outcome = "Pending";
    let outcome_at = null;

    if (trade.outcome) {
      outcome = pnl !== null && pnl < 0 ? "LOSS" : "WIN";
      outcome_at = new Date(trade.timestamp * 1000);
    }

await supabase.from("signals").insert({
  wallet_id: wallet.id,
  signal: trade.title,
  market_name: trade.title,
  market_id: trade.conditionId,
  side: trade.side.toUpperCase(),
  picked_outcome: trade.outcome,   // 🔥 NEW
  tx_hash: trade.transactionHash,
  outcome: "Pending",
  created_at: new Date(trade.timestamp * 1000),
  wallet_count: 1,
  wallet_set: [String(wallet.id)],
  tx_hashes: [trade.transactionHash],
});

  }

  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Helper
=========================== */

async function fetchMarketByConditionId(conditionId) {
  const res = await fetch(
    `https://data-api.polymarket.com/markets/${conditionId}`
  );

  if (!res.ok) throw new Error("Market fetch failed");

  return res.json();
}


/* ===========================
   Update Pending Outcomes (RESOLUTION-ONLY, CAN'T LIE)
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pending?.length) return;

  for (const sig of pending) {
    // Hard guardrails
    if (!sig.market_id) continue;
    if (!sig.picked_outcome) continue;

    let market;
    try {
      market = await fetchMarketByConditionId(sig.market_id);
    } catch {
      continue;
    }

    if (!market?.resolved || !market.winningOutcome) continue;

    const resolved_outcome = market.winningOutcome;

    const finalOutcome =
      sig.picked_outcome.toLowerCase() ===
      resolved_outcome.toLowerCase()
        ? "WIN"
        : "LOSS";

    await supabase
      .from("signals")
      .update({
        resolved_outcome,
        outcome: finalOutcome,
        outcome_at: new Date(),
      })
      .eq("id", sig.id);

    // Wallet streak logic
    const { data: wallet } = await supabase
      .from("wallets")
      .select("*")
      .eq("id", sig.wallet_id)
      .single();

    if (!wallet) continue;

    if (finalOutcome === "LOSS") {
      const streak = (wallet.losing_streak || 0) + 1;

      await supabase
        .from("wallets")
        .update({ losing_streak: streak })
        .eq("id", wallet.id);

      if (streak >= LOSING_STREAK_THRESHOLD) {
        await supabase
          .from("wallets")
          .update({ paused: true })
          .eq("id", wallet.id);

        await sendTelegram(
          `⛔ Wallet paused\nWallet ID: ${wallet.id}\nLosing streak: ${streak}`
        );
      }
    } else {
      await supabase
        .from("wallets")
        .update({ losing_streak: 0 })
        .eq("id", wallet.id);
    }

    await sendResultNotes(
      sig,
      finalOutcome,
      sig.picked_outcome,
      resolved_outcome
    );
  }

  await sendMajoritySignals();
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

  const noteText = toBlockquote(text);
  const { data: notes } = await supabase
    .from("notes")
    .select("id, content")
    .eq("slug", "polymarket-millionaires")
    .maybeSingle();

  let newContent = notes?.content || "";
  const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");

  if (regex.test(newContent)) newContent = newContent.replace(regex, noteText);
  else newContent += newContent ? `\n\n${noteText}` : noteText;

  await supabase.from("notes").update({ content: newContent, public: true }).eq("slug", "polymarket-millionaires");
}


async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id", { distinct: true });

  if (!markets?.length) return;

  for (const { market_id } of markets) {
    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .eq("market_id", market_id);

    if (!signals || signals.length < MIN_WALLETS_FOR_SIGNAL) continue;

    // 1️⃣ Determine one pick per wallet
    const perWalletPick = {};
    for (const sig of signals) {
      if (!sig.wallet_id) continue;
      perWalletPick[sig.wallet_id] = getPick(sig);
    }

    // 2️⃣ Count picks
    const pickCounts = {};
    for (const pick of Object.values(perWalletPick)) {
      if (!pick || pick === "Unknown") continue;
      pickCounts[pick] = (pickCounts[pick] || 0) + 1;
    }

    const entries = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;

    // Tie check
    if (entries.length > 1 && entries[0][1] === entries[1][1]) continue;

    const [majorityPick, walletCount] = entries[0];
    if (walletCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const confidence = getConfidenceEmoji(walletCount);

    // 3️⃣ Send ONE representative signal
    const sig = signals.find(s => getPick(s) === majorityPick);
    if (!sig) continue;

    if (!FORCE_SEND && sig.signal_sent_at) continue;

    const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
    const text = formatSignal(
      { ...sig, side: majorityPick }, // override side for display
      confidence,
      emoji,
      "Signal Sent"
    );

    await sendTelegram(text);

    // Notes update
    const noteText = toBlockquote(text);
    const { data: notes } = await supabase
      .from("notes")
      .select("content")
      .eq("slug", "polymarket-millionaires")
      .maybeSingle();

    let newContent = notes?.content || "";
    const safeSignal = sig.signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`.*\\[${safeSignal}\\]\\(.*\\).*`, "g");

    if (regex.test(newContent)) {
      newContent = newContent.replace(regex, noteText);
    } else {
      newContent += newContent ? `\n\n${noteText}` : noteText;
    }

    await supabase
      .from("notes")
      .update({ content: newContent, public: true })
      .eq("slug", "polymarket-millionaires");

    // Mark all signals in this market as sent
    await supabase
      .from("signals")
      .update({ signal_sent_at: new Date() })
      .eq("market_id", market_id);
  }
}


/* ===========================
   Pre-signals (near-threshold)
=========================== */
async function updatePreSignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    if (!counts) continue;

    const side = getMajoritySide(counts);
    if (!side) continue;

    const maxCount = Math.max(...Object.values(counts));
    if (maxCount > 0 && maxCount < MIN_WALLETS_FOR_SIGNAL) {
      const { data: existing } = await supabase.from("pre_signals").select("id").eq("market_id", market_id).eq("side", side).maybeSingle();
      if (!existing) {
        const { data: sig } = await supabase.from("signals").select("*").eq("market_id", market_id).eq("side", side).limit(1).maybeSingle();
        if (sig) {
          await supabase.from("pre_signals").insert({
            market_id,
            market_name: sig.market_name,
            side,
            wallet_count: maxCount,
            confidence: getConfidenceEmoji(maxCount),
            signal: sig.signal,
          });
        }
      }
    }
  }
}


/* ===========================
   Fetch new leaderboard wallets from Polymarket
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalInserted = 0;

  for (const period of timePeriods) {
    let fetched = 0;
    let passed = 0;
    let inserted = 0;
    let duplicates = 0;

    try {
      const url = `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=50`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      fetched = data.length;
      console.log(`[LEADERBOARD][${period}] Fetched=${fetched}`);

      for (const entry of data) {
        // Skip entries without proxyWallet
        if (!entry.proxyWallet) continue;

        // PnL and volume filter
        if (entry.pnl >= 100 && entry.vol < 6 * entry.pnl) {
          passed++;

          // Insert only if not already in wallets table
          const { data: existing } = await supabase
            .from("wallets")
            .select("id")
            .or(
              `polymarket_proxy_wallet.eq.${entry.proxyWallet},polymarket_username.eq.${entry.userName}`
            )
            .maybeSingle();

          if (existing) {
            duplicates++;
            continue;
          }

          try {
            await supabase.from("wallets").insert({
              polymarket_proxy_wallet: entry.proxyWallet,
              polymarket_username: entry.userName,
              last_checked: new Date(),
              paused: false,
            });
            inserted++;
            totalInserted++;
          } catch (err) {
            console.error("Insert wallet failed:", err.message);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to fetch leaderboard (${period}):`, err.message);
    }

    console.log(
      `[LEADERBOARD][${period}] Passed=${passed} Inserted=${inserted} Duplicates=${duplicates}`
    );
  }

  console.log(`Leaderboard fetch complete. Total new wallets inserted: ${totalInserted}`);
}




/* ===========================
   Daily Summary + Leaderboard
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const startYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

  const { data: allSignals } = await supabase.from("signals").select("*");
  const { data: ySignals } = await supabase
    .from("signals")
    .select("*")
    .gte("created_at", startYesterday.toISOString())
    .lte("created_at", endYesterday.toISOString());

  const pendingSignals = allSignals.filter(s => s.outcome === "Pending");

  let summaryText = `Yesterday's results:\n`;

  if (!ySignals || ySignals.length === 0) summaryText += `0 predictions yesterday.\n`;
  else ySignals.forEach(s => summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${RESULT_EMOJIS[s.outcome] || "⚪"}\n`);

  summaryText += `\nPending picks:\n`;
  if (!pendingSignals || pendingSignals.length === 0) summaryText += `0 predictions pending ⚪\n`;
  else pendingSignals.forEach(s => summaryText += `${s.signal} - ${s.side} - Pending ⚪\n`);

  await sendTelegram(toBlockquote(summaryText), true);
  await supabase
    .from("notes")
    .update({ content: toBlockquote(summaryText), public: true })
    .eq("slug", "polymarket-millionaires");

  // Update leaderboard and fetch new wallets
  await updateLeaderboard();
  await fetchAndInsertLeaderboardWallets();
}

/* ===========================
   Cron daily at 7am ET
=========================== */
cron.schedule("0 7 * * *", () => {
  console.log("Running daily summary + leaderboard + new wallets fetch...");
  sendDailySummary();
}, { timezone: TIMEZONE });

/* ===========================
   Main Loop
=========================== */
async function main() {
  console.log("🚀 POLYMARKET TRACKER LIVE 🚀");

  // Insert new leaderboard wallets immediately on deploy
  await fetchAndInsertLeaderboardWallets();

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets?.length) return;

      console.log("Wallets loaded:", wallets.length);

      await Promise.all(wallets.map(trackWallet));
      await updatePendingOutcomes();
      await updatePreSignals();
    } catch (e) {
      console.error("Loop error:", e);
      await sendTelegram(`Tracker loop error: ${e.message}`);
    }
  }, POLL_INTERVAL);
}

main();

/* ===========================
   Keep Render happy by binding to a port
=========================== */
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => {
  console.log(`Tracker listening on port ${PORT}`);
});
