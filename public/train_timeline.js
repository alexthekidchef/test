
function __authRedirect(nextPath){
  const b64 = btoa(nextPath).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  location.href = "/login.html?next=" + b64;
}

/* Train Timeline page
   - Shows a vertical "line map" of past vs planned station events
   - Data source: /api/rt/trains
*/
function $(id){ return document.getElementById(id); }
function escapeHtml(s){ return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

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

function pickTrainObj(list){
  if(!Array.isArray(list) || !list.length) return null;
  return list.find(x=>String(x.provider||"").toLowerCase()==="amtrak") || list[0];
}
async function fetchRealtime(){
  // Prefer same-origin proxy (works when using run_windows.bat)
  let r = await fetch("/api/rt/trains", { cache:"no-store" }).catch(()=>null);
  if(!r || !r.ok){
    r = await fetch("/api/rt/trains", { cache:"no-store" });
  }
  if(!r.ok) throw new Error("HTTP "+r.status);
  return await r.json();
}
function parseTime(s){
  if(!s) return null;
  const d = new Date(s);
  if(!isNaN(d.getTime())) return d;
  return null;
}
function fmtDT(d){
  if(!d) return "--";
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  const yy = d.getFullYear();
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${mm}/${dd}/${yy} ${String(h).padStart(2,"0")}:${m}`;
}
function stationDisplay(s){
  return (s.name || s.station || s.code || "").toString().trim() || "--";
}

function eventLabel(st){
  // prefer explicit status/event
  const stt = String(st.status||"").trim();
  if(stt) return stt;
  if(st.dep || st.schDep) return "Depart";
  if(st.arr || st.schArr) return "Arrive";
  return "Through";
}

function buildItems(stations){
  const now = Date.now();
  const past = [];
  const planned = [];
  for(const st of stations){
    // choose best time for sorting and display
    const t = parseTime(st.dep) || parseTime(st.arr) || parseTime(st.schDep) || parseTime(st.schArr);
    const item = {
      code: String(st.code||"").toUpperCase(),
      name: stationDisplay(st),
      event: eventLabel(st),
      time: t ? fmtDT(t) : "--",
      tms: t ? t.getTime() : 0,
      status: String(st.status||"").trim()
    };
    // classify: if departed or time < now and status indicates past
    const isPast = item.status === "Departed" || (t && t.getTime() < now && item.status);
    if(isPast) past.push(item); else planned.push(item);
  }
  past.sort((a,b)=>a.tms-b.tms);
  planned.sort((a,b)=>a.tms-b.tms);
  return {past, planned};
}

function renderList(containerId, items, kind){
  const container = $(containerId);
  container.innerHTML = "";
  items.forEach((it, idx)=>{
    const row = document.createElement("div");
    row.className = "item";
    // dot positioning: we place a dot aligned with each row using absolute positioning inside the wrap
    const dot = document.createElement("div");
    dot.className = "dot " + (kind==="past" ? "past" : "");
    // mark the first planned as "now"
    if(kind==="planned" && idx===0) dot.classList.add("now");
    // Place dot at row's top offset via CSS translate after insert
    row.innerHTML = `
      <div class="station">${escapeHtml(it.name)}</div>
      <div class="event">${escapeHtml(it.event)}</div>
      <div class="time">${escapeHtml(it.time)}</div>
    `;
    container.appendChild(row);
    // attach dot
    // compute offset relative to wrapper
    const wrap = container.parentElement;
    const top = row.offsetTop + 14;
    dot.style.top = top + "px";
    wrap.appendChild(dot);
  });
}

async function init(){
  const params = new URLSearchParams(window.location.search);
  const train = params.get("train");
  $("back").addEventListener("click", ()=> window.location.href="train_details.html");
  if(!train){
    $("err").textContent = "Missing train number.";
    $("err").style.display="block";
    return;
  }
  $("title").textContent = "Train " + train;
  try{
    const data = await fetchRealtime();
    const t = pickTrainObj(data[train]);
    if(!t){
      throw new Error("Train not found in realtime feed.");
    }
    const stations = Array.isArray(t.stations) ? t.stations : [];
    const {past, planned} = buildItems(stations);

    $("meta").innerHTML = `
      <span class="pill">Train ${escapeHtml(train)}</span>
      <span class="pill">${escapeHtml((t.routeName||t.route||t.name||"Amtrak").toString())}</span>
      ${t.heading ? `<span class="pill">To ${escapeHtml(String(t.heading))}</span>` : ``}
    `;
    renderList("past", past, "past");
    renderList("planned", planned, "planned");
    $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
  }catch(e){
    $("err").textContent = 'Realtime fetch failed. Run "run_windows.bat" (or "python server.py") so the local /api/rt/trains proxy can bypass CORS. Error: ' + (e?.message||e);
    $("err").style.display="block";
  }
}
init();
