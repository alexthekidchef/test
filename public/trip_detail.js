
function __authRedirect(nextPath){
  const b64 = btoa(nextPath).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  location.href = "/login.html?next=" + b64;
}

function $(id){ return document.getElementById(id); }
function pad2(n){ return String(n).padStart(2,"0"); }
function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function parseRtTime(s){
  if(!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function fmtLocal(d){
  if(!d) return "--";
  const h = d.getHours();
  const m = pad2(d.getMinutes());
  const isPM = h>=12;
  const h12 = ((h+11)%12)+1;
  return `${h12}:${m}${isPM?"p":"a"}`;
}
function formatServiceTime(sec, stationTimeZone(code), serviceDateISO){
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
  const [stops, tripmap, stopEvents] = await Promise.all([
    fetch("./data/stops.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/tripmap.json", {cache:"no-store"}).then(r=>r.json()),
    fetch("./data/stop_events.json", {cache:"no-store"}).then(r=>r.json()),
  ]);
  return {stops, tripmap, stopEvents};
}
async function fetchRealtime(){
  let r = await fetch("/api/rt/trains", { cache:"no-store" }).catch(()=>null);
  if(!r || !r.ok){
    r = await fetch("/api/rt/trains", { cache:"no-store" });
  }
  if(!r.ok) throw new Error("HTTP "+r.status);
  return await r.json();
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

const logoutBtn = document.getElementById("logoutBtn");
if(logoutBtn){
  logoutBtn.addEventListener("click", async ()=>{
    try{ await fetch("/api/auth/logout", {method:"POST"}); }catch(e){}
    location.href = "/login.html";
  });
}

let DATA=null;

$("back").addEventListener("click", ()=> window.history.back());

(async function init(){
  const p = new URLSearchParams(window.location.search);
  const station = (p.get("station")||"").toUpperCase();
  const tripId = p.get("trip") || "";
  const dateISO = p.get("date") || todayISO();

  DATA = await loadData();
  const meta = DATA.tripmap?.[tripId];
  const stationName = DATA.stops?.[station]?.n || station;

  $("title").textContent = `Trip Details`;
  $("meta").innerHTML = `
    <span class="pill">${escapeHtml(stationName)} (${escapeHtml(station)})</span>
    <span class="pill">Trip ${escapeHtml(tripId)}</span>
    <span class="pill">Date ${escapeHtml(dateISO)}</span>
    ${meta?.ts ? `<span class="pill">Train ${escapeHtml(meta.ts)}</span>` : ``}
    ${meta?.rl ? `<span class="pill">${escapeHtml(meta.rl)}</span>` : ``}
    ${meta?.hd ? `<span class="pill">To ${escapeHtml(meta.hd)}</span>` : ``}
  `;

  // scheduled for this trip at this station
  const ev = DATA.stopEvents?.[station] || [];
  let schedArr = null, schedDep = null;
  for(const [arrSec, depSec, tId] of ev){
    if(tId === tripId){
      schedArr = arrSec;
      schedDep = depSec;
      break;
    }
  }

  let rtTrain = null;
  try{
    const rt = await fetchRealtime();
    const trainNum = (meta?.ts||"").toString().trim();
    if(trainNum && rt[trainNum] && rt[trainNum].length){
      rtTrain = rt[trainNum].find(x=>String(x.provider||"").toLowerCase()==="amtrak") || rt[trainNum][0];
    }
  }catch(e){
    // ignore
  }

  const rows = [];
  if(rtTrain && Array.isArray(rtTrain.stations) && rtTrain.stations.length){
    for(const st of rtTrain.stations){
      const code = String(st.code||"").toUpperCase();
      const name = DATA.stops?.[code]?.n || code;
      rows.push({
        name,
        schArr: fmtLocal(parseRtTime(st.schArr)),
        arr: fmtLocal(parseRtTime(st.arr)),
        schDep: fmtLocal(parseRtTime(st.schDep)),
        dep: fmtLocal(parseRtTime(st.dep)),
        status: String(st.status||"")
      });
    }
    $("msg").textContent = `Realtime stop-by-stop timestamps`;
  }else{
    rows.push({
      name: stationName,
      schArr: schedArr!=null ? formatServiceTime(schedArr, stationTimeZone(code), serviceDateISO) : "--",
      arr: "--",
      schDep: schedDep!=null ? formatServiceTime(schedDep, stationTimeZone(code), serviceDateISO) : "--",
      dep: "--",
      status: "Scheduled"
    });
    $("msg").textContent = `No realtime stop list for this train right now — showing scheduled times for this station only.`;
  }

  $("rows").innerHTML = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.schArr)}</td>
      <td>${escapeHtml(r.arr)}</td>
      <td>${escapeHtml(r.schDep)}</td>
      <td>${escapeHtml(r.dep)}</td>
      <td>${escapeHtml(r.status)}</td>
    </tr>
  `).join("");

  $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
})();