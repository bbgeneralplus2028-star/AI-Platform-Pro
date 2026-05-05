const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const fs = require("fs");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const { chromium } = require("playwright");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== INIT =====
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats(
      id SERIAL PRIMARY KEY,
      user_name TEXT,
      message TEXT,
      reply TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

// ===== AI =====
app.post("/ai", async (req, res) => {
  const { prompt, userName } = req.body;

  const mem = await pool.query(
    "SELECT message,reply FROM chats WHERE user_name=$1 ORDER BY created_at DESC LIMIT 5",
    [userName]
  );

  const memory = mem.rows.map(m => `User:${m.message}\nAI:${m.reply}`).join("\n");

  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: memory },
        { role: "user", content: prompt }
      ]
    })
  });

  const d = await ai.json();
  const reply = d.choices?.[0]?.message?.content || "No response";

  await pool.query(
    "INSERT INTO chats(user_name,message,reply) VALUES($1,$2,$3)",
    [userName, prompt, reply]
  );

  res.json({ result: reply });
});

// ===== SEARCH =====
app.post("/search", async (req, res) => {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(req.body.query)}`);
  const html = await r.text();

  const results = [];
  const reg = /uddg=([^&"]+)/g;
  let m;

  while ((m = reg.exec(html))) {
    results.push({ link: decodeURIComponent(m[1]) });
    if (results.length >= 5) break;
  }

  res.json({ results });
});

// ===== IMAGE AI =====
app.post("/analyze-image", async (req, res) => {
  const { image } = req.body;

  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Identify item and estimate price" },
          { type: "image_url", image_url: { url: image } }
        ]
      }]
    })
  });

  const d = await ai.json();
  res.json({ result: d.choices[0].message.content });
});

// ===== FILES =====
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ file: req.file });
});

app.get("/files", (req, res) => {
  fs.readdir("uploads", (e, f) => res.json(f || []));
});

// ===== PLAYWRIGHT AGENT =====
app.post("/agent/action", async (req, res) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto("https://www.google.com");
  await page.fill('input[name="q"]', req.body.task);
  await page.keyboard.press("Enter");

  await page.waitForTimeout(3000);

  const results = await page.$$eval("h3", els => els.map(e => e.innerText));
  await browser.close();

  res.json({ result: results.slice(0, 5) });
});

// ===== AUTONOMOUS LOOP =====
let loops = {};

app.post("/agent/auto", (req, res) => {
  const { goal, id } = req.body;
  loops[id] = true;

  (async () => {
    let context = "";
    while (loops[id]) {
      const ai = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Autonomous agent" },
            { role: "user", content: `Goal:${goal}\n${context}` }
          ]
        })
      });

      const d = await ai.json();
      const step = d.choices?.[0]?.message?.content;

      console.log(step);
      context += step + "\n";

      await new Promise(r => setTimeout(r, 5000));
    }
  })();

  res.json({ status: "started" });
});

app.post("/agent/stop", (req, res) => {
  loops[req.body.id] = false;
  res.json({ status: "stopped" });
});

// ===== STRIPE =====
app.post("/checkout", async (req, res) => {
  const s = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "AI Platform" },
        unit_amount: 2000
      },
      quantity: 1
    }],
    success_url: "https://example.com",
    cancel_url: "https://example.com"
  });

  res.json({ url: s.url });
});

app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 RUNNING");
});
