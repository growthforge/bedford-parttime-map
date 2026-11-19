/*
 * Bedford part-time job map — page logic.
 *
 * Loads the business list, computes every distance in the browser with the
 * haversine formula (mean Earth radius 3958.7613 miles / 6371 km), filters
 * and sorts by that computed distance, then renders the list cards and the
 * Leaflet markers. The list is paginated (40 cards per "Load more" page) so
 * thousands of records never enter the DOM at once — a marker tap for a
 * card on an unloaded page shows a single "Selected from the map" card
 * above the list instead of appending every card in between — and the
 * markers go into a Leaflet.markercluster group with chunked loading so
 * "All businesses" (3,890 markers in the real data) stays usable on a phone.
 * If the cluster plugin fails to load, only the pins for the businesses on the loaded list
 * pages are drawn. No cookies, no analytics, no service worker, nothing is
 * written.
 */
(function () {
  'use strict';

  /* Centre point: Mercure Bedford Centre Hotel, 2 St Marys Street, Bedford MK42 0AR.
   * GPS 52.133977, -0.465752 — official Accor hotel page
   * https://all.accor.com/hotel/B541/index.en.shtml, confirmed 19 Nov 2026. */
  var CENTRE_LAT = 52.133977;
  var CENTRE_LNG = -0.465752;
  var HOTEL_NAME = 'Mercure Bedford Centre Hotel';
  var HOTEL_ADDRESS = '2 St Marys Street, Bedford MK42 0AR';

  var HARD_MAX_MILES = 6;  // nothing further than this is ever shown
  var PAGE_SIZE = 40;      // cards per "Load more" page — never thousands at once
  var CLUSTER_RADIUS = 60; // px, for L.markerClusterGroup
  /* './businesses.json' is tried first (the file sits next to the page, as
   * in a repo-root deploy); if it 404s, '../businesses.json' backs it up
   * (a copy one folder up), so the same page works at a repo root or from
   * a sub-folder. */
  var PRIMARY_DATA_URLS = ['./businesses.json', '../businesses.json'];
  var EXAMPLE_DATA_URL = './example-businesses.json';

  /* ---- Helpers ------------------------------------------------------ */

  function toRad(d) { return d * Math.PI / 180; }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    var R = 3958.7613;
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

  /* Coordinates must be numeric: a number, or a numeric string. */
  function toCoord(v) {
    if (isFiniteNumber(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v);
      if (isFinite(n)) return n;
    }
    return NaN;
  }

  function strOrNull(v) {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  }

  /* Only http(s) URLs from the data are ever linked. */
  function safeHttpUrl(v) {
    var t = strOrNull(v);
    return t && /^https?:\/\//i.test(t) ? t : null;
  }

  /* part_time_link can hold several vacancy URLs, separated by " | " in the
   * real data (8 of the 26 published rows); newlines and "; " are tolerated
   * too. Only http(s) URLs are kept, one Vacancy action per URL. */
  function splitVacancyLinks(value) {
    if (typeof value !== 'string') return [];
    var urls = [];
    value.split(/\s*\|\s*|\r\n|\r|\n|;/).forEach(function (part) {
      var url = safeHttpUrl(part);
      if (url && urls.indexOf(url) === -1) urls.push(url);
    });
    return urls;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function telHref(phone) { return 'tel:' + phone.replace(/\s+/g, ''); }

  /* No origin, so Google Maps starts from the device's location. */
  function directionsUrl(lat, lng, mode) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=' + mode;
  }

  function formatDistance(miles) { return miles.toFixed(1) + ' miles'; }

  /* ---- State and DOM ------------------------------------------------ */

  var state = {
    all: [],          // validated records within 6 miles, distance computed here
    filtered: [],     // current filter and sort result
    selectedDetail: null, // the one record shown in the "Selected from the map" slot
    /* Default scope is 'published': only businesses with a published
     * part-time vacancy are listed and plotted until "All businesses" is
     * tapped. */
    filters: { query: '', category: 'all', scope: 'published', maxMiles: 6 },
    travelMode: 'walking', // walking | driving | transit — used by every Directions link
    dataReady: false
  };

  /* Pagination: the DOM only ever holds the cards of the pages loaded so
   * far (PAGE_SIZE each), grown by the "Load more" button. */
  var renderedCount = 0;

  var el = {
    banner: document.getElementById('example-banner'),
    map: document.getElementById('map'),
    mapNote: document.getElementById('map-note'),
    status: document.getElementById('status'),
    cards: document.getElementById('cards'),
    selectedSection: document.getElementById('selected-detail'),
    selectedClear: document.getElementById('selected-clear'),
    selectedCard: document.getElementById('selected-card'),
    noMatches: document.getElementById('no-matches'),
    count: document.getElementById('result-count'),
    search: document.getElementById('search-input'),
    filters: document.querySelector('.filters'),
    scopeChips: document.getElementById('scope-chips'),
    categoryChips: document.getElementById('category-chips'),
    travelChips: document.getElementById('travel-chips'),
    loadMore: document.getElementById('load-more')
  };

  var searchTimer = null;
  var highlightTimer = null;

  /* ---- Leaflet map --------------------------------------------------- */

  var map = null;
  var businessLayer = null;
  var bizIcon = null;
  var clusteringReady = false; // true once Leaflet.markercluster has loaded

  function showMapNote(text) {
    if (!el.mapNote) return;
    el.mapNote.textContent = text;
    el.mapNote.hidden = false;
  }

  function initMap() {
    if (typeof window.L === 'undefined') {
      el.map.innerHTML = '<p class="map-unavailable">The interactive map could not load — the Leaflet CDN was unreachable. The list and the directions links below still work.</p>';
      return;
    }
    map = L.map(el.map).setView([CENTRE_LAT, CENTRE_LNG], 12);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
    }).addTo(map);

    var centreIcon = L.divIcon({
      className: 'centre-pin-wrap',
      html: '<span class="centre-pin" aria-hidden="true"></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    /* The hotel marker is added straight to the map, never to the cluster
     * group, so it is always visible no matter the scope or zoom. */
    L.marker([CENTRE_LAT, CENTRE_LNG], {
      icon: centreIcon,
      keyboard: true,
      title: 'You are starting here — ' + HOTEL_NAME
    }).addTo(map).bindPopup(
      '<strong>You are starting here</strong><br>' + esc(HOTEL_NAME) + '<br>' + esc(HOTEL_ADDRESS) +
      '<br><small>GPS 52.133977, -0.465752 (source: Accor, 19 Nov 2026)</small>'
    );

    clusteringReady = typeof L.markerClusterGroup === 'function';
    if (clusteringReady) {
      businessLayer = L.markerClusterGroup({
        chunkedLoading: true, // adds 3,890 markers in chunks, not one blocking loop
        maxClusterRadius: CLUSTER_RADIUS
      }).addTo(map);
    } else {
      /* No cluster plugin: thousands of loose pins would freeze a phone, so
       * only the loaded list pages ever get pins. */
      businessLayer = L.layerGroup().addTo(map);
      showMapNote('Map clustering did not load, so the map shows only the pins for the businesses currently listed below.');
    }
  }

  function popupHtml(r) {
    var lines = [
      '<strong>' + esc(r.name) + '</strong>',
      esc(r.category) + ' &middot; ' + esc(formatDistance(r.distanceMiles))
    ];
    if (r.address) lines.push(esc(r.address));
    return lines.join('<br>');
  }

  function renderMarkers() {
    if (!businessLayer) return;
    businessLayer.clearLayers();
    if (!state.filtered.length) return;
    if (!bizIcon) {
      bizIcon = L.divIcon({
        className: 'biz-pin-wrap',
        html: '<span class="biz-pin" aria-hidden="true"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
    }
    /* Without clustering, only the businesses on the loaded list pages are
     * plotted; with it, every filtered business is clustered on the map. */
    var shown = clusteringReady ? state.filtered : state.filtered.slice(0, renderedCount);
    var markers = [];
    shown.forEach(function (r, i) {
      var marker = L.marker([r.lat, r.lng], { icon: bizIcon, keyboard: true, title: r.name });
      marker.bindPopup(popupHtml(r));
      marker.on('click', function () { highlightCard(i); });
      markers.push(marker);
    });
    if (businessLayer.addLayers) {
      businessLayer.addLayers(markers); // chunked by the cluster group
    } else {
      markers.forEach(function (m) { businessLayer.addLayer(m); });
    }
  }

  function fitToVisible() {
    if (!map) return;
    if (!state.filtered.length) {
      map.setView([CENTRE_LAT, CENTRE_LNG], 12); // town-scale context around the hotel
      return;
    }
    var bounds = L.latLngBounds([CENTRE_LAT, CENTRE_LNG]);
    state.filtered.forEach(function (r) { bounds.extend([r.lat, r.lng]); });
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  /* ---- Selected from the map ----------------------------------------- */

  /* The single record a marker tap can point at while its card sits beyond
   * the loaded pages. Replaces any previous selection; dismissed by its
   * Clear button and by every filter, search or scope change (the record
   * may no longer match). */
  function clearSelectedDetail() {
    state.selectedDetail = null;
    el.selectedSection.hidden = true;
    el.selectedCard.innerHTML = '';
  }

  /* (Re)build the selected-detail card. The travel mode calls this too, so
   * the detail card's Directions href always matches the current mode. */
  function renderSelectedCard() {
    if (state.selectedDetail) {
      el.selectedCard.innerHTML = cardHtml(state.selectedDetail, 'selected-detail-card');
    }
  }

  /* Outline a card for a few seconds, then scroll it into view. */
  function flashAndScroll(card) {
    card.classList.add('is-highlight');
    if (highlightTimer) window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(function () {
      card.classList.remove('is-highlight');
    }, 3000);
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }

  function highlightCard(index) {
    var previous = document.querySelector('.card.is-highlight');
    if (previous) previous.classList.remove('is-highlight');
    if (index < renderedCount) {
      /* The tapped marker's card is on a loaded page: highlight it there. */
      clearSelectedDetail();
      var card = document.getElementById('biz-' + index);
      if (card) flashAndScroll(card);
      return;
    }
    /* The card is beyond the loaded pages: never grow the paginated list
     * for one tap — show this business alone in the selected-detail slot. */
    var record = state.filtered[index];
    if (!record) return;
    state.selectedDetail = record;
    renderSelectedCard();
    el.selectedSection.hidden = false;
    var detailCard = el.selectedCard.querySelector('.card');
    if (detailCard) flashAndScroll(detailCard);
  }

  /* ---- Records -------------------------------------------------------- */

  /* Returns a display-ready record, or null when the record must be skipped
   * (no name, no usable coordinates, or beyond HARD_MAX_MILES). Any
   * distance_miles field on the record is deliberately ignored. */
  function normaliseBusiness(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = strOrNull(raw.name);
    if (!name) return null;
    var lat = toCoord(raw.lat);
    var lng = toCoord(raw.lng);
    if (!isFinite(lat) || Math.abs(lat) > 90 || !isFinite(lng) || Math.abs(lng) > 180) return null;

    var distanceMiles = haversineMiles(CENTRE_LAT, CENTRE_LNG, lat, lng);
    if (distanceMiles > HARD_MAX_MILES) return null;

    /* part_time_status is one of exactly "published", "not found" or
     * "not checked" in the real data. "not checked" is a distinct status
     * and is never collapsed into "not found"; anything else counts as
     * "not checked". */
    var status = typeof raw.part_time_status === 'string'
      ? raw.part_time_status.trim().toLowerCase() : '';
    if (status !== 'published' && status !== 'not found') status = 'not checked';

    var vacancyLinks = splitVacancyLinks(raw.part_time_link);

    /* The real file uses careers_url; careers_page_url is still accepted so
     * the example fixture keeps working. When the careers page is already
     * one of the vacancy links, only the Vacancy action is shown. */
    var careersUrl = safeHttpUrl(raw.careers_url) || safeHttpUrl(raw.careers_page_url);
    if (careersUrl && vacancyLinks.indexOf(careersUrl) !== -1) careersUrl = null;

    return {
      name: name,
      category: strOrNull(raw.category) || 'Uncategorised',
      address: strOrNull(raw.address),
      postcode: strOrNull(raw.postcode),
      lat: lat,
      lng: lng,
      distanceMiles: distanceMiles, // computed here; used for all filtering and sorting
      phone: strOrNull(raw.phone),
      website: safeHttpUrl(raw.website),
      openingHours: strOrNull(raw.opening_hours),
      partTimeStatus: status,
      vacancyLinks: vacancyLinks,
      careersUrl: careersUrl,
      searchText: [raw.name, raw.category, raw.address, raw.postcode]
        .filter(function (v) { return typeof v === 'string'; })
        .join(' ')
        .toLowerCase()
    };
  }

  /* Accept a top-level array or an object with a "businesses" array. */
  function extractBusinesses(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object' && Array.isArray(json.businesses)) return json.businesses;
    return null;
  }

  function useJson(json, isExample) {
    var rawRecords = extractBusinesses(json);
    if (!rawRecords) {
      showStatusBox('Business list could not be read',
        '<p>The file is valid JSON, but it is neither an array nor an object with a ' +
        '<code>businesses</code> array, so nothing can be shown from it.</p>');
      return;
    }
    var records = [];
    var skipped = 0;
    rawRecords.forEach(function (raw) {
      var record = normaliseBusiness(raw);
      if (record) records.push(record);
      else skipped++;
    });
    if (!records.length) {
      showStatusBox('No usable businesses in the data file',
        '<p>Every record needs a name and numeric coordinates, and must be within ' +
        HARD_MAX_MILES + ' miles of the hotel.' +
        (skipped ? ' ' + skipped + ' record' + (skipped === 1 ? ' was' : 's were') + ' skipped.' : '') +
        '</p>');
      return;
    }
    if (skipped) {
      console.info('[job map] Skipped ' + skipped + ' record(s) with no name, no usable coordinates, or beyond ' + HARD_MAX_MILES + ' miles.');
    }
    state.all = records;
    state.dataReady = true;
    buildCategoryChips();
    el.status.hidden = true;
    el.status.innerHTML = '';
    if (isExample) el.banner.hidden = false;
    applyFilters();
    render();
  }

  /* ---- Loading -------------------------------------------------------- */

  function loadJson(url) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      return response.json();
    });
  }

  /* ?data= must be a same-origin relative filename: no protocol, no '..',
   * no absolute path, no backslashes. Anything else is ignored. */
  function safeDataParam(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    if (!v || v.length > 200) return null;
    if (v.indexOf('..') !== -1) return null;
    if (v.indexOf(':') !== -1) return null;
    if (v.indexOf('\\') !== -1) return null;
    if (v.charAt(0) === '/') return null;
    return v;
  }

  /* The real list is a few megabytes, so the loading state stays up until
   * the fetch, the JSON parse and the normalise pass have all finished. */
  function showLoading() {
    el.status.hidden = false;
    el.status.innerHTML =
      '<div class="status-box">' +
      '<p class="loading">Loading businesses…</p>' +
      '<p class="loading-hint">The full list is a few megabytes, so this can take a moment.</p>' +
      '</div>';
  }

  function showNotLoaded() {
    showStatusBox('Business list not loaded yet',
      '<p>The real business list (<code>businesses.json</code>) could not be found next to ' +
      'this page or one folder up. Once it is in place, this page will show it ' +
      'automatically on reload.</p>' +
      '<p>To preview how the page behaves, you can load clearly-labelled placeholder data:</p>');
  }

  /* Loading / empty / error state. Always offers the example data,
   * clearly labelled, since no real data is available in these states. */
  function showStatusBox(title, bodyHtml) {
    state.all = [];
    state.filtered = [];
    state.dataReady = false;
    renderedCount = 0;
    el.cards.innerHTML = '';
    clearSelectedDetail();
    el.noMatches.hidden = true;
    el.loadMore.hidden = true;
    renderMarkers();
    updateCount();
    el.status.hidden = false;
    el.status.innerHTML =
      '<div class="status-box">' +
      '<h3>' + esc(title) + '</h3>' +
      bodyHtml +
      '<button type="button" id="load-example" class="btn btn-primary">Load example data (not real businesses)</button>' +
      '</div>';
    var button = el.status.querySelector('#load-example');
    if (button) button.addEventListener('click', loadExampleData);
  }

  function loadExampleData() {
    var button = el.status.querySelector('#load-example');
    if (button) {
      button.disabled = true;
      button.textContent = 'Loading example data…';
    }
    loadJson(EXAMPLE_DATA_URL)
      .then(function (json) { useJson(json, true); })
      .catch(function (err) {
        showStatusBox('Example data could not be loaded',
          '<p>example-businesses.json could not be read (' +
          esc(String(err && err.message ? err.message : err)) + ').</p>');
      });
  }

  /* ---- Filters -------------------------------------------------------- */

  function applyFilters() {
    var f = state.filters;
    var q = f.query.trim().toLowerCase();
    state.filtered = state.all.filter(function (r) {
      if (r.distanceMiles > f.maxMiles) return false;
      if (f.category !== 'all' && r.category !== f.category) return false;
      if (f.scope === 'published' && r.partTimeStatus !== 'published') return false;
      if (q && r.searchText.indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) {
      return a.distanceMiles - b.distanceMiles || a.name.localeCompare(b.name, 'en-GB');
    });
  }

  function chipHtml(group, value, label, pressed) {
    return '<button type="button" class="chip" data-group="' + group +
           '" data-value="' + esc(value) + '" aria-pressed="' + (pressed ? 'true' : 'false') +
           '">' + esc(label) + '</button>';
  }

  /* "All" plus one chip per distinct category in the loaded, in-range data
   * (25 in the real file). The chips are dataset-wide and stay put across
   * scope changes, so a category with no match in the current scope can
   * stay selected and simply show the no-matches message. */
  function buildCategoryChips() {
    var seen = {};
    var categories = [];
    state.all.forEach(function (r) {
      if (!seen[r.category]) {
        seen[r.category] = true;
        categories.push(r.category);
      }
    });
    categories.sort(function (a, b) { return a.localeCompare(b, 'en-GB'); });

    if (categories.indexOf(state.filters.category) === -1) state.filters.category = 'all';

    var html = [chipHtml('category', 'all', 'All', state.filters.category === 'all')];
    categories.forEach(function (c) {
      html.push(chipHtml('category', c, c, state.filters.category === c));
    });
    el.categoryChips.innerHTML = html.join('');
  }

  function setPressed(container, value) {
    if (!container) return;
    var chips = container.querySelectorAll('.chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].setAttribute('aria-pressed',
        chips[i].getAttribute('data-value') === value ? 'true' : 'false');
    }
  }

  function wireEvents() {
    el.search.addEventListener('input', function () {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        state.filters.query = el.search.value;
        applyFilters();
        render();
      }, 150);
    });

    el.filters.addEventListener('click', function (event) {
      var chip = event.target.closest ? event.target.closest('.chip') : null;
      if (!chip) return;
      var group = chip.getAttribute('data-group');
      var value = chip.getAttribute('data-value');
      if (group === 'travel') {
        state.travelMode = value;
        setPressed(el.travelChips, value);
        refreshVisibleCards(); // rewrites every Directions href, page stays as it is
        renderSelectedCard();  // …and the selected-detail card's Directions href
      } else {
        if (group === 'scope') state.filters.scope = value;
        else if (group === 'distance') state.filters.maxMiles = Number(value);
        else if (group === 'category') state.filters.category = value;
        else return;
        setPressed(chip.parentElement, value);
        applyFilters();
        render(); // any scope, distance or category change resets the list to page 1
      }
    });

    el.loadMore.addEventListener('click', function () {
      appendUpTo(renderedCount + PAGE_SIZE);
      if (!clusteringReady) renderMarkers(); // fallback mode: the pins follow the loaded pages
    });

    el.selectedClear.addEventListener('click', clearSelectedDetail);
  }

  /* ---- Rendering ------------------------------------------------------ */

  function render() {
    clearSelectedDetail(); // any filter, search, scope or data change invalidates the map selection
    resetList();
    renderMarkers();
    fitToVisible();
  }

  /* Clear the list and draw its first page again. */
  function resetList() {
    el.cards.innerHTML = '';
    renderedCount = 0;
    el.noMatches.hidden = state.filtered.length !== 0;
    appendUpTo(PAGE_SIZE);
  }

  /* Append cards until the list holds target records (never more than the
   * filtered total), then refresh the count line and the Load more button. */
  function appendUpTo(target) {
    if (!state.dataReady) return;
    var total = state.filtered.length;
    if (target > total) target = total;
    if (target > renderedCount) {
      var html = [];
      for (var i = renderedCount; i < target; i++) html.push(cardHtml(state.filtered[i], 'biz-' + i));
      el.cards.insertAdjacentHTML('beforeend', html.join(''));
      renderedCount = target;
    }
    updateCount();
    updateLoadMore();
  }

  /* Rebuild just the cards already shown, keeping the same page — used when
   * the travel mode changes and only the Directions hrefs differ. */
  function refreshVisibleCards() {
    if (!state.dataReady) return;
    el.cards.innerHTML = state.filtered.slice(0, renderedCount)
      .map(function (r, i) { return cardHtml(r, 'biz-' + i); }).join('');
  }

  function cardHtml(r, id) {
    var actions = [];
    if (r.phone) {
      actions.push('<a class="btn btn-primary" href="' + esc(telHref(r.phone)) + '">Call</a>');
    }
    actions.push('<a class="btn btn-primary" target="_blank" rel="noopener noreferrer" href="' +
      esc(directionsUrl(r.lat, r.lng, state.travelMode)) + '">Directions</a>');
    /* One Vacancy action per link; plain "Vacancy" when there is only one. */
    r.vacancyLinks.forEach(function (url, n) {
      actions.push('<a class="btn btn-secondary" target="_blank" rel="noopener noreferrer" href="' +
        esc(url) + '">' + (r.vacancyLinks.length === 1 ? 'Vacancy' : 'Vacancy ' + (n + 1)) + '</a>');
    });
    if (r.careersUrl) {
      actions.push('<a class="btn btn-secondary" target="_blank" rel="noopener noreferrer" href="' +
        esc(r.careersUrl) + '">Careers page</a>');
    }
    if (r.website) {
      actions.push('<a class="btn btn-ghost" target="_blank" rel="noopener noreferrer" href="' +
        esc(r.website) + '">Website</a>');
    }

    var html =
      '<li class="card" id="' + id + '">' +
      '<div class="card-top"><h3 class="card-name">' + esc(r.name) + '</h3>' +
      '<p class="card-distance">' + esc(formatDistance(r.distanceMiles)) + '</p></div>' +
      '<p class="card-meta"><span class="card-category">' + esc(r.category) + '</span>' +
      partTimeBadge(r) + '</p>';

    var place = [r.address, r.postcode].filter(Boolean).join(', ');
    if (place) html += '<p class="card-place">' + esc(place) + '</p>';
    if (r.openingHours) html += '<p class="card-hours">Opening hours: ' + esc(r.openingHours) + '</p>';
    html += '<div class="card-actions">' + actions.join('') + '</div></li>';
    return html;
  }

  /* Three distinct statuses, shown exactly as the data states them. */
  function partTimeBadge(r) {
    var cls = r.partTimeStatus === 'published' ? 'badge-published'
            : (r.partTimeStatus === 'not found' ? 'badge-notfound' : 'badge-notchecked');
    return '<span class="badge ' + cls + '">Part-time: ' + esc(r.partTimeStatus) + '</span>';
  }

  /* The count line reports the cards actually on the page against the full
   * filtered total, e.g. "Showing 26 of 26 businesses" on the default view
   * or "Showing 40 of 3890 businesses" after the first page of All. */
  function updateCount() {
    if (!state.dataReady) {
      el.count.textContent = '';
      return;
    }
    var shown = Math.min(renderedCount, state.filtered.length);
    var total = state.filtered.length;
    el.count.textContent = 'Showing ' + shown + ' of ' + total + ' ' +
      (total === 1 ? 'business' : 'businesses');
  }

  function updateLoadMore() {
    var remaining = state.filtered.length - renderedCount;
    if (!state.dataReady || remaining <= 0) {
      el.loadMore.hidden = true;
    } else {
      el.loadMore.hidden = false;
      el.loadMore.textContent = 'Load more (' + remaining + ' remaining)';
    }
  }

  /* ---- Boot ----------------------------------------------------------- */

  function boot() {
    initMap();
    wireEvents();
    showLoading();

    var param = null;
    try {
      param = safeDataParam(new URLSearchParams(window.location.search).get('data'));
    } catch (e) { /* very old browser: skip the ?data= support */ }

    var chain = PRIMARY_DATA_URLS.slice();
    var exampleUrl = null;
    if (param) {
      chain.unshift(param);
      exampleUrl = param;
    }

    var index = 0;
    (function tryNext() {
      if (index >= chain.length) {
        showNotLoaded();
        return;
      }
      var url = chain[index++];
      loadJson(url)
        .then(function (json) { useJson(json, url === exampleUrl); })
        .catch(function () { tryNext(); });
    })();
  }

  boot();
})();
