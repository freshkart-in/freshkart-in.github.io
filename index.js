import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  keyFile: './service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Gemini client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function extractOrder(message) {
  const prompt = `
You are a data extraction assistant for a chicken and meat sales system.
From the message below, extract structured order data as **pure JSON**.
The message may contain one or multiple items.

Return JSON in this structure (no extra text or markdown):

{
  "customer_name": "string",
  "payment_mode": "Cash | UPI | Card",
  "items": [
    {
      "item": "chicken",
      "quantity": 2,
      "unit": "kg",
      "price": 180,
      "total_price": 360
    },
    {
      "item": "boneless chicken",
      "quantity": 1,
      "unit": "kg",
      "price": 250,
      "total_price": 250
    }
  ]
}

Rules:
- Default prices: chicken=180/kg, mixed chicken=200/kg, boneless chicken=250/kg, wings=190/kg, mutton=600/kg.
- Default payment_mode="Cash" if missing.
- If total_price missing, calculate quantity × price.
- Output only valid JSON, no markdown.

Message: "${message}"
`;

  const model = "gemini-2.0-flash";
  let attempts = 0;

  while (attempts < 3) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ text: prompt }],
      });

      let text = response.candidates[0].content.parts[0].text.trim();
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const cleanJson = jsonMatch ? jsonMatch[0] : text;

      return JSON.parse(cleanJson);
    } catch (error) {
      if (error.status === 429) {
        console.warn("⚠️ Gemini quota hit, retrying in 5 seconds...");
        await new Promise((res) => setTimeout(res, 5000));
        attempts++;
      } else {
        throw error;
      }
    }
  }

  throw new Error("Gemini API exhausted or returned invalid JSON.");
}



app.post("/orders", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: "Missing order message" });
    }

    const orderData = await extractOrder(message);
    if (!orderData || !orderData.items || !Array.isArray(orderData.items)) {
      return res.status(500).json({ error: "Failed to parse message into multiple items" });
    }

    const authClient = await auth.getClient();
    const sheetsAPI = google.sheets({ version: "v4", auth: authClient });

    // Prepare rows for each item
    const values = orderData.items.map((it) => [
      new Date().toLocaleString(),
      it.item,
      it.quantity,
      it.unit,
      it.price,
      it.total_price,
      orderData.customer_name,
      "Pending",
      it.payment_mode,
    ]);

    await sheetsAPI.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Orders!A:J",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    res.json({ success: true, order: orderData, message: "Multiple items saved successfully!" });
  } catch (error) {
    console.error("Error processing order:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/orders", async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const sheetsAPI = google.sheets({ version: "v4", auth: authClient });

    const response = await sheetsAPI.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Orders!A:J", // Columns A to I
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return res.json({ success: true, orders: [] });
    }

    // Convert rows into objects
    const formatted = rows.slice(1).map((row,index) => ({
      id: index + 1,
      datetime: row[1] || "",
      item: row[2] || "",
      quantity: row[3] || "",
      unit: row[4] || "",
      price: row[5] || "",
      total_price: row[6] || "",
      customer_name: row[7] || "",
      status: row[8] || "",
      payment_mode: row[9] || "",
    }));

    res.json({ success: true, orders: formatted });

  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});




app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
