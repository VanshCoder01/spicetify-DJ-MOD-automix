// NAME: DJ Mix
// DESCRIPTION: Real DJ transitions in Spotify. Uses Spotify's own (hidden) automix engine to overlap the end of one
//              song with the next, beat-matched and tempo-synced, like Apple Music's AutoMix.
// VERSION: 0.4.0
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
  // beatOnly: skip mixes Spotify can't beat-match. maxTempo: skip mixes that change tempo by more than this % (0 = any).
  // marker: draw the next mix on the seek bar.
  const DEFAULTS = { enabled: true, notify: true, marker: true, beatOnly: false, maxTempo: 0 };
  const loadJSON = (key, fallback) => {
    try {
      const v = JSON.parse(S.LocalStorage.get(key) || "null");
      return v && typeof v === "object" ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const saveJSON = (key, v) => {
    try {
      S.LocalStorage.set(key, JSON.stringify(v));
    } catch {}
  };
  const settings = { ...DEFAULTS, ...loadJSON(SETTINGS_KEY, {}) };
  const saveSettings = () => saveJSON(SETTINGS_KEY, settings);

  // Mix history (last few mixes) and lifetime stats, kept across restarts.
  const HISTORY_KEY = "djmix:history";
  const STATS_KEY = "djmix:stats";
  const HISTORY_MAX = 12;
  const history = Array.isArray(loadJSON(HISTORY_KEY, [])) ? loadJSON(HISTORY_KEY, []) : [];
  const stats = { mixes: 0, beatmatched: 0, overlapMs: 0, tempoSum: 0, ...loadJSON(STATS_KEY, {}) };

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
  const tempoPct = (ov) => (ov?.isBeatmatched && ov.speedB ? (ov.speedB - 1) * 100 : 0);
  const signedPct = (p) => `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;

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
  let skippedKey = ""; // the one upcoming mix you chose to skip

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
    if (key === skippedKey) return void (lastReason = `Skipping this mix; ${to.name ?? "the next song"} plays normally`);
    planning = true;
    try {
      const tr = await M.getAutoTransitionForTrackPair(from.uri, to.uri);
      const ov = tr?.overlap;
      if (planKey !== key) return;
      if (!ov || !(ov.startAMs > 0)) return void (lastReason = "Spotify has no transition for this pair");
      if (settings.beatOnly && !ov.isBeatmatched)
        return void (lastReason = "Spotify can't beat-match this pair (beat-matched only is on)");
      const tp = tempoPct(ov);
      if (settings.maxTempo > 0 && Math.abs(tp) > settings.maxTempo)
        return void (lastReason = `Tempo change ${signedPct(tp)} is over your ${settings.maxTempo}% limit`);
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
      recordMix(p);
    } catch (e) {
      log("native transition failed", e);
      if (!previewActive()) session = null;
      else session.pendingIdx = null;
    } finally {
      busy = false;
    }
  }

  function recordMix(p) {
    const ov = p.ov;
    const tp = tempoPct(ov);
    history.unshift({
      at: Date.now(),
      from: p.from.name ?? "",
      to: p.to.name ?? "",
      beat: !!ov.isBeatmatched,
      bpmA: ov.bpmA ? Math.round(ov.bpmA) : null,
      bpmB: ov.bpmB ? Math.round(ov.bpmB) : null,
      tempo: Math.round(tp * 10) / 10,
      overlapMs: Math.round(ov.durationMs || 0),
    });
    history.length = Math.min(history.length, HISTORY_MAX);
    stats.mixes++;
    if (ov.isBeatmatched) stats.beatmatched++;
    stats.overlapMs += ov.durationMs || 0;
    stats.tempoSum += Math.abs(tp);
    saveJSON(HISTORY_KEY, history);
    saveJSON(STATS_KEY, stats);
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
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mixing = () => session?.pendingIdx != null;
  /** The plan for the song that's playing right now, if any. */
  const livePlan = (st = state()) => (plan && st?.item && plan.from.uri === st.item.uri ? plan : null);

  function statusLines() {
    if (!settings.enabled) return ["DJ Mix is off", session ? "Finishing the current song in mix mode" : ""];
    if (mixing()) {
      const to = session.queue[session.pendingIdx];
      return [`Mixing into ${to?.name}…`, describe(session.ov)];
    }
    const p = livePlan();
    if (p) {
      const left = p.ov.startAMs - posOf(state());
      return [`Next mix → ${p.to.name} at ${fmt(p.ov.startAMs)}${left > 0 ? ` (in ${fmt(left)})` : ""}`, describe(p.ov)];
    }
    return [lastReason || "Waiting for the next song…", ""];
  }

  // ---------------------------------------------------------------- actions

  function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    button.active = on;
    paintMarker();
  }
  /** A setting changed which mixes are allowed: drop the current plan so it gets re-checked. */
  function replan() {
    if (busy || mixing()) return;
    plan = null;
    planKey = "";
  }
  /** Jump to a few seconds before the next mix point so you hear the blend right away. */
  function mixNow() {
    const st = state();
    const p = livePlan(st);
    if (!settings.enabled || !p || mixing() || busy) return false;
    const target = Math.max(0, p.ov.startAMs - 4000);
    if (posOf(st) >= target) return false;
    A.seekTo(target); // goes through our hand-back when in automix mode
    return true;
  }
  /** Let the current song end normally instead of mixing, just this once. */
  function skipMix() {
    const p = livePlan();
    if (!p || mixing()) return false;
    skippedKey = p.key;
    plan = null; // planKey stays the same, so this pair isn't planned again
    lastReason = `Skipping this mix; ${p.to.name ?? "the next song"} plays normally`;
    paintMarker();
    return true;
  }
  function unskipMix() {
    skippedKey = "";
    replan();
  }

  // ---------------------------------------------------------------- seek-bar marker
  // A glowing zone on Spotify's progress bar: where the next mix starts and how long the overlap lasts.

  const style = document.createElement("style");
  style.textContent = `
    .djmix-marker { position:absolute; top:50%; height:12px; transform:translateY(-50%); pointer-events:none; z-index:2;
      border-radius:3px; min-width:3px; border-left:2px solid #1ed760;
      background:linear-gradient(90deg, rgba(30,215,96,.55), rgba(30,215,96,.12));
      box-shadow:0 0 8px rgba(30,215,96,.6); animation:djmix-glow 1.6s ease-in-out infinite; }
    @keyframes djmix-glow { 50% { box-shadow:0 0 14px rgba(30,215,96,.95); } }
  `;
  document.head.appendChild(style);

  const BAR_SELECTORS = [
    '[data-testid="playback-progressbar"] [data-testid="progress-bar"]',
    ".playback-bar [data-testid='progress-bar']",
    ".playback-bar .progress-bar",
    '[data-testid="playback-progressbar"]',
  ];
  const findBar = () => {
    for (const sel of BAR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  let marker = null;
  function paintMarker() {
    const st = state();
    const p = livePlan(st);
    const dur = st?.duration;
    const bar = settings.marker && settings.enabled && p && dur > 0 && !mixing() ? findBar() : null;
    if (!bar) {
      marker?.remove();
      marker = null;
      return;
    }
    if (!marker || marker.parentElement !== bar) {
      marker?.remove();
      marker = document.createElement("div");
      marker.className = "djmix-marker";
      if (getComputedStyle(bar).position === "static") bar.style.position = "relative";
      bar.appendChild(marker);
    }
    const start = Math.min(p.ov.startAMs, dur);
    const len = Math.min(p.ov.durationMs || 0, dur - start);
    marker.style.left = `${(start / dur) * 100}%`;
    marker.style.width = `${(len / dur) * 100}%`;
    marker.title = `DJ Mix → ${p.to.name} at ${fmt(start)}`;
  }
  setInterval(paintMarker, 500);

  // ---------------------------------------------------------------- keyboard shortcut

  const onShortcut = (e) => {
    e?.preventDefault?.();
    setEnabled(!settings.enabled);
    S.showNotification(settings.enabled ? "🎧 DJ Mix on" : "DJ Mix off");
  };
  try {
    if (typeof S.Mousetrap?.bind === "function") S.Mousetrap.bind("ctrl+alt+d", onShortcut);
    else S.Keyboard?.registerShortcut?.({ key: "d", ctrl: true, alt: true }, onShortcut);
  } catch (e) {
    log("could not register keyboard shortcut", e);
  }

  // ---------------------------------------------------------------- panel

  function historyHTML() {
    if (!history.length) return `<li class="djmix-empty">No mixes yet. They'll show up here as they happen.</li>`;
    return history
      .map((h) => {
        const meta = h.beat ? `${h.bpmA ?? "?"}→${h.bpmB ?? "?"} BPM${h.tempo ? ` · ${signedPct(h.tempo)}` : ""}` : "crossfade";
        const when = new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `<li><span class="djmix-h-songs"><span>${esc(h.from)}</span> → <b>${esc(h.to)}</b></span>
          <span class="djmix-h-meta">${esc(meta)} · ${when}</span></li>`;
      })
      .join("");
  }
  function statsLine() {
    if (!stats.mixes) return "";
    const pctBeat = Math.round((stats.beatmatched / stats.mixes) * 100);
    const avgTempo = stats.beatmatched ? stats.tempoSum / stats.beatmatched : 0;
    const blend = stats.overlapMs >= 60000 ? `${Math.round(stats.overlapMs / 60000)} min` : `${Math.round(stats.overlapMs / 1000)}s`;
    return `All time: ${stats.mixes} ${stats.mixes === 1 ? "mix" : "mixes"} · ${pctBeat}% beat-matched · avg tempo shift ${avgTempo.toFixed(1)}% · ${blend} of blending`;
  }

  function openPanel() {
    const root = document.createElement("div");
    const checkbox = (key, label) => `
      <div class="djmix-row"><label for="djmix-${key}">${label}</label>
        <input type="checkbox" id="djmix-${key}" data-key="${key}" ${settings[key] ? "checked" : ""}></div>`;
    const tempoOpts = [0, 2, 4, 6, 8]
      .map((v) => `<option value="${v}" ${+settings.maxTempo === v ? "selected" : ""}>${v ? `±${v}%` : "Any"}</option>`)
      .join("");
    root.innerHTML = `
      <style>
        .djmix { display:flex; flex-direction:column; gap:14px; font-size:14px; color:var(--spice-text); min-width:360px; }
        .djmix-status { padding:14px; border-radius:8px; background:var(--spice-highlight, rgba(255,255,255,.07)); }
        .djmix-status b { display:block; font-size:15px; }
        .djmix-status span { display:block; margin-top:4px; opacity:.7; font-size:12px; }
        .djmix-meter { margin-top:10px; height:4px; border-radius:2px; background:rgba(255,255,255,.1); overflow:hidden; }
        .djmix-meter i { display:block; height:100%; width:0; background:#1ed760; transition:width .25s linear; }
        .djmix-actions { display:flex; gap:8px; }
        .djmix-actions button { flex:1; padding:8px 12px; border-radius:500px; border:1px solid rgba(255,255,255,.25);
          background:transparent; color:inherit; font-weight:700; font-size:13px; cursor:pointer; }
        .djmix-actions button:hover:not(:disabled) { border-color:#1ed760; color:#1ed760; }
        .djmix-actions button:disabled { opacity:.35; cursor:default; }
        .djmix-row { display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .djmix-row input { width:18px; height:18px; accent-color:var(--spice-button, #1db954); }
        .djmix-row select { background:var(--spice-highlight, #333); color:inherit; border:0; border-radius:4px; padding:4px 6px; }
        .djmix-h { font-size:12px; text-transform:uppercase; letter-spacing:.08em; opacity:.6; margin-top:4px; }
        .djmix-hist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; max-height:190px; overflow:auto; }
        .djmix-hist li { display:flex; flex-direction:column; gap:2px; font-size:13px; }
        .djmix-h-songs span { opacity:.75; }
        .djmix-h-meta, .djmix-stats, .djmix-empty { opacity:.6; font-size:12px; }
        .djmix-note { opacity:.6; font-size:12px; line-height:1.45; }
      </style>
      <div class="djmix">
        <div class="djmix-status"><b data-l1></b><span data-l2></span><div class="djmix-meter"><i data-meter></i></div></div>
        <div class="djmix-actions">
          <button data-act="now" title="Jump to just before the mix point">⏩ Mix now</button>
          <button data-act="skip" title="Let this song end normally, just this once">Skip this mix</button>
        </div>
        ${checkbox("enabled", "Mix songs like a DJ <span style='opacity:.5'>(Ctrl+Alt+D)</span>")}
        ${checkbox("notify", "Show a notification on each mix")}
        ${checkbox("marker", "Show the next mix on the seek bar")}
        ${checkbox("beatOnly", "Only mix when Spotify can beat-match")}
        <div class="djmix-row"><label for="djmix-maxTempo">Largest tempo change allowed</label>
          <select id="djmix-maxTempo">${tempoOpts}</select></div>
        <div class="djmix-h">Recent mixes</div>
        <ul class="djmix-hist" data-hist></ul>
        <div class="djmix-stats" data-stats></div>
        <div class="djmix-note">Transitions come from Spotify's own automix engine: it picks the mix point, lines up the
          beats and nudges the tempo of the incoming song. While mixing, songs you add to the queue are picked up
          after you next seek or skip.</div>
      </div>`;

    root.querySelectorAll("[data-key]").forEach((input) =>
      input.addEventListener("change", () => {
        const key = input.dataset.key;
        if (key === "enabled") return setEnabled(input.checked);
        settings[key] = input.checked;
        saveSettings();
        if (key === "beatOnly") replan();
        paintMarker();
      })
    );
    root.querySelector("#djmix-maxTempo").addEventListener("change", (e) => {
      settings.maxTempo = +e.target.value || 0;
      saveSettings();
      replan();
    });
    const btnNow = root.querySelector('[data-act="now"]');
    const btnSkip = root.querySelector('[data-act="skip"]');
    const canUnskip = () => !!skippedKey && skippedKey === planKey && !livePlan();
    btnNow.addEventListener("click", () => mixNow());
    btnSkip.addEventListener("click", () => (canUnskip() ? unskipMix() : skipMix()));

    const l1 = root.querySelector("[data-l1]"), l2 = root.querySelector("[data-l2]");
    const meter = root.querySelector("[data-meter]");
    const histEl = root.querySelector("[data-hist]"), statsEl = root.querySelector("[data-stats]");
    const enabledBox = root.querySelector("#djmix-enabled");
    let shownHistory = -1;
    const refresh = () => {
      if (!root.isConnected && root.dataset.shown) return clearInterval(timer);
      if (root.isConnected) root.dataset.shown = "1";
      const st = state();
      const p = livePlan(st);
      const [a, b] = statusLines();
      l1.textContent = a;
      l2.textContent = b;
      enabledBox.checked = settings.enabled; // the shortcut can flip it while the panel is open
      meter.style.width = p ? `${Math.min(100, (posOf(st) / p.ov.startAMs) * 100)}%` : mixing() ? "100%" : "0%";
      btnNow.disabled = !settings.enabled || !p || mixing() || posOf(st) >= p.ov.startAMs - 4000;
      const unskip = canUnskip();
      btnSkip.textContent = unskip ? "Undo skip" : "Skip this mix";
      btnSkip.disabled = !(p || unskip) || mixing();
      const stamp = history.length ? history[0].at : 0;
      if (stamp !== shownHistory) {
        shownHistory = stamp;
        histEl.innerHTML = historyHTML();
        statsEl.textContent = statsLine();
      }
    };
    const timer = setInterval(refresh, 250);
    refresh();
    S.PopupModal.display({ title: "DJ Mix", content: root, isLarge: false });
  }

  window.__djmix = {
    get plan() { return plan; },
    get session() { return session; },
    settings,
    history,
    stats,
    mixNow,
    skipMix,
  };
  log("ready");
})();
