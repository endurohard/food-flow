import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_DIR = process.env.WHATSAPP_SESSION_DIR
  || path.join(__dirname, '../data/session');
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
// TEST MODE is the default — set WHATSAPP_TEST_MODE=false explicitly to go live
const TEST_MODE = process.env.WHATSAPP_TEST_MODE !== 'false';
const SOCKS_PROXY = process.env.WHATSAPP_SOCKS_PROXY || '';

const SUPPORTED_EXTENSIONS = [
  // images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  // video / audio
  '.mp4', '.3gp', '.avi', '.mov', '.mkv', '.webm',
  '.mp3', '.wav', '.ogg', '.opus', '.aac', '.m4a',
  // documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.rtf', '.odt', '.ods', '.odp',
  // archives
  '.zip', '.rar', '.7z', '.tar', '.gz',
];
const WHATSAPP_FILE_LIMIT_MB = 100;

class WhatsAppManager {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isReady = false;
    this.qrDataUrl = null;       // base64 QR png (canvas dataURL)
    this.statusMsg = 'not_started';
    this.lastError = null;
    this._initPromise = null;
    this._sendLock = Promise.resolve(); // serialize send operations

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    if (TEST_MODE) {
      this.isReady = true;
      this.statusMsg = 'test_mode';
      console.log('[WA] TEST MODE — messages will NOT be sent');
    }
  }

  getStatus() {
    return {
      ready: this.isReady,
      status: this.statusMsg,
      test_mode: TEST_MODE,
      has_qr: !!this.qrDataUrl,
      last_error: this.lastError,
    };
  }

  getQR() { return this.qrDataUrl; }

  // Serialize concurrent send operations — a single WhatsApp Web page
  // cannot service two chats at once.
  _withLock(fn) {
    const run = this._sendLock.then(fn, fn);
    this._sendLock = run.catch(() => {});
    return run;
  }

  // ── Cleanup stale Chrome processes / profile locks ──
  async _cleanup() {
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    const hasLock = locks.some(f => fs.existsSync(path.join(SESSION_DIR, f)));
    if (!hasLock) return;
    console.log('[WA] Cleaning stale Chrome locks…');
    try { await execAsync('pkill -9 chrome 2>/dev/null; pkill -9 chromium 2>/dev/null'); } catch { /* ok */ }
    await new Promise(r => setTimeout(r, 1500));
    for (const f of locks) {
      try { fs.unlinkSync(path.join(SESSION_DIR, f)); } catch { /* ok */ }
    }
  }

  async initialize() {
    if (TEST_MODE || this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    this.statusMsg = 'initializing';
    try {
      await this._cleanup();
      const args = [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`,
      ];
      if (SOCKS_PROXY) args.push(`--proxy-server=${SOCKS_PROXY}`);

      this.browser = await puppeteer.launch({
        executablePath: CHROMIUM_PATH,
        headless: true,
        userDataDir: SESSION_DIR,
        protocolTimeout: 300_000,
        args,
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 720 });

      console.log('[WA] Opening WhatsApp Web…');
      this.statusMsg = 'loading';

      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      });

      this._pollAuth();
    } catch (err) {
      this.statusMsg = 'error';
      this.lastError = err.message;
      this._initPromise = null;
      console.error('[WA] Init error:', err.message);
    }
  }

  // Poll until authenticated or QR appears
  _pollAuth() {
    let attempts = 0;
    const MAX = 120; // 10 min
    const iv = setInterval(async () => {
      attempts++;
      try {
        const state = await this.page.evaluate(() => {
          const hasChats = !!document.querySelector('[data-testid="chat-list"]');
          const hasSide  = !!document.querySelector('#side');
          const hasUser  = !!document.querySelector('[data-testid="default-user"]');
          const noLanding = !document.querySelector('.landing-main');
          const hasQRCanvas = !!document.querySelector('canvas');
          return { hasChats, hasSide, hasUser, noLanding, hasQRCanvas };
        });

        const authScore = [state.hasChats, state.hasSide, state.hasUser, state.noLanding]
          .filter(Boolean).length;

        if (authScore >= 2) {
          clearInterval(iv);
          this.isReady = true;
          this.qrDataUrl = null;
          this.statusMsg = 'ready';
          console.log('[WA] Ready!');
          return;
        }

        // QR code visible — capture it
        if (state.hasQRCanvas) {
          this.statusMsg = 'waiting_qr_scan';
          try {
            const dataUrl = await this.page.evaluate(() => {
              const c = document.querySelector('canvas');
              return c ? c.toDataURL('image/png') : null;
            });
            if (dataUrl) this.qrDataUrl = dataUrl;
          } catch { /* ok */ }
        }

        if (attempts >= MAX) {
          clearInterval(iv);
          this.statusMsg = 'timeout';
          this.lastError = 'Auth timeout (10 min)';
          console.error('[WA] Auth timeout');
        }
      } catch (e) {
        console.warn('[WA] Poll error:', e.message);
      }
    }, 5_000);
  }

  // ── Phone normalization (8XXXXXXXXXX → 7XXXXXXXXXX) ──
  _normalizePhone(raw) {
    let d = String(raw).replace(/[^0-9]/g, '');
    if (d.startsWith('8')) d = '7' + d.slice(1);
    if (!d.startsWith('7')) d = '7' + d;
    return d;
  }

  // ── File validation (ported from pack/whatsappManager.js) ──
  validateFilePath(filePath, options = {}) {
    const { checkFileType = true } = options;
    const absolutePath = path.resolve(filePath);
    const extension = path.extname(absolutePath).toLowerCase();

    if (!fs.existsSync(absolutePath)) {
      return { valid: false, absolutePath, extension, error: `File does not exist: ${absolutePath}` };
    }

    const stats = fs.statSync(absolutePath);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > WHATSAPP_FILE_LIMIT_MB) {
      return {
        valid: false, absolutePath, size: stats.size, extension,
        error: `File too large: ${sizeMB.toFixed(2)}MB (WhatsApp limit: ${WHATSAPP_FILE_LIMIT_MB}MB)`,
      };
    }

    if (checkFileType && !SUPPORTED_EXTENSIONS.includes(extension)) {
      return {
        valid: false, absolutePath, size: stats.size, extension,
        error: `Unsupported file type: ${extension || '(none)'}`,
      };
    }

    return { valid: true, absolutePath, size: stats.size, extension };
  }

  // ── Open chat by phone ──
  async _openChat(phone) {
    const url = `https://web.whatsapp.com/send?phone=${phone}`;
    const curUrl = this.page.url();
    if (!curUrl.includes('web.whatsapp.com')) {
      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
    } else {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {}),
        this.page.evaluate(u => { window.location.href = u; }, url),
      ]);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Invalid phone number modal?
    const invalidPhone = await this.page.evaluate(() => {
      const text = document.body.textContent || '';
      return (text.includes('Номер телефона') && text.includes('недействителен'))
        || (text.includes('phone number') && text.includes('invalid'));
    }).catch(() => false);
    if (invalidPhone) throw new Error(`Invalid phone number: ${phone}`);

    // Wait for message input
    await this.page.waitForSelector(
      '[data-testid="conversation-compose-box-input"], [contenteditable="true"][data-tab="10"], footer [contenteditable="true"]',
      { timeout: 30_000 }
    );
    await new Promise(r => setTimeout(r, 1000));
  }

  // ── Send text message ──
  async sendMessage(phone, message) {
    if (TEST_MODE) {
      const clean = this._normalizePhone(phone);
      console.log(`[WA][TEST] → ${clean}: ${String(message).slice(0, 80)}`);
      return { success: true, test_mode: true, phone: clean };
    }
    if (!this.isReady || !this.page) throw new Error('WhatsApp not ready');

    return this._withLock(async () => {
      const clean = this._normalizePhone(phone);
      console.log(`[WA] Sending to ${clean}…`);

      await this._openChat(clean);

      const input = await this.page.$(
        '[data-testid="conversation-compose-box-input"], [contenteditable="true"][data-tab="10"], footer [contenteditable="true"]'
      );
      await input.click();

      // Split message by newlines for proper Enter handling
      for (const line of String(message).split('\n')) {
        await this.page.keyboard.type(line);
        await this.page.keyboard.down('Shift');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Shift');
      }

      // Remove last extra newline, then send
      await this.page.keyboard.press('Backspace');
      await this.page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1500));

      console.log(`[WA] Sent to ${clean}`);
      return { success: true, phone: clean };
    });
  }

  // ════════════════════════════════════════════════════════════════
  // File attachment (ported from pack/whatsappManager.js, simplified)
  // ════════════════════════════════════════════════════════════════

  // Find the attach / clip / plus button (WhatsApp changes selectors often)
  async _findAttachButton() {
    const selectors = [
      '[data-testid="clip"]',
      '[data-icon="clip"]',
      'span[data-icon="plus"]',
      'span[data-icon="plus-rounded"]',
      'button[aria-label*="Attach"]',
      '[aria-label*="Прикрепить"]',
      'button[title*="Attach"]',
    ];
    for (const sel of selectors) {
      const el = await this.page.$(sel);
      if (el) return el;
    }
    // Fallback: any footer button that looks like attach/plus
    const buttons = await this.page.$$('footer button, footer span[role="button"], footer div[role="button"]');
    for (const btn of buttons) {
      const info = await this.page.evaluate(el => ({
        html: el.innerHTML || '',
        aria: (el.getAttribute('aria-label') || '').toLowerCase(),
      }), btn);
      if (info.html.includes('clip') || info.html.includes('plus')
        || info.aria.includes('attach') || info.aria.includes('прикреп')) {
        return btn;
      }
    }
    return null;
  }

  // Click the "Document" item in the attach menu (best effort)
  async _clickDocumentMenuItem() {
    return this.page.evaluate(() => {
      // 1. By data-icon="document"
      const icon = document.querySelector('span[data-icon="document"], span[data-icon="document-filled"]');
      if (icon) {
        const item = icon.closest('li, button, div[role="button"]');
        if (item) { item.click(); return true; }
      }
      // 2. By visible text
      const texts = ['Документ', 'Document'];
      const els = Array.from(document.querySelectorAll('span, div, li, button'));
      for (const t of texts) {
        const el = els.find(e => (e.textContent || '').trim().toLowerCase() === t.toLowerCase());
        if (el) {
          const item = el.closest('li, button, div[role="button"]') || el;
          item.click();
          return true;
        }
      }
      // 3. First menu item (Document is usually first)
      const first = document.querySelector('li[role="button"]');
      if (first) { first.click(); return true; }
      return false;
    });
  }

  // Locate a file input suitable for documents
  async _findFileInput() {
    const selectors = [
      'input[type="file"][accept="*"]',
      'input[type="file"]:not([accept*="image"]):not([accept*="video"])',
      'input[type="file"]',
    ];
    for (const sel of selectors) {
      const inputs = await this.page.$$(sel);
      if (inputs.length > 0) return inputs[0];
    }
    return null;
  }

  // Verify WhatsApp accepted the file: preview / caption input / send icon appears
  async _verifyFileAccepted(timeout = 8000) {
    try {
      await this.page.waitForFunction(() => {
        const docPreview = document.querySelector('[data-testid="document-thumb"], [data-icon="document"], [data-icon="preview-document"]');
        const mediaViewer = document.querySelector('[data-testid="media-viewer"], [role="dialog"] [data-icon="send"]');
        const captionInput = document.querySelector('[data-testid="media-caption-input"], [contenteditable="true"][data-tab="10"]');
        const sendIcon = document.querySelector('[data-icon="send"], [data-icon="wds-ic-send-filled"]');
        const fileName = Array.from(document.querySelectorAll('span, div')).some(el => {
          const t = (el.textContent || '').toLowerCase();
          return t.endsWith('.pdf') || t.endsWith('.doc') || t.endsWith('.docx')
            || t.endsWith('.xls') || t.endsWith('.xlsx') || t.endsWith('.zip');
        });
        return !!(docPreview || mediaViewer || (captionInput && sendIcon) || (fileName && sendIcon));
      }, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  // Multi-fallback upload:
  //   1) elementHandle.uploadFile() on input[type="file"]
  //   2) page.waitForFileChooser() + click document menu item / attach button
  //   3) DataTransfer API injection (base64 → File in browser context)
  async _uploadFileWithFallback(absolutePath, { attachButton = null, verifyTimeout = 8000, chooserTimeout = 10_000 } = {}) {
    // Method 1: direct uploadFile on the input
    const input = await this._findFileInput();
    if (input) {
      try {
        console.log('[WA][file] Method 1: input.uploadFile()…');
        await input.uploadFile(absolutePath);
        await new Promise(r => setTimeout(r, 1000));
        if (await this._verifyFileAccepted(verifyTimeout)) {
          return { success: true, method: 'uploadFile' };
        }
        console.warn('[WA][file] uploadFile not accepted, trying fallback…');
      } catch (e) {
        console.warn(`[WA][file] uploadFile error: ${e.message}, trying fallback…`);
      }
    } else {
      console.warn('[WA][file] No input[type=file] found, trying fileChooser…');
    }

    // Method 2: intercept native file chooser
    if (attachButton) {
      try {
        console.log('[WA][file] Method 2: waitForFileChooser()…');
        const [chooser] = await Promise.all([
          this.page.waitForFileChooser({ timeout: chooserTimeout }),
          // Re-open menu and click Document (the click opens the chooser)
          (async () => {
            await attachButton.click().catch(() => {});
            await new Promise(r => setTimeout(r, 1200));
            await this._clickDocumentMenuItem();
          })(),
        ]);
        await chooser.accept([absolutePath]);
        await new Promise(r => setTimeout(r, 1000));
        if (await this._verifyFileAccepted(verifyTimeout)) {
          return { success: true, method: 'fileChooser' };
        }
        console.warn('[WA][file] fileChooser upload not confirmed, trying DataTransfer…');
      } catch (e) {
        console.warn(`[WA][file] fileChooser error: ${e.message}, trying DataTransfer…`);
      }
    }

    // Method 3: DataTransfer API (inject file content into the input)
    const input3 = await this._findFileInput();
    if (input3) {
      try {
        console.log('[WA][file] Method 3: DataTransfer injection…');
        const base64 = fs.readFileSync(absolutePath).toString('base64');
        const fileName = path.basename(absolutePath);
        const ext = path.extname(absolutePath).toLowerCase();
        const mime = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
        await input3.evaluate((el, b64, name, type) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const file = new File([bytes], name, { type });
          const dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, base64, fileName, mime);
        await new Promise(r => setTimeout(r, 1000));
        if (await this._verifyFileAccepted(verifyTimeout)) {
          return { success: true, method: 'dataTransfer' };
        }
      } catch (e) {
        console.warn(`[WA][file] DataTransfer error: ${e.message}`);
      }
    }

    return { success: false, method: 'all', error: 'All upload methods failed (uploadFile, fileChooser, dataTransfer)' };
  }

  // Retry wrapper — retries only on timeout-ish failures
  async _uploadFileWithRetry(absolutePath, options = {}) {
    const { maxRetries = 2, retryDelay = 2000, ...rest } = options;
    let last = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      console.log(`[WA][file] Upload attempt ${attempt}/${maxRetries + 1}`);
      last = await this._uploadFileWithFallback(absolutePath, rest);
      if (last.success) return { ...last, attempts: attempt };
      const isTimeout = (last.error || '').toLowerCase().includes('timeout');
      if (!isTimeout) return { ...last, attempts: attempt };
      if (attempt <= maxRetries) await new Promise(r => setTimeout(r, retryDelay));
    }
    return { ...last, attempts: maxRetries + 1 };
  }

  // Click the send button in the file preview dialog (or press Enter)
  async _sendFilePreview() {
    // Primary: click send icon button
    const clicked = await this.page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll('span[data-icon="send"], span[data-icon="wds-ic-send-filled"], [data-testid="send"]'));
      // Prefer icons in the right part of the screen (preview dialog)
      const sorted = icons.sort((a, b) =>
        b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      for (const icon of sorted) {
        const rect = icon.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const btn = icon.closest('button, div[role="button"], span[role="button"]') || icon;
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.warn('[WA][file] Send button not found, pressing Enter…');
      await this.page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 1500));
      // Last resort: Ctrl+Enter
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('Enter');
      await this.page.keyboard.up('Control');
    }
    await new Promise(r => setTimeout(r, 4000));
  }

  // ── Send message with an attached file (e.g. PDF invoice) ──
  async sendMessageWithFile(phone, message, filePath) {
    const validation = this.validateFilePath(filePath);
    if (!validation.valid) throw new Error(validation.error);
    const absolutePath = validation.absolutePath;

    if (TEST_MODE) {
      const clean = this._normalizePhone(phone);
      console.log(`[WA][TEST] → ${clean}: file=${path.basename(absolutePath)} (${validation.size} bytes), caption=${String(message || '').slice(0, 60)}`);
      return { success: true, test_mode: true, phone: clean, file: path.basename(absolutePath) };
    }
    if (!this.isReady || !this.page) throw new Error('WhatsApp not ready');

    return this._withLock(async () => {
      const clean = this._normalizePhone(phone);
      console.log(`[WA] Sending file to ${clean}: ${path.basename(absolutePath)}…`);

      await this._openChat(clean);

      // Open the attach menu
      const attachButton = await this._findAttachButton();
      if (!attachButton) throw new Error('Attach button not found');

      await attachButton.click();
      await new Promise(r => setTimeout(r, 1500));

      // Menu really opened?
      const menuOpened = await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('li[role="button"], [role="menu"] [role="button"]'));
        return items.some(i => {
          const s = window.getComputedStyle(i);
          return s.display !== 'none' && s.visibility !== 'hidden';
        });
      });
      if (!menuOpened) {
        await attachButton.click().catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      }

      // Reveal the Document input (clicking the menu item mounts the input)
      await this._clickDocumentMenuItem();
      await new Promise(r => setTimeout(r, 800));

      // Upload with fallbacks
      const upload = await this._uploadFileWithRetry(absolutePath, { attachButton });
      if (!upload.success) throw new Error(upload.error || 'File upload failed');
      console.log(`[WA][file] Uploaded via ${upload.method} (attempt ${upload.attempts})`);

      // Wait for the preview to settle / upload to finish
      await new Promise(r => setTimeout(r, 2000));

      // Add caption if provided
      if (message) {
        const captionSelectors = [
          '[data-testid="media-caption-input"]',
          'div[contenteditable="true"][data-tab="10"]',
          'div[contenteditable="true"][data-lexical-editor="true"]',
        ];
        let captionBox = null;
        for (const sel of captionSelectors) {
          captionBox = await this.page.$(sel);
          if (captionBox) break;
        }
        if (captionBox) {
          await captionBox.click();
          for (const line of String(message).split('\n')) {
            await this.page.keyboard.type(line);
            await this.page.keyboard.down('Shift');
            await this.page.keyboard.press('Enter');
            await this.page.keyboard.up('Shift');
          }
          await this.page.keyboard.press('Backspace');
          await new Promise(r => setTimeout(r, 500));
        } else {
          console.warn('[WA][file] Caption input not found, sending without caption');
        }
      }

      // Send
      await this._sendFilePreview();

      console.log(`[WA] File sent to ${clean}`);
      return { success: true, phone: clean, file: path.basename(absolutePath), method: upload.method };
    });
  }

  async restart() {
    if (TEST_MODE) {
      console.log('[WA][TEST] restart (noop)');
      return;
    }
    this.isReady = false;
    this.statusMsg = 'restarting';
    this.qrDataUrl = null;
    this._initPromise = null;
    try {
      if (this.browser) await this.browser.close();
    } catch { /* ok */ }
    this.browser = null;
    this.page = null;
    await this.initialize();
  }
}

const manager = new WhatsAppManager();
export default manager;
