import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import wa from './whatsapp.js';
import { authenticate } from './auth.js';

const PORT = Number(process.env.PORT || 3014);
const UPLOAD_DIR = path.join(os.tmpdir(), 'whatsapp-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '30mb' })); // fileBase64 payloads

// ── Multer: keep original extension (WhatsApp validates by extension) ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

function cleanupFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[cleanup] Failed to remove ${filePath}: ${err.message}`);
    }
  });
}

// Sanitize a client-supplied file name into a safe basename
function safeFileName(name, fallbackExt = '.pdf') {
  const base = path.basename(String(name || 'file' + fallbackExt));
  const ext = path.extname(base).toLowerCase() || fallbackExt;
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

// ── Health (unauthenticated) ──
app.get('/health', (_req, res) => res.json({ ok: true, service: 'whatsapp-service' }));

// All /api/whatsapp/* require internal token or admin JWT
app.use('/api/whatsapp', authenticate);

// ── Status ──
app.get('/api/whatsapp/status', (_req, res) => res.json(wa.getStatus()));

// ── QR code (canvas dataURL) ──
app.get('/api/whatsapp/qr', async (_req, res) => {
  const status = wa.getStatus();
  if (status.ready) return res.json({ status: 'ready', qr: null });
  const raw = wa.getQR();
  if (!raw) return res.json({ status: status.status, qr: null });
  return res.json({ status: status.status, qr: raw });
});

// ── Send text message ──
app.post('/api/whatsapp/send', async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }
  try {
    const result = await wa.sendMessage(phone, message);
    return res.json({ ok: true, testMode: !!result.test_mode, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Send file (PDF invoice etc.) ──
// Variant A: multipart/form-data — fields: phone, message (optional), file
// Variant B: application/json — { phone, message?, fileBase64, fileName }
app.post('/api/whatsapp/send-file', (req, res) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      return res.status(400).json({ error: `upload error: ${multerErr.message}` });
    }

    let tmpPath = null;
    try {
      const { phone, message } = req.body || {};
      if (!phone) {
        if (req.file) cleanupFile(req.file.path);
        return res.status(400).json({ error: 'phone required' });
      }

      if (req.file) {
        // Variant A: multipart upload
        tmpPath = req.file.path;
      } else if (req.body?.fileBase64) {
        // Variant B: JSON with base64 content
        const { fileBase64, fileName } = req.body;
        let buffer;
        try {
          buffer = Buffer.from(fileBase64, 'base64');
        } catch {
          return res.status(400).json({ error: 'invalid fileBase64' });
        }
        if (!buffer || buffer.length === 0) {
          return res.status(400).json({ error: 'invalid fileBase64' });
        }
        tmpPath = path.join(UPLOAD_DIR, safeFileName(fileName));
        fs.writeFileSync(tmpPath, buffer);
      } else {
        return res.status(400).json({
          error: 'file required (multipart field "file" or JSON fileBase64+fileName)',
        });
      }

      const result = await wa.sendMessageWithFile(phone, message || '', tmpPath);
      return res.json({ ok: true, testMode: !!result.test_mode, ...result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    } finally {
      cleanupFile(tmpPath);
    }
  });
});

// ── Broadcast (sequential, delay between messages) ──
// Body: { recipients: [{phone, name}], message } — {name} template supported
let _broadcastRunning = false;

app.post('/api/whatsapp/broadcast', async (req, res) => {
  if (_broadcastRunning) {
    return res.status(409).json({ error: 'broadcast_running', message: 'Broadcast already in progress' });
  }
  const { recipients, message } = req.body || {};
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients array required' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }

  _broadcastRunning = true;
  const total = recipients.length;
  let sent = 0;
  const failed = [];
  const DELAY = Number(process.env.BROADCAST_DELAY_MS || 2500);

  console.log(`[WA][broadcast] Starting: ${total} recipients`);

  try {
    for (const { phone, name } of recipients) {
      const text = message.replace(/\{name\}/g, name || '');
      try {
        await wa.sendMessage(phone, text);
        sent++;
        console.log(`[WA][broadcast] ${sent}/${total} → ${phone}`);
      } catch (err) {
        console.error(`[WA][broadcast] FAIL → ${phone}: ${err.message}`);
        failed.push({ phone, error: err.message });
      }
      if (sent + failed.length < total) {
        await new Promise(r => setTimeout(r, DELAY));
      }
    }
  } finally {
    _broadcastRunning = false;
  }

  console.log(`[WA][broadcast] Done: sent=${sent} failed=${failed.length}`);
  return res.json({ ok: true, total, sent, failed_count: failed.length, failed });
});

// ── Restart browser / session ──
app.post('/api/whatsapp/restart', async (_req, res) => {
  try {
    await wa.restart();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[whatsapp-service] listening on :${PORT}`);
  // Auto-initialize (non-blocking; noop in TEST_MODE)
  wa.initialize()?.catch?.(err => console.error('[WA] init error:', err.message));
});
