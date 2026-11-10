/**
 * app.js
 * Session controller, SHA-256 lecturer authentication, synchronised timers,
 * anonymous student drafting, live Word-style review broadcast, and IndexedDB archiving.
 */
(function () {
  'use strict';

  const ADJECTIVES = [
    'Empirical', 'Reflexive', 'Critical', 'Inductive', 'Deductive', 'Systematic',
    'Analytical', 'Interpretive', 'Dialectical', 'Rigorous', 'Epistemic', 'Pragmatic'
  ];
  const NOUNS = [
    'Scholar', 'Researcher', 'Inquirer', 'Methodologist', 'Observer', 'Analyst',
    'Theorist', 'Ethnographer', 'Investigator', 'Synthesist', 'Reviewer', 'Fellow'
  ];

  const VIEW_MODE_LABELS = {
    'all-markup': 'All Markup',
    'simple-markup': 'Simple Markup',
    'no-markup': 'No Markup (Final)',
    'original': 'Original'
  };

  function randomCode(prefix) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return (prefix || 'METH') + '-' + out;
  }

  function generatePseudonym() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(10 + Math.random() * 89);
    return adj + ' ' + noun + ' #' + num;
  }

  async function hashPassphrase(text) {
    const clean = String(text || '').trim();
    if (window.crypto && window.crypto.subtle) {
      const msgBuffer = new TextEncoder().encode('wh_salt_v1::' + clean);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
      return Array.from(new Uint8Array(hashBuffer))
        .map(function (b) { return b.toString(16).padStart(2, '0'); })
        .join('');
    }
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
      h = ((h << 5) - h) + clean.charCodeAt(i);
      h |= 0;
    }
    return 'fb_' + Math.abs(h);
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return 'Untimed';
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function showToast(message) {
    const box = document.getElementById('toast-container');
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    box.appendChild(item);
    setTimeout(function () {
      item.remove();
    }, 3200);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // =========================================================
  // INDEXEDDB ARCHIVE STORE
  // =========================================================
  const ArchiveDB = (function () {
    const DB_NAME = 'AcademicWritingHubArchives';
    const STORE = 'archives';

    function openDb() {
      return new Promise(function (resolve, reject) {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }

    async function save(record) {
      const db = await openDb();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error); };
      });
    }

    async function getAll() {
      const db = await openDb();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          const list = req.result || [];
          list.sort(function (a, b) { return (b.archivedAt || 0) - (a.archivedAt || 0); });
          resolve(list);
        };
        req.onerror = function () { reject(req.error); };
      });
    }

    async function remove(id) {
      const db = await openDb();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        req.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }

    return { save: save, getAll: getAll, remove: remove };
  })();

  // =========================================================
  // APPLICATION STATE
  // =========================================================
  let currentRole = null;
  let sessionState = null;
  let submissionsMap = {};
  let liveModelState = null;

  let studentIdentity = loadStudentIdentity();
  let studentEditor = null;
  let loadedDraftSessionId = null;
  let draftSyncTimer = null;

  let adminEditor = null;
  let selectedStudentId = null;
  let activeComments = [];
  let modelBroadcastTimer = null;
  let timerInterval = null;
  let lastSpotlightStamp = 0;

  function loadStudentIdentity() {
    try {
      const saved = JSON.parse(localStorage.getItem('wh_student_identity') || 'null');
      if (saved && saved.id && saved.alias) return saved;
    } catch (_) {}
    const fresh = {
      id: 'stu_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      alias: generatePseudonym()
    };
    localStorage.setItem('wh_student_identity', JSON.stringify(fresh));
    return fresh;
  }

  const el = {};
  function cacheDom() {
    const ids = [
      'view-gateway', 'view-admin', 'view-student',
      'tab-btn-student', 'tab-btn-admin', 'panel-join-student', 'panel-login-admin',
      'student-room-input', 'student-db-wrapper', 'student-db-input', 'student-join-error', 'btn-student-join',
      'admin-mode-select', 'admin-db-group', 'admin-db-input', 'admin-room-input', 'btn-generate-room',
      'admin-pass-input', 'admin-lesson-input', 'admin-login-error', 'btn-admin-start',
      // Admin
      'admin-lesson-badge', 'admin-room-badge', 'admin-status-badge', 'admin-timer-display',
      'btn-open-invite', 'btn-open-setup', 'btn-stop-writing', 'btn-archive-session', 'btn-open-archives', 'btn-admin-logout',
      'admin-sidebar', 'submissions-count', 'submissions-list', 'btn-toggle-sidebar', 'btn-expand-sidebar',
      'admin-empty-canvas', 'btn-empty-setup', 'btn-empty-invite', 'admin-modelling-panel',
      'model-author-label', 'model-wordcount-label', 'model-revcount-label', 'chk-compare-original', 'btn-reset-model',
      'admin-canvas-split', 'admin-original-pane', 'admin-original-content', 'admin-editor-mount',
      'comment-composer', 'comment-quote-preview', 'comment-tag-select', 'comment-text-input',
      'btn-save-comment', 'btn-cancel-comment', 'admin-comments-list',
      // Student
      'student-alias-label', 'btn-shuffle-alias', 'student-conn-dot', 'student-conn-text',
      'student-timer-badge', 'student-phase-badge', 'btn-switch-to-admin', 'btn-student-leave',
      'student-phase-lobby', 'student-lobby-room', 'student-lobby-lesson',
      'student-phase-writing', 'prompt-topic-title', 'prompt-genre-badge', 'prompt-wordlimit-badge',
      'prompt-instructions-body', 'student-editor-mount', 'student-word-counter', 'student-save-status', 'btn-student-submit',
      'student-phase-modelling', 'mirror-viewmode-badge', 'mirror-waiting-notice', 'mirror-workspace', 'mirror-author-badge',
      'mirror-original-pane', 'mirror-original-body', 'mirror-model-body', 'mirror-comments-list',
      // Modals
      'modal-session-setup', 'setup-topic', 'setup-genre', 'setup-duration', 'setup-wordlimit',
      'setup-instructions', 'setup-clear-previous', 'btn-launch-session', 'btn-close-setup', 'btn-cancel-setup',
      'modal-invite', 'invite-room-code', 'invite-qr-box', 'invite-mode-warning', 'invite-url-input', 'btn-copy-invite', 'btn-close-invite',
      'modal-archives', 'archives-list', 'btn-export-all-json', 'btn-import-json', 'file-import-json', 'btn-close-archives',
      'modal-admin-unlock', 'unlock-pass-input', 'unlock-error', 'btn-confirm-unlock', 'btn-cancel-unlock'
    ];
    ids.forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  function switchScreen(viewName) {
    el['view-gateway'].classList.toggle('hidden', viewName !== 'gateway');
    el['view-admin'].classList.toggle('hidden', viewName !== 'admin');
    el['view-student'].classList.toggle('hidden', viewName !== 'student');
  }

  // =========================================================
  // GATEWAY & CONNECTION WORKFLOW
  // =========================================================
  function setupGatewayEvents() {
    el['tab-btn-student'].addEventListener('click', function () {
      el['tab-btn-student'].classList.add('active');
      el['tab-btn-admin'].classList.remove('active');
      el['panel-join-student'].classList.remove('hidden');
      el['panel-login-admin'].classList.add('hidden');
    });

    el['tab-btn-admin'].addEventListener('click', function () {
      el['tab-btn-admin'].classList.add('active');
      el['tab-btn-student'].classList.remove('active');
      el['panel-login-admin'].classList.remove('hidden');
      el['panel-join-student'].classList.add('hidden');
    });

    el['admin-mode-select'].addEventListener('change', function () {
      const isCloud = el['admin-mode-select'].value === 'firebase';
      el['admin-db-group'].classList.toggle('hidden', !isCloud);
    });

    el['btn-generate-room'].addEventListener('click', function () {
      el['admin-room-input'].value = randomCode('METH');
    });

    const savedAdmin = JSON.parse(localStorage.getItem('wh_admin_prefs') || '{}');
    if (savedAdmin.dbUrl) el['admin-db-input'].value = savedAdmin.dbUrl;
    if (savedAdmin.mode) {
      el['admin-mode-select'].value = savedAdmin.mode;
      el['admin-db-group'].classList.toggle('hidden', savedAdmin.mode !== 'firebase');
    }
    el['admin-room-input'].value = savedAdmin.roomId || randomCode('METH');
    if (savedAdmin.lessonTitle) el['admin-lesson-input'].value = savedAdmin.lessonTitle;

    el['btn-admin-start'].addEventListener('click', handleAdminStart);
    el['btn-student-join'].addEventListener('click', function () {
      const room = el['student-room-input'].value.trim();
      const dbUrl = el['student-db-input'].value.trim();
      const mode = dbUrl === 'LOCAL_SANDBOX' ? 'local' : 'firebase';
      startStudentConnection(mode, dbUrl, room);
    });
  }

  async function handleAdminStart() {
    el['admin-login-error'].classList.add('hidden');
    const mode = el['admin-mode-select'].value;
    const dbUrl = el['admin-db-input'].value.trim();
    const roomId = HubSync.sanitiseRoomKey(el['admin-room-input'].value);
    const passphrase = el['admin-pass-input'].value.trim();
    const lessonTitle = el['admin-lesson-input'].value.trim() || 'Research Methodology Writing';

    if (!roomId) {
      showError(el['admin-login-error'], 'Please specify a Room Code.');
      return;
    }
    if (!passphrase) {
      showError(el['admin-login-error'], 'Please enter a Lecturer Passphrase to protect admin controls.');
      return;
    }

    el['btn-admin-start'].disabled = true;
    try {
      await connectHub('admin', mode, dbUrl, roomId);
      const passHash = await hashPassphrase(passphrase);
      const existingMeta = await HubSync.getRoomMetaOnce();

      if (existingMeta && existingMeta.adminHash && existingMeta.adminHash !== passHash) {
        HubSync.disconnect();
        showError(el['admin-login-error'], 'Incorrect passphrase for existing room ' + roomId + '. Choose a new Room Code or enter the original passphrase.');
        el['btn-admin-start'].disabled = false;
        return;
      }

      await HubSync.saveRoomMeta({
        adminHash: passHash,
        lessonTitle: lessonTitle,
        updatedAt: HubSync.getServerNow()
      });

      if (!sessionState) {
        await HubSync.updateSession({
          sessionId: 'ses_' + Date.now(),
          lessonTitle: lessonTitle,
          status: 'lobby',
          topic: '',
          genre: '',
          instructions: '',
          wordLimit: 0,
          durationMinutes: 0,
          endTime: null
        });
      } else if (lessonTitle) {
        await HubSync.updateSession({ lessonTitle: lessonTitle });
      }

      localStorage.setItem('wh_admin_prefs', JSON.stringify({
        mode: mode,
        dbUrl: dbUrl,
        roomId: roomId,
        lessonTitle: lessonTitle
      }));

      el['admin-lesson-badge'].textContent = lessonTitle;
      el['admin-room-badge'].textContent = roomId;
      switchScreen('admin');
      startGlobalTimerLoop();
    } catch (err) {
      showError(el['admin-login-error'], err.message || 'Unable to connect.');
    } finally {
      el['btn-admin-start'].disabled = false;
    }
  }

  async function startStudentConnection(mode, dbUrl, roomCode) {
    el['student-join-error'].classList.add('hidden');
    const roomId = HubSync.sanitiseRoomKey(roomCode);
    if (!roomId) {
      showError(el['student-join-error'], 'Please enter the Session Room Code.');
      return;
    }
    if (mode === 'firebase' && !dbUrl) {
      showError(el['student-join-error'], 'Please open the full Invite Link/QR provided by your lecturer, or paste the Sync Database URL.');
      return;
    }

    el['btn-student-join'].disabled = true;
    try {
      await connectHub('student', mode, dbUrl, roomId);
      el['student-alias-label'].textContent = studentIdentity.alias;
      el['student-lobby-room'].textContent = roomId;
      switchScreen('student');
      startGlobalTimerLoop();
    } catch (err) {
      showError(el['student-join-error'], err.message || 'Unable to join room.');
    } finally {
      el['btn-student-join'].disabled = false;
    }
  }

  async function connectHub(role, mode, dbUrl, roomId) {
    currentRole = role;
    sessionState = null;
    submissionsMap = {};
    liveModelState = null;
    selectedStudentId = null;

    await HubSync.init({
      mode: mode,
      dbUrl: dbUrl,
      roomId: roomId,
      onConnectionChange: function (online) {
        el['student-conn-dot'].className = 'conn-dot ' + (online ? 'online' : 'offline');
        el['student-conn-text'].textContent = online ? 'Live' : 'Reconnecting...';
      },
      onSessionChange: function (session) {
        sessionState = session;
        if (currentRole === 'admin') renderAdminSessionHeader();
        if (currentRole === 'student') renderStudentSessionState();
      },
      onSubmissionsChange: function (subs) {
        submissionsMap = subs || {};
        if (currentRole === 'admin') renderAdminSubmissionsList();
      },
      onLiveModelChange: function (liveModel) {
        liveModelState = liveModel;
        if (currentRole === 'student') renderStudentLiveMirror();
      }
    });
  }

  function showError(bannerEl, msg) {
    bannerEl.textContent = msg;
    bannerEl.classList.remove('hidden');
  }

  // =========================================================
  // SYNCHRONISED COUNTDOWN & AUTO-LOCK ENGINE
  // =========================================================
  function startGlobalTimerLoop() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(tickTimer, 500);
    tickTimer();
  }

  function tickTimer() {
    if (!sessionState) return;
    const status = sessionState.status || 'lobby';

    if (status !== 'writing' || !sessionState.endTime) {
      const label = status === 'writing' ? 'Untimed' : (status === 'modelling' ? 'Locked' : '--:--');
      el['admin-timer-display'].textContent = label;
      el['admin-timer-display'].classList.remove('urgent');
      el['student-timer-badge'].textContent = label;
      el['student-timer-badge'].classList.remove('urgent');
      return;
    }

    const remaining = sessionState.endTime - HubSync.getServerNow();
    const formatted = formatDuration(remaining);
    const isUrgent = remaining > 0 && remaining <= 60000;

    el['admin-timer-display'].textContent = formatted;
    el['admin-timer-display'].classList.toggle('urgent', isUrgent);
    el['student-timer-badge'].textContent = formatted;
    el['student-timer-badge'].classList.toggle('urgent', isUrgent);

    if (remaining <= 0) {
      if (currentRole === 'student' && studentEditor) {
        studentEditor.setLocked(true);
        flushStudentDraft(true);
      }
      if (currentRole === 'admin' && sessionState.status === 'writing') {
        stopWritingAndBroadcast();
      }
    }
  }

  // =========================================================
  // STUDENT INTERFACE WORKFLOW
  // =========================================================
  function setupStudentEvents() {
    studentEditor = HubEditor.initStudentEditor(el['student-editor-mount'], {
      onChange: function (html) {
        if (!sessionState || sessionState.status !== 'writing') return;
        updateStudentWordCounter(html);
        localStorage.setItem('wh_draft_' + sessionState.sessionId, html);
        el['student-save-status'].textContent = 'Saving...';

        if (draftSyncTimer) clearTimeout(draftSyncTimer);
        draftSyncTimer = setTimeout(function () {
          flushStudentDraft(false);
        }, 900);
      }
    });

    el['btn-student-submit'].addEventListener('click', function () {
      flushStudentDraft(true);
      showToast('Writing saved and submitted to the lecturer.');
    });

    el['btn-shuffle-alias'].addEventListener('click', function () {
      studentIdentity.alias = generatePseudonym();
      localStorage.setItem('wh_student_identity', JSON.stringify(studentIdentity));
      el['student-alias-label'].textContent = studentIdentity.alias;
      if (sessionState && sessionState.status === 'writing') {
        flushStudentDraft(false);
      }
    });

    el['btn-student-leave'].addEventListener('click', function () {
      HubSync.disconnect();
      switchScreen('gateway');
    });

    el['btn-switch-to-admin'].addEventListener('click', function () {
      el['unlock-pass-input'].value = '';
      el['unlock-error'].classList.add('hidden');
      el['modal-admin-unlock'].classList.remove('hidden');
    });

    el['btn-cancel-unlock'].addEventListener('click', function () {
      el['modal-admin-unlock'].classList.add('hidden');
    });

    el['btn-confirm-unlock'].addEventListener('click', async function () {
      const pass = el['unlock-pass-input'].value.trim();
      const meta = await HubSync.getRoomMetaOnce();
      const enteredHash = await hashPassphrase(pass);
      if (!meta || meta.adminHash !== enteredHash) {
        showError(el['unlock-error'], 'Invalid lecturer passphrase.');
        return;
      }
      el['modal-admin-unlock'].classList.add('hidden');
      const syncInfo = HubSync.getState();
      await connectHub('admin', syncInfo.mode, syncInfo.dbUrl, syncInfo.roomId);
      el['admin-room-badge'].textContent = syncInfo.roomId;
      el['admin-lesson-badge'].textContent = (meta && meta.lessonTitle) || 'Research Methodology';
      switchScreen('admin');
    });
  }

  function updateStudentWordCounter(html) {
    const words = HubEditor.countWordsFromHtml(html);
    const limit = Number(sessionState && sessionState.wordLimit) || 0;
    const counterEl = el['student-word-counter'];
    counterEl.className = 'word-counter';

    if (limit > 0) {
      counterEl.textContent = words + ' / ' + limit + ' words';
      if (words > limit) counterEl.classList.add('over');
      else if (words >= limit * 0.9) counterEl.classList.add('warn');
    } else {
      counterEl.textContent = words + (words === 1 ? ' word' : ' words');
    }
  }

  async function flushStudentDraft(explicitSubmit) {
    if (!sessionState || !studentEditor) return;
    const html = studentEditor.getHtml();
    const wordCount = HubEditor.countWordsFromHtml(html);
    if (wordCount === 0 && !explicitSubmit) return;

    try {
      await HubSync.upsertSubmission(studentIdentity.id, {
        studentId: studentIdentity.id,
        pseudonym: studentIdentity.alias,
        originalHtml: html,
        wordCount: wordCount,
        submitted: Boolean(explicitSubmit),
        updatedAt: HubSync.getServerNow()
      });
      el['student-save-status'].textContent = explicitSubmit ? 'Submitted ✓' : 'Synced live ✓';
    } catch (_) {
      el['student-save-status'].textContent = 'Saved locally (reconnecting...)';
    }
  }

  function renderStudentSessionState() {
    if (!sessionState) {
      setStudentPhaseUI('lobby');
      return;
    }

    const status = sessionState.status || 'lobby';
    if (sessionState.lessonTitle) {
      el['student-lobby-lesson'].textContent = sessionState.lessonTitle + ' — Waiting for lecturer to start the session.';
    }

    if (status === 'lobby') {
      setStudentPhaseUI('lobby');
    } else if (status === 'writing') {
      setStudentPhaseUI('writing');
      el['prompt-topic-title'].textContent = sessionState.topic || 'Writing Session';
      el['prompt-genre-badge'].textContent = sessionState.genre || 'Methodology Text';
      el['prompt-wordlimit-badge'].textContent = sessionState.wordLimit > 0
        ? 'Limit: ' + sessionState.wordLimit + ' words'
        : 'Open length';
      el['prompt-instructions-body'].textContent = sessionState.instructions || 'Draft your text in the workspace below.';

      if (loadedDraftSessionId !== sessionState.sessionId) {
        loadedDraftSessionId = sessionState.sessionId;
        const cached = localStorage.getItem('wh_draft_' + sessionState.sessionId) || '<p><br></p>';
        studentEditor.setHtml(cached);
        updateStudentWordCounter(cached);
      }
      const timeRemaining = sessionState.endTime ? (sessionState.endTime - HubSync.getServerNow()) : 1;
      studentEditor.setLocked(timeRemaining <= 0);
    } else if (status === 'modelling') {
      studentEditor.setLocked(true);
      setStudentPhaseUI('modelling');
      renderStudentLiveMirror();
    }
  }

  function setStudentPhaseUI(phase) {
    el['student-phase-lobby'].classList.toggle('hidden', phase !== 'lobby');
    el['student-phase-writing'].classList.toggle('hidden', phase !== 'writing');
    el['student-phase-modelling'].classList.toggle('hidden', phase !== 'modelling');

    const badge = el['student-phase-badge'];
    badge.className = 'status-pill status-' + phase;
    badge.textContent = phase === 'lobby' ? 'Waiting' : (phase === 'writing' ? 'Writing Open' : 'Live Review');
    el['btn-shuffle-alias'].classList.toggle('hidden', phase === 'modelling');
  }

  function renderStudentLiveMirror() {
    if (!sessionState || sessionState.status !== 'modelling') return;

    if (!liveModelState || !liveModelState.modelHtml) {
      el['mirror-waiting-notice'].classList.remove('hidden');
      el['mirror-workspace'].classList.add('hidden');
      return;
    }

    el['mirror-waiting-notice'].classList.add('hidden');
    el['mirror-workspace'].classList.remove('hidden');

    el['mirror-author-badge'].textContent = liveModelState.pseudonym || 'Anonymous Draft';

    // Apply synced Word Markup View mode
    const mode = liveModelState.viewMode || 'all-markup';
    el['mirror-viewmode-badge'].textContent = VIEW_MODE_LABELS[mode] || 'All Markup';
    const mirrorBody = el['mirror-model-body'];
    mirrorBody.classList.remove('view-all-markup', 'view-simple-markup', 'view-no-markup', 'view-original');
    mirrorBody.classList.add('view-' + mode);
    mirrorBody.innerHTML = HubEditor.sanitiseHtml(liveModelState.modelHtml);

    const showCompare = Boolean(liveModelState.compareOriginal);
    el['mirror-original-pane'].classList.toggle('hidden', !showCompare);
    if (showCompare) {
      el['mirror-original-body'].innerHTML = HubEditor.sanitiseHtml(liveModelState.originalHtml || '');
    }

    const comments = Array.isArray(liveModelState.comments) ? liveModelState.comments : [];
    const listEl = el['mirror-comments-list'];
    if (comments.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">Margin commentary will appear here as the lecturer reviews the text.</div>';
    } else {
      listEl.innerHTML = comments.map(function (c, idx) {
        return '' +
          '<div class="comment-card" data-mirror-cid="' + escapeHtml(c.id) + '">' +
            '<div class="comment-card-header">' +
              '<span class="comment-tag-badge">#' + (idx + 1) + ' &bull; ' + escapeHtml(c.tag) + '</span>' +
            '</div>' +
            (c.quote ? '<div class="comment-quote">&ldquo;' + escapeHtml(c.quote) + '&rdquo;</div>' : '') +
            '<div class="comment-body">' + escapeHtml(c.text) + '</div>' +
          '</div>';
      }).join('');
    }

    if (liveModelState.spotlight && liveModelState.spotlight.ts > lastSpotlightStamp) {
      lastSpotlightStamp = liveModelState.spotlight.ts;
      pulseHighlightComment(
        el['mirror-model-body'],
        el['mirror-comments-list'],
        liveModelState.spotlight.commentId
      );
    }
  }

  function pulseHighlightComment(proseContainer, commentsContainer, commentId) {
    const anchor = proseContainer.querySelector('span.rev-anchor[data-comment-id="' + commentId + '"]');
    const card = commentsContainer.querySelector('[data-mirror-cid="' + commentId + '"], [data-admin-cid="' + commentId + '"]');

    if (anchor) {
      anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      anchor.classList.add('spotlight-pulse');
      setTimeout(function () { anchor.classList.remove('spotlight-pulse'); }, 2600);
    }
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.add('spotlight-pulse');
      setTimeout(function () { card.classList.remove('spotlight-pulse'); }, 2600);
    }
  }

  // =========================================================
  // LECTURER ADMIN INTERFACE WORKFLOW
  // =========================================================
  function updateAdminStatsBadges(html, stats) {
    const words = HubEditor.countWordsFromHtml(html);
    el['model-wordcount-label'].textContent = words + ' words';
    const revStats = stats || adminEditor.getRevisionStats();
    const totalEdits = revStats.insertions + revStats.deletions;
    el['model-revcount-label'].textContent =
      revStats.insertions + ' ins • ' + revStats.deletions + ' del • ' + activeComments.length + (activeComments.length === 1 ? ' comment' : ' comments');
    el['model-revcount-label'].title = totalEdits + ' tracked in-text edits';
  }

  function setupAdminEvents() {
    adminEditor = HubEditor.initAdminEditor(el['admin-editor-mount'], {
      onChange: function (updatedHtml, stats) {
        if (!selectedStudentId) return;
        updateAdminStatsBadges(updatedHtml, stats);
        scheduleModelSync(false);
      },
      onViewModeChange: function () {
        if (!selectedStudentId) return;
        scheduleModelSync(true);
      },
      onRequestComment: function (selectedQuote) {
        el['comment-quote-preview'].textContent = selectedQuote;
        el['comment-text-input'].value = '';
        el['comment-composer'].classList.remove('hidden');
        el['comment-text-input'].focus();
      },
      onClickAnchor: function (commentId) {
        pulseHighlightComment(adminEditor.getRootElement(), el['admin-comments-list'], commentId);
      }
    });

    // Margin Comment controls
    el['btn-save-comment'].addEventListener('click', function () {
      const note = el['comment-text-input'].value.trim();
      if (!note) return;
      const cid = 'c_' + Date.now().toString(36);
      const quote = el['comment-quote-preview'].textContent;
      const tag = el['comment-tag-select'].value;

      adminEditor.attachCommentAnchor(cid);
      activeComments.push({ id: cid, tag: tag, quote: quote, text: note });
      el['comment-composer'].classList.add('hidden');
      renderAdminComments();
      updateAdminStatsBadges(adminEditor.getHtml());
      scheduleModelSync(true);
    });

    el['btn-cancel-comment'].addEventListener('click', function () {
      el['comment-composer'].classList.add('hidden');
    });

    // Split Original & Revert controls
    el['chk-compare-original'].addEventListener('change', function () {
      const show = el['chk-compare-original'].checked;
      el['admin-original-pane'].classList.toggle('hidden', !show);
      scheduleModelSync(true);
    });

    el['btn-reset-model'].addEventListener('click', function () {
      if (!selectedStudentId || !submissionsMap[selectedStudentId]) return;
      if (!confirm('Revert all tracked changes and comments back to the student\'s untouched submission?')) return;
      const orig = submissionsMap[selectedStudentId].originalHtml || '<p><br></p>';
      activeComments = [];
      adminEditor.setHtml(orig);
      adminEditor.setViewMode('all-markup');
      renderAdminComments();
      updateAdminStatsBadges(orig);
      scheduleModelSync(true);
    });

    // Sidebar collapse/expand
    el['btn-toggle-sidebar'].addEventListener('click', function () {
      el['admin-sidebar'].classList.add('hidden');
      el['btn-expand-sidebar'].classList.remove('hidden');
    });
    el['btn-expand-sidebar'].addEventListener('click', function () {
      el['admin-sidebar'].classList.remove('hidden');
      el['btn-expand-sidebar'].classList.add('hidden');
    });

    // Session, Invite & Archive modals
    el['btn-open-setup'].addEventListener('click', openSetupModal);
    el['btn-empty-setup'].addEventListener('click', openSetupModal);
    el['btn-close-setup'].addEventListener('click', closeSetupModal);
    el['btn-cancel-setup'].addEventListener('click', closeSetupModal);
    el['btn-launch-session'].addEventListener('click', launchWritingSession);

    el['btn-stop-writing'].addEventListener('click', stopWritingAndBroadcast);

    el['btn-open-invite'].addEventListener('click', openInviteModal);
    el['btn-empty-invite'].addEventListener('click', openInviteModal);
    el['btn-close-invite'].addEventListener('click', function () {
      el['modal-invite'].classList.add('hidden');
    });
    el['btn-copy-invite'].addEventListener('click', function () {
      navigator.clipboard.writeText(el['invite-url-input'].value);
      showToast('Student join link copied to clipboard.');
    });

    el['btn-archive-session'].addEventListener('click', archiveCurrentSession);
    el['btn-open-archives'].addEventListener('click', openArchivesModal);
    el['btn-close-archives'].addEventListener('click', function () {
      el['modal-archives'].classList.add('hidden');
    });
    el['btn-export-all-json'].addEventListener('click', exportAllArchivesJson);
    el['btn-import-json'].addEventListener('click', function () {
      el['file-import-json'].click();
    });
    el['file-import-json'].addEventListener('change', handleImportArchivesJson);

    el['btn-admin-logout'].addEventListener('click', function () {
      HubSync.disconnect();
      switchScreen('gateway');
    });
  }

  function renderAdminSessionHeader() {
    if (!sessionState) return;
    const status = sessionState.status || 'lobby';
    if (sessionState.lessonTitle) {
      el['admin-lesson-badge'].textContent = sessionState.lessonTitle;
    }
    const badge = el['admin-status-badge'];
    badge.className = 'status-pill status-' + status;
    badge.textContent = status === 'lobby' ? 'Lobby' : (status === 'writing' ? 'Writing Active' : 'Reviewing Live');

    el['btn-stop-writing'].classList.toggle('hidden', status !== 'writing');
  }

  function renderAdminSubmissionsList() {
    const entries = Object.values(submissionsMap || {}).filter(function (s) {
      return s && s.studentId;
    });
    entries.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

    el['submissions-count'].textContent = String(entries.length);
    const listEl = el['submissions-list'];

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">No student submissions yet. Share the Invite Link/QR and start a writing session.</div>';
      return;
    }

    const limit = Number(sessionState && sessionState.wordLimit) || 0;
    listEl.innerHTML = '';

    entries.forEach(function (sub) {
      const card = document.createElement('div');
      card.className = 'submission-card' + (sub.studentId === selectedStudentId ? ' active' : '');

      const plainPreview = (function () {
        const d = document.createElement('div');
        d.innerHTML = HubEditor.sanitiseHtml(sub.originalHtml || '');
        return (d.textContent || '').trim().slice(0, 140) || '(Blank draft)';
      })();

      const overLimit = limit > 0 && sub.wordCount > limit;
      const hasModel = sub.model && sub.model.modelHtml;

      card.innerHTML = '' +
        '<div class="sub-card-top">' +
          '<span class="sub-author">' + escapeHtml(sub.pseudonym || 'Anonymous') + '</span>' +
          '<span class="sub-words ' + (overLimit ? 'over-limit' : '') + '">' + (sub.wordCount || 0) + ' w</span>' +
        '</div>' +
        '<div class="sub-snippet">' + escapeHtml(plainPreview) + '</div>' +
        (hasModel ? '<div class="sub-badges"><span class="badge-modelled">Reviewed &check;</span></div>' : '');

      card.addEventListener('click', function () {
        selectSubmissionForModelling(sub.studentId);
      });
      listEl.appendChild(card);
    });
  }

  function selectSubmissionForModelling(studentId) {
    const sub = submissionsMap[studentId];
    if (!sub) return;

    selectedStudentId = studentId;
    el['admin-empty-canvas'].classList.add('hidden');
    el['admin-modelling-panel'].classList.remove('hidden');

    el['model-author-label'].textContent = sub.pseudonym || 'Anonymous Researcher';
    el['admin-original-content'].innerHTML = HubEditor.sanitiseHtml(sub.originalHtml || '<p><br></p>');

    const initialHtml = (sub.model && sub.model.modelHtml) ? sub.model.modelHtml : (sub.originalHtml || '<p><br></p>');
    activeComments = (sub.model && Array.isArray(sub.model.comments)) ? sub.model.comments.slice() : [];

    adminEditor.setHtml(initialHtml);
    if (sub.model && sub.model.viewMode) {
      adminEditor.setViewMode(sub.model.viewMode);
    } else {
      adminEditor.setViewMode('all-markup');
    }

    renderAdminSubmissionsList();
    renderAdminComments();
    updateAdminStatsBadges(initialHtml);
    scheduleModelSync(true);
  }

  function renderAdminComments() {
    const listEl = el['admin-comments-list'];
    if (activeComments.length === 0) {
      listEl.innerHTML = '<div class="empty-hint">Select text in the document and click <strong>+ New Comment</strong> in the Review ribbon.</div>';
      return;
    }

    listEl.innerHTML = '';
    activeComments.forEach(function (c, idx) {
      const card = document.createElement('div');
      card.className = 'comment-card';
      card.setAttribute('data-admin-cid', c.id);
      card.innerHTML = '' +
        '<div class="comment-card-header">' +
          '<span class="comment-tag-badge">#' + (idx + 1) + ' &bull; ' + escapeHtml(c.tag) + '</span>' +
        '</div>' +
        (c.quote ? '<div class="comment-quote">&ldquo;' + escapeHtml(c.quote) + '&rdquo;</div>' : '') +
        '<div class="comment-body">' + escapeHtml(c.text) + '</div>' +
        '<div class="comment-actions">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-act="spotlight">Spotlight Class</button>' +
          '<button type="button" class="btn btn-secondary btn-xs" data-act="delete">Resolve / Delete</button>' +
        '</div>';

      card.querySelector('[data-act="spotlight"]').addEventListener('click', function () {
        pulseHighlightComment(adminEditor.getRootElement(), el['admin-comments-list'], c.id);
        broadcastCurrentModel({ commentId: c.id, ts: HubSync.getServerNow() });
        showToast('Spotlighted Comment #' + (idx + 1) + ' on all student screens.');
      });

      card.querySelector('[data-act="delete"]').addEventListener('click', function () {
        adminEditor.removeCommentAnchor(c.id);
        activeComments = activeComments.filter(function (item) { return item.id !== c.id; });
        renderAdminComments();
        updateAdminStatsBadges(adminEditor.getHtml());
        scheduleModelSync(true);
      });

      listEl.appendChild(card);
    });
  }

  function scheduleModelSync(immediate) {
    if (modelBroadcastTimer) clearTimeout(modelBroadcastTimer);
    if (immediate) {
      broadcastCurrentModel(null);
    } else {
      modelBroadcastTimer = setTimeout(function () {
        broadcastCurrentModel(null);
      }, 220);
    }
  }

  async function broadcastCurrentModel(spotlightObj) {
    if (!selectedStudentId || !submissionsMap[selectedStudentId]) return;
    const sub = submissionsMap[selectedStudentId];
    const currentHtml = adminEditor.getHtml();
    const currentViewMode = adminEditor.getViewMode();

    const modelRecord = {
      modelHtml: currentHtml,
      viewMode: currentViewMode,
      comments: activeComments,
      updatedAt: HubSync.getServerNow()
    };

    await HubSync.saveSubmissionModel(selectedStudentId, modelRecord);
    await HubSync.broadcastLiveModel({
      studentId: selectedStudentId,
      pseudonym: sub.pseudonym || 'Anonymous Researcher',
      originalHtml: sub.originalHtml || '',
      modelHtml: currentHtml,
      viewMode: currentViewMode,
      comments: activeComments,
      compareOriginal: el['chk-compare-original'].checked,
      spotlight: spotlightObj || (liveModelState && liveModelState.spotlight) || null,
      updatedAt: HubSync.getServerNow()
    });
  }

  // =========================================================
  // SESSION CONTROL, INVITE QR & ARCHIVING
  // =========================================================
  function openSetupModal() {
    if (sessionState && sessionState.topic) {
      el['setup-topic'].value = sessionState.topic;
      el['setup-instructions'].value = sessionState.instructions || '';
    }
    el['modal-session-setup'].classList.remove('hidden');
  }

  function closeSetupModal() {
    el['modal-session-setup'].classList.add('hidden');
  }

  async function launchWritingSession() {
    const topic = el['setup-topic'].value.trim() || 'Methodology Writing Exercise';
    const genre = el['setup-genre'].value;
    const durationMins = Math.max(0, Number(el['setup-duration'].value) || 0);
    const wordLimit = Math.max(0, Number(el['setup-wordlimit'].value) || 0);
    const instructions = el['setup-instructions'].value.trim();
    const clearPrev = el['setup-clear-previous'].checked;

    if (clearPrev) {
      await HubSync.clearSubmissionsAndModel();
      selectedStudentId = null;
      activeComments = [];
      el['admin-modelling-panel'].classList.add('hidden');
      el['admin-empty-canvas'].classList.remove('hidden');
    }

    const now = HubSync.getServerNow();
    const endTime = durationMins > 0 ? now + durationMins * 60 * 1000 : null;

    await HubSync.updateSession({
      sessionId: 'ses_' + Date.now(),
      status: 'writing',
      topic: topic,
      genre: genre,
      instructions: instructions,
      durationMinutes: durationMins,
      wordLimit: wordLimit,
      startedAt: now,
      endTime: endTime
    });

    closeSetupModal();
    showToast('Writing session started! Students can now write.');
  }

  async function stopWritingAndBroadcast() {
    await HubSync.updateSession({
      status: 'modelling',
      endTime: null
    });
    if (selectedStudentId) {
      await broadcastCurrentModel(null);
    }
    showToast('Writing closed. All student screens now mirror your Review Studio.');
  }

  function openInviteModal() {
    const syncInfo = HubSync.getState();
    el['invite-room-code'].textContent = syncInfo.roomId;

    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('room', syncInfo.roomId);
    url.searchParams.set('role', 'student');
    if (syncInfo.mode === 'local') {
      url.searchParams.set('db', 'LOCAL_SANDBOX');
      el['invite-mode-warning'].classList.remove('hidden');
    } else {
      url.searchParams.set('db', syncInfo.dbUrl);
      el['invite-mode-warning'].classList.add('hidden');
    }

    const inviteLink = url.toString();
    el['invite-url-input'].value = inviteLink;

    const qrBox = el['invite-qr-box'];
    qrBox.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
      new QRCode(qrBox, {
        text: inviteLink,
        width: 180,
        height: 180,
        colorDark: '#002147',
        colorLight: '#ffffff'
      });
    } else {
      qrBox.textContent = 'Share the link below with students';
    }

    el['modal-invite'].classList.remove('hidden');
  }

  async function archiveCurrentSession() {
    const subsArray = Object.values(submissionsMap || {}).filter(function (s) { return s && s.studentId; });
    const record = {
      id: 'arc_' + Date.now(),
      archivedAt: Date.now(),
      roomId: HubSync.getState().roomId,
      lessonTitle: (sessionState && sessionState.lessonTitle) || el['admin-lesson-badge'].textContent,
      topic: (sessionState && sessionState.topic) || 'Untitled Session',
      genre: (sessionState && sessionState.genre) || '',
      wordLimit: (sessionState && sessionState.wordLimit) || 0,
      instructions: (sessionState && sessionState.instructions) || '',
      submissions: subsArray
    };

    await ArchiveDB.save(record);
    showToast('Session archived locally (' + subsArray.length + ' writings saved).');

    if (confirm('Session archived! Would you like to reset the room to Lobby for a new session?')) {
      await HubSync.clearSubmissionsAndModel();
      await HubSync.updateSession({ status: 'lobby', endTime: null });
      selectedStudentId = null;
      el['admin-modelling-panel'].classList.add('hidden');
      el['admin-empty-canvas'].classList.remove('hidden');
    }
  }

  async function openArchivesModal() {
    const list = await ArchiveDB.getAll();
    const container = el['archives-list'];

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-hint">No archived sessions yet. Click <strong>Archive</strong> in the top bar after any writing session.</div>';
    } else {
      container.innerHTML = '';
      list.forEach(function (arc) {
        const modelledCount = (arc.submissions || []).filter(function (s) { return s.model && s.model.modelHtml; }).length;
        const dateStr = new Date(arc.archivedAt).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        const row = document.createElement('div');
        row.className = 'archive-item';
        row.innerHTML = '' +
          '<div>' +
            '<div class="archive-item-title">' + escapeHtml(arc.topic) + '</div>' +
            '<div class="archive-item-meta">' +
              escapeHtml(arc.lessonTitle) + ' &bull; ' + dateStr +
              ' &bull; ' + (arc.submissions || []).length + ' drafts (' + modelledCount + ' reviewed)' +
            '</div>' +
          '</div>' +
          '<div class="archive-item-actions">' +
            '<button type="button" class="btn btn-primary btn-xs" data-act="handout">Printable Handout</button>' +
            '<button type="button" class="btn btn-secondary btn-xs" data-act="json">JSON</button>' +
            '<button type="button" class="btn btn-secondary btn-xs" data-act="delete">Delete</button>' +
          '</div>';

        row.querySelector('[data-act="handout"]').addEventListener('click', function () {
          exportPrintableHandout(arc);
        });
        row.querySelector('[data-act="json"]').addEventListener('click', function () {
          downloadJsonFile(arc, 'writing-session-' + arc.id + '.json');
        });
        row.querySelector('[data-act="delete"]').addEventListener('click', async function () {
          if (!confirm('Delete this archived session permanently?')) return;
          await ArchiveDB.remove(arc.id);
          openArchivesModal();
        });

        container.appendChild(row);
      });
    }

    el['modal-archives'].classList.remove('hidden');
  }

  function downloadJsonFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportAllArchivesJson() {
    const all = await ArchiveDB.getAll();
    downloadJsonFile(all, 'writing-hub-archives-backup.json');
  }

  function handleImportArchivesJson(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function () {
      try {
        const parsed = JSON.parse(reader.result);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] && arr[i].id) await ArchiveDB.save(arr[i]);
        }
        showToast('Imported ' + arr.length + ' archived session(s).');
        openArchivesModal();
      } catch (_) {
        alert('Invalid JSON archive file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function exportPrintableHandout(arc) {
    const modelledSubs = (arc.submissions || []).filter(function (s) { return s.model && s.model.modelHtml; });
    const targetSubs = modelledSubs.length > 0 ? modelledSubs : (arc.submissions || []);

    const sectionsHtml = targetSubs.map(function (s) {
      const comments = (s.model && s.model.comments) || [];
      const commentsHtml = comments.length > 0
        ? '<h4>Review Commentary</h4><ol>' + comments.map(function (c) {
          return '<li><strong>[' + escapeHtml(c.tag) + ']</strong> ' +
            (c.quote ? '<em>&ldquo;' + escapeHtml(c.quote) + '&rdquo;</em> &mdash; ' : '') +
            escapeHtml(c.text) + '</li>';
        }).join('') + '</ol>'
        : '';

      return '' +
        '<section class="model-block">' +
          '<h3>' + escapeHtml(s.pseudonym || 'Anonymous Draft') + '</h3>' +
          '<div class="prose-box">' + HubEditor.sanitiseHtml((s.model && s.model.modelHtml) || s.originalHtml || '') + '</div>' +
          commentsHtml +
        '</section>';
    }).join('');

    const docHtml = '<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8">' +
      '<title>' + escapeHtml(arc.topic) + ' — Tracked Review Handout</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Alegreya:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">' +
      '<style>' +
        'body{font-family:Alegreya,Georgia,serif;color:#1f2933;max-width:820px;margin:2rem auto;padding:0 1.5rem;line-height:1.68;font-size:12pt;}' +
        'header{border-bottom:2px solid #002147;padding-bottom:0.8rem;margin-bottom:1.5rem;}' +
        'h1,h2,h3,h4{color:#002147;margin-bottom:0.4rem;}' +
        '.prompt-box{background:#f8fafc;border-left:4px solid #002147;padding:0.8rem 1rem;margin-bottom:1.8rem;}' +
        '.model-block{margin-bottom:2.2rem;page-break-inside:avoid;border-top:1px solid #d9e2ec;padding-top:1rem;}' +
        'ins.rev-ins{background:#d1fae5;color:#065f46;text-decoration:none;border-bottom:1.5px solid #059669;padding:0 2px;}' +
        'del.rev-del{background:#fee2e2;color:#991b1b;text-decoration:line-through;padding:0 2px;}' +
        'mark.rev-hl{background:#fef08a;padding:0 2px;}' +
        'table{width:100%;border-collapse:collapse;margin:0.8rem 0;}th,td{border:1px solid #94a3b8;padding:6px 8px;text-align:left;}' +
      '</style></head><body>' +
      '<header><h1>' + escapeHtml(arc.topic) + '</h1>' +
      '<div><strong>Lesson:</strong> ' + escapeHtml(arc.lessonTitle) + ' &bull; <strong>Genre:</strong> ' + escapeHtml(arc.genre) + '</div></header>' +
      (arc.instructions ? '<div class="prompt-box"><strong>Task Criteria:</strong><br>' + escapeHtml(arc.instructions) + '</div>' : '') +
      sectionsHtml +
      '<script>window.onload=function(){window.print();};<\/script></body></html>';

    const win = window.open('', '_blank');
    if (win) {
      win.document.open();
      win.document.write(docHtml);
      win.document.close();
    }
  }

  function checkUrlAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const dbParam = params.get('db');
    const roleParam = params.get('role');

    if (roomParam) {
      el['student-room-input'].value = roomParam;
    }
    if (dbParam) {
      el['student-db-input'].value = dbParam;
      el['student-db-wrapper'].classList.add('hidden');
    }

    if (roomParam && dbParam && roleParam === 'student') {
      const mode = dbParam === 'LOCAL_SANDBOX' ? 'local' : 'firebase';
      startStudentConnection(mode, dbParam, roomParam);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    cacheDom();
    setupGatewayEvents();
    setupStudentEvents();
    setupAdminEvents();
    checkUrlAutoJoin();
  });
})();