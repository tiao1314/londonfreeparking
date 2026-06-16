/* UAV Parking — TfL Live Data */

const state = {
  map: null,
  markers: {},
  selectedId: null,
  userLocation: null,
  userMarker: null,
  filter: 'all',
  sortBy: 'name',
  searchQuery: '',
  spots: [],
  cameras: [],
  camerasLoaded: false,
  filteredData: [],
};

// ── TFL DATA ──────────────────────────────────────────────────────
async function initData() {
  try {
    const [parkRes, camRes] = await Promise.all([
      fetch('https://api.tfl.gov.uk/Occupancy/CarPark'),
      fetch('https://api.tfl.gov.uk/Place/Type/JamCam'),
    ]);

    if (parkRes.ok) {
      const parks = await parkRes.json();
      state.spots = parks
        .map(cp => {
          const bays = (cp.carParkOccupancy?.[0]?.bays || []).find(b => b.bayType === 'All') || null;
          return {
            id: cp.id,
            name: cp.name,
            coords: [cp.lat, cp.lon],
            total: bays?.total ?? null,
            occupied: bays?.occupied ?? null,
            free: bays?.free ?? null,
          };
        })
        .filter(s => s.coords[0] && s.coords[1]);
    }

    if (camRes.ok) {
      const cams = await camRes.json();
      state.cameras = cams.map(cam => {
        const imgProp = (cam.additionalProperties || []).find(p => p.key === 'imageUrl');
        const id = cam.id.replace('JamCams_', '');
        return {
          id,
          lat: cam.lat,
          lon: cam.lon,
          name: cam.commonName || id,
          imageUrl: imgProp?.value || `${TFL_CAMERA_BASE}${id}.jpg`,
        };
      });
      state.camerasLoaded = true;
    }
  } catch (e) {
    console.error('TfL API error:', e);
  }

  renderMarkers();
  renderList();
  document.getElementById('loadingOverlay').classList.add('hidden');
}

async function refreshOccupancy() {
  try {
    const res = await fetch('https://api.tfl.gov.uk/Occupancy/CarPark');
    if (!res.ok) return;
    const parks = await res.json();
    let changed = false;
    parks.forEach(cp => {
      const spot = state.spots.find(s => s.id === cp.id);
      if (!spot) return;
      const bays = (cp.carParkOccupancy?.[0]?.bays || []).find(b => b.bayType === 'All');
      if (bays) {
        spot.total = bays.total;
        spot.occupied = bays.occupied;
        spot.free = bays.free;
        changed = true;
      }
    });
    if (changed) {
      renderMarkers();
      renderList();
      if (state.selectedId) {
        const spot = state.spots.find(s => s.id === state.selectedId);
        if (spot) updatePanelOccupancy(spot);
      }
    }
  } catch (e) {
    console.warn('Refresh failed:', e.message);
  }
}

function getNearestCamera(spot, maxDist = 600) {
  if (!state.cameras.length) return null;
  let nearest = null, minDist = Infinity;
  for (const cam of state.cameras) {
    const d = haversine(spot.coords[0], spot.coords[1], cam.lat, cam.lon);
    if (d < minDist && d < maxDist) { minDist = d; nearest = { ...cam, dist: Math.round(d) }; }
  }
  return nearest;
}

// ── STATUS ────────────────────────────────────────────────────────
function getStatus(spot) {
  if (spot.free === null || spot.total === null || spot.total === 0) {
    return { code: 'unknown', label: 'No data', pct: null };
  }
  const pct = spot.free / spot.total;
  if (spot.free === 0) return { code: 'full', label: 'Full', pct: 0 };
  if (pct < 0.15)      return { code: 'limited', label: `${spot.free} left`, pct: Math.round(pct * 100) };
  return { code: 'free', label: `${spot.free} free`, pct: Math.round(pct * 100) };
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
  const mins = Math.round(m / 80);
  return mins < 1 ? '<1 min walk' : `${mins} min walk`;
}

// ── MAP ───────────────────────────────────────────────────────────
function initMap() {
  state.map = L.map('map', {
    center: [51.5074, -0.1278],
    zoom: 10,
    zoomControl: false,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(state.map);

  L.control.zoom({ position: 'topleft' }).addTo(state.map);
  state.map.on('click', () => { if (state.selectedId) deselectSpot(); });
}

function makeMarkerIcon(spot, status) {
  const colors = {
    free:    { bg: '#30d158', border: '#1da244', text: '#002608' },
    limited: { bg: '#ff9f0a', border: '#d47f00', text: '#1a0e00' },
    full:    { bg: '#ff453a', border: '#cc2f25', text: '#1a0200' },
    unknown: { bg: '#48484a', border: '#5a5a5c', text: '#aeaeb2' },
  }[status.code] || { bg: '#48484a', border: '#5a5a5c', text: '#aeaeb2' };

  const pulse = status.code === 'free'
    ? `<circle cx="18" cy="18" r="14" fill="${colors.bg}" opacity="0.2"><animate attributeName="r" values="14;22;14" dur="2.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.2;0;0.2" dur="2.5s" repeatCount="indefinite"/></circle>`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    ${pulse}
    <circle cx="18" cy="18" r="13" fill="${colors.bg}" stroke="${colors.border}" stroke-width="1.5"/>
    <text x="18" y="23" text-anchor="middle" font-family="-apple-system,system-ui" font-weight="700" font-size="13" fill="${colors.text}">P</text>
  </svg>`;

  return L.divIcon({ html: svg, className: '', iconSize: [36,36], iconAnchor: [18,18], popupAnchor: [0,-20] });
}

function makePopupHTML(spot, status) {
  const barColor = { free: '#30d158', limited: '#ff9f0a', full: '#ff453a' }[status.code] || '#48484a';
  return `
    <div style="min-width:180px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;line-height:1.3">${spot.name}</div>
      ${status.pct !== null ? `
        <div style="margin-bottom:8px">
          <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin-bottom:4px">
            <div style="width:${Math.max(2, status.pct)}%;height:100%;background:${barColor};border-radius:2px"></div>
          </div>
          <div style="font-size:11px;color:#aeaeb2">${spot.free} of ${spot.total} spaces free · Est.</div>
        </div>` : `<div style="font-size:11px;color:#6a6a8a;margin-bottom:8px">No data available</div>`}
      <button class="map-popup-btn" onclick="selectSpot('${spot.id}')">View Details →</button>
    </div>`;
}

function renderMarkers() {
  Object.values(state.markers).forEach(m => m.remove());
  state.markers = {};

  state.spots.forEach(spot => {
    const status = getStatus(spot);
    const icon = makeMarkerIcon(spot, status);
    const marker = L.marker(spot.coords, { icon, zIndexOffset: status.code === 'free' ? 100 : 0 })
      .addTo(state.map)
      .bindPopup(makePopupHTML(spot, status), { maxWidth: 240, className: 'park-popup' });

    marker.on('click', e => { e.originalEvent.stopPropagation(); selectSpot(spot.id); });
    state.markers[spot.id] = marker;
  });
}

// ── LIST ──────────────────────────────────────────────────────────
function getFilteredData() {
  let data = state.spots.slice();

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    data = data.filter(s => s.name.toLowerCase().includes(q));
  }

  if (state.filter !== 'all') {
    data = data.filter(s => {
      const st = getStatus(s);
      if (state.filter === 'available') return st.code === 'free';
      if (state.filter === 'limited')   return st.code === 'limited';
      if (state.filter === 'full')      return st.code === 'full';
      return true;
    });
  }

  data.sort((a, b) => {
    if (state.sortBy === 'distance' && state.userLocation) {
      return haversine(state.userLocation.lat, state.userLocation.lng, a.coords[0], a.coords[1])
           - haversine(state.userLocation.lat, state.userLocation.lng, b.coords[0], b.coords[1]);
    }
    if (state.sortBy === 'availability') {
      const order = { free: 0, limited: 1, unknown: 2, full: 3 };
      return (order[getStatus(a).code] ?? 2) - (order[getStatus(b).code] ?? 2);
    }
    return a.name.localeCompare(b.name);
  });

  state.filteredData = data;
  return data;
}

function renderList() {
  const list = document.getElementById('parkingList');
  const countEl = document.getElementById('resultsNum');
  const data = getFilteredData();

  if (countEl) countEl.textContent = data.length;

  if (!state.spots.length) {
    list.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
    return;
  }

  if (!data.length) {
    list.innerHTML = `<div class="empty-state"><p>No car parks match your filter.</p></div>`;
    return;
  }

  const barColors = { free: 'var(--green)', limited: 'var(--orange)', full: 'var(--red)' };

  list.innerHTML = data.map(spot => {
    const status = getStatus(spot);
    const dist = state.userLocation
      ? haversine(state.userLocation.lat, state.userLocation.lng, spot.coords[0], spot.coords[1])
      : null;
    const barColor = barColors[status.code] || 'rgba(255,255,255,0.1)';
    const pctWidth = status.pct !== null ? Math.max(2, status.pct) : 0;

    return `<div class="parking-card ${state.selectedId === spot.id ? 'selected' : ''}"
                 data-id="${spot.id}" onclick="selectSpot('${spot.id}')">
      <div class="card-dot ${status.code}"></div>
      <div class="card-body">
        <div class="card-name">${spot.name}</div>
        ${status.pct !== null
          ? `<div class="card-occ-bar"><div class="card-occ-fill" style="width:${pctWidth}%;background:${barColor}"></div></div>`
          : ''}
      </div>
      <div class="card-right">
        <span class="badge badge-${status.code}">${status.label}</span>
        ${dist !== null ? `<div class="card-distance">${formatDist(dist)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── SELECT / DESELECT ─────────────────────────────────────────────
window.selectSpot = function(id) {
  const spot = state.spots.find(s => s.id === id);
  if (!spot) return;
  state.selectedId = id;
  renderList();
  state.map.setView(spot.coords, Math.max(state.map.getZoom(), 14), { animate: true });
  if (state.markers[id]) state.markers[id].openPopup();
  openDetailPanel(spot);
  // close mobile sidebar when a spot is selected
  document.getElementById('sidebar')?.classList.remove('open');
};

function deselectSpot() {
  state.selectedId = null;
  state.map.closePopup();
  document.getElementById('detailPanel').classList.remove('open');
  renderList();
}
window.deselectSpot = deselectSpot;

// ── DETAIL PANEL ──────────────────────────────────────────────────
function openDetailPanel(spot) {
  const panel = document.getElementById('detailPanel');
  const status = getStatus(spot);
  const camera = getNearestCamera(spot);
  const dist = state.userLocation
    ? haversine(state.userLocation.lat, state.userLocation.lng, spot.coords[0], spot.coords[1])
    : null;

  const barColor = { free: 'var(--green)', limited: 'var(--orange)', full: 'var(--red)' }[status.code] || 'rgba(255,255,255,0.12)';
  const pctWidth = status.pct !== null ? Math.max(1, status.pct) : 0;
  const statusMsg = {
    free:    'Spaces available now.',
    limited: 'Only a few spaces left.',
    full:    'No spaces available.',
    unknown: 'Occupancy data unavailable.',
  }[status.code] || '';

  const cameraSection = camera ? `
    <div class="info-section">
      <div class="info-section-title">Live Street View
        <button class="cam-refresh-btn" onclick="refreshPanelCamera()">⟳</button>
      </div>
      <div class="camera-feed-box">
        <div class="camera-feed-header">
          <span class="camera-live-dot">LIVE</span>
          <span class="camera-id">${camera.name || camera.id}${camera.dist ? ` · ${camera.dist}m away` : ''}</span>
        </div>
        <div class="camera-img-wrap" id="panelCamWrap">
          <img id="panelCamImg"
               src="${camera.imageUrl}"
               alt="TfL street camera"
               onload="onPanelCamLoad(this)"
               onerror="onPanelCamError()"
               style="opacity:0;width:100%;display:block;transition:opacity 0.4s"/>
          <div class="camera-img-overlay" id="panelCamOverlay">Loading…</div>
        </div>
      </div>
    </div>` : '';

  const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.coords[0]},${spot.coords[1]}`;

  panel.innerHTML = `
    <div class="drag-handle"></div>
    <div class="panel-header">
      <button class="panel-close" onclick="deselectSpot()">✕</button>
      <div class="panel-type-badge">TfL Car Park</div>
      <div class="panel-name">${spot.name}</div>
      ${dist ? `<div class="panel-address">${formatDist(dist)} · ${formatWalk(dist)}</div>` : ''}
    </div>

    <div class="panel-scroll">

      <div class="occ-hero" id="occHero">
        <div class="occ-hero-top">
          <div class="occ-hero-numbers">
            <span class="occ-hero-free" style="color:${barColor}">${spot.free ?? '—'}</span>
            <span class="occ-hero-denom"> / ${spot.total ?? '—'} spaces free</span>
          </div>
          <span class="badge badge-${status.code}">${status.label}</span>
        </div>
        <div class="occ-bar-large">
          <div class="occ-bar-fill" id="occBarFill" style="width:${pctWidth}%;background:${barColor}"></div>
        </div>
        <p class="occ-note">${statusMsg} Data from TfL — estimated, updates every few minutes.</p>
      </div>

      ${cameraSection}

      <div class="action-buttons">
        <a class="btn-directions" href="${gmapsUrl}" target="_blank" rel="noopener">Directions</a>
        <button class="btn-share" onclick="shareSpot('${spot.id}')">Share</button>
      </div>

    </div>`;

  panel.classList.add('open');
}

function updatePanelOccupancy(spot) {
  const status = getStatus(spot);
  const barColor = { free: 'var(--green)', limited: 'var(--orange)', full: 'var(--red)' }[status.code] || 'rgba(255,255,255,0.12)';
  const pctWidth = status.pct !== null ? Math.max(1, status.pct) : 0;
  const hero = document.getElementById('occHero');
  if (!hero) return;
  const freeEl = hero.querySelector('.occ-hero-free');
  const denomEl = hero.querySelector('.occ-hero-denom');
  const fill = document.getElementById('occBarFill');
  if (freeEl) { freeEl.textContent = spot.free ?? '—'; freeEl.style.color = barColor; }
  if (denomEl) denomEl.textContent = ` / ${spot.total ?? '—'} spaces free`;
  if (fill) { fill.style.width = pctWidth + '%'; fill.style.background = barColor; }
}

// ── CAMERA HANDLERS ───────────────────────────────────────────────
window.onPanelCamLoad = function(img) {
  img.style.opacity = '1';
  const overlay = document.getElementById('panelCamOverlay');
  if (overlay) overlay.style.display = 'none';
};

window.onPanelCamError = function() {
  const wrap = document.getElementById('panelCamWrap');
  if (wrap) wrap.innerHTML = '<div class="camera-no-feed"><span>📷</span>Feed unavailable</div>';
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

// ── SHARE ─────────────────────────────────────────────────────────
window.shareSpot = function(id) {
  const spot = state.spots.find(s => s.id === id);
  if (!spot) return;
  const status = getStatus(spot);
  const text = `🅿 ${spot.name} — ${status.label}\nLive TfL data · ${window.location.href}`;
  if (navigator.share) {
    navigator.share({ title: spot.name, text, url: window.location.href });
  } else {
    navigator.clipboard?.writeText(text);
    showToast('Car park info copied');
  }
};

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// ── CLOCK ─────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const el = document.getElementById('clockTime');
  if (el) el.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

// ── GEOLOCATION ───────────────────────────────────────────────────
window.locateMe = function() {
  if (!navigator.geolocation) { showToast('Geolocation not supported'); return; }
  showToast('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (state.userMarker) state.userMarker.remove();
      const userIcon = L.divIcon({
        html: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" fill="#007aff" opacity="0.2">
            <animate attributeName="r" values="9;17;9" dur="2s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.2;0;0.2" dur="2s" repeatCount="indefinite"/>
          </circle>
          <circle cx="12" cy="12" r="7" fill="#007aff" stroke="#fff" stroke-width="2"/>
        </svg>`,
        className: '', iconSize: [24,24], iconAnchor: [12,12],
      });
      state.userMarker = L.marker([pos.coords.latitude, pos.coords.longitude], { icon: userIcon, zIndexOffset: 1000 })
        .addTo(state.map).bindPopup('<div style="font-size:13px">📍 You are here</div>');
      state.map.setView([pos.coords.latitude, pos.coords.longitude], 12, { animate: true });
      state.sortBy = 'distance';
      document.getElementById('sortSelect').value = 'distance';
      renderList();
      showToast('Sorted by distance');
    },
    err => {
      const msgs = ['', 'Location denied', 'Location unavailable', 'Request timed out'];
      showToast(msgs[err.code] || 'Could not get location');
    },
    { timeout: 10000, enableHighAccuracy: true }
  );
};

// ── SEARCH ────────────────────────────────────────────────────────
function initSearch() {
  const input = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  if (!input) return;

  input.addEventListener('input', () => {
    state.searchQuery = input.value.trim();
    const q = state.searchQuery.toLowerCase();
    if (!q) { results.classList.remove('visible'); renderList(); return; }

    const matches = state.spots.filter(s => s.name.toLowerCase().includes(q)).slice(0, 6);
    if (!matches.length) {
      results.classList.remove('visible');
    } else {
      const dotColor = { free:'#30d158', limited:'#ff9f0a', full:'#ff453a', unknown:'#48484a' };
      results.innerHTML = matches.map(s => {
        const st = getStatus(s);
        return `<div class="search-result-item" onclick="pickSearchResult('${s.id}')">
          <div class="sri-dot" style="background:${dotColor[st.code] || '#48484a'}"></div>
          <div>
            <div class="sri-name">${s.name}</div>
            <div class="sri-sub">${st.label}</div>
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
  const spot = state.spots.find(s => s.id === id);
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
      const cls = { all: 'active-all', available: 'active-free', limited: 'active-soon', full: 'active-restricted' }[state.filter];
      pill.classList.add(cls);
      renderList();
    });
  });

  document.getElementById('sortSelect')?.addEventListener('change', e => {
    state.sortBy = e.target.value;
    renderList();
  });
}

// ── MOBILE SIDEBAR ────────────────────────────────────────────────
function initMobileToggle() {
  const btn = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (!btn || !sidebar) return;
  btn.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    btn.textContent = open ? '✕ Close' : '🅿 View List';
  });
}

// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  renderList();
  initSearch();
  initFilters();
  initMobileToggle();
  updateClock();
  initData();

  setInterval(updateClock, 30000);
  setInterval(refreshOccupancy, 3 * 60 * 1000);
});
