const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();

// Enable CORS for frontend client calls
app.use(cors());
app.use(express.json());

// Serve static files from the parent directory (frontend files)
app.use(express.static(path.join(__dirname, '..')));

const PORT = process.env.PORT || 3000;
const MONO_TOKEN = process.env.MONO_TOKEN;
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8551709614:AAG0cPhDj0MasK0EJjfOc1Vb7NOi_5cVIcc';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003941811035';
const SUCCESS_REDIRECT_URL = process.env.SUCCESS_REDIRECT_URL || 'https://grace-heritage.shop/index.html?status=success';

// Helper function to send messages to Telegram
async function sendTelegramMessage(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
  }
}

// Helper function to send order data to Google Apps Script
async function sendToGoogleSheets(payload) {
  if (!GOOGLE_APPS_SCRIPT_URL) {
    console.log('Google Apps Script URL is not configured. Skipping sheet log.');
    return;
  }
  try {
    await axios.post(GOOGLE_APPS_SCRIPT_URL, JSON.stringify(payload), {
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  } catch (error) {
    console.error('Error updating Google Sheets:', error.message);
  }
}

// 1. Endpoint: Create Payment Invoice
app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, phone, shipping, bundle, colors, amount, qty } = req.body;

    if (!name || !phone || !amount) {
      return res.status(400).json({ success: false, error: 'Необхідні поля відсутні' });
    }

    const orderId = `GH-${Date.now()}`;
    const colorsText = Array.isArray(colors) ? colors.join(', ') : (colors || '');

    console.log(`[PAYMENT] Creating invoice for Order: ${orderId}, Amount: ${amount} UAH`);

    // Call Monobank API to create invoice
    const monoResponse = await axios.post(
      'https://api.monobank.ua/api/merchant/invoice/create',
      {
        amount: Math.round(amount * 100), // convert to kopecks
        ccy: 980, // UAH
        merchantInvoiceId: orderId,
        redirectUrl: SUCCESS_REDIRECT_URL,
        // The webhook URL should point back to this server's public endpoint
        webHookUrl: process.env.WEBHOOK_URL ? `${process.env.WEBHOOK_URL}/api/webhook/monobank` : undefined,
        destination: `Оплата замовлення ${orderId} (Grace Heritage)`
      },
      {
        headers: {
          'X-Token': MONO_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const { pageUrl, invoiceId } = monoResponse.data;

    // Save order as pending to Google Sheets
    const sheetPayload = {
      trxId: orderId,
      name,
      phone,
      shipping,
      bundle,
      colors: colorsText,
      value: amount,
      qty: qty || 1,
      status: 'Очікує оплати'
    };
    await sendToGoogleSheets(sheetPayload);

    // Send Telegram Notification
    const tgMessage = `<b>🔔 Нове замовлення (Очікує оплати)</b>\n\n` +
      `<b>🆔 ID:</b> ${orderId}\n` +
      `<b>👤 Ім'я:</b> ${name}\n` +
      `<b>📞 Телефон:</b> ${phone}\n` +
      `<b>📍 Доставка:</b> ${shipping}\n` +
      `<b>📦 Комплект:</b> ${bundle}\n` +
      `<b>🎨 Колір:</b> ${colorsText}\n` +
      `<b>💵 Сума:</b> ${amount} ₴`;
    await sendTelegramMessage(tgMessage);

    res.json({
      success: true,
      orderId,
      pageUrl,
      invoiceId
    });

  } catch (error) {
    console.error('Error creating invoice:', error.response ? error.response.data : error.message);
    res.status(500).json({
      success: false,
      error: 'Помилка створення платіжного посилання Monobank',
      details: error.response ? error.response.data : error.message
    });
  }
});

// 2. Endpoint: Monobank Webhook Callback
app.post('/api/webhook/monobank', async (req, res) => {
  try {
    const { invoiceId, status, merchantInvoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).send('Bad Request');
    }

    console.log(`[WEBHOOK] Received update for Invoice: ${invoiceId}, Status: ${status}`);

    // SECURITY VERIFICATION: Verify status directly from Monobank server to prevent webhook spoofing
    const verifyResponse = await axios.get(
      `https://api.monobank.ua/api/merchant/invoice/status?invoiceId=${invoiceId}`,
      {
        headers: {
          'X-Token': MONO_TOKEN
        }
      }
    );

    const verifiedStatus = verifyResponse.data.status;
    const verifiedOrderId = verifyResponse.data.merchantInvoiceId;
    const verifiedAmount = verifyResponse.data.amount / 100;

    if (verifiedStatus === 'success') {
      console.log(`[WEBHOOK] Verified success for Order: ${verifiedOrderId}`);

      // Update order status in Google Sheets
      const sheetPayload = {
        action: 'updateStatus',
        trxId: verifiedOrderId,
        status: 'Оплачено'
      };
      await sendToGoogleSheets(sheetPayload);

      // Send Telegram Notification for successful payment
      const tgMessage = `<b>✅ Замовлення оплачено!</b>\n\n` +
        `<b>🆔 ID:</b> ${verifiedOrderId}\n` +
        `<b>💵 Сума:</b> ${verifiedAmount} ₴\n` +
        `<b>💳 Статус:</b> Успішна оплата через Monobank`;
      await sendTelegramMessage(tgMessage);
    } else {
      console.log(`[WEBHOOK] Invoice status is ${verifiedStatus}. No action taken.`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error.response ? error.response.data : error.message);
    res.status(500).send('Error');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.send('Grace Heritage Backend is healthy.');
});

app.listen(PORT, () => {
  console.log(`Grace Heritage Backend running on port ${PORT}`);
});
