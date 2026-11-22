"use strict";

const NIVEAU = { goedkoop: "Goedkoop", normaal: "Normaal", duur: "Duur" };
const $ = (id) => document.getElementById(id);

const fmtGetal = (v, d) => v.toLocaleString("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const euro = (v, d = 3) => (v == null ? "–" : (v < 0 ? "−€" : "€") + fmtGetal(Math.abs(v), d));
const watt = (w) => (w == null ? "–" : Math.round(Math.abs(w)).toLocaleString("nl-NL") + " W");
const kwh = (v, d = 3) => (v == null ? "–" : fmtGetal(v, d) + " kWh");
const kwh3 = (v) => kwh(v, 3);

let tab = "nu";
let dag = "vandaag";
let nuTimer = null;
let prijsTimer = null;

async function haal(pad) {
  const r = await fetch(pad, { cache: "no-store" });
  if (!r.ok) throw new Error(pad + " gaf " + r.status);
  return r.json();
}

/* ---------- Nu ---------- */

const NODES = {
  zon: { x: 170, y: 56, r: 46, kleur: "#E8A200", marker: "m-zon", naam: "zon" },
  bat: { x: 56, y: 196, r: 46, kleur: "#18946B", marker: "m-bat", naam: "batterij" },
  net: { x: 284, y: 196, r: 46, kleur: "#4A6CF0", marker: "m-net", naam: "net" },
  huis: { x: 170, y: 308, r: 56, kleur: "#FF7A1A", marker: "", naam: "huis" },
};
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
  $("bat-label").textContent = "Batterij" + (v.laadtoestand != null ? " " + Math.round(v.laadtoestand) + "%" : "");
  $("net-label").textContent = v.net > DREMPEL ? "Afname" : v.net < -DREMPEL ? "Terug" : "Net";
  $("node-net").classList.toggle("actief", Math.abs(v.net) > DREMPEL);

  const stromen = verdeelStromen(v);
  const actief = Object.entries(stromen).filter(([, w]) => w >= DREMPEL);
  const periode = Math.max(1, (interval || 5) / 2); // twee keer per verversing
  const sleutel = actief.map(([k]) => k).sort().join(",") + "|" + periode;

  const zinnen = actief.map(([k, w]) => {
    const [van, naar] = k.split(">");
    return `${watt(w)} van ${NODES[van].naam} naar ${NODES[naar].naam}`;
  });
  $("flow").setAttribute("aria-label", "Energiestromen: " + (zinnen.join(", ") || "geen stroom"));

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
  $("live-tekst").textContent = d.ok ? "Live · " + d.tijd : d.tijd ? "Laatst " + d.tijd : "Geen verbinding";

  const fout = $("fout-nu");
  fout.hidden = d.ok || !d.fout;
  fout.textContent = d.fout ? "Gateway: " + d.fout : "";

  if (d.prijs) {
    $("prijs-nu").innerHTML = euro(d.prijs.allin) + "<small> /kWh</small>";
    $("niveau-nu").textContent = NIVEAU[d.prijs.level];
  } else {
    $("prijs-nu").innerHTML = "–<small> /kWh</small>";
    $("niveau-nu").textContent = "Geen prijs";
  }
  const nb = $("volgende");
  if (d.volgende) {
    nb.hidden = false;
    const v = d.volgende;
    const wanneer = (v.morgen ? "morgen " : "") + `<strong>${v.uur}</strong>`;
    nb.classList.toggle("goed", v.soort !== "duur_vanaf");
    $("volgende-tekst").innerHTML = {
      voordelig_tot: `Voordelig tot ${wanneer}, daarna ${euro(v.allin)}`,
      voordelig_vanaf: `Voordelig vanaf ${wanneer}: ${euro(v.allin)}`,
      duur_vanaf: `Om ${wanneer} wordt het duur: ${euro(v.allin)}`,
    }[v.soort];
  } else {
    nb.hidden = true;
  }
  tekenStrip(d.strip || []);
  if (d.vermogen) tekenStromen(d.vermogen, d.interval);

  const t = d.vandaag;
  $("t-kosten").textContent = euro(t.kosten);
  $("t-verbruik").textContent = kwh(t.verbruik_kwh);
  $("t-zon").textContent = kwh(t.opgewekt_kwh);
  $("t-bat").textContent = kwh(t.batterij_uit_kwh);

  // Batterijscherm gebruikt dezelfde gegevens
  const soc = d.vermogen ? d.vermogen.laadtoestand : null;
  $("b-soc").textContent = soc == null ? "–" : Math.round(soc) + "%";
  $("b-vul").style.width = (soc || 0) + "%";
  $("b-balk").setAttribute("aria-label", "Laadtoestand " + (soc == null ? "onbekend" : Math.round(soc) + " procent"));
  if (d.vermogen) {
    const b = d.vermogen.batterij;
    $("b-vermogen").textContent = Math.abs(b) < 15 ? "In rust" : (b > 0 ? "Ontlaadt " : "Laadt ") + watt(b);
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
    $("live-tekst").textContent = "Geen verbinding";
  }
  if (tab === "nu" || tab === "batterij") nuTimer = setTimeout(verversNu, Math.max(3, interval) * 1000);
}

/* ---------- Prijzen ---------- */

function tekenPrijzen(d) {
  const datum = new Date(d.dag + "T12:00:00");
  const label = datum.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
  $("prijs-datum").textContent = label.charAt(0).toUpperCase() + label.slice(1) + " · all-in per kWh";

  const leeg = !d.uren.length;
  $("p-leeg").hidden = !leeg;
  $("p-leeg").textContent = d.verwacht_rond
    ? `De prijzen voor morgen worden rond ${d.verwacht_rond} bekend. Kijk straks nog eens.`
    : "Voor deze dag zijn nog geen prijzen binnen.";
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
  bars.setAttribute("aria-label", `Prijs per uur: goedkoopst ${euro(s.laagste)} om ${s.laagste_uur}, duurst ${euro(s.hoogste)} om ${s.hoogste_uur}`);
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
    rij.innerHTML = `<span class="stip ${b.level}"></span><span class="tijd">${b.van}–${b.tot}</span><span class="lvl">${NIVEAU[b.level]}</span><span class="bedrag">${bedrag}</span>`;
    box.appendChild(rij);
  }

  const o = $("opbouw");
  if (d.is_vandaag && d.nu) {
    o.hidden = false;
    const ob = d.nu.opbouw;
    $("opbouw-titel").textContent = `Opbouw nu (${d.nu.uur}–${d.nu.tot})`;
    $("o-beurs").textContent = euro(ob.beurs, 3);
    $("o-inkoop").textContent = euro(ob.inkoop, 3);
    $("o-eb").textContent = euro(ob.energiebelasting, 3);
    $("o-totaal").textContent = euro(ob.totaal, 3);
    const tot = ob.totaal || 1;
    $("o1").style.width = Math.max(0, (ob.beurs / tot) * 100) + "%";
    $("o2").style.width = (ob.inkoop / tot) * 100 + "%";
    $("o3").style.width = (ob.energiebelasting / tot) * 100 + "%";
    $("o-terug").textContent = d.saldering
      ? `Terugleveren levert nu ${euro(d.nu.terug)} op, door de saldering tot 1 januari.`
      : `Terugleveren levert nu ${euro(d.nu.terug)} per kWh op.`;
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
    $("p-leeg").textContent = "Prijzen konden niet geladen worden.";
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
  const t = d.totaal;
  $("h-kosten-label").textContent = d.lopend ? "Stroomkosten tot nu" : "Stroomkosten";
  $("h-kosten").textContent = t.meetminuten ? euro(t.kosten, 3) : "–";
  $("h-vergelijk").textContent = d.vergelijk ? `${d.vergelijk.label} ${euro(d.vergelijk.kosten, 3)}` : "";
  zetOpbrengst($("h-bat"), t.batterij.opbrengst);
  $("h-verbruik").textContent = kwh3(t.verbruik_kwh);
  $("h-opgewekt").textContent = kwh3(t.opgewekt_kwh);
  $("h-afname").textContent = kwh3(t.afname_kwh);
  $("h-terug").textContent = kwh3(t.terug_kwh);

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
  bars.setAttribute("aria-label", `Verbruik per ${d.periode === "dag" ? "uur" : d.periode === "jaar" ? "maand" : "dag"}, totaal ${kwh3(t.verbruik_kwh)}, uit zon, batterij en net`);
  for (const r of reeks) {
    const kolom = document.createElement("i");
    const hoog = (v) => (v / top) * 140;
    kolom.style.height = hoog(r.zon + r.batterij + r.net) + "px";
    kolom.title = `${r.label}: zon ${kwh3(r.zon)}, batterij ${kwh3(r.batterij)}, net ${kwh3(r.net)}${r.heeft_data ? ", " + euro(r.kosten, 3) : ""}`;
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

  const b = t.batterij;
  $("h-laadnoot").textContent = b.uit_net_kwh > 0.05
    ? `Daarnaast ${kwh3(b.uit_net_kwh)} van het net gehaald om de batterij te laden.`
    : "";
  let dekking = "";
  if (!t.meetminuten) dekking = "Voor deze periode zijn nog geen metingen.";
  else if (t.uren_zonder_prijs) dekking = `Voor ${t.uren_zonder_prijs} uur ontbreekt de prijs; die kosten tellen niet mee.`;
  $("h-dekking").textContent = dekking;
}

async function verversHistorie() {
  clearTimeout(histTimer);
  try {
    const q = `api/history?periode=${periode}` + (periodeDatum ? `&datum=${periodeDatum}` : "");
    tekenHistorie(await haal(q));
  } catch (e) {
    $("h-dekking").textContent = "Historie kon niet geladen worden.";
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
  return kwh3(v.kwh) + (v.procent != null ? `<small>${v.procent}% van de lading</small>` : "");
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
  $("b-curve").setAttribute("aria-label", last ? `Laadtoestand vandaag, nu ${Math.round(last.soc)} procent` : "Nog geen laadcurve");

  const nacht = $("b-nacht");
  const n = d.nachtladen;
  if (n.vol_om) { nacht.textContent = "✓ Vol om " + n.vol_om; nacht.className = "status"; }
  else if (n.max_procent != null && new Date().getHours() >= 9) { nacht.textContent = `Vannacht niet vol (max ${n.max_procent}%)`; nacht.className = "status mis"; }
  else { nacht.textContent = ""; }

  const g = d.gisteren;
  zetOpbrengst($("g-op"), g.heeft_data ? g.opbrengst : null);
  $("g-in").textContent = g.heeft_data ? kwh3(g.geladen_kwh) : "–";
  $("g-uit").textContent = g.heeft_data ? kwh3(g.ontladen_kwh) : "–";
  $("g-verlies").innerHTML = g.heeft_data ? verliesTekst(g.verlies) : "–";
  $("g-cycli").textContent = g.heeft_data && g.cycli != null ? fmtGetal(g.cycli, 3) : "–";
  $("g-uitleg").textContent = !g.heeft_data
    ? "Nog geen metingen van gisteren."
    : g.laadprijs != null && g.gebruiksprijs != null
      ? `Geladen voor gemiddeld ${euro(g.laadprijs, 3)} per kWh, gebruikt in uren van gemiddeld ${euro(g.gebruiksprijs, 3)}.`
      : "";

  const lijst = $("b-dagen");
  lijst.textContent = "";
  $("b-dagen-kaart").hidden = !d.dagen.length;
  for (const r of d.dagen) {
    const rij = document.createElement("div");
    rij.className = "blok";
    rij.innerHTML = `<span class="tijd">${r.dag}</span><span class="lvl">${kwh3(r.ontladen_kwh)} ontladen</span><span class="bedrag ${r.opbrengst != null && r.opbrengst < 0 ? "c-min" : "c-bat"}">${signedEuro(r.opbrengst)}</span>`;
    lijst.appendChild(rij);
  }
  zetOpbrengst($("b-samen"), d.dagen_samen);
}

async function verversBatterij() {
  clearTimeout(batTimer);
  try { tekenBatterij(await haal("api/battery")); } catch (e) { /* volgende keer opnieuw */ }
  if (tab === "batterij") batTimer = setTimeout(verversBatterij, 60 * 1000);
}

/* ---------- Navigatie ---------- */

function toon(naam) {
  tab = naam;
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== "scherm-" + naam;
  for (const b of document.querySelectorAll(".tabs button")) {
    if (b.dataset.tab === naam) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
  if (naam === "nu" || naam === "batterij") verversNu();
  if (naam === "prijzen") verversPrijzen();
  if (naam === "historie") verversHistorie();
  if (naam === "batterij") verversBatterij();
  try { localStorage.setItem("tab", naam); } catch (e) { /* geen opslag */ }
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => toon(b.dataset.tab)));
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

let start = "nu";
try { start = localStorage.getItem("tab") || "nu"; } catch (e) { /* geen opslag */ }
toon(["nu", "prijzen", "historie", "batterij"].includes(start) ? start : "nu");
