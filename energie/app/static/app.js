"use strict";

const $ = (id) => document.getElementById(id);

const fmtGetal = (v, d) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
const euro = (v, d = 3) => (v == null ? "–" : (v < 0 ? "−€" : "€") + fmtGetal(Math.abs(v), d));
const watt = (w) => (w == null ? "–" : Math.round(Math.abs(w)).toLocaleString(locale()) + " W");
const kwh = (v, d = 3) => (v == null ? "–" : fmtGetal(v, d) + " kWh");
const kwh3 = (v) => kwh(v, 3);
const niveau = (l) => t("niveau." + l);

let tab = "nu";
let dag = "vandaag";
let nuTimer = null;
let prijsTimer = null;

async function haal(pad) {
  const r = await fetch(pad, { cache: "no-store" });
  if (!r.ok) throw new Error(pad + " gaf " + r.status);
  return r.json();
}
const metTaal = (pad) => pad + (pad.includes("?") ? "&" : "?") + "taal=" + TAAL;

/* ---------- Thema ---------- */

const donkerMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let themaKeus = "auto";
try { themaKeus = localStorage.getItem("thema") || "auto"; } catch (e) { /* geen opslag */ }

function huidigThema() {
  if (themaKeus === "licht") return "light";
  if (themaKeus === "donker") return "dark";
  return donkerMedia && donkerMedia.matches ? "dark" : "light";
}

function pasThemaToe() {
  const thema = huidigThema();
  document.documentElement.dataset.theme = thema;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", thema === "dark" ? "#120C08" : "#FFF1E4");
  document.querySelectorAll("[data-thema]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.thema === themaKeus)));
  $("thema-uitleg").textContent = themaKeus === "auto"
    ? t("inst.uitleg_auto", { stand: t(thema === "dark" ? "inst.stand_donker" : "inst.stand_licht") })
    : t("inst.uitleg_vast");
}

if (donkerMedia) {
  const wissel = () => { if (themaKeus === "auto") pasThemaToe(); };
  if (donkerMedia.addEventListener) donkerMedia.addEventListener("change", wissel);
  else if (donkerMedia.addListener) donkerMedia.addListener(wissel);
}

document.querySelectorAll("[data-thema]").forEach((b) =>
  b.addEventListener("click", () => {
    themaKeus = b.dataset.thema;
    try { localStorage.setItem("thema", themaKeus); } catch (e) { /* geen opslag */ }
    pasThemaToe();
  })
);

/* ---------- Taal ---------- */

function pasTaalToe() {
  vertaalPagina();
  document.querySelectorAll("[data-taal]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.taal === TAAL)));
  pasThemaToe();
}

document.querySelectorAll("[data-taal]").forEach((b) =>
  b.addEventListener("click", () => {
    if (TAAL === b.dataset.taal) return;
    TAAL = b.dataset.taal;
    try { localStorage.setItem("taal", TAAL); } catch (e) { /* geen opslag */ }
    pasTaalToe();
    stroomSleutel = "";
    verversNu();
    verversStatus();
  })
);

/* ---------- Nu ---------- */

const NODES = {
  zon: { x: 170, y: 56, r: 46, kleur: "#E8A200" },
  bat: { x: 56, y: 196, r: 46, kleur: "#18946B" },
  net: { x: 284, y: 196, r: 46, kleur: "#4A6CF0" },
  huis: { x: 170, y: 308, r: 56, kleur: "#FF7A1A" },
};
const NAAM = { zon: "naam.zon", bat: "naam.batterij", net: "naam.net", huis: "naam.huis" };
const VERBINDINGEN = [["zon", "huis"], ["zon", "bat"], ["zon", "net"], ["bat", "huis"], ["bat", "net"], ["net", "huis"]];
const DREMPEL = 15; // watt; daaronder geen stroom tonen
let stroomSleutel = "";

/** Verdeelt de gemeten vermogens over de verbindingen: van welke bron naar welke bestemming. */
function verdeelStromen(v) {
  const pv = Math.max(v.zon, 0);
  let load = Math.max(v.huis, 0);
  const ontlaad = Math.max(v.batterij, 0);
  const laad = Math.max(-v.batterij, 0);
  const afname = Math.max(v.net, 0);
  const terug = Math.max(-v.net, 0);
  const s = {};
  let restZon = pv, restLaad = laad, restTerug = terug, restAfname = afname, restOntlaad = ontlaad;
  const neem = (van, naar, a, b) => { const x = Math.min(a, b); if (x > 0) s[van + ">" + naar] = x; return x; };
  let x = neem("zon", "huis", restZon, load); restZon -= x; load -= x;
  x = neem("zon", "bat", restZon, restLaad); restZon -= x; restLaad -= x;
  x = neem("zon", "net", restZon, restTerug); restZon -= x; restTerug -= x;
  x = neem("bat", "huis", restOntlaad, load); restOntlaad -= x; load -= x;
  x = neem("bat", "net", restOntlaad, restTerug); restOntlaad -= x; restTerug -= x;
  x = neem("net", "huis", restAfname, load); restAfname -= x; load -= x;
  x = neem("net", "bat", restAfname, restLaad); restAfname -= x; restLaad -= x;
  return s;
}

function rand(a, b, extra) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  return {
    x1: a.x + ux * (a.r + extra), y1: a.y + uy * (a.r + extra),
    x2: b.x - ux * (b.r + extra), y2: b.y - uy * (b.r + extra),
  };
}

function svg(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
  return el;
}

function tekenStromen(v, interval) {
  $("w-zon").textContent = watt(v.zon);
  $("w-huis").textContent = watt(v.huis);
  $("w-bat").textContent = watt(v.batterij);
  $("w-net").textContent = watt(v.net);
  $("bat-label").textContent = t("node.batterij") + (v.laadtoestand != null ? " " + Math.round(v.laadtoestand) + "%" : "");
  $("net-label").textContent = t(v.net > DREMPEL ? "node.afname" : v.net < -DREMPEL ? "node.terug" : "node.net");
  $("node-net").classList.toggle("actief", Math.abs(v.net) > DREMPEL);

  const stromen = verdeelStromen(v);
  const actief = Object.entries(stromen).filter(([, w]) => w >= DREMPEL);
  const periode = Math.max(1, (interval || 5) / 2); // twee keer per verversing
  const sleutel = actief.map(([k]) => k).sort().join(",") + "|" + periode;

  const zinnen = actief.map(([k, w]) => {
    const [van, naar] = k.split(">");
    return t("flow.stroom", { w: watt(w), van: t(NAAM[van]), naar: t(NAAM[naar]) });
  });
  $("flow").setAttribute("aria-label", t("flow.aria", { lijst: zinnen.join(", ") || t("flow.geen") }));

  // Lijnen: bij elke verversing bijwerken (dikte volgt het vermogen)
  const lijnen = $("flow-lijnen");
  lijnen.textContent = "";
  for (const [a, b] of VERBINDINGEN) {
    const heen = stromen[a + ">" + b] || 0, terug = stromen[b + ">" + a] || 0;
    const w = Math.max(heen, terug);
    const r = rand(NODES[a], NODES[b], 6);
    const attrs = { class: "lijn", x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 };
    if (w >= DREMPEL) {
      const bron = heen >= terug ? a : b;
      attrs.class = "lijn actief";
      attrs.stroke = NODES[bron].kleur;
      attrs["stroke-width"] = (2 + Math.min(w / 1000, 3) * 1.5).toFixed(1);
    }
    lijnen.appendChild(svg("line", attrs));
  }

  // Stippen alleen opnieuw opbouwen als de richting of het aantal stromen verandert,
  // anders springt de animatie bij elke verversing terug naar het begin.
  if (sleutel === stroomSleutel) return;
  stroomSleutel = sleutel;
  const stippen = $("flow-stippen");
  stippen.textContent = "";
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const [k] of actief) {
    const [van, naar] = k.split(">");
    const r = rand(NODES[van], NODES[naar], 4);
    const pad = `M${r.x1.toFixed(1)},${r.y1.toFixed(1)} L${r.x2.toFixed(1)},${r.y2.toFixed(1)}`;
    for (let i = 0; i < 3; i++) {
      // opacity 0 als basis: zo staat de stip niet linksboven in beeld voordat zijn animatie begint
      const stip = svg("circle", { r: 6.5 - i * 1.5, class: "stip", fill: NODES[van].kleur, "fill-opacity": 1 - i * 0.25, opacity: 0 });
      stip.appendChild(svg("animateMotion", {
        path: pad, dur: periode + "s", begin: (i * 0.12 * periode).toFixed(2) + "s",
        repeatCount: "indefinite", keyPoints: "0;1", keyTimes: "0;1", calcMode: "linear", fill: "freeze",
      }));
      stip.appendChild(svg("animate", {
        attributeName: "opacity", values: "0;1;1;0", keyTimes: "0;0.1;0.85;1",
        dur: periode + "s", begin: (i * 0.12 * periode).toFixed(2) + "s", repeatCount: "indefinite",
      }));
      stippen.appendChild(stip);
    }
  }
}

function tekenStrip(strip) {
  const box = $("strip");
  box.textContent = "";
  if (!strip.length) return;
  const vals = strip.map((h) => h.allin);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (const h of strip) {
    const i = document.createElement("i");
    i.className = h.level + (h.voorbij ? " voorbij" : "") + (h.nu ? " nu" : "");
    i.style.height = (8 + (hi > lo ? (h.allin - lo) / (hi - lo) : 0.5) * 28) + "px";
    i.title = h.uur + "  " + euro(h.allin);
    box.appendChild(i);
  }
}

function tekenNu(d) {
  const live = $("live");
  live.classList.toggle("uit", !d.ok);
  $("live-tekst").textContent = d.ok ? t("live.live", { tijd: d.tijd }) : d.tijd ? t("live.laatst", { tijd: d.tijd }) : t("live.geen");

  const fout = $("fout-nu");
  fout.hidden = d.ok || !d.fout;
  fout.textContent = d.fout ? t("nu.gatewayfout", { fout: d.fout }) : "";

  if (d.prijs) {
    $("prijs-nu").innerHTML = euro(d.prijs.allin) + "<small> /kWh</small>";
    $("niveau-nu").textContent = niveau(d.prijs.level);
  } else {
    $("prijs-nu").innerHTML = "–<small> /kWh</small>";
    $("niveau-nu").textContent = t("nu.geenprijs");
  }
  const nb = $("volgende");
  if (d.volgende) {
    nb.hidden = false;
    const v = d.volgende;
    const wanneer = (v.morgen ? t("nu.morgen") : "") + `<strong>${v.uur}</strong>`;
    nb.classList.toggle("goed", v.soort !== "duur_vanaf");
    $("volgende-tekst").innerHTML = t("nu." + v.soort, { wanneer, prijs: euro(v.allin) });
  } else {
    nb.hidden = true;
  }
  tekenStrip(d.strip || []);
  if (d.vermogen) tekenStromen(d.vermogen, d.interval);

  const td = d.vandaag;
  $("t-kosten").textContent = euro(td.kosten);
  $("t-verbruik").textContent = kwh(td.verbruik_kwh);
  $("t-zon").textContent = kwh(td.opgewekt_kwh);
  $("t-bat").textContent = kwh(td.batterij_uit_kwh);

  // Batterijscherm gebruikt dezelfde gegevens
  const soc = d.vermogen ? d.vermogen.laadtoestand : null;
  $("b-soc").textContent = soc == null ? "–" : Math.round(soc) + "%";
  $("b-vul").style.width = (soc || 0) + "%";
  $("b-balk").setAttribute("aria-label", soc == null ? t("bat.onbekend") : t("bat.laadtoestand_pct", { pct: Math.round(soc) }));
  if (d.vermogen) {
    const b = d.vermogen.batterij;
    $("b-vermogen").textContent = Math.abs(b) < 15 ? t("bat.rust") : t(b > 0 ? "bat.ontlaadt" : "bat.laadt", { w: watt(b) });
  }
  return d.interval;
}

async function verversNu() {
  clearTimeout(nuTimer);
  let interval = 5;
  try {
    interval = tekenNu(await haal("api/now")) || 5;
  } catch (e) {
    $("live").classList.add("uit");
    $("live-tekst").textContent = t("live.geen");
  }
  if (tab === "nu" || tab === "batterij") nuTimer = setTimeout(verversNu, Math.max(3, interval) * 1000);
}

/* ---------- Prijzen ---------- */

function tekenPrijzen(d) {
  const datum = new Date(d.dag + "T12:00:00");
  const label = datum.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
  $("prijs-datum").textContent = t("prijs.datum", { datum: label.charAt(0).toUpperCase() + label.slice(1) });

  const leeg = !d.uren.length;
  $("p-leeg").hidden = !leeg;
  $("p-leeg").textContent = d.verwacht_rond ? t("prijs.morgen_rond", { tijd: d.verwacht_rond }) : t("prijs.geen");
  $("p-grafiek").hidden = leeg;
  $("blokken").hidden = leeg;

  const s = d.samenvatting;
  $("p-laag").textContent = s ? euro(s.laagste) : "–";
  $("p-laag-uur").textContent = s ? s.laagste_uur : "";
  $("p-gem").textContent = s ? euro(s.gemiddeld) : "–";
  $("p-hoog").textContent = s ? euro(s.hoogste) : "–";
  $("p-hoog-uur").textContent = s ? s.hoogste_uur : "";
  if (leeg) { $("opbouw").hidden = true; return; }

  const vals = d.uren.map((h) => h.allin);
  const lo = Math.floor(Math.min(...vals) * 20) / 20;
  let hi = Math.ceil(Math.max(...vals) * 20) / 20;
  if (hi <= lo) hi = lo + 0.05;
  $("y-max").textContent = euro(hi);
  $("y-mid").textContent = euro((hi + lo) / 2);
  $("y-min").textContent = euro(lo);
  const bars = $("bars");
  bars.textContent = "";
  bars.setAttribute("aria-label", t("prijs.bars_aria", { laag: euro(s.laagste), laaguur: s.laagste_uur, hoog: euro(s.hoogste), hooguur: s.hoogste_uur }));
  const nuUur = new Date().getHours();
  for (const h of d.uren) {
    const i = document.createElement("i");
    const uur = parseInt(h.uur, 10);
    i.className = h.level + (d.is_vandaag && uur < nuUur ? " voorbij" : "") + (d.is_vandaag && uur === nuUur ? " nu" : "");
    i.style.height = Math.max(3, ((h.allin - lo) / (hi - lo)) * 140) + "px";
    i.title = `${h.uur}  ${euro(h.allin)}`;
    bars.appendChild(i);
  }

  const box = $("blokken");
  box.textContent = "";
  for (const b of d.blokken) {
    const rij = document.createElement("div");
    rij.className = "blok";
    const bedrag = b.min === b.max ? euro(b.min) : euro(b.min) + "–" + fmtGetal(b.max, 3);
    rij.innerHTML = `<span class="stip ${b.level}"></span><span class="tijd">${b.van}–${b.tot}</span><span class="lvl">${niveau(b.level)}</span><span class="bedrag">${bedrag}</span>`;
    box.appendChild(rij);
  }

  const o = $("opbouw");
  if (d.is_vandaag && d.nu) {
    o.hidden = false;
    const ob = d.nu.opbouw;
    $("opbouw-titel").textContent = t("prijs.opbouw", { van: d.nu.uur, tot: d.nu.tot });
    $("o-beurs").textContent = euro(ob.beurs, 3);
    $("o-inkoop").textContent = euro(ob.inkoop, 3);
    $("o-eb").textContent = euro(ob.energiebelasting, 3);
    $("o-totaal").textContent = euro(ob.totaal, 3);
    const tot = ob.totaal || 1;
    $("o1").style.width = Math.max(0, (ob.beurs / tot) * 100) + "%";
    $("o2").style.width = (ob.inkoop / tot) * 100 + "%";
    $("o3").style.width = (ob.energiebelasting / tot) * 100 + "%";
    $("o-terug").textContent = t(d.saldering ? "prijs.terug_saldering" : "prijs.terug", { prijs: euro(d.nu.terug) });
  } else {
    o.hidden = true;
  }
}

async function verversPrijzen() {
  clearTimeout(prijsTimer);
  try {
    tekenPrijzen(await haal("api/prices?dag=" + dag));
  } catch (e) {
    $("p-leeg").hidden = false;
    $("p-leeg").textContent = t("prijs.fout");
  }
  if (tab === "prijzen") prijsTimer = setTimeout(verversPrijzen, 10 * 60 * 1000);
}

/* ---------- Historie ---------- */

let periode = "dag";
let periodeDatum = null; // null = de lopende periode
let histTimer = null;
let histData = null;

function signedEuro(v) {
  if (v == null) return "–";
  return (v > 0 ? "+" : "") + euro(v, 3);
}

function zetOpbrengst(el, v) {
  el.textContent = signedEuro(v);
  el.classList.toggle("c-min", v != null && v < 0);
}

function tekenHistorie(d) {
  histData = d;
  if (d.lopend) periodeDatum = null;
  $("h-titel").textContent = d.titel;
  $("h-volgende").disabled = !d.volgende;
  $("h-vorige").disabled = !d.eerder_beschikbaar;
  const tt = d.totaal;
  $("h-kosten-label").textContent = t(d.lopend ? "hist.kosten_lopend" : "hist.kosten");
  $("h-kosten").textContent = tt.meetminuten ? euro(tt.kosten, 3) : "–";
  $("h-vergelijk").textContent = d.vergelijk ? `${d.vergelijk.label} ${euro(d.vergelijk.kosten, 3)}` : "";
  $("h-verbruik").textContent = kwh3(tt.verbruik_kwh);
  $("h-opgewekt").textContent = kwh3(tt.opgewekt_kwh);
  $("h-afname").textContent = kwh3(tt.afname_kwh);
  $("h-terug").textContent = kwh3(tt.terug_kwh);

  const reeks = d.reeks;
  const totalen = reeks.map((r) => r.zon + r.batterij + r.net);
  const max = Math.max(0.05, ...totalen);
  const stap = max <= 1 ? 0.1 : max <= 5 ? 0.5 : max <= 20 ? 2 : max <= 100 ? 10 : 50;
  const top = Math.ceil(max / stap) * stap;
  const dec = top < 1 ? 1 : 0;
  $("hy-max").textContent = fmtGetal(top, dec);
  $("hy-mid").textContent = fmtGetal(top / 2, dec);

  const bars = $("h-bars");
  bars.textContent = "";
  const eenheid = t(d.periode === "dag" ? "hist.per_uur" : d.periode === "jaar" ? "hist.per_maand" : "hist.per_dag");
  bars.setAttribute("aria-label", t("hist.bars_aria", { eenheid, totaal: kwh3(tt.verbruik_kwh) }));
  for (const r of reeks) {
    const kolom = document.createElement("i");
    const hoog = (v) => (v / top) * 140;
    kolom.style.height = hoog(r.zon + r.batterij + r.net) + "px";
    kolom.title = t("hist.tip", { label: r.label, zon: kwh3(r.zon), bat: kwh3(r.batterij), net: kwh3(r.net) }) + (r.heeft_data ? ", " + euro(r.kosten, 3) : "");
    for (const [cls, v] of [["zon", r.zon], ["bat", r.batterij], ["net", r.net]]) {
      if (v <= 0) continue;
      const b = document.createElement("b");
      b.className = cls;
      b.style.height = hoog(v) + "px";
      kolom.appendChild(b);
    }
    bars.appendChild(kolom);
  }

  const as = $("h-as");
  as.textContent = "";
  const n = reeks.length;
  const ticks = d.periode === "dag" ? [0, 6, 12, 18, n - 1] : d.periode === "maand" ? [0, 9, 19, n - 1] : reeks.map((_, i) => i);
  as.className = "axis pad dicht";
  reeks.forEach((r, i) => {
    const s = document.createElement("span");
    s.textContent = ticks.includes(i) ? r.label : "";
    as.appendChild(s);
  });

  const b = tt.batterij;
  $("h-laadnoot").textContent = b.uit_net_kwh > 0.05 ? t("hist.laadnoot", { kwh: kwh3(b.uit_net_kwh) }) : "";
  let dekking = "";
  if (!tt.meetminuten) dekking = t("hist.geen");
  else if (tt.uren_zonder_prijs) dekking = t("hist.zonderprijs", { uren: tt.uren_zonder_prijs });
  $("h-dekking").textContent = dekking;
}

async function verversHistorie() {
  clearTimeout(histTimer);
  try {
    const q = `api/history?periode=${periode}` + (periodeDatum ? `&datum=${periodeDatum}` : "");
    tekenHistorie(await haal(metTaal(q)));
  } catch (e) {
    $("h-dekking").textContent = t("hist.fout");
  }
  if (tab === "historie" && !periodeDatum) histTimer = setTimeout(verversHistorie, 60 * 1000);
}

document.querySelectorAll("[data-periode]").forEach((b) =>
  b.addEventListener("click", () => {
    periode = b.dataset.periode;
    periodeDatum = null;
    document.querySelectorAll("[data-periode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    verversHistorie();
  })
);
$("h-vorige").addEventListener("click", () => { if (histData) { periodeDatum = histData.vorige; verversHistorie(); } });
$("h-volgende").addEventListener("click", () => {
  if (histData && histData.volgende) { periodeDatum = histData.volgende; verversHistorie(); }
});

/* ---------- Batterij ---------- */

let batTimer = null;

function verliesTekst(v) {
  if (!v) return "–";
  return kwh3(v.kwh) + (v.procent != null ? `<small>${t("bat.van_lading", { pct: v.procent })}</small>` : "");
}

function tekenBatterij(d) {
  const v = d.vandaag;
  $("b-in").textContent = kwh3(v.geladen_kwh);
  $("b-uit").textContent = kwh3(v.ontladen_kwh);
  $("b-cycli").textContent = v.cycli == null ? "–" : fmtGetal(v.cycli, 3);
  zetOpbrengst($("b-op-vandaag"), v.opbrengst);

  const pts = d.curve.map((p) => `${((p.uur / 24) * 316).toFixed(1)},${(88 - p.soc * 0.8).toFixed(1)}`);
  $("b-lijn").setAttribute("points", pts.join(" "));
  const last = d.curve[d.curve.length - 1];
  const punt = $("b-punt");
  if (last) { punt.setAttribute("cx", ((last.uur / 24) * 316).toFixed(1)); punt.setAttribute("cy", (88 - last.soc * 0.8).toFixed(1)); }
  $("b-curve").setAttribute("aria-label", last ? t("bat.curve_nu", { pct: Math.round(last.soc) }) : t("bat.curve_geen"));

  const nacht = $("b-nacht");
  const n = d.nachtladen;
  if (n.vol_om) { nacht.textContent = t("bat.vol_om", { tijd: n.vol_om }); nacht.className = "status"; }
  else if (n.max_procent != null && new Date().getHours() >= 9) { nacht.textContent = t("bat.niet_vol", { pct: n.max_procent }); nacht.className = "status mis"; }
  else { nacht.textContent = ""; }

  const g = d.gisteren;
  zetOpbrengst($("g-op"), g.heeft_data ? g.opbrengst : null);
  $("g-in").textContent = g.heeft_data ? kwh3(g.geladen_kwh) : "–";
  $("g-uit").textContent = g.heeft_data ? kwh3(g.ontladen_kwh) : "–";
  $("g-verlies").innerHTML = g.heeft_data ? verliesTekst(g.verlies) : "–";
  $("g-cycli").textContent = g.heeft_data && g.cycli != null ? fmtGetal(g.cycli, 3) : "–";
  $("g-uitleg").textContent = !g.heeft_data
    ? t("bat.geen_gisteren")
    : g.laadprijs != null && g.gebruiksprijs != null
      ? t("bat.uitleg", { laad: euro(g.laadprijs, 3), gebruik: euro(g.gebruiksprijs, 3) })
      : "";

  const lijst = $("b-dagen");
  lijst.textContent = "";
  $("b-dagen-kaart").hidden = !d.dagen.length;
  for (const r of d.dagen) {
    const rij = document.createElement("div");
    rij.className = "blok";
    rij.innerHTML = `<span class="tijd">${r.dag}</span><span class="lvl">${t("bat.ontladen_kwh", { kwh: kwh3(r.ontladen_kwh) })}</span><span class="bedrag ${r.opbrengst != null && r.opbrengst < 0 ? "c-min" : "c-bat"}">${signedEuro(r.opbrengst)}</span>`;
    lijst.appendChild(rij);
  }
  zetOpbrengst($("b-samen"), d.dagen_samen);
}

async function verversBatterij() {
  clearTimeout(batTimer);
  try { tekenBatterij(await haal(metTaal("api/battery"))); } catch (e) { /* volgende keer opnieuw */ }
  if (tab === "batterij") batTimer = setTimeout(verversBatterij, 60 * 1000);
}

/* ---------- Status ---------- */

const ICOON = {
  ok: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  let_op: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>',
  fout: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};
let statusTimer = null;
let laatsteStatus = null;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function badge(id, status) {
  const el = $(id);
  const s = ["ok", "let_op", "fout"].includes(status) ? status : "onbekend";
  el.className = "badge " + s;
  el.textContent = t("status." + s);
}

function rijen(id, items) {
  const dl = $(id);
  dl.innerHTML = items
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls || ""}">${esc(v)}</dd>`)
    .join("") || `<dt>${esc(t("status.geen_gegevens"))}</dt><dd></dd>`;
}

const jaNee = (v, ja = "ja", nee = "nee") => (v === true ? t(ja) : v === false ? t(nee) : null);

function tekenStatus(d) {
  laatsteStatus = d;
  $("tab-melding").hidden = d.niveau === "ok";
  const ic = $("s-icoon");
  ic.className = "s-icoon " + d.niveau;
  ic.innerHTML = ICOON[d.niveau] || "";
  const n = d.meldingen.length;
  $("s-kop").textContent = d.niveau === "ok" ? t("status.alles") : n === 1 ? t("status.een") : t("status.meer", { n });
  $("s-tijd").textContent = t("status.tijd", { tijd: d.gecontroleerd });

  const box = $("s-meldingen");
  box.hidden = !n;
  box.innerHTML = d.meldingen
    .map((m) => `<div class="melding ${m.niveau}"><span class="stip"></span><div><small>${esc(m.onderdeel)}</small>${esc(m.tekst)}</div></div>`)
    .join("");

  // Omvormers
  const o = d.omvormers;
  badge("s-omv-badge", o.status);
  const maxW = Math.max(370, ...o.lijst.map((p) => p.max_watt || 0));
  $("s-panelen").innerHTML = o.lijst
    .map((p) => `<div class="paneel ${p.status}${p.slaapt ? " slaapt" : ""}" title="${esc(t("status.omvormer", { serie: p.serie }))}">
        <div class="kop"><span>${esc(t("status.paneel", { nr: p.nr }))}</span><span class="dot"></span></div>
        <b>${p.watt == null ? "–" : watt(p.watt)}</b>
        <div class="meter"><i style="width:${p.watt ? Math.min(100, (p.watt / maxW) * 100) : 0}%"></i></div>
        ${p.reden ? `<span class="reden">${esc(p.reden)}</span>` : `<span class="note">${esc(p.slaapt ? t("status.slaapt") : (p.laatste || ""))}</span>`}
      </div>`)
    .join("") || `<p class="note">${esc(t("status.geen_omv"))}</p>`;
  $("s-omv-noot").textContent = o.aantal && o.slapen
    ? t("status.omv_slapen", { aantal: o.aantal })
    : o.aantal
    ? t("status.omv_noot", { actief: o.actief, aantal: o.aantal, watt: watt(o.totaal_watt) })
    : o.ophaalfout ? t("status.niet_opgehaald", { fout: o.ophaalfout }) : "";

  // Batterij
  const b = d.batterij;
  badge("s-bat-badge", b.status);
  const bat = b.lijst[0];
  rijen("s-bat", bat ? [
    [t("rij.status"), bat.reden ? bat.reden : t("status.ok"), bat.status],
    [t("rij.laadtoestand"), bat.laadtoestand != null ? bat.laadtoestand + "%" : null],
    [t("rij.temperatuur"), bat.temperatuur != null ? bat.temperatuur + " °C" : null],
    [t("rij.capaciteit"), bat.capaciteit_kwh != null ? fmtGetal(bat.capaciteit_kwh, 1) + " kWh" : null],
    [t("rij.communiceert"), jaNee(bat.communiceert)],
    [t("rij.actief"), jaNee(bat.actief)],
    [t("rij.slaapstand"), jaNee(bat.slaapstand, "aan", "uit")],
    [t("rij.signaal"), bat.signaal != null ? t("rij.signaal_van", { n: bat.signaal }) : null],
    [t("rij.laatste"), bat.laatste],
    [t("rij.serie"), bat.serie],
  ] : [[t("rij.status"), b.ophaalfout ? t("status.niet_opgehaald_kort") : t("status.geen_batterij"), "let_op"]]);

  // Gateway
  const g = d.gateway;
  badge("s-gw-badge", g.status);
  rijen("s-gw", [
    [t("rij.bereikbaar"), t(g.bereikbaar ? "ja" : "nee"), g.bereikbaar ? "ok" : "fout"],
    [t("rij.laatste_meting"), g.laatste_meting],
    [t("rij.verbinding"), g.verbinding ? g.verbinding + (g.signaal ? t("rij.signaal_kort", { s: g.signaal }) : "") : null],
    [t("rij.cloud"), g.cloud == null ? null : t(g.cloud ? "rij.verbonden" : "rij.geen_verbinding"), g.cloud === false ? "let_op" : ""],
    [t("rij.laatste_cloud"), g.laatste_cloud],
    [t("rij.opslag"), g.opslag_procent != null ? t("rij.opslag_vol", { pct: g.opslag_procent }) : null],
    [t("rij.firmware"), g.firmware],
    [t("rij.serie"), g.serienummer],
    [t("rij.token"), g.token_verloopt ? t("rij.token_dagen", { datum: g.token_verloopt, dagen: g.token_dagen }) : null, g.token_dagen != null && g.token_dagen < 30 ? "let_op" : ""],
  ]);

  // Meters
  const m = d.meters;
  badge("s-met-badge", m.status);
  rijen("s-met", m.lijst.map((x) => [x.naam, t(x.aan ? "rij.meter_actief" : "rij.meter_uit"), x.aan ? "ok" : "let_op"]));

  // App
  const a = d.app;
  rijen("s-app", [
    [t("rij.versie"), a.versie],
    [t("rij.prijzen_vandaag"), t(a.prijzen_vandaag ? "rij.binnen" : "rij.ontbreken"), a.prijzen_vandaag ? "ok" : "let_op"],
    [t("rij.prijzen_morgen"), t(a.prijzen_morgen ? "rij.binnen" : "rij.nog_niet")],
    [t("rij.metingen_sinds"), a.metingen_sinds],
    [t("rij.database"), a.database_mb != null ? fmtGetal(a.database_mb, 1) + " MB" : null],
    ...haRijen(a.ha_historie),
  ]);

  // Instellingen: over de app
  $("i-versie").textContent = a.versie || "–";
  $("i-gateway").textContent = g.firmware || "–";
}

function haRijen(h) {
  if (!h) return [];
  if (h.status === "fout") return [[t("rij.ha"), t("rij.ha_fout", { fout: h.fout || "" }), "let_op"]];
  if (h.sinds) return [[t("rij.ha"), t("rij.ha_sinds", { datum: h.sinds }) + (h.status === "bezig" ? " · " + t("rij.ha_bezig") : ""), "ok"]];
  return [[t("rij.ha"), t(h.status === "bezig" ? "rij.ha_bezig" : "rij.ha_wacht")]];
}

async function verversStatus(vernieuw = false) {
  clearTimeout(statusTimer);
  if (vernieuw) $("s-kop").textContent = t("status.controleren");
  try { tekenStatus(await haal(metTaal("api/system" + (vernieuw ? "?vernieuw=1" : "")))); }
  catch (e) { $("s-kop").textContent = t("status.ophaalfout"); }
  statusTimer = setTimeout(() => verversStatus(false), (tab === "status" ? 60 : 300) * 1000);
}
$("s-vernieuw").addEventListener("click", () => verversStatus(true));

/* ---------- Navigatie ---------- */

const TABS = ["nu", "prijzen", "historie", "batterij", "status"];

function toon(naam) {
  tab = naam;
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== "scherm-" + naam;
  // Instellingen hoort bij Nu: het menu blijft Nu tonen
  const actieveTab = naam === "instellingen" ? "nu" : naam;
  for (const b of document.querySelectorAll(".tabs button")) {
    if (b.dataset.tab === actieveTab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (naam === "nu" || naam === "batterij") verversNu();
  if (naam === "prijzen") verversPrijzen();
  if (naam === "historie") verversHistorie();
  if (naam === "batterij") verversBatterij();
  if (naam === "status") verversStatus();
  if (naam === "instellingen") { pasTaalToe(); if (!laatsteStatus) verversStatus(); }
  if (TABS.includes(naam)) { try { localStorage.setItem("tab", naam); } catch (e) { /* geen opslag */ } }
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => toon(b.dataset.tab)));
$("naar-instellingen").addEventListener("click", () => toon("instellingen"));
$("terug-nu").addEventListener("click", () => toon("nu"));
document.querySelectorAll("[data-dag]").forEach((b) =>
  b.addEventListener("click", () => {
    dag = b.dataset.dag;
    document.querySelectorAll("[data-dag]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    verversPrijzen();
  })
);
document.addEventListener("visibilitychange", () => { if (!document.hidden) toon(tab); });
document.addEventListener("keydown", (e) => { if (e.key === "Tab") document.body.classList.add("toetsenbord"); });
document.addEventListener("pointerdown", () => document.body.classList.remove("toetsenbord"));

pasTaalToe();
let start = "nu";
try { start = localStorage.getItem("tab") || "nu"; } catch (e) { /* geen opslag */ }
toon(TABS.includes(start) ? start : "nu");
// Stip bij Status als er iets aandacht nodig heeft, ook als je op een ander scherm bent
if (start !== "status") verversStatus();
