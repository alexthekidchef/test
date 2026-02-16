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
function timeToBoard(sec){
  if(sec == null || Number.isNaN(sec)) return "--";
  const dayOffset = Math.floor(sec / 86400);
  if(dayOffset > 0) return "--";
  const s = sec % 86400;
  const h24 = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ampm = h24 >= 12 ? "p" : "a";
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${pad2(m)}${ampm}`;
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
function inferPastOrFuture(tSec){
  const now = new Date();
  const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
  const sec = (tSec%86400);
  return sec < nowSec ? "past" : "future";
}

function stationTimeZone(code){
  try{
    const st = (DATA && DATA.stops) ? DATA.stops[code] : null;
    const lon = st ? parseFloat(st.lon) : NaN;
    // crude US timezone bands by longitude
    if(!isNaN(lon)){
      if(lon <= -114) return "America/Los_Angeles";      // Pacific
      if(lon <= -102) return "America/Denver";           // Mountain
      if(lon <= -85)  return "America/Chicago";          // Central
      return "America/New_York";                         // Eastern
    }
  }catch(e){}
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// Returns offset minutes between UTC and given timeZone at a UTC date.
function tzOffsetMinutes(utcDate, timeZone){
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12:false,
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
  const parts = dtf.formatToParts(utcDate);
  const map = {};
  for(const p of parts) if(p.type!=="literal") map[p.type]=p.value;
  const asUTC = Date.UTC(+map.year, +map.month-1, +map.day, +map.hour, +map.minute, +map.second);
  return (asUTC - utcDate.getTime()) / 60000;
}

// Build a Date (UTC instant) that corresponds to a local service date + seconds in a specific time zone.
function dateFromServiceSeconds(serviceDateISO, seconds, timeZone){
  // serviceDateISO: "YYYY-MM-DD"
  const [Y,M,D] = serviceDateISO.split("-").map(x=>parseInt(x,10));
  // start with UTC midnight of that date
  let utc = new Date(Date.UTC(Y, M-1, D, 0, 0, 0));
  // compute offset at that moment for the target zone and shift so that formatting in zone shows midnight
  const off = tzOffsetMinutes(utc, timeZone);
  // utcAdjusted represents local midnight in that zone
  const utcAdjusted = new Date(utc.getTime() - off*60000 + (seconds||0)*1000);
  return utcAdjusted;
}

function formatServiceTime(seconds, timeZone, serviceDateISO){
  if(typeof seconds !== "number") return "--";
  const d = dateFromServiceSeconds(serviceDateISO, seconds, timeZone);
  return new Intl.DateTimeFormat("en-US", { timeZone, hour:"numeric", minute:"2-digit" }).format(d).replace(" AM","a").replace(" PM","p").replace(" am","a").replace(" pm","p");
}

const NEC_ROUTES = ["Acela", "Northeast Regional", "Keystone Service", "Cardinal", "Carolinian", "Crescent", "Palmetto", "Silver Meteor", "Silver Star", "Vermonter"];
const NEC_STATIONS = new Set(["BOS", "BBY", "RTE", "PVD", "KIN", "WLY", "MYS", "NLC", "OSB", "NHV", "BRP", "STM", "NRO", "NYP", "NWK", "EWR", "MET", "NBK", "PJC", "TRE", "CWH", "PHN", "PHL", "WIL", "NRK", "ABD", "EDW", "BWI", "BAL", "NCR", "WAS"]);

function buildTripOrigins(stopEvents){
  const origin = {};
  for(const [st, evs] of Object.entries(stopEvents||{})){
    if(!Array.isArray(evs)) continue;
    for(const e of evs){
      if(!Array.isArray(e) || e.length < 3) continue;
      const [arrSec, depSec, tripId] = e;
      const tt = Math.min(
        (typeof arrSec==="number") ? arrSec : Infinity,
        (typeof depSec==="number") ? depSec : Infinity
      );
      const id = String(tripId);
      if(!origin[id] || tt < origin[id].t) origin[id] = {st:String(st), t:tt};
    }
  }
  const out = {};
  for(const [tid,v] of Object.entries(origin)) out[tid]=v.st;
  return out;
}

const logoutBtn = document.getElementById("logoutBtn");
if(logoutBtn){
  logoutBtn.addEventListener("click", async ()=>{
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    location.href = "/login.html";
  });
}

let DATA=null;
let station=null;
let activeTab="departures"; // default; can be overridden by ?tab=

function render(){
  const q = ($("q").value||"").toLowerCase().trim();
  const dateISO = $("date").value || todayISO();
  const dateYMD = isoToYMD(dateISO);
  const active = new Set((DATA.servicesByDate[dateYMD]||[]));
  const ev = DATA.stopEvents[station] || [];
  const rows=[];
  for(const [arrSec, depSec, tripId] of ev){
    const meta=DATA.tripmap[tripId]; if(!meta) continue;
    if(!active.has(meta.svc)) continue;
    const routeName = (meta.rl && meta.rl.trim()) ? meta.rl.trim()
                    : (meta.rs && meta.rs.trim()) ? meta.rs.trim()
                    : "Train";
    const trainNo = (meta.ts && meta.ts.trim()) ? meta.ts.trim() : (meta.rs && meta.rs.trim()) ? meta.rs.trim() : "--";
    const head = (meta.hd && meta.hd.trim()) ? meta.hd.trim() : "--";
    const origins = buildTripOrigins(DATA.stopEvents);
    const originCode = origins[String(tripId)];
    const originName = originCode ? (DATA.stops?.[originCode]?.n || originCode) : "--";
    if(depSec!=null && Math.floor(depSec/86400)==0){
      rows.push({kind:"departures", timeSec:depSec, time:formatServiceTime(depSec, stationTimeZone(station), serviceDateISO), no:trainNo, route:routeName, dir:head, status: inferPastOrFuture(depSec)==="past"?"Departed":"Scheduled", tripId});
    }
    if(arrSec!=null && Math.floor(arrSec/86400)==0){
      rows.push({kind:"arrivals", timeSec:arrSec, time:formatServiceTime(arrSec, stationTimeZone(station), serviceDateISO), no:trainNo, route:routeName, dir:originName, status: inferPastOrFuture(arrSec)==="past"?"Arrived":"Scheduled", tripId});
    }
  }
  rows.sort((a,b)=>a.timeSec-b.timeSec);

  const filtered = rows.filter(r=>{
    if(activeTab!=="all" && r.kind!==activeTab) return false;
    if(!q) return true;
    const hay = `${r.no} ${r.route} ${r.dir} ${r.status}`.toLowerCase();
    return hay.includes(q);
  });

  $("msg").textContent = `${filtered.length} events`;
  $("rows").innerHTML = filtered.map(r=>`
    <tr data-trip="${escapeHtml(r.tripId)}">
      <td>${escapeHtml(r.time)}</td>
      <td>${escapeHtml(r.no)}</td>
      <td>${escapeHtml(r.route)}</td>
      <td>${escapeHtml(r.dir)}</td>
      <td><span class="pill">${escapeHtml(r.status)}</span></td>
    </tr>
  `).join("");

  document.querySelectorAll('tr[data-trip]').forEach(tr=>{
    tr.addEventListener("click", ()=>{
      const tripId = tr.getAttribute("data-trip");
      window.location.href = `trip_detail.html?station=${encodeURIComponent(station)}&trip=${encodeURIComponent(tripId)}&date=${encodeURIComponent(dateISO)}`;
    });
  });

  $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
}

function setTab(tab){
  activeTab=tab;
  document.querySelectorAll(".tab").forEach(el=>{
    el.classList.toggle("active", el.dataset.tab===tab);
  });
  const hdr = document.getElementById("toFromHdr");
  if(hdr) hdr.textContent = (activeTab==="arrivals") ? "From" : "To";
  const initHdr=document.getElementById("toFromHdr");
  if(initHdr) initHdr.textContent = (activeTab==="arrivals") ? "From" : "To";
  render();
}

$("back").addEventListener("click", ()=> window.location.href="station_status.html");
$("q").addEventListener("input", render);
$("date").addEventListener("change", render);
document.querySelectorAll(".tab").forEach(el=>{
  el.addEventListener("click", ()=> setTab(el.dataset.tab));
});

(async function init(){
  const p = new URLSearchParams(window.location.search);
  station = (p.get("station")||"").toUpperCase();
  const tabParam = (p.get("tab")||"").toLowerCase();
  if(tabParam==="arrivals"||tabParam==="departures"||tabParam==="all") setTab(tabParam);
  $("date").value = p.get("date") || todayISO();
  DATA = await loadData();
  const name = DATA.stops?.[station]?.n || station;
  $("title").textContent = `${name} (${station})`;
  const hdr = document.getElementById("toFromHdr");
  if(hdr) hdr.textContent = (activeTab==="arrivals") ? "From" : "To";
  render();
})();