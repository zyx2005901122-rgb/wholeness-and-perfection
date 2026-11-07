'use strict';

const {TOTAL_FRAMES, FRAMES_PER_TURN, FPS, parseArduinoData, createLineDecoder, frameTime, RotationLedger} = window.BloomCore;
const DEBUG = new URLSearchParams(location.search).has('debug');
const state = {
  phase: 'landing', demo: false, demoCounter: 0, ledger: new RotationLedger(),
  session: null, connecting: false, sensor: null, status: 'disconnected',
  timers: [], transitionId: 0, noticeTimer: 0, mediaReady: false, mediaFailed: false,
  triedMP4: false, frame: 0, pendingSeek: null, seekEpoch: 0, needsRewind: true,
  nextFrameAt: 0, hasRotated: false,
};
const ui = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), el => [el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), el]));
ui.video = ui.artVideo;
function debugLog(...args) { if (DEBUG) console.debug('[BLOOM]', ...args); }
function later(callback, delay) { state.timers.push(setTimeout(callback, delay)); }
function clearTransitions() { state.transitionId++; state.timers.forEach(clearTimeout); state.timers = []; }
function setPhase(phase) { state.phase = phase; ui.installation.dataset.phase = phase; }
function showNotice(message, persistent = false) {
  clearTimeout(state.noticeTimer);
  ui.noticeText.textContent = message;
  ui.notice.hidden = !message;
  if (message && !persistent) state.noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 8000);
}
function seedCounter() {
  state.ledger.rebase();
  if (state.demo) state.ledger.ingest(state.demoCounter, false);
  else if (state.sensor && performance.now() - state.sensor.receivedAt < 3500) state.ledger.ingest(state.sensor.rotations, false);
}
function resetGrowth() {
  state.ledger.reset();
  seedCounter();
  state.seekEpoch++;
  state.needsRewind = true;
  state.frame = 0;
  state.hasRotated = false;
  ui.video.pause();
  updateDataDisplay();
}
async function resetExperience() {
  clearTransitions();
  const id = state.transitionId;
  if (ui.settingsDialog.open) ui.settingsDialog.close();
  resetGrowth();
  setPhase('landing');
  ui.instruction.hidden = true;
  ui.instruction.classList.remove('leaving');
  ui.experience.hidden = true;
  ui.experience.inert = true;
  ui.landing.hidden = false;
  ui.landing.inert = false;
  ui.landing.className = 'landing';
  ui.enterButton.disabled = true;
  // Wait for both real PNGs to decode before beginning the ordered entrance.
  await Promise.allSettled([ui.flowerLarge.decode(), ui.flowerSmall.decode()]);
  if (id !== state.transitionId) return;
  requestAnimationFrame(() => {
    if (id !== state.transitionId) return;
    ui.landing.classList.add('show-large');
    later(() => ui.landing.classList.add('show-small'), 1150);
    later(() => ui.landing.classList.add('show-copy'), 2300);
    later(() => { ui.landing.classList.add('show-enter'); ui.enterButton.disabled = false; }, 3350);
  });
}
function showGuide() {
  clearTransitions();
  setPhase('guide');
  ui.experience.hidden = false;
  ui.experience.inert = true;
  ui.instruction.hidden = false;
  ui.instruction.classList.remove('leaving');
  ui.landing.classList.add('leaving');
  ui.landing.inert = true;
  later(() => { ui.landing.hidden = true; }, 650);
  // The English instruction stays for three seconds, then the glass dissolves.
  later(() => ui.instruction.classList.add('leaving'), 3000);
  later(() => {
    ui.instruction.hidden = true;
    ui.experience.inert = false;
    seedCounter(); // Do not charge for turning during the instructions.
    setPhase('experience');
    ui.guideButton.focus({preventScroll:true});
  }, 3600);
}
function enterExperience() { if (state.phase === 'landing' && !ui.enterButton.disabled) showGuide(); }
function canGrow() { return state.phase === 'experience' && !ui.settingsDialog.open && !document.hidden && state.mediaReady && !state.mediaFailed; }

/** Shared route for real serial packets and demo packets. RPM is diagnostic only. */
function updateRPM(rpm, rotations, source = 'sensor') {
  if (source !== (state.demo ? 'demo' : 'sensor')) return;
  const previous = state.ledger.last;
  const delta = state.ledger.ingest(rotations, canGrow());
  if (previous !== null && rotations < previous && source === 'sensor') showNotice('Arduino counter restarted. Your current bloom has been preserved.');
  if (delta > 0) state.hasRotated = true;
  updateDataDisplay();
  debugLog(`RPM: ${rpm}; counter: ${rotations}; round turns: ${state.ledger.turns}; target frame: ${state.ledger.targetFrame + 1}`);
}
function enableDemoMode(enabled = true) {
  if (state.demo === Boolean(enabled)) return;
  state.demo = Boolean(enabled);
  ui.demoButton.setAttribute('aria-pressed', String(state.demo));
  ui.demoButton.textContent = state.demo ? 'On' : 'Off';
  ui.demoControls.hidden = !state.demo;
  ui.inputSource.textContent = state.demo ? 'DEMO' : 'LIVE SENSOR';
  resetGrowth(); // Avoid mixing simulated turns with physical turns.
  debugLog('Input source', state.demo ? 'demo' : 'sensor');
}
function addDemoTurns(turns) {
  if (!state.demo || !canGrow()) return;
  state.demoCounter += turns;
  updateRPM(0, state.demoCounter, 'demo');
}

/** Advance credited frames one at a time. Seeking never creates unearned motion.
 *  Every intermediate frame gets a minimum 1/24 second dwell; no video.play().
 *  An epoch invalidates pending seeks after reset, source changes or media fallback.
 */
function updateVideoPlayback(now) {
  if (state.mediaReady && !state.mediaFailed && !state.pendingSeek && !ui.video.seeking) {
    const next = state.needsRewind ? 0 : canGrow() && now >= state.nextFrameAt && state.frame < state.ledger.targetFrame ? state.frame + 1 : null;
    if (next !== null) {
      const time = frameTime(next);
      if (Math.abs(ui.video.currentTime - time) < .0001) {
        state.frame = next;
        state.needsRewind = false;
        state.nextFrameAt = now + 1000 / FPS;
        updateDataDisplay();
      } else {
        state.pendingSeek = {frame:next, epoch:state.seekEpoch, at:now};
        ui.video.currentTime = time;
      }
    }
  }
  if (state.pendingSeek && now - state.pendingSeek.at > 8000) handleMediaError();
  requestAnimationFrame(updateVideoPlayback);
}
function onSeeked() {
  const pending = state.pendingSeek;
  state.pendingSeek = null;
  if (!pending || pending.epoch !== state.seekEpoch) return;
  state.frame = pending.frame;
  state.needsRewind = false;
  state.nextFrameAt = performance.now() + 1000 / FPS;
  updateDataDisplay();
}
function updateDataDisplay() {
  const complete = state.frame === TOTAL_FRAMES - 1 && state.ledger.complete;
  // The first frame is a still preview. The final credit clamps at frame 322.
  const revealed = complete ? TOTAL_FRAMES : state.frame;
  const percent = revealed / TOTAL_FRAMES * 100;
  ui.turnsValue.textContent = String(state.ledger.turns);
  ui.progressValue.textContent = `${complete ? '100' : percent === 0 ? '0' : percent.toFixed(1)}%`;
  ui.progressFill.style.width = `${percent}%`;
  ui.growthProgress.setAttribute('aria-valuenow', percent.toFixed(1));
  ui.installation.dataset.frame = String(state.frame + 1);
}
function handleMediaError() {
  state.mediaReady = false;
  state.pendingSeek = null;
  state.seekEpoch++;
  state.needsRewind = true;
  if (!state.triedMP4) {
    state.triedMP4 = true;
    // MOV is retained. See README for H.264 conversion if the MOV codec changes.
    ui.video.src = 'assets/video/0001-0322.mp4';
    ui.video.load();
    debugLog('Trying H.264 MP4 fallback');
  } else {
    state.mediaFailed = true;
    ui.filmMessage.hidden = false;
    ui.filmMessage.textContent = 'The film could not be loaded. Check assets/video/0001-0322.mov and its MP4 copy, then reload.';
    showNotice('Film unavailable. Wheel input is paused until the video can be loaded.', true);
  }
  updateDataDisplay();
}
function setArduinoStatus(status) {
  state.status = status;
  ui.connectionButton.dataset.status = status;
  ui.dialogStatusDot.dataset.status = status;
  const labels = {connected:'Arduino Connected', disconnected:'Connect Arduino', connecting:'Connecting…', waiting:'Checking Arduino', stale:'No Sensor Data', error:'Arduino Error'};
  ui.connectionLabel.textContent = labels[status];
  ui.statusText.textContent = status === 'stale' ? 'Port open · no valid data' : `Arduino ${status}`;
  ui.connectButton.textContent = state.session ? 'Disconnect Arduino' : status === 'connecting' ? 'Connecting…' : 'Connect Arduino ↗';
  ui.baudRate.disabled = Boolean(state.session || state.connecting);
  debugLog('Arduino', status);
}
async function connectArduino() {
  if (state.connecting) return;
  if (state.session) { await closeArduino(state.session); return; }
  if (!window.isSecureContext || !navigator.serial) {
    showNotice('Connect Arduino using Chrome or Edge on this HTTPS website. Demo mode is available in this browser.', true);
    ui.sensorReadout.textContent = 'Web Serial unavailable here. Open this website directly in Chrome or Edge.';
    return;
  }
  state.connecting = true;
  ui.connectButton.disabled = true;
  setArduinoStatus('connecting');
  let port;
  try {
    port = await navigator.serial.requestPort();
    await port.open({baudRate:Number(ui.baudRate.value), bufferSize:4096});
    const session = {port, reader:null, readTask:null, closeTask:null, closing:false, connectedAt:performance.now(), warningShown:false, invalidCount:0};
    state.session = session;
    state.sensor = null;
    enableDemoMode(false);
    state.ledger.rebase();
    setArduinoStatus('waiting');
    ui.settingsDialog.close();
    showNotice('Arduino connected. Waiting for the first sensor packet.');
    session.readTask = readSerialData(session);
    session.readTask.then(() => {
      if (!session.closing && state.session === session) closeArduino(session, 'error', 'Serial data stopped. Reconnect Arduino to continue.');
    });
  } catch (error) {
    if (port?.readable) { try { await port.close(); } catch (closeError) { debugLog(closeError); } }
    if (error.name === 'NotFoundError') setArduinoStatus('disconnected');
    else {
      setArduinoStatus('error');
      const message = 'Could not open Arduino. Close Serial Monitor / Plotter, check the USB cable and baud rate, then reconnect.';
      showNotice(message, true);
      ui.sensorReadout.textContent = message;
      debugLog(error);
    }
  } finally {
    state.connecting = false;
    ui.connectButton.disabled = false;
    ui.baudRate.disabled = Boolean(state.session);
  }
}
async function readSerialData(session) {
  const decoder = new TextDecoder();
  const lines = createLineDecoder(line => {
    if (session.closing || state.session !== session) return;
    const packet = parseArduinoData(line);
    if (!packet) { session.invalidCount++; debugLog('Invalid serial line', line); return; }
    state.sensor = {...packet, receivedAt:performance.now()};
    ui.sensorReadout.textContent = `RPM ${packet.rpm.toFixed(1)} · Board rotations ${packet.rotations} · ${ui.baudRate.value} baud`;
    if (state.status === 'waiting') { setArduinoStatus('connected'); showNotice('Arduino connected. Sensor data received.'); }
    if (session.warningShown) {
      session.warningShown = false;
      if (!state.demo) state.ledger.rebase(); // Ignore unknown movement during missing data.
      setArduinoStatus('connected');
      showNotice('Sensor data restored.');
    }
    updateRPM(packet.rpm, packet.rotations, 'sensor');
  });
  let recoveries = 0;
  while (session.port.readable && !session.closing) {
    try {
      session.reader = session.port.readable.getReader();
      while (!session.closing) {
        const {value, done} = await session.reader.read();
        if (done) return;
        if (value) lines.push(decoder.decode(value, {stream:true}));
      }
    } catch (error) {
      debugLog('Serial read error', error);
      lines.reset();
      decoder.decode();
      if (session.closing || !session.port.readable || ++recoveries > 3) return;
    } finally {
      session.reader?.releaseLock();
      session.reader = null;
    }
  }
}
function closeArduino(session, status = 'disconnected', message = '') {
  if (session.closeTask) return session.closeTask;
  session.closing = true;
  ui.connectButton.disabled = true;
  session.closeTask = (async () => {
    try {
      try { await session.reader?.cancel(); } catch (error) { debugLog(error); }
      await session.readTask;
      try { await session.port.close(); } catch (error) { debugLog(error); }
    } finally {
      if (state.session === session) {
        state.session = null;
        state.sensor = null;
        if (!state.demo) state.ledger.rebase();
        setArduinoStatus(status);
        ui.connectButton.disabled = false;
        ui.sensorReadout.textContent = message || 'Serial port closed.';
        showNotice(message, Boolean(message));
      }
    }
  })();
  return session.closeTask;
}
function checkSensorHealth() {
  const session = state.session;
  if (!session || session.closing) return;
  const lastValid = state.sensor?.receivedAt ?? session.connectedAt;
  if (performance.now() - lastValid > 3500 && !session.warningShown) {
    session.warningShown = true;
    setArduinoStatus('stale');
    const message = 'No valid sensor data for 3.5 seconds. Check the USB cable, 9600 baud and the D2 sketch. A stationary wheel should still send data.';
    showNotice(message, true);
    ui.sensorReadout.textContent = message;
  }
}
function openSettings() { ui.settingsDialog.showModal(); }
function initialize() {
  ui.video.autoplay = false;
  ui.video.controls = false;
  ui.video.loop = false;
  ui.video.muted = true;
  ui.video.pause();
  ui.enterButton.addEventListener('click', enterExperience);
  ui.resetButton.addEventListener('click', resetGrowth);
  ui.homeButton.addEventListener('click', resetExperience);
  ui.guideButton.addEventListener('click', showGuide);
  ui.settingsButton.addEventListener('click', openSettings);
  ui.connectionButton.addEventListener('click', openSettings);
  ui.settingsClose.addEventListener('click', () => ui.settingsDialog.close());
  ui.settingsDialog.addEventListener('close', seedCounter);
  ui.connectButton.addEventListener('click', connectArduino);
  ui.demoButton.addEventListener('click', () => enableDemoMode(!state.demo));
  ui.demoOne.addEventListener('click', () => addDemoTurns(1));
  ui.demoTen.addEventListener('click', () => addDemoTurns(10));
  ui.noticeClose.addEventListener('click', () => { ui.notice.hidden = true; });
  ui.fullscreenButton.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      ui.fullscreenButton.textContent = document.fullscreenElement ? 'Exit full screen ↙' : 'Enter full screen ↗';
    } catch { ui.sensorReadout.textContent = 'Full screen is unavailable here. Use your browser’s View menu.'; }
  });
  document.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.target.matches('input,select,textarea,[contenteditable="true"]')) return;
    if (state.demo && canGrow() && (event.key === 'ArrowUp' || event.key === 'ArrowRight')) { event.preventDefault(); addDemoTurns(1); }
  });
  document.addEventListener('visibilitychange', seedCounter);
  ui.video.addEventListener('seeked', onSeeked);
  ui.video.addEventListener('error', handleMediaError);
  const onMediaReady = () => {
    state.mediaReady = true;
    state.mediaFailed = false;
    ui.filmMessage.hidden = true;
    ui.video.pause();
    if (Math.abs(ui.video.duration - TOTAL_FRAMES / FPS) > .1) showNotice('Video duration differs from the 322-frame, 24 fps calibration. Check the source film.', true);
    updateDataDisplay();
  };
  ui.video.addEventListener('loadeddata', onMediaReady);
  if (ui.video.readyState >= 2) onMediaReady();
  navigator.serial?.addEventListener('disconnect', event => {
    const session = state.session;
    if (session && (event.target === session.port || event.port === session.port)) closeArduino(session, 'error', 'Arduino disconnected. Reconnect the USB cable and select Connect Arduino.');
  });
  setInterval(checkSensorHealth, 250);
  setArduinoStatus('disconnected');
  if (new URLSearchParams(location.search).get('view') === 'experience') {
    ui.landing.hidden = true;
    ui.landing.inert = true;
    ui.experience.hidden = false;
    ui.experience.inert = false;
    setPhase('experience');
    resetGrowth();
  } else resetExperience();
  requestAnimationFrame(updateVideoPlayback);
}
initialize();
