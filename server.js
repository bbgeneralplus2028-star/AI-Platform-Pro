const express = require("express");
const cors = require("cors");
const path = require("path");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== SUPABASE CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
              ? `The user's name is ${userName}. Speak naturally and remember them.`
              : "You are a helpful assistant."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    // ===== SAVE TO SUPABASE =====
    if (SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/chats`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_name: userName || "guest",
          message: prompt,
          reply: reply
        })
      });
    }

    res.json({ result: reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI error" });
  }
});

// ===== LOAD MEMORY =====
app.get("/memory/:name", async (req, res) => {
  try {
    const name = req.params.name;

    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/chats?user_name=eq.${name}&order=created_at.desc&limit=10`,
      {
        headers: {
          "apikey": process.env.SUPABASE_KEY,
          "Authorization": `Bearer ${process.env.SUPABASE_KEY}`
        }
      }
    );

    const data = await response.json();

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: "Memory load error" });
  }
});

// ===== HEALTH =====
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ===== START =====
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("✅ AI with Memory running on", PORT);
});
