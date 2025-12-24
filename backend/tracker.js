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
const LOSING_STREAK_THRESHOLD = parseInt(process.env.LOSING_STREAK_THRESHOLD || "3", 10);
const MIN_WALLETS_FOR_SIGNAL = parseInt(process.env.MIN_WALLETS_FOR_SIGNAL || "2", 10);
const FORCE_SEND = process.env.FORCE_SEND === "true"; // fixed

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
  const { data: signals } = await supabase.from("signals").select("wallet_id, side").eq("market_id", marketId);
  if (!signals?.length) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = (perWallet[s.wallet_id][s.side] || 0) + 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    if (sides.length > 1 && sides[0][1] === sides[1][1]) continue; // tie per wallet
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
  const eventUrl = `https://polymarket.com/events/${sig.market_id}`;
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
   Track Wallet Trades
=========================== */

async function trackWallet(wallet) {
  if (wallet.paused) return;

  const userId = wallet.polymarket_proxy_wallet || wallet.polymarket_username;
  if (!userId) return;

  // Fetch positions
  let positions = [];
  try {
    const url = `https://data-api.polymarket.com/positions?user=${userId}&limit=100`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (res.ok) positions = await res.json();
    else console.log(`Failed to fetch positions for wallet ${wallet.id}, status: ${res.status}`);
  } catch (err) {
    console.error(`Failed to fetch positions for wallet ${wallet.id}:`, err.message);
  }

  if (!positions.length) {
    await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
    return;
  }

  // Fetch existing signals to avoid duplicates
  const { data: existingSignals } = await supabase
    .from("signals")
    .select("id, tx_hash, market_id")
    .eq("wallet_id", wallet.id);
  const existingTxs = new Set(existingSignals?.map(s => s.tx_hash));
  const existingMarkets = new Set(existingSignals?.map(s => s.market_id));

  for (const pos of positions) {
    const pickedOutcome = pos.outcome || derivePickedOutcome(pos);
    const eventSlug = pos.eventSlug || pos.slug;
    const cashPnl = pos.cashPnl ?? 0;
    const outcome = cashPnl < 0 ? "LOSS" : "WIN";
    const resolved_outcome = cashPnl < 0 ? pos.oppositeOutcome || pickedOutcome : pickedOutcome;

    // Check if signal exists
    let sigId = null;
    const existingSig = existingSignals.find(s => s.market_id === pos.conditionId);
    if (existingSig) {
      sigId = existingSig.id;
      // Update existing signal
      try {
        await supabase
          .from("signals")
          .update({
            pnl: cashPnl,
            outcome,
            resolved_outcome,
            outcome_at: new Date(),
          })
          .eq("id", sigId);
      } catch (err) {
        console.error("Failed to update existing signal:", err.message);
      }
    } else if (!existingTxs.has(pos.asset)) {
      // Insert new signal
      try {
        const { data: inserted } = await supabase.from("signals").insert({
          wallet_id: wallet.id,
          signal: pos.title,
          market_name: pos.title,
          market_id: pos.conditionId,
          event_slug: eventSlug,
          side: pos.side?.toUpperCase() || "BUY",
          picked_outcome: pickedOutcome,
          tx_hash: pos.asset,
          pnl: cashPnl,
          outcome,
          resolved_outcome,
          outcome_at: new Date(),
          created_at: new Date(pos.timestamp * 1000 || Date.now()),
          wallet_count: 1,
          wallet_set: [String(wallet.id)],
          tx_hashes: [pos.asset],
        }).select("id");

        sigId = inserted?.[0]?.id;
      } catch (err) {
        console.error("Failed to insert new signal:", err.message);
      }
    }

    // Update losing streak if LOSS
    if (cashPnl < 0) {
      try {
        const { data: walletData } = await supabase
          .from("wallets")
          .select("losing_streak")
          .eq("id", wallet.id)
          .maybeSingle();

        const newStreak = (walletData?.losing_streak || 0) + 1;
        await supabase.from("wallets").update({ losing_streak: newStreak }).eq("id", wallet.id);
      } catch (err) {
        console.error("Failed to update losing streak:", err.message);
      }
    }
  }

  // Update last_checked
  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}


  // Update last_checked
  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
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
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets?.length) return;

  for (const { market_id } of markets) {
    const { data: signals } = await supabase.from("signals").select("*").eq("market_id", market_id);
    if (!signals || signals.length < MIN_WALLETS_FOR_SIGNAL) continue;

    const perWalletPick = {};
    for (const sig of signals) perWalletPick[sig.wallet_id] = getPick(sig);

    const pickCounts = {};
    for (const pick of Object.values(perWalletPick)) if (pick && pick !== "Unknown") pickCounts[pick] = (pickCounts[pick] || 0) + 1;

    const entries = Object.entries(pickCounts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;
    if (entries.length > 1 && entries[0][1] === entries[1][1]) continue; // tie

    const [majorityPick, walletCount] = entries[0];
    if (walletCount < MIN_WALLETS_FOR_SIGNAL) continue;

    const confidence = getConfidenceEmoji(walletCount);
    const sig = signals.find(s => getPick(s) === majorityPick);
    if (!sig) continue;
    if (!FORCE_SEND && sig.signal_sent_at) continue;

    const emoji = RESULT_EMOJIS[sig.outcome] || "⚪";
    const text = formatSignal({ ...sig, side: majorityPick }, confidence, emoji, "Signal Sent");

    await sendTelegram(text);
    await updateNotes("polymarket-millionaires", text);

    await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("market_id", market_id);
  }
}

/* ===========================
   Leaderboard Wallets
=========================== */
async function fetchAndInsertLeaderboardWallets() {
  const timePeriods = ["DAY", "WEEK", "MONTH", "ALL"];
  let totalInserted = 0;

  for (const period of timePeriods) {
    try {
      const url = `https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=${period}&orderBy=PNL&limit=50`;
      const data = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      console.log(`[LEADERBOARD][${period}] Fetched=${data.length}`);

      for (const entry of data) {
        if (!entry.proxyWallet || entry.pnl < 10000 || entry.vol >= 6 * entry.pnl) continue;

        const { data: existing } = await supabase.from("wallets").select("id")
          .or(`polymarket_proxy_wallet.eq.${entry.proxyWallet},polymarket_username.eq.${entry.userName}`).maybeSingle();
        if (existing) continue;

        await supabase.from("wallets").insert({
          polymarket_proxy_wallet: entry.proxyWallet,
          polymarket_username: entry.userName,
          last_checked: new Date(),
          paused: false,
        });
        totalInserted++;
      }
    } catch (err) {
      console.error(`Failed to fetch leaderboard (${period}):`, err.message);
    }
  }

  console.log(`Leaderboard fetch complete. Total new wallets inserted: ${totalInserted}`);
}

/* ===========================
   Daily Summary
=========================== */
async function sendDailySummary() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const startYesterday = new Date(yesterday.setHours(0, 0, 0, 0));
  const endYesterday = new Date(yesterday.setHours(23, 59, 59, 999));

  const { data: ySignals } = await supabase.from("signals").select("*")
    .gte("created_at", startYesterday.toISOString())
    .lte("created_at", endYesterday.toISOString());

  const { data: allSignals } = await supabase.from("signals").select("*");
  const pendingSignals = allSignals.filter(s => s.outcome === "Pending");

  let summaryText = `Yesterday's results:\n`;
  if (!ySignals.length) summaryText += `0 predictions yesterday.\n`;
  else ySignals.forEach(s => summaryText += `${s.signal} - ${s.side} - ${s.outcome || "Pending"} ${RESULT_EMOJIS[s.outcome] || "⚪"}\n`);

  summaryText += `\nPending picks:\n`;
  if (!pendingSignals.length) summaryText += `0 predictions pending ⚪\n`;
  else pendingSignals.forEach(s => summaryText += `${s.signal} - ${s.side} - Pending ⚪\n`);

  await sendTelegram(toBlockquote(summaryText), true);
  await supabase.from("notes").update({ content: toBlockquote(summaryText), public: true }).eq("slug", "polymarket-millionaires");

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
  await fetchAndInsertLeaderboardWallets();

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets?.length) return;
      console.log("Wallets loaded:", wallets.length);

      await Promise.all(wallets.map(trackWallet));
    } catch (e) {
      console.error("Loop error:", e);
      await sendTelegram(`Tracker loop error: ${e.message}`);
    }
  }, POLL_INTERVAL);
}

main();

/* ===========================
   Keep Render happy
=========================== */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Polymarket tracker running\n");
}).listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
