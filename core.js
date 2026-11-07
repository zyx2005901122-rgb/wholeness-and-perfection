/* Shared serial protocol and discrete growth model. No browser dependencies. */
(function (root) {
  'use strict';
  const TOTAL_FRAMES = 322;
  const FRAMES_PER_TURN = 2;
  const MAX_TURNS = Math.ceil(TOTAL_FRAMES / FRAMES_PER_TURN);
  const FPS = 24;
  function parseArduinoData(line) {
    if (typeof line !== 'string' || line.length > 256) return null;
    const match = /^\s*RPM:\s*(\d+(?:\.\d+)?)\s*,\s*ROTATIONS:\s*(\d+)\s*$/i.exec(line);
    if (!match) return null;
    const rpm = Number(match[1]), rotations = Number(match[2]);
    return Number.isFinite(rpm) && rpm <= 10000 && Number.isSafeInteger(rotations) ? {rpm, rotations} : null;
  }
  function createLineDecoder(onLine) {
    let pending = '', dropping = false;
    return {
      push(chunk) {
        for (const char of chunk) {
          if (char === '\n') {
            if (!dropping && pending.trim()) onLine(pending.replace(/\r$/, ''));
            pending = ''; dropping = false;
          } else if (!dropping) {
            pending += char;
            if (pending.length > 256) { pending = ''; dropping = true; }
          }
        }
      },
      reset() { pending = ''; dropping = false; },
    };
  }
  function frameForTurns(turns) {
    return Math.min(TOTAL_FRAMES - 1, Math.max(0, Math.floor(turns)) * FRAMES_PER_TURN);
  }
  function frameTime(frame) {
    // Seek inside the frame interval, avoiding rounding onto its predecessor.
    return (Math.min(321, Math.max(0, frame)) + .25) / FPS;
  }
  class RotationLedger {
    constructor() { this.turns = 0; this.last = null; }
    rebase() { this.last = null; }
    reset() { this.turns = 0; this.rebase(); }
    ingest(counter, active) {
      if (!Number.isSafeInteger(counter) || counter < 0) return 0;
      const previous = this.last;
      this.last = counter;
      if (!active || previous === null || counter < previous) return 0;
      const delta = Math.min(MAX_TURNS - this.turns, counter - previous);
      this.turns += delta;
      return delta;
    }
    get targetFrame() { return frameForTurns(this.turns); }
    get complete() { return this.turns * FRAMES_PER_TURN >= TOTAL_FRAMES; }
  }
  const api = {TOTAL_FRAMES, FRAMES_PER_TURN, MAX_TURNS, FPS, parseArduinoData, createLineDecoder, frameForTurns, frameTime, RotationLedger};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BloomCore = api;
})(typeof window === 'undefined' ? globalThis : window);
