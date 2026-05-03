const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const multer = require("multer");
const fs = require("fs");
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
})();

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, pin } = req.body;

  const u = await pool.query("SELECT * FROM users WHERE username=$1",[username]);

  if (u.rows.length === 0) {
    await pool.query("INSERT INTO users (username,pin) VALUES ($1,$2)",[username,pin]);
    return res.json({ status: "created" });
  }

  if (u.rows[0].pin === pin) return res.json({ status: "ok" });

  res.status(401).json({ error: "Wrong PIN" });
});

// ===== AI =====
app.post("/ai", async (req, res) => {
  try {
    const { prompt, userName } = req.body;

    const mem = await pool.query(
      "SELECT message,reply FROM chats WHERE user_name=$1 ORDER BY created_at DESC LIMIT 5",
      [userName]
    );

    const memoryText = mem.rows.map(m => `User:${m.message}\nAI:${m.reply}`).join("\n");

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        Authorization:`Bearer ${process.env.OPENAI_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model:"gpt-4o-mini",
        messages:[
          { role:"system", content:`User:${userName}\nMemory:\n${memoryText}` },
          { role:"user", content:prompt }
        ]
      })
    });

    const data = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content || "No response";

    await pool.query(
      "INSERT INTO chats (user_name,message,reply) VALUES ($1,$2,$3)",
      [userName, prompt, reply]
    );

    res.json({ result: reply });

  } catch {
    res.status(500).json({ error:"AI error" });
  }
});

// ===== MEMORY =====
app.get("/memory/:name", async (req,res)=>{
  const r = await pool.query(
    "SELECT * FROM chats WHERE user_name=$1 ORDER BY created_at DESC LIMIT 10",
    [req.params.name]
  );
  res.json(r.rows);
});

// ===== SEARCH =====
app.post("/search", async (req,res)=>{
  try{
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(req.body.query)}`);
    const html = await r.text();

    const results=[];
    const regex=/uddg=([^&"]+)/g;
    let m;

    while((m=regex.exec(html))){
      const link=decodeURIComponent(m[1]);
      results.push({title:link,link});
      if(results.length>=5) break;
    }

    res.json({results});
  }catch{
    res.json({results:[]});
  }
});

// ===== ARTICLE =====
app.post("/fetch-article", async (req,res)=>{
  try{
    const r = await fetch(req.body.url,{headers:{ "User-Agent":"Mozilla/5.0"}});
    const html = await r.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi,"")
      .replace(/<style[\s\S]*?<\/style>/gi,"")
      .replace(/<[^>]+>/g," ")
      .replace(/\s+/g," ");

    res.json({content:text.substring(0,10000)});
  }catch{
    res.json({content:"Failed"});
  }
});

// ===== FILE UPLOAD =====
const upload = multer({ dest:"uploads/" });

app.post("/upload", upload.single("file"), (req,res)=>{
  res.json({file:req.file});
});

app.get("/files",(req,res)=>{
  fs.readdir("uploads",(e,f)=>{
    if(e) return res.json([]);
    res.json(f);
  });
});

// ===== AGENTS =====
let agents=[];

app.post("/agent/create",(req,res)=>{
  const a={id:Date.now(),...req.body};
  agents.push(a);

  setInterval(async ()=>{
    const ai = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{
        Authorization:`Bearer ${process.env.OPENAI_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model:"gpt-4o-mini",
        messages:[{role:"user",content:a.goal}]
      })
    });

    const d=await ai.json();
    console.log("AGENT:",d.choices?.[0]?.message?.content);
  }, a.interval || 60000);

  res.json({status:"started"});
});

// ===== PAYMENTS =====
const stripe = require("stripe")(process.env.STRIPE_KEY);

app.post("/checkout", async (req,res)=>{
  const s = await stripe.checkout.sessions.create({
    payment_method_types:["card"],
    mode:"payment",
    line_items:[{
      price_data:{
        currency:"usd",
        product_data:{name:"AI OS Pro"},
        unit_amount:2000
      },
      quantity:1
    }],
    success_url:"https://example.com",
    cancel_url:"https://example.com"
  });

  res.json({url:s.url});
});

// ===== HEALTH =====
app.get("/health",(req,res)=>res.json({status:"ok"}));

app.listen(process.env.PORT||10000,()=>console.log("AI OS RUNNING"));
