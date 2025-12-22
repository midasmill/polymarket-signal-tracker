import { createClient } from "@supabase/supabase-js";
import { ethers } from "ethers";
import fetch from "node-fetch";

// ---------------------------
// Environment variables
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required.");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Telegram bot info required.");

// ---------------------------
// Supabase client
// ---------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------
// Polygon provider
// ---------------------------
const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");

// ---------------------------
// Polymarket Conditional Tokens contract
// ---------------------------
const ctfAddress = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const ctfAbi = [
  "function getPositionId(bytes32 conditionId, uint outcomeIndex, address collateralToken) view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)"
];
const ctf = new ethers.Contract(ctfAddress, ctfAbi, provider);

// ---------------------------
// Polling interval
// ---------------------------
const POLL_INTERVAL = 30 * 1000; // 30 seconds

// ---------------------------
// Telegram alert
// ---------------------------
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

// ---------------------------
// Active markets (example)
// ---------------------------
async function getActiveMarkets() {
  return [
    {
      marketName: "Fed decision in January?",
      conditionId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      collateralToken: "0x0000000000000000000000000000000000000000",
      outcomes: 2
    },
    // Add more markets here
  ];
}

// ---------------------------
// Generate tokenId map
// ---------------------------
async function generateTokenIdMap() {
  const markets = await getActiveMarkets();
  const tokenIdMap = {};

  for (const market of markets) {
    for (let i = 0; i < market.outcomes; i++) {
      try {
        const tokenId = await ctf.getPositionId(
          market.conditionId,
          i,
          market.collateralToken
        );
        tokenIdMap[tokenId.toString()] = { marketName: market.marketName, outcomeIndex: i, conditionId: market.conditionId };
      } catch (err) {
        console.error(`Error generating tokenId for ${market.marketName} outcome ${i}:`, err.message);
      }
    }
  }

  return tokenIdMap;
}

// ---------------------------
// Fetch wallet positions
// ---------------------------
async function fetchWalletPositions(walletAddress, tokenIdMap) {
  const positions = [];
  for (const [tokenId, info] of Object.entries(tokenIdMap)) {
    try {
      const balance = await ctf.balanceOf(walletAddress, tokenId);
      if (balance > 0) positions.push({ tokenId, ...info, amount: Number(balance) });
    } catch (err) {
      console.error(`Error fetching balance for ${walletAddress} tokenId ${tokenId}:`, err.message);
    }
  }
  return positions;
}

// ---------------------------
// Generate signal
// ---------------------------
function generateSignal(positions) {
  if (!positions || positions.length === 0) return null;
  const pos = positions[0]; // pick first
  const side = Math.random() > 0.5 ? "YES" : "NO";

  return {
    signal: pos.marketName,
    side,
    outcome: "Pending",
    outcome_at: null,
    conditionId: pos.conditionId,
    outcomeIndex: pos.outcomeIndex,
    sent_at: new Date()
  };
}

// ---------------------------
// Track single wallet
// ---------------------------
async function trackWallet(wallet, tokenIdMap) {
  if (wallet.paused) return;

  const positions = await fetchWalletPositions(wallet.wallet_address, tokenIdMap);
  if (!positions || positions.length === 0) return;

  const result = generateSignal(positions);
  if (!result) return;

  // Insert signal into Supabase
  const { data: insertedSignal } = await supabase.from("signals").insert([{
    wallet_id: wallet.id,
    signal: result.signal,
    outcome: result.outcome,
    outcome_at: result.outcome_at,
    created_at: result.sent_at
  }]).select().single();

  // Update notes content
  const { data: existingNotes } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", "polymarket-millionaires")
    .single();

  let contentArray = existingNotes?.content?.split("</p>").filter(Boolean) || [];

  contentArray.unshift(
    `<p>
       Signal Sent: ${result.sent_at.toLocaleString("en-US")}<br>
       Buy: ${result.side}<br>
       Market: ${result.signal}<br>
       Outcome: Pending
     </p>`
  );

  const MAX_SIGNALS = 50;
  contentArray = contentArray.slice(0, MAX_SIGNALS);

  const newContent = contentArray.map(c => c + "</p>").join("");

  await supabase.from("notes")
    .update({ content: newContent, public: true })
    .eq("slug", "polymarket-millionaires");

  // Send Telegram alert
  await sendTelegram(
    `Signal Sent: ${result.sent_at.toLocaleString("en-US")}\nBuy: ${result.side}\nMarket: ${result.signal}\nOutcome: Pending`
  );
}

// ---------------------------
// Real on-chain outcome check
// ---------------------------
async function getWinningOutcome(conditionId) {
  const markets = await getActiveMarkets();
  const market = markets.find(m => m.conditionId === conditionId);
  if (!market) return null;

  for (let i = 0; i < market.outcomes; i++) {
    const tokenId = await ctf.getPositionId(
      conditionId,
      i,
      market.collateralToken
    );
    const balance = await ctf.balanceOf("0x0000000000000000000000000000000000000000", tokenId);
    if (balance === 1) return i;
  }

  return null; // Not resolved yet
}

// ---------------------------
// Update pending outcomes and summary
// ---------------------------
async function updatePendingOutcomes() {
  const { data: pendingSignals } = await supabase
    .from("signals")
    .select("*")
    .is("outcome", "Pending");

  if (!pendingSignals || pendingSignals.length === 0) return;

  const { data: existingNotes } = await supabase
    .from("notes")
    .select("content")
    .eq("slug", "polymarket-millionaires")
    .single();

  let contentArray = existingNotes?.content?.split("</p>").filter(Boolean) || [];

  let summaryUpdated = false;

  for (const sig of pendingSignals) {
    const winningOutcome = await getWinningOutcome(sig.conditionId);
    if (winningOutcome === null) continue;

    const outcomeText = sig.outcomeIndex === winningOutcome ? "WIN" : "LOSS";
    const outcomeTime = new Date().toLocaleString("en-US");

    // Update signals table
    await supabase.from("signals")
      .update({ outcome: outcomeText, outcome_at: new Date().toISOString() })
      .eq("id", sig.id);

    // Update notes feed line
    contentArray = contentArray.map(line => {
      if (line.includes(sig.signal) && line.includes("Pending")) {
        summaryUpdated = true;
        return line.replace("Pending", `${outcomeText} (Resolved: ${outcomeTime})`);
      }
      return line;
    });

    // Send Telegram alert
    await sendTelegram(
      `Outcome Update:\nSignal Sent: ${new Date(sig.created_at).toLocaleString("en-US")}\nBuy: ${sig.side || "YES"}\nMarket: ${sig.signal}\nOutcome: ${outcomeText}`
    );
  }

  // ---------------------------
  // Update summary line if any outcome resolved
  // ---------------------------
  if (summaryUpdated) {
    const { data: summary } = await supabase
      .from("signals")
      .select("outcome")
      .in("outcome", ["WIN", "LOSS"]);

    const wins = summary.filter(s => s.outcome === "WIN").length;
    const losses = summary.filter(s => s.outcome === "LOSS").length;
    const winRate = losses + wins > 0 ? ((wins / (wins + losses)) * 100).toFixed(2) : 0;

    const summaryLine = `<p>Summary: ${wins} WIN(s), ${losses} LOSS(es), Win Rate: ${winRate}%</p>`;

    // Remove old summary line if exists
    contentArray = contentArray.filter(line => !line.startsWith("<p>Summary:"));

    // Prepend new summary
    contentArray.unshift(summaryLine);
  }

  // Limit to last 50 signals
  const MAX_SIGNALS = 50;
  const newContent = contentArray.slice(0, MAX_SIGNALS).map(c => c + "</p>").join("");

  await supabase.from("notes")
    .update({ content: newContent })
    .eq("slug", "polymarket-millionaires");
}

// ---------------------------
// Main loop
// ---------------------------
async function main() {
  console.log("🚀 Polymarket wallet tracker started.");

  setInterval(async () => {
    try {
      await updatePendingOutcomes();

      const tokenIdMap = await generateTokenIdMap();
      const { data: wallets } = await supabase.from("wallets").select("*");

      for (const wallet of wallets) {
        await trackWallet(wallet, tokenIdMap);
      }
    } catch (err) {
      console.error("Tracker loop error:", err);
    }
  }, POLL_INTERVAL);
}

main();
