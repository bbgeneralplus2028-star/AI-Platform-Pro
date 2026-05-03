const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

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

// ===== INIT TABLES =====
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      user_name TEXT,
      message TEXT,
      reply TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      pin TEXT
    )
  `);
}
initDB();

// ===== HOME =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, pin } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (user.rows.length === 0) {
    await pool.query(
      "INSERT INTO users (username, pin) VALUES ($1,$2)",
      [username, pin]
    );
    return res.json({ status: "created" });
  }

  if (user.rows[0].pin === pin) {
    return res.json({ status: "ok" });
  }

  res.status(401).json({ error: "Wrong PIN" });
});

// ===== AI WITH MEMORY (🔥 FIXED) =====
app.post("/ai", async (req, res) => {
  try {
    const { prompt, userName } = req.body;

    // 🧠 LOAD LAST MEMORY
    const mem = await pool.query(
      "SELECT message, reply FROM chats WHERE user_name=$1 ORDER BY created_at DESC LIMIT 5",
      [userName]
    );

    const memoryText = mem.rows
      .map(m => `User: ${m.message}\nAI: ${m.reply}`)
      .join("\n");

    // 🤖 AI CALL
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are a smart assistant.

User name: ${userName}

Memory:
${memoryText}

Use memory to answer questions and remember facts about the user.
`
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    // 💾 SAVE
    await pool.query(
      "INSERT INTO chats (user_name,message,reply) VALUES ($1,$2,$3)",
      [userName, prompt, reply]
    );

    res.json({ result: reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

// ===== MEMORY =====
app.get("/memory/:name", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM chats WHERE user_name=$1 ORDER BY created_at DESC LIMIT 10",
    [req.params.name]
  );
  res.json(result.rows);
});

// ===== SCRAPE =====
app.post("/scrape", async (req, res) => {
  try {
    const r = await fetch(req.body.url);
    const html = await r.text();
    res.json({ content: html.substring(0, 3000) });
  } catch {
    res.json({ content: "Failed to fetch" });
  }
});

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ AI PLATFORM OS RUNNING"));
