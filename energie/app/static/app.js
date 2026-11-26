"use strict";

const $ = (id) => document.getElementById(id);

const fmtGetal = (v, d) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
const euro = (v, d = 3) => (v == null ? "–" : (v < 0 ? "−€" : "€") + fmtGetal(Math.abs(v), d));
const watt = (w) => (w == null ? "–" : Math.round(Math.abs(w)).toLocaleString(locale()) + " W");
const kwh = (v, d = 3) => (v == null ? "–" : fmtGetal(v, d) + " kWh");
const kwh3 = (v) => kwh(v, 3);
const niveau = (l) => t("niveau." + l);

let tab = "overzicht";
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

function tekenNu(d) {
  const live = $("live");
  live.classList.toggle("uit", !d.ok);
  $("live-tekst").textContent = d.ok ? t("live.live", { tijd: d.tijd }) : d.tijd ? t("live.laatst", { tijd: d.tijd }) : t("live.geen");

  const fout = $("fout-nu");
  fout.hidden = d.ok || !d.fout;
  fout.textContent = d.fout ? t("nu.gatewayfout", { fout: d.fout }) : "";

  $("prijs-nu").innerHTML = (d.prijs ? euro(d.prijs.allin) : "–") + "<small> /kWh</small>";
  if (d.vermogen) tekenStromen(d.vermogen, d.interval);

  const td = d.vandaag;
  $("t-kosten").textContent = euro(td.kosten, 2);

  // Batterij op Overzicht
  const soc = d.vermogen ? d.vermogen.laadtoestand : null;
  $("ob-soc").textContent = soc == null ? "–" : Math.round(soc) + "%";
  if (d.vermogen) {
    const b = d.vermogen.batterij;
    $("ob-status").textContent = Math.abs(b) < 15 ? t("bat.rust") : t(b > 0 ? "bat.ontlaadt" : "bat.laadt", { w: watt(b) });
    $("ob-status").className = "status" + (b < -15 ? "" : " stil");
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
  if (tab === "overzicht" || tab === "systeem") nuTimer = setTimeout(verversNu, Math.max(3, interval) * 1000);
}

/* ---------- Prijzen ---------- */

function tekenPrijzen(d) {
  const leeg = !d.uren.length;
  $("p-leeg").hidden = !leeg;
  $("p-leeg").textContent = d.verwacht_rond ? t("prijs.morgen_rond", { tijd: d.verwacht_rond }) : t("prijs.geen");
  $("p-mini").hidden = $("p-chart").hidden = leeg;
  for (const el of document.querySelectorAll("#p-grafiek .axis, #p-grafiek .legend")) el.hidden = leeg;

  const s = d.samenvatting;
  $("p-laag").textContent = s ? euro(s.laagste) : "–";
  $("p-laag-uur").textContent = s ? s.laagste_uur : "";
  $("p-gem").textContent = s ? euro(s.gemiddeld) : "–";
  $("p-hoog").textContent = s ? euro(s.hoogste) : "–";
  $("p-hoog-uur").textContent = s ? s.hoogste_uur : "";
  if (leeg) { laatstePrijzen = d; tekenBeste(); return; }

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

  laatstePrijzen = d;
  tekenBeste();
  tekenPrijsOverlay();
}

/** Over de prijsstaven: de verwachte zon (gele lijn) en het laadblok van vannacht (groen vlak), als het advies over deze dag gaat. */
function tekenPrijsOverlay() {
  const d = laatstePrijzen;
  const g = $("p-overlay");
  g.textContent = "";
  const p = advies && advies.plan;
  const passend = d && d.uren.length && p && p.status === "ok" && p.uren && p.dag === d.dag;
  $("p-leg-zon").hidden = $("p-leg-laden").hidden = true;
  if (!passend) return;
  const n = d.uren.length, bw = 240 / n;
  const perUur = new Map(p.uren.map((u) => [u.uur, u]));
  let laden = false;
  d.uren.forEach((h, i) => {
    const u = perUur.get(h.uur);
    if (u && u.laden) { laden = true; g.appendChild(svg("rect", { x: (i * bw).toFixed(2), y: 0, width: bw.toFixed(2), height: 140, class: "laadvlak" })); }
  });
  const max = Math.max(0.2, ...p.uren.map((u) => u.zon));
  const pts = d.uren.map((h, i) => { const u = perUur.get(h.uur); return u ? `${(i * bw + bw / 2).toFixed(2)},${(136 - (u.zon / max) * 118).toFixed(1)}` : null; }).filter(Boolean);
  const zon = p.uren.some((u) => u.zon > 0.01);
  if (zon && pts.length > 1) g.appendChild(svg("polyline", { points: pts.join(" "), class: "zonlijn" }));
  $("p-leg-zon").hidden = !zon;
  $("p-leg-laden").hidden = !laden;
}

let laatstePrijzen = null;
let blokLengte = 2;
try { blokLengte = parseInt(localStorage.getItem("blok") || "2", 10) || 2; } catch (e) { /* geen opslag */ }

/** Goedkoopste aaneengesloten blok van n uur binnen [van, tot); geeft de index in uren. */
function besteBlok(uren, n, van, tot) {
  let beste = null;
  for (let i = 0; i + n <= uren.length; i++) {
    const u = parseInt(uren[i].uur, 10);
    if (u < van || u + n > tot) continue;
    const gem = uren.slice(i, i + n).reduce((a, h) => a + h.allin, 0) / n;
    if (!beste || gem < beste.gem) beste = { i, gem };
  }
  return beste;
}

const uurTekst = (u) => String(u % 24).padStart(2, "0") + ":00";

function tekenBeste() {
  const d = laatstePrijzen;
  document.querySelectorAll("[data-blok]").forEach((b) => b.setAttribute("aria-pressed", String(parseInt(b.dataset.blok, 10) === blokLengte)));
  const kaart = $("p-beste");
  const bars = $("bars").children;
  for (const el of bars) el.classList.remove("beste");
  if (!d || !d.uren.length) { kaart.hidden = true; return; }
  const vanaf = d.is_vandaag ? new Date().getHours() : 0;
  const b = besteBlok(d.uren, blokLengte, vanaf, 24);
  kaart.hidden = !b;
  $("p-leg-beste").hidden = !b;
  if (!b) return;
  const u = parseInt(d.uren[b.i].uur, 10);
  $("p-beste-tijd").textContent = `${uurTekst(u)} – ${uurTekst(u + blokLengte)}`;
  $("p-beste-prijs").textContent = t("prijs.gem", { prijs: euro(b.gem) });
  for (let k = b.i; k < b.i + blokLengte; k++) if (bars[k]) bars[k].classList.add("beste");
  const dag = besteBlok(d.uren, blokLengte, Math.max(vanaf, 8), 17);
  if (dag && dag.i !== b.i) {
    const v = parseInt(d.uren[dag.i].uur, 10);
    $("p-beste-dag").innerHTML = t("prijs.overdag", { tijd: `<b>${uurTekst(v)} – ${uurTekst(v + blokLengte)}</b>`, prijs: euro(dag.gem) });
  } else {
    $("p-beste-dag").textContent = "";
  }
}

document.querySelectorAll("[data-blok]").forEach((b) =>
  b.addEventListener("click", () => {
    blokLengte = parseInt(b.dataset.blok, 10);
    try { localStorage.setItem("blok", String(blokLengte)); } catch (e) { /* geen opslag */ }
    tekenBeste();
  })
);

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

let dagGekozen = false; // eerste keer: open op de dag van het advies
async function verversPrijsAdvies() {
  tekenAdvies();
  await laadAdvies(true);
  const p = advies && advies.plan;
  if (!dagGekozen && p && p.status === "ok") {
    dagGekozen = true;
    const morgen = new Date(Date.now() + 86400000);
    const iso = `${morgen.getFullYear()}-${String(morgen.getMonth() + 1).padStart(2, "0")}-${String(morgen.getDate()).padStart(2, "0")}`;
    if (p.dag === iso && dag !== "morgen") {
      dag = "morgen";
      document.querySelectorAll("[data-dag]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.dag === dag)));
    }
  }
  tekenAdvies();
  await verversPrijzen();
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
  // Uitzondering: stroomkosten op Historie met twee decimalen
  $("h-kosten").textContent = tt.meetminuten ? euro(tt.kosten, 2) : "–";
  $("h-vergelijk").textContent = d.vergelijk ? `${d.vergelijk.label} ${euro(d.vergelijk.kosten, 2)}` : "";
  // Overzicht met ring
  $("h-verbruik").textContent = fmtGetal(tt.verbruik_kwh, 3);
  $("h-afname").innerHTML = kwhKlein(tt.afname_kwh);
  $("h-opgewekt").innerHTML = kwhKlein(tt.opgewekt_kwh);
  $("h-bat-uit").innerHTML = kwhKlein(tt.uit_batterij_kwh);
  $("h-terug").innerHTML = kwhKlein(tt.terug_kwh);
  $("h-netto").innerHTML = kwhKlein(tt.netto_afname_kwh);
  $("h-bat-in").innerHTML = kwhKlein(tt.in_batterij_kwh);
  tekenRing(tt);

  tekenTweezijdig(d);

  // Zelfvoorzienend en eigen gebruik van zon
  const verbruik = tt.verbruik_kwh || 0, zon = tt.opgewekt_kwh || 0;
  $("h-zelf").textContent = verbruik > 0.01 ? Math.round(Math.max(0, Math.min(1, 1 - (tt.huis_uit_net_kwh || 0) / verbruik)) * 100) + "%" : "–";
  $("h-eigen").textContent = zon > 0.01 ? Math.round(Math.max(0, Math.min(1, (zon - (tt.terug_kwh || 0)) / zon)) * 100) + "%" : "–";
  const b = tt.batterij;
  $("h-laadnoot").textContent = b.uit_net_kwh > 0.05 ? t("hist.laadnoot", { kwh: kwh3(b.uit_net_kwh) }) : "";
  let dekking = "";
  if (!tt.meetminuten) dekking = t("hist.geen");
  else if (tt.uren_zonder_prijs) dekking = t("hist.zonderprijs", { uren: tt.uren_zonder_prijs });
  $("h-dekking").textContent = dekking;
}

const kwhKlein = (v) => (v == null ? "–" : `${fmtGetal(v, 3)}<small> kWh</small>`);

function tekenRing(tt) {
  const delen = [["zon", tt.huis_uit_zon_kwh], ["bat", tt.huis_uit_batterij_kwh], ["net", tt.huis_uit_net_kwh]];
  const som = delen.reduce((a, [, v]) => a + (v || 0), 0);
  const g = $("h-ring-delen");
  g.textContent = "";
  const r = 52, omtrek = 2 * Math.PI * r;
  let af = 0;
  const pct = {};
  for (const [k, v] of delen) {
    const deel = som > 0 ? (v || 0) / som : 0;
    pct[k] = Math.round(deel * 100);
    if (deel <= 0.001) continue;
    const l = deel * omtrek;
    g.appendChild(svg("circle", {
      cx: 64, cy: 64, r, class: "ring-deel r-" + k,
      "stroke-dasharray": `${Math.max(l - 3, 0.5).toFixed(1)} ${omtrek.toFixed(1)}`, "stroke-dashoffset": (-af).toFixed(1),
    }));
    af += l;
  }
  $("h-aandelen").innerHTML = som > 0
    ? `<span><b class="c-zon">${pct.zon}%</b> ${t("naam.zon")}</span><span><b class="c-bat">${pct.bat}%</b> ${t("naam.batterij")}</span><span><b class="c-net">${pct.net}%</b> ${t("naam.net")}</span>`
    : "";
  $("h-ring").setAttribute("aria-label", t("hist.ring_aria", { kwh: kwh3(tt.verbruik_kwh), zon: pct.zon || 0, bat: pct.bat || 0, net: pct.net || 0 }));
}

const IN = [["zon", "zon"], ["bat_uit", "bat"], ["net", "net"]];
const UIT = [["huis", "huis"], ["bat_in", "batin"], ["terug", "terug"]];

function netteSchaal(max) {
  const stappen = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  return stappen.find((s) => s >= max) || Math.ceil(max / 1000) * 1000;
}

function tekenTweezijdig(d) {
  const reeks = d.reeks;
  const n = reeks.length;
  const somIn = (r) => (r.in ? r.in.zon + r.in.bat_uit + r.in.net : 0);
  const somUit = (r) => (r.uit ? r.uit.huis + r.uit.bat_in + r.uit.terug : 0);
  const max = Math.max(0.01, ...reeks.map(somIn), ...reeks.map(somUit));
  const top = netteSchaal(max * 1.05);
  const dec = top < 1 ? 2 : top < 10 ? 1 : 0;
  $("hy-max").textContent = fmtGetal(top, dec);
  $("hy-min").textContent = fmtGetal(top, dec);
  $("h-grafiek-titel").textContent = t(d.periode === "dag" ? "hist.per_kwartier" : d.periode === "jaar" ? "hist.per_maand_titel" : "hist.per_dag_titel");

  const W = 316, H = 220, M = H / 2, bw = W / n, gat = n > 40 ? 0.9 : 3;
  const el = $("h-bars");
  el.setAttribute("viewBox", `0 0 ${W} ${H}`);
  el.textContent = "";
  for (const y of [0, H / 4, (3 * H) / 4, H]) el.appendChild(svg("line", { x1: 0, x2: W, y1: y, y2: y, class: "grid" }));
  const sy = (v) => (v / top) * M;
  reeks.forEach((r, i) => {
    const x = i * bw;
    const g = svg("g", { class: r.per_uur ? "kolom per-uur" : "kolom", "data-i": i });
    g.appendChild(svg("rect", { x: x.toFixed(2), y: 0, width: bw.toFixed(2), height: H, class: "raak" }));
    let y = M;
    if (r.in) for (const [k, c] of IN) {
      const h = Math.min(sy(r.in[k]), y);
      if (h < 0.05) continue;
      y -= h;
      g.appendChild(svg("rect", { x: x.toFixed(2), y: y.toFixed(2), width: Math.max(bw - gat, 0.6).toFixed(2), height: h.toFixed(2), class: "r-" + c }));
    }
    y = M;
    if (r.uit) for (const [k, c] of UIT) {
      const h = Math.min(sy(r.uit[k]), H - y);
      if (h < 0.05) continue;
      g.appendChild(svg("rect", { x: x.toFixed(2), y: y.toFixed(2), width: Math.max(bw - gat, 0.6).toFixed(2), height: h.toFixed(2), class: "r-" + c }));
      y += h;
    }
    el.appendChild(g);
  });
  el.appendChild(svg("line", { x1: 0, x2: W, y1: M, y2: M, class: "nul" }));
  if (gekozen != null && gekozen < n) toonDetail(gekozen); else sluitDetail();
  el.setAttribute("aria-label", t("hist.bars_aria2", { in: kwh3(d.totaal.opgewekt_kwh + d.totaal.afname_kwh + d.totaal.uit_batterij_kwh), huis: kwh3(d.totaal.verbruik_kwh) }));

  // As
  const as = $("h-as");
  as.textContent = "";
  as.className = "axis pad";
  if (d.periode === "dag") {
    for (const l of ["00", "06", "12", "18", "24"]) { const s = document.createElement("span"); s.textContent = l; as.appendChild(s); }
  } else {
    as.className = "axis pad dicht";
    const ticks = d.periode === "maand" ? [0, 9, 19, n - 1] : reeks.map((_, i) => i);
    reeks.forEach((r, i) => { const s = document.createElement("span"); s.textContent = ticks.includes(i) ? r.label : ""; as.appendChild(s); });
  }
}


/* Tik op een staaf: details van dat moment; tik ernaast: terug naar het overzicht */
let gekozen = null;
function sluitDetail() {
  gekozen = null;
  const d = $("h-detail");
  if (d) d.hidden = true;
  if ($("h-tik")) $("h-tik").hidden = false;
  document.querySelectorAll("#h-bars .kolom").forEach((k) => k.classList.remove("sel", "dim"));
  $("h-bars").classList.remove("gekozen");
}
function toonDetail(i) {
  const r = histData && histData.reeks[i];
  if (!r) return sluitDetail();
  gekozen = i;
  $("h-bars").classList.add("gekozen");
  document.querySelectorAll("#h-bars .kolom").forEach((k) => k.classList.toggle("sel", +k.dataset.i === i));
  const tijd = histData.periode === "dag"
    ? (() => { const [h, m] = r.label.split(":").map(Number); const e = (h * 60 + m + 15) % 1440; return `${r.label}–${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`; })()
    : r.label;
  const v = (x) => (x == null ? "–" : fmtGetal(x, histData.periode === "dag" ? 3 : 2));
  const rij = (cls, naam, x) => `<div><i class="sw ${cls}"></i><span>${esc(naam)}</span><b>${v(x)}</b></div>`;
  const ri = r.in || {}, ru = r.uit || {};
  const d = $("h-detail");
  d.innerHTML = `<div class="row"><b>${esc(tijd)}</b><span class="note">kWh${r.kosten != null ? " · " + esc(euro(r.kosten, 2)) : ""}</span>
      <button type="button" class="rond klein" id="h-detail-sluit" aria-label="${esc(t("li.sluiten"))}">×</button></div>
    <div class="detail-kol"><small>${esc(t("hist.kwam_binnen"))}</small>${rij("c-bg-zon", t("node.zon"), ri.zon)}${rij("goedkoop", t("node.batterij"), ri.bat_uit)}${rij("c-bg-net", t("node.net"), ri.net)}</div>
    <div class="detail-kol"><small>${esc(t("hist.ging_naar"))}</small>${rij("c-bg-huis", t("node.huis"), ru.huis)}${rij("c-bg-batin", t("node.batterij"), ru.bat_in)}${rij("c-bg-terug", t("node.terug"), ru.terug)}</div>
    ${r.in ? "" : `<p class="note">${esc(t("hist.geen_meting"))}</p>`}`;
  d.hidden = false;
  $("h-tik").hidden = true;
  $("h-detail-sluit").addEventListener("click", (e) => { e.stopPropagation(); sluitDetail(); });
}
$("h-bars").addEventListener("click", (e) => {
  const k = e.target.closest(".kolom");
  if (!k) return sluitDetail();
  e.stopPropagation();
  const i = +k.dataset.i;
  if (i === gekozen) sluitDetail(); else toonDetail(i);
});
$("h-detail").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { if (gekozen != null) sluitDetail(); });

async function verversHistorie() {
  clearTimeout(histTimer);
  try {
    const q = `api/history?periode=${periode}` + (periodeDatum ? `&datum=${periodeDatum}` : "");
    tekenHistorie(await haal(metTaal(q)));
  } catch (e) {
    $("h-dekking").textContent = t("hist.fout");
  }
  if (tab === "overzicht" && !periodeDatum) histTimer = setTimeout(verversHistorie, 60 * 1000);
}

document.querySelectorAll("[data-periode]").forEach((b) =>
  b.addEventListener("click", () => {
    periode = b.dataset.periode;
    periodeDatum = null;
    gekozen = null;
    document.querySelectorAll("[data-periode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    verversHistorie();
  })
);
$("h-vorige").addEventListener("click", (e) => { e.stopPropagation(); gekozen = null; if (histData) { periodeDatum = histData.vorige; verversHistorie(); } });
$("h-volgende").addEventListener("click", (e) => {
  e.stopPropagation(); gekozen = null;
  if (histData && histData.volgende) { periodeDatum = histData.volgende; verversHistorie(); }
});

/* ---------- Batterij ---------- */

let sysTimer = null;
let laatsteSysteem = null;

const datumKort = (iso) => (iso ? new Date(iso + "T12:00:00").toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" }) : "–");

function tekenSysteem(d) {
  laatsteSysteem = d;
  const p = d.panelen;
  const box = $("y-panelen");
  box.textContent = "";
  const omv = new Map(((laatsteStatus && laatsteStatus.omvormers.lijst) || []).map((o) => [o.nr, o]));
  if (p && p.lijst.length) {
    const best = Math.max(0.001, ...p.lijst.map((x) => x.vandaag_kwh || 0));
    const zwak = new Set((p.zwak || []).map((z) => z.nr));
    for (const x of p.lijst) {
      const o = omv.get(x.nr) || {};
      const st = o.status || x.status || "ok";
      const r = (x.vandaag_kwh || 0) / best;
      const el = document.createElement("div");
      el.className = "ptegel" + (zwak.has(x.nr) ? " zwak" : "") + (st === "fout" ? " fout" : st === "let_op" ? " let_op" : "");
      el.style.setProperty("--licht", Math.max(0.15, Math.min(1, (r - 0.4) / 0.6)).toFixed(2));
      el.title = o.reden || (o.serie ? t("status.omvormer", { serie: o.serie }) : "");
      const nu = x.slaapt || o.slaapt ? t("status.slaapt") : x.watt == null ? "–" : watt(x.watt);
      el.innerHTML = `<div class="pkop"><span>${esc(t("status.paneel", { nr: x.nr }))}</span><i class="pstip ${st}" aria-label="${esc(t("status." + (["ok", "let_op", "fout"].includes(st) ? st : "onbekend")))}"></i></div>
        <b>${x.vandaag_kwh == null ? "–" : fmtGetal(x.vandaag_kwh, 3)}</b><small class="eenheid">kWh</small>
        <div class="meter"><i style="width:${(r * 100).toFixed(0)}%"></i></div>
        <div class="pvoet"><span>${esc(nu)}</span><span>${x.temp == null ? "" : Math.round(x.temp) + "°"}</span></div>`;
      box.appendChild(el);
    }
    $("y-noot").textContent = p.bron === "eigen telling" ? t("sys.eigen_telling") : "";
  } else {
    box.innerHTML = `<p class="note">${esc(t("status.geen_omv"))}</p>`;
  }

  const b = d.batterij;
  const v = b.vandaag;
  $("b-in").textContent = kwh3(v.geladen_kwh);
  $("b-uit").textContent = kwh3(v.ontladen_kwh);
  $("b-cycli").textContent = v.cycli == null ? "–" : fmtGetal(v.cycli, 3);
  zetOpbrengst($("b-op-vandaag"), v.opbrengst);
  const pts = b.curve || [];
  if (pts.length) {
    const xy = pts.map((q) => [((q.uur / 24) * 316).toFixed(1), (78 - (q.soc / 100) * 76).toFixed(1)]);
    const lijn = "M" + xy.map(([x, y]) => `${x} ${y}`).join(" L");
    $("b-lijn").setAttribute("d", lijn);
    $("b-vlak").setAttribute("d", `${lijn} L${xy[xy.length - 1][0]} 78 L${xy[0][0]} 78 Z`);
    $("b-curve").setAttribute("aria-label", t("bat.curve_nu", { pct: Math.round(pts[pts.length - 1].soc) }));
  }
  const c = advies && advies.instellingen;
  const vlak = $("b-laadvlak");
  vlak.textContent = "";
  $("ob-leg-nacht").hidden = !(c && c.schema_limiet);
  if (c && c.schema_limiet) {
    const s0 = c.schema_start, e0 = c.schema_eind > s0 ? c.schema_eind : c.schema_eind + 24;
    for (let h = s0; h < e0; h++) vlak.appendChild(svg("rect", { x: ((h % 24) / 24 * 316).toFixed(1), y: 2, width: (316 / 24).toFixed(1), height: 76, class: "laadvlak" }));
    $("ob-nacht-tekst").textContent = t("ov.nachtladen", { van: uurT(c.schema_start), tot: uurT(c.schema_eind) });
  }
  const n = b.nachtladen;
  const nacht = $("b-nacht");
  if (n.vol_om) { nacht.textContent = t("bat.vol_om", { tijd: n.vol_om }); nacht.className = "status"; }
  else if (n.max_procent != null && new Date().getHours() >= 9) { nacht.textContent = t("bat.niet_vol", { pct: n.max_procent }); nacht.className = "status mis"; }
  else nacht.textContent = "";
}

async function verversSysteem() {
  clearTimeout(sysTimer);
  try { tekenSysteem(await haal("api/systeem")); } catch (e) { /* volgende keer opnieuw */ }
  if (tab === "systeem" || tab === "overzicht") sysTimer = setTimeout(verversSysteem, 60 * 1000);
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

  // Omvormers: status per paneel in de tegels van Systeem
  const o = d.omvormers;
  $("s-omv-noot").textContent = o.aantal && o.slapen
    ? t("status.omv_slapen", { aantal: o.aantal })
    : o.aantal
    ? t("status.omv_noot", { actief: o.actief, aantal: o.aantal, watt: watt(o.totaal_watt) })
    : o.ophaalfout ? t("status.niet_opgehaald", { fout: o.ophaalfout }) : "";
  if (laatsteSysteem) tekenSysteem(laatsteSysteem);

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

}

function haRijen(h) {
  if (!h) return [];
  if (h.status === "uit") return [[t("rij.ha"), t("rij.ha_uit_" + (h.reden || "uitgezet")), h.reden === "geen_toegang" ? "let_op" : ""]];
  if (h.status === "fout") return [[t("rij.ha"), t("rij.ha_fout", { fout: h.fout || "" }), "let_op"]];
  if (h.sinds) return [[t("rij.ha"), t("rij.ha_sinds", { datum: h.sinds }) + (h.status === "bezig" ? " · " + t("rij.ha_bezig") : ""), "ok"]];
  return [[t("rij.ha"), t(h.status === "bezig" ? "rij.ha_bezig" : "rij.ha_wacht")]];
}

async function verversStatus(vernieuw = false) {
  clearTimeout(statusTimer);
  if (vernieuw) $("s-kop").textContent = t("status.controleren");
  try { tekenStatus(await haal(metTaal("api/system" + (vernieuw ? "?vernieuw=1" : "")))); }
  catch (e) { $("s-kop").textContent = t("status.ophaalfout"); }
  statusTimer = setTimeout(() => verversStatus(false), (tab === "systeem" ? 60 : 300) * 1000);
}
$("s-vernieuw").addEventListener("click", () => verversStatus(true));

/* ---------- Advies ---------- */

let advies = null;
let adviesT = 0;
const uurT = (h) => String(((h % 24) + 24) % 24).padStart(2, "0") + ":00";
const euro2 = (v) => (v == null ? "–" : (v < 0 ? "−€" : "€") + fmtGetal(Math.abs(v), 2));

function adviesKop(p) {
  const a = p.advies;
  return a ? t("adv.kop_laden", { van: uurT(a.start), tot: uurT(a.eind), limiet: a.limiet }) : t("adv.kop_niet");
}

function nachtLabel(p) {
  const d = new Date(p.dag + "T12:00:00");
  const v = new Date(d.getTime() - 86400000);
  const f = (x) => x.toLocaleDateString(locale(), { weekday: "long" });
  return t("adv.nacht", { van: f(v), tot: f(d) });
}

function schemaTekst(sc) {
  return sc.limiet ? `${uurT(sc.start)} – ${uurT(sc.eind)} (${sc.limiet}%)` : t("adv.geen_schema");
}

async function laadAdvies(vernieuw = false) {
  if (!vernieuw && advies && Date.now() - adviesT < 5 * 60 * 1000) return advies;
  try { advies = await haal("api/advies" + (vernieuw ? "?vernieuw=1" : "")); adviesT = Date.now(); } catch (e) { /* later opnieuw */ }
  return advies;
}

function tekenAdvies() {
  const d = advies;
  const p = d && d.plan;
  const ok = p && p.status === "ok";
  $("a-leeg").hidden = ok;
  $("a-leeg").textContent = d && d.fout ? t("adv.fout", { fout: d.fout }) : t("adv.volgt_uitleg");
  $("a-waarom").hidden = !ok;
  $("a-kop").textContent = ok ? adviesKop(p) : t("adv.volgt");
  $("a-nacht").textContent = p ? nachtLabel(p) : "";
  const sinds = $("a-sinds");
  sinds.hidden = !(p && p.prijzen_sinds);
  sinds.textContent = p && p.prijzen_sinds ? t("adv.sinds", { tijd: p.prijzen_sinds }) : "";
  if (!ok) { $("a-kwh").textContent = $("a-prijs").textContent = $("a-besparing").textContent = "–"; tekenEvaluatie(); return; }
  const a = p.advies;
  $("a-kwh").textContent = a ? fmtGetal(a.laden_kwh, 1) + " kWh" : "0 kWh";
  $("a-prijs").textContent = a ? euro(a.gem_prijs) : "–";
  $("a-besparing").textContent = p.gelijk_aan_schema ? t("adv.gelijk_kort") : euro2(p.besparing_vs_schema);

  // Waarom
  const rij = (k, v, cls = "") => `<dt>${esc(k)}</dt><dd class="${cls}">${esc(v)}</dd>`;
  $("a-rijen").innerHTML =
    rij(t("adv.r_begin"), p.soc_begin_nacht + "%") +
    rij(t("adv.r_zon"), kwh(p.zon_kwh, 1)) +
    rij(t("adv.r_verbruik"), kwh(p.verbruik_kwh, 1)) +
    (a ? rij(t("adv.r_laden"), t("adv.r_laden_v", { kwh: fmtGetal(a.laden_kwh, 1), prijs: euro(a.gem_prijs) })) : "") +
    (p.gebruik_prijs ? rij(t("adv.r_gebruik"), euro(p.gebruik_prijs) + " /kWh", "ok") : "") +
    rij(t("adv.r_niets"), euro2(p.besparing_vs_niets)) +
    rij(t("adv.r_schema"), p.gelijk_aan_schema ? t("adv.gelijk_kort") : euro2(p.besparing_vs_schema));
  $("a-uitleg").textContent = !a ? t("adv.uitleg_niet")
    : a.limiet < 100 ? t("adv.uitleg_deels", { limiet: a.limiet }) : t("adv.uitleg_vol");

  tekenEvaluatie();
  if (laatstePrijzen) tekenPrijsOverlay();
}

function tekenEvaluatie() {
  const e = advies && advies.evaluatie;
  $("a-ev-euro").textContent = e && e.besparing_maand != null ? euro2(e.besparing_maand) : "–";
  $("a-ev-zon").textContent = e && e.zon_afwijking != null ? "± " + e.zon_afwijking + "%" : "–";
}

// Instellingen voor het advies
function vulAdviesInstellingen() {
  const c = advies && advies.instellingen;
  const uren = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${uurT(h)}</option>`).join("");
  if (!$("ai-start").options.length) {
    $("ai-start").innerHTML = uren;
    $("ai-eind").innerHTML = uren;
    $("ai-limiet").innerHTML = Array.from({ length: 21 }, (_, i) => `<option value="${i * 5}">${i * 5}%</option>`).join("");
  }
  if (!c) return;
  $("ai-start").value = c.schema_start;
  $("ai-eind").value = c.schema_eind;
  $("ai-limiet").value = Math.round(c.schema_limiet / 5) * 5;
  $("ai-kwp").value = c.kwp;
  $("ai-azimut").value = c.azimut;
  $("ai-helling").value = c.helling;
}

async function bewaarAdviesInstellingen() {
  const body = {
    schema_start: parseInt($("ai-start").value, 10), schema_eind: parseInt($("ai-eind").value, 10),
    schema_limiet: parseInt($("ai-limiet").value, 10), kwp: parseFloat($("ai-kwp").value),
    azimut: parseInt($("ai-azimut").value, 10), helling: parseInt($("ai-helling").value, 10),
  };
  for (const k of Object.keys(body)) if (!Number.isFinite(body[k])) delete body[k];
  try {
    const r = await fetch("api/advies/instellingen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) { advies = await r.json(); adviesT = Date.now(); }
  } catch (e) { /* blijft zoals het was */ }
}
for (const id of ["ai-start", "ai-eind", "ai-limiet", "ai-kwp", "ai-azimut", "ai-helling"]) $(id).addEventListener("change", bewaarAdviesInstellingen);

/* ---------- Meldingen ---------- */

let meldingen = null;

async function laadMeldingen() {
  try { meldingen = await haal("api/meldingen"); } catch (e) { meldingen = null; }
  tekenMeldingen();
}

function tekenMeldingen() {
  const m = meldingen;
  const beschikbaar = !!(m && m.beschikbaar);
  const niet = $("m-niet");
  niet.hidden = beschikbaar && m.doelen.length > 0;
  niet.textContent = !beschikbaar ? t("inst.m_geen_toegang") : t("inst.m_geen_telefoon");
  const sel = $("m-doel");
  sel.innerHTML = `<option value="">${esc(t("inst.m_kies"))}</option>` +
    (m ? m.doelen.map((d) => `<option value="${esc(d.id)}">${esc(d.naam)}</option>`).join("") : "");
  sel.value = (m && m.instellingen.doel) || "";
  sel.disabled = !beschikbaar;
  document.querySelectorAll("[data-melding]").forEach((c) => {
    c.checked = !!(m && m.instellingen[c.dataset.melding]);
    c.disabled = !beschikbaar || !sel.value;
  });
  $("m-test").disabled = !beschikbaar || !sel.value;
}

async function bewaarMeldingen(wijziging) {
  try {
    const r = await fetch("api/meldingen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...wijziging, taal: TAAL }) });
    if (r.ok) meldingen = await r.json();
  } catch (e) { /* blijft zoals het was */ }
  tekenMeldingen();
}

$("m-doel").addEventListener("change", (e) => bewaarMeldingen({ doel: e.target.value || null }));
document.querySelectorAll("[data-melding]").forEach((c) => c.addEventListener("change", () => bewaarMeldingen({ [c.dataset.melding]: c.checked })));
$("m-test").addEventListener("click", async () => {
  const k = $("m-test");
  k.disabled = true;
  let ok = false;
  try { ok = (await (await fetch("api/meldingen/test", { method: "POST" })).json()).ok; } catch (e) { /* mislukt */ }
  $("m-test-tekst").textContent = t(ok ? "inst.m_test_ok" : "inst.m_test_mis");
  k.disabled = false;
});

/* ---------- Navigatie ---------- */

// Hoofdmenu: Stroom · Klimaat · Licht · Zonwering · Instellingen. Stroom heeft drie tabbladen.
const ENERGIE = ["overzicht", "prijzen", "systeem"];
const OUD = { nu: "overzicht", historie: "overzicht", status: "systeem", batterij: "systeem", advies: "prijzen", thuis: "overzicht" };
const TABS = [...ENERGIE, "klimaat", "licht", "zonwering", "instellingen"];
let laatsteEnergie = "overzicht";
try { const e = localStorage.getItem("energie"); const v = OUD[e] || e; if (ENERGIE.includes(v)) laatsteEnergie = v; } catch (e) { /* geen opslag */ }

function hoofdVan(naam) {
  if (ENERGIE.includes(naam)) return "energie";
  if (naam === "instellingen") return "instellingen";
  return naam;
}

function toon(naam) {
  if (OUD[naam]) naam = OUD[naam];
  if (naam === "energie") naam = laatsteEnergie;
  tab = naam;
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== "scherm-" + naam;
  const actief = hoofdVan(naam);
  for (const b of document.querySelectorAll(".tabs [data-tab]")) {
    if (b.dataset.tab === actief) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  document.querySelectorAll("[data-sub]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sub === naam)));
  window.scrollTo(0, 0);
  if (naam === "overzicht" || naam === "systeem") verversNu();
  if (naam === "prijzen") verversPrijsAdvies();
  if (naam === "overzicht") { sluitDetail(); verversHistorie(); verversSysteem(); laadAdvies().then(() => laatsteSysteem && tekenSysteem(laatsteSysteem)); }
  if (naam === "systeem") { verversSysteem(); verversStatus(); }
  if (naam === "instellingen") { pasTaalToe(); if (!laatsteStatus) verversStatus(); laadMeldingen(); laadAdvies().then(vulAdviesInstellingen); }
  if (typeof thuisGetoond === "function") thuisGetoond(naam);
  if (ENERGIE.includes(naam)) { laatsteEnergie = naam; try { localStorage.setItem("energie", naam); } catch (e) { /* geen opslag */ } }
  if (TABS.includes(naam)) { try { localStorage.setItem("scherm", naam); } catch (e) { /* geen opslag */ } }
}

document.querySelectorAll(".tabs [data-tab]").forEach((b) => b.addEventListener("click", () => toon(b.dataset.tab)));
document.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () => toon(b.dataset.sub)));
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
let start = "overzicht";
try { start = localStorage.getItem("scherm") || "overzicht";
  if (OUD[start]) start = OUD[start]; } catch (e) { /* geen opslag */ }
// Opstarten gebeurt in thuis.js, zodra ook die schermen klaar zijn
