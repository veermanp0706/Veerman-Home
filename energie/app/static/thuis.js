"use strict";
/* Thuis, Klimaat, Licht en Zonwering: alles via Home Assistant (api/thuis). */

const THUIS_TABS = ["thuis", "klimaat", "licht", "zonwering"];
let thuisData = null;
let nuData = null;
let thuisTimer = null;
let prijsVandaag = null, prijsVandaagT = 0;
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
  if (naam === "thuis") { laadPrijsVandaag(); laadAdvies().then(() => tab === "thuis" && tekenThuis()); }
}

async function laadPrijsVandaag() {
  if (prijsVandaag && Date.now() - prijsVandaagT < 15 * 60 * 1000) return;
  try { prijsVandaag = await haal("api/prices?dag=vandaag"); prijsVandaagT = Date.now(); if (tab === "thuis") tekenThuis(); } catch (e) { /* later */ }
}

function tekenThuisTab() {
  if (schuiftNu) return;
  if (tab === "thuis") tekenThuis();
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
const VINK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const LAMP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>';
const STER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';

const WEER_SVG = {
  zon: '<circle cx="24" cy="24" r="9" fill="#FFC23D"/><g stroke="#FFC23D" stroke-width="3" stroke-linecap="round"><path d="M24 5v5M24 38v5M5 24h5M38 24h5M10.6 10.6l3.5 3.5M33.9 33.9l3.5 3.5M10.6 37.4l3.5-3.5M33.9 14.1l3.5-3.5"/></g>',
  nacht: '<path d="M30 8a15 15 0 1 0 10 26A17 17 0 0 1 30 8z" fill="#F3E7DA"/>',
  halfbewolkt: '<circle cx="18" cy="17" r="8" fill="#FFC23D"/><g stroke="#FFC23D" stroke-width="2.6" stroke-linecap="round"><path d="M18 3v3M5 17h3M8.5 7.5l2 2M27.5 7.5l-2 2"/></g><path d="M15 40h20a8 8 0 0 0 0-16 11 11 0 0 0-20.5 3A6.5 6.5 0 0 0 15 40z" fill="#F3E7DA"/>',
  bewolkt: '<path d="M13 38h22a9 9 0 0 0 0-18 12 12 0 0 0-22.6 3.4A7.3 7.3 0 0 0 13 38z" fill="#F3E7DA"/>',
  mist: '<g stroke="#F3E7DA" stroke-width="3.2" stroke-linecap="round"><path d="M8 16h32M12 24h28M8 32h32M14 40h20"/></g>',
  regen: '<path d="M13 30h22a8 8 0 0 0 0-16 11 11 0 0 0-20.7 3A6.5 6.5 0 0 0 13 30z" fill="#F3E7DA"/><g stroke="#8DB8EE" stroke-width="3" stroke-linecap="round"><path d="M16 35l-2 6M24 35l-2 6M32 35l-2 6"/></g>',
  onweer: '<path d="M13 28h22a8 8 0 0 0 0-16 11 11 0 0 0-20.7 3A6.5 6.5 0 0 0 13 28z" fill="#F3E7DA"/><path d="M25 30l-6 9h5l-2 7 8-10h-5l3-6z" fill="#FFC23D"/>',
  sneeuw: '<path d="M13 30h22a8 8 0 0 0 0-16 11 11 0 0 0-20.7 3A6.5 6.5 0 0 0 13 30z" fill="#F3E7DA"/><g fill="#F3E7DA"><circle cx="16" cy="38" r="2.2"/><circle cx="24" cy="41" r="2.2"/><circle cx="32" cy="38" r="2.2"/></g>',
  wind: '<g fill="none" stroke="#F3E7DA" stroke-width="3.2" stroke-linecap="round"><path d="M6 18h24a5 5 0 1 0-5-5M6 26h32a5 5 0 1 1-5 5M6 34h16"/></g>',
};
const weerIcoon = (naam, maat = 48) => `<svg class="weer-icoon" width="${maat}" height="${maat}" viewBox="0 0 48 48" aria-hidden="true">${WEER_SVG[naam] || WEER_SVG.bewolkt}</svg>`;

/** Weerbericht in de oranje band (Klimaat en Zonwering). */
function tekenWeer(id) {
  const el = $(id);
  const w = thuisData && thuisData.ok ? thuisData.weer : null;
  if (!w) {
    el.innerHTML = `<div class="weer-kop"><div class="stack"><span class="sub">${esc(t("weer.buiten"))}</span><span class="hero">${thuisData && thuisData.ok ? graden(thuisData.buiten) : "–"}</span></div></div>`;
    return;
  }
  const pijl = w.wind_graden == null ? "" : `<svg class="windpijl" width="16" height="16" viewBox="0 0 24 24" style="transform:rotate(${(w.wind_graden + 180) % 360}deg)" aria-hidden="true"><path d="M12 3l6 15-6-4-6 4z" fill="currentColor"/></svg>`;
  el.innerHTML = `<div class="weer-kop">
      ${weerIcoon(w.icoon, 60)}
      <div class="stack groei"><span class="sub">${esc(t("weer.buiten"))}</span><span class="hero">${graden(w.temp)}</span><span class="weer-toestand">${esc(((x) => (x.startsWith("weer.") ? w.toestand : x))(t("weer." + w.toestand)))}</span></div>
    </div>
    <div class="tiles twee">
      <div class="tile"><span>${esc(t("weer.vocht"))}</span><b>${procent(w.vocht)}</b><span>${esc(t("weer.luchtvochtigheid"))}</span></div>
      <div class="tile"><span>${esc(t("weer.wind"))}</span><b>${w.wind_bft == null ? "–" : w.wind_bft + " Bft"}</b><span class="wind-r">${pijl}${esc(w.wind_richting || "")}${w.wind_kmh != null ? " · " + w.wind_kmh + " km/u" : ""}</span></div>
    </div>`;
}

/** Kleur bij een temperatuur: 10° blauw → 30° rood (zelfde stappen als het ontwerp). */
const TEMP_STOPS = [[10, [47, 111, 214]], [15, [141, 184, 238]], [19.5, [243, 231, 218]], [24, [242, 163, 107]], [30, [217, 68, 63]]];
function tempKleur(v) {
  if (v == null) return null;
  const x = Math.min(Math.max(v, 10), 30);
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

function kopRij(titel, naar) {
  return `<div class="row"><h2>${esc(titel)}</h2>${naar ? `<button type="button" class="ga-naar" data-ga="${naar}">${esc(t("tab." + naar))} ›</button>` : ""}</div>`;
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

/* ---------- Thuis ---------- */

function slimmeTips(d) {
  const tips = [];
  const v = nuData && nuData.vermogen;
  const woon = d && d.klimaat.find((r) => (r.ruimte || r.naam).toLowerCase() === "woonkamer");
  const zw = d && d.zonwering;
  // 1. Veel zon en het wordt warm binnen: zonwering omlaag
  if (v && zw && v.zon >= 1000 && woon && woon.temp != null && woon.temp >= 21.5) {
    const s = zw.scenes.find((x) => x.naam.toLowerCase() === "overdag 1");
    if (s && zw.actief !== s.naam) tips.push({ icoon: "zon", kop: t("tip.zon_kop"), tekst: t("tip.zon_tekst", { w: watt(v.zon), temp: graden(woon.temp) }), knop: s.naam, a: "zscene", id: s.id });
  }
  // 2. Goedkoopste twee uur van vandaag (nog te gaan)
  if (prijsVandaag && prijsVandaag.uren && prijsVandaag.uren.length) {
    const b = besteBlok(prijsVandaag.uren, 2, new Date().getHours(), 24);
    if (b) {
      const u = parseInt(prijsVandaag.uren[b.i].uur, 10);
      const nu = new Date().getHours();
      tips.push({ icoon: "euro", kop: u <= nu ? t("tip.goedkoop_nu_kop") : t("tip.goedkoop_kop", { tijd: `${uurTekst(u)} – ${uurTekst(u + 2)}` }), tekst: t("tip.goedkoop_tekst", { prijs: euro(b.gem) }), knop: t("tab.prijzen"), ga: "prijzen" });
    }
  }
  // 3. Batterij-advies voor vannacht nog niet ingesteld
  const p = advies && advies.plan;
  if (p && p.status === "ok" && !p.ingesteld && !p.gelijk_aan_schema) {
    tips.push({ icoon: "bat", kop: t("tip.advies_kop"), tekst: adviesKop(p), knop: t("adv.titel"), ga: "advies" });
  }
  // 4. Stroom is nu duur en de batterij is leeg
  if (nuData && nuData.prijs && nuData.prijs.level === "duur" && v && v.laadtoestand != null && v.laadtoestand < 15) {
    tips.push({ icoon: "euro", kop: t("tip.duur_kop"), tekst: nuData.volgende ? t("tip.duur_tekst", { tijd: nuData.volgende.uur }) : "", ga: "overzicht", knop: t("et.overzicht") });
  }
  return tips;
}

const TIP_ICOON = {
  zon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  euro: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M17 6a7 7 0 1 0 0 12M4 10h9M4 14h9"/></svg>',
  bat: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M22 11v2M7 10v4M11 10v4"/></svg>',
};

function tekenThuis() {
  const nu = new Date();
  const datum = nu.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
  const d = thuisData && thuisData.ok ? thuisData : null;
  const w = d && d.weer;
  $("th-datum").innerHTML = esc(datum.charAt(0).toUpperCase() + datum.slice(1))
    + (w ? ` · <span class="weer-mini">${weerIcoon(w.icoon, 18)}${graden(w.temp)}</span>` : d && d.buiten != null ? ` · ${graden(d.buiten)}` : "");

  // Tegels: woonkamer, kosten tot nu, batterij
  const woon = d && d.klimaat.find((r) => (r.ruimte || r.naam).toLowerCase() === "woonkamer");
  $("th-woon").textContent = graden(woon ? woon.temp : null);
  $("th-woon-sub").textContent = woon ? (woon.actie === "heating" ? "▲ " + graden(wachtTemp[woon.id] ?? woon.doel) : t("th.doel", { temp: graden(wachtTemp[woon.id] ?? woon.doel) })) : "";
  $("th-kosten").textContent = nuData ? euro(nuData.vandaag.kosten, 2) : "–";
  const v = nuData && nuData.vermogen;
  $("th-soc").textContent = v && v.laadtoestand != null ? Math.round(v.laadtoestand) + "%" : "–";
  $("th-bat").textContent = !v ? "" : Math.abs(v.batterij) < 15 ? t("bat.rust") : t(v.batterij > 0 ? "bat.ontlaadt" : "bat.laadt", { w: watt(v.batterij) });

  const fout = haFout("th-fout");

  // Nu slim om te doen
  const tk = $("th-tips");
  const tips = slimmeTips(d);
  tk.hidden = !tips.length;
  tk.innerHTML = `<h2>${esc(t("th.tips"))}</h2>` + tips.map((x) => `<div class="tip">
      <span class="tip-icoon ${x.icoon}">${TIP_ICOON[x.icoon]}</span>
      <div class="stack groei"><b>${esc(x.kop)}</b><span class="note">${esc(x.tekst)}</span></div>
      ${x.knop ? `<button type="button" class="knop klein" ${x.ga ? `data-ga="${x.ga}"` : `data-a="${x.a}" data-id="${esc(x.id)}"`}>${esc(x.knop)}</button>` : ""}
    </div>`).join("");

  // Licht: groepen als snelle knoppen
  const lk = $("th-licht");
  const li = d && d.licht;
  lk.hidden = !li || !(li.groepen.length || li.totaal);
  if (!lk.hidden) {
    const gr = li.groepen.filter((g) => !g.ouder);
    lk.innerHTML = kopRij(t("tab.licht"), "licht") + (gr.length
      ? `<div class="mini-groepen">${gr.map((g) => {
          const s = groepStand(g);
          return `<button type="button" class="mini-groep${s.aan ? " aan" : ""}" data-a="groep" data-id="${esc(g.id)}" aria-pressed="${s.aan}" ${g.bereikbaar ? "" : "disabled"}>
            <span class="lamp-icoon">${LAMP}</span><span class="stack"><b>${esc(g.naam)}</b><small>${s.aan ? (s.helderheid != null ? s.helderheid + "%" : esc(t("li.aan_kort"))) : esc(t("li.uit_kort"))}</small></span></button>`;
        }).join("")}</div>`
      : `<div class="row end"><b class="groot">${esc(t("li.van", { aan: li.aan, totaal: li.totaal }))}</b></div>`)
      + `<button type="button" class="knop breed-knop" data-a="alles_uit" ${li.aan ? "" : "disabled"}>${esc(t("li.alles_uit"))}</button>`;
  }

  // Zonwering: scènes als chips
  const zk = $("th-zon");
  const zw = d && d.zonwering;
  zk.hidden = !zw || (!zw.gordijnen.length && !zw.scenes.length);
  if (!zk.hidden) {
    zk.innerHTML = kopRij(t("tab.zonwering"), "zonwering")
      + (zw.actief ? `<div class="regel"><span>${esc(t("zw.scene"))}</span><b class="c-oranje">${esc(zw.actief)}</b></div>` : "")
      + `<div class="chips">${zw.scenes.map((s) => `<button type="button" class="chip-knop${s.naam === zw.actief ? " vol" : ""}" data-a="zscene" data-id="${esc(s.id)}">${esc(s.naam)}</button>`).join("")}</div>`;
  }

  // Ruimtes per verdieping, gekleurd naar temperatuur
  const rk = $("th-ruimtes");
  const kl = d ? d.klimaat : [];
  rk.hidden = !kl.length;
  if (kl.length) {
    rk.innerHTML = kopRij(t("th.ruimtes"), "klimaat") + perVerdieping(kl).map((v) =>
      `<span class="sublabel">${esc(v.naam)}</span><div class="kamers-mini">${v.kamers.map((r) => {
        const doel = wachtTemp[r.id] ?? r.doel;
        return `<button type="button" class="kamer-mini${r.actie === "heating" ? " warm" : ""}${r.bereikbaar ? "" : " weg"}" data-ga="klimaat" style="${tempStijl(r.temp)}">
          <span class="naam">${esc(r.naam)}</span><b>${graden(r.temp)}</b><small>${r.actie === "heating" ? "▲ " + graden(doel) : esc(t("th.doel", { temp: graden(doel) }))}</small></button>`;
      }).join("")}</div>`).join("");
  }

  // Energie nu
  const ek = $("th-energie");
  ek.innerHTML = kopRij(t("th.energie_nu"), "energie") + (v ? `<div class="grid2 energie-mini">
      <div class="stat"><span>${esc(t("node.zon"))}</span><b class="c-zon">${watt(v.zon)}</b></div>
      <div class="stat"><span>${esc(t("node.huis"))}</span><b>${watt(v.huis)}</b></div>
      <div class="stat"><span>${esc(t("node.batterij"))}</span><b class="c-bat">${watt(v.batterij)}</b></div>
      <div class="stat"><span>${esc(t("node.net"))}</span><b class="c-net">${watt(v.net)}</b></div>
    </div>
    ${nuData.prijs ? `<div class="regel boven-lijn"><span>${esc(t("ov.tarief"))}</span><span><b>${euro(nuData.prijs.allin)}</b> <span class="chip klein">${esc(niveau(nuData.prijs.level))}</span></span></div>` : ""}`
    : `<p class="note">${esc(t("th.geen_energie"))}</p>`);
  if (fout && !d) rk.hidden = lk.hidden = zk.hidden = true;
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
          <span>${esc(s.naam)}</span>${s.bezig ? `<span class="bezig" aria-label="${esc(t("zw.bezig"))}"></span>` : actief ? VINK : ""}</button>`;
      }).join("") + `</div>${zw.helper ? "" : `<p class="note">${esc(t("zw.geen_helper"))}</p>`}</section>`;
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
for (const id of ["th-tips", "th-zon", "th-ruimtes", "th-licht", "th-energie", "kl-main", "li-main", "zw-main", "li-uit", "li-sheet-scenes"]) $(id).addEventListener("click", klik);
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

toon(TABS.includes(start) ? start : "thuis");
// Stip bij Energie als er iets aandacht nodig heeft, ook als je op een ander scherm bent
if (start !== "systeem") verversStatus();
