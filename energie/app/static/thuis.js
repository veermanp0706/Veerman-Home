"use strict";
/* Klimaat, Licht en Zonwering: alles via Home Assistant (api/thuis). */

const THUIS_TABS = ["klimaat", "licht", "zonwering"];
let thuisData = null;
let nuData = null;
let thuisTimer = null;
const wachtTemp = {};   // id -> doeltemperatuur die nog verstuurd wordt
const wachtRail = {};   // entity_id -> stand (PowerView-percentage) die nog verstuurd wordt
const wachtGroep = {};  // id -> {aan, helderheid} die nog verstuurd wordt
const verstuurTimers = {};
let schuiftNu = false;  // niet opnieuw tekenen terwijl iemand een schuif vasthoudt
let sheetGroep = null;  // groep waarvan de scènes open staan

const graden = (v) => (v == null ? "–" : fmtGetal(v, 1) + "°");
const procent = (v) => (v == null ? "–" : Math.round(v) + "%");

/* ---------- Ophalen en acties ---------- */

async function verversThuis() {
  clearTimeout(thuisTimer);
  const [th, nu] = await Promise.allSettled([haal("api/thuis"), haal("api/now")]);
  if (th.status === "fulfilled") thuisData = th.value;
  else thuisData = { ok: false, fout: th.reason ? th.reason.message : "" };
  if (nu.status === "fulfilled") nuData = nu.value;
  tekenThuisTab();
  if (THUIS_TABS.includes(tab)) thuisTimer = setTimeout(verversThuis, 5000);
}

function thuisGetoond(naam) {
  if (naam !== "licht") sluitSheet();
  if (THUIS_TABS.includes(naam)) { tekenThuisTab(); verversThuis(); }
  else clearTimeout(thuisTimer);
  if (naam === "instellingen") vulAdres();
}

/* Adres van de woning (Instellingen → Woning) */
async function vulAdres() {
  try {
    const d = thuisData && thuisData.ok ? thuisData : await haal("api/thuis");
    if (!d.ok) return;
    const veld = $("i-adres");
    if (document.activeElement !== veld) veld.value = d.adres_eigen || "";
    veld.placeholder = d.adres || "";
  } catch (e) { /* later */ }
}
$("i-adres").addEventListener("change", async (e) => {
  try {
    await fetch("api/thuis/instellingen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adres: e.target.value }) });
    thuisData = null;
  } catch (err) { melding(t("th.actie_mis", { fout: err.message })); }
});

function tekenThuisTab() {
  if (schuiftNu) return;
  if (tab === "klimaat") tekenKlimaat();
  if (tab === "licht") tekenLicht();
  if (tab === "zonwering") tekenZonwering();
}

async function actie(body) {
  try {
    const r = await fetch("api/thuis/actie", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.fout || r.status);
  } catch (e) {
    melding(t("th.actie_mis", { fout: e.message }));
  }
  setTimeout(verversThuis, 700);
  setTimeout(verversThuis, 3000);
}

function later(sleutel, ms, fn) {
  clearTimeout(verstuurTimers[sleutel]);
  verstuurTimers[sleutel] = setTimeout(fn, ms);
}

let meldingTimer = null;
function melding(tekst) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = tekst;
  el.hidden = false;
  clearTimeout(meldingTimer);
  meldingTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

/* ---------- Gedeelde stukjes ---------- */

const PIJL_OP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const PIJL_NEER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const INFO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
const VINK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const LAMP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>';
const STER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';


/** Weerbericht met het weer als achtergrond (Klimaat en Zonwering). */
const LUCHT = {
  zon: ["#2F7FD8", "#7FB8F0", "#FFD28A"], halfbewolkt: ["#4F86C9", "#9EC3E6", "#F7C98B"], bewolkt: ["#6F829B", "#A9B6C6", "#D9C9B2"],
  mist: ["#8D97A3", "#B9C0C8", "#D8D2C8"], regen: ["#56657A", "#8E9AAB", "#B9B2A6"], onweer: ["#3B4252", "#646C80", "#9A8F86"],
  sneeuw: ["#8EA3BD", "#C9D5E3", "#EFEDE8"], wind: ["#5E86B5", "#A3BCD6", "#E5CFAE"], nacht: ["#101B3A", "#2A3A6B", "#5A4A6A"],
};
function weerAchtergrond(soort) {
  const c = LUCHT[soort] || LUCHT.bewolkt;
  const wolk = (x, y, sc, o, kleur = "#FFFFFF") => `<g transform="translate(${x} ${y}) scale(${sc})" fill="${kleur}" fill-opacity="${o}"><ellipse cx="0" cy="20" rx="70" ry="22"/><circle cx="-24" cy="6" r="26"/><circle cx="14" cy="-4" r="34"/><circle cx="46" cy="12" r="22"/></g>`;
  const zon = '<circle cx="330" cy="62" r="62" fill="#FFE08A" fill-opacity=".28"/><circle cx="330" cy="62" r="34" fill="#FFD24A"/>';
  const regen = '<g stroke="#DDE6F2" stroke-opacity=".7" stroke-width="2.4" stroke-linecap="round">' + Array.from({ length: 18 }, (_, k) => `<path d="M${30 + k * 22} ${110 + (k % 3) * 8}l-8 18"/>`).join("") + "</g>";
  const sterren = [[40, 30], [90, 70], [150, 24], [200, 90], [240, 40], [370, 110], [120, 120], [60, 150], [400, 40], [330, 160]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#fff" fill-opacity=".8"/>`).join("");
  const binnen = {
    zon: zon + wolk(230, 150, 0.55, 0.35),
    halfbewolkt: zon + wolk(280, 96, 1, 0.95) + wolk(200, 36, 0.55, 0.5) + wolk(400, 150, 0.8, 0.7),
    bewolkt: wolk(90, 60, 1.1, 0.75, "#EEF1F5") + wolk(300, 80, 1.3, 0.85, "#E3E8EE") + wolk(200, 140, 1, 0.6, "#F4F6F8"),
    mist: '<g fill="#FFFFFF" fill-opacity=".35">' + [60, 100, 140, 180].map((y) => `<rect x="0" y="${y}" width="420" height="16" rx="8"/>`).join("") + "</g>",
    regen: wolk(90, 50, 1.1, 0.55, "#D7DCE3") + wolk(300, 70, 1.2, 0.7, "#C4CAD3") + regen,
    onweer: wolk(100, 50, 1.2, 0.6, "#9AA2B1") + wolk(300, 60, 1.3, 0.7, "#8A92A2") + '<path d="M250 110l-18 34h16l-8 30 30-42h-16l10-22z" fill="#FFD24A"/>',
    sneeuw: wolk(100, 50, 1.1, 0.8) + wolk(300, 60, 1.2, 0.85) + '<g fill="#fff">' + Array.from({ length: 16 }, (_, k) => `<circle cx="${25 + k * 25}" cy="${120 + (k % 4) * 14}" r="3"/>`).join("") + "</g>",
    wind: wolk(120, 60, 0.9, 0.6) + '<g fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="4" stroke-linecap="round"><path d="M40 120h200a20 20 0 1 0-20-20M60 150h260a20 20 0 1 1-20 20"/></g>',
    nacht: sterren + '<circle cx="330" cy="58" r="26" fill="#F3EEDC"/><circle cx="342" cy="50" r="24" fill="#2A3A6B"/>',
  }[soort] || "";
  // De lucht zelf is de achtergrond van het blok; zon en wolken staan rechts, op ware grootte
  return `<svg class="weer-lucht" aria-hidden="true" viewBox="0 0 420 300" preserveAspectRatio="xMaxYMin meet">${binnen}</svg>`;
}

const tijdVan = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : "–");
function dagVan(iso) {
  if (!iso) return "";
  const d = new Date(iso), nu = new Date();
  return d.toDateString() === nu.toDateString() ? t("weer.vandaag") : t("weer.morgen");
}

function tekenWeer(id) {
  const el = $(id);
  const d = thuisData && thuisData.ok ? thuisData : null;
  const w = d && d.weer;
  const soort = w ? w.icoon : "bewolkt";
  const tegel = (icoon, label, waarde, sub) => `<div class="wtegel"><span class="wl">${icoon}${esc(label)}</span><b>${waarde}</b><span class="wl">${sub}</span></div>`;
  const op = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 18h16M7 14a5 5 0 0 1 10 0M12 4v4M12 4l-2 2M12 4l2 2"/></svg>';
  const onder = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 18h16M7 14a5 5 0 0 1 10 0M12 4v4M12 8l-2-2M12 8l2-2"/></svg>';
  const druppel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>';
  const windI = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/></svg>';
  const pijl = w && w.wind_graden != null ? `<svg class="windpijl" width="11" height="11" viewBox="0 0 24 24" style="transform:rotate(${(w.wind_graden + 180) % 360}deg)" aria-hidden="true"><path d="M12 3l6 15-6-4-6 4z" fill="currentColor"/></svg>` : "";
  const z = d && d.zon;
  const toestand = w ? ((x) => (x.startsWith("weer.") ? w.toestand : x))(t("weer." + w.toestand)) : "";
  el.innerHTML = weerAchtergrond(soort) + `<div class="weer-inhoud">
      <div class="weer-kop"><span class="weer-adres">${esc((d && d.adres) || t("weer.buiten"))}</span>
        <span class="hero">${graden(w ? w.temp : d ? d.buiten : null)}</span><span class="weer-toestand">${esc(toestand)}</span></div>
      <div class="weer-tegels">
        ${tegel(op, t("weer.zon_op"), z ? tijdVan(z.op) : "–", z ? dagVan(z.op) : "")}
        ${tegel(onder, t("weer.zon_onder"), z ? tijdVan(z.onder) : "–", z ? dagVan(z.onder) : "")}
        ${tegel(druppel, t("weer.vocht"), procent(w && w.vocht), esc(t("weer.lucht")))}
        ${tegel(windI, t("weer.wind"), w && w.wind_bft != null ? w.wind_bft + " Bft" : "–", w ? `${pijl}${esc(w.wind_richting || "")}` : "")}
      </div></div>`;
  el.classList.toggle("nacht", soort === "nacht" || soort === "onweer");
  const c = LUCHT[soort] || LUCHT.bewolkt;
  el.style.background = `linear-gradient(180deg, ${c[0]}, ${c[1]} 62%, ${c[2]})`;
}

/** Kleur bij een temperatuur: 10° blauw → 25° rood (zelfde stappen als het ontwerp). */
const TEMP_STOPS = [[10, [47, 111, 214]], [13.5, [141, 184, 238]], [17, [243, 231, 218]], [21, [242, 163, 107]], [25, [217, 68, 63]]];
function tempKleur(v) {
  if (v == null) return null;
  const x = Math.min(Math.max(v, 10), 25);
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    if (x <= t1) {
      const [t0, c0] = TEMP_STOPS[i - 1];
      const f = (x - t0) / (t1 - t0);
      return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
    }
  }
  return TEMP_STOPS[TEMP_STOPS.length - 1][1];
}
function tempStijl(v) {
  const c = tempKleur(v);
  if (!c) return "";
  const licht = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 150;
  return `--k:rgba(${c},.62);--kr:rgba(${c},.9);--kt:${licht ? "#2a1a10" : "#fff"}`;
}


function haFout(id) {
  const el = $(id);
  if (!el) return false;
  const fout = thuisData && !thuisData.ok;
  el.hidden = !fout;
  if (fout) el.textContent = thuisData.fout === "geen_toegang" ? t("th.geen_toegang") : t("th.ha_fout", { fout: thuisData.fout || "" });
  return fout;
}

function leegKaart(el) {
  el.innerHTML = `<p class="card leeg">${esc(thuisData && thuisData.fout === "geen_toegang" ? t("th.geen_toegang") : thuisData && !thuisData.ok ? t("th.ha_fout", { fout: thuisData.fout || "" }) : t("th.laden"))}</p>`;
}

function railStand(g) {
  const rail = wachtRail[g.boven_id] ?? g.rail;
  const product = wachtRail[g.onder_id] ?? g.product;
  return { rail, product };
}

function groepStand(g) {
  const w = wachtGroep[g.id] || {};
  return { aan: w.aan ?? g.aan, helderheid: w.helderheid ?? g.helderheid };
}

/** Raampje met de stof tussen de middelste rail (vanaf boven) en de onderste rail (vanaf onder). */
function raam(rail, product) {
  const boven = Math.min(Math.max(rail ?? 0, 0), 100);
  const onder = Math.min(Math.max(100 - (product ?? 100), boven), 100);
  return `<div class="raam" role="img" aria-label="${esc(t("zw.raam_aria", { rail: procent(rail), product: procent(product) }))}">
    <i class="stof" style="top:${boven}%;height:${onder - boven}%"></i>
    <i class="rail" style="top:${boven}%"></i><i class="rail" style="top:${onder}%"></i></div>`;
}

/** Kamers gegroepeerd per verdieping, in de volgorde van Home Assistant. */
function perVerdieping(kl) {
  const uit = [];
  for (const r of kl) {
    const naam = r.verdieping || t("kl.overig");
    let v = uit.find((x) => x.naam === naam);
    if (!v) uit.push((v = { naam, kamers: [] }));
    v.kamers.push(r);
  }
  return uit;
}

function kamerStatus(r) {
  if (!r.bereikbaar) return t("th.onbereikbaar");
  if (r.modus === "off") return t("kl.uit");
  return r.actie === "heating" ? t("kl.verwarmt") : t("kl.op_temp");
}

/* ---------- Klimaat ---------- */

function tekenKlimaat() {
  tekenWeer("kl-weer");
  const main = $("kl-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  if (!d) return leegKaart(main);
  const kl = d.klimaat;
  if (!kl.length) { main.innerHTML = `<p class="card leeg">${esc(t("kl.geen"))}</p>`; return; }
  main.innerHTML = perVerdieping(kl).map((v) => {
    const warm = v.kamers.filter((r) => r.actie === "heating").length;
    return `<section class="card verdieping" aria-label="${esc(v.naam)}">
      <div class="row"><h2>${esc(v.naam)}</h2><span class="note">${warm ? esc(t(warm === 1 ? "kl.verwarmt_1" : "kl.verwarmt_n", { n: warm })) : esc(t(v.kamers.length === 1 ? "kl.ruimte_1" : "kl.ruimtes_n", { n: v.kamers.length }))}</span></div>
      <div class="kamers">${v.kamers.map((r) => {
        const doel = wachtTemp[r.id] ?? r.doel;
        const uit = r.modus === "off" || !r.bereikbaar;
        return `<div class="kamer-t${r.actie === "heating" ? " warm" : ""}${r.bereikbaar ? "" : " weg"}" style="${tempStijl(r.temp)}">
          <div class="kt-naam"><b>${esc(r.naam)}</b><small>${esc(kamerStatus(r))}${r.vocht != null ? " · " + procent(r.vocht) : ""}</small></div>
          <b class="kt-temp">${graden(r.temp)}</b>
          <div class="stepper">
            <button type="button" data-a="temp" data-id="${esc(r.id)}" data-delta="-1" aria-label="${esc(t("kl.lager", { naam: r.naam }))}" ${uit ? "disabled" : ""}>−</button>
            <span class="stack"><small>${esc(t("kl.doel"))}</small><b>${graden(doel)}</b></span>
            <button type="button" data-a="temp" data-id="${esc(r.id)}" data-delta="1" aria-label="${esc(t("kl.hoger", { naam: r.naam }))}" ${uit ? "disabled" : ""}>+</button>
          </div>
        </div>`;
      }).join("")}</div>
    </section>`;
  }).join("") + `<p class="note pad-l breed">${esc(t("kl.uitleg"))}</p>`;
}

function stapTemp(id, richting) {
  const r = thuisData.klimaat.find((x) => x.id === id);
  if (!r) return;
  const huidig = wachtTemp[id] ?? r.doel ?? r.temp ?? 20;
  const nieuw = Math.min(Math.max(Math.round((huidig + richting * r.stap) / r.stap) * r.stap, r.min), r.max);
  wachtTemp[id] = nieuw;
  tekenThuisTab();
  later("temp:" + id, 800, async () => {
    await actie({ soort: "temperatuur", id, waarde: nieuw });
    setTimeout(() => { delete wachtTemp[id]; }, 3500);
  });
}

/* ---------- Licht ---------- */

function groepKaart(g) {
  const s = groepStand(g);
  const status = !g.bereikbaar ? t("th.onbereikbaar")
    : s.aan ? t("li.lampen_aan", { aan: g.lampen_aan || g.lampen, totaal: g.lampen }) + (g.dimbaar && s.helderheid != null ? " · " + s.helderheid + "%" : "")
    : t("li.uit_kort");
  const sub = g.ouder ? " sub" : "";
  return `<section class="card groep${s.aan ? " aan" : ""}${sub}${g.bereikbaar ? "" : " weg"}" aria-label="${esc(g.naam)}" style="--h:${s.aan ? (s.helderheid ?? 100) / 100 : 0}">
    <div class="groep-kop">
      <span class="lamp-icoon">${LAMP}</span>
      <div class="stack groei"><b class="groep-naam">${g.ouder ? '<span class="zone">↳</span>' : ""}${esc(g.naam)}</b><small>${esc(status)}</small></div>
      ${g.scenes.length ? `<button type="button" class="rond scene-open${g.scenes.some((x) => x.actief) ? " actief" : ""}" data-a="sheet" data-id="${esc(g.id)}" aria-label="${esc(t("li.scenes_van", { naam: g.naam }))}">${STER}</button>` : ""}
      <button type="button" class="schakel" role="switch" aria-checked="${s.aan}" data-a="groep" data-id="${esc(g.id)}" aria-label="${esc(g.naam)}" ${g.bereikbaar ? "" : "disabled"}><i></i></button>
    </div>
    ${g.dimbaar ? `<div class="dim${s.aan ? "" : " uit"}"><span class="dim-ico laag" aria-hidden="true">${LAMP}</span>
      <input type="range" min="1" max="100" step="1" value="${s.helderheid ?? 100}" style="--v:${s.helderheid ?? 100}%" data-a="helderheid" data-id="${esc(g.id)}" aria-label="${esc(t("li.helderheid", { naam: g.naam }))}" ${g.bereikbaar ? "" : "disabled"}>
      <span class="dim-ico" aria-hidden="true">${LAMP}</span></div>` : ""}
  </section>`;
}

function tekenLicht() {
  const main = $("li-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  const li = d ? d.licht : null;
  $("li-groepen").innerHTML = li && li.groepen.length ? `${li.groepen_aan} <small>${esc(t("li.van_kort", { totaal: li.groepen.length }))}</small>` : "–";
  $("li-aan").innerHTML = li ? `${li.aan} <small>${esc(t("li.van_kort", { totaal: li.totaal }))}</small>` : "–";
  $("li-uit").disabled = !li || !li.aan;
  if (!li) return leegKaart(main);
  if (!li.groepen.length) { main.innerHTML = `<p class="card leeg">${esc(t(li.totaal ? "li.geen_groepen" : "li.geen"))}</p>`; return; }
  main.innerHTML = li.groepen.map(groepKaart).join("") + `<p class="note pad-l breed">${esc(t("li.uitleg"))}</p>`;
  if (sheetGroep) tekenSheet();
}

function vindGroep(id) { return thuisData && thuisData.licht ? thuisData.licht.groepen.find((g) => g.id === id) : null; }

function openSheet(id) {
  sheetGroep = id;
  tekenSheet();
  $("li-sheet-achter").hidden = false;
  $("li-sheet").hidden = false;
  requestAnimationFrame(() => { $("li-sheet").classList.add("open"); $("li-sheet-achter").classList.add("open"); });
  setTimeout(() => $("li-sheet-sluit").focus(), 50);
}
function sluitSheet() {
  if (!sheetGroep) return;
  const knop = document.querySelector(`.scene-open[data-id="${CSS.escape(sheetGroep)}"]`);
  sheetGroep = null;
  $("li-sheet").classList.remove("open");
  $("li-sheet-achter").classList.remove("open");
  $("li-sheet").hidden = true;
  $("li-sheet-achter").hidden = true;
  if (knop) knop.focus();
}
function tekenSheet() {
  const g = vindGroep(sheetGroep);
  if (!g) return sluitSheet();
  $("li-sheet-titel").textContent = t("li.scenes_titel", { naam: g.naam });
  $("li-sheet-sub").textContent = t(g.scenes.length === 1 ? "li.scene_1" : "li.scenes_n", { n: g.scenes.length });
  $("li-sheet-scenes").innerHTML = g.scenes.map((s) => `<button type="button" class="scene-knop${s.actief ? " vol" : ""}" data-a="scene" data-id="${esc(s.id)}" aria-pressed="${s.actief}">
      <span>${esc(s.naam)}</span>${s.actief ? VINK : ""}</button>`).join("");
}

function zetGroep(id, aan) {
  const g = vindGroep(id);
  if (!g) return;
  wachtGroep[id] = { ...(wachtGroep[id] || {}), aan };
  tekenThuisTab();
  actie({ soort: "groep", id, aan }).then(() => setTimeout(() => { delete wachtGroep[id]; }, 3500));
}

/* ---------- Zonwering ---------- */

function tekenZonwering() {
  tekenWeer("zw-weer");
  const main = $("zw-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  if (!d) return leegKaart(main);
  const zw = d.zonwering;
  let html = "";
  if (zw.scenes.length) {
    html += `<section class="card breed" aria-label="${esc(t("zw.scenes"))}"><h2>${esc(t("zw.scenes"))}</h2><div class="scenes">`
      + zw.scenes.map((s) => {
        const actief = s.naam === zw.actief;
        return `<button type="button" class="scene-knop${actief ? " vol" : ""}${s.naam.length > 16 ? " lang" : ""}" data-a="zscene" data-id="${esc(s.id)}" aria-pressed="${actief}">
          <span>${esc(s.naam)}</span>${s.bezig ? `<span class="bezig" aria-label="${esc(t("zw.bezig"))}"></span>` : ""}</button>`;
      }).join("") + `</div>${zw.kan_herkennen ? `<p class="note info">${INFO}${esc(t(zw.actief ? (zw.herkend ? "zw.herkend" : "zw.bezig_naar") : "zw.eigen_stand", { naam: zw.actief || "" }))}</p>` : zw.helper ? "" : `<p class="note">${esc(t("zw.geen_helper"))}</p>`}</section>`;
  }
  if (!zw.gordijnen.length) html += `<p class="card leeg">${esc(t("zw.geen"))}</p>`;
  html += zw.gordijnen.map((g) => {
    const s = railStand(g);
    const rij = (label, hint, id, waarde, op, neer) => `<div class="rail-rij">
        <div class="stack groei"><span class="note">${esc(label)}</span><b>${procent(waarde)}</b><small>${esc(hint)}</small></div>
        <button type="button" class="rond" data-a="rail" data-id="${esc(id)}" data-delta="${op}" aria-label="${esc(t("zw.omhoog", { naam: g.naam, rail: label }))}" ${id && g.bereikbaar ? "" : "disabled"}>${PIJL_OP}</button>
        <button type="button" class="rond" data-a="rail" data-id="${esc(id)}" data-delta="${neer}" aria-label="${esc(t("zw.omlaag", { naam: g.naam, rail: label }))}" ${id && g.bereikbaar ? "" : "disabled"}>${PIJL_NEER}</button>
      </div>`;
    return `<section class="card" aria-label="${esc(g.naam)}">
      <div class="row"><h2 class="naam-groot">${esc(g.naam)}</h2><span class="badge ${g.bereikbaar ? "ok" : "fout"}">${esc(t(g.bereikbaar ? "zw.bereikbaar" : "th.onbereikbaar"))}</span></div>
      <div class="gordijn">${raam(s.rail, s.product)}
        <div class="stack groei rails">
          ${rij(t("zw.rail"), t("zw.vanaf_boven"), g.boven_id, s.rail, -5, 5)}
          ${rij(t("zw.product"), t("zw.vanaf_onder"), g.onder_id, s.product, 5, -5)}
        </div>
      </div>
    </section>`;
  }).join("");
  html += `<p class="note pad-l breed">${esc(t("zw.uitleg"))}</p>`;
  main.innerHTML = html;
}

function stapRail(id, delta) {
  const g = thuisData.zonwering.gordijnen.find((x) => x.onder_id === id || x.boven_id === id);
  if (!g) return;
  const s = railStand(g);
  const huidig = id === g.boven_id ? s.rail : s.product;
  const nieuw = Math.min(Math.max(Math.round(((huidig ?? 0) + delta) / 5) * 5, 0), 100);
  wachtRail[id] = nieuw;
  tekenThuisTab();
  later("rail:" + id, 1000, async () => {
    await actie({ soort: "rail", id, waarde: nieuw });
    setTimeout(() => { delete wachtRail[id]; }, 8000); // bluetooth: de nieuwe stand komt wat later binnen
  });
}

/* ---------- Klikken ---------- */

function klik(e) {
  const ga = e.target.closest("[data-ga]");
  if (ga) { toon(ga.dataset.ga); return; }
  const k = e.target.closest("[data-a]");
  if (!k || k.disabled || k.tagName === "INPUT") return;
  const a = k.dataset.a;
  if (a === "temp") stapTemp(k.dataset.id, Number(k.dataset.delta));
  else if (a === "rail") stapRail(k.dataset.id, Number(k.dataset.delta));
  else if (a === "groep") { const g = vindGroep(k.dataset.id); if (g) zetGroep(g.id, !groepStand(g).aan); }
  else if (a === "sheet") openSheet(k.dataset.id);
  else if (a === "alles_uit") {
    thuisData.licht.lampen.forEach((l) => { l.aan = false; });
    thuisData.licht.groepen.forEach((g) => { g.aan = false; g.lampen_aan = 0; });
    thuisData.licht.aan = thuisData.licht.groepen_aan = 0;
    tekenThuisTab();
    actie({ soort: "alles_uit" });
  } else if (a === "scene") {
    const g = vindGroep(sheetGroep);
    if (g) { g.scenes.forEach((s) => { s.actief = s.id === k.dataset.id; }); wachtGroep[g.id] = { ...(wachtGroep[g.id] || {}), aan: true }; tekenThuisTab(); }
    actie({ soort: "scene", id: k.dataset.id }).then(() => { if (g) setTimeout(() => { delete wachtGroep[g.id]; }, 3500); });
    setTimeout(sluitSheet, 350);
  } else if (a === "zscene") {
    const s = thuisData.zonwering.scenes.find((x) => x.id === k.dataset.id);
    if (s) { thuisData.zonwering.actief = s.naam; s.bezig = true; tekenThuisTab(); }
    actie({ soort: "zonwering_scene", id: k.dataset.id });
  }
}
for (const id of ["kl-main", "li-main", "zw-main", "li-uit", "li-sheet-scenes"]) $(id).addEventListener("click", klik);
$("li-uit").dataset.a = "alles_uit";
$("li-sheet-sluit").addEventListener("click", sluitSheet);
$("li-sheet-achter").addEventListener("click", sluitSheet);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") sluitSheet(); });

const liMain = $("li-main");
liMain.addEventListener("pointerdown", (e) => { if (e.target.matches("input[type=range]")) schuiftNu = true; });
document.addEventListener("pointerup", () => { if (schuiftNu) schuiftNu = false; });
liMain.addEventListener("change", (e) => {
  const k = e.target;
  if (k.dataset.a !== "helderheid") return;
  schuiftNu = false;
  const waarde = Number(k.value);
  wachtGroep[k.dataset.id] = { aan: true, helderheid: waarde };
  actie({ soort: "helderheid", id: k.dataset.id, waarde }).then(() => setTimeout(() => { delete wachtGroep[k.dataset.id]; }, 3500));
  tekenThuisTab();
});
liMain.addEventListener("input", (e) => {
  const k = e.target;
  if (k.dataset.a !== "helderheid") return;
  const kaart = k.closest(".groep");
  k.style.setProperty("--v", k.value + "%");
  if (kaart) kaart.style.setProperty("--h", Number(k.value) / 100);
  const small = kaart && kaart.querySelector(".groep-kop small");
  if (small) small.textContent = small.textContent.replace(/\d+%$/, k.value + "%");
});

/* ---------- Opstarten ---------- */

toon(TABS.includes(start) ? start : "overzicht");
// Stip bij Energie als er iets aandacht nodig heeft, ook als je op een ander scherm bent
if (start !== "systeem") verversStatus();
