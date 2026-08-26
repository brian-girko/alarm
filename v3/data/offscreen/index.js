'use strict';

// single-slot player: a new play request replaces the previous one
let player = null;

const stop = () => {
  if (player) {
    player.pause();
    player.currentTime = 0;
    player = null;
  }
};

chrome.runtime.onMessage.addListener((request, sender, respose) => {
  // ignore messages targeted at other contexts (notify windows, worker);
  // never respond to them so we don't steal their sendResponse channels
  if (request.target !== 'offscreen') {
    return;
  }

  if (request.method === 'play-audio') {
    stop();
    const volume = Number(request.volume);
    const repeats = Number(request.repeats);
    if (!volume || !request.src) {
      return respose(false);
    }

    const e = new Audio();
    e.volume = volume;
    let n = Number.isFinite(repeats) && repeats > 0 ? repeats : 1;
    e.addEventListener('ended', function() {
      n -= 1;
      if (n > 0 && player === e) {
        e.currentTime = 0;
        e.play().catch(() => {});
      }
      else {
        stop();
      }
    }, false);
    e.addEventListener('error', () => {
      if (player === e) {
        stop();
      }
    });
    player = e;
    e.src = '/' + request.src;
    e.play().then(() => respose(true)).catch(err => {
      console.warn('offscreen playback failed', err);
      respose(false);
    });
    return true;
  }
  else if (request.method === 'stop-audio') {
    stop();
  }
});
