const express = require("express");
const cors = require("cors");
const path = require("path");

require("dotenv").config();

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== SERVE FRONTEND =====
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== AI ENDPOINT =====
app.post("/ai", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.json({ result: "No prompt provided" });
    }

    const OPENAI_KEY = process.env.OPENAI_KEY;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    const reply =
      data.choices?.[0]?.message?.content ||
      "No response from AI";

    res.json({ result: reply });

  } catch (err) {
    console.error("AI ERROR:", err);
    res.status(500).json({ error: "AI server error" });
  }
});

// ===== AI MODE (QR / SHORTCUT) =====
app.get("/ai-mode", (req, res) => {
  res.send(`
    <h2>🤖 AI Assistant Ready</h2>
    <p>Tap below to open shortcut:</p>

    <a href="shortcuts://run-shortcut?name=AI Assistant">
      ▶ Open Siri Shortcut
    </a>

    <br><br>

    <a href="/">⬅ Back to App</a>
  `);
});

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date()
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("✅ AI Platform running on port", PORT);
});
