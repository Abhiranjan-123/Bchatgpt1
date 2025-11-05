// backend/server.js
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 5000;

/* -----------------------------
   ✅ 1️⃣ Enable CORS for Netlify + Localhost
----------------------------- */
app.use(cors({
  origin: [
    "https://roaring-zabaione-cc06a9.netlify.app/", // ✅ Replace this with your actual Netlify site
    "http://localhost:3000", // for local frontend dev
    "http://localhost:5000"  // for backend testing
  ],
  methods: ["GET", "POST"],
  credentials: true
}));

// Middleware
app.use(express.json());

/* -----------------------------
   ✅ 2️⃣ Load dataset
----------------------------- */
const dataPath = path.join(__dirname, "data.json");
let qaData = [];
function loadData() {
  try {
    qaData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    console.log(`📗 Loaded data.json (${qaData.length} entries)`);
  } catch {
    console.error("❌ Could not read data.json.");
    qaData = [];
  }
}
loadData();

/* -----------------------------
   ✅ 3️⃣ Text helpers
----------------------------- */
const STOPWORDS = new Set([
  "the", "is", "in", "at", "which", "on", "a", "an", "and", "of", "for",
  "to", "from", "by", "what", "who", "when", "where", "why", "how", "about", "tell", "me"
]);
function normalize(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
function keywords(text) {
  return normalize(text).split(" ").filter(w => w && !STOPWORDS.has(w));
}
function keywordScore(a, b) {
  const A = new Set(keywords(a));
  const B = new Set(keywords(b));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  let score = inter / union;
  if (normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a))) score = Math.max(score, 0.8);
  return score;
}
function findBestAnswer(message) {
  let best = null, bestScore = 0;
  for (const item of qaData) {
    const s = keywordScore(message, item.question || "");
    if (s > bestScore) { bestScore = s; best = item; }
  }
  if (best && bestScore >= 0.55) {
    console.log(`✅ Dataset match (score=${bestScore.toFixed(2)}): ${best.question}`);
    return best.answer;
  }
  console.log(`⚠️ No dataset match (best=${bestScore.toFixed(2)})`);
  return null;
}

/* -----------------------------
   ✅ 4️⃣ Groq (LLaMA-3)
----------------------------- */
async function askGroq(prompt) {
  if (!process.env.GROQ_API_KEY) {
    console.error("❌ Missing GROQ_API_KEY in .env");
    return null;
  }
  try {
    console.log("⚡ Asking Groq LLaMA 3 for:", prompt);
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile", // ✅ new stable model
        messages: [
          { role: "system", content: "You are a helpful AI assistant." },
          { role: "user", content: prompt }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    const text = response.data?.choices?.[0]?.message?.content;
    return text?.trim() || null;
  } catch (err) {
    console.error("❌ Groq error:", err.response?.data || err.message);
    return null;
  }
}

/* -----------------------------
   ✅ 5️⃣ Web Fallbacks
----------------------------- */
function looksEnglish(s) {
  if (!s) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  return letters > 5 && nonAscii / s.length < 0.15;
}

async function googleSearch(query) {
  try {
    console.log("🌐 Searching Google:", query);
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 });
    const $ = cheerio.load(data);
    const texts = [];
    $("div.BNeawe.s3v9rd.AP7Wnd, div.IsZvec").each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 40 && looksEnglish(t)) texts.push(t);
    });
    const uniq = [...new Set(texts)].slice(0, 5);
    return uniq.join(" ").split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
  } catch (err) {
    console.warn("googleSearch failed:", err.message);
    return null;
  }
}

async function duckDuckGoSearch(query) {
  try {
    console.log("🦆 Searching DuckDuckGo:", query);
    const { data } = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, { timeout: 10000 });
    if (data?.AbstractText && looksEnglish(data.AbstractText)) return data.AbstractText;
    const rel = data?.RelatedTopics?.[0]?.Text;
    if (rel && looksEnglish(rel)) return rel;
    return null;
  } catch (err) {
    console.warn("duckDuckGoSearch failed:", err.message);
    return null;
  }
}

async function wikipediaSearch(query) {
  try {
    console.log("📚 Searching Wikipedia:", query);
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=2`;
    const sRes = await axios.get(searchUrl, { timeout: 10000 });
    const pages = sRes.data?.query?.search || [];
    for (const p of pages) {
      const title = p.title;
      const eUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles=${encodeURIComponent(title)}`;
      const eRes = await axios.get(eUrl, { timeout: 10000 });
      const extract = Object.values(eRes.data?.query?.pages || {})[0]?.extract;
      if (extract && looksEnglish(extract))
        return extract.split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
    }
    return null;
  } catch (err) {
    console.warn("wikipediaSearch failed:", err.message);
    return null;
  }
}

async function webFallback(query) {
  const g = await googleSearch(query);
  if (g) return `From Google: ${g}`;
  const d = await duckDuckGoSearch(query);
  if (d) return `From DuckDuckGo: ${d}`;
  const w = await wikipediaSearch(query);
  if (w) return `From Wikipedia: ${w}`;
  return `I couldn't find a clear English answer for “${query}”.`;
}

/* -----------------------------
   ✅ 6️⃣ Personality Replies
----------------------------- */
function personalityReply(message) {
  const m = message.toLowerCase();
  if (m.includes("who created you") || m.includes("who made you"))
    return "My creator is Abhiranjan Singh — smart, funny, and a bit pagal 😜";
  if (m.includes("girlfriend") || m.includes("boyfriend"))
    return "Haha, still single — my love life is stuck in beta mode 🤖💕";
  return null;
}

/* -----------------------------
   ✅ 7️⃣ Chat Endpoint
----------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: "No message received." });

    console.log(`💭 User asked: "${message}"`);
    let reply = null;

    reply = personalityReply(message);
    if (reply) return res.json({ reply });

    reply = findBestAnswer(message);
    if (reply) return res.json({ reply });

    reply = await askGroq(message);
    if (reply) return res.json({ reply });

    reply = await webFallback(message);
    return res.json({ reply: reply || "😕 Sorry, I couldn’t find a clear answer." });
  } catch (err) {
    console.error("Server error:", err.message);
    return res.status(500).json({ reply: "Internal server error." });
  }
});

/* -----------------------------
   ✅ 8️⃣ Basic health route for Render
----------------------------- */
app.get("/", (req, res) => {
  res.status(200).send("✅ Backend is live and working!");
});

/* -----------------------------
   ✅ 9️⃣ Start server
----------------------------- */
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

