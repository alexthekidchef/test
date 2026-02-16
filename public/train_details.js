
function __authRedirect(nextPath){
  const b64 = btoa(nextPath).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  location.href = "/login.html?next=" + b64;
}

/* Train Details page
   - Pull running trains from /api/rt/trains
   - Group into "services" by route/service name when available
   - Click a train to open train_timeline.html?train=XXXX
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

let all = null; // realtime response
let services = []; // [{key,label,count,trains:[{num, name, nextStop, eta, status}]}]

async function fetchRealtime(){
  // Prefer same-origin proxy (works when using run_windows.bat)
  let r = await fetch("/api/rt/trains", { cache:"no-store" }).catch(()=>null);
  if(!r || !r.ok){
    r = await fetch("/api/rt/trains", { cache:"no-store" });
  }
  if(!r.ok) throw new Error("HTTP "+r.status);
  return await r.json();
}

function pickTrainObj(list){
  if(!Array.isArray(list) || !list.length) return null;
  // prefer Amtrak provider
  return list.find(x=>String(x.provider||"").toLowerCase()==="amtrak") || list[0];
}

function trainServiceName(t){
  // best-effort
  return (t.routeName || t.route || t.name || t.line || "").toString().trim() || "Amtrak";
}

function stationDisplay(s){
  // prefer name, fall back to code
  return (s.name || s.station || s.code || "").toString().trim() || "--";
}

function parseTime(s){
  if(!s) return null;
  const d = new Date(s);
  if(!isNaN(d.getTime())) return d;
  return null;
}

function fmtHM(d){
  if(!d) return "--";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2,"0");
  const isPM = h>=12;
  const h12 = ((h+11)%12)+1;
  return `${h12}:${m}${isPM?"p":"a"}`;
}

function findNextStop(t){
  const st = Array.isArray(t.stations) ? t.stations : [];
  // next is first station not marked Departed (or not past)
  for(const s of st){
    const status = String(s.status||"");
    if(status !== "Departed"){
      // choose ETA/ETD: use dep for next departure, else arr
      const tt = parseTime(s.dep) || parseTime(s.arr) || parseTime(s.schDep) || parseTime(s.schArr);
      const ev = (s.dep || s.schDep) ? "Depart" : "Arrive";
      return { stop: stationDisplay(s), time: fmtHM(tt), event: ev, raw: s };
    }
  }
  return { stop: "--", time: "--", event: "" };
}

function normalizeTrainRow(num, t){
  const svc = trainServiceName(t);
  const next = findNextStop(t);
  // status summary
  let status = String(t.status || t.currentStatus || "").trim();
  if(!status) status = String(next.raw?.status||"").trim() || "Running";
  // if next stop has a time difference, show "Now"
  let eta = next.time;
  if(next.raw){
    const actual = parseTime(next.raw.dep) || parseTime(next.raw.arr);
    const sched  = parseTime(next.raw.schDep) || parseTime(next.raw.schArr);
    if(actual && (!sched || Math.abs(actual.getTime()-sched.getTime())>60000)){
      status = `Now ${fmtHM(actual)}`;
      eta = fmtHM(actual);
    }
  }
  return { num, service: svc, nextStop: next.stop, eta, status };
}

function buildServices(allData){
  const svcMap = new Map();
  for(const [num, list] of Object.entries(allData || {})){
    const t = pickTrainObj(list);
    if(!t) continue;
    // heuristic: running trains have stations and a last position
    if(!t.stations || !Array.isArray(t.stations) || t.stations.length===0) continue;
    const row = normalizeTrainRow(num, t);
    const key = row.service;
    if(!svcMap.has(key)) svcMap.set(key, []);
    svcMap.get(key).push(row);
  }
  // sort trains within service by number
  const svcArr = Array.from(svcMap.entries()).map(([key,trains])=>({
    key, label:key, count:trains.length,
    trains: trains.sort((a,b)=>String(a.num).localeCompare(String(b.num)))
  }));
  svcArr.sort((a,b)=>a.label.localeCompare(b.label));
  return svcArr;
}

function renderServiceOptions(){
  const sel = $("serviceSelect");
  sel.innerHTML = services.map(s=>`<option value="${escapeHtml(s.key)}">${escapeHtml(s.label)} (${s.count})</option>`).join("");
  // pick first
  if(services[0]) sel.value = services[0].key;
}

function renderTable(){
  const key = $("serviceSelect").value;
  const svc = services.find(s=>s.key===key);
  const q = ($("trainFilter").value||"").toLowerCase().trim();
  const tbody = $("rows");
  tbody.innerHTML = "";
  if(!svc){
    $("msg").textContent = "No trains found for that service.";
    return;
  }
  const rows = svc.trains.filter(r=>{
    if(!q) return true;
    const hay = `${r.num} ${r.service} ${r.nextStop} ${r.status}`.toLowerCase();
    return hay.includes(q);
  });
  $("msg").textContent = `${rows.length} trains`;
  for(const r of rows){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.num)}</td>
      <td>${escapeHtml(r.service)}</td>
      <td>${escapeHtml(r.nextStop)}</td>
      <td>${escapeHtml(r.eta)}</td>
      <td><span class="pill ${r.status.startsWith("Now")?"statusNow":""}">${escapeHtml(r.status)}</span></td>
    `;
    tr.addEventListener("click", ()=>{
      window.location.href = `train_timeline.html?train=${encodeURIComponent(r.num)}`;
    });
    tbody.appendChild(tr);
  }
}

async function refresh(){
  $("err").style.display="none";
  $("msg").textContent="Loading live trains…";
  try{
    const data = await fetchRealtime();
    all = data;
    services = buildServices(all);
    if(!services.length){
      $("msg").textContent = "No running trains returned. If this looks wrong, realtime may be blocked (CORS) — use server.py to run.";
    }
    renderServiceOptions();
    renderTable();
    $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
  }catch(e){
    $("err").textContent = 'Realtime fetch failed. Run "run_windows.bat" (or "python server.py") so the local /api/rt/trains proxy can bypass CORS. Error: ' + (e?.message||e);
    $("err").style.display="block";
    $("msg").textContent="—";
  }
}

$("back").addEventListener("click", ()=> window.location.href="index.html");
$("refresh").addEventListener("click", refresh);
$("serviceSelect").addEventListener("change", renderTable);
$("trainFilter").addEventListener("input", renderTable);

refresh();
