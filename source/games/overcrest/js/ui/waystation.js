/* Overcrest — waystation and summary screens.
 *
 * Pure DOM: the run layer decides what is offered; this shows it and
 * reports the choice back. Kept deliberately concise — a waystation is a
 * pause for breath, not a shop.
 */

const $ = (id) => document.getElementById(id);

const NAMES_A = ["Sawmill", "Lakeshore", "Birch", "Ferry", "Marsh", "Kettle", "Owl", "North", "Elk", "Charcoal", "Winter", "Quarry"];
const NAMES_B = ["Service", "Garage", "Halt", "Stop", "Depot", "Yard"];

export function waystationName(index, seedHash) {
  const a = NAMES_A[(seedHash + index * 7) % NAMES_A.length];
  const b = NAMES_B[(seedHash * 3 + index * 5) % NAMES_B.length];
  return a + " " + b;
}

export function makeWaystationUI() {
  const el = {
    screen: $("waystation"), over: $("wsOver"), name: $("wsName"),
    dist: $("wsDist"), score: $("wsScore"), cond: $("wsCond"), saves: $("wsSaves"), time: $("wsTime"), sweepStat: $("wsSweepStat"), sweep: $("wsSweep"), note: $("wsNote"),
    routes: $("routeCards"), end: $("btnEndHere"), seed: $("wsSeed"), noCard: $("btnNoCard"),
    stageCards: $("wsStageCards"), stageRoutes: $("wsStageRoutes"), cards: $("wsCards"), build: $("wsBuild"),
    numbers: $("wsNumbers"), album: $("sumAlbum"),
    sum: $("summary"), sumOver: $("sumOver"), sumTitle: $("sumTitle"), sumGrid: $("sumGrid"), sumSeen: $("sumSeen"),
    again: $("btnAgain"), same: $("btnSameSeed"), share: $("btnShare"), card: $("btnCard"), map: $("sumMap"),
  };

  /* The route, drawn as the line it was. North is wherever the journey
   * went — the line is normalised to fit, because the shape is the story
   * and the compass is not. On the summary's paper it reads as the recce
   * marker's red line: start an open circle, the end inked solid. */
  function drawMap(path) {
    const cv = el.map;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!path || path.length < 3) { cv.style.display = "none"; return; }
    cv.style.display = "block";
    let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    for (const [x, z] of path) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const pad = 14;
    const sc = Math.min((cv.width - pad * 2) / Math.max(1, x1 - x0), (cv.height - pad * 2) / Math.max(1, z1 - z0));
    const ox = (cv.width - (x1 - x0) * sc) / 2, oz = (cv.height - (z1 - z0) * sc) / 2;
    const px = (p) => [ox + (p[0] - x0) * sc, oz + (p[1] - z0) * sc];
    ctx.beginPath();
    ctx.strokeStyle = "rgba(168,64,47,0.85)";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    const [sx, sy] = px(path[0]);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < path.length; i++) { const [x, y] = px(path[i]); ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.strokeStyle = "#2b2418";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 3.4, 0, Math.PI * 2); ctx.stroke();
    const [ex, ey] = px(path[path.length - 1]);
    ctx.fillStyle = "#2b2418";
    ctx.beginPath(); ctx.arc(ex, ey, 3.6, 0, Math.PI * 2); ctx.fill();
  }

  /* The share card: the journey as one image — the line it drew, the
   * numbers that matter, the seed to drive it yourself. Composed on a
   * canvas and saved as a PNG; nothing leaves the machine unless the
   * player posts it somewhere. */
  function composeCard(card, path) {
    const W = 1200, H = 630;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const DISP = '"Saira Condensed", "Arial Narrow", sans-serif';
    const TYPE = '"Courier Prime", "Courier New", monospace';
    const PROSE = '"Lora", Georgia, serif';
    // paper stock, warmed at the centre, browned at the edges
    ctx.fillStyle = "#ede4cf";
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createRadialGradient(W / 2, H / 2, 160, W / 2, H / 2, 780);
    grad.addColorStop(0, "rgba(255,246,224,0.5)");
    grad.addColorStop(1, "rgba(96,74,42,0.22)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // the roadbook's punched holes along the top edge
    ctx.fillStyle = "rgba(24,19,11,0.42)";
    for (let x = 36; x < W; x += 46) {
      ctx.beginPath(); ctx.arc(x, 22, 6, 0, Math.PI * 2); ctx.fill();
    }
    // the page's edge rule
    ctx.strokeStyle = "rgba(43,36,24,0.55)";
    ctx.lineWidth = 3;
    ctx.strokeRect(9, 9, W - 18, H - 18);
    // the route — the recce marker's red line, centre-right
    if (path && path.length > 2) {
      let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
      for (const [x, z] of path) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const bx = 560, by = 90, bw = 560, bh = 450;
      const sc = Math.min(bw / Math.max(1, x1 - x0), bh / Math.max(1, z1 - z0));
      const ox = bx + (bw - (x1 - x0) * sc) / 2, oz = by + (bh - (z1 - z0) * sc) / 2;
      const px = (p) => [ox + (p[0] - x0) * sc, oz + (p[1] - z0) * sc];
      ctx.beginPath();
      ctx.strokeStyle = "rgba(168,64,47,0.88)";
      ctx.lineWidth = 4.5;
      ctx.lineJoin = "round";
      const [sx, sy] = px(path[0]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < path.length; i++) { const [x, y] = px(path[i]); ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.strokeStyle = "#2b2418";
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.stroke();
      const [ex, ey] = px(path[path.length - 1]);
      ctx.fillStyle = "#2b2418";
      ctx.beginPath(); ctx.arc(ex, ey, 7.5, 0, Math.PI * 2); ctx.fill();
    }
    // the words: typewritten officialdom, the plate marque, the serif moment
    ctx.fillStyle = "#8a7d64";
    ctx.font = "700 21px " + TYPE;
    ctx.fillText("A N   E N D L E S S   R A L L Y", 64, 102);
    ctx.fillStyle = "#2b2418";
    ctx.font = "700 96px " + DISP;
    ctx.fillText("OVERCREST", 60, 188);
    ctx.fillStyle = "#a8402f";
    ctx.font = "700 62px " + DISP;
    ctx.fillText((card.dist / 1000).toFixed(1) + " km", 64, 276);
    ctx.fillStyle = "#5c5240";
    ctx.font = "400 25px " + TYPE;
    ctx.fillText(Math.round(card.score).toLocaleString() + " points · " + card.waystations + " waystations", 64, 320);
    ctx.fillText(card.countries, 64, 356);
    if (card.moment) {
      ctx.fillStyle = "#6b5f49";
      ctx.font = "italic 400 25px " + PROSE;
      // wrap the one moment onto two lines if it runs long
      const words = card.moment.split(" ");
      let line = "", y = 424;
      for (const w of words) {
        const t = line ? line + " " + w : w;
        if (ctx.measureText(t).width > 430) { ctx.fillText(line, 64, y); y += 33; line = w; }
        else line = t;
      }
      if (line) ctx.fillText(line, 64, y);
    }
    ctx.fillStyle = "#8a7d64";
    ctx.font = "700 21px " + TYPE;
    ctx.fillText("seed  " + card.seed, 64, 556);
    ctx.fillText("quinnsavitt.com/games/overcrest", 64, 590);
    return cv;
  }

  function pips(n) {
    let h = "";
    for (let i = 1; i <= 4; i++) h += `<i class="${i <= n ? "on" : ""}"></i>`;
    return h;
  }

  /* Tulip diagrams: each route archetype drawn the way a roadbook draws a
   * junction — a dot where you are, an arrow where the road goes, and the
   * character of the road in the line between. Ink on the page. */
  const TULIP = {
    flow:   { d: "M14,56 C14,42 30,46 30,32 C30,22 20,24 20,12", s: [14, 56], e: [20, 12] },
    tech:   { d: "M16,56 V46 H30 V36 H16 V26 H28 V12", s: [16, 56], e: [28, 12] },
    fast:   { d: "M22,56 V12", s: [22, 56], e: [22, 12] },
    crests: { d: "M22,56 V12", s: [22, 56], e: [22, 12], x: "M14,41 C17,34 27,34 30,41 M14,27 C17,20 27,20 30,27" },
    calm:   { d: "M16,56 C16,42 27,38 27,26 C27,17 22,16 22,12", s: [16, 56], e: [22, 12], x: "M7,24 a5.5,3.8 0 1 0 11,0 a5.5,3.8 0 1 0 -11,0" },
    mixed:  { d: "M15,56 V44 C15,36 29,38 29,28 V12", s: [15, 56], e: [29, 12] },
  };
  function tulipSvg(key) {
    const t = TULIP[key] || TULIP.mixed;
    return `<svg viewBox="0 0 44 64" aria-hidden="true">` +
      (t.x ? `<path d="${t.x}" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"/>` : "") +
      `<path d="${t.d}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<circle cx="${t.s[0]}" cy="${t.s[1]}" r="2.7" fill="currentColor"/>` +
      `<path d="M${t.e[0] - 4.5},${t.e[1] + 7.5} L${t.e[0]},${t.e[1] - 1} L${t.e[0] + 4.5},${t.e[1] + 7.5} Z" fill="currentColor"/>` +
      `</svg>`;
  }

  function kindLabel(c) {
    if (c.kind === "part") return ["PART", "part"];
    if (c.kind === "service") return ["SERVICE", "service"];
    // the Sweep's own wing wears its contract on the label
    return [(c.modeOnly === "sweep" ? "SWEEP SOUVENIR · " : "SOUVENIR · ") + c.rarity.toUpperCase(), c.rarity];
  }

  function renderBuild(list) {
    el.build.innerHTML = list.length
      ? list.map((d) => `<span class="sv ${d.kind === "part" ? "part" : ""}" title="${d.rule.replace(/"/g, "&quot;")}">${d.name}</span>`).join("")
      : `<span class="none">Stock Kestrel. Nothing bolted on yet.</span>`;
  }

  /* opts: {index, name, dist, score, cond, note, cards[], routes[], build[], seedStr,
   *        onCard(i, def), onRoute(i, route), onEnd()} */
  function show(opts) {
    el.over.textContent = "Waystation " + (opts.index + 1);
    el.name.textContent = opts.name;
    el.dist.textContent = (opts.dist / 1000).toFixed(1) + " km";
    el.score.textContent = Math.round(opts.score).toLocaleString();
    el.cond.textContent = Math.round(opts.cond) + "%";
    // saves in hand: earned at the milestone stops, or given by a souvenir
    if (el.saves) el.saves.textContent = String(opts.saves != null ? opts.saves : 0);
    // the logbook clock: arrival → departure (the stop takes half an hour)
    if (el.time) el.time.textContent = opts.time || "–";
    // the Sweep's pace for the leg ahead (Sweep runs only)
    if (el.sweepStat) {
      el.sweepStat.style.display = opts.sweep ? "" : "none";
      if (el.sweep) el.sweep.textContent = opts.sweep || "";
    }
    el.note.textContent = opts.note;
    el.seed.textContent = opts.seedStr;
    renderBuild(opts.build || []);
    // the spec sheet: main hands finished [label, value] pairs
    if (el.numbers) el.numbers.innerHTML = (opts.numbers || [])
      .map(([k, v]) => `<span class="${v === "stock" ? "stock" : ""}">${k}<b>${v}</b></span>`).join("");
    // stage 1: cards
    el.cards.innerHTML = "";
    const cards = opts.cards || [];
    if (cards.length) {
      el.stageCards.style.display = "block";
      el.stageRoutes.style.display = "none";
      cards.forEach((c, i) => {
        const [label, cls] = kindLabel(c);
        const b = document.createElement("button");
        b.className = "card";
        b.innerHTML =
          `<div class="kind ${cls}">${label}${c.syn ? ` <span class="syn" title="synergy">◆</span>` : ""}</div>` +
          `<div class="name">${c.name}</div>` +
          `<div class="rule">${c.rule}</div>` +
          `<div class="blurb">${c.blurb || ""}</div>`;
        b.addEventListener("click", () => {
          opts.onCard(i, c);
          el.stageCards.style.display = "none";
          el.stageRoutes.style.display = "block";
          renderBuild(opts.build || []);
        });
        el.cards.appendChild(b);
      });
    } else {
      el.stageCards.style.display = "none";
      el.stageRoutes.style.display = "block";
    }
    // taking nothing is a real choice (owner asked for it): straight to
    // the roads, the shelf left as found, nothing reported to the run
    if (el.noCard) el.noCard.onclick = () => {
      el.stageCards.style.display = "none";
      el.stageRoutes.style.display = "block";
      // still nothing reported to the run; the marshals' book only notes the choice
      if (opts.onNoCard && cards.length) opts.onNoCard();
    };
    el.routes.innerHTML = "";
    opts.routes.forEach((r, i) => {
      const b = document.createElement("button");
      b.className = "route";
      b.innerHTML =
        `<div class="tulip">${tulipSvg(r.key)}</div>` +
        `<div class="r-body">` +
        `<div class="tag">${r.tag}${r.changes ? " · INTO " + r.biomeName.toUpperCase() : ""}` +
        `${r.suits ? ` <span class="suits" title="suits the build">◆</span>` : ""}</div>` +
        `<div class="name">${r.name}</div>` +
        `<div class="desc">${r.desc}</div>` +
        `<div class="meta"><span>${(r.len / 1000).toFixed(1)} km · ${r.reward}</span><span class="danger">${pips(r.danger)}</span></div>` +
        `</div>`;
      b.addEventListener("click", () => { hide(); opts.onRoute(i, r); });
      el.routes.appendChild(b);
    });
    el.end.onclick = () => { hide(); opts.onEnd(); };
    el.screen.classList.add("on");
  }
  function hide() { el.screen.classList.remove("on"); }

  function showSummary(opts) {
    el.sumOver.textContent = opts.over || "The journey ends";
    el.sumTitle.textContent = opts.title;
    el.sumGrid.innerHTML = opts.stats.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join("");
    /* The diary. Every landmark this journey drove, named and dated by
     * light and weather — the part of a summary worth reading rather than
     * scanning. Absent entirely when there is nothing to say, because an
     * empty "LANDMARKS: none" heading is a reproach and this is a record,
     * not a scorecard. */
    const seen = opts.seen || [];
    const moments = opts.moments || [];
    let seenHtml = "";
    /* The moments first: the three sentences the journey earned. */
    if (moments.length) {
      seenHtml += `<h4>Moments</h4><ul>${moments.map((t) => `<li>${t}</li>`).join("")}</ul>`;
    }
    if (seen.length) {
      const shown = seen.slice(-6);
      seenHtml +=
        `<h4>Landmarks</h4><ul>${shown.map((t) => {
          const i = t.indexOf(" · ");
          return i < 0 ? `<li>${t}</li>` : `<li>${t.slice(0, i)}<span>${t.slice(i)}</span></li>`;
        }).join("")}</ul>` +
        (seen.length > shown.length ? `<div class="more">and ${seen.length - shown.length} more</div>` : "");
    }
    /* the marshals' book: what this journey was marked for. Name and the
     * line under it, nothing else; a journey that earned nothing shows
     * no heading at all (a record, not a scorecard) */
    const earned = opts.earned || [];
    if (earned.length) {
      seenHtml += `<h4>Marked for</h4><ul class="ach-earned">${earned.map((a) =>
        `<li><b>${a.name}</b><span> · ${a.desc}</span></li>`).join("")}</ul>`;
    }
    el.sumSeen.innerHTML = seenHtml;
    /* the crew's album: the stills from every cinematic cut the driver
     * rode out — this run only, gone with the page (film, not archive) */
    if (el.album) {
      const album = opts.album || [];
      el.album.innerHTML = album.length
        ? `<h4>The crew's album</h4><div class="album">` + album.map((a, i) =>
          `<figure data-i="${i}" title="Open full size"><img src="${a.img}" alt="${a.kind} still"><figcaption>${a.kind} · ${a.km} km</figcaption></figure>`).join("") + `</div>`
        : "";
      /* clicking a still opens it full size in a new tab (owner ask). A
       * data: URL cannot be a top-level page any more, so it rides a blob
       * URL — and the open happens inside the click, or blockers eat it. */
      el.album.onclick = (e) => {
        const fig = e.target.closest ? e.target.closest("figure[data-i]") : null;
        if (!fig) return;
        const a = album[parseInt(fig.dataset.i, 10)];
        if (!a || !a.img) return;
        try {
          const mime = (/^data:(.*?);/.exec(a.img) || [])[1] || "image/jpeg";
          const bin = atob(a.img.slice(a.img.indexOf(",") + 1));
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([buf], { type: mime }));
          window.open(url, "_blank");
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (err) { /* a blocked popup or a mangled still: the thumbnail stays */ }
      };
    }
    drawMap(opts.path);
    if (el.share) {
      el.share.style.display = opts.shareUrl ? "" : "none";
      el.share.onclick = () => {
        try {
          navigator.clipboard.writeText(opts.shareUrl);
          el.share.textContent = "Link copied";
          setTimeout(() => { el.share.textContent = "Copy link"; }, 1600);
        } catch (e) { /* clipboard unavailable: the seed is on screen anyway */ }
      };
    }
    if (el.card) {
      el.card.style.display = opts.card ? "" : "none";
      el.card.onclick = () => {
        try {
          const cv = composeCard(opts.card, opts.path);
          cv.toBlob((blob) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "overcrest-" + (opts.card.seed || "journey").replace(/[^\w-]+/g, "-") + ".png";
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          });
          el.card.textContent = "Card saved";
          setTimeout(() => { el.card.textContent = "Save card"; }, 1600);
        } catch (e) { /* canvas/download unavailable: the summary is still on screen */ }
      };
    }
    el.again.onclick = () => { el.sum.classList.remove("on"); opts.onAgain(); };
    el.same.onclick = () => { el.sum.classList.remove("on"); opts.onSame(); };
    el.sum.classList.add("on");
  }

  return { show, hide, showSummary };
}
