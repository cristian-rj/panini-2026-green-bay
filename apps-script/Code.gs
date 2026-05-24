/**
 * Familia Green Bay - Panini WC 2026 Album Tracker
 * Google Apps Script Backend
 *
 * Setup (one time):
 * 1. Create a new Google Sheet, copy its ID into SHEET_ID below.
 * 2. In this Apps Script project: Project Settings -> Script Properties:
 *      - Add property: ANTHROPIC_API_KEY = sk-ant-...
 *      - (Optional) ALLOWED_EMAILS = "person1@gmail.com,person2@gmail.com" (comma-separated; omit to allow anyone)
 * 3. Deploy -> New deployment -> Type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *      - Copy the /exec URL into the frontend config (app.js -> CONFIG.backendUrl)
 * 4. Open the Sheet once and run setupSheet() from the Apps Script editor to create headers.
 */

const SHEET_ID = 'PASTE_YOUR_SHEET_ID_HERE';
const INVENTORY_SHEET = 'SharedInventory'; // Shared across all family members; old 'Inventory' sheet is preserved as backup.
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'; // More accurate vision than haiku, ~3x cost (~$0.005/scan)
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ---------- HTTP entrypoints ----------

function doGet(e) {
  return handleRequest(e, 'GET');
}

function doPost(e) {
  return handleRequest(e, 'POST');
}

function handleRequest(e, method) {
  try {
    let params = {};
    // Frontend uses POST with text/plain body containing JSON: {action, idToken, ...args}.
    // We also accept GET with ?payload=<JSON> as a fallback for debugging or curl tests.
    if (method === 'POST' && e.postData && e.postData.contents) {
      try { params = JSON.parse(e.postData.contents); } catch (err) { params = {}; }
    } else if (e.parameter && e.parameter.payload) {
      try { params = JSON.parse(e.parameter.payload); } catch (err) { params = {}; }
    } else if (e.parameter) {
      params = e.parameter;
    }

    const action = params.action || (e.parameter && e.parameter.action);
    const idToken = (e.parameter && e.parameter.idToken) || params.idToken;

    if (!action) return jsonResponse({ error: 'Missing action' }, 400);

    const user = verifyUser(idToken);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    switch (action) {
      case 'getInventory':
        return jsonResponse({ ok: true, user: user.email, inventory: getInventory() });
      case 'updateSticker':
        updateSticker(user.email, params.stickerId, !!params.owned, Number(params.count || 1));
        return jsonResponse({ ok: true });
      case 'bulkUpdate':
        bulkUpdate(user.email, params.stickers || []);
        return jsonResponse({ ok: true });
      case 'scan':
        const scanResult = scanPage(params.image, params.stickerCount, params.context || '', params.teamCode || '');
        return jsonResponse({ ok: true, ...scanResult });
      case 'ping':
        return jsonResponse({ ok: true, user: user.email });
      default:
        return jsonResponse({ error: 'Unknown action: ' + action }, 400);
    }
  } catch (err) {
    return jsonResponse({ error: String(err && err.message || err) }, 500);
  }
}

function jsonResponse(obj, status) {
  // Apps Script web apps cannot set arbitrary status codes; status is informational in body.
  if (status && status >= 400) obj.status = status;
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Auth ----------

function verifyUser(idToken) {
  if (!idToken) return null;
  try {
    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return null;
    const info = JSON.parse(resp.getContentText());
    if (!info.email || !info.email_verified) return null;

    const allowed = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS');
    if (allowed) {
      const list = allowed.split(',').map(s => s.trim().toLowerCase());
      if (list.indexOf(info.email.toLowerCase()) === -1) return null;
    }
    return { email: info.email.toLowerCase(), name: info.name || '' };
  } catch (e) {
    return null;
  }
}

// ---------- Sheet helpers ----------

// Shared schema: sticker_id | owned | count | updated_at | updated_by
// One row per sticker (not per user-sticker). Everyone reads/writes the same data.
const HEADERS = ['sticker_id', 'owned', 'count', 'updated_at', 'updated_by'];

function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(INVENTORY_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(INVENTORY_SHEET);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function setupSheet() {
  const sheet = getSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  sheet.setFrozenRows(1);
}

function getInventory() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const inv = {};
  for (let i = 1; i < data.length; i++) {
    const [stickerId, owned, count, updatedAt, updatedBy] = data[i];
    if (!stickerId) continue;
    inv[stickerId] = {
      owned: !!owned,
      count: Number(count || 0),
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      updatedBy: updatedBy || ''
    };
  }
  return inv;
}

function updateSticker(email, stickerId, owned, count) {
  if (!stickerId) throw new Error('stickerId required');
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === stickerId) {
      sheet.getRange(i + 1, 2, 1, 4).setValues([[owned, count, now, email]]);
      return;
    }
  }
  sheet.appendRow([stickerId, owned, count, now, email]);
}

function bulkUpdate(email, stickers) {
  if (!stickers || !stickers.length) return;
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const now = new Date();

  // Build index of existing rows by sticker_id
  const index = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) index[data[i][0]] = i + 1;
  }

  const toAppend = [];
  stickers.forEach(s => {
    if (!s.id) return;
    const owned = !!s.owned;
    const count = Number(s.count != null ? s.count : (owned ? 1 : 0));
    if (index[s.id]) {
      sheet.getRange(index[s.id], 2, 1, 4).setValues([[owned, count, now, email]]);
    } else {
      toAppend.push([s.id, owned, count, now, email]);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
  }
}

// ---------- Claude Vision ----------

function scanPage(imageDataUrl, stickerCount, context, teamCode) {
  if (!imageDataUrl) throw new Error('image required');
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in Script Properties');

  const match = imageDataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) throw new Error('image must be a data URL (data:image/...;base64,...)');
  const mediaType = match[1];
  const base64 = match[2];

  const count = Number(stickerCount) || 20;
  const code = (teamCode || '').toString().toUpperCase().trim();

  // Strategy: In a Panini album, EMPTY slots show their code+number prominently
  // (e.g., "MEX 1", "MEX 4"). FILLED slots are covered by a sticker so the
  // number is hidden. We ask Claude to read the visible numbers on empty slots
  // and infer the rest by grid position.
  const prompt = [
    'Esta es una foto de una página del álbum oficial Panini FIFA World Cup 2026.',
    context ? ('Página: ' + context + '.') : '',
    code ? ('Código del equipo en las estampas: "' + code + '" (los espacios vacíos muestran "' + code + ' N" donde N es el número).') : '',
    'La página tiene exactamente ' + count + ' espacios numerados del 1 al ' + count + '.',
    '',
    'CÓMO IDENTIFICAR ESPACIOS:',
    '- VACÍO: muestra claramente el número en grande (ej: "' + (code || 'MEX') + ' 4", "' + (code || 'MEX') + ' 11") sobre un fondo rosado o verde, SIN foto de jugador.',
    '- LLENO: cubierto con una estampa pegada — se ve la foto a color de un jugador, escudo, foto de equipo, o diseño gráfico. El número está oculto debajo.',
    '',
    'PROCEDIMIENTO:',
    '1. Identifica TODOS los espacios visibles en la foto (vacíos y llenos).',
    '2. Lee los números visibles en los espacios VACÍOS (siempre son legibles).',
    '3. Para los espacios LLENOS, infiere su número por la posición en la cuadrícula respecto a los espacios vacíos cercanos (los números van en orden de izquierda a derecha y arriba a abajo).',
    '4. Si no puedes determinar el número de un espacio lleno con confianza, ponlo en "uncertain" en vez de "filled".',
    '',
    'IMPORTANTE: Una estampa con foto pegada NUNCA está vacía. Una estampa especial (con brillo, foto de equipo, "We Are Mexico", etc.) cuenta como pegada.',
    '',
    'Responde ÚNICAMENTE con JSON válido, sin texto antes ni después:',
    '{"empty": [números visibles vacíos], "filled": [números deducidos como llenos], "uncertain": [números que no pudiste determinar], "notes": "qué viste (1 frase)"}'
  ].filter(Boolean).join('\n');

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const resp = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = resp.getResponseCode();
  const body = resp.getContentText();
  if (status !== 200) {
    throw new Error('Claude API error ' + status + ': ' + body);
  }

  const data = JSON.parse(body);
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  // Extract first {...} block to be robust against extra text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { filled: [], empty: [], notes: 'Could not parse model output', raw: text };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { filled: [], empty: [], notes: 'Invalid JSON from model', raw: text };
  }
  const clean = arr => Array.isArray(arr) ? arr.map(Number).filter(n => n >= 1 && n <= count) : [];
  return {
    filled: clean(parsed.filled),
    empty: clean(parsed.empty),
    uncertain: clean(parsed.uncertain),
    notes: parsed.notes || ''
  };
}
