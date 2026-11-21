// DJ Mix app: a full page in Spotify's sidebar for the DJ Mix extension.
// Live decks, a setlist forecast for your queue, the Mix Lab (hear any two songs mixed), settings and stats.
// It drives the extension through window.DJMix (djmix.js ships inside this app as a subfile extension).

/* global Spicetify */
var djmixApp = (() => {
  const S = window.Spicetify;
  const React = S.React;
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback, useMemo } = React;

  // ------------------------------------------------------------ helpers

  const fmt = (ms) => {
    if (!(ms >= 0)) return "–:––";
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const pct = (p) => `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
  const cx = (...c) => c.filter(Boolean).join(" ");
  const img = (item) => {
    const list = item?.images || item?.album?.images || [];
    const pick = list.find((i) => /large|xlarge/i.test(i.label || "")) || list[list.length - 1] || list[0];
    const u = pick?.url || item?.metadata?.image_large_url || item?.metadata?.image_url || "";
    return u.startsWith("spotify:image:") ? `https://i.scdn.co/image/${u.slice(14)}` : u;
  };
  const artists = (item) =>
    (item?.artists || []).map((a) => a.name).filter(Boolean).join(", ") || item?.metadata?.artist_name || "";
  const durOf = (item) => item?.duration?.milliseconds ?? (typeof item?.duration === "number" ? item.duration : 0);
  const isTrack = (uri) => typeof uri === "string" && uri.startsWith("spotify:track:");
  const tempoOf = (ov) => (ov?.isBeatmatched && ov.speedB ? (ov.speedB - 1) * 100 : 0);
  const toTrack = (item) =>
    item && isTrack(item.uri)
      ? { uri: item.uri, uid: item.uid, name: item.name || "Unknown song", artist: artists(item), image: img(item), duration: durOf(item), provider: item.provider }
      : null;

  /** "https://open.spotify.com/track/ID?si=…" or "spotify:track:ID" → "spotify:track:ID" */
  function parseTrack(text) {
    const t = String(text || "").trim();
    const m = t.match(/(?:spotify:track:|open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/)([A-Za-z0-9]{22})/);
    return m ? `spotify:track:${m[1]}` : null;
  }
  async function lookupTrack(uri) {
    const id = uri.split(":")[2];
    try {
      const r = await S.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${id}`);
      if (r?.uri) {
        return {
          uri: r.uri, name: r.name, artist: (r.artists || []).map((a) => a.name).join(", "),
          image: r.album?.images?.[0]?.url || "", duration: r.duration_ms || 0,
        };
      }
    } catch {}
    return { uri, name: "Pasted song", artist: id, image: "", duration: 0 };
  }

  const api = () => window.DJMix;

  /** Re-render every `ms` while mounted. */
  function useTick(ms) {
    const [, set] = useState(0);
    useEffect(() => {
      const t = setInterval(() => set((n) => n + 1), ms);
      return () => clearInterval(t);
    }, [ms]);
  }

  /** The player's current song and up-next list, refreshed on song / queue changes. */
  function usePlayer() {
    const read = () => {
      const st = S.Platform.PlayerAPI.getState();
      return { st, current: toTrack(st?.item), next: (st?.nextItems || []).map(toTrack).filter(Boolean) };
    };
    const [p, setP] = useState(read);
    useEffect(() => {
      const upd = () => setP(read());
      const t = setInterval(upd, 1000);
      S.Player?.addEventListener?.("songchange", upd);
      return () => {
        clearInterval(t);
        S.Player?.removeEventListener?.("songchange", upd);
      };
    }, []);
    return p;
  }

  /** Full queue (up to `max` songs) from PlayerAPI.getQueue, falling back to the state's nextItems. */
  async function readQueue(max) {
    const st = S.Platform.PlayerAPI.getState();
    let list = st?.nextItems || [];
    try {
      const q = await S.Platform.PlayerAPI.getQueue();
      const full = [...(q?.queued || []), ...(q?.nextUp || [])];
      if (full.length >= list.length) list = full;
    } catch {}
    return { current: toTrack(st?.item), next: list.map(toTrack).filter(Boolean).slice(0, max) };
  }

  // ------------------------------------------------------------ small components

  function Art({ track, size = 56, spin }) {
    return h(
      "div",
      { className: cx("dj-art", spin && "dj-spin"), style: { width: size, height: size } },
      track?.image ? h("img", { src: track.image, alt: "" }) : h("div", { className: "dj-art-empty" }, "♪")
    );
  }

  function Toggle({ on, onChange, label, hint }) {
    return h(
      "label",
      { className: "dj-setting" },
      h("span", { className: "dj-setting-text" }, h("b", null, label), hint && h("small", null, hint)),
      h("button", {
        type: "button", role: "switch", "aria-checked": !!on, "aria-label": label,
        className: cx("dj-switch", on && "on"), onClick: () => onChange(!on),
      })
    );
  }

  function Segmented({ value, options, onChange, label, hint }) {
    return h(
      "div",
      { className: "dj-setting" },
      h("span", { className: "dj-setting-text" }, h("b", null, label), hint && h("small", null, hint)),
      h(
        "div",
        { className: "dj-seg", role: "radiogroup", "aria-label": label },
        options.map(([v, t]) =>
          h("button", {
            key: String(v), type: "button", role: "radio", "aria-checked": String(value) === String(v),
            className: cx(String(value) === String(v) && "on"), onClick: () => onChange(v),
          }, t)
        )
      )
    );
  }

  function Slider({ value, min, max, step, onChange, label, hint, show }) {
    return h(
      "div",
      { className: "dj-setting" },
      h("span", { className: "dj-setting-text" }, h("b", null, label), hint && h("small", null, hint)),
      h(
        "div",
        { className: "dj-slider" },
        h("input", { type: "range", min, max, step, value, "aria-label": label, onChange: (e) => onChange(+e.target.value) }),
        h("output", null, show(value))
      )
    );
  }

  function Badge({ kind, children }) {
    return h("span", { className: cx("dj-badge", kind) }, children);
  }

  function RecipeBadges({ ov }) {
    if (!ov) return h(Badge, { kind: "muted" }, "no transition");
    const tp = tempoOf(ov);
    return h(
      React.Fragment,
      null,
      ov.isBeatmatched ? h(Badge, { kind: "green" }, "beat-matched") : h(Badge, { kind: "blue" }, "crossfade"),
      ov.bpmA && ov.bpmB ? h(Badge, null, `${Math.round(ov.bpmA)} → ${Math.round(ov.bpmB)} BPM`) : null,
      tp ? h(Badge, { kind: Math.abs(tp) > 4 ? "amber" : null }, `${pct(tp)} tempo`) : null,
      h(Badge, null, `${((ov.durationMs || 0) / 1000).toFixed(1)}s${ov.durationBars ? ` · ${ov.durationBars} bars` : ""}`)
    );
  }

  /** Two curves (out / in) for a fade shape, as an SVG. */
  function CurveGraph({ name, width = 220, height = 80 }) {
    const n = 40;
    const pts = (fn) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const k = i / n;
        return `${(k * width).toFixed(1)},${(height - fn(k) * (height - 6) - 3).toFixed(1)}`;
      }).join(" ");
    const c = (k) => api()?.curve?.(name, k) ?? Math.cos((k * Math.PI) / 2);
    return h(
      "svg",
      { className: "dj-curve", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": `${name} fade shape` },
      h("polyline", { points: pts((k) => c(k)), className: "out" }),
      h("polyline", { points: pts((k) => c(1 - k)), className: "in" })
    );
  }

  // ------------------------------------------------------------ Live tab

  function Live() {
    useTick(250);
    const { current, next } = usePlayer();
    const d = api();
    const s = d.status();
    const p = s.plan;
    const target = p?.to ? next.find((t) => t.uid === p.to.uid || t.uri === p.to.uri) || { ...p.to, name: p.to.name } : next[0];
    const progress = s.duration ? s.position / s.duration : 0;
    const left = p ? p.at - s.position : null;
    const ov = p?.overlap;
    const fader = s.mixing ? 1 : p ? Math.max(0, Math.min(1, s.position / p.at)) : 0;

    return h(
      "div",
      { className: "dj-live" },
      h(
        "div",
        { className: "dj-decks" },
        h(Deck, { side: "A", track: current, playing: !s.paused, label: "Now playing", bpm: ov?.bpmA, dim: s.mixing && s.fadePhase !== "out" }),
        h(
          "div",
          { className: "dj-mixer" },
          h("div", { className: cx("dj-count", s.mixing && "live") },
            s.mixing ? "MIXING" : left != null && left > 0 ? fmt(left) : "–:––"),
          h("small", null, s.mixing ? "blend in progress" : p ? `until the ${p.mode === "fade" ? "fade" : "mix"}` : "no mix planned"),
          h("div", { className: "dj-fader", "aria-hidden": true }, h("i", { style: { left: `calc(${fader * 100}% - 9px)` } })),
          h("div", { className: "dj-fader-labels" }, h("span", null, "A"), h("span", null, "B"))
        ),
        h(Deck, { side: "B", track: target, label: "Up next", bpm: ov?.bpmB, dim: !s.mixing })
      ),
      h(
        "div",
        { className: "dj-timeline" },
        h("div", { className: "dj-tl-bar" },
          h("i", { className: "dj-tl-pos", style: { width: `${progress * 100}%` } }),
          p && s.duration
            ? h("i", {
                className: cx("dj-tl-zone", p.mode === "fade" && "fade"),
                style: { left: `${(p.at / s.duration) * 100}%`, width: `${Math.max(0.5, (p.length / s.duration) * 100)}%` },
              })
            : null),
        h("div", { className: "dj-tl-times" }, h("span", null, fmt(s.position)), h("span", null, fmt(s.duration)))
      ),
      h(
        "div",
        { className: "dj-status-card" },
        h("div", null, h("b", null, s.line1), s.line2 && h("span", null, s.line2), h("em", null, `Engine: ${s.engine}`)),
        p?.overlap ? h("div", { className: "dj-badges" }, h(RecipeBadges, { ov: p.overlap })) : null
      ),
      h(
        "div",
        { className: "dj-actions" },
        h("button", { className: cx("dj-btn", s.enabled ? "primary" : ""), onClick: () => d.setEnabled(!s.enabled) },
          s.enabled ? "● DJ Mix on" : "○ DJ Mix off"),
        h("button", { className: "dj-btn", disabled: !s.enabled || !p || s.mixing || s.position >= (p?.at || 0) - 4000, onClick: () => d.mixNow() }, "⏩ Mix now"),
        h("button", { className: "dj-btn", disabled: !(p || s.canUnskip) || s.mixing, onClick: () => (s.canUnskip ? d.unskipMix() : d.skipMix()) },
          s.canUnskip ? "↩ Undo skip" : "⏭ Skip this mix")
      ),
      h("p", { className: "dj-foot" }, "Tip: Ctrl+Alt+D toggles DJ Mix from anywhere in Spotify.")
    );
  }

  function Deck({ side, track, label, bpm, playing, dim }) {
    return h(
      "div",
      { className: cx("dj-deck", dim && "dim") },
      h("div", { className: "dj-deck-head" }, h("span", { className: "dj-deck-side" }, side), h("small", null, label)),
      h(Art, { track, size: 148, spin: side === "A" && playing }),
      h("div", { className: "dj-deck-title", title: track?.name }, track?.name || "—"),
      h("div", { className: "dj-deck-artist" }, track?.artist || ""),
      h("div", { className: "dj-deck-bpm" }, bpm ? `${Math.round(bpm)} BPM` : " ")
    );
  }

  // ------------------------------------------------------------ Setlist tab

  function Setlist({ onLab }) {
    const [rows, setRows] = useState(null);
    const [count, setCount] = useState(10);
    const [busy, setBusy] = useState(false);
    const run = useRef(0);

    const load = useCallback(async () => {
      const id = ++run.current;
      setBusy(true);
      const { current, next } = await readQueue(count);
      const chain = [current, ...next].filter(Boolean);
      const out = chain.slice(1).map((t, i) => ({ a: chain[i], b: t, ov: undefined }));
      setRows([...out]);
      for (let i = 0; i < out.length; i++) {
        if (run.current !== id) return;
        const tr = await api().getTransition(out[i].a.uri, out[i].b.uri);
        out[i] = { ...out[i], ov: tr?.overlap?.startAMs > 0 ? tr.overlap : null };
        setRows([...out]);
      }
      setBusy(false);
    }, [count]);

    useEffect(() => {
      load();
      return () => void run.current++;
    }, [load]);

    const done = (rows || []).filter((r) => r.ov !== undefined);
    const beat = done.filter((r) => r.ov?.isBeatmatched);
    const shifts = beat.map((r) => Math.abs(tempoOf(r.ov)));
    const avg = shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : 0;
    const score = done.length
      ? Math.round(done.reduce((acc, r) => acc + (!r.ov ? 0 : r.ov.isBeatmatched ? Math.max(40, 100 - Math.abs(tempoOf(r.ov)) * 8) : 35), 0) / done.length)
      : null;

    return h(
      "div",
      { className: "dj-setlist" },
      h(
        "div",
        { className: "dj-summary" },
        h(Stat, { big: score ?? "…", label: "set flow score", hint: "how smoothly your queue will mix" }),
        h(Stat, { big: done.length ? `${beat.length}/${done.length}` : "…", label: "beat-matchable" }),
        h(Stat, { big: beat.length ? `${avg.toFixed(1)}%` : "–", label: "avg tempo shift" }),
        h("div", { className: "dj-summary-ctl" },
          h(Segmented, { label: "Look ahead", value: count, options: [[5, "5"], [10, "10"], [20, "20"]], onChange: setCount }),
          h("button", { className: "dj-btn", onClick: load, disabled: busy }, busy ? "Reading Spotify's recipes…" : "↻ Refresh"))
      ),
      !rows
        ? h("p", { className: "dj-empty" }, "Loading your queue…")
        : !rows.length
          ? h("p", { className: "dj-empty" }, "Nothing up next. Play a playlist or album and come back.")
          : h(
              "ol",
              { className: "dj-rows" },
              rows.map((r, i) =>
                h(
                  "li",
                  { key: `${r.b.uid || r.b.uri}-${i}` },
                  h("span", { className: "dj-row-n" }, i + 1),
                  h(Art, { track: r.b, size: 40 }),
                  h("div", { className: "dj-row-main" },
                    h("div", { className: "dj-row-title" }, h("span", null, r.a.name), " → ", h("b", null, r.b.name)),
                    h("div", { className: "dj-badges" },
                      r.ov === undefined ? h(Badge, { kind: "muted" }, "checking…") : h(RecipeBadges, { ov: r.ov }),
                      r.b.provider && r.b.provider !== "context" ? h(Badge, { kind: "amber" }, "from your queue") : null)),
                  h("button", { className: "dj-btn small", title: "Open this pair in the Mix Lab", onClick: () => onLab(r.a, r.b) }, "🧪 Lab")
                )
              )
            ),
      h("p", { className: "dj-foot" }, "Recipes come from Spotify's automix engine. Beat-matched pairs blend on the beat on Premium; everything else gets a smooth fade.")
    );
  }

  function Stat({ big, label, hint }) {
    return h("div", { className: "dj-stat", title: hint }, h("b", null, big), h("span", null, label));
  }

  // ------------------------------------------------------------ Mix Lab tab

  function Lab({ seed }) {
    useTick(300);
    const [a, setA] = useState(seed?.a || null);
    const [b, setB] = useState(seed?.b || null);
    const [ov, setOv] = useState(undefined);
    const [err, setErr] = useState("");
    const [pool, setPool] = useState([]);
    const d = api();
    const s = d.status();

    useEffect(() => {
      readQueue(50).then(({ current, next }) => {
        const list = [current, ...next].filter(Boolean);
        setPool(list);
        if (!seed) {
          setA((x) => x || list[0] || null);
          setB((x) => x || list[1] || null);
        }
      });
    }, []);
    useEffect(() => {
      if (seed) {
        setA(seed.a);
        setB(seed.b);
      }
    }, [seed]);
    useEffect(() => {
      setOv(undefined);
      setErr("");
      if (!a || !b) return;
      let live = true;
      d.getTransition(a.uri, b.uri).then((tr) => live && setOv(tr?.overlap?.startAMs > 0 ? tr.overlap : null));
      return () => void (live = false);
    }, [a?.uri, b?.uri]);

    const shuffle = () => {
      if (pool.length < 2) return;
      const i = Math.floor(Math.random() * pool.length);
      let j = Math.floor(Math.random() * (pool.length - 1));
      if (j >= i) j++;
      setA(pool[i]);
      setB(pool[j]);
    };
    const play = async () => {
      setErr("");
      try {
        await d.lab.play(a.uri, b.uri, { aName: a.name, bName: b.name });
      } catch (e) {
        setErr(e?.message || String(e));
      }
    };
    const playing = s.lab && s.lab.a === a?.uri && s.lab.b === b?.uri;
    const settings = d.settings;

    return h(
      "div",
      { className: "dj-lab" },
      h("p", { className: "dj-lead" }, "Pick any two songs and hear how DJ Mix would blend them. Paste a Spotify song link, or pick from your queue."),
      h(
        "div",
        { className: "dj-lab-pick" },
        h(Picker, { side: "A", value: a, pool, onChange: setA }),
        h("button", { className: "dj-swap", title: "Swap A and B", onClick: () => (setA(b), setB(a)) }, "⇄"),
        h(Picker, { side: "B", value: b, pool, onChange: setB })
      ),
      h(Recipe, { a, b, ov, lab: playing ? s.lab : null }),
      h(
        "div",
        { className: "dj-actions" },
        playing
          ? h("button", { className: "dj-btn primary", onClick: () => d.lab.stop() }, `■ Stop (${s.lab.phase})`)
          : h("button", { className: "dj-btn primary", disabled: !a || !b || a.uri === b.uri || ov === undefined, onClick: play }, "▶ Hear this mix"),
        h("button", { className: "dj-btn", onClick: shuffle, disabled: pool.length < 2 }, "🎲 Random pair"),
        h("span", { className: "dj-lab-engine" }, s.hasNative && s.account !== "free" && settings.engine !== "fade" && ov
          ? "Plays through Spotify's beat-match engine"
          : `Plays as a ${settings.fadeSec}s ${labelCurve(settings.fadeCurve)} fade`)
      ),
      err && h("p", { className: "dj-err" }, err),
      h(
        "div",
        { className: "dj-card" },
        h("h3", null, "Fade shape playground"),
        h("p", { className: "dj-muted" }, "How the volume moves during a Smooth fade. Green is the song going out, blue is the song coming in."),
        h("div", { className: "dj-curves" },
          d.curves.map((c) =>
            h("button", { key: c, className: cx("dj-curve-pick", settings.fadeCurve === c && "on"), onClick: () => d.set("fadeCurve", c) },
              h(CurveGraph, { name: c, width: 150, height: 60 }), h("span", null, labelCurve(c)))))
      )
    );
  }
  const labelCurve = (c) => ({ power: "equal-power", linear: "linear", smooth: "S-curve", late: "late-drop" })[c] || c;

  function Picker({ side, value, pool, onChange }) {
    const [text, setText] = useState("");
    const [open, setOpen] = useState(false);
    const submit = async () => {
      const uri = parseTrack(text);
      if (!uri) return;
      setText("");
      onChange(pool.find((t) => t.uri === uri) || (await lookupTrack(uri)));
    };
    return h(
      "div",
      { className: "dj-picker" },
      h("div", { className: "dj-deck-head" }, h("span", { className: "dj-deck-side" }, side)),
      h("button", { className: "dj-picker-cur", onClick: () => setOpen(!open), "aria-expanded": open },
        h(Art, { track: value, size: 52 }),
        h("span", null, h("b", null, value?.name || "Pick a song"), h("small", null, value?.artist || "")),
        h("i", null, "▾")),
      open && h("ul", { className: "dj-picker-list" },
        pool.length ? pool.map((t, i) =>
          h("li", { key: `${t.uri}-${i}` },
            h("button", { onClick: () => (onChange(t), setOpen(false)) }, h(Art, { track: t, size: 32 }),
              h("span", null, h("b", null, t.name), h("small", null, t.artist)))))
          : h("li", { className: "dj-muted" }, "Your queue is empty")),
      h("div", { className: "dj-paste" },
        h("input", { placeholder: "Paste a Spotify song link…", value: text, onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => e.key === "Enter" && submit(), "aria-label": `Song ${side} link` }),
        h("button", { className: "dj-btn small", onClick: submit, disabled: !parseTrack(text) }, "Use"))
    );
  }

  /** Song A's tail and song B's head drawn on one timeline, lined up at the overlap. */
  function Recipe({ a, b, ov, lab }) {
    if (!a || !b) return h("div", { className: "dj-card dj-muted" }, "Pick two songs.");
    if (ov === undefined) return h("div", { className: "dj-card dj-muted" }, "Asking Spotify for the transition…");
    if (!ov) return h("div", { className: "dj-card" }, h("b", null, "Spotify has no transition recipe for this pair."),
      h("p", { className: "dj-muted" }, "DJ Mix would fade at the end of song A instead. You can still hear it."));
    const span = 30000; // window shown: 30 s around the mix
    const pre = Math.min(12000, ov.startAMs);
    const t0 = ov.startAMs - pre; // timeline zero, in song A time
    const x = (ms) => `${Math.max(0, Math.min(100, (ms / span) * 100))}%`;
    const durA = a.duration || ov.startAMs + ov.durationMs + 5000;
    const aEnd = Math.min(durA - t0, pre + (ov.durationMs || 0)); // A is gone once the overlap ends
    const bStart = pre; // B starts (at startBMs) when A reaches startAMs
    return h(
      "div",
      { className: "dj-card dj-recipe" },
      h("div", { className: "dj-badges" }, h(RecipeBadges, { ov }),
        ov.startBMs > 1000 ? h(Badge, null, `B enters at ${fmt(ov.startBMs)}`) : null),
      h("div", { className: "dj-lanes" },
        h("div", { className: "dj-lane a" }, h("i", { style: { left: 0, width: x(aEnd) } }, `A · ${a.name}`)),
        h("div", { className: "dj-lane b" }, h("i", { style: { left: x(bStart), width: `calc(100% - ${x(bStart)})` } }, `B · ${b.name}`)),
        h("div", { className: "dj-overlap", style: { left: x(pre), width: x(ov.durationMs) } }),
        lab ? h("div", { className: "dj-lab-phase" }, `▶ ${lab.mode === "native" ? "beat-match" : "fade"} · ${lab.phase}`) : null),
      h("div", { className: "dj-tl-times" },
        h("span", null, `A ${fmt(t0)}`), h("span", null, `mix at A ${fmt(ov.startAMs)}`), h("span", null, `+${span / 1000}s`))
    );
  }

  // ------------------------------------------------------------ Settings tab

  function Settings() {
    const [, bump] = useState(0);
    const d = api();
    const s = d.settings;
    const set = (k) => (v) => (d.set(k, v), bump((n) => n + 1));
    return h(
      "div",
      { className: "dj-settings" },
      h("section", { className: "dj-card" },
        h("h3", null, "Mixing"),
        h(Toggle, { label: "Mix songs like a DJ", hint: "Ctrl+Alt+D toggles it anywhere", on: s.enabled, onChange: set("enabled") }),
        h(Segmented, { label: "Mix engine", hint: "Beat-match needs Premium; Smooth fade works on any account",
          value: s.engine, options: [["auto", "Auto"], ["native", "Beat-match"], ["fade", "Smooth fade"]], onChange: set("engine") }),
        h(Toggle, { label: "Fade songs beat-match can't mix", hint: "Songs from your queue, pairs with no transition", on: s.fallbackFade, onChange: set("fallbackFade") })),
      h("section", { className: "dj-card" },
        h("h3", null, "Smooth fade"),
        h(Slider, { label: "Fade length", value: s.fadeSec, min: 1, max: 20, step: 1, onChange: set("fadeSec"), show: (v) => `${v}s` }),
        h(Segmented, { label: "Fade shape", value: s.fadeCurve, options: d.curves.map((c) => [c, labelCurve(c)]), onChange: set("fadeCurve") }),
        h("div", { className: "dj-curve-preview" }, h(CurveGraph, { name: s.fadeCurve })),
        h(Toggle, { label: "Skip quiet intros", hint: "Start the next song where Spotify's recipe says", on: s.smartEntry, onChange: set("smartEntry") })),
      h("section", { className: "dj-card" },
        h("h3", null, "Beat-match filters"),
        h(Toggle, { label: "Only mix when Spotify can beat-match", on: s.beatOnly, onChange: set("beatOnly") }),
        h(Slider, { label: "Largest tempo change allowed", hint: "0 = any", value: s.maxTempo, min: 0, max: 12, step: 1, onChange: set("maxTempo"),
          show: (v) => (v ? `±${v}%` : "Any") })),
      h("section", { className: "dj-card" },
        h("h3", null, "Display"),
        h(Toggle, { label: "Notification on each mix", on: s.notify, onChange: set("notify") }),
        h(Toggle, { label: "Show the next mix on the seek bar", on: s.marker, onChange: set("marker") })),
      h("div", { className: "dj-actions" },
        h("button", { className: "dj-btn", onClick: () => {
          for (const [k, v] of Object.entries(d.defaults)) if (k !== "enabled") d.set(k, v);
          bump((n) => n + 1);
          S.showNotification("DJ Mix settings reset to defaults");
        } }, "Reset to defaults"),
        h("span", { className: "dj-muted" }, `DJ Mix v${d.version} · settings save automatically`))
    );
  }

  // ------------------------------------------------------------ Stats tab

  function Stats() {
    const [, bump] = useState(0);
    useTick(2000);
    const d = api();
    const st = d.stats;
    const native = st.mixes - (st.fades || 0);
    const blend = st.overlapMs >= 60000 ? `${Math.round(st.overlapMs / 60000)} min` : `${Math.round(st.overlapMs / 1000)}s`;
    return h(
      "div",
      { className: "dj-stats" },
      h("div", { className: "dj-summary" },
        h(Stat, { big: st.mixes, label: "mixes" }),
        h(Stat, { big: native > 0 ? `${Math.round((st.beatmatched / native) * 100)}%` : "–", label: "beat-matched" }),
        h(Stat, { big: st.beatmatched ? `${(st.tempoSum / st.beatmatched).toFixed(1)}%` : "–", label: "avg tempo shift" }),
        h(Stat, { big: blend, label: "of blending" }),
        h(Stat, { big: st.fades || 0, label: "smooth fades" })),
      h("div", { className: "dj-card" },
        h("h3", null, "Recent mixes"),
        d.history.length
          ? h("ol", { className: "dj-rows compact" },
              d.history.map((x, i) =>
                h("li", { key: `${x.at}-${i}` },
                  h("div", { className: "dj-row-main" },
                    h("div", { className: "dj-row-title" }, h("span", null, x.from), " → ", h("b", null, x.to)),
                    h("div", { className: "dj-badges" },
                      x.kind === "fade"
                        ? h(Badge, { kind: "blue" }, `smooth fade${x.fadeSec ? ` ${x.fadeSec}s` : ""}`)
                        : x.beat ? h(Badge, { kind: "green" }, `${x.bpmA ?? "?"} → ${x.bpmB ?? "?"} BPM${x.tempo ? ` · ${pct(x.tempo)}` : ""}`)
                          : h(Badge, { kind: "blue" }, "crossfade"),
                      h(Badge, { kind: "muted" }, new Date(x.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })))))))
          : h("p", { className: "dj-muted" }, "No mixes yet. They'll show up here as they happen.")),
      h("div", { className: "dj-actions" },
        h("button", { className: "dj-btn", onClick: () => (d.clearHistory(), bump((n) => n + 1)) }, "Clear history"),
        h("button", { className: "dj-btn", onClick: () => (d.resetStats(), bump((n) => n + 1)) }, "Reset all-time stats"))
    );
  }

  // ------------------------------------------------------------ shell

  const LOGO = `<svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M2 5.25a1.25 1.25 0 0 1 1.25-1.25c4.2 0 6.6 2.7 8.05 5.4 1.45-2.7 3.85-5.4 8.05-5.4a1.25 1.25 0 1 1 0 2.5c-3.1 0-4.9 2.3-6.65 5.75 1.75 3.45 3.55 5.75 6.65 5.75a1.25 1.25 0 1 1 0 2.5c-4.2 0-6.6-2.7-8.05-5.4-1.45 2.7-3.85 5.4-8.05 5.4a1.25 1.25 0 1 1 0-2.5c3.1 0 4.9-2.3 6.65-5.75C8.15 8.8 6.35 6.5 3.25 6.5A1.25 1.25 0 0 1 2 5.25z"/></svg>`;

  const TABS = [
    ["live", "Live"],
    ["setlist", "Setlist"],
    ["lab", "Mix Lab"],
    ["settings", "Settings"],
    ["stats", "Stats"],
  ];

  function App() {
    const [ready, setReady] = useState(!!window.DJMix);
    const [tab, setTab] = useState(() => {
      try {
        return S.LocalStorage.get("djmix:app-tab") || "live";
      } catch {
        return "live";
      }
    });
    const [seed, setSeed] = useState(null);
    useEffect(() => {
      if (ready) return;
      const t = setInterval(() => window.DJMix && setReady(true), 300);
      return () => clearInterval(t);
    }, [ready]);
    const go = (t) => {
      setTab(t);
      try {
        S.LocalStorage.set("djmix:app-tab", t);
      } catch {}
    };
    const openLab = (a, b) => {
      setSeed({ a, b });
      go("lab");
    };

    if (!ready) {
      return h("div", { className: "dj-app" },
        h("div", { className: "dj-card dj-missing" },
          h("h2", null, "DJ Mix engine isn't running"),
          window.__djmix
            ? h("p", null, "An older DJ Mix (v0.5 or earlier) is installed as a separate extension. Remove it so this version can run: ",
                h("code", null, "spicetify config extensions djmix.js-"), " then ", h("code", null, "spicetify apply"), ".")
            : h("p", null, "Waiting for the DJ Mix extension to load. If this stays here, run ", h("code", null, "spicetify apply"),
                " or reinstall DJ Mix with the installer.")));
    }

    return h(
      "div",
      { className: "dj-app" },
      h(
        "header",
        { className: "dj-header" },
        h("div", { className: "dj-brand" }, h("span", { className: "dj-logo", "aria-hidden": true, dangerouslySetInnerHTML: { __html: LOGO } }),
          h("div", null, h("h1", null, "DJ Mix"), h("small", null, "Your playlists, mixed like a DJ set"))),
        h("nav", { className: "dj-tabs", role: "tablist" },
          TABS.map(([id, label]) =>
            h("button", { key: id, role: "tab", "aria-selected": tab === id, className: cx(tab === id && "on"), onClick: () => go(id) }, label)))
      ),
      h(
        "main",
        { className: "dj-body" },
        tab === "live" && h(Live),
        tab === "setlist" && h(Setlist, { onLab: openLab }),
        tab === "lab" && h(Lab, { seed }),
        tab === "settings" && h(Settings),
        tab === "stats" && h(Stats)
      )
    );
  }

  return { default: () => h(App) };
})();

// Spicetify calls the global `render` to mount a custom app.
// eslint-disable-next-line no-unused-vars
function render() {
  return djmixApp.default();
}
