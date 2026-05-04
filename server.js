const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const multer = require("multer");
const fs = require("fs");
const stripe = require("stripe")(process.env.STRIPE_KEY);
const { chromium } = require("playwright");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      pin TEXT
    )
  `);
})();

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, pin } = req.body;

  const u = await pool.query("SELECT * FROM users WHERE username=$1", [username]);

  if (u.rows.length === 0) {
    await pool.query("INSERT INTO users(username,pin) VALUES($1,$2)", [username, pin]);
    return res.json({ status: "created" });
  }

  if (u.rows[0].pin === pin) return res.json({ status: "ok" });

  res.status(401).json({ error: "wrong pin" });
});

// ===== AI (MEMORY ENABLED) =====
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
        { role: "system", content: `User:${userName}\n${memory}` },
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

// ===== FETCH ARTICLE =====
app.post("/fetch-article", async (req, res) => {
  const r = await fetch(req.body.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await r.text();

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  res.json({ content: text.substring(0, 10000) });
});

// ===== FILE UPLOAD =====
const upload = multer({ dest: "uploads/" });

app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ file: req.file });
});

app.get("/files", (req, res) => {
  fs.readdir("uploads", (e, f) => {
    if (e) return res.json([]);
    res.json(f);
  });
});

// ===== PLAYWRIGHT ACTION AGENT =====
app.post("/agent/action", async (req, res) => {
  const { task } = req.body;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    if (task.includes("google")) {
      await page.goto("https://www.google.com");
      await page.fill('input[name="q"]', task.replace("google", ""));
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);

      const results = await page.$$eval("h3", els =>
        els.slice(0, 5).map(e => e.innerText)
      );

      await browser.close();
      return res.json({ result: results });
    }

    await browser.close();
    res.json({ result: "Task executed" });

  } catch (e) {
    await browser.close();
    res.json({ error: e.message });
  }
});

// ===== MULTI-AGENT SWARM =====
app.post("/swarm", async (req, res) => {
  const { goal } = req.body;

  const roles = ["research", "executor", "analyst"];
  let outputs = [];

  for (const role of roles) {
    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `You are a ${role} agent` },
          { role: "user", content: goal }
        ]
      })
    });

    const d = await ai.json();
    outputs.push({ role, output: d.choices[0].message.content });
  }

  res.json(outputs);
});

// ===== COMMAND ROUTER =====
app.post("/command", async (req, res) => {
  const { cmd } = req.body;

  if (cmd === "time") {
    return res.json({ result: new Date().toString() });
  }

  res.json({ result: "Unknown command" });
});

// ===== ANALYTICS =====
app.get("/stats", async (req, res) => {
  const users = await pool.query("SELECT COUNT(*) FROM users");
  const chats = await pool.query("SELECT COUNT(*) FROM chats");

  res.json({
    users: users.rows[0].count,
    chats: chats.rows[0].count
  });
});

// ===== PAYMENTS =====
app.post("/checkout", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "AI OS" },
        unit_amount: 2000
      },
      quantity: 1
    }],
    success_url: "https://example.com",
    cancel_url: "https://example.com"
  });

  res.json({ url: session.url });
});

// ===== HEALTH =====
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(process.env.PORT || 10000, () =>
  console.log("🚀 AI OS JARVIS MODE RUNNING")
);
