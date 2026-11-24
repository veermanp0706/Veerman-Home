"use strict";
/* Thuis, Klimaat, Licht en Zonwering: alles via Home Assistant (api/thuis). */

const THUIS_TABS = ["thuis", "klimaat", "licht", "zonwering"];
let thuisData = null;
let nuData = null;
let thuisTimer = null;
const wachtTemp = {};   // id -> doeltemperatuur die nog verstuurd wordt
const wachtRail = {};   // entity_id -> stand (PowerView-percentage) die nog verstuurd wordt
const verstuurTimers = {};
let schuiftNu = false;  // niet opnieuw tekenen terwijl iemand een schuif vasthoudt

const graden = (v) => (v == null ? "–" : fmtGetal(v, 1) + "°");
const procent = (v) => (v == null ? "–" : Math.round(v) + "%");
const gemiddelde = (lijst) => (lijst.length ? lijst.reduce((a, b) => a + b, 0) / lijst.length : null);

function binnenGemiddeld() {
  const k = (thuisData && thuisData.klimaat) || [];
  return gemiddelde(k.map((r) => r.temp).filter((v) => v != null));
}

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
  if (THUIS_TABS.includes(naam)) { tekenThuisTab(); verversThuis(); }
  else clearTimeout(thuisTimer);
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

function railStand(g) {
  const rail = wachtRail[g.boven_id] ?? g.rail;
  const product = wachtRail[g.onder_id] ?? g.product;
  return { rail, product };
}

/** Raampje met de stof tussen de middelste rail (vanaf boven) en de onderste rail (vanaf onder). */
function raam(rail, product) {
  const boven = Math.min(Math.max(rail ?? 0, 0), 100);
  const onder = Math.min(Math.max(100 - (product ?? 100), boven), 100);
  return `<div class="raam" role="img" aria-label="${esc(t("zw.raam_aria", { rail: procent(rail), product: procent(product) }))}">
    <i class="stof" style="top:${boven}%;height:${onder - boven}%"></i>
    <i class="rail" style="top:${boven}%"></i><i class="rail" style="top:${onder}%"></i></div>`;
}

/* ---------- Thuis ---------- */

function tekenThuis() {
  const nu = new Date();
  const datum = nu.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
  $("th-datum").textContent = datum.charAt(0).toUpperCase() + datum.slice(1) + " · " + nu.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
  $("th-binnen").textContent = graden(binnenGemiddeld());
  if (nuData && nuData.prijs) {
    $("th-prijs").textContent = euro(nuData.prijs.allin);
    $("th-niveau").textContent = niveau(nuData.prijs.level);
  } else {
    $("th-prijs").textContent = "–";
    $("th-niveau").textContent = "";
  }
  const v = nuData && nuData.vermogen;
  $("th-soc").textContent = v && v.laadtoestand != null ? Math.round(v.laadtoestand) + "%" : "–";
  $("th-bat").textContent = !v ? "" : Math.abs(v.batterij) < 15 ? t("bat.rust") : t(v.batterij > 0 ? "bat.ontlaadt" : "bat.laadt", { w: watt(v.batterij) });

  const fout = haFout("th-fout");
  const d = thuisData && thuisData.ok ? thuisData : null;

  // Zonwering
  const zk = $("th-zon");
  const zw = d && d.zonwering;
  zk.hidden = !zw || (!zw.gordijnen.length && !zw.scenes.length);
  if (!zk.hidden) {
    const voorkeur = ["overdag 1", "avond 1", "alles dicht"];
    let snel = zw.scenes.filter((s) => voorkeur.includes(s.naam.toLowerCase()));
    if (snel.length < 3) snel = zw.scenes.slice(0, 3);
    zk.innerHTML = kopRij(t("tab.zonwering"), "zonwering")
      + (zw.actief ? `<div class="regel"><span>${esc(t("zw.scene"))}</span><b class="c-oranje">${esc(zw.actief)}</b></div>` : "")
      + zw.gordijnen.map((g) => { const s = railStand(g); return `<div class="regel"><span>${esc(g.naam)}</span><span class="stil">${esc(t("zw.kort", { product: procent(s.product), rail: procent(s.rail) }))}</span></div>`; }).join("")
      + `<div class="knoppen drie">${snel.map((s) => `<button type="button" class="knop${s.naam === zw.actief ? " vol" : ""}" data-a="zscene" data-id="${esc(s.id)}">${esc(s.naam)}</button>`).join("")}</div>`;
  }

  // Ruimtes
  const rk = $("th-ruimtes");
  const kl = d ? d.klimaat : [];
  rk.hidden = !kl.length;
  if (kl.length) {
    const lampen = d.licht.lampen;
    rk.innerHTML = kopRij(t("th.ruimtes"), "klimaat") + `<div class="ruimtes">${kl.map((r) => {
      const inRuimte = lampen.filter((l) => l.ruimte && l.ruimte === r.ruimte);
      const aan = inRuimte.filter((l) => l.aan).length;
      const doel = wachtTemp[r.id] ?? r.doel;
      const warm = r.actie === "heating";
      return `<button type="button" class="ruimte${warm ? " warm" : ""}" data-ga="klimaat">
        <span class="naam">${esc(r.naam)}</span><b>${graden(r.temp)}</b>
        <span class="${warm ? "c-oranje sterk" : ""}">${warm ? esc(t("th.verwarmt_naar", { temp: graden(doel) })) : esc(t("th.doel", { temp: graden(doel) }))}</span>
        ${inRuimte.length ? `<span>${aan ? esc(t(aan === 1 ? "th.lamp_aan" : "th.lampen_aan", { n: aan })) : esc(t("th.licht_uit"))}</span>` : ""}
      </button>`;
    }).join("")}</div>`;
  }

  // Licht
  const lk = $("th-licht");
  const li = d && d.licht;
  lk.hidden = !li || !li.totaal;
  if (!lk.hidden) {
    lk.innerHTML = kopRij(t("tab.licht"), "licht")
      + `<div class="row end"><b class="groot">${esc(t("li.van", { aan: li.aan, totaal: li.totaal }))}</b>
         <button type="button" class="knop${li.aan ? " vol" : ""}" data-a="alles_uit" ${li.aan ? "" : "disabled"}>${esc(t("li.alles_uit"))}</button></div>`;
  }

  // Energie
  const ek = $("th-energie");
  ek.innerHTML = kopRij(t("th.energie_nu"), "energie") + (v ? `<div class="grid2">
      <div class="stat"><span>${esc(t("node.zon"))}</span><b class="c-zon">${watt(v.zon)}</b></div>
      <div class="stat"><span>${esc(t("node.huis"))}</span><b>${watt(v.huis)}</b></div>
      <div class="stat"><span>${esc(t("node.batterij"))}</span><b class="c-bat">${watt(v.batterij)}</b></div>
      <div class="stat"><span>${esc(t("node.net"))}</span><b class="c-net">${watt(v.net)}</b></div>
    </div>
    <div class="regel boven-lijn"><span>${esc(t("stat.kosten_vandaag"))}</span><b>${euro(nuData.vandaag.kosten)}</b></div>`
    : `<p class="note">${esc(t("th.geen_energie"))}</p>`);
  if (fout && !d) rk.hidden = lk.hidden = zk.hidden = true;
}

/* ---------- Klimaat ---------- */

function tekenKlimaat() {
  const main = $("kl-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  const kl = d ? d.klimaat : [];
  $("kl-gem").textContent = graden(binnenGemiddeld());
  const warm = kl.filter((r) => r.actie === "heating").length;
  $("kl-chip").hidden = !warm;
  $("kl-chip").textContent = t(warm === 1 ? "kl.verwarmt_1" : "kl.verwarmt_n", { n: warm });
  $("kl-buiten").textContent = graden(d ? d.buiten : null);
  const vocht = gemiddelde(kl.map((r) => r.vocht).filter((x) => x != null));
  $("kl-vocht").textContent = procent(vocht);
  $("kl-aantal").textContent = kl.length || "–";

  if (!d) { main.innerHTML = `<p class="card leeg">${esc(thuisData && thuisData.fout === "geen_toegang" ? t("th.geen_toegang") : t("th.laden"))}</p>`; return; }
  if (!kl.length) { main.innerHTML = `<p class="card leeg">${esc(t("kl.geen"))}</p>`; return; }
  main.innerHTML = kl.map((r) => {
    const doel = wachtTemp[r.id] ?? r.doel;
    const status = !r.bereikbaar ? ["fout", t("th.onbereikbaar")] : r.modus === "off" ? ["", t("kl.uit")]
      : r.actie === "heating" ? ["warm", t("kl.verwarmt")] : ["ok", t("kl.op_temp")];
    const uit = r.modus === "off" || !r.bereikbaar;
    return `<section class="card" aria-label="${esc(r.naam)}">
      <div class="row"><h2>${esc(r.naam)}</h2><span class="badge ${status[0]}">${esc(status[1])}</span></div>
      <div class="kamer">
        <div class="stack groei"><b class="kamer-temp">${graden(r.temp)}</b><span class="note">${r.vocht != null ? esc(t("kl.vocht_kort", { v: procent(r.vocht) })) : ""}</span></div>
        <button type="button" class="rond" data-a="temp" data-id="${esc(r.id)}" data-delta="-1" aria-label="${esc(t("kl.lager", { naam: r.naam }))}" ${uit ? "disabled" : ""}>−</button>
        <div class="stack doel"><span class="note">${esc(t("kl.doel"))}</span><b class="${r.actie === "heating" ? "c-oranje" : ""}">${graden(doel)}</b></div>
        <button type="button" class="rond" data-a="temp" data-id="${esc(r.id)}" data-delta="1" aria-label="${esc(t("kl.hoger", { naam: r.naam }))}" ${uit ? "disabled" : ""}>+</button>
      </div>
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

function tekenLicht() {
  const main = $("li-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  const li = d ? d.licht : null;
  $("li-aan").innerHTML = li ? `${li.aan} <small>${esc(t("li.van_kort", { totaal: li.totaal }))}</small>` : "–";
  $("li-uit").disabled = !li || !li.aan;
  const laatste = li ? li.scenes.filter((s) => s.laatst).sort((a, b) => (a.laatst < b.laatst ? 1 : -1))[0] : null;
  $("li-scene").textContent = laatste ? laatste.naam : "–";
  $("li-scene-groep").textContent = laatste && laatste.groep ? laatste.groep : "";

  if (!li) { main.innerHTML = `<p class="card leeg">${esc(thuisData && thuisData.fout === "geen_toegang" ? t("th.geen_toegang") : t("th.laden"))}</p>`; return; }
  if (!li.totaal) { main.innerHTML = `<p class="card leeg">${esc(t("li.geen"))}</p>`; return; }

  let html = "";
  if (li.scenes.length) {
    const groepen = [...new Set(li.scenes.map((s) => s.groep || ""))];
    html += `<section class="card breed" aria-label="${esc(t("li.scenes"))}"><h2>${esc(t("li.scenes"))}</h2>` + groepen.map((g) =>
      (groepen.length > 1 ? `<span class="sublabel">${esc(g || t("li.overig"))}</span>` : "")
      + `<div class="chips">${li.scenes.filter((s) => (s.groep || "") === g).map((s) =>
        `<button type="button" class="chip-knop${s.actief ? " vol" : ""}" data-a="scene" data-id="${esc(s.id)}">${esc(s.naam)}</button>`).join("")}</div>`).join("") + `</section>`;
  }
  const ruimtes = [...new Set(li.lampen.map((l) => l.ruimte || ""))];
  html += ruimtes.map((r) => {
    const lampen = li.lampen.filter((l) => (l.ruimte || "") === r);
    const aan = lampen.filter((l) => l.aan).length;
    return `<section class="card" aria-label="${esc(r || t("li.overig"))}">
      <div class="row"><h2>${esc(r || t("li.overig"))}</h2><span class="note ${aan ? "c-zon sterk" : ""}">${aan ? esc(t("li.n_aan", { n: aan })) : esc(t("li.uit"))}</span></div>
      <div class="lampen">${lampen.map((l) => `<div class="lamp${l.aan ? " aan" : ""}${l.bereikbaar ? "" : " weg"}">
          <button type="button" class="lamp-knop" data-a="licht" data-id="${esc(l.id)}" aria-pressed="${l.aan}" ${l.bereikbaar ? "" : "disabled"}>
            <b>${esc(l.naam)}</b><span>${!l.bereikbaar ? esc(t("th.onbereikbaar")) : l.aan ? (l.helderheid != null ? l.helderheid + "%" : esc(t("li.aan_kort"))) : esc(t("li.uit_kort"))}</span>
          </button>
          ${l.aan && l.dimbaar ? `<input type="range" min="1" max="100" step="1" value="${l.helderheid ?? 100}" data-a="helderheid" data-id="${esc(l.id)}" aria-label="${esc(t("li.helderheid", { naam: l.naam }))}">` : ""}
        </div>`).join("")}</div>
    </section>`;
  }).join("");
  main.innerHTML = html;
}

/* ---------- Zonwering ---------- */

function tekenZonwering() {
  const main = $("zw-main");
  const d = thuisData && thuisData.ok ? thuisData : null;
  const v = nuData && nuData.vermogen;
  $("zw-zon").textContent = v ? watt(v.zon) : "–";
  $("zw-binnen").textContent = graden(binnenGemiddeld());
  if (!d) { main.innerHTML = `<p class="card leeg">${esc(thuisData && thuisData.fout === "geen_toegang" ? t("th.geen_toegang") : t("th.laden"))}</p>`; return; }
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
  if (!zw.gordijnen.length) {
    html += `<p class="card leeg">${esc(t("zw.geen"))}</p>`;
  }
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

for (const id of ["th-zon", "th-ruimtes", "th-licht", "th-energie", "kl-main", "li-main", "zw-main", "li-uit"]) {
  $(id).addEventListener("click", (e) => {
    const ga = e.target.closest("[data-ga]");
    if (ga) { toon(ga.dataset.ga); return; }
    const k = e.target.closest("[data-a]");
    if (!k || k.disabled || k.tagName === "INPUT") return;
    const a = k.dataset.a;
    if (a === "temp") stapTemp(k.dataset.id, Number(k.dataset.delta));
    else if (a === "rail") stapRail(k.dataset.id, Number(k.dataset.delta));
    else if (a === "licht") {
      const l = thuisData.licht.lampen.find((x) => x.id === k.dataset.id);
      if (l) { l.aan = !l.aan; tekenThuisTab(); actie({ soort: "licht", id: l.id, aan: l.aan }); }
    } else if (a === "alles_uit") {
      thuisData.licht.lampen.forEach((l) => { l.aan = false; });
      thuisData.licht.aan = 0;
      tekenThuisTab();
      actie({ soort: "alles_uit" });
    } else if (a === "scene") actie({ soort: "scene", id: k.dataset.id });
    else if (a === "zscene") {
      const s = thuisData.zonwering.scenes.find((x) => x.id === k.dataset.id);
      if (s) { thuisData.zonwering.actief = s.naam; s.bezig = true; tekenThuisTab(); }
      actie({ soort: "zonwering_scene", id: k.dataset.id });
    }
  });
}
$("li-uit").dataset.a = "alles_uit";

const liMain = $("li-main");
liMain.addEventListener("pointerdown", (e) => { if (e.target.matches("input[type=range]")) schuiftNu = true; });
document.addEventListener("pointerup", () => { if (schuiftNu) { schuiftNu = false; } });
liMain.addEventListener("change", (e) => {
  const k = e.target;
  if (k.dataset.a !== "helderheid") return;
  schuiftNu = false;
  const l = thuisData.licht.lampen.find((x) => x.id === k.dataset.id);
  if (l) l.helderheid = Number(k.value);
  actie({ soort: "helderheid", id: k.dataset.id, waarde: Number(k.value) });
});
liMain.addEventListener("input", (e) => {
  const k = e.target;
  if (k.dataset.a === "helderheid") { const s = k.parentElement.querySelector(".lamp-knop span"); if (s) s.textContent = k.value + "%"; }
});

/* ---------- Opstarten ---------- */

toon(TABS.includes(start) ? start : "thuis");
// Stip bij Energie als er iets aandacht nodig heeft, ook als je op een ander scherm bent
if (start !== "status") verversStatus();
