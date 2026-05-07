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

// ===== INIT TABLES =====
(async () => {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    user_name TEXT UNIQUE,
    profile JSONB DEFAULT '{}'
  )`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS memory(
    id SERIAL PRIMARY KEY,
    user_name TEXT,
    category TEXT,
    content TEXT,
    importance INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS decisions(
    id SERIAL PRIMARY KEY,
    user_name TEXT,
    goal TEXT,
    action TEXT,
    result TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS leads(
    id SERIAL PRIMARY KEY,
    query TEXT,
    link TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
})();

// ===== AI CHAT WITH MEMORY =====
app.post("/ai", async (req, res) => {
  const { prompt, userName } = req.body;

  // STORE USER INPUT
  await pool.query(
    "INSERT INTO memory(user_name,category,content) VALUES($1,$2,$3)",
    [userName, "conversation", prompt]
  );

  // LOAD MEMORY
  const mem = await pool.query(
    "SELECT content FROM memory WHERE user_name=$1 ORDER BY importance DESC, created_at DESC LIMIT 10",
    [userName]
  );

  const memoryText = mem.rows.map(m => m.content).join("\n");

  // AI CALL
  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `User Memory:\n${memoryText}` },
        { role: "user", content: prompt }
      ]
    })
  });

  const d = await ai.json();
  const reply = d.choices?.[0]?.message?.content || "No response";

  // STORE RESPONSE
  await pool.query(
    "INSERT INTO memory(user_name,category,content) VALUES($1,$2,$3)",
    [userName, "ai", reply]
  );

  // AUTO LEARN
  if (prompt.toLowerCase().includes("my name is")) {
    const name = prompt.split("is")[1]?.trim();

    await pool.query(`
      INSERT INTO users(user_name, profile)
      VALUES($1,$2)
      ON CONFLICT (user_name)
      DO UPDATE SET profile = jsonb_set(users.profile, '{name}', to_jsonb($2::text))
    `, [userName, name]);
  }

  res.json({ result: reply });
});

// ===== MEMORY AUTO CLASSIFIER =====
app.post("/memory/auto", async (req, res) => {
  const { userName, text } = req.body;

  let category = "general";
  let importance = 1;

  if (text.includes("my name")) category = "identity", importance = 5;
  if (text.includes("I like")) category = "preference", importance = 4;
  if (text.includes("goal") || text.includes("I need")) category = "goal", importance = 5;

  await pool.query(
    "INSERT INTO memory(user_name,category,content,importance) VALUES($1,$2,$3,$4)",
    [userName, category, text, importance]
  );

  res.json({ status: "stored" });
});

// ===== DECISION ENGINE =====
app.post("/ai/decide", async (req, res) => {
  const { userName, goal } = req.body;

  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a decision-making AI" },
        { role: "user", content: `Goal: ${goal}. Give next action.` }
      ]
    })
  });

  const d = await ai.json();
  const action = d.choices[0].message.content;

  await pool.query(
    "INSERT INTO decisions(user_name,goal,action) VALUES($1,$2,$3)",
    [userName, goal, action]
  );

  res.json({ action });
});

// ===== AUTONOMOUS BRAIN =====
app.post("/brain/start", (req, res) => {
  const { userName, goal } = req.body;

  (async () => {
    while (true) {
      const r = await fetch(process.env.BASE_URL + "/ai/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName, goal })
      });

      const d = await r.json();

      console.log("🧠 ACTION:", d.action);

      await pool.query(
        "INSERT INTO memory(user_name,category,content) VALUES($1,$2,$3)",
        [userName, "action", d.action]
      );

      await new Promise(r => setTimeout(r, 5000));
    }
  })();

  res.json({ status: "running" });
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

// ===== LEADS SYSTEM =====
app.post("/money/leads", async (req, res) => {
  const query = req.body.query;

  const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  const html = await r.text();

  const results = [];
  const reg = /uddg=([^&"]+)/g;
  let m;

  while ((m = reg.exec(html))) {
    const link = decodeURIComponent(m[1]);
    results.push(link);

    await pool.query(
      "INSERT INTO leads(query,link) VALUES($1,$2)",
      [query, link]
    );

    if (results.length >= 10) break;
  }

  res.json({ results });
});

app.get("/money/leads", async (req, res) => {
  const d = await pool.query("SELECT * FROM leads ORDER BY created_at DESC LIMIT 50");
  res.json(d.rows);
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

// ===== AGENT AUTOMATION =====
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

// ===== PAYMENTS =====
app.post("/checkout", async (req, res) => {
  const s = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "AI OS PRO" },
        unit_amount: 2000
      },
      quantity: 1
    }],
    success_url: "https://example.com",
    cancel_url: "https://example.com"
  });

  res.json({ url: s.url });
});

// ===== HEALTH =====
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===== START =====
// ===============================
// AI CLOSER SYSTEM
// ===============================

// SALES TABLE
(async()=>{

await pool.query(`
CREATE TABLE IF NOT EXISTS sales(
 id SERIAL PRIMARY KEY,
 user_name TEXT,
 lead TEXT,
 email TEXT,
 status TEXT DEFAULT 'new',
 conversation TEXT DEFAULT '',
 last_contact TIMESTAMP,
 deal_value INT DEFAULT 0,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`);

})();

// ===============================
// GENERATE SALES MESSAGE
// ===============================
app.post("/sales/message", async(req,res)=>{

 const { lead, service } = req.body;

 try{

 const ai = await fetch("https://api.openai.com/v1/chat/completions",{
   method:"POST",
   headers:{
     Authorization:`Bearer ${process.env.OPENAI_KEY}`,
     "Content-Type":"application/json"
   },
   body:JSON.stringify({
     model:"gpt-4o-mini",
     messages:[
       {
         role:"system",
         content:"You are a professional sales closer."
       },
       {
         role:"user",
         content:`
Create a short persuasive outreach message.

Service:
${service}

Lead:
${lead}
`
       }
     ]
   })
 });

 const d = await ai.json();

 res.json({
   message:d.choices?.[0]?.message?.content || "Hello"
 });

 }catch(e){
   res.json({error:e.message});
 }

});

// ===============================
// HANDLE REPLIES
// ===============================
app.post("/sales/reply", async(req,res)=>{

 const { email, reply } = req.body;

 try{

 // LOAD SALES RECORD
 const sale = await pool.query(
   "SELECT * FROM sales WHERE email=$1 LIMIT 1",
   [email]
 );

 const convo = sale.rows[0]?.conversation || "";

 // AI RESPONSE
 const ai = await fetch("https://api.openai.com/v1/chat/completions",{
   method:"POST",
   headers:{
     Authorization:`Bearer ${process.env.OPENAI_KEY}`,
     "Content-Type":"application/json"
   },
   body:JSON.stringify({
     model:"gpt-4o-mini",
     messages:[
       {
         role:"system",
         content:`
You are an AI sales closer.

Your goal:
- build trust
- answer objections
- close the sale
- move toward payment
`
       },
       {
         role:"user",
         content:`
Conversation:
${convo}

Lead Reply:
${reply}
`
       }
     ]
   })
 });

 const d = await ai.json();

 const response =
 d.choices?.[0]?.message?.content || "Thanks for the reply.";

 // SAVE CONVERSATION
 await pool.query(`
 UPDATE sales
 SET
 conversation = conversation || $1,
 last_contact = NOW(),
 status='engaged'
 WHERE email=$2
 `,
 [`\nLEAD:${reply}\nAI:${response}`, email]);

 res.json({
   response
 });

 }catch(e){
   res.json({error:e.message});
 }

});

// ===============================
// AUTO CLOSE DEAL
// ===============================
app.post("/sales/close", async(req,res)=>{

 const { email, amount, service } = req.body;

 try{

 const s = await stripe.checkout.sessions.create({
   payment_method_types:["card"],
   mode:"payment",
   line_items:[{
     price_data:{
       currency:"usd",
       product_data:{
         name:service || "AI Service"
       },
       unit_amount:amount || 10000
     },
     quantity:1
   }],
   success_url:process.env.BASE_URL,
   cancel_url:process.env.BASE_URL
 });

 // UPDATE SALE
 await pool.query(`
 UPDATE sales
 SET
 status='payment_sent',
 deal_value=$1
 WHERE email=$2
 `,[amount,email]);

 res.json({
   payment_url:s.url
 });

 }catch(e){
   res.json({error:e.message});
 }

});

// ===============================
// AUTO FOLLOW UPS
// ===============================
app.post("/sales/followups", async(req,res)=>{

 try{

 const leads = await pool.query(`
 SELECT * FROM sales
 WHERE
 status='contacted'
 AND last_contact < NOW() - INTERVAL '2 days'
 LIMIT 20
 `);

 for(let l of leads.rows){

   const body = `
Just checking in.

Are you still interested in learning more?
`;

   await fetch(process.env.BASE_URL + "/agent/execute",{
     method:"POST",
     headers:{
       "Content-Type":"application/json"
     },
     body:JSON.stringify({
       action:"send_email",
       data:{
         to:l.email,
         subject:"Following up",
         body
       }
     })
   });

   await pool.query(`
   UPDATE sales
   SET last_contact=NOW()
   WHERE id=$1
   `,[l.id]);

 }

 res.json({
   status:"followups sent"
 });

 }catch(e){
   res.json({error:e.message});
 }

});

// ===============================
// FULL AI SALES LOOP
// ===============================
app.post("/sales/auto", (req,res)=>{

 const { service } = req.body;

 (async()=>{

   while(true){

     try{

       // LOAD NEW LEADS
       const leads = await pool.query(`
       SELECT * FROM sales
       WHERE status='new'
       LIMIT 5
       `);

       for(let l of leads.rows){

         // GENERATE MESSAGE
         const msg = await fetch(
           process.env.BASE_URL + "/sales/message",
           {
             method:"POST",
             headers:{
               "Content-Type":"application/json"
             },
             body:JSON.stringify({
               lead:l.lead,
               service
             })
           }
         );

         const m = await msg.json();

         // SEND EMAIL
         await fetch(
           process.env.BASE_URL + "/agent/execute",
           {
             method:"POST",
             headers:{
               "Content-Type":"application/json"
             },
             body:JSON.stringify({
               action:"send_email",
               data:{
                 to:l.email,
                 subject:"Quick Question",
                 body:m.message
               }
             })
           }
         );

         // UPDATE STATUS
         await pool.query(`
         UPDATE sales
         SET
         status='contacted',
         last_contact=NOW()
         WHERE id=$1
         `,[l.id]);

       }

       console.log("🤖 SALES LOOP RUNNING");

     }catch(e){
       console.log(e.message);
     }

     await new Promise(r=>setTimeout(r,60000));

   }

 })();

 res.json({
   status:"AI SALES SYSTEM RUNNING"
 });

});
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 FULL AI OS RUNNING");
});
