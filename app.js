/* ─────────────────────────────────────────────────────────────────
   ParkLDN — Application Logic
───────────────────────────────────────────────────────────────── */

// ── STATE ─────────────────────────────────────────────────────────
const state = {
  map: null,
  markers: {},
  selectedId: null,
  userLocation: null,
  filter: 'all',
  searchQuery: '',
  sortBy: 'name',
  filteredData: [],
  countdownTimer: null,
  clockTimer: null,
  cameras: [],          // TfL JamCam objects loaded at startup
  camerasLoaded: false,
};

// ── TFL JAMCAM API ────────────────────────────────────────────────
async function initTfLCameras() {
  try {
    const res = await fetch('https://api.tfl.gov.uk/Place/Type/JamCam');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.cameras = data.map(cam => {
      const imgProp = (cam.additionalProperties || []).find(p => p.key === 'imageUrl');
      const id = cam.id.replace('JamCams_', '');
      return {
        id,
        lat: cam.lat,
        lon: cam.lon,
        name: cam.commonName || id,
        imageUrl: imgProp?.value ||
          `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${id}.jpg`,
      };
    });
    state.camerasLoaded = true;
    updateCameraBadge();
    console.log(`Loaded ${state.cameras.length} TfL JamCam feeds`);
  } catch (e) {
    console.warn('TfL JamCam API unavailable — falling back to preset IDs:', e.message);
    // Build fallback list from data.js preset camera IDs
    state.cameras = PARKING_DATA
      .filter(s => s.tflCameraId)
      .map(s => ({
        id: s.tflCameraId,
        lat: s.coords[0], lon: s.coords[1],
        name: s.name,
        imageUrl: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${s.tflCameraId}.jpg`,
      }));
    state.camerasLoaded = true;
    updateCameraBadge();
  }
}

function getNearestCamera(spot, maxDist = 700) {
  const list = state.cameras;
  if (!list.length) {
    if (!spot.tflCameraId) return null;
    return {
      id: spot.tflCameraId,
      imageUrl: `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${spot.tflCameraId}.jpg`,
      name: spot.tflCameraId,
    };
  }
  let nearest = null, minDist = Infinity;
  for (const cam of list) {
    const d = haversine(spot.coords[0], spot.coords[1], cam.lat, cam.lon);
    if (d < minDist && d < maxDist) { minDist = d; nearest = { ...cam, dist: Math.round(d) }; }
  }
  return nearest;
}

// ── TIME HELPERS ──────────────────────────────────────────────────
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function parseTime(t) {  // "18:30" → minutes int
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function formatTime12(t) {  // "18:30" → "6:30 PM"
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function getDayAbbrev() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
}

// ── STATUS COMPUTATION ────────────────────────────────────────────
function getStatus(spot) {
  const now = nowMinutes();
  const day = getDayAbbrev();

  // Car parks always open (paid or free after hours)
  if (spot.type === 'car-park' && !spot.freeAfter && spot.restrictedDays.length === 0) {
    return { code: 'open', label: 'Open Now', color: '#00d4ff' };
  }

  // On-street paid only (no restrictions tracked)
  if (!spot.freeAfter && spot.restrictedDays.length === 0 && spot.freeDays.length === 0) {
    return { code: 'open', label: 'Open Now', color: '#00d4ff' };
  }

  // Free all day today
  if (spot.freeDays.includes(day)) {
    return { code: 'free', label: 'Free Today', color: '#00ff9d' };
  }

  // Not a restricted day at all
  if (!spot.restrictedDays.includes(day)) {
    return { code: 'free', label: 'Free Today', color: '#00ff9d' };
  }

  const freeAfterMin = parseTime(spot.freeAfter);
  const freeUntilMin = parseTime(spot.freeUntil);

  // Currently in free period (after freeAfter but before freeUntil next day)
  if (freeAfterMin !== null) {
    if (now >= freeAfterMin || (freeUntilMin && now < freeUntilMin)) {
      return { code: 'free', label: 'Free Now', color: '#00ff9d' };
    }

    // Within 90 minutes of becoming free
    const minsUntilFree = freeAfterMin - now;
    if (minsUntilFree > 0 && minsUntilFree <= 90) {
      return { code: 'soon', label: `Free after ${formatTime12(spot.freeAfter)}`, color: '#ffaa00', minsUntil: minsUntilFree };
    }
  }

  return { code: 'restricted', label: 'Restricted', color: '#ff4466' };
}

// ── DISTANCE ─────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDist(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m/1000).toFixed(1)}km`;
}

function formatWalk(m) {
  const mins = Math.round(m / 80);  // avg walking speed 80m/min
  return mins < 1 ? '<1 min walk' : `${mins} min walk`;
}

// ── MAP INIT ──────────────────────────────────────────────────────
function initMap() {
  state.map = L.map('map', {
    center: [51.5074, -0.1278],
    zoom: 13,
    zoomControl: false,
    attributionControl: true,
  });

  // Dark CartoDB tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" style="color:#6a6a9a">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" style="color:#6a6a9a">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(state.map);

  // Zoom control (top left)
  L.control.zoom({ position: 'topleft' }).addTo(state.map);

  // Click outside to deselect
  state.map.on('click', () => {
    if (state.selectedId) deselectSpot();
  });
}

// ── CUSTOM MARKER SVG ─────────────────────────────────────────────
function makeMarkerIcon(spot, status) {
  const colors = {
    free:       { bg: '#00ff9d', border: '#00cc7a', text: '#001a0d', glow: '#00ff9d80' },
    soon:       { bg: '#ffaa00', border: '#cc8800', text: '#1a0f00', glow: '#ffaa0060' },
    restricted: { bg: '#ff4466', border: '#cc2244', text: '#1a0010', glow: '#ff446660' },
    paid:       { bg: '#3a3a5a', border: '#5a5a7a', text: '#aaaacc', glow: 'transparent' },
  }[status.code] || { bg: '#3a3a5a', border: '#5a5a7a', text: '#aaaacc', glow: 'transparent' };

  const icon = spot.type === 'car-park' ? '🅿' : 'P';
  const pulse = status.code === 'free' ?
    `<circle cx="18" cy="18" r="16" fill="${colors.bg}" opacity="0.3"><animate attributeName="r" values="16;22;16" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite"/></circle>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    ${pulse}
    <circle cx="18" cy="18" r="14" fill="${colors.bg}" stroke="${colors.border}" stroke-width="2"/>
    <filter id="glow${spot.id}"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <text x="18" y="23" text-anchor="middle" font-family="'Rajdhani',sans-serif" font-weight="700" font-size="${icon === '🅿' ? 16 : 14}" fill="${colors.text}">${icon}</text>
  </svg>`;

  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -22],
  });
}

// ── POPUP CONTENT ─────────────────────────────────────────────────
function makePopupHTML(spot, status) {
  const badgeClass = {
    free: 'background:#00ff9d22;color:#00ff9d;border:1px solid #00ff9d',
    soon: 'background:#ffaa0022;color:#ffaa00;border:1px solid #ffaa00',
    restricted: 'background:#ff446622;color:#ff4466;border:1px solid #ff4466',
    paid: 'background:#ffffff10;color:#888899;border:1px solid #3a3a5a',
  }[status.code];

  return `
    <div class="map-popup" style="min-width:200px">
      <div style="font-size:10px;font-weight:600;color:#6a6a9a;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${spot.borough}</div>
      <h4>${spot.name}</h4>
      <div class="map-popup-meta">${spot.address} · ${spot.postcode}</div>
      <div style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:600;margin-bottom:10px;${badgeClass}">
        ${status.label}
      </div>
      ${status.code !== 'paid' && spot.freeAfter ? `<div style="font-size:11px;color:#6a6a9a;margin-bottom:8px">Free after ${formatTime12(spot.freeAfter)}</div>` : ''}
      <button class="map-popup-btn" onclick="selectSpot(${spot.id})">View Details →</button>
    </div>`;
}

// ── RENDER MARKERS ────────────────────────────────────────────────
function renderMarkers() {
  // Remove existing
  Object.values(state.markers).forEach(m => m.remove());
  state.markers = {};

  PARKING_DATA.forEach(spot => {
    const status = getStatus(spot);
    const icon = makeMarkerIcon(spot, status);

    const marker = L.marker(spot.coords, { icon, zIndexOffset: status.code === 'free' ? 100 : 0 })
      .addTo(state.map)
      .bindPopup(makePopupHTML(spot, status), {
        maxWidth: 260,
        className: 'park-popup',
      });

    marker.on('click', e => {
      e.originalEvent.stopPropagation();
      selectSpot(spot.id);
    });

    state.markers[spot.id] = marker;
  });
}

// ── PARKING LIST ──────────────────────────────────────────────────
function getFilteredData() {
  let data = PARKING_DATA.slice();

  // Search filter
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    data = data.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.postcode.toLowerCase().includes(q) ||
      s.borough.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q)
    );
  }

  // Status filter
  if (state.filter !== 'all') {
    data = data.filter(s => {
      const st = getStatus(s);
      if (state.filter === 'free')  return st.code === 'free';
      if (state.filter === '6pm')   return s.freeAfter === '18:00';
      if (state.filter === '6:30pm') return s.freeAfter === '18:30';
      return true;
    });
  }

  // Sort
  data.sort((a, b) => {
    if (state.sortBy === 'distance' && state.userLocation) {
      const da = haversine(state.userLocation.lat, state.userLocation.lng, a.coords[0], a.coords[1]);
      const db = haversine(state.userLocation.lat, state.userLocation.lng, b.coords[0], b.coords[1]);
      return da - db;
    }
    if (state.sortBy === 'status') {
      const order = { free: 0, soon: 1, restricted: 2, paid: 3 };
      return order[getStatus(a).code] - order[getStatus(b).code];
    }
    return a.name.localeCompare(b.name);
  });

  state.filteredData = data;
  return data;
}

function renderList() {
  const list = document.getElementById('parkingList');
  const data = getFilteredData();

  document.querySelector('.results-count').innerHTML =
    `<strong>${data.length}</strong> location${data.length !== 1 ? 's' : ''} found`;

  if (data.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <span>🔍</span>
      <p>No parking spots match your filters.</p>
    </div>`;
    return;
  }

  list.innerHTML = data.map(spot => {
    const status = getStatus(spot);
    const dist = state.userLocation
      ? haversine(state.userLocation.lat, state.userLocation.lng, spot.coords[0], spot.coords[1])
      : null;

    const badgeLabel = {
      free:       'Free Now',
      soon:       `After ${formatTime12(spot.freeAfter)}`,
      restricted: 'Restricted',
      paid:       'Paid',
      open:       'Open',
    }[status.code];

    const distHTML = dist !== null
      ? `<div class="card-distance has-dist">${formatDist(dist)}</div>`
      : '';

    return `<div class="parking-card ${state.selectedId === spot.id ? 'selected' : ''}"
                 data-id="${spot.id}" onclick="selectSpot(${spot.id})">
      <div class="card-dot ${status.code}"></div>
      <div class="card-body">
        <div class="card-name">${spot.name}</div>
        <div class="card-sub">${spot.borough}</div>
      </div>
      <div class="card-right">
        <span class="badge badge-${status.code}">${badgeLabel}</span>
        ${distHTML}
      </div>
    </div>`;
  }).join('');
}

// ── SELECT / DESELECT ─────────────────────────────────────────────
window.selectSpot = function(id) {
  const spot = PARKING_DATA.find(s => s.id === id);
  if (!spot) return;

  state.selectedId = id;
  renderList();

  // Pan map to spot
  state.map.setView(spot.coords, Math.max(state.map.getZoom(), 15), { animate: true });
  if (state.markers[id]) state.markers[id].openPopup();

  // Open detail panel
  openDetailPanel(spot);
};

function deselectSpot() {
  state.selectedId = null;
  state.map.closePopup();
  document.getElementById('detailPanel').classList.remove('open');
  renderList();
}

// ── PARKING SPACE VISUALISER ──────────────────────────────────────
const CAR_SIZES = {
  city:     { w: 1.65, l: 3.60, label: 'City Car',  example: 'Mini / Smart',    color: '#00ff9d', fit: 96 },
  standard: { w: 1.80, l: 4.45, label: 'Standard',  example: 'Golf / Focus',    color: '#ffaa00', fit: 70 },
  suv:      { w: 2.00, l: 4.90, label: 'SUV / 4x4', example: 'Range Rover',     color: '#ff5533', fit: 32 },
};

const BAY_W = 2.4, BAY_L = 4.8;  // metres, standard UK bay
const SCENE_H = 190, SCENE_W = 90; // px — scene pixel dimensions
const PX_PER_M = SCENE_H / BAY_L;  // ~39.6px per metre

function carPxDims(size) {
  const c = CAR_SIZES[size];
  return { w: Math.round(c.w * PX_PER_M), h: Math.round(c.l * PX_PER_M) };
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function makeCarSVG(size, color) {
  const c10 = hexToRgba(color, 0.10), c22 = hexToRgba(color, 0.22);
  const c35 = hexToRgba(color, 0.35), c55 = hexToRgba(color, 0.55);
  const c40 = hexToRgba(color, 0.40), stroke4 = hexToRgba(color, 0.40);
  return `<svg viewBox="0 0 56 100" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;filter:drop-shadow(0 0 7px ${hexToRgba(color,0.67)})">
    <rect x="5" y="8" width="46" height="84" rx="10" fill="${c10}" stroke="${color}" stroke-width="2"/>
    <rect x="10" y="14" width="36" height="17" rx="5" fill="${c55}"/>
    <rect x="10" y="26" width="36" height="35" rx="5" fill="${c22}"/>
    <rect x="10" y="70" width="36" height="12" rx="4" fill="${c35}"/>
    <ellipse cx="14" cy="10" rx="5" ry="3.5" fill="rgba(255,255,180,0.53)"/>
    <ellipse cx="42" cy="10" rx="5" ry="3.5" fill="rgba(255,255,180,0.53)"/>
    <ellipse cx="14" cy="90" rx="5" ry="3.5" fill="rgba(255,50,50,0.53)"/>
    <ellipse cx="42" cy="90" rx="5" ry="3.5" fill="rgba(255,50,50,0.53)"/>
    <rect x="0"  y="17" width="9" height="16" rx="3" fill="#0a0a1a" stroke="${stroke4}" stroke-width="1.5"/>
    <rect x="47" y="17" width="9" height="16" rx="3" fill="#0a0a1a" stroke="${stroke4}" stroke-width="1.5"/>
    <rect x="0"  y="67" width="9" height="16" rx="3" fill="#0a0a1a" stroke="${stroke4}" stroke-width="1.5"/>
    <rect x="47" y="67" width="9" height="16" rx="3" fill="#0a0a1a" stroke="${stroke4}" stroke-width="1.5"/>
  </svg>`;
}

function makeIonParticles(color) {
  return Array.from({ length: 14 }, (_, i) => {
    const x  = (Math.random() * 38 + 2).toFixed(1);
    const sz = (3 + Math.random() * 5).toFixed(1);
    const dl = (i * 0.07).toFixed(2);
    const dr = (0.7 + Math.random() * 0.6).toFixed(2);
    const dy = (40 + Math.random() * 80).toFixed(0);
    return `<div class="ion-p" style="left:calc(50% + ${x}px);width:${sz}px;height:${sz}px;` +
           `background:${color};box-shadow:0 0 6px ${color};` +
           `animation-delay:${dl}s;animation-duration:${dr}s;--dy:${dy}px"></div>`;
  }).join('');
}

function makeSpaceVisualizerHTML(spot, camera) {
  const bayL = spot.type === 'car-park' ? 5.0 : 4.8;
  const bayW = spot.type === 'car-park' ? 2.7 : 2.4;
  const defaultSize = 'standard';
  const car = CAR_SIZES[defaultSize];
  const { w: cw, h: ch } = carPxDims(defaultSize);

  return `
  <div class="parking-visualizer" id="parkingViz">
    <div class="viz-header">
      <div class="viz-view-tabs">
        <button class="viz-view-btn active" onclick="switchVizView('bay',this)">📐 Bay</button>
        <button class="viz-view-btn" onclick="switchVizView('live',this)">📷 Live${camera ? '' : ' (no cam)'}</button>
      </div>
      <div class="car-size-tabs">
        <button class="car-size-btn" onclick="setCarSize('city',this)">🏎 City</button>
        <button class="car-size-btn active" onclick="setCarSize('standard',this)">🚗 Std</button>
        <button class="car-size-btn" onclick="setCarSize('suv',this)">🚙 SUV</button>
      </div>
    </div>

    <!-- BAY VIEW -->
    <div class="viz-body" id="vizBayView">
      <!-- LEFT: top-down bay scene -->
      <div class="bay-scene-col">
        <div class="bay-scene" style="height:${SCENE_H + 32}px">
          <div class="bay-road-ctx">
            <!-- road approach arrows -->
            <div class="road-approach">
              <span class="ra">↑</span><span class="ra">↑</span><span class="ra">↑</span>
            </div>
            <!-- bay box -->
            <div class="bay-box" id="bayBox" style="width:${SCENE_W}px;height:${SCENE_H}px">
              <!-- floor lines -->
              <div class="bay-floor-line left"></div>
              <div class="bay-floor-line right"></div>
              <!-- ion particles (behind car) -->
              <div class="ion-particles-wrap" id="ionWrap">
                ${makeIonParticles(car.color)}
              </div>
              <!-- ion streak -->
              <div class="ion-streak" id="ionStreak" style="background:linear-gradient(to bottom,transparent,${car.color}88,transparent)"></div>
              <!-- parked pulse ring -->
              <div class="park-pulse-ring" id="parkPulse"></div>
              <!-- car wrapper (animates) -->
              <div class="car-anim-wrap" id="carAnimWrap">
                <div class="car-box" id="carBox" style="width:${cw}px;height:${ch}px">
                  ${makeCarSVG(defaultSize, car.color)}
                </div>
              </div>
            </div>
          </div>
        </div>
        <button class="viz-replay-btn" onclick="replayCarAnim()">↺ Replay</button>
      </div>

      <!-- RIGHT: size info -->
      <div class="viz-info-col">
        <div class="viz-info-card">
          <div class="vic-row">
            <span class="vic-label">Bay</span>
            <span class="vic-val">${bayL}m &times; ${bayW}m</span>
          </div>
          <div class="vic-row">
            <span class="vic-label" id="vicCarLabel">Car (Standard)</span>
            <span class="vic-val" id="vicCarDims">${car.l}m × ${car.w}m</span>
          </div>
          <div class="vic-row">
            <span class="vic-label">Example</span>
            <span class="vic-val" id="vicExample">${car.example}</span>
          </div>
        </div>

        <div class="vic-fit-section">
          <div class="vic-fit-label" id="vicFitLabel">Fit</div>
          <div class="vic-fit-bar">
            <div class="vic-fit-fill" id="vicFitFill"
                 style="width:${car.fit}%;background:${car.color}"></div>
          </div>
          <div class="vic-fit-pct" id="vicFitPct" style="color:${car.color}">${car.fit}%</div>
        </div>

        <div class="vic-verdict" id="vicVerdict" style="color:${car.color};border-color:${car.color}22">
          Standard fit
        </div>

        <div class="vic-space-bars">
          <div class="vic-space-row">
            <span class="vic-space-axis">Width</span>
            <div class="vic-space-track">
              <div class="vic-space-car" id="spaceCarW"
                   style="width:${Math.round((car.w/bayW)*100)}%;background:${car.color}33;border-color:${car.color}"></div>
              <div class="vic-space-gap" id="spaceGapW"
                   style="width:${Math.round(((bayW-car.w)/bayW)*100)}%"></div>
            </div>
            <span class="vic-space-rem" id="spaceRemW">${((bayW - car.w)*100).toFixed(0)}cm spare</span>
          </div>
          <div class="vic-space-row">
            <span class="vic-space-axis">Length</span>
            <div class="vic-space-track">
              <div class="vic-space-car" id="spaceCarL"
                   style="width:${Math.round((car.l/bayL)*100)}%;background:${car.color}33;border-color:${car.color}"></div>
              <div class="vic-space-gap" id="spaceGapL"
                   style="width:${Math.round(((bayL-car.l)/bayL)*100)}%"></div>
            </div>
            <span class="vic-space-rem" id="spaceRemL">${((bayL - car.l)*100).toFixed(0)}cm spare</span>
          </div>
        </div>
      </div>
    </div>

    <!-- LIVE CAMERA VIEW -->
    <div class="viz-body" id="vizLiveView" style="display:none">
      <div class="viz-cam-col">
        ${camera ? `
        <div class="viz-cam-wrap" id="vizCamWrapInner">
          <div class="viz-cam-img-box">
            <img id="vizCamImg"
                 src="${camera.imageUrl}"
                 crossorigin="anonymous"
                 alt="Live camera"
                 onload="onVizCamLoad(this)"
                 onerror="onVizCamError()"
                 style="width:100%;display:block;opacity:0;transition:opacity 0.4s"/>
            <canvas id="vizCamCanvas" style="display:none"></canvas>
            <div class="viz-cam-car-overlay" id="vizCarOverlay">
              ${makeCarSVG(defaultSize, car.color)}
            </div>
            <div class="viz-cam-badge" id="vizCamBadge">🔍 Loading feed…</div>
          </div>
          <div class="viz-cam-meta">
            <span>📷 ${camera.name || camera.id}${camera.dist ? ` · ${camera.dist}m` : ''}</span>
            <button class="cam-refresh-btn" onclick="refreshVizCam()">⟳ Refresh</button>
          </div>
        </div>` : `
        <div class="viz-cam-wrap">
          <div class="viz-cam-no-feed"><span>📷</span><p>No camera near this location</p></div>
        </div>`}
      </div>
      <!-- same info col as bay view (shared IDs, updated by setCarSize) -->
      <div class="viz-info-col">
        <div class="viz-info-card">
          <div class="vic-row">
            <span class="vic-label">Bay</span>
            <span class="vic-val">${bayL}m &times; ${bayW}m</span>
          </div>
          <div class="vic-row">
            <span class="vic-label" id="vicCarLabel2">Car (Standard)</span>
            <span class="vic-val" id="vicCarDims2">${car.l}m x ${car.w}m</span>
          </div>
          <div class="vic-row">
            <span class="vic-label">Example</span>
            <span class="vic-val" id="vicExample2">${car.example}</span>
          </div>
        </div>
        <div class="vic-fit-section">
          <div class="vic-fit-label">Fit</div>
          <div class="vic-fit-bar"><div class="vic-fit-fill" id="vicFitFill2" style="width:${car.fit}%;background:${car.color}"></div></div>
          <div class="vic-fit-pct" id="vicFitPct2" style="color:${car.color}">${car.fit}%</div>
        </div>
        <div class="vic-verdict" id="vicVerdict2" style="color:${car.color};border-color:${car.color}22">Standard fit</div>
      </div>
    </div>
  </div>`;
}

window.setCarSize = function(size, btn) {
  const car = CAR_SIZES[size];
  if (!car) return;
  const bayL = 4.8, bayW = 2.4;

  document.querySelectorAll('.car-size-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const { w: cw, h: ch } = carPxDims(size);

  // Resize car box
  const carBox = document.getElementById('carBox');
  if (carBox) {
    carBox.style.width = cw + 'px';
    carBox.style.height = ch + 'px';
    carBox.innerHTML = makeCarSVG(size, car.color);
  }

  // Re-trigger animation
  const wrap = document.getElementById('carAnimWrap');
  if (wrap) { wrap.classList.remove('parked'); void wrap.offsetWidth; wrap.classList.add('parked'); }

  // Refresh ion particles
  const ionWrap = document.getElementById('ionWrap');
  if (ionWrap) { ionWrap.innerHTML = makeIonParticles(car.color); }

  // Streak colour
  const streak = document.getElementById('ionStreak');
  if (streak) streak.style.background = `linear-gradient(to bottom,transparent,${car.color}88,transparent)`;

  // Pulse colour
  const pulse = document.getElementById('parkPulse');
  if (pulse) { pulse.style.borderColor = car.color; pulse.classList.remove('active'); void pulse.offsetWidth; pulse.classList.add('active'); }

  // Update info
  const verdicts = {
    city:     'Comfortable ✓',
    standard: 'Standard fit',
    suv:      '⚠ Tight — take care',
  };
  document.getElementById('vicCarLabel').textContent = `Car (${car.label})`;
  document.getElementById('vicCarDims').textContent   = `${car.l}m x ${car.w}m`;
  document.getElementById('vicExample').textContent   = car.example;
  document.getElementById('vicFitFill').style.width   = car.fit + '%';
  document.getElementById('vicFitFill').style.background = car.color;
  document.getElementById('vicFitPct').textContent    = car.fit + '%';
  document.getElementById('vicFitPct').style.color    = car.color;
  document.getElementById('vicVerdict').textContent   = verdicts[size];
  document.getElementById('vicVerdict').style.color   = car.color;
  document.getElementById('vicVerdict').style.borderColor = car.color + '22';

  // Width bar
  const wPct = Math.round((car.w / bayW) * 100);
  const lPct = Math.round((car.l / bayL) * 100);
  document.getElementById('spaceCarW').style.width = wPct + '%';
  document.getElementById('spaceCarW').style.background = car.color + '33';
  document.getElementById('spaceCarW').style.borderColor = car.color;
  document.getElementById('spaceGapW').style.width = (100 - wPct) + '%';
  document.getElementById('spaceRemW').textContent = `${((bayW - car.w) * 100).toFixed(0)}cm spare`;
  document.getElementById('spaceCarL').style.width = lPct + '%';
  document.getElementById('spaceCarL').style.background = car.color + '33';
  document.getElementById('spaceCarL').style.borderColor = car.color;
  document.getElementById('spaceGapL').style.width = (100 - lPct) + '%';
  document.getElementById('spaceRemL').textContent = `${((bayL - car.l) * 100).toFixed(0)}cm spare`;

  // Sync the live-view info col (uses -2 suffix IDs)
  const elSet = [
    ['vicCarLabel2', `Car (${car.label})`],
    ['vicCarDims2',  `${car.l}m x ${car.w}m`],
    ['vicExample2',  car.example],
    ['vicVerdict2',  verdicts[size]],
  ];
  elSet.forEach(([id, val]) => { const el = document.getElementById(id); if(el) el.textContent = val; });
  const ff2 = document.getElementById('vicFitFill2');
  if (ff2) { ff2.style.width = car.fit + '%'; ff2.style.background = car.color; }
  ['vicFitPct2','vicVerdict2'].forEach(id => {
    const el = document.getElementById(id); if(el) el.style.color = car.color;
  });
  const vv2 = document.getElementById('vicVerdict2');
  if (vv2) vv2.style.borderColor = car.color + '22';

  // Update car overlay on camera view
  const overlay = document.getElementById('vizCarOverlay');
  if (overlay) overlay.innerHTML = makeCarSVG(size, car.color);
};

window.replayCarAnim = function() {
  const wrap = document.getElementById('carAnimWrap');
  const ionWrap = document.getElementById('ionWrap');
  const pulse = document.getElementById('parkPulse');
  if (!wrap) return;

  // Detect current active size to get colour
  const activeBtn = document.querySelector('.car-size-btn.active');
  const size = activeBtn?.textContent.toLowerCase().includes('city') ? 'city'
             : activeBtn?.textContent.toLowerCase().includes('suv')  ? 'suv'
             : 'standard';
  const car = CAR_SIZES[size];

  if (ionWrap) { ionWrap.innerHTML = makeIonParticles(car.color); }
  wrap.classList.remove('parked'); void wrap.offsetWidth; wrap.classList.add('parked');
  if (pulse) { pulse.classList.remove('active'); void pulse.offsetWidth; pulse.classList.add('active'); }
};

// ── VIZ VIEW TABS ────────────────────────────────────────────────
window.switchVizView = function(view, btn) {
  const bayView  = document.getElementById('vizBayView');
  const liveView = document.getElementById('vizLiveView');
  const btns = document.querySelectorAll('.viz-view-btn');
  btns.forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (bayView)  bayView.style.display  = view === 'bay'  ? '' : 'none';
  if (liveView) liveView.style.display = view === 'live' ? '' : 'none';
};

// ── VIZ CAMERA HANDLERS ──────────────────────────────────────────
window.onVizCamLoad = function(img) {
  img.style.opacity = '1';
  const badge = document.getElementById('vizCamBadge');
  if (!badge) return;
  try {
    const canvas = document.getElementById('vizCamCanvas') || document.createElement('canvas');
    canvas.width  = img.naturalWidth  || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      if (lum < 80) dark++;
    }
    const darkRatio = dark / (d.length / 4);
    if (darkRatio > 0.45) {
      badge.className = 'viz-cam-badge badge-open';
      badge.textContent = '🟢 Space likely available';
    } else {
      badge.className = 'viz-cam-badge badge-occupied';
      badge.textContent = '🔴 Space may be occupied';
    }
  } catch(e) {
    badge.className = 'viz-cam-badge';
    badge.textContent = '👁 Check feed manually';
  }
};

window.onVizCamError = function() {
  const wrap = document.getElementById('vizCamWrap');
  if (wrap) wrap.innerHTML = '<div class="viz-cam-no-feed"><span>📷</span>Camera feed unavailable</div>';
  const badge = document.getElementById('vizCamBadge');
  if (badge) { badge.className = 'viz-cam-badge'; badge.textContent = '⚠️ Feed unavailable'; }
};

window.refreshVizCam = function() {
  const img = document.getElementById('vizCamImg');
  if (!img) return;
  const base = img.src.split('?')[0];
  img.style.opacity = '0';
  img.src = base + '?t=' + Date.now();
};

// ── PANEL CAMERA HANDLERS ────────────────────────────────────────
window.onPanelCamLoad = function(img, id) {
  img.style.opacity = '1';
  const overlay = document.getElementById('panelCamOverlay');
  if (overlay) overlay.style.display = 'none';
  const analysisRow  = document.getElementById('camAnalysisRow');
  const analysisBadge = document.getElementById('camAnalysisBadge');
  if (!analysisRow || !analysisBadge) return;
  try {
    const canvas = document.getElementById('panelCamCanvas');
    if (!canvas) return;
    canvas.width  = img.naturalWidth  || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      if (lum < 80) dark++;
    }
    const darkRatio = dark / (d.length / 4);
    analysisRow.style.display = 'flex';
    if (darkRatio > 0.45) {
      analysisBadge.className = 'cam-analysis-badge badge-open';
      analysisBadge.textContent = '🟢 Road visible — space likely free';
    } else {
      analysisBadge.className = 'cam-analysis-badge badge-occupied';
      analysisBadge.textContent = '🔴 Traffic detected — may be busy';
    }
  } catch(e) {
    analysisRow.style.display = 'flex';
    analysisBadge.className = 'cam-analysis-badge';
    analysisBadge.textContent = '👁 Check feed manually (CORS)';
  }
};

window.onPanelCamError = function() {
  const wrap = document.getElementById('panelCamWrap');
  if (wrap) {
    wrap.innerHTML = '<div class="camera-no-feed"><span>📷</span>Feed unavailable — try refreshing</div>';
  }
};

window.refreshPanelCamera = function() {
  const img = document.getElementById('panelCamImg');
  if (!img) return;
  const base = img.src.split('?')[0];
  img.style.opacity = '0';
  const overlay = document.getElementById('panelCamOverlay');
  if (overlay) { overlay.textContent = 'Refreshing…'; overlay.style.display = 'flex'; }
  img.src = base + '?t=' + Date.now();
};

// ── DETAIL PANEL ──────────────────────────────────────────────────
function openDetailPanel(spot) {
  const panel = document.getElementById('detailPanel');
  const status = getStatus(spot);
  const day = getDayAbbrev();
  const dist = state.userLocation
    ? haversine(state.userLocation.lat, state.userLocation.lng, spot.coords[0], spot.coords[1])
    : null;
  const camera = getNearestCamera(spot);   // real TfL camera nearest this spot
  state.currentCamera = camera;

  // Status bar
  const statusConfig = {
    free:       { icon: '✅', cls: 'free',       msg: 'This spot is free to park right now.' },
    soon:       { icon: '⏱', cls: 'soon',       msg: `Parking becomes free after ${formatTime12(spot.freeAfter)}.` },
    restricted: { icon: '🚫', cls: 'restricted', msg: `Restrictions lift after ${formatTime12(spot.freeAfter)}. Use camera to check live availability.` },
    paid:       { icon: '💳', cls: 'paid',       msg: 'Paid car park. Open now — check camera feed for spaces.' },
    open:       { icon: '🔵', cls: 'free',       msg: spot.type === 'car-park' ? 'Car park open. Check camera for live space availability.' : 'Available. Verify on live camera feed.' },
  }[status.code];

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const scheduleHTML = days.map(d => {
    const isFreeDay = spot.freeDays.includes(d);
    const isRestrictedDay = spot.restrictedDays.includes(d);
    const cls = isFreeDay || !isRestrictedDay ? 'free' : 'restricted';
    return `<div class="day-block ${cls}">${d.slice(0,1)}</div>`;
  }).join('');

  // Countdown: build once, update via timer
  const freeAfterMin = parseTime(spot.freeAfter);
  let countdownSection = '';
  if (status.code === 'soon' || status.code === 'restricted') {
    countdownSection = `
      <div class="countdown-widget" id="countdown-widget">
        <div class="countdown-label">⏳ Time Until Free Parking</div>
        <div class="countdown-display" id="countdown-display">
          <div class="cd-unit"><span class="cd-num" id="cd-h">--</span><span class="cd-label">Hrs</span></div>
          <div class="cd-sep">:</div>
          <div class="cd-unit"><span class="cd-num" id="cd-m">--</span><span class="cd-label">Min</span></div>
          <div class="cd-sep">:</div>
          <div class="cd-unit"><span class="cd-num" id="cd-s">--</span><span class="cd-label">Sec</span></div>
        </div>
      </div>`;
  }

  const cameraSection = camera ? `
    <div class="info-section">
      <div class="info-section-title">📷 Live TfL Camera Feed
        <button class="cam-refresh-btn" onclick="refreshPanelCamera()" title="Refresh feed">⟳</button>
      </div>
      <div class="camera-feed-box">
        <div class="camera-feed-header">
          <span class="camera-live-dot">LIVE</span>
          <span class="camera-id">${camera.name || camera.id}${camera.dist ? ` · ${camera.dist}m away` : ''}</span>
        </div>
        <div class="camera-img-wrap" id="panelCamWrap">
          <img id="panelCamImg"
               src="${camera.imageUrl}"
               alt="TfL Camera Feed"
               crossorigin="anonymous"
               onload="onPanelCamLoad(this,'${camera.id}')"
               onerror="onPanelCamError()"
               style="opacity:0;width:100%;display:block;transition:opacity 0.4s"/>
          <div class="camera-img-overlay" id="panelCamOverlay">Loading feed…</div>
          <canvas id="panelCamCanvas" style="display:none"></canvas>
        </div>
      </div>
      <div class="cam-analysis-row" id="camAnalysisRow" style="display:none">
        <span class="cam-analysis-badge" id="camAnalysisBadge"></span>
        <span class="cam-analysis-note">Based on live image analysis</span>
      </div>
      <p style="font-size:11px;color:var(--text-dim);padding:6px 0 0">
        TfL JamCam · ID ${camera.id} · refreshes every ~60s
      </p>
    </div>` : `
    <div class="info-section">
      <div class="info-section-title">📷 Live TfL Camera Feed</div>
      <div class="camera-feed-box">
        <div class="camera-no-feed"><span>📷</span>No camera within 700m of this spot</div>
      </div>
    </div>`;

  const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.coords[0]},${spot.coords[1]}`;

  panel.innerHTML = `
    <div class="drag-handle"></div>
    <div class="panel-header">
      <button class="panel-close" onclick="deselectSpot()">✕</button>
      <div class="panel-type-badge">
        ${spot.type === 'car-park' ? '🏢 Car Park' : '🛣 On-Street Bays'}
      </div>
      <div class="panel-name">${spot.name}</div>
      <div class="panel-address">${spot.address}, ${spot.borough}</div>
      <div class="panel-postcode-row">
        <a class="panel-postcode panel-postcode-link"
           href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spot.postcode + ' London UK')}"
           target="_blank" rel="noopener" title="Search on Google Maps">
          ${spot.postcode} <span class="postcode-map-icon">🗺</span>
        </a>
        <button class="btn-copy" id="copyBtn" onclick="copyPostcode('${spot.postcode}')">Copy</button>
      </div>
    </div>

    <div class="status-bar ${statusConfig.cls}">
      <div class="status-icon">${statusConfig.icon}</div>
      <div class="status-text ${statusConfig.cls}">
        <strong>${status.label}</strong>
        <p>${statusConfig.msg}</p>
      </div>
    </div>

    ${countdownSection}

    <div class="panel-scroll">

      ${makeSpaceVisualizerHTML(spot, camera)}

      <div class="info-section">
        <div class="info-section-title">📋 Parking Details</div>
        <div class="info-row">
          <span class="info-label">Type</span>
          <span class="info-value">${spot.bayType}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Capacity</span>
          <span class="info-value">${spot.spaces.toLocaleString()} spaces</span>
        </div>
        ${spot.freeAfter ? `<div class="info-row">
          <span class="info-label">Free After</span>
          <span class="info-value green">${formatTime12(spot.freeAfter)}</span>
        </div>` : ''}
        ${spot.freeUntil ? `<div class="info-row">
          <span class="info-label">Free Until</span>
          <span class="info-value orange">${formatTime12(spot.freeUntil)} (next day)</span>
        </div>` : ''}
        ${spot.eveningRate ? `<div class="info-row">
          <span class="info-label">Evening Rate</span>
          <span class="info-value highlight">${spot.eveningRate}</span>
        </div>` : ''}
        ${dist ? `<div class="info-row">
          <span class="info-label">Distance</span>
          <span class="info-value highlight">📍 ${formatDist(dist)} · ${formatWalk(dist)}</span>
        </div>` : ''}
      </div>

      <div class="info-section">
        <div class="info-section-title">📅 Weekly Schedule</div>
        <div class="schedule-grid" style="margin-bottom:8px">${scheduleHTML}</div>
        <p style="font-size:11px;color:var(--text-muted);line-height:1.5">
          🟢 Free all day &nbsp; 🔴 Restrictions apply (free after ${formatTime12(spot.freeAfter) || 'N/A'})
        </p>
        ${spot.freeDays.length ? `<p style="font-size:11px;color:var(--green);margin-top:4px">Free all day on: ${spot.freeDays.join(', ')}</p>` : ''}
        ${spot.notes ? `<p style="font-size:11px;color:var(--text-muted);margin-top:6px;padding:8px;background:var(--bg-input);border-radius:6px;line-height:1.5">${spot.notes}</p>` : ''}
      </div>

      <div class="info-section">
        <div class="info-section-title">📍 Location</div>
        <div class="info-row">
          <span class="info-label">Borough</span>
          <span class="info-value">${spot.borough}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Postcode</span>
          <span class="info-value highlight">${spot.postcode}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Landmark</span>
          <span class="info-value">${spot.walkingLandmark}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Coordinates</span>
          <span class="info-value" style="font-family:monospace;font-size:11px">${spot.coords[0].toFixed(4)}, ${spot.coords[1].toFixed(4)}</span>
        </div>
      </div>

      ${cameraSection}

      <div class="action-buttons">
        <a class="btn-action btn-directions" href="${gmapsUrl}" target="_blank" rel="noopener">
          🗺 Directions
        </a>
        <button class="btn-action btn-share" onclick="shareSpot(${spot.id})">
          📤 Share
        </button>
      </div>

    </div>`;

  panel.classList.add('open');

  // Kick off the car animation after panel slides in
  setTimeout(() => {
    const wrap = document.getElementById('carAnimWrap');
    const pulse = document.getElementById('parkPulse');
    if (wrap) wrap.classList.add('parked');
    if (pulse) setTimeout(() => pulse.classList.add('active'), 1300);
  }, 380);

  // Start countdown timer
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  if (freeAfterMin !== null && (status.code === 'soon' || status.code === 'restricted')) {
    updateCountdown(freeAfterMin);
    state.countdownTimer = setInterval(() => updateCountdown(freeAfterMin), 1000);
  }
}

function updateCountdown(freeAfterMin) {
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  let diff = (freeAfterMin - nowM) * 60; // seconds

  if (diff <= 0) {
    // It's now free — refresh everything
    clearInterval(state.countdownTimer);
    if (state.selectedId) openDetailPanel(PARKING_DATA.find(s => s.id === state.selectedId));
    renderList();
    renderMarkers();
    return;
  }

  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = Math.floor(diff % 60);

  const hEl = document.getElementById('cd-h');
  const mEl = document.getElementById('cd-m');
  const sEl = document.getElementById('cd-s');

  if (hEl) hEl.textContent = String(h).padStart(2,'0');
  if (mEl) mEl.textContent = String(m).padStart(2,'0');
  if (sEl) sEl.textContent = String(s).padStart(2,'0');
}

// ── COPY POSTCODE ─────────────────────────────────────────────────
window.copyPostcode = function(postcode) {
  navigator.clipboard?.writeText(postcode).then(() => {
    const btn = document.getElementById('copyBtn');
    if (btn) { btn.textContent = '✓ Copied'; btn.classList.add('copied'); }
    showToast(`Copied ${postcode} to clipboard`);
    setTimeout(() => { if (btn) { btn.textContent = 'Copy'; btn.classList.remove('copied'); } }, 2000);
  }).catch(() => showToast('Could not copy postcode'));
};

// ── SHARE ─────────────────────────────────────────────────────────
window.shareSpot = function(id) {
  const spot = PARKING_DATA.find(s => s.id === id);
  if (!spot) return;
  const text = `🅿 ${spot.name} - ${spot.postcode}\n${spot.borough}, London\nFree from: ${spot.freeAfter ? formatTime12(spot.freeAfter) : 'Check restrictions'}`;
  if (navigator.share) {
    navigator.share({ title: spot.name, text, url: window.location.href });
  } else {
    navigator.clipboard?.writeText(text);
    showToast('Parking info copied to clipboard');
  }
};

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── LIVE CLOCK ────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2,'0');
  const m = String(now.getMinutes()).padStart(2,'0');
  const s = String(now.getSeconds()).padStart(2,'0');

  const timeEl = document.getElementById('clockTime');
  const dateEl = document.getElementById('clockDate');
  if (timeEl) timeEl.textContent = `${h}:${m}`;
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
  }
}

// ── GEOLOCATION ───────────────────────────────────────────────────
window.locateMe = function() {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported by your browser');
    return;
  }
  showToast('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };

      // Add user marker
      if (state.userMarker) state.userMarker.remove();
      const userIcon = L.divIcon({
        html: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9" fill="#00d4ff" stroke="#fff" stroke-width="2"/>
          <circle cx="11" cy="11" r="9" fill="#00d4ff" opacity="0.3">
            <animate attributeName="r" values="9;16;9" dur="2s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.3;0;0.3" dur="2s" repeatCount="indefinite"/>
          </circle>
        </svg>`,
        className: '',
        iconSize: [22,22],
        iconAnchor: [11,11],
      });
      state.userMarker = L.marker([pos.coords.latitude, pos.coords.longitude], { icon: userIcon, zIndexOffset: 1000 })
        .addTo(state.map)
        .bindPopup('<div style="font-size:13px;color:#e2e2f4">📍 Your Location</div>');

      state.map.setView([pos.coords.latitude, pos.coords.longitude], 14, { animate: true });
      state.sortBy = 'distance';
      document.getElementById('sortSelect').value = 'distance';
      renderList();
      showToast('Showing nearest parking to your location');
    },
    err => {
      const msgs = ['', 'Location access denied', 'Location unavailable', 'Location request timed out'];
      showToast(msgs[err.code] || 'Could not get location');
    },
    { timeout: 10000, enableHighAccuracy: true }
  );
};

// ── SEARCH ────────────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');

  input.addEventListener('input', () => {
    state.searchQuery = input.value.trim();
    const q = state.searchQuery.toLowerCase();

    if (!q) { results.classList.remove('visible'); renderList(); return; }

    const matches = PARKING_DATA.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.postcode.toLowerCase().includes(q) ||
      s.borough.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q)
    ).slice(0, 6);

    if (!matches.length) {
      results.classList.remove('visible');
    } else {
      results.innerHTML = matches.map(s => {
        const status = getStatus(s);
        const dotColor = { free:'#00ff9d', soon:'#ffaa00', restricted:'#ff4466', paid:'#888899' }[status.code];
        const bgColor = { free:'#00ff9d22', soon:'#ffaa0022', restricted:'#ff446622', paid:'#88889922' }[status.code];
        return `<div class="search-result-item" onclick="pickSearchResult(${s.id})">
          <div class="sri-icon" style="background:${bgColor}">
            <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${dotColor}"/></svg>
          </div>
          <div>
            <div class="sri-name">${s.name}</div>
            <div class="sri-sub">${s.postcode} · ${s.borough}</div>
          </div>
        </div>`;
      }).join('');
      results.classList.add('visible');
    }
    renderList();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.value = ''; state.searchQuery = ''; results.classList.remove('visible'); renderList(); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper')) results.classList.remove('visible');
  });
}

window.pickSearchResult = function(id) {
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  const spot = PARKING_DATA.find(s => s.id === id);
  if (spot) {
    input.value = spot.name;
    state.searchQuery = '';
    results.classList.remove('visible');
    renderList();
    selectSpot(id);
  }
};

// ── FILTERS ───────────────────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.pill[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      state.filter = pill.dataset.filter;
      document.querySelectorAll('.pill[data-filter]').forEach(p => p.className = 'pill');
      const cls = { all: 'active-all', free: 'active-free', '6pm': 'active-6pm', '6:30pm': 'active-630pm' }[state.filter];
      pill.classList.add(cls);
      renderList();
    });
  });

  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderList();
  });
}

// ── MOBILE SIDEBAR TOGGLE ─────────────────────────────────────────
function initMobileToggle() {
  const btn = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (btn && sidebar) {
    btn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      btn.textContent = sidebar.classList.contains('open') ? '✕ Close' : '🅿 View List';
    });
  }
}

// ── CAMERA BADGE ──────────────────────────────────────────────────
function updateCameraBadge() {
  const el = document.getElementById('cameraCount');
  if (!el) return;
  const count = state.camerasLoaded ? state.cameras.length : PARKING_DATA.filter(s => s.tflCameraId).length;
  el.textContent = `${count} TfL cameras active`;
}

// ── MARKER REFRESH (every minute) ────────────────────────────────
function startPeriodicRefresh() {
  setInterval(() => {
    renderMarkers();
    renderList();
  }, 60000); // every 1 minute
}

// ── DESELECT ON OUTSIDE CLICK ─────────────────────────────────────
window.deselectSpot = deselectSpot;

// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Hide loading after brief delay for effect
  setTimeout(() => {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }, 1200);

  initMap();
  renderMarkers();
  renderList();
  initSearch();
  initFilters();
  initMobileToggle();
  updateCameraBadge();
  updateClock();
  initTfLCameras();
  startPeriodicRefresh();

  // Live clock every second
  setInterval(updateClock, 1000);

  // Also refresh status displays every minute
  setInterval(() => {
    if (state.selectedId) {
      const spot = PARKING_DATA.find(s => s.id === state.selectedId);
      if (spot) {
        const status = getStatus(spot);
        // Refresh status bar text silently
        const statusEl = document.querySelector('.status-bar');
        if (statusEl) {
          const newStatus = getStatus(spot);
          statusEl.className = `status-bar ${newStatus.code}`;
        }
      }
    }
  }, 30000);
});
