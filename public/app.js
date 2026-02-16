
function filterStations(inputId, selectId){
  const q = ($(inputId).value||"").toLowerCase();
  const sel = $(selectId);
  const opts = Array.from(sel.options);
  opts.forEach(o=>{
    const t=o.text.toLowerCase();
    o.hidden = q && !t.includes(q);
  });
}

/* Amtrak board v4
   - Uses GTFS JSON in ./data/
   - Two layouts:
       Info Mode (workstation list, flat colors)
       Display Mode (fixed 1920x1080 signage canvas)
   - Departures: white headers + blue rows
   - Arrivals: blue headers + white rows
   - No bold text (CSS enforces weight 400)
*/

const NEC_STATIONS = new Set(["BOS", "BBY", "RTE", "PVD", "KIN", "WLY", "MYS", "NLC", "OSB", "NHV", "BRP", "STM", "NRO", "NYP", "NWK", "EWR", "MET", "NBK", "PJC", "TRE", "CWH", "PHN", "PHL", "WIL", "NRK", "ABD", "EDW", "BWI", "BAL", "NCR", "WAS"]);
const NEC_ROUTES = ["Acela", "Northeast Regional", "Keystone Service", "Cardinal", "Carolinian", "Crescent", "Palmetto", "Silver Meteor", "Silver Star", "Vermonter"];

const LS = {
  prefs: "amtrak_board_prefs_v4",
  overrides: "amtrak_board_overrides_v4"
};

const state = {
  stationId: null,
  boardType: "departures",
  dateISO: null,
  ticker: "",
  realtime: "on",
  data: null,
  tickerPos: 1920,
  tickerRAF: null
};

function applyAccountFilters(data, filters){
  if(!filters || filters.region !== "nec") return data;

  // Filter stops
  if(data.stops){
    const out = {};
    for(const [k,v] of Object.entries(data.stops)){
      if(NEC_STATIONS.has(String(k).toUpperCase())) out[k]=v;
    }
    data.stops = out;
  }

  // Filter tripmap by explicit route allowlist (matches rl or rs)
  const allowedTrip = new Set();
  if(data.tripmap){
    const out = {};
    for(const [tid, meta] of Object.entries(data.tripmap)){
      const rn = String(meta?.rl || meta?.rs || "").trim();
      if(NEC_ROUTES.some(x=>x.toLowerCase()===rn.toLowerCase())){
        out[tid]=meta;
        allowedTrip.add(String(tid));
      }
    }
    data.tripmap = out;
  }

  // Filter stop_events: only NEC stations, only allowed trips
  if(data.stopEvents){
    const out = {};
    for(const [st, evs] of Object.entries(data.stopEvents)){
      const code = String(st).toUpperCase();
      if(!NEC_STATIONS.has(code)) continue;
      if(Array.isArray(evs)){
        out[st] = evs.filter(e=>Array.isArray(e) && e.length>=3 && allowedTrip.has(String(e[2])));
      }
    }
    data.stopEvents = out;
  }

  // Filter services_by_date to services that exist in remaining tripmap
  if(data.servicesByDate && data.tripmap){
    const allowedSvc = new Set(Object.values(data.tripmap).map(m=>String(m?.svc||"")).filter(Boolean));
    const out = {};
    for(const [d, svcs] of Object.entries(data.servicesByDate)){
      if(Array.isArray(svcs)){
        out[d] = svcs.filter(s=>allowedSvc.has(String(s)));
      }else out[d]=svcs;
    }
    data.servicesByDate = out;
  }

  return data;
}

function buildTripOrigins(stopEvents){
  // Build tripId -> origin station code by scanning earliest time across all stations.
  const origin = {};
  if(!stopEvents) return origin;
  for(const [st, evs] of Object.entries(stopEvents)){
    if(!Array.isArray(evs)) continue;
    for(const e of evs){
      if(!Array.isArray(e) || e.length < 3) continue;
      const [arrSec, depSec, tripId] = e;
      const t = Math.min(
        (typeof arrSec==="number") ? arrSec : Infinity,
        (typeof depSec==="number") ? depSec : Infinity
      );
      const id = String(tripId);
      if(!origin[id] || t < origin[id].t){
        origin[id] = { st: String(st), t };
      }
    }
  }
  const out = {};
  for(const [tid, v] of Object.entries(origin)) out[tid]=v.st;
  return out;
}


// --- Realtime (Train Tracker) cache ---
let _rtCache = { ts: 0, data: null, err: null };

// Parse a time string from realtime station objects.
// Commonly ISO-like or RFC; fall back to returning null.
function parseRtTime(s){
  if(!s) return null;
  const d = new Date(s);
  if(!isNaN(d.getTime())) return d;
  // Try "YYYY-MM-DD HH:MM" or "MM/DD/YYYY HH:MM"
  let m = String(s).match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if(m){
    const d2 = new Date(m[1] + "T" + m[2] + ":00");
    if(!isNaN(d2.getTime())) return d2;
  }
  m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4}).*?(\d{1,2}):(\d{2})/);
  if(m){
    const mm = pad2(Number(m[1]));
    const dd = pad2(Number(m[2]));
    const yyyy = m[3];
    const hh = pad2(Number(m[4]));
    const mi = pad2(Number(m[5]));
    const d2 = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00`);
    if(!isNaN(d2.getTime())) return d2;
  }
  return null;
}

function fmtShortTimeForStation(tz, dateObj){
  // returns "7:42a" / "7:42p"
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute:"2-digit", hour12: true });
  const s = fmt.format(dateObj); // e.g. "7:42 AM"
  const m = s.match(/^(\d+:\d{2})\s*(AM|PM)$/i);
  if(!m) return s;
  return m[1] + (m[2].toUpperCase()==="AM" ? "a" : "p");
}
function $(id){ return document.getElementById(id); }
function pad2(n){ return String(n).padStart(2,"0"); }
function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function isoToYMD(iso){ return iso.replaceAll("-",""); }

function fmtClock(d){
  let h = d.getHours();
  const m = pad2(d.getMinutes());
  const ampm = h >= 12 ? "PM" : "AM";
  h = ((h + 11) % 12) + 1;
  return `${h}:${m} ${ampm}`;
}
function tickClocks(){
  const tz = stationTimeZone();
  const t = fmtClockInZone(tz);
  if($("infoClock")) $("infoClock").textContent = t;
  if($("dispClock")) $("dispClock").textContent = t;
}
setInterval(tickClocks, 1000); tickClocks();

function loadPrefs(){
  try{
    const raw = localStorage.getItem(LS.prefs);
    if(!raw) return;
    const p = JSON.parse(raw);
    if(p.stationId) state.stationId = p.stationId;
    if(p.boardType) state.boardType = p.boardType;
    if(p.dateISO) state.dateISO = p.dateISO;
    if(typeof p.ticker === "string") state.ticker = p.ticker;
    state.realtime = "on";
  }catch{}
}
function savePrefs(){
  localStorage.setItem(LS.prefs, JSON.stringify({
    stationId: state.stationId,
    boardType: state.boardType,
    dateISO: state.dateISO,
    ticker: state.ticker,
    realtime: "on"
  }));
}

function loadOverrides(){
  try{
    const raw = localStorage.getItem(LS.overrides);
    if(!raw) return {};
    const o = JSON.parse(raw);
    return (o && typeof o === "object") ? o : {};
  }catch{ return {}; }
}
function saveOverrides(o){
  localStorage.setItem(LS.overrides, JSON.stringify(o));
}
function ovKey(dateYMD, stopId, tripId){
  return `${dateYMD}|${stopId}|${tripId}`;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

const logoutBtn = document.getElementById("logoutBtn");
if(logoutBtn){
  logoutBtn.addEventListener("click", async ()=>{
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    location.href = "/login.html";
  });
}

function deriveRtStatus(trainObj, stationObj, isDepartures, nowSec){
  // Prefer provider status strings if present
  const cand = [
    trainObj?.status, trainObj?.train_status, trainObj?.trainStatus,
    stationObj?.status, stationObj?.stationStatus
  ].filter(x=>typeof x === "string" && x.trim());
  if(cand.length) return cand[0];

  const actual = stationObj?.arr_actual ?? stationObj?.arrActual ?? stationObj?.arrivalActual ?? stationObj?.actualArrival
              ?? stationObj?.dep_actual ?? stationObj?.depActual ?? stationObj?.departureActual ?? stationObj?.actualDeparture;
  const est = stationObj?.arr_est ?? stationObj?.arrEst ?? stationObj?.arrivalEstimated ?? stationObj?.estimatedArrival
           ?? stationObj?.dep_est ?? stationObj?.depEst ?? stationObj?.departureEstimated ?? stationObj?.estimatedDeparture;
  const sch = stationObj?.arr_sch ?? stationObj?.arrSch ?? stationObj?.arrivalScheduled ?? stationObj?.scheduledArrival
           ?? stationObj?.dep_sch ?? stationObj?.depSch ?? stationObj?.departureScheduled ?? stationObj?.scheduledDeparture;

  const tA = (typeof actual === "number") ? actual : null;
  const tE = (typeof est === "number") ? est : null;
  const tS = (typeof sch === "number") ? sch : null;

  if(!isDepartures && (stationObj?.arrived === true || stationObj?.hasArrived === true)) return "Arrived";
  if(isDepartures && (stationObj?.departed === true || stationObj?.hasDeparted === true)) return "Departed";

  if(!isDepartures && tA != null && tA <= nowSec) return "Arrived";
  if(isDepartures && tA != null && tA <= nowSec) return "Departed";

  if(tE != null && tS != null){
    const diffMin = Math.round((tE - tS)/60);
    if(diffMin >= 5) return `Delayed ${diffMin}m`;
    if(diffMin <= -5) return `Early ${Math.abs(diffMin)}m`;
  }
  return null;
}

// --- Station timezone helpers (by stop longitude, best-effort) ---
function tzFromLon(lon){
  const x = Number(lon);
  if(!Number.isFinite(x)) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if(x <= -154) return "Pacific/Honolulu";
  if(x <= -130) return "America/Anchorage";
  if(x <= -114) return "America/Los_Angeles";
  if(x <= -102) return "America/Denver";
  if(x <= -85)  return "America/Chicago";
  return "America/New_York";
}
function stationTimeZone(){
  const s = state.data?.stops?.[state.stationId];
  return tzFromLon(s?.lon);
}
function nowInZoneParts(tz){
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
  const parts = fmt.formatToParts(d);
  const get = (t)=> parts.find(p=>p.type===t)?.value;
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}
function fmtClockInZone(tz){
  const p = nowInZoneParts(tz);
  const h24 = p.hour;
  const m = pad2(p.minute);
  const isPM = h24 >= 12;
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${m} ${isPM ? "PM" : "AM"}`;
}


function tzFromLon(lon){
  if(lon==null || isNaN(lon)) return "America/New_York";
  if(lon <= -115) return "America/Los_Angeles";
  if(lon <= -105) return "America/Denver";
  if(lon <= -90)  return "America/Chicago";
  return "America/New_York";
}
function formatHM(epochSec, tz){
  try{
    const d=new Date(epochSec*1000);
    return new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',hour12:true,timeZone:tz}).format(d);
  }catch(e){
    const d=new Date(epochSec*1000);
    return d.formatHM(Math.floor(Date.now()/1000), tzFromLon(state.stationLon||-77));
  }
}


function rtEndpointCandidates(){
  return [
    "/api/rt/trains",
    "/api/rt/trains"
  ];
}

async function fetchRealtimeAllTrains(){
  const now = Date.now();
  if(_rtCache?.data && (now - _rtCache.ts) < 30000) return _rtCache.data;
  _rtCache = _rtCache || { ts: 0, data: null, err: null };
  _rtCache.err = null;

  for(const url of rtEndpointCandidates()){
    try{
      const r = await fetch(url, { cache: "no-store" });
      if(!r.ok){
      if(url.includes("/api/rt/trains") && r.status===401){
        // Not logged in to local server
        location.href = "/login.html?next=" + btoa("/index.html").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
        return null;
      }
      if(url.includes("/api/rt/trains") && r.status===403){
        alert("Your account does not have access to realtime data.");
        return null;
      }
      if(url.includes("/api/rt/trains") && r.status===404){
        console.warn("Realtime proxy /api/rt/trains not found. Start the app with run_windows.bat (python server.py) instead of python -m http.server.");
      }
      throw new Error("HTTP " + r.status);
    }
      const data = await r.json();
      _rtCache = { ts: now, data, err: null };
      return data;
    }catch(e){
      _rtCache.err = e;
      continue;
    }
  }
  _rtCache = { ts: now, data: null, err: _rtCache.err || new Error("No realtime endpoint reachable") };
  return null;
}


function getRealtimeUrl(){
  // Prefer local proxy endpoint if available (server.py), fall back to direct.
  return "/api/rt/trains";
}
async function fetchRealtimeDirect(){
  const r = await fetch("/api/rt/trains", { cache:"no-store" });
  if(!r.ok){
      if(url.includes("/api/rt/trains") && r.status===404){
        console.warn("Realtime proxy /api/rt/trains not found. Start the app with run_windows.bat (python server.py) instead of python -m http.server.");
      }
      throw new Error("HTTP " + r.status);
    }
  return await r.json();
}

async function loadData(){
  const [stops, tripmap, servicesByDate, stopEvents] = await Promise.all([
    fetch("./data/stops.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/tripmap.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/services_by_date.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/stop_events.json", {cache:"no-store"}).then(r=>r.json()),
  ]);
  state.data = {stops, tripmap, servicesByDate, stopEvents};
}

function populateStations(selectEl){
  const stops = state.data.stops;
  const entries = Object.entries(stops).map(([id, s])=>({id, name:s.n || id}));
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  selectEl.innerHTML = entries.map(e=>`<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");

  if(!state.stationId || !stops[state.stationId]){
    const guess = entries.find(e=>/Washington Union/i.test(e.name))?.id
              || entries.find(e=>/New York/i.test(e.name))?.id
              || entries[0]?.id;
    state.stationId = guess;
  }
  selectEl.value = state.stationId;
}

function timeToBoard(sec){
  if(sec == null || Number.isNaN(sec)) return "--";
  const dayOffset = Math.floor(sec / 86400);
  if(dayOffset > 0) return "--"; // v1: show only today's board
  const s = sec % 86400;
  const h24 = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ampm = h24 >= 12 ? "p" : "a";
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${pad2(m)}${ampm}`;
}

function inferStatus(isDepartures, tSec, nowSec){
  if(!isDepartures){
    // Arrivals: mark trains that have already arrived.
    return (tSec != null && tSec <= nowSec) ? "Arrived" : "On Time";
  }
  const mins = (tSec - nowSec) / 60;
  if(mins <= 15 && mins >= -5) return "Boarding";
  return "On Time";
}

async function buildRows(){
  const { tripmap, servicesByDate, stopEvents } = state.data;
  const dateYMD = isoToYMD(state.dateISO);
  const active = new Set(servicesByDate[dateYMD] || []);
  const events = stopEvents[state.stationId] || [];
  const overrides = loadOverrides();
  const origins = buildTripOrigins(stopEvents);

  const tzNow = stationTimeZone();
  const pNow = nowInZoneParts(tzNow);
  const nowSec = pNow.hour*3600 + pNow.minute*60 + pNow.second;

  const isDep = state.boardType === "departures";

  // Don't show trains already departed/arrived.
  // Keep a tiny grace period so something doesn't vanish mid-refresh.
  const pastGrace = isDep ? 120 : 24*3600; // seconds (arrivals show since midnight)
  const futureWindow = 6*3600; // next 6 hours
  const windowStart = Math.max(0, nowSec - pastGrace);
  const windowEnd = nowSec + 8*3600;

  const rows = [];
  for(const [arrSec, depSec, tripId] of events){
    const meta = tripmap[tripId];
    if(!meta) continue;
    if(!active.has(meta.svc)) continue;

    const tSec = isDep ? depSec : arrSec;
    if(tSec == null) continue;
    if(Math.floor(tSec/86400) > 0) continue;

    if(tSec < windowStart || tSec > windowEnd) continue;

    const key = ovKey(dateYMD, state.stationId, tripId);
    const ov = overrides[key] || {};

    const routeName = (meta.rl && meta.rl.trim()) ? meta.rl.trim()
                    : (meta.rs && meta.rs.trim()) ? meta.rs.trim()
                    : "Train";
    let to = (meta.hd && meta.hd.trim()) ? meta.hd.trim() : "--";
    if(!isDep){
      const o = origins[String(tripId)];
      if(o && state.data.stops && state.data.stops[o]) to = state.data.stops[o].n || o;
      else if(o) to = o;
    }
    const no = (meta.ts && meta.ts.trim()) ? meta.ts.trim() : (meta.rs && meta.rs.trim()) ? meta.rs.trim() : "--";

    let status = inferStatus(isDep, tSec, nowSec);
    if(ov.status) status = ov.status;

    rows.push({
      tripId,
      sort: tSec,
      time: timeToBoard(tSec),
      no,
      train: routeName,
      to,
      status,
      gate: ov.gate || "--",
      track: ov.track || "--"
    });
  }

  
  rows.sort((a,b)=>a.sort-b.sort);

  // Realtime overlay: replace status with "Now HH:MM" when actual time differs and train hasn't departed.
  if(state.realtime === "on"){
    const rt = await fetchRealtimeAllTrains();
    if(rt && rows && rows.length){
      const tz = stationTimeZone();
      const stationCode = state.stationId;
      const isDep = state.boardType === "departures";
      for(const r of rows){
        const trainNum = String(r.no || "").trim();
        const trains = rt[trainNum];
        if(!trains || !trains.length) continue;
        // choose an Amtrak provider train if present
        const t = trains.find(x=>String(x.provider||"").toLowerCase()==="amtrak") || trains[0];
        const st = (t.stations || []).find(s=>String(s.code||"").toUpperCase()===stationCode);
        const rtStatus = deriveRtStatus(t, st, isDep, nowSec);
        if(rtStatus) r.status = rtStatus;
        if(!st) continue;

        const actualStr = isDep ? st.dep : st.arr;
        const schedStr  = isDep ? st.schDep : st.schArr;

        const actual = parseRtTime(actualStr);
        const sched  = parseRtTime(schedStr);

        // If actual exists and is different (or sched missing), show Now time.
        // Only if not already departed at this station.
        const stStatus = String(st.status||"");
        // Hide trains that have already departed/arrived at this station
        if(stStatus === "Departed" || (!isDep && stStatus === "Arrived")){
          r._hide = true;
          continue;
        }
        if(actual){
          const nowLabel = fmtShortTimeForStation(tz, actual);
          // If it looks delayed, show "Now"
          if(!sched || (sched && Math.abs(actual.getTime()-sched.getTime()) > 60000)){
            r.status = "Now " + nowLabel;
            // Also update the time column to the new time (public boards usually do this)
            r.time = nowLabel;
          }
        }
      }
    }
  }

  const visible = rows.filter(r=>!r._hide);
  return visible.slice(0, 20);

}

function statusSpan(status){
  const s = escapeHtml(status);
  if(status === "Boarding"){
    return `<span class="statusTag boarding">Boarding</span>`;
  }
  return `<span class="statusTag">${s}</span>`;
}

function setBoardTypeClasses(info){
  const table = $("infoTable");
  const canvas = $("displayCanvas");
  const isArr = state.boardType === "arrivals";
  if(table){
    table.classList.toggle("arrivals", isArr);
    table.classList.toggle("departures", !isArr);
  }
  if(canvas){
    canvas.classList.toggle("arrivals", isArr);
    canvas.classList.toggle("departures", !isArr);
  }
  const title = state.boardType;
  if($("infoTitle")) $("infoTitle").textContent = title;
  if($("dispTitle")) $("dispTitle").textContent = title;
}

async function renderInfo(){
  setBoardTypeClasses(true);
  const tbody = $("infoRows");
  const rows = await buildRows();
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="7" style="padding:6px;color:inherit;">No trips in window.</td></tr>`;
  }else{
    tbody.innerHTML = rows.map(r=>`
      <tr data-trip="${r.tripId}">
        <td class="col-time">${r.time}</td>
        <td class="col-no">${escapeHtml(r.no)}</td>
        <td class="col-train">${escapeHtml(r.train)}</td>
        <td class="col-to">${escapeHtml(r.to)}</td>
        <td class="col-status">${statusSpan(r.status)}</td>
        <td class="col-gate">${escapeHtml(r.gate)}</td>
        <td class="col-track">${escapeHtml(r.track)}</td>
      </tr>
    `).join("");

    // row click override
    tbody.querySelectorAll("tr[data-trip]").forEach(tr=>{
      tr.style.cursor="pointer";
      tr.addEventListener("click", ()=> openOverride(tr.dataset.trip));
    });
  }
}

async function renderDisplay(){
  setBoardTypeClasses(false);
  const body = $("dispBody");
  const rows = await buildRows();
  body.innerHTML = "";

  rows.forEach((r,i)=>{
    const row = document.createElement("div");
    row.className = "dispRow";
    row.innerHTML = `
      <div class="dispCell w-time">${r.time}</div>
      <div class="dispCell w-no">${escapeHtml(r.no)}</div>
      <div class="dispCell w-train">${escapeHtml(r.train)}</div>
      <div class="dispCell w-to">${escapeHtml(r.to)}</div>
      <div class="dispCell w-status">${statusSpan(r.status)}</div>
      <div class="dispCell w-gate">${escapeHtml(r.gate)}</div>
      <div class="dispCell w-track">${escapeHtml(r.track)}</div>
    `;
    body.appendChild(row);
  });

  $("tickerText").textContent = state.ticker || "";
}

function openOverride(tripId){
  const dateYMD = isoToYMD(state.dateISO);
  const overrides = loadOverrides();
  const key = ovKey(dateYMD, state.stationId, tripId);
  const ov = overrides[key] || {gate:"",track:"",status:""};

  const gate = prompt("Gate (blank = --):", ov.gate || "");
  if(gate === null) return;
  const track = prompt("Track (blank = --):", ov.track || "");
  if(track === null) return;
  const status = prompt("Status (Boarding / On Time / Delayed / Cancelled):", ov.status || "");
  if(status === null) return;

  const clean = v => (v||"").trim();
  const next = { gate: clean(gate), track: clean(track), status: clean(status) };

  if(!next.gate && !next.track && !next.status) delete overrides[key];
  else overrides[key]=next;

  saveOverrides(overrides);
  renderInfo();
  renderDisplay();
}

function applyFromInputs(prefix){
  state.stationId = $(prefix+"Station").value;
  state.boardType = $(prefix+"Board").value;
  state.dateISO = $(prefix+"Date").value || todayISO();
  state.ticker = $(prefix+"Ticker").value || "";
  const rtEl = $(prefix+"Realtime");
  state.realtime = "on";
  savePrefs();
}

function showMenu(){
  $("menu").style.display="block";
  $("infoShell").style.display="none";
  $("displayRoot").style.display="none";
  stopTicker();
}

function showInfo(){
  $("menu").style.display="none";
  $("infoShell").style.display="block";
  $("displayRoot").style.display="none";
  stopTicker();

  renderInfo();
}

function scaleCanvas(){
  const root = $("displayRoot");
  const canvas = $("displayCanvas");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw/1920, vh/1080);
  canvas.style.transform = `scale(${scale})`;
  root.classList.add("scaled");
}

function startTicker(){
  stopTicker();
  const el = $("tickerText");
  state.tickerPos = 1920;
  const speed = 2.0; // px per frame

  const step = ()=>{
    state.tickerPos -= speed;
    const w = el.offsetWidth || 0;
    if(state.tickerPos < -w) state.tickerPos = 1920;
    el.style.left = state.tickerPos + "px";
    state.tickerRAF = requestAnimationFrame(step);
  };
  state.tickerRAF = requestAnimationFrame(step);
}
function stopTicker(){
  if(state.tickerRAF) cancelAnimationFrame(state.tickerRAF);
  state.tickerRAF = null;
}

function showDisplay(){
  $("menu").style.display="none";
  $("infoShell").style.display="none";
  $("displayRoot").style.display="flex";
  scaleCanvas();
  renderDisplay();
  startTicker();
}

function wireMenu(){
  // menu inputs
  $("stationSelect").addEventListener("change", ()=>{
    state.stationId = $("stationSelect").value;
    savePrefs();
  });
  $("boardType").addEventListener("change", ()=>{
    state.boardType = $("boardType").value;
    savePrefs();
  });
  $("dateInput").addEventListener("change", ()=>{
    state.dateISO = $("dateInput").value || todayISO();
    savePrefs();
  });
  $("tickerInput").addEventListener("input", ()=>{
    state.ticker = $("tickerInput").value || "";
    savePrefs();
  });

  $("openInfo").addEventListener("click", ()=>{
    // sync into info controls
    $("infoStation").value = state.stationId;
    $("infoBoard").value = state.boardType;
    $("infoDate").value = state.dateISO;
    $("infoTicker").value = state.ticker;
  if($("infoRealtime")) $("infoRealtime").value = state.realtime || "off";
    if($("infoRealtime")) $("infoRealtime").value = state.realtime || "off";
    showInfo();
  });

  $("openDisplay").addEventListener("click", ()=>{
    window.open("index.html?mode=display","_blank","noopener");
  });

  
  if($("openTrainDetails")) $("openTrainDetails").addEventListener("click", ()=>{ window.location.href = "train_details.html"; });
  if($("openStationStatus")) $("openStationStatus").addEventListener("click", ()=>{ window.location.href = "station_status.html"; });
// info controls
  $("applyInfo").addEventListener("click", ()=>{
    applyFromInputs("info");
    // sync menu too
    $("stationSelect").value = state.stationId;
    $("boardType").value = state.boardType;
    $("dateInput").value = state.dateISO;
    $("tickerInput").value = state.ticker;
  state.realtime = "on";
    state.realtime = "on";
    renderInfo();
  });
  $("backMenu").addEventListener("click", showMenu);

  window.addEventListener("resize", ()=>{
    if($("displayRoot").style.display==="flex") scaleCanvas();
  });
}

function startAutoRefresh(){
  setInterval(()=>{
    // re-render whichever mode is visible
    if($("infoShell").style.display==="block") renderInfo();
    if($("displayRoot").style.display==="flex") renderDisplay();
  }, 20000);
}

(async function init(){
  loadPrefs();
  if(!state.dateISO) state.dateISO = todayISO();

  await loadData();

  populateStations($("stationSelect"));
  populateStations($("infoStation"));

  // apply saved prefs to menu inputs
  $("boardType").value = state.boardType;
  $("dateInput").value = state.dateISO;
  $("tickerInput").value = state.ticker;
  state.realtime = "on";

  $("infoBoard").value = state.boardType;
  $("infoDate").value = state.dateISO;
  $("infoTicker").value = state.ticker;
  if($("infoRealtime")) $("infoRealtime").value = state.realtime || "off";

  wireMenu();
// station filters
if($("stationFilter")) $("stationFilter").addEventListener("input",()=>filterStations("stationFilter","stationSelect"));
if($("infoStationFilter")) $("infoStationFilter").addEventListener("input",()=>filterStations("infoStationFilter","infoStation"));
// back button
if($("displayBack")) $("displayBack").addEventListener("click",()=>{ window.location.href="index.html"; });

  startAutoRefresh();

  // If opened as a dedicated display tab, jump straight to Display Mode.
  const params = new URLSearchParams(window.location.search);
  if(params.get("mode")==="display"){
    showDisplay();
  }else{
    showMenu();
  }
})();


