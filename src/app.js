import { parseFitFile } from './api.js';
import {
  summarizeActivity,
  summarizeRange,
  formatDuration,
  formatDistance,
  formatSpeed,
  formatNumber,
  computeMaxMeanPower,
  calcZonesFromProfile,
  analyzeZones,
  ZONE_NAMES,
  ZONE_COLORS
} from './metrics.js';
import {
  renderMap,
  renderAltitudeChart,
  resetVisuals,
  getMapInstance,
  getAltitudeChart,
  getLastBounds,
  highlightMapRange,
  setAltitudeRangeMmpMarkers,
  clearAltitudeRangeMmpMarkers,
  setAltitudeRangeMmpFills,
  clearAltitudeRangeMmpFills,
  highlightMapMmpRanges,
  clearMapMmpRanges
} from './charts.js';

const fitFileInput = document.getElementById('fitFile');
const positionIndex = document.getElementById('positionIndex');
const positionLabel = document.getElementById('positionLabel');
const analyzeBtn = document.getElementById('analyzeBtn');
const resetBtn = document.getElementById('resetBtn');
const statusBox = document.getElementById('statusBox');
const themeToggle = document.getElementById('themeToggle');
const splitHandle = document.getElementById('splitHandle');
const splitPanel = document.querySelector('.split-panel');
const mapExpandToggle = document.getElementById('mapExpandToggle');
const mapCenterToggle = document.getElementById('mapCenterToggle');
const mapPanel = document.querySelector('.map-panel');
const mapElement = document.getElementById('map');

const rangePanel = document.getElementById('rangePanel');
const rangeFrom = document.getElementById('rangeFrom');
const rangeTo = document.getElementById('rangeTo');
const rangeFromLabel = document.getElementById('rangeFromLabel');
const rangeToLabel = document.getElementById('rangeToLabel');
const rangeTrackFill = document.getElementById('rangeTrackFill');
const rangeDragOverlay = document.getElementById('rangeDragOverlay');

let rangeDragState = null;
let currentRecords = [];
let cursorMarker = null;
let activeMmpLabels = new Set(['1min', '5min', '10min', '20min', '30min', '60min']);
let lastAbsoluteMarkers = {};
let currentZones = [];

const rangeFields = {
  duration: document.getElementById('rangeDuration'),
  distance: document.getElementById('rangeDistance'),
  speed: document.getElementById('rangeSpeed'),
  hr: document.getElementById('rangeHr'),
  ascent: document.getElementById('rangeAscent'),
  descent: document.getElementById('rangeDescent'),
  power: document.getElementById('rangePower'),
  cadence: document.getElementById('rangeCadence')
};

const fields = {
  metricStart: document.getElementById('metricStart'),
  metricDuration: document.getElementById('metricDuration'),
  metricDistance: document.getElementById('metricDistance'),
  metricSpeed: document.getElementById('metricSpeed'),
  metricHr: document.getElementById('metricHr'),
  metricPower: document.getElementById('metricPower'),
  metricAscent: document.getElementById('metricAscent'),
  metricDescent: document.getElementById('metricDescent'),
  detailFileName: document.getElementById('detailFileName'),
  detailPoints: document.getElementById('detailPoints'),
  detailGps: document.getElementById('detailGps'),
  detailPowerAvailable: document.getElementById('detailPowerAvailable'),
  detailHrAvailable: document.getElementById('detailHrAvailable')
};

analyzeBtn.addEventListener('click', handleAnalyze);
resetBtn.addEventListener('click', handleReset);
themeToggle.addEventListener('click', toggleTheme);

initTheme();
initResizableSplit();
initMapExpandToggle();
initMapCenterToggle();
initZonesPanel();

/* -------------------------------------------------------------------------- */
/*   Range Scheduling                                                         */
/* -------------------------------------------------------------------------- */

let pendingRangeFrameId = 0;
let pendingRangeVisual = null;
let pendingRangeStats = null;
let rangeStatsDebounceId = 0;

function applyRangeVisuals(fromIndex, toIndex, records) {
  highlightAltitudeRange(fromIndex, toIndex);
  highlightMapRange(records, fromIndex, toIndex);
}

function applyRangeStats(fromIndex, toIndex, records) {
  const slice = records.slice(fromIndex, toIndex + 1);
  if (!slice.length) return;

  const summary = summarizeRange(slice);
  if (summary) {
    rangeFields.duration.textContent = formatDuration(summary.durationSeconds);
    rangeFields.distance.textContent = formatDistance(summary.distance);
    rangeFields.speed.textContent = formatSpeed(summary.avgSpeed);
    rangeFields.hr.textContent = formatNumber(summary.avgHeartRate, 0, 'bpm');
    rangeFields.ascent.textContent = formatNumber(summary.totalAscent, 0, 'm');
    rangeFields.descent.textContent = formatNumber(summary.totalDescent, 0, 'm');
    rangeFields.power.textContent = formatNumber(summary.avgPower, 0, 'W');
    rangeFields.cadence.textContent = formatNumber(summary.avgCadence, 0, 'rpm');
  }

  const rangeMMP = computeMaxMeanPower(slice);
  displayRangeMaxMeanPower(rangeMMP, records, fromIndex);

  const absoluteMarkers = absolutizeRangeMmp(rangeMMP, fromIndex);
  lastAbsoluteMarkers = absoluteMarkers;

  applyMmpVisibility(records);

  if (currentZones.length) renderZoneAnalysis(slice, currentZones);
}

function absolutizeRangeMmp(rangeMMP, baseIndex) {
  const result = {};

  for (const [key, value] of Object.entries(rangeMMP || {})) {
    result[key] = {
      watts: value?.watts ?? null,
      startIndex: Number.isFinite(value?.startIndex) ? value.startIndex + baseIndex : null,
      endIndex: Number.isFinite(value?.endIndex) ? value.endIndex + baseIndex : null
    };
  }

  return result;
}

function scheduleRangeVisuals(fromIndex, toIndex, records) {
  pendingRangeVisual = { fromIndex, toIndex, records };

  if (pendingRangeFrameId) return;

  pendingRangeFrameId = requestAnimationFrame(() => {
    pendingRangeFrameId = 0;
    if (!pendingRangeVisual) return;

    const { fromIndex, toIndex, records } = pendingRangeVisual;
    pendingRangeVisual = null;

    applyRangeVisuals(fromIndex, toIndex, records);
  });
}

function scheduleRangeStats(fromIndex, toIndex, records) {
  pendingRangeStats = { fromIndex, toIndex, records };

  if (rangeStatsDebounceId) {
    clearTimeout(rangeStatsDebounceId);
  }

  rangeStatsDebounceId = setTimeout(() => {
    rangeStatsDebounceId = 0;
    if (!pendingRangeStats) return;

    const { fromIndex, toIndex, records } = pendingRangeStats;
    pendingRangeStats = null;

    applyRangeStats(fromIndex, toIndex, records);
  }, 180);
}

/* -------------------------------------------------------------------------- */
/*   Analyse / Summary / MMP                                                  */
/* -------------------------------------------------------------------------- */

async function handleAnalyze() {
  const file = fitFileInput.files?.[0];
  if (!file) {
    setStatus('Bitte wähle zuerst eine FIT-Datei aus.', 'error');
    return;
  }

  const mmpPanel = document.getElementById('maxMeanPowerPanel');
  if (mmpPanel) mmpPanel.innerHTML = '';

  try {
    setStatus('Datei wird analysiert ...', 'info');
    analyzeBtn.disabled = true;

    const data = await parseFitFile(file);
    console.log('maxMeanPower from backend:', data.maxMeanPower);
    console.log('✅ keys:', Object.keys(data.maxMeanPower || {}));

    const summary = summarizeActivity(data);
    renderSummary(file.name, summary);

    renderMap(data.records || []);
    renderAltitudeChart(data.records || []);
    currentRecords = data.records || [];

    initRangeSlider(currentRecords);

    const fullMmp = computeMaxMeanPower(currentRecords);
    console.log('🔵 Frontend maxMeanPower:', fullMmp);
    displayMaxMeanPower(fullMmp);

    setStatus('Analyse erfolgreich abgeschlossen.', 'success');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Analyse fehlgeschlagen.', 'error');
  } finally {
    analyzeBtn.disabled = false;
  }
}

function mmpToWattsOnly(mmp) {
  const out = {};
  for (const [key, value] of Object.entries(mmp || {})) {
    out[key] = value?.watts ?? null;
  }
  return out;
}

function renderSummary(fileName, summary) {
  fields.metricStart.textContent = summary.startTime
    ? new Date(summary.startTime).toLocaleString('de-DE')
    : '–';
  fields.metricDuration.textContent = formatDuration(summary.durationSeconds);
  fields.metricDistance.textContent = formatDistance(summary.distance);
  fields.metricSpeed.textContent = formatSpeed(summary.avgSpeed);
  fields.metricHr.textContent = formatNumber(summary.avgHeartRate, 0, 'bpm');
  fields.metricPower.textContent = formatNumber(summary.avgPower, 0, 'W');
  fields.metricAscent.textContent = formatNumber(summary.totalAscent, 0, 'm');
  fields.metricDescent.textContent = formatNumber(summary.totalDescent, 0, 'm');
  fields.detailFileName.textContent = fileName;
  fields.detailPoints.textContent = formatNumber(summary.recordCount, 0, 'Records');
  fields.detailGps.textContent = summary.hasGps ? 'Ja' : 'Nein';
  fields.detailPowerAvailable.textContent = summary.hasPower ? 'Ja' : 'Nein';
  fields.detailHrAvailable.textContent = summary.hasHeartRate ? 'Ja' : 'Nein';
}

function displayMaxMeanPower(mmp) {
  const container = document.getElementById('maxMeanPowerPanel');
  if (!container) return;

  const labels = ['1min', '5min', '10min', '20min', '30min', '60min'];

  container.innerHTML = labels.map(label => {
    const watts = mmp?.[label]?.watts;
    return `
      <div class="metric-card">
        <span>${label}</span>
        <strong>${Number.isFinite(watts) ? `${watts} W` : '–'}</strong>
      </div>
    `;
  }).join('');
}

const MMP_COLORS = {
  '1min':  '#ef4444',
  '5min':  '#f97316',
  '10min': '#eab308',
  '20min': '#22c55e',
  '30min': '#a855f7',
  '60min': '#3b82f6'
};

function displayRangeMaxMeanPower(mmp, records, fromIndex) {
  const container = document.getElementById('rangeMaxMeanPowerPanel');
  if (!container) return;

  const labels = ['1min', '5min', '10min', '20min', '30min', '60min'];

  container.innerHTML = labels.map(label => {
    const watts = mmp?.[label]?.watts;
    const active = activeMmpLabels.has(label);
    const color = MMP_COLORS[label];
    return `
      <div class="metric-card mmp-toggle ${active ? 'mmp-active' : 'mmp-inactive'}"
           data-mmp-label="${label}"
           style="--mmp-color: ${color}">
        <span>${label}</span>
        <strong>${Number.isFinite(watts) ? `${watts} W` : '–'}</strong>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.mmp-toggle').forEach(card => {
    card.addEventListener('click', () => {
      const label = card.dataset.mmpLabel;
      if (activeMmpLabels.has(label)) {
        activeMmpLabels.delete(label);
        card.classList.replace('mmp-active', 'mmp-inactive');
      } else {
        activeMmpLabels.add(label);
        card.classList.replace('mmp-inactive', 'mmp-active');
      }
      applyMmpVisibility(currentRecords);
    });
  });
}

function applyMmpVisibility(records) {
  const filtered = {};
  for (const [key, val] of Object.entries(lastAbsoluteMarkers)) {
    filtered[key] = activeMmpLabels.has(key) ? val : null;
  }
  setAltitudeRangeMmpMarkers(filtered);
  highlightMapMmpRanges(records, filtered);
  setAltitudeRangeMmpFills(filtered);
}

/* -------------------------------------------------------------------------- */
/*   Profil / Zonen                                                           */
/* -------------------------------------------------------------------------- */

function initZonesPanel() {
  const tabSimple  = document.getElementById('zoneTabSimple');
  const tabExpert  = document.getElementById('zoneTabExpert');
  const modeSimple = document.getElementById('zoneModeSimple');
  const modeExpert = document.getElementById('zoneModeExpert');

  tabSimple.addEventListener('click', () => {
    tabSimple.classList.add('active');
    tabExpert.classList.remove('active');
    modeSimple.style.display = '';
    modeExpert.style.display = 'none';
  });
  tabExpert.addEventListener('click', () => {
    tabExpert.classList.add('active');
    tabSimple.classList.remove('active');
    modeExpert.style.display = '';
    modeSimple.style.display = 'none';
    buildExpertTable();
  });

  document.getElementById('calcZonesBtn').addEventListener('click', () => {
    const ftp   = parseFloat(document.getElementById('inputFtp').value);
    const hrMax = parseFloat(document.getElementById('inputHrMax').value);
    if (!Number.isFinite(ftp) || ftp <= 0 || !Number.isFinite(hrMax) || hrMax <= 0) {
      alert('Bitte gültige Werte für FTP und HFmax eingeben.');
      return;
    }
    currentZones = calcZonesFromProfile(ftp, hrMax);
    renderZonesPreview(currentZones);
    if (currentRecords.length) renderZoneAnalysis(currentRecords, currentZones);
  });

  document.getElementById('applyExpertZonesBtn').addEventListener('click', () => {
    const zones = readExpertZones();
    if (!zones) return;
    currentZones = zones;
    renderZonesPreview(currentZones);
    if (currentRecords.length) renderZoneAnalysis(currentRecords, currentZones);
  });
}

function buildExpertTable() {
  const tbody = document.getElementById('zonesExpertBody');
  if (tbody.children.length > 0) return;
  ZONE_NAMES.forEach((name, i) => {
    const existing = currentZones[i];
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td><span class="zone-dot" style="background:${ZONE_COLORS[i]}"></span></td>
        <td>${name}</td>
        <td><input class="zone-input" data-zone="${i}" data-field="powerMin" type="number" value="${existing?.powerMin ?? ''}" placeholder="W" /></td>
        <td><input class="zone-input" data-zone="${i}" data-field="powerMax" type="number" value="${existing?.powerMax ?? ''}" placeholder="W (leer=∞)" /></td>
        <td><input class="zone-input" data-zone="${i}" data-field="hrMin" type="number" value="${existing?.hrMin ?? ''}" placeholder="bpm" /></td>
        <td><input class="zone-input" data-zone="${i}" data-field="hrMax" type="number" value="${existing?.hrMax ?? ''}" placeholder="bpm (leer=∞)" /></td>
      </tr>
    `);
  });
}

function readExpertZones() {
  const zones = ZONE_NAMES.map((name, i) => ({
    name, color: ZONE_COLORS[i], powerMin: 0, powerMax: null, hrMin: 0, hrMax: null
  }));
  document.querySelectorAll('.zone-input').forEach(inp => {
    const zi    = parseInt(inp.dataset.zone);
    const field = inp.dataset.field;
    const val   = inp.value.trim() === '' ? null : parseFloat(inp.value);
    zones[zi][field] = (val === null || !Number.isFinite(val)) ? null : val;
  });
  zones.forEach(z => {
    if (z.powerMin === null) z.powerMin = 0;
    if (z.hrMin    === null) z.hrMin    = 0;
  });
  return zones;
}

function renderZonesPreview(zones) {
  const preview = document.getElementById('zonesPreview');
  const grid    = document.getElementById('zonesPreviewGrid');
  preview.style.display = '';
  grid.innerHTML = zones.map(z => `
    <div class="zone-preview-card" style="border-color:${z.color}">
      <span class="zone-dot" style="background:${z.color}"></span>
      <strong>${z.name}</strong>
      <span>${z.powerMin}–${z.powerMax ?? '∞'} W</span>
      <span>${z.hrMin}–${z.hrMax ?? '∞'} bpm</span>
    </div>
  `).join('');
}

function renderZoneAnalysis(records, zones) {
  const container = document.getElementById('rangeZoneAnalysis');
  if (!container) return;
  const result   = analyzeZones(records, zones);
  const hasPower = result.some(z => z.powerSeconds > 0);
  const hasHr    = result.some(z => z.hrSeconds    > 0);
  if (!hasPower && !hasHr) {
    container.innerHTML = '<p class="muted">Keine Leistungs- oder HF-Daten für Zonenanalyse.</p>';
    return;
  }
  container.innerHTML = `
    <div class="zone-bars">
      ${hasPower ? `<div class="zone-bar-group"><h4>Leistungszonen</h4>${result.map(z => `
        <div class="zone-bar-row">
          <span class="zone-label">${z.name}</span>
          <div class="zone-bar-track"><div class="zone-bar-fill" style="width:${z.powerPct.toFixed(1)}%;background:${z.color}"></div></div>
          <span class="zone-bar-pct">${z.powerPct.toFixed(0)}%</span>
          <span class="zone-bar-time">${formatDuration(z.powerSeconds)}</span>
        </div>`).join('')}</div>` : ''}
      ${hasHr ? `<div class="zone-bar-group"><h4>HF-Zonen</h4>${result.map(z => `
        <div class="zone-bar-row">
          <span class="zone-label">${z.name}</span>
          <div class="zone-bar-track"><div class="zone-bar-fill" style="width:${z.hrPct.toFixed(1)}%;background:${z.color}"></div></div>
          <span class="zone-bar-pct">${z.hrPct.toFixed(0)}%</span>
          <span class="zone-bar-time">${formatDuration(z.hrSeconds)}</span>
        </div>`).join('')}</div>` : ''}
    </div>`;
}

/* -------------------------------------------------------------------------- */
/*   Reset / Status / Theme                                                   */
/* -------------------------------------------------------------------------- */

function handleReset() {
  fitFileInput.value = '';
  Object.values(fields).forEach(field => {
    field.textContent = '–';
  });

  Object.values(rangeFields).forEach(field => {
    field.textContent = '–';
  });

  positionLabel.textContent = '0.00 km';
  rangeFromLabel.textContent = 'Von: 0.00 km';
  rangeToLabel.textContent = 'Bis: 0.00 km';

  resetVisuals();
  clearAltitudeRangeMmpMarkers();
  clearMapMmpRanges();
  clearAltitudeRangeMmpFills();
  lastAbsoluteMarkers = {};
  activeMmpLabels = new Set(['1min', '5min', '10min', '20min', '30min', '60min']);

  rangePanel.style.display = 'none';
  currentRecords = [];
  cursorMarker = null;

  if (rangeTrackFill) {
    rangeTrackFill.style.left = '0%';
    rangeTrackFill.style.width = '0%';
  }

  const mmpPanel = document.getElementById('maxMeanPowerPanel');
  if (mmpPanel) mmpPanel.innerHTML = '';

  const rangeMmpPanel = document.getElementById('rangeMaxMeanPowerPanel');
  if (rangeMmpPanel) rangeMmpPanel.innerHTML = '';

  setStatus('Ansicht wurde zurückgesetzt.', 'info');
}

function setStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className = `status-box ${type}`;
}

function initTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
}

/* -------------------------------------------------------------------------- */
/*   Split-Panel / Karte                                                      */
/* -------------------------------------------------------------------------- */

function initResizableSplit() {
  if (!splitHandle || !splitPanel) return;

  let isDragging = false;

  splitHandle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    isDragging = true;
    splitHandle.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });

  window.addEventListener('mousemove', (event) => {
    if (!isDragging) return;
    if (window.innerWidth <= 700) return;

    const rect = splitPanel.getBoundingClientRect();
    const handleWidth = 10;
    const minLeft = 320;
    const minRight = 320;

    let leftWidth = event.clientX - rect.left;
    const maxLeft = rect.width - handleWidth - minRight;

    if (leftWidth < minLeft) leftWidth = minLeft;
    if (leftWidth > maxLeft) leftWidth = maxLeft;

    const rightWidth = rect.width - leftWidth - handleWidth;
    splitPanel.style.gridTemplateColumns = `${leftWidth}px ${handleWidth}px ${rightWidth}px`;

    const map = getMapInstance();
    if (map) map.invalidateSize(false);

    const chart = getAltitudeChart();
    if (chart) chart.resize();
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    splitHandle.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    setTimeout(() => {
      const map = getMapInstance();
      if (map) map.invalidateSize(false);
      const chart = getAltitudeChart();
      if (chart) chart.resize();
    }, 100);
  });
}

function initMapExpandToggle() {
  if (!mapExpandToggle || !mapPanel || !mapElement) return;

  mapExpandToggle.addEventListener('click', () => {
    const expanded = mapPanel.classList.toggle('expanded');

    mapExpandToggle.textContent = expanded
      ? 'Karte verkleinern'
      : 'Karte vergrößern';

    const map = getMapInstance();
    const bounds = getLastBounds();

    if (!map || !bounds) return;

    setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [20, 20] });
    }, 220);
  });
}

function initMapCenterToggle() {
  if (!mapCenterToggle) return;

  mapCenterToggle.addEventListener('click', () => {
    const map = getMapInstance();
    const bounds = getLastBounds();

    if (map && bounds) {
      map.invalidateSize(false);
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  });
}

/* -------------------------------------------------------------------------- */
/*   Index-basierter Range-Slider                                             */
/* -------------------------------------------------------------------------- */

function initRangeSlider(records) {
  if (!records.length) return;

  const maxIndex = records.length - 1;

  rangeFrom.min = 0;
  rangeFrom.max = maxIndex;
  rangeTo.min = 0;
  rangeTo.max = maxIndex;

  const initialWindow = Math.max(200, Math.round(maxIndex * 0.2));
  rangeFrom.value = '0';
  rangeTo.value = String(Math.min(maxIndex, initialWindow));

  rangeFrom.oninput = () => handleRangeChange(records);
  rangeTo.oninput = () => handleRangeChange(records);

  rangeFrom.onchange = () => finalizeRangeChange(records);
  rangeTo.onchange = () => finalizeRangeChange(records);

  rangePanel.style.display = '';

  positionIndex.min = 0;
  positionIndex.max = maxIndex;
  positionIndex.value = 0;

  updatePositionCursor(records, 0);

  positionIndex.oninput = () => {
    const idx = parseInt(positionIndex.value, 10) || 0;
    updatePositionCursor(records, idx);
  };

  handleRangeChange(records);
  finalizeRangeChange(records);
  initRangeDragOverlay(records);
}

function finalizeRangeChange(records) {
  let from = parseInt(rangeFrom.value, 10);
  let to = parseInt(rangeTo.value, 10);

  if (from > to) [from, to] = [to, from];

  applyRangeVisuals(from, to, records);
  applyRangeStats(from, to, records);
}

function initRangeDragOverlay(records) {
  if (!rangeDragOverlay || !records.length) return;

  rangeDragOverlay.onpointerdown = null;
  rangeDragOverlay.onpointermove = null;
  rangeDragOverlay.onpointerup = null;
  rangeDragOverlay.onpointercancel = null;
  rangeDragOverlay.onlostpointercapture = null;

  rangeDragOverlay.onpointerdown = (event) => {
    const maxIndex = parseInt(rangeTo.max, 10);
    if (!Number.isFinite(maxIndex)) return;

    const rect = rangeDragOverlay.getBoundingClientRect();
    rangeDragOverlay.setPointerCapture(event.pointerId);

    rangeDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      rectWidth: rect.width,
      startFrom: parseInt(rangeFrom.value, 10),
      startTo: parseInt(rangeTo.value, 10),
      maxIndex
    };

    rangeDragOverlay.classList.add('is-dragging');
  };

  rangeDragOverlay.onpointermove = (event) => {
    if (!rangeDragState || event.pointerId !== rangeDragState.pointerId) return;

    const { rectWidth, startX, startFrom, startTo, maxIndex } = rangeDragState;
    if (rectWidth <= 0) return;

    const dx = event.clientX - startX;
    const deltaIndex = Math.round((dx / rectWidth) * maxIndex);

    const size = startTo - startFrom;
    if (size <= 0 || size >= maxIndex) return;

    let nextFrom = startFrom + deltaIndex;
    let nextTo = startTo + deltaIndex;

    if (nextFrom < 0) {
      nextFrom = 0;
      nextTo = size;
    }

    if (nextTo > maxIndex) {
      nextTo = maxIndex;
      nextFrom = maxIndex - size;
    }

    rangeFrom.value = String(nextFrom);
    rangeTo.value = String(nextTo);

    handleRangeChange(records);
  };

  const endDrag = (event) => {
    if (!rangeDragState || event.pointerId !== rangeDragState.pointerId) return;

    rangeDragState = null;
    rangeDragOverlay.classList.remove('is-dragging');

    try {
      rangeDragOverlay.releasePointerCapture(event.pointerId);
    } catch (_) { }

    finalizeRangeChange(records);
  };

  rangeDragOverlay.onpointerup = endDrag;
  rangeDragOverlay.onpointercancel = endDrag;
  rangeDragOverlay.onlostpointercapture = endDrag;
}

function handleRangeChange(records) {
  let from = parseInt(rangeFrom.value, 10);
  let to = parseInt(rangeTo.value, 10);

  if (from > to) {
    if (document.activeElement === rangeFrom) {
      rangeFrom.value = String(to);
      from = to;
    } else {
      rangeTo.value = String(from);
      to = from;
    }
  }

  const max = records.length - 1;
  if (max <= 0) return;

  rangeTrackFill.style.left = `${(from / max) * 100}%`;
  rangeTrackFill.style.width = `${((to - from) / max) * 100}%`;

  const dFrom = records[from]?.distance;
  const dTo = records[to]?.distance;

  rangeFromLabel.textContent = `Von: ${dFrom != null ? (dFrom / 1000).toFixed(2) + ' km' : '–'}`;
  rangeToLabel.textContent = `Bis: ${dTo != null ? (dTo / 1000).toFixed(2) + ' km' : '–'}`;

  scheduleRangeVisuals(from, to, records);
  scheduleRangeStats(from, to, records);
}

/* -------------------------------------------------------------------------- */
/*   Chart-/Map-Cursor                                                        */
/* -------------------------------------------------------------------------- */

function highlightAltitudeRange(fromIndex, toIndex) {
  const chart = getAltitudeChart();
  if (!chart) return;

  const rangeDataset = chart.data.datasets[0]; // Ausgewählter Bereich
  const mainDataset = chart.data.datasets[7];  // Höhe (m)

  if (!mainDataset || !rangeDataset) return;

  const src = mainDataset.data;
  const dst = new Array(src.length).fill(null);

  for (let i = fromIndex; i <= toIndex && i < src.length; i++) {
    dst[i] = src[i];
  }

  rangeDataset.data = dst;
  chart.update('none');
}

function updateMapCursor(records, index) {
  const mapInstance = getMapInstance();
  if (!mapInstance || !records.length) return;

  const r = records[index];
  if (!Number.isFinite(r.position_lat) || !Number.isFinite(r.position_long)) return;

  const latlng = [r.position_lat, r.position_long];

  if (!cursorMarker) {
    cursorMarker = L.circleMarker(latlng, {
      radius: 8,
      color: '#f2f3f5',
      weight: 2,
      fillColor: '#030ff8',
      fillOpacity: 1
    }).addTo(mapInstance);
  } else {
    cursorMarker.setLatLng(latlng);
  }
}

function updatePositionCursor(records, index) {
  const r = records[index];
  if (!r) return;

  positionLabel.textContent = Number.isFinite(r.distance)
    ? (r.distance / 1000).toFixed(2) + ' km'
    : `${index}`;

  updateMapCursor(records, index);
  updatePointStats(r);

  const chart = getAltitudeChart();
  if (!chart) return;

  const mainDataset = chart.data.datasets[7];   // Höhe (m)
  const cursorDataset = chart.data.datasets[8]; // Position
  if (!mainDataset || !cursorDataset) return;

  const src = mainDataset.data;
  const dst = new Array(src.length).fill(null);

  if (index >= 0 && index < src.length) {
    dst[index] = src[index];
  }

  cursorDataset.data = dst;
  chart.update('none');
}

function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updatePointStats(r) {
  safeSetText('pointHr', r.heart_rate != null ? `${r.heart_rate} bpm` : '–');
  safeSetText('pointAltitude', Number.isFinite(r.altitude) ? `${r.altitude.toFixed(1)} m` : '–');
  safeSetText('pointSpeed', Number.isFinite(r.speed) ? `${(r.speed * 3.6).toFixed(1)} km/h` : '–');
  safeSetText('pointPower', r.power != null ? `${r.power} W` : '–');
}