/* Familia Green Bay - app.js */
(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    album: null,          // album-structure.json
    inventory: {},        // { stickerId: { owned, count, updatedAt, updatedBy } }
    user: null,           // { email, name, picture, idToken }
    currentDetail: null,  // { type: 'team'|'special', node }
    pending: 0,           // number of in-flight save operations
    lastError: null,      // last sync error message
    failedOps: [],        // operations to retry on demand
    // Dirty buffer for the currently open modal. Keys are sticker IDs, values
    // are { owned, count }. Cleared on save or discard.
    dirty: new Map(),
    // Snapshot of inventory state before the user started editing, used to
    // restore on Discard. Captured when the modal opens.
    snapshot: null
  };

  const $ = (id) => document.getElementById(id);

  // ---------- Sticker ID helpers ----------
  function teamStickerId(teamId, n) { return 'T:' + teamId + ':' + n; }
  function sectionStickerId(sectionId, n) { return 'S:' + sectionId + ':' + n; }

  function getSticker(id) {
    return state.inventory[id] || { owned: false, count: 0 };
  }

  function setSticker(id, owned, count) {
    if (owned) {
      state.inventory[id] = { owned: true, count: Math.max(1, count || 1) };
    } else {
      state.inventory[id] = { owned: false, count: 0 };
    }
  }

  // ---------- Backend ----------
  // We use POST with text/plain body. This is a "simple" CORS request (no preflight).
  // Apps Script returns 302 to a googleusercontent.com URL with a user_content_key
  // that caches the POST body. fetch automatically follows 302 by converting POST→GET
  // (per WHATWG fetch spec) and the final response has Access-Control-Allow-Origin: *.
  // This supports large bodies (~30KB+ for image scans) that wouldn't fit in a GET URL.
  async function callBackend(action, payload) {
    if (!window.CONFIG || !window.CONFIG.backendUrl || window.CONFIG.backendUrl.indexOf('PASTE_') === 0) {
      throw new Error('Backend no configurado. Edita config.js con tu URL de Apps Script.');
    }
    if (!state.user || !state.user.idToken) {
      throw new Error('No has iniciado sesión.');
    }
    const body = JSON.stringify(Object.assign({ action, idToken: state.user.idToken }, payload || {}));
    console.log('Request:', action, '(body ' + body.length + ' bytes)');
    let resp;
    try {
      resp = await fetch(window.CONFIG.backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow'
      });
    } catch (netErr) {
      throw new Error('Fallo de red (' + body.length + ' bytes): ' + netErr.message);
    }
    if (!resp.ok) throw new Error('Backend HTTP ' + resp.status);
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('Respuesta no es JSON: ' + text.slice(0, 200)); }
    if (data.error) throw new Error(data.error);
    return data;
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------- Sync status ----------
  function renderSyncStatus() {
    const el = $('syncStatus');
    if (!el) return;
    el.classList.remove('saving', 'error');
    const textEl = el.querySelector('.sync-text');
    if (state.pending > 0) {
      el.classList.add('saving');
      textEl.textContent = 'Guardando…';
      el.title = state.pending + ' cambio(s) en curso';
    } else if (state.failedOps.length > 0) {
      el.classList.add('error');
      textEl.textContent = 'Reintentar (' + state.failedOps.length + ')';
      el.title = (state.lastError || 'Error al guardar') + '. Click para reintentar.';
    } else {
      textEl.textContent = '✓ Guardado';
      el.title = 'Todo sincronizado con Google Sheets';
    }
  }

  // Wraps a backend save call with pending counter + error queueing.
  // If the call fails, the op is added to failedOps for the user to retry.
  async function trackedSave(action, payload, retryOp) {
    state.pending++;
    renderSyncStatus();
    try {
      await callBackend(action, payload);
      // Success — if this was a retry, remove it from the queue
      if (retryOp) {
        const idx = state.failedOps.indexOf(retryOp);
        if (idx >= 0) state.failedOps.splice(idx, 1);
      }
      state.lastError = null;
    } catch (e) {
      state.lastError = e.message;
      if (!retryOp) {
        state.failedOps.push({ action, payload });
      }
      console.error('Save failed:', action, e);
    } finally {
      state.pending--;
      renderSyncStatus();
    }
  }

  async function retryFailed() {
    if (!state.failedOps.length) return;
    const ops = state.failedOps.slice();
    state.failedOps = [];
    renderSyncStatus();
    for (const op of ops) {
      await trackedSave(op.action, op.payload, op);
    }
    if (state.failedOps.length === 0) {
      toast('✓ Cambios guardados', 'success');
    }
  }

  // ---------- Dirty buffer (manual save) ----------
  // Records a pending change (no backend call). Updates inventory locally and
  // refreshes the Save button. Use this anywhere a change should be queued.
  function markDirty(id, owned, count) {
    state.dirty.set(id, { owned: !!owned, count: Number(count || 0) });
    state.inventory[id] = {
      owned: !!owned,
      count: Number(count || 0),
      updatedAt: new Date().toISOString(),
      updatedBy: (state.user && state.user.email) || '' // optimistic
    };
    renderSaveButton();
  }

  function renderSaveButton() {
    const saveBtn = $('saveChangesBtn');
    const discardBtn = $('discardChangesBtn');
    if (!saveBtn || !discardBtn) return;
    const n = state.dirty.size;
    if (n === 0) {
      saveBtn.disabled = true;
      saveBtn.textContent = '💾 Sin cambios';
      discardBtn.hidden = true;
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Guardar ' + n + (n === 1 ? ' cambio' : ' cambios');
      discardBtn.hidden = false;
    }
  }

  async function saveChanges() {
    if (state.dirty.size === 0) return;
    const stickers = [];
    state.dirty.forEach((v, id) => stickers.push({ id, owned: v.owned, count: v.count }));
    await trackedSave('bulkUpdate', { stickers });
    if (state.failedOps.length === 0) {
      const n = stickers.length;
      state.dirty.clear();
      state.snapshot = snapshotInventory();
      renderSaveButton();
      toast('✓ Guardados ' + n + (n === 1 ? ' cambio' : ' cambios'), 'success');
    } else {
      toast('Error guardando. Pulsa "Reintentar" arriba.', 'error');
    }
  }

  function discardChanges() {
    if (state.dirty.size === 0) return;
    if (!confirm('¿Descartar ' + state.dirty.size + ' cambio(s) sin guardar?')) return;
    // Restore inventory from snapshot
    if (state.snapshot) {
      state.dirty.forEach((_, id) => {
        if (state.snapshot[id] === undefined) {
          delete state.inventory[id];
        } else {
          state.inventory[id] = state.snapshot[id];
        }
      });
    }
    state.dirty.clear();
    renderSaveButton();
    if (state.currentDetail) renderStickerGrid();
    recomputeStats();
  }

  function snapshotInventory() {
    // Shallow copy is enough because individual sticker entries are replaced on update.
    const snap = {};
    Object.keys(state.inventory).forEach(k => { snap[k] = state.inventory[k]; });
    return snap;
  }

  // ---------- Stats ----------
  function recomputeStats() {
    let total = 0, owned = 0, dup = 0;
    state.album.specialSections.forEach(s => { total += s.stickerCount; });
    state.album.groups.forEach(g => g.teams.forEach(t => { total += t.stickerCount; }));
    Object.values(state.inventory).forEach(v => {
      if (v.owned) {
        owned += 1;
        if (v.count > 1) dup += (v.count - 1);
      }
    });
    const missing = total - owned;
    const pct = total ? Math.round((owned / total) * 100) : 0;
    $('ownedCount').textContent = owned;
    $('missingCount').textContent = missing;
    $('dupCount').textContent = dup;
    $('progressPct').textContent = pct + '%';
    $('progressFill').style.width = pct + '%';
  }

  function nodeProgress(node) {
    let owned = 0;
    for (let i = 1; i <= node.stickerCount; i++) {
      const id = node._idFor(i);
      if (state.inventory[id] && state.inventory[id].owned) owned++;
    }
    return { owned, total: node.stickerCount, pct: node.stickerCount ? owned / node.stickerCount : 0 };
  }

  // ---------- Render: Groups view ----------
  function renderGroups() {
    const root = $('groupsView');
    root.innerHTML = '';
    state.album.groups.forEach(group => {
      const groupEl = document.createElement('section');
      groupEl.className = 'group';

      let groupOwned = 0, groupTotal = 0;
      group.teams.forEach(t => {
        groupTotal += t.stickerCount;
        for (let i = 1; i <= t.stickerCount; i++) {
          if (state.inventory[teamStickerId(t.id, i)] && state.inventory[teamStickerId(t.id, i)].owned) groupOwned++;
        }
      });

      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = '<div class="group-title">' + escapeHtml(group.name) + '</div>' +
        '<div class="group-progress">' + groupOwned + ' / ' + groupTotal + '</div>';
      groupEl.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'team-grid';
      group.teams.forEach(team => grid.appendChild(buildTeamCard(team)));
      groupEl.appendChild(grid);
      root.appendChild(groupEl);
    });
  }

  function buildTeamCard(team) {
    team._idFor = (n) => teamStickerId(team.id, n);
    const { owned, total, pct } = nodeProgress(team);
    const card = document.createElement('button');
    card.className = 'team-card' + (owned === total ? ' complete' : '');
    card.innerHTML =
      '<div class="team-card-top">' +
        '<span>' + (team.flag || '🏳️') + '</span>' +
        '<span class="team-card-name">' + escapeHtml(team.name) + '</span>' +
      '</div>' +
      '<div class="team-card-progress">' +
        '<div class="mini-progress"><div class="mini-progress-fill" style="width:' + (pct * 100) + '%"></div></div>' +
        '<span>' + owned + '/' + total + '</span>' +
      '</div>';
    card.addEventListener('click', () => openDetail({
      title: (team.flag || '') + ' ' + team.name,
      stickerCount: team.stickerCount,
      idFor: team._idFor,
      contextLabel: 'Equipo: ' + team.name,
      teamCode: team.id
    }));
    return card;
  }

  // ---------- Render: Special sections ----------
  function renderSpecial() {
    const root = $('specialView');
    root.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'team-grid';
    state.album.specialSections.forEach(sec => {
      sec._idFor = (n) => sectionStickerId(sec.id, n);
      const { owned, total, pct } = nodeProgress(sec);
      const card = document.createElement('button');
      card.className = 'team-card' + (owned === total ? ' complete' : '');
      card.innerHTML =
        '<div class="team-card-top">' +
          '<span>' + (sec.icon || '⭐') + '</span>' +
          '<span class="team-card-name">' + escapeHtml(sec.name) + '</span>' +
        '</div>' +
        '<div class="team-card-progress">' +
          '<div class="mini-progress"><div class="mini-progress-fill" style="width:' + (pct * 100) + '%"></div></div>' +
          '<span>' + owned + '/' + total + '</span>' +
        '</div>';
      card.addEventListener('click', () => openDetail({
        title: (sec.icon || '') + ' ' + sec.name,
        stickerCount: sec.stickerCount,
        idFor: sec._idFor,
        contextLabel: 'Sección: ' + sec.name
      }));
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  // ---------- Render: Missing view ----------
  function renderMissing() {
    const root = $('missingView');
    root.innerHTML = '';

    const sections = [];
    state.album.groups.forEach(g => g.teams.forEach(team => {
      const missing = [];
      for (let i = 1; i <= team.stickerCount; i++) {
        if (!state.inventory[teamStickerId(team.id, i)] || !state.inventory[teamStickerId(team.id, i)].owned) {
          missing.push(i);
        }
      }
      if (missing.length) sections.push({ icon: team.flag || '🏳️', name: g.name + ' · ' + team.name, missing });
    }));
    state.album.specialSections.forEach(sec => {
      const missing = [];
      for (let i = 1; i <= sec.stickerCount; i++) {
        if (!state.inventory[sectionStickerId(sec.id, i)] || !state.inventory[sectionStickerId(sec.id, i)].owned) {
          missing.push(i);
        }
      }
      if (missing.length) sections.push({ icon: sec.icon || '⭐', name: sec.name, missing });
    });

    if (!sections.length) {
      root.innerHTML = '<div class="empty-state"><h3>🎉 ¡Felicitaciones!</h3><p>Tienes todas las fichas del álbum.</p></div>';
      return;
    }

    sections.forEach(s => {
      const el = document.createElement('div');
      el.className = 'missing-team';
      const numsHtml = s.missing.map(n => '<span class="missing-num">' + n + '</span>').join('');
      el.innerHTML =
        '<div class="missing-team-header"><span>' + s.icon + '</span><span>' + escapeHtml(s.name) + '</span>' +
        '<span style="margin-left:auto;color:var(--text-muted);font-weight:400;font-size:13px">' + s.missing.length + ' faltan</span></div>' +
        '<div class="missing-numbers">' + numsHtml + '</div>';
      root.appendChild(el);
    });
  }

  function renderAll() {
    renderGroups();
    renderSpecial();
    renderMissing();
    recomputeStats();
  }

  // ---------- Detail modal ----------
  function openDetail(opts) {
    // If the user opens a new team with unsaved changes from another, force them to resolve first.
    if (state.dirty.size > 0) {
      const ok = confirm(state.dirty.size + ' cambio(s) sin guardar. ¿Descartar para abrir otro equipo?');
      if (!ok) return;
      discardChangesNoConfirm();
    }
    state.currentDetail = opts;
    state.snapshot = snapshotInventory();
    state.dirty.clear();
    $('detailTitle').textContent = opts.title;
    $('scanStatus').hidden = true;
    $('scanPreviewWrap').hidden = true;
    scanCtx.img = null;
    scanCtx.rotation = 0;
    renderStickerGrid();
    renderSaveButton();
    $('detailModal').hidden = false;
  }

  function closeDetail() {
    if (state.dirty.size > 0) {
      const choice = confirm(
        state.dirty.size + ' cambio(s) sin guardar.\n\n' +
        'Aceptar = guardar y cerrar\n' +
        'Cancelar = volver al modal (no se cierra)'
      );
      if (choice) {
        // Save then close once it succeeds
        saveChanges().then(() => {
          if (state.dirty.size === 0) {
            $('detailModal').hidden = true;
            state.currentDetail = null;
            state.snapshot = null;
          }
        });
      }
      return; // either saving in progress or user clicked Cancel
    }
    $('detailModal').hidden = true;
    state.currentDetail = null;
    state.snapshot = null;
  }

  function discardChangesNoConfirm() {
    if (state.snapshot) {
      state.dirty.forEach((_, id) => {
        if (state.snapshot[id] === undefined) {
          delete state.inventory[id];
        } else {
          state.inventory[id] = state.snapshot[id];
        }
      });
    }
    state.dirty.clear();
    renderSaveButton();
    if (state.currentDetail) renderStickerGrid();
    recomputeStats();
  }

  function renderStickerGrid(highlightSet) {
    const grid = $('stickerGrid');
    grid.innerHTML = '';
    const { stickerCount, idFor } = state.currentDetail;
    for (let i = 1; i <= stickerCount; i++) {
      const id = idFor(i);
      const s = getSticker(id);
      const el = document.createElement('div');
      el.className = 'sticker' + (s.owned ? ' owned' : '') + (s.count > 1 ? ' dup' : '');
      if (highlightSet && highlightSet.has(i)) el.classList.add('detected-new');
      el.textContent = i;
      if (s.count > 1) {
        const badge = document.createElement('span');
        badge.className = 'count-badge';
        badge.textContent = '×' + s.count;
        el.appendChild(badge);
      }
      let tip = s.owned
        ? (s.count > 1 ? 'Tienen ' + s.count + ' (' + (s.count - 1) + ' repetidas)' : 'Tienen esta ficha')
        : 'Aún no tienen esta ficha';
      if (s.updatedBy) tip += '\nActualizada por: ' + s.updatedBy;
      el.title = tip;
      // Left-click cycles: empty -> 1 -> 2 -> 3 -> ... -> empty
      el.addEventListener('click', () => cycleSticker(id));
      // Right-click decrements
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); decSticker(id); });
      grid.appendChild(el);
    }
  }

  function cycleSticker(id) {
    const s = getSticker(id);
    let next;
    if (!s.owned) next = { owned: true, count: 1 };
    else if (s.count < 5) next = { owned: true, count: s.count + 1 };
    else next = { owned: false, count: 0 };
    markDirty(id, next.owned, next.count);
    renderStickerGrid();
    recomputeStats();
  }

  function decSticker(id) {
    const s = getSticker(id);
    if (!s.owned) return;
    const next = s.count > 1 ? { owned: true, count: s.count - 1 } : { owned: false, count: 0 };
    markDirty(id, next.owned, next.count);
    renderStickerGrid();
    recomputeStats();
  }

  function markAllOwned() {
    const { stickerCount, idFor } = state.currentDetail;
    let n = 0;
    for (let i = 1; i <= stickerCount; i++) {
      const id = idFor(i);
      const cur = getSticker(id);
      if (!cur.owned) { markDirty(id, true, 1); n++; }
    }
    renderStickerGrid();
    recomputeStats();
    if (n > 0) toast(n + ' fichas pendientes de guardar', 'success');
  }

  function clearAll() {
    if (!confirm('¿Marcar todas las fichas de esta página como faltantes? (no se guarda hasta que pulses Guardar)')) return;
    const { stickerCount, idFor } = state.currentDetail;
    for (let i = 1; i <= stickerCount; i++) {
      const id = idFor(i);
      if (getSticker(id).owned) markDirty(id, false, 0);
    }
    renderStickerGrid();
    recomputeStats();
  }

  // ---------- Photo scan ----------
  // We keep the loaded image (with current rotation) here so the rotate buttons
  // can re-render before the user confirms the scan.
  const scanCtx = { img: null, rotation: 0 };

  async function handlePhoto(file) {
    if (!file) return;
    const detail = state.currentDetail;
    if (!detail) return;

    setScanStatus('Cargando imagen…');
    try {
      scanCtx.img = await loadImage(file);
      scanCtx.rotation = 0;
      renderScanPreview();
      setScanStatus('Si la foto se ve acostada, rótala con los botones. Luego pulsa "Analizar foto".');
    } catch (e) {
      setScanStatus('Error cargando imagen: ' + e.message, true);
    }
  }

  function rotateScan(deg) {
    if (!scanCtx.img) return;
    scanCtx.rotation = (scanCtx.rotation + deg + 360) % 360;
    renderScanPreview();
  }

  function renderScanPreview() {
    if (!scanCtx.img) return;
    const dataUrl = renderRotatedDataUrl(scanCtx.img, scanCtx.rotation, 1400, 0.85);
    $('scanPreview').src = dataUrl;
    $('scanPreviewWrap').hidden = false;
  }

  async function confirmScan() {
    if (!scanCtx.img) return;
    const detail = state.currentDetail;
    if (!detail) return;

    setScanStatus('Comprimiendo imagen…');
    let dataUrl;
    try {
      // Render rotated image at higher quality for the API call.
      dataUrl = renderRotatedDataUrl(scanCtx.img, scanCtx.rotation, 1400, 0.85);
      console.log('Image to send:', dataUrl.length, 'bytes, rotation:', scanCtx.rotation);
    } catch (e) {
      setScanStatus('Error procesando imagen: ' + e.message, true);
      return;
    }

    setScanStatus('Analizando con Claude Vision… (puede tardar 10-25 seg)');

    try {
      const res = await callBackend('scan', {
        image: dataUrl,
        stickerCount: detail.stickerCount,
        context: detail.contextLabel || detail.title,
        teamCode: detail.teamCode || ''
      });
      const filled = (res.filled || []).filter(n => n >= 1 && n <= detail.stickerCount);
      const detected = new Set();
      let newCount = 0;
      filled.forEach(n => {
        const id = detail.idFor(n);
        const cur = getSticker(id);
        if (!cur.owned) {
          markDirty(id, true, 1);
          detected.add(n);
          newCount++;
        }
      });

      renderStickerGrid(detected);
      recomputeStats();

      let msg = '✅ Detectadas ' + filled.length + ' fichas';
      if (newCount > 0) {
        msg += ' (' + newCount + ' nuevas — pulsa Guardar para confirmar)';
      } else {
        msg += ' (ninguna nueva)';
      }
      if (res.uncertain && res.uncertain.length) {
        msg += ' · ⚠️ ' + res.uncertain.length + ' inciertas (revisa: ' + res.uncertain.join(', ') + ')';
      }
      if (res.notes) msg += ' · ' + res.notes;
      setScanStatus(msg);
      toast(msg, 'success');
    } catch (e) {
      setScanStatus('Error: ' + e.message, true);
      toast('Error escaneando: ' + e.message, 'error');
    }
  }

  function setScanStatus(msg, isError) {
    const el = $('scanStatus');
    el.textContent = msg;
    el.className = 'scan-status' + (isError ? ' error' : '');
    el.hidden = false;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Imagen inválida'));
        img.onload = () => resolve(img);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderRotatedDataUrl(img, rotationDeg, maxDim, quality) {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    // Scale down before rotating
    if (w > maxDim || h > maxDim) {
      const r = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    const canvas = document.createElement('canvas');
    const rot = ((rotationDeg % 360) + 360) % 360;
    // For 90/270 degrees, swap width/height
    if (rot === 90 || rot === 270) {
      canvas.width = h;
      canvas.height = w;
    } else {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  // ---------- Tabs ----------
  function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        $(tab.dataset.tab + 'View').classList.add('active');
      });
    });
  }

  // ---------- Google Sign-In ----------
  const AUTH_STORAGE_KEY = 'panini-auth-v1';

  window.handleCredentialResponse = function (response) {
    const payload = parseJwt(response.credential);
    state.user = {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      idToken: response.credential,
      exp: payload.exp // Unix seconds; Google ID tokens last ~1 hour
    };
    saveStoredAuth(state.user);
    renderUserPill();
    bootstrap();
  };

  function parseJwt(token) {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  }

  function loadStoredAuth() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.idToken || !data.exp) return null;
      // 60s safety margin so we don't use a token that expires mid-request
      if (Date.now() / 1000 > data.exp - 60) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function saveStoredAuth(user) {
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
    } catch (e) { /* localStorage may be disabled */ }
  }

  function clearStoredAuth() {
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
  }

  function renderUserPill() {
    const u = state.user;
    if (!u) return;
    $('userArea').innerHTML =
      '<div class="user-pill">' +
        (u.picture ? '<img src="' + u.picture + '" alt="" referrerpolicy="no-referrer" />' : '') +
        '<span>' + escapeHtml(u.name || u.email) + '</span>' +
        '<button id="signOutBtn">Salir</button>' +
      '</div>';
    $('signOutBtn').addEventListener('click', signOut);
  }

  function signOut() {
    state.user = null;
    state.inventory = {};
    clearStoredAuth();
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
    location.reload();
  }

  function initGoogleSignIn() {
    if (!window.CONFIG.googleClientId || window.CONFIG.googleClientId.indexOf('PASTE_') === 0) {
      $('userArea').innerHTML = '<div style="color:#ffd;font-size:12px">⚠️ Configura googleClientId en config.js</div>';
      return;
    }
    function ready() {
      google.accounts.id.initialize({
        client_id: window.CONFIG.googleClientId,
        callback: handleCredentialResponse,
        auto_select: true
      });
      // Only show the Sign-In button if there's no valid stored session
      if (!state.user) {
        google.accounts.id.renderButton(
          document.getElementById('googleSignInBtn'),
          { theme: 'filled_blue', size: 'medium', text: 'signin_with', shape: 'pill' }
        );
        google.accounts.id.prompt();
      }
    }
    if (window.google && google.accounts && google.accounts.id) ready();
    else window.addEventListener('load', () => setTimeout(ready, 300));
  }

  // ---------- Bootstrap ----------
  async function loadAlbum() {
    const resp = await fetch('data/album-structure.json');
    if (!resp.ok) throw new Error('No se pudo cargar el álbum');
    state.album = await resp.json();
  }

  async function bootstrap() {
    try {
      if (!state.album) await loadAlbum();
      const data = await callBackend('getInventory');
      state.inventory = data.inventory || {};
      $('welcome').hidden = true;
      $('main').hidden = false;
      $('stats').hidden = false;
      renderAll();
      renderSyncStatus();
    } catch (e) {
      console.error(e);
      // If backend rejects our token (expired/invalid), clear it and prompt re-login.
      if (/unauthorized/i.test(e.message) || /401/.test(e.message)) {
        clearStoredAuth();
        state.user = null;
        $('userArea').innerHTML = '<div id="googleSignInBtn"></div>';
        initGoogleSignIn();
        toast('Sesión expirada. Inicia sesión otra vez.', 'error');
      } else {
        toast('Error: ' + e.message, 'error');
      }
    }
  }

  // Pulls latest inventory from the Sheet to show changes other users made.
  // Used by the ↻ button and on window focus (debounced).
  let reloadInflight = false;
  async function reloadInventory(silent) {
    if (reloadInflight) return;
    if (!state.user) return;
    if (state.dirty.size > 0) {
      if (!silent) toast('Guarda o descarta tus cambios antes de recargar', 'error');
      return;
    }
    reloadInflight = true;
    const btn = $('reloadBtn');
    if (btn) btn.classList.add('spinning');
    try {
      const data = await callBackend('getInventory');
      const before = JSON.stringify(state.inventory);
      state.inventory = data.inventory || {};
      const after = JSON.stringify(state.inventory);
      renderAll();
      if (!silent) {
        toast(before === after ? 'Sin cambios nuevos' : '✓ Inventario actualizado', 'success');
      }
    } catch (e) {
      if (!silent) toast('Error al recargar: ' + e.message, 'error');
    } finally {
      reloadInflight = false;
      if (btn) btn.classList.remove('spinning');
    }
  }

  // Auto-refresh when the user returns to the tab, but not more than once per 20s,
  // and never while there are unsaved local changes (would clobber them).
  let lastAutoReload = 0;
  function maybeAutoReload() {
    if (!state.user) return;
    if (document.hidden) return;
    if (state.dirty.size > 0) return;
    const now = Date.now();
    if (now - lastAutoReload < 20000) return;
    lastAutoReload = now;
    reloadInventory(true);
  }

  // ---------- Util ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- Wire up ----------
  document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    $('closeDetail').addEventListener('click', closeDetail);
    $('detailModal').addEventListener('click', (e) => {
      if (e.target === $('detailModal')) closeDetail();
    });
    $('photoInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      handlePhoto(f);
      e.target.value = '';
    });
    $('markAllBtn').addEventListener('click', markAllOwned);
    $('clearAllBtn').addEventListener('click', clearAll);
    $('rotateLeftBtn').addEventListener('click', () => rotateScan(-90));
    $('rotateRightBtn').addEventListener('click', () => rotateScan(90));
    $('rotate180Btn').addEventListener('click', () => rotateScan(180));
    $('confirmScanBtn').addEventListener('click', confirmScan);
    $('reloadBtn').addEventListener('click', () => reloadInventory(false));
    $('syncStatus').addEventListener('click', () => {
      if (state.failedOps.length) retryFailed();
    });
    $('saveChangesBtn').addEventListener('click', saveChanges);
    $('discardChangesBtn').addEventListener('click', discardChanges);
    // Warn if the user tries to close/reload the tab with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      if (state.dirty.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', maybeAutoReload);
    renderSyncStatus();
    renderSaveButton();

    // Try to restore session from localStorage before showing the login button
    const stored = loadStoredAuth();
    if (stored) {
      state.user = stored;
      renderUserPill();
      bootstrap();
    }
    initGoogleSignIn();
    // Pre-load album so first interaction is instant
    loadAlbum().catch(err => console.warn('Album preload failed:', err));
  });
})();
