let mapInstance = null;
let altitudeChart = null;
let trackLine = null;
let highlightLine = null;
let lastBounds = null;
let altitudeRangeMmpMarkers = {};
let mmpOverlayLines = [];

const rangeMmpPlugin = {
  id: 'rangeMmpPlugin',
  afterDatasetsDraw(chart) {
    const markers = altitudeRangeMmpMarkers;
    if (!markers || !Object.keys(markers).length) return;

    const ctx = chart.ctx;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const chartArea = chart.chartArea;
    if (!xScale || !yScale || !chartArea) return;

    const palette = {
      '1min': '#ef4444',
      '5min': '#f97316',
      '10min': '#eab308',
      '20min': '#22c55e',
      '30min': '#a855f7',
      '60min': '#3b82f6'
    };

    ctx.save();
    ctx.font = '12px Inter, sans-serif';
    ctx.textBaseline = 'middle';

    const placedLabels = [];

    for (const [label, marker] of Object.entries(markers)) {
      if (!marker) continue;
      if (!Number.isFinite(marker.startIndex) || !Number.isFinite(marker.endIndex)) continue;

      const x1 = xScale.getPixelForValue(marker.startIndex);
      const x2 = xScale.getPixelForValue(marker.endIndex);
      const color = palette[label] || '#ffffff';

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;

      /* Startlinie: durchgezogen */
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, chartArea.top);
      ctx.lineTo(x1, chartArea.bottom);
      ctx.stroke();

      /* Endlinie: gestrichelt */
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x2, chartArea.top);
      ctx.lineTo(x2, chartArea.bottom);
      ctx.stroke();

      /* Dash zurücksetzen */
      ctx.setLineDash([]);

      const text = `${label}: ${Number.isFinite(marker.watts) ? marker.watts : '–'} W`;
      const paddingX = 6;
      const boxHeight = 18;
      const textWidth = ctx.measureText(text).width;
      const boxWidth = textWidth + paddingX * 2;

      let labelX = x1 + 6;
      if (labelX + boxWidth > chartArea.right) {
        labelX = chartArea.right - boxWidth - 4;
      }
      if (labelX < chartArea.left + 4) {
        labelX = chartArea.left + 4;
      }

      let labelY = chartArea.top + 12;

      for (const placed of placedLabels) {
        const overlapsX = !(labelX + boxWidth < placed.x || labelX > placed.x + placed.w);
        const overlapsY = Math.abs(labelY - placed.y) < 20;
        if (overlapsX && overlapsY) {
          labelY += 20;
        }
      }

      if (labelY + boxHeight > chartArea.bottom - 4) {
        labelY = chartArea.bottom - boxHeight - 4;
      }

      ctx.fillStyle = 'rgba(17, 22, 28, 0.78)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;

      roundRect(ctx, labelX, labelY - boxHeight / 2, boxWidth, boxHeight, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, labelX + paddingX, labelY);

      placedLabels.push({ x: labelX, y: labelY, w: boxWidth });
    }

    ctx.restore();
  }
};

export function highlightMapMmpRanges(records, markers) {
  if (!mapInstance) return;

  mmpOverlayLines.forEach(line => line.remove());
  mmpOverlayLines = [];

  const order = ['60min', '30min', '20min', '10min', '5min', '1min'];
  const colors = {
    '1min': '#ef4444',
    '5min': '#f97316',
    '10min': '#eab308',
    '20min': '#22c55e',
    '30min': '#a855f7',
    '60min': '#3b82f6'
  };

  const weights = {
    '1min': 9,
    '5min': 8,
    '10min': 7,
    '20min': 6,
    '30min': 5,
    '60min': 4
  };

  for (const key of order) {
    const marker = markers?.[key];
    if (!marker) continue;
    if (!Number.isFinite(marker.startIndex) || !Number.isFinite(marker.endIndex)) continue;

    const points = (records || [])
      .slice(marker.startIndex, marker.endIndex + 1)
      .filter(r => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long))
      .map(r => [r.position_lat, r.position_long]);

    if (points.length < 2) continue;

    const line = L.polyline(points, {
      pane: 'mmpPane',
      color: colors[key],
      weight: weights[key],
      opacity: key === '60min' ? 0.75 : 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(mapInstance);

    if (Number.isFinite(marker.watts)) {
      line.bindTooltip(`${key}: ${marker.watts} W`, {
        sticky: true,
        direction: 'top',
        offset: [0, -4]
      });
    }

    mmpOverlayLines.push(line);
  }
}

export function clearMapMmpRanges() {
  mmpOverlayLines.forEach(line => line.remove());
  mmpOverlayLines = [];
}

function buildMmpRangeDataset(sourceData, startIndex, endIndex) {
  return sourceData.map((value, index) =>
    index >= startIndex && index <= endIndex ? value : null
  );
}

export function renderMap(records) {
  const valid = (records || []).filter(
    r => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long)
  );

  if (!mapInstance) {
    mapInstance = L.map('map', { preferCanvas: true });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap-Mitwirkende'
    }).addTo(mapInstance);

    if (!mapInstance.getPane('mmpPane')) {
      mapInstance.createPane('mmpPane');
      mapInstance.getPane('mmpPane').style.zIndex = 450;
    }
  }

  if (trackLine) {
    trackLine.remove();
    trackLine = null;
  }

  if (highlightLine) {
    highlightLine.remove();
    highlightLine = null;
  }

  mmpOverlayLines.forEach(line => line.remove());
  mmpOverlayLines = [];

  if (!valid.length) {
    lastBounds = null;
    mapInstance.setView([47.9978, 7.8421], 10);
    return;
  }

  const latlngs = valid.map(r => [r.position_lat, r.position_long]);

  trackLine = L.polyline(latlngs, {
    color: '#d14b57',
    weight: 4,
    opacity: 0.9
  }).addTo(mapInstance);

  lastBounds = trackLine.getBounds();
  mapInstance.fitBounds(lastBounds, { padding: [20, 20] });
}

export function highlightMapRange(records, fromIndex, toIndex) {
  if (!mapInstance) return;

  if (highlightLine) {
    highlightLine.remove();
    highlightLine = null;
  }

  console.log('mapRange', { fromIndex, toIndex });

  const points = (records || [])
    .slice(fromIndex, toIndex + 1)
    .filter(r => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long))
    .map(r => [r.position_lat, r.position_long]);

  console.log('points length', points.length);

  if (points.length < 2) return;

  highlightLine = L.polyline(points, {
    color: '#0b6b75',
    weight: 5,
    opacity: 0.95
  }).addTo(mapInstance);
}

export function renderAltitudeChart(records) {
  const canvas = document.getElementById('altitudeChart');
  if (!canvas) return;

  if (altitudeChart) {
    altitudeChart.destroy();
    altitudeChart = null;
  }

  const labels = (records || []).map(r => {
    const distKm = Number.isFinite(r.distance) ? r.distance / 1000 : null;
    return distKm != null ? distKm.toFixed(2) : '';
  });

  const altitudeData = (records || []).map(r =>
    Number.isFinite(r.altitude) ? Number(r.altitude.toFixed(1)) : null
  );

  const rangeData = new Array(altitudeData.length).fill(null);
  const cursorData = new Array(altitudeData.length).fill(null);

  altitudeChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // 1. Ausgewählter Bereich (Basisfläche)
        {
          label: 'Ausgewählter Bereich',
          data: rangeData,
          borderColor: '#55aab3',
          backgroundColor: 'rgba(85, 170, 179, 0.16)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 60min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.28)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 30min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.26)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 20min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34, 197, 94, 0.26)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 10min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#eab308',
          backgroundColor: 'rgba(234, 179, 8, 0.26)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 5min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.30)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        {
          label: 'MMP 1min',
          data: new Array(altitudeData.length).fill(null),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.34)',
          borderWidth: 0,
          pointRadius: 0,
          tension: 0.18,
          fill: 'origin'
        },
        // 8. Haupt-Höhenlinie (liegt oben auf allen Flächen)
        {
          label: 'Höhe (m)',
          data: altitudeData,
          borderColor: '#0b6b75',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.18,
          fill: false
        },
        // 9. Cursor
        {
          label: 'Position',
          data: cursorData,
          borderColor: '#2563eb',
          backgroundColor: '#2563eb',
          pointRadius: 5,
          pointHoverRadius: 5,
          showLine: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          labels: {
            color: '#8fa0b5',
            boxWidth: 30
          }
        },
        tooltip: {
          enabled: true
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#8fa0b5',
            maxTicksLimit: 14
          },
          title: {
            display: true,
            text: 'Distanz (km)',
            color: '#8fa0b5'
          },
          grid: {
            color: 'rgba(143, 160, 181, 0.08)'
          }
        },
        y: {
          ticks: {
            color: '#8fa0b5'
          },
          title: {
            display: true,
            text: 'Höhe (m)',
            color: '#8fa0b5'
          },
          grid: {
            color: 'rgba(143, 160, 181, 0.08)'
          }
        }
      }
    },
    plugins: [rangeMmpPlugin]
  });
}

export function setAltitudeRangeMmpFills(markers) {
  if (!altitudeChart) return;

  const source = altitudeChart.data.datasets[7]?.data || []; // Höhe (m)
  const datasets = altitudeChart.data.datasets;

  const map = {
    '60min': 1,
    '30min': 2,
    '20min': 3,
    '10min': 4,
    '5min': 5,
    '1min': 6
  };

  for (const [key, datasetIndex] of Object.entries(map)) {
    const ds = datasets[datasetIndex];
    const marker = markers?.[key];
    if (!ds) continue;

    if (!marker || !Number.isFinite(marker.startIndex) || !Number.isFinite(marker.endIndex)) {
      ds.data = new Array(source.length).fill(null);
      continue;
    }

    ds.data = source.map((value, index) =>
      index >= marker.startIndex && index <= marker.endIndex ? value : null
    );
  }

  altitudeChart.update('none');
}

export function clearAltitudeRangeMmpFills() {
  if (!altitudeChart) return;

  const sourceLen = altitudeChart.data.datasets[7]?.data.length || 0;

  [1, 2, 3, 4, 5, 6].forEach(index => {
    if (altitudeChart.data.datasets[index]) {
      altitudeChart.data.datasets[index].data = new Array(sourceLen).fill(null);
    }
  });

  altitudeChart.update('none');
}

export function setAltitudeRangeMmpMarkers(markers) {
  altitudeRangeMmpMarkers = markers || {};
  if (altitudeChart) {
    altitudeChart.update('none');
  }
}

export function clearAltitudeRangeMmpMarkers() {
  altitudeRangeMmpMarkers = {};
  if (altitudeChart) {
    altitudeChart.update('none');
  }
}

export function resetVisuals() {
  if (trackLine) {
    trackLine.remove();
    trackLine = null;
  }

  if (highlightLine) {
    highlightLine.remove();
    highlightLine = null;
  }

  mmpOverlayLines.forEach(line => line.remove());
  mmpOverlayLines = [];

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  if (altitudeChart) {
    altitudeChart.destroy();
    altitudeChart = null;
  }

  altitudeRangeMmpMarkers = {};
  lastBounds = null;
}

export function getMapInstance() {
  return mapInstance;
}

export function getAltitudeChart() {
  return altitudeChart;
}

export function getLastBounds() {
  return lastBounds;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}