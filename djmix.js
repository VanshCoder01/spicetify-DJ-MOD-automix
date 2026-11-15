// NAME: DJ Mix
// DESCRIPTION: Real DJ transitions in Spotify. Uses Spotify's own (hidden) automix engine to overlap the end of one
//              song with the next, beat-matched and tempo-synced, like Apple Music's AutoMix.
// VERSION: 0.3.0
//
// How it works
//   Spotify ships a native transition engine for its playlist "Mix" feature. Its editor can preview a transition between
//   any two tracks via the player signal "automix-preview". DJ Mix asks Spotify's server for the best transition between
//   the current and next track (PlaylistMixingAPI.getAutoTransitionForTrackPair) and fires that preview just before the
//   mix point, rewritten so the outgoing song keeps playing from exactly where it is.
//
//   Once the first mix fires, the player sits in Spotify's "automix" mode. DJ Mix stays there and chains every following
//   transition (no restarts = no stutter), following a snapshot of your up-next list. It only hands playback back to your
//   normal context when you seek / skip, or when a song has no transition (then exactly at the song boundary).

(function djmix() {
  const S = window.Spicetify;
  const P = S?.Platform;
  if (!S?.Playbar?.Button || !S?.PopupModal || !S?.LocalStorage || !P?.PlayerAPI || !P?.PlaylistMixingAPI) {
    setTimeout(djmix, 300);
    return;
  }

  const A = P.PlayerAPI;
  const M = P.PlaylistMixingAPI;
  const previewPlayer = M._transitionAPI?._previewPlayer;
  if (typeof M.getAutoTransitionForTrackPair !== "function" || typeof M.playTransitionPreview !== "function" || !previewPlayer) {
    console.warn("[DJ Mix] This Spotify version has no automix engine; extension disabled.");
    return;
  }

  // ---------------------------------------------------------------- settings

  const SETTINGS_KEY = "djmix:v2";
  const DEFAULTS = { enabled: true, notify: true };
  const settings = (() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(S.LocalStorage.get(SETTINGS_KEY) || "{}") };
    } catch {
      return { ...DEFAULTS };
    }
  })();
  const saveSettings = () => {
    try {
      S.LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  };

  // ---------------------------------------------------------------- helpers

  const log = (...a) => console.log("%c[DJ Mix]", "color:#1ed760;font-weight:bold", ...a);
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const state = () => A.getState();
  const posOf = (st) =>
    !st ? 0 : st.positionAsOfTimestamp + (st.isPaused ? 0 : (Date.now() - st.timestamp) * (st.speed || 1));
  const isTrack = (uri) => typeof uri === "string" && uri.startsWith("spotify:track:");
  const previewActive = () => {
    try {
      return M.isTransitionPreviewActive();
    } catch {
      return false;
    }
  };
  const ref = (item) => item && { uri: item.uri, uid: item.uid, name: item.name, provider: item.provider };
  const mixable = (item) => item && isTrack(item.uri) && (!item.provider || item.provider === "context");

  // Main-thread timers get throttled to ~1/s when Spotify is minimised. Worker timers don't, so use one as the clock.
  function startClock(fn, ms) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(()=>postMessage(0),${ms})`], { type: "text/javascript" })));
      w.onmessage = fn;
      return;
    } catch (e) {
      log("worker clock unavailable, falling back to setInterval", e);
    }
    setInterval(fn, ms);
  }

  // ---------------------------------------------------------------- protobuf patch
  // The preview signal hard-codes "start 3000 ms before the overlap" (field 5, relative flag in field 6).
  // We rewrite it to an absolute start position = where the song is right now, so nothing audibly jumps.

  function readVarint(bytes, i) {
    let v = 0, mul = 1, b;
    do {
      b = bytes[i++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return [v, i];
  }
  function writeVarint(v) {
    const out = [];
    v = Math.max(0, Math.floor(v));
    while (v >= 0x80) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  }
  function patchStartPosition(b64, absMs) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out = [];
    let i = 0, patched5 = false, patched6 = false;
    while (i < bytes.length) {
      const start = i;
      const [key, afterKey] = readVarint(bytes, i);
      const field = Math.floor(key / 8), wire = key & 7;
      i = afterKey;
      if (wire === 0) {
        const [, end] = readVarint(bytes, i);
        if (field === 5) { out.push(...bytes.slice(start, afterKey), ...writeVarint(absMs)); patched5 = true; }
        else if (field === 6) { out.push(...bytes.slice(start, afterKey), 0); patched6 = true; }
        else out.push(...bytes.slice(start, end));
        i = end;
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(bytes, i);
        i = afterLen + len;
        out.push(...bytes.slice(start, i));
      } else if (wire === 1) { i += 8; out.push(...bytes.slice(start, i)); }
      else if (wire === 5) { i += 4; out.push(...bytes.slice(start, i)); }
      else return null; // unknown layout: don't touch it
    }
    if (!patched5 || !patched6) return null;
    let s = "";
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }

  /** Fire Spotify's native transition from track a to b, with track a continuing from `startMs`. */
  async function fireNativeTransition(tr, ctxUri, aUri, bUri, startMs) {
    const realSend = A.sendSignal;
    const realPause = A.pause;
    const realActive = previewPlayer.isTransitionPreviewActive;
    A.pause = async () => {}; // the editor pauses first; we want the music to keep going
    previewPlayer.isTransitionPreviewActive = () => false; // ...and it stops a running preview first; we chain instead
    A.sendSignal = function (sig, payload, ...rest) {
      if (sig === "automix-preview") {
        const patched = patchStartPosition(payload, startMs);
        if (patched) payload = patched;
        else log("could not patch start position; using Spotify's default lead-in");
      }
      return realSend.call(this, sig, payload, ...rest);
    };
    try {
      await M.playTransitionPreview(tr, ctxUri, aUri, bUri);
    } finally {
      A.sendSignal = realSend;
      A.pause = realPause;
      previewPlayer.isTransitionPreviewActive = realActive;
    }
  }

  // ---------------------------------------------------------------- state

  // session: we're in automix mode, following a snapshot of the real up-next list.
  //   { ctxUri, queue: [ref...], idx, pendingIdx, firedAt, settleUntil, ov }
  let session = null;
  let plan = null; // { key, from, to, toIdx, tr, ov, triggerAt }
  let planKey = "";
  let planning = false;
  let busy = false;
  let lastReason = "";

  function curRef(st) {
    if (!session) return ref(st?.item);
    const q = session.queue;
    const byPending = session.pendingIdx != null && q[session.pendingIdx]?.uri === st?.item?.uri ? session.pendingIdx : null;
    return q[byPending ?? session.idx];
  }

  async function ensurePlan(from, to, toIdx, st) {
    const key = `${from?.uri}|${to?.uid ?? to?.uri}|${toIdx}`;
    if (key === planKey || planning) return;
    planKey = key;
    plan = null;
    if (!isTrack(from?.uri)) return void (lastReason = "Not a music track");
    if (!to) return void (lastReason = "Nothing up next");
    if (!mixable(to)) return void (lastReason = "Next song is from your queue, so it plays normally");
    if (st.repeat === 2) return void (lastReason = "Repeat-one is on");
    planning = true;
    try {
      const tr = await M.getAutoTransitionForTrackPair(from.uri, to.uri);
      const ov = tr?.overlap;
      if (planKey !== key) return;
      if (!ov || !(ov.startAMs > 0)) return void (lastReason = "Spotify has no transition for this pair");
      plan = { key, from, to, toIdx, tr, ov, triggerAt: ov.startAMs - 1500 };
      lastReason = "";
      log(`planned: "${from.name ?? from.uri}" → "${to.name}" at ${fmt(ov.startAMs)}`, ov);
    } catch (e) {
      lastReason = "Couldn't get a transition from Spotify";
      log("transition lookup failed", e);
    } finally {
      planning = false;
    }
  }

  // ---------------------------------------------------------------- firing a mix

  async function fire(st, p) {
    busy = true;
    plan = null;
    planKey = "";
    const ctxUri = session?.ctxUri ?? st.context?.uri;
    if (!session) {
      // First mix: snapshot the real up-next list so we can keep following it inside automix mode.
      let upNext = (st.nextItems || []).map(ref);
      try {
        const q = await A.getQueue();
        const fromQueue = [...(q?.queued || []), ...(q?.nextUp || [])].map(ref);
        if (fromQueue[0]?.uid === p.to.uid && fromQueue.length >= upNext.length) upNext = fromQueue;
      } catch {}
      if (upNext[0]?.uid !== p.to.uid) upNext = [p.to, ...upNext];
      session = { ctxUri, queue: [ref(st.item), ...upNext.slice(0, 150)], idx: 0 };
    }
    session.pendingIdx = p.toIdx;
    session.firedAt = Date.now();
    session.settleUntil = Date.now() + 1500; // the player reports a few junk states right after a fire
    session.ov = p.ov;
    log(`mixing into "${p.to.name}"`);
    if (settings.notify) S.showNotification(`🎧 Mixing into ${p.to.name}${tempoLabel(p.ov)}`);
    try {
      const startMs = Math.round(posOf(state()) + 120); // small lead for the command to reach the player
      await fireNativeTransition(p.tr, ctxUri, p.from.uri, p.to.uri, startMs);
    } catch (e) {
      log("native transition failed", e);
      if (!previewActive()) session = null;
      else session.pendingIdx = null;
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- leaving automix mode

  async function handBack(target, seekMs) {
    if (busy || !session) return;
    busy = true;
    const st = state();
    const ctxUri = session.ctxUri;
    const wasPaused = st?.isPaused;
    try {
      await A.play(
        { uri: ctxUri },
        { featureIdentifier: "playlist", referrerIdentifier: "other" },
        { skipTo: { uri: target.uri, uid: target.uid }, seekTo: Math.max(0, Math.round(seekMs)) }
      );
      if (wasPaused) await A.pause().catch(() => {});
    } catch (e) {
      log("hand-back failed", e);
      try {
        await M.cleanupTransitionPreview();
      } catch {}
    } finally {
      session = null;
      plan = null;
      planKey = "";
      busy = false;
    }
  }

  // In automix mode Spotify blocks seek / previous and its own "next" would follow the preview's queue,
  // so route them through a hand-back to your real context.
  const orig = { seekTo: A.seekTo, skipToNext: A.skipToNext, skipToPrevious: A.skipToPrevious };
  const inSession = () => session && previewActive();
  A.seekTo = function (ms, ...rest) {
    if (inSession()) {
      const cur = curRef(state());
      return handBack(cur, ms);
    }
    return orig.seekTo.call(this, ms, ...rest);
  };
  A.skipToNext = function (...args) {
    if (inSession()) {
      const st = state();
      const cur = curRef(st);
      const i = session.queue.indexOf(cur);
      const next = session.queue[i + 1];
      if (next && mixable(next)) return handBack(next, 0);
      // Past the end of our snapshot: get back to the real context, then let Spotify skip normally.
      return handBack(cur, posOf(st)).then(() => orig.skipToNext.apply(A, args));
    }
    return orig.skipToNext.apply(this, args);
  };
  A.skipToPrevious = function (...args) {
    if (inSession()) {
      const st = state();
      const cur = curRef(st);
      const i = session.queue.indexOf(cur);
      const prev = posOf(st) < 3000 && i > 0 ? session.queue[i - 1] : cur;
      return handBack(prev, 0);
    }
    return orig.skipToPrevious.apply(this, args);
  };

  // Spotify greys out the back button in automix mode; we handle it, so keep it clickable.
  try {
    const ev = A.getEvents?.();
    const origEmit = ev?.emit;
    if (origEmit) {
      ev.emit = function (type, data, ...rest) {
        const r = data?.data?.restrictions ?? data?.restrictions;
        if (session && r) {
          r.canSkipPrevious = true;
          r.canSeek = true;
          r.disallowSkippingPreviousReasons = [];
          r.disallowSeekingReasons = [];
        }
        return origEmit.call(this, type, data, ...rest);
      };
    }
  } catch (e) {
    log("could not patch player events", e);
  }

  // ---------------------------------------------------------------- engine

  function tick() {
    if (busy) return;
    const st = state();
    if (!st?.item) return;
    const now = Date.now();

    if (session) {
      if (now < session.settleUntil) return;
      if (!previewActive()) {
        // Left automix mode some other way (you played something else, or Spotify stopped it).
        session = null;
        plan = null;
        planKey = "";
        return;
      }
      const q = session.queue;
      if (session.pendingIdx != null && st.item.uri === q[session.pendingIdx]?.uri) {
        session.idx = session.pendingIdx;
        session.pendingIdx = null;
      }
      const cur = q[session.idx];
      if (st.item.uri !== cur?.uri) {
        // Overlap in progress, or a mix that never happened.
        if (session.pendingIdx != null && now - session.firedAt > (session.ov?.durationMs || 0) + 20000) session.pendingIdx = null;
        return;
      }
      if (session.pendingIdx != null) return; // fired, waiting for the overlap to reach the new song

      const next = q[session.idx + 1];
      ensurePlan(cur, next, session.idx + 1, st);
      const pos = posOf(st);
      if (settings.enabled && plan?.from.uri === cur.uri && !st.isPaused && pos >= plan.triggerAt && pos < plan.ov.startAMs - 250) {
        fire(st, plan);
        return;
      }
      // No mix will happen for this song: leave automix mode right at the song boundary.
      if (pos >= (st.duration || Infinity) - 350) {
        if (next && mixable(next)) handBack(next, 0);
        else handBack(cur, pos);
      }
      return;
    }

    if (previewActive()) return; // Spotify's own mix editor is previewing; stay out of it

    const cur = ref(st.item);
    ensurePlan(cur, ref(st.nextItems?.[0]), 1, st);
    if (!settings.enabled || !plan || st.isPaused || plan.from.uri !== cur.uri) return;
    if (st.nextItems?.[0]?.uid !== plan.to.uid) {
      planKey = "";
      return;
    }
    const pos = posOf(st);
    if (pos >= plan.triggerAt && pos < plan.ov.startAMs - 250) fire(st, plan);
  }

  startClock(tick, 50);

  // ---------------------------------------------------------------- UI

  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5a.75.75 0 0 1 .75-.75c3.2 0 5.03 2.27 6.25 4.6 1.22-2.33 3.05-4.6 6.25-4.6a.75.75 0 0 1 0 1.5c-2.53 0-3.97 1.9-5.4 4.75 1.43 2.85 2.87 4.75 5.4 4.75a.75.75 0 0 1 0 1.5c-3.2 0-5.03-2.27-6.25-4.6-1.22 2.33-3.05 4.6-6.25 4.6a.75.75 0 0 1 0-1.5c2.53 0 3.97-1.9 5.4-4.75C5.72 6.15 4.28 4.25 1.75 4.25A.75.75 0 0 1 1 3.5z"/></svg>`;
  const button = new S.Playbar.Button("DJ Mix", ICON, openPanel, false, settings.enabled);

  function tempoLabel(ov) {
    if (!ov?.isBeatmatched) return "";
    const pct = ov.speedB && Math.abs(ov.speedB - 1) > 0.001 ? ` (${ov.speedB > 1 ? "+" : ""}${((ov.speedB - 1) * 100).toFixed(1)}% tempo)` : "";
    return ` · beat-matched${pct}`;
  }
  function describe(ov) {
    if (!ov) return "";
    const bits = [];
    if (ov.durationBars) bits.push(`${ov.durationBars} bars`);
    bits.push(`${(ov.durationMs / 1000).toFixed(1)}s overlap`);
    if (ov.isBeatmatched) {
      bits.push(`beat-matched ${Math.round(ov.bpmA)}→${Math.round(ov.bpmB)} BPM`);
      if (ov.speedB && Math.abs(ov.speedB - 1) > 0.001) bits.push(`${ov.speedB > 1 ? "+" : ""}${((ov.speedB - 1) * 100).toFixed(1)}% tempo`);
    } else bits.push("crossfade");
    if (ov.startBMs > 1000) bits.push(`enters at ${fmt(ov.startBMs)}`);
    return bits.join(" · ");
  }
  function statusLines() {
    if (!settings.enabled) return ["DJ Mix is off", session ? "Finishing the current song in mix mode" : ""];
    if (session?.pendingIdx != null) {
      const to = session.queue[session.pendingIdx];
      return [`Mixing into ${to?.name}…`, describe(session.ov)];
    }
    if (plan) return [`Next mix → ${plan.to.name} at ${fmt(plan.ov.startAMs)}`, describe(plan.ov)];
    return [lastReason || "Waiting for the next song…", ""];
  }

  function openPanel() {
    const root = document.createElement("div");
    root.innerHTML = `
      <style>
        .djmix { display:flex; flex-direction:column; gap:16px; font-size:14px; color:var(--spice-text); min-width:340px; }
        .djmix-status { padding:14px; border-radius:8px; background:var(--spice-highlight, rgba(255,255,255,.07)); }
        .djmix-status b { display:block; font-size:15px; }
        .djmix-status span { display:block; margin-top:4px; opacity:.7; font-size:12px; }
        .djmix-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .djmix-row input { width:18px; height:18px; accent-color:var(--spice-button, #1db954); }
        .djmix-note { opacity:.6; font-size:12px; line-height:1.45; }
      </style>
      <div class="djmix">
        <div class="djmix-status"><b data-l1></b><span data-l2></span></div>
        <div class="djmix-row"><label for="djmix-enabled">Mix songs like a DJ</label>
          <input type="checkbox" id="djmix-enabled" data-key="enabled" ${settings.enabled ? "checked" : ""}></div>
        <div class="djmix-row"><label for="djmix-notify">Show a notification on each mix</label>
          <input type="checkbox" id="djmix-notify" data-key="notify" ${settings.notify ? "checked" : ""}></div>
        <div class="djmix-note">Transitions come from Spotify's own automix engine: it picks the mix point, lines up the
          beats and nudges the tempo of the incoming song. While mixing, songs you add to the queue are picked up
          after you next seek or skip.</div>
      </div>`;
    root.querySelectorAll("[data-key]").forEach((input) =>
      input.addEventListener("change", () => {
        settings[input.dataset.key] = input.checked;
        saveSettings();
        button.active = settings.enabled;
      })
    );
    const l1 = root.querySelector("[data-l1]"), l2 = root.querySelector("[data-l2]");
    const refresh = () => {
      if (!root.isConnected && root.dataset.shown) return clearInterval(timer);
      if (root.isConnected) root.dataset.shown = "1";
      const [a, b] = statusLines();
      l1.textContent = a;
      l2.textContent = b;
    };
    const timer = setInterval(refresh, 500);
    refresh();
    S.PopupModal.display({ title: "DJ Mix", content: root, isLarge: false });
  }

  window.__djmix = {
    get plan() { return plan; },
    get session() { return session; },
    settings,
  };
  log("ready");
})();
