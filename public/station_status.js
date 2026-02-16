function $(id){ return document.getElementById(id); }
function pad2(n){ return String(n).padStart(2,"0"); }
function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function isoToYMD(iso){ return iso.replaceAll("-",""); }
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
async function loadData(){
  const authMe = await fetch("/api/auth/me", {cache:"no-store"}).then(r=>r.ok ? r.json() : null).catch(()=>null);
  const filters = authMe?.filters || {};
  const [stops, tripmap, servicesByDate, stopEvents] = await Promise.all([
    fetch("./data/stops.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/tripmap.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/services_by_date.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/stop_events.json", {cache:"no-store"}).then(r=>r.json()),
  ]);
  const data = {stops, tripmap, servicesByDate, stopEvents};
  // Apply NEC-only filtering
if(filters.region === "nec"){
  // stops
  if(data.stops){
    const out={};
    for(const [k,v] of Object.entries(data.stops)) if(NEC_STATIONS.has(String(k).toUpperCase())) out[k]=v;
    data.stops=out;
  }
  // tripmap (routes allowlist)
  if(data.tripmap){
    const out={};
    for(const [tid, meta] of Object.entries(data.tripmap)){
      const rn = String(meta?.rl || meta?.rs || "").trim();
      if(NEC_ROUTES.some(x=>x.toLowerCase()===rn.toLowerCase())) out[tid]=meta;
    }
    data.tripmap=out;
  }
  // stop_events: only NEC stations and trips still in tripmap
  if(data.stopEvents){
    const out={};
    for(const [st, evs] of Object.entries(data.stopEvents)){
      if(!NEC_STATIONS.has(String(st).toUpperCase())) continue;
      if(Array.isArray(evs)) out[st] = evs.filter(e=>Array.isArray(e) && e.length>=3 && data.tripmap?.[e[2]]);
    }
    data.stopEvents=out;
  }
  // services_by_date: only services referenced by remaining tripmap
  if(data.servicesByDate && data.tripmap){
    const allowedSvc = new Set(Object.values(data.tripmap).map(m=>String(m?.svc||"")).filter(Boolean));
    const out={};
    for(const [d, svcs] of Object.entries(data.servicesByDate)){
      if(Array.isArray(svcs)) out[d] = svcs.filter(s=>allowedSvc.has(String(s)));
      else out[d]=svcs;
    }
    data.servicesByDate=out;
  }
}
return data;
}
function nextEventForStation(stopEventsForStation, tripmap, activeSet){
  const now = new Date();
  const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
  let best = null;
  for(const [arrSec, depSec, tripId] of (stopEventsForStation||[])){
    const meta = tripmap[tripId]; if(!meta) continue;
    if(!activeSet.has(meta.svc)) continue;
    const tSec = depSec ?? arrSec;
    if(tSec==null) continue;
    if(Math.floor(tSec/86400)>0) continue;
    const sec = tSec % 86400;
    if(sec < nowSec) continue;
    if(best==null || sec < best.sec){
      best = { sec, meta };
    }
  }
  if(!best) return "—";
  const h24 = Math.floor(best.sec/3600);
  const m = pad2(Math.floor((best.sec%3600)/60));
  const isPM = h24>=12;
  const h12 = ((h24+11)%12)+1;
  const t = `${h12}:${m}${isPM?"p":"a"}`;
  const n = (best.meta.ts||best.meta.rs||"--").toString().trim() || "--";
  return `${t}  Train ${n}`;
}

const NEC_ROUTES = ["Acela", "Northeast Regional", "Keystone Service", "Cardinal", "Carolinian", "Crescent", "Palmetto", "Silver Meteor", "Silver Star", "Vermonter"];
const NEC_STATIONS = new Set(["BOS", "BBY", "RTE", "PVD", "KIN", "WLY", "MYS", "NLC", "OSB", "NHV", "BRP", "STM", "NRO", "NYP", "NWK", "EWR", "MET", "NBK", "PJC", "TRE", "CWH", "PHN", "PHL", "WIL", "NRK", "ABD", "EDW", "BWI", "BAL", "NCR", "WAS"]);

const logoutBtn = document.getElementById("logoutBtn");
if(logoutBtn){
  logoutBtn.addEventListener("click", async ()=>{
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    location.href = "/login.html";
  });
}

let DATA=null;
function buildList(){
  const q = ($("q").value||"").toLowerCase().trim();
  const view = $("view").value;
  const dateISO = $("date").value || todayISO();
  const dateYMD = isoToYMD(dateISO);
  const active = new Set((DATA.servicesByDate[dateYMD]||[]));
  const rowsEl = $("rows");
  rowsEl.innerHTML = "";
  const entries = Object.entries(DATA.stops).map(([id, s])=>({id, name:s.n || id}));
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  let shown = 0;
  for(const e of entries){
    const name = e.name.toLowerCase();
    if(q && !(e.id.toLowerCase().includes(q) || name.includes(q))) continue;

    const ev = DATA.stopEvents[e.id] || [];
    let dep=0, arr=0;
    for(const [arrSec, depSec, tripId] of ev){
      const meta = DATA.tripmap[tripId]; if(!meta) continue;
      if(!active.has(meta.svc)) continue;
      if(depSec!=null && Math.floor(depSec/86400)==0) dep++;
      if(arrSec!=null && Math.floor(arrSec/86400)==0) arr++;
    }
    if(view==="hasTrains" && (dep+arr)===0) continue;

    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td><span class="pill">${escapeHtml(e.id)}</span></td>
      <td>${escapeHtml(e.name)}</td>
      <td>${dep}</td>
      <td>${arr}</td>
      <td>${escapeHtml(nextEventForStation(ev, DATA.tripmap, active))}</td>
    `;
    tr.addEventListener("click", ()=>{
      window.location.href = `station_detail.html?station=${encodeURIComponent(e.id)}&date=${encodeURIComponent(dateISO)}`;
    });
    rowsEl.appendChild(tr);
    shown++;
  }
  $("msg").textContent = `${shown} stations`;
  $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
}

$("back").addEventListener("click", ()=> window.location.href="index.html");
$("q").addEventListener("input", buildList);
$("view").addEventListener("change", buildList);
$("date").addEventListener("change", buildList);

(async function init(){
  $("date").value = todayISO();
  DATA = await loadData();
  buildList();
})();