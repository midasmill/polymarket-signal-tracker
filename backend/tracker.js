import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const POLL_INTERVAL = 30 * 1000;
const LOSING_STREAK_THRESHOLD = 3;
const MIN_WALLETS_FOR_SIGNAL = 1; // lowered for testing
const FORCE_SEND = true; // test mode: sends all eligible signals

/* ===========================
   Telegram helper
=========================== */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const json = await res.json();
    if (!json.ok) console.error("Telegram API error:", json);
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

/* ===========================
   Polymarket API
=========================== */
async function fetchLatestTrades(user) {
  const url = `https://data-api.polymarket.com/trades?limit=100&takerOnly=true&user=${user}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.error("Trade fetch error:", err.message);
    return null;
  }
}

async function fetchMarket(marketId) {
  try {
    const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ===========================
   Confidence helpers
=========================== */
function getConfidenceEmoji(count) {
  if (count > 50) return "⭐⭐⭐⭐⭐";
  if (count > 35) return "⭐⭐⭐⭐";
  if (count > 25) return "⭐⭐⭐";
  if (count > 15) return "⭐⭐";
  if (count >= MIN_WALLETS_FOR_SIGNAL) return "⭐";
  return "";
}

function confidenceToNumber(conf) {
  return (conf.match(/⭐/g) || []).length;
}

/* ===========================
   Market vote counts
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data: signals } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!signals || signals.length === 0) return null;

  const perWallet = {};
  for (const s of signals) {
    perWallet[s.wallet_id] ??= {};
    perWallet[s.wallet_id][s.side] = 1;
  }

  const counts = {};
  for (const votes of Object.values(perWallet)) {
    const sides = Object.keys(votes);
    if (sides.length !== 1) continue; // conflicting wallet → ignore
    const side = sides[0];
    counts[side] = (counts[side] || 0) + 1;
  }

  return counts;
}

function getMajoritySide(counts) {
  if (!counts) return null;
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function getMajorityConfidence(counts) {
  if (!counts) return "";
  const max = Math.max(...Object.values(counts));
  return getConfidenceEmoji(max);
}

/* ===========================
   Track Wallet Trades
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused || !wallet.polymarket_proxy_wallet) return;
  console.log("Fetching trades for proxy wallet:", wallet.polymarket_proxy_wallet);

  const trades = await fetchLatestTrades(wallet.polymarket_proxy_wallet);
  if (!trades || trades.length === 0) return;

  for (const trade of trades) {
    if (trade.proxyWallet && trade.proxyWallet.toLowerCase() !== wallet.polymarket_proxy_wallet.toLowerCase()) continue;

    // safeguard: market_id + side + signal uniqueness
    const { data: existing } = await supabase
      .from("signals")
      .select("id")
      .eq("market_id", trade.conditionId)
      .eq("side", trade.outcome)
      .eq("signal", trade.title)
      .maybeSingle();

    if (existing) continue;

    const side = String(trade.outcome).toUpperCase();

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.title,
      market_name: trade.title,
      market_id: trade.conditionId,
      side,
      tx_hash: trade.transactionHash,
      outcome: "Pending",
      created_at: new Date(trade.timestamp * 1000),
      wallet_count: 1,
      wallet_set: [String(wallet.id)],
      tx_hashes: [trade.transactionHash],
    });

    console.log("Inserted trade:", trade.transactionHash);
  }

  await supabase.from("wallets").update({ last_checked: new Date() }).eq("id", wallet.id);
}

/* ===========================
   Resolve outcomes & handle losing streaks
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase.from("signals").select("*").eq("outcome", "Pending");
  if (!pending?.length) return;

  let resolvedAny = false;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winningSide = String(market.winningOutcome || "").toUpperCase();
    if (!winningSide) continue;

    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({ outcome: result, outcome_at: new Date() })
      .eq("id", sig.id);

    const { data: wallet } = await supabase.from("wallets").select("*").eq("id", sig.wallet_id).single();

    if (result === "LOSS") {
      const streak = (wallet.losing_streak || 0) + 1;
      await supabase.from("wallets").update({ losing_streak: streak }).eq("id", wallet.id);
      if (streak >= LOSING_STREAK_THRESHOLD) {
        await supabase.from("wallets").update({ paused: true }).eq("id", wallet.id);
        await sendTelegram(`Wallet paused due to losing streak:\nWallet ID: ${wallet.id}\nLosses: ${streak}`);
      }
    }

    resolvedAny = true;

    // send Notes/Telegram for resolved signal
    const counts = await getMarketVoteCounts(sig.market_id);
    const confidence = getMajorityConfidence(counts);

    const noteText = `Result Received: ${new Date().toLocaleString()}\nMarket Event: ${sig.signal}\nPrediction: ${sig.side}\nConfidence: ${confidence}\nOutcome: ${winningSide}\nResult: ${result}\n`;

    console.log("📤 Sending resolved signal:", sig.signal, sig.side);
    await sendTelegram(noteText);

    // Ensure Notes row exists
    let notes = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();
    if (!notes) {
      const { data: inserted } = await supabase
        .from("notes")
        .insert({ slug: "polymarket-millionaires", title: "Polymarket Millionaires", content: "", public: true })
        .select("*")
        .single();
      notes = inserted;
    }

    const newContent = notes.content + `<p>${noteText.replace(/\n/g, "<br>")}</p>`;
    await supabase.from("notes").update({ content: newContent, public: true }).eq("id", notes.id);
  }

  if (resolvedAny) {
    await sendMajoritySignals();
  }
}

/* ===========================
   Send majority signals
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase.from("signals").select("market_id", { distinct: true });
  if (!markets) return;

  for (const { market_id } of markets) {
    const counts = await getMarketVoteCounts(market_id);
    const side = getMajoritySide(counts);
    if (!side) continue;

    const confidence = getMajorityConfidence(counts);
    if (!confidence) continue;

    const { data: signals } = await supabase
      .from("signals")
      .select("*")
      .eq("market_id", market_id)
      .eq("side", side);

    if (!signals) continue;

    for (const sig of signals) {
      // FORCE_SEND properly overrides
      if (sig.signal_sent_at && !FORCE_SEND) continue;

      const noteText = `Signal Sent: ${new Date().toLocaleString()}\nMarket Event: ${sig.signal}\nPrediction: ${sig.side}\nConfidence: ${confidence}\n`;

      console.log("📤 Sending majority signal:", sig.signal, sig.side);
      // Telegram
      await sendTelegram(noteText);

      // Notes page
      let notes = await supabase.from("notes").select("id, content").eq("slug", "polymarket-millionaires").maybeSingle();
      if (!notes) {
        const { data: inserted } = await supabase
          .from("notes")
          .insert({ slug: "polymarket-millionaires", title: "Polymarket Millionaires", content: "", public: true })
          .select("*")
          .single();
        notes = inserted;
      }
      const newContent = notes.content + `<p>${noteText.replace(/\n/g, "<br>")}</p>`;
      await supabase.from("notes").update({ content: newContent, public: true }).eq("id", notes.id);

      // mark as sent
      await supabase.from("signals").update({ signal_sent_at: new Date() }).eq("id", sig.id);
    }
  }
}

/* ===========================
   Main Loop
=========================== */
async function main() {
  console.log("🚀 Polymarket tracker live");

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase.from("wallets").select("*");
      if (!wallets) return;
      console.log("Wallets loaded:", wallets.length);

      for (const wallet of wallets) {
        await trackWallet(wallet);
      }

      await updatePendingOutcomes();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
