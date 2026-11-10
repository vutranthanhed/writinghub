/**
 * sync.js
 * Dual-mode real-time transport layer for Academic Writing Hub:
 * 1. Firebase Realtime Database (cross-network Wi-Fi & 4G/5G mobile data)
 * 2. Local Browser Sandbox via BroadcastChannel + localStorage (instant offline testing)
 */
(function (global) {
  'use strict';

  let currentMode = null;
  let activeRoomId = null;
  let activeDbUrl = '';
  let serverTimeOffset = 0;

  // Firebase state
  let fbApp = null;
  let fbDb = null;
  let fbListeners = [];

  // Local Sandbox state
  let bcChannel = null;
  let storageListener = null;

  let callbacks = {
    onConnectionChange: function () {},
    onSessionChange: function () {},
    onSubmissionsChange: function () {},
    onLiveModelChange: function () {}
  };

  function normaliseDbUrl(rawUrl) {
    if (!rawUrl) return '';
    let trimmed = rawUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    return trimmed;
  }

  function sanitiseRoomKey(roomCode) {
    return String(roomCode || '')
      .trim()
      .toUpperCase()
      .replace(/[.#$\[\]\/\s]+/g, '-');
  }

  function getLocalRoomKey(roomId) {
    return 'wh_sandbox_room_' + roomId;
  }

  function readLocalRoom(roomId) {
    try {
      const raw = localStorage.getItem(getLocalRoomKey(roomId));
      return raw ? JSON.parse(raw) : { meta: null, session: null, submissions: {}, liveModel: null };
    } catch (_) {
      return { meta: null, session: null, submissions: {}, liveModel: null };
    }
  }

  function writeLocalRoom(roomId, data, broadcastType) {
    localStorage.setItem(getLocalRoomKey(roomId), JSON.stringify(data));
    if (bcChannel) {
      bcChannel.postMessage({ type: broadcastType || 'sync', roomId: roomId });
    }
  }

  function emitLocalAll() {
    if (!activeRoomId) return;
    const state = readLocalRoom(activeRoomId);
    callbacks.onSessionChange(state.session || null);
    callbacks.onSubmissionsChange(state.submissions || {});
    callbacks.onLiveModelChange(state.liveModel || null);
  }

  function disconnect() {
    // Detach Firebase listeners
    fbListeners.forEach(function (entry) {
      try {
        entry.ref.off(entry.event, entry.fn);
      } catch (_) {}
    });
    fbListeners = [];

    if (bcChannel) {
      bcChannel.close();
      bcChannel = null;
    }
    if (storageListener) {
      window.removeEventListener('storage', storageListener);
      storageListener = null;
    }
    serverTimeOffset = 0;
  }

  async function init(options) {
    disconnect();

    currentMode = options.mode || 'firebase';
    activeRoomId = sanitiseRoomKey(options.roomId);
    activeDbUrl = normaliseDbUrl(options.dbUrl || '');

    callbacks.onConnectionChange = options.onConnectionChange || function () {};
    callbacks.onSessionChange = options.onSessionChange || function () {};
    callbacks.onSubmissionsChange = options.onSubmissionsChange || function () {};
    callbacks.onLiveModelChange = options.onLiveModelChange || function () {};

    if (!activeRoomId) {
      throw new Error('Please enter a valid Room Code.');
    }

    if (currentMode === 'local') {
      if (typeof BroadcastChannel !== 'undefined') {
        bcChannel = new BroadcastChannel('wh_channel_' + activeRoomId);
        bcChannel.onmessage = function () {
          emitLocalAll();
        };
      }
      storageListener = function (e) {
        if (e.key === getLocalRoomKey(activeRoomId)) {
          emitLocalAll();
        }
      };
      window.addEventListener('storage', storageListener);
      callbacks.onConnectionChange(true);
      emitLocalAll();
      return;
    }

    // Cloud Mode: Firebase Realtime Database
    if (!activeDbUrl || !activeDbUrl.includes('firebase')) {
      throw new Error('Please provide a valid Firebase Realtime Database URL (ending in firebasedatabase.app or firebaseio.com).');
    }
    if (typeof firebase === 'undefined') {
      throw new Error('Firebase SDK could not be loaded. Check your internet connection or test using Local Browser Sandbox.');
    }

    const appName = 'whApp_' + btoa(activeDbUrl).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const existing = firebase.apps.find(function (a) { return a.name === appName; });
    fbApp = existing || firebase.initializeApp({ databaseURL: activeDbUrl }, appName);
    fbDb = fbApp.database();

    // Track connection status and server clock offset so timers match across all phones/laptops
    const connRef = fbDb.ref('.info/connected');
    const connFn = connRef.on('value', function (snap) {
      callbacks.onConnectionChange(Boolean(snap.val()));
    });
    fbListeners.push({ ref: connRef, event: 'value', fn: connFn });

    const offsetRef = fbDb.ref('.info/serverTimeOffset');
    const offsetFn = offsetRef.on('value', function (snap) {
      serverTimeOffset = Number(snap.val() || 0);
    });
    fbListeners.push({ ref: offsetRef, event: 'value', fn: offsetFn });

    const basePath = 'rooms/' + activeRoomId;

    const sessionRef = fbDb.ref(basePath + '/session');
    const sessionFn = sessionRef.on('value', function (snap) {
      callbacks.onSessionChange(snap.val() || null);
    });
    fbListeners.push({ ref: sessionRef, event: 'value', fn: sessionFn });

    const subsRef = fbDb.ref(basePath + '/submissions');
    const subsFn = subsRef.on('value', function (snap) {
      callbacks.onSubmissionsChange(snap.val() || {});
    });
    fbListeners.push({ ref: subsRef, event: 'value', fn: subsFn });

    const modelRef = fbDb.ref(basePath + '/liveModel');
    const modelFn = modelRef.on('value', function (snap) {
      callbacks.onLiveModelChange(snap.val() || null);
    });
    fbListeners.push({ ref: modelRef, event: 'value', fn: modelFn });
  }

  function getServerNow() {
    return Date.now() + serverTimeOffset;
  }

  async function getRoomMetaOnce() {
    if (currentMode === 'local') {
      return readLocalRoom(activeRoomId).meta || null;
    }
    const snap = await fbDb.ref('rooms/' + activeRoomId + '/meta').once('value');
    return snap.val() || null;
  }

  async function saveRoomMeta(meta) {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      state.meta = meta;
      writeLocalRoom(activeRoomId, state, 'meta');
      return;
    }
    await fbDb.ref('rooms/' + activeRoomId + '/meta').set(meta);
  }

  async function updateSession(sessionPatch) {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      state.session = Object.assign({}, state.session || {}, sessionPatch);
      writeLocalRoom(activeRoomId, state, 'session');
      emitLocalAll();
      return;
    }
    await fbDb.ref('rooms/' + activeRoomId + '/session').update(sessionPatch);
  }

  async function clearSubmissionsAndModel() {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      state.submissions = {};
      state.liveModel = null;
      writeLocalRoom(activeRoomId, state, 'clear');
      emitLocalAll();
      return;
    }
    await Promise.all([
      fbDb.ref('rooms/' + activeRoomId + '/submissions').remove(),
      fbDb.ref('rooms/' + activeRoomId + '/liveModel').remove()
    ]);
  }

  async function upsertSubmission(studentId, payload) {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      state.submissions = state.submissions || {};
      state.submissions[studentId] = Object.assign({}, state.submissions[studentId] || {}, payload);
      writeLocalRoom(activeRoomId, state, 'submission');
      emitLocalAll();
      return;
    }
    await fbDb.ref('rooms/' + activeRoomId + '/submissions/' + studentId).update(payload);
  }

  async function saveSubmissionModel(studentId, modelRecord) {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      if (state.submissions && state.submissions[studentId]) {
        state.submissions[studentId].model = modelRecord;
        writeLocalRoom(activeRoomId, state, 'modelSave');
        emitLocalAll();
      }
      return;
    }
    await fbDb.ref('rooms/' + activeRoomId + '/submissions/' + studentId + '/model').set(modelRecord);
  }

  async function broadcastLiveModel(liveModelObj) {
    if (currentMode === 'local') {
      const state = readLocalRoom(activeRoomId);
      state.liveModel = liveModelObj;
      writeLocalRoom(activeRoomId, state, 'liveModel');
      emitLocalAll();
      return;
    }
    await fbDb.ref('rooms/' + activeRoomId + '/liveModel').set(liveModelObj);
  }

  global.HubSync = {
    init: init,
    disconnect: disconnect,
    getServerNow: getServerNow,
    getRoomMetaOnce: getRoomMetaOnce,
    saveRoomMeta: saveRoomMeta,
    updateSession: updateSession,
    clearSubmissionsAndModel: clearSubmissionsAndModel,
    upsertSubmission: upsertSubmission,
    saveSubmissionModel: saveSubmissionModel,
    broadcastLiveModel: broadcastLiveModel,
    normaliseDbUrl: normaliseDbUrl,
    sanitiseRoomKey: sanitiseRoomKey,
    getState: function () {
      return { mode: currentMode, roomId: activeRoomId, dbUrl: activeDbUrl };
    }
  };
})(window);