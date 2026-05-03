const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== FILE DATABASE =====
const DB_FILE = "memory.json";

// load memory file
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

// save memory file
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ===== FRONTEND =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== AI + MEMORY =====
app.post("/ai", async (req, res) => {
  try {
    const { prompt, userName } = req.body;

    const OPENAI_KEY = process.env.OPENAI_KEY;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: userName
              ? `The user's name is ${userName}. Remember them.`
              : "You are a helpful assistant."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    // ===== SAVE TO FILE =====
    const db = loadDB();

    db.push({
      user_name: userName || "guest",
      message: prompt,
      reply: reply,
      time: new Date()
    });

    saveDB(db);

    res.json({ result: reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

// ===== LOAD MEMORY =====
app.get("/memory/:name", (req, res) => {
  const name = req.params.name;

  const db = loadDB();

  const userData = db.filter(item => item.user_name === name);

  res.json(userData.slice(-10)); // last 10 messages
});

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ===== START =====
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("✅ AI with local memory running on", PORT);
});
