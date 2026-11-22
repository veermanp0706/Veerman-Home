"use strict";

const NIVEAU = { goedkoop: "Goedkoop", normaal: "Normaal", duur: "Duur" };
const ACCU_KWH = 5.0;
const $ = (id) => document.getElementById(id);

const fmtGetal = (v, d) => v.toLocaleString("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const euro = (v, d = 2) => (v == null ? "–" : (v < 0 ? "−€" : "€") + fmtGetal(Math.abs(v), d));
const kw = (w) => (w == null ? "–" : fmtGetal(Math.abs(w) / 1000, 2) + " kW");
const kwh = (v) => (v == null ? "–" : fmtGetal(v, 1) + " kWh");

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

function zetLijn(id, actief, kleur, marker, van, naar) {
  const l = $(id);
  l.setAttribute("x1", van[0]); l.setAttribute("y1", van[1]);
  l.setAttribute("x2", naar[0]); l.setAttribute("y2", naar[1]);
  l.classList.toggle("actief", actief);
  l.style.stroke = actief ? kleur : "";
  if (actief) l.setAttribute("marker-end", `url(#${marker})`); else l.removeAttribute("marker-end");
}

function tekenStromen(v) {
  const drempel = 15;
  $("w-zon").textContent = kw(v.zon);
  $("w-huis").textContent = kw(v.huis);
  $("w-bat").textContent = kw(v.batterij);
  $("w-net").textContent = kw(v.net);
  $("bat-label").textContent = "Batterij" + (v.laadtoestand != null ? " " + Math.round(v.laadtoestand) + "%" : "");
  $("net-label").textContent = v.net > drempel ? "Afname" : v.net < -drempel ? "Terug" : "Net";
  document.querySelector(".node.net").classList.toggle("actief", Math.abs(v.net) > drempel);

  zetLijn("lijn-zon", v.zon > drempel, "#E8A200", "m-zon", [147, 76], [147, 116]);
  const batBuiten = [74, 178], batBinnen = [100, 173];
  if (v.batterij > drempel) zetLijn("lijn-bat", true, "#18946B", "m-bat", batBuiten, batBinnen);
  else if (v.batterij < -drempel) zetLijn("lijn-bat", true, "#18946B", "m-bat", batBinnen, batBuiten);
  else zetLijn("lijn-bat", false, "", "", batBuiten, batBinnen);
  const netBuiten = [220, 178], netBinnen = [194, 173];
  if (v.net > drempel) zetLijn("lijn-net", true, "#4A6CF0", "m-net", netBuiten, netBinnen);
  else if (v.net < -drempel) zetLijn("lijn-net", true, "#4A6CF0", "m-net", netBinnen, netBuiten);
  else zetLijn("lijn-net", false, "", "", netBuiten, netBinnen);
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
    nb.classList.toggle("goed", d.volgende.level === "goedkoop");
    const woord = { duur: "duur", goedkoop: "goedkoop", normaal: "weer normaal" }[d.volgende.level];
    $("volgende-tekst").innerHTML = `Om <strong>${d.volgende.uur}</strong> wordt het ${woord}: ${euro(d.volgende.allin)}`;
  } else {
    nb.hidden = true;
  }
  tekenStrip(d.strip || []);
  if (d.vermogen) tekenStromen(d.vermogen);

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
    $("b-vermogen").textContent = Math.abs(b) < 15 ? "In rust" : (b > 0 ? "Ontlaadt " : "Laadt ") + kw(b);
  }
  $("b-in").textContent = kwh(t.batterij_in_kwh);
  $("b-uit").textContent = kwh(t.batterij_uit_kwh);
  $("b-verlies").textContent = "–";
  $("b-verlies").title = "Volgt in de volgende versie, over een volledige cyclus";
  $("b-cycli").textContent = fmtGetal(t.batterij_uit_kwh / ACCU_KWH, 1);
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
    const bedrag = b.min === b.max ? euro(b.min) : euro(b.min) + "–" + fmtGetal(b.max, 2);
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
  try { localStorage.setItem("tab", naam); } catch (e) { /* geen opslag */ }
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => toon(b.dataset.tab)));
document.querySelectorAll(".segment button").forEach((b) =>
  b.addEventListener("click", () => {
    dag = b.dataset.dag;
    document.querySelectorAll(".segment button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    verversPrijzen();
  })
);
document.addEventListener("visibilitychange", () => { if (!document.hidden) toon(tab); });

let start = "nu";
try { start = localStorage.getItem("tab") || "nu"; } catch (e) { /* geen opslag */ }
toon(["nu", "prijzen", "historie", "batterij"].includes(start) ? start : "nu");
