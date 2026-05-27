// Intercept Console Logs for Diagnostics
const debugLogs = document.getElementById('debugLogs');
function appendDebugLog(type, ...args) {
  if (debugLogs) {
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    const color = type === 'error' ? 'var(--accent-rose)' : type === 'warn' ? 'var(--accent-amber)' : '#10b981';
    debugLogs.innerHTML += `<div style="color: ${color};">[${type.toUpperCase()}] ${message}</div>`;
    debugLogs.scrollTop = debugLogs.scrollHeight;
  }
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { originalLog(...args); appendDebugLog('info', ...args); };
console.error = (...args) => { originalError(...args); appendDebugLog('error', ...args); };
console.warn = (...args) => { originalWarn(...args); appendDebugLog('warn', ...args); };

// State Management
let allTransactions = [];
let filteredTransactions = [];
let sigunguNameMap = {};
let sidoSigunguMap = {};
let currentSigunguName = '';

// Kakao Map State
let kakaoMapReady = false;
let mainMapInstance = null;
let mainMarkers = [];
let mainOverlayInstance = null;

let kakaoMapInstance = null;
let kakaoMarkerInstance = null;
let kakaoInfoWindowInstance = null;

// Pagination State
let currentPage = 1;
const rowsPerPage = 10;

// Sorting State
let currentSortCol = 'dealDate';
let isSortAsc = false; // default to descending for dates (newest first)

// Chart Instances
let scatterChart = null;
let distChart = null;

// UI Elements
const searchForm = document.getElementById('searchForm');
const sidoSelect = document.getElementById('sidoSelect');
const sigunguSelect = document.getElementById('sigunguSelect');
const yearSelect = document.getElementById('yearSelect');
const monthSelect = document.getElementById('monthSelect');
const searchBtn = document.getElementById('searchBtn');

const introState = document.getElementById('introState');
const dashboardContent = document.getElementById('dashboardContent');
const loadingOverlay = document.getElementById('loadingOverlay');

// KPI elements
const kpiTotalCount = document.getElementById('kpiTotalCount');
const kpiAvgPrice = document.getElementById('kpiAvgPrice');
const kpiMaxPrice = document.getElementById('kpiMaxPrice');
const kpiMaxApt = document.getElementById('kpiMaxApt');
const kpiMinPrice = document.getElementById('kpiMinPrice');
const kpiMinApt = document.getElementById('kpiMinApt');

// Table elements
const transactionTableBody = document.getElementById('transactionTableBody');
const tableSearchInput = document.getElementById('tableSearchInput');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const pageInfo = document.getElementById('pageInfo');
const paginationButtons = document.getElementById('paginationButtons');

// Modal elements
const detailModal = document.getElementById('detailModal');
const modalAptName = document.getElementById('modalAptName');
const detailAddress = document.getElementById('detailAddress');
const detailDate = document.getElementById('detailDate');
const detailArea = document.getElementById('detailArea');
const detailAmount = document.getElementById('detailAmount');
const detailFloor = document.getElementById('detailFloor');
const detailBuildYear = document.getElementById('detailBuildYear');
const detailCancelRow = document.getElementById('detailCancelRow');
const detailCancelStatus = document.getElementById('detailCancelStatus');
const kakaoMapLink = document.getElementById('kakaoMapLink');

const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalCloseBtnBottom = document.getElementById('modalCloseBtnBottom');

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  initFilters();
  setupEventListeners();
  initKakaoMapSDK();
});

// Dynamic Loader for Kakao Maps SDK
async function initKakaoMapSDK() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    const appKey = config.kakaoKey;
    
    if (!appKey) {
      console.warn("Kakao API key is empty. Kakao Map will be disabled.");
      return;
    }
    
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${appKey}&libraries=services&autoload=false`;
      script.onload = () => {
        kakao.maps.load(() => {
          kakaoMapReady = true;
          console.log("Kakao Maps SDK loaded and initialized successfully.");
          initMainMap();
          resolve();
        });
      };
      script.onerror = (err) => {
        console.error("Failed to load Kakao Maps script tag:", err);
        reject(err);
      };
      document.head.appendChild(script);
    });
  } catch (err) {
    console.error("Error fetching Kakao config or loading SDK:", err);
  }
}

// Initialize Main Map
function initMainMap() {
  const mapOverlay = document.getElementById('mapOverlay');
  const mapOverlayText = document.getElementById('mapOverlayText');
  const mapContainer = document.getElementById('mainMap');
  
  if (!mapContainer) return;
  
  try {
    // Seoul City Hall default center
    const defaultCoords = new kakao.maps.LatLng(37.566826, 126.9786567);
    mainMapInstance = new kakao.maps.Map(mapContainer, {
      center: defaultCoords,
      level: 5
    });
    
    // Zoom control
    const zoomControl = new kakao.maps.ZoomControl();
    mainMapInstance.addControl(zoomControl, kakao.maps.ControlPosition.RIGHT);
    
    // Hide map overlay when map is initialized
    if (mapOverlay) {
      mapOverlay.style.opacity = '0';
      setTimeout(() => {
        mapOverlay.style.display = 'none';
      }, 300);
    }
    console.log("Main Map initialized successfully.");
  } catch (e) {
    console.error("Failed to initialize Main Map:", e);
    if (mapOverlayText) {
      mapOverlayText.textContent = "지도를 로드하는 중 오류가 발생했습니다.";
    }
  }
}

// Update Map Markers based on current search result
function updateMainMapMarkers() {
  if (!kakaoMapReady || !mainMapInstance) {
    console.warn("Kakao Map is not ready yet. Cannot update markers.");
    return;
  }
  
  mainMapInstance.relayout();
  
  // Close active overlay
  if (mainOverlayInstance) {
    mainOverlayInstance.setMap(null);
    mainOverlayInstance = null;
  }
  
  // Clear existing markers
  mainMarkers.forEach(m => m.setMap(null));
  mainMarkers = [];
  
  if (allTransactions.length === 0) {
    return;
  }
  
  // Group transactions by unique apartment address
  const complexes = {};
  allTransactions.forEach(t => {
    const key = `${t.aptDong}_${t.jibun}_${t.aptNm}`;
    if (!complexes[key]) {
      complexes[key] = {
        aptNm: t.aptNm,
        aptDong: t.aptDong,
        jibun: t.jibun,
        address: `${currentSigunguName} ${t.aptDong} ${t.jibun}`,
        transactions: []
      };
    }
    complexes[key].transactions.push(t);
  });
  
  const geocoder = new kakao.maps.services.Geocoder();
  const bounds = new kakao.maps.LatLngBounds();
  let resolvedCount = 0;
  const totalCount = Object.keys(complexes).length;
  
  if (totalCount === 0) return;
  
  Object.values(complexes).forEach(complex => {
    geocoder.addressSearch(complex.address, (result, status) => {
      resolvedCount++;
      
      if (status === kakao.maps.services.Status.OK) {
        const coords = new kakao.maps.LatLng(result[0].y, result[0].x);
        
        // Create standard marker
        const marker = new kakao.maps.Marker({
          map: mainMapInstance,
          position: coords,
          title: complex.aptNm
        });
        
        mainMarkers.push(marker);
        bounds.extend(coords);
        
        // Click event to display CustomOverlay
        kakao.maps.event.addListener(marker, 'click', () => {
          showMainMapOverlay(complex, coords);
        });
      }
      
      // Once all geocoding requests resolve, fit the map bounds to show all markers
      if (resolvedCount === totalCount) {
        if (mainMarkers.length > 0 && mainMapInstance) {
          mainMapInstance.setBounds(bounds);
        }
      }
    });
  });
}

// Display Details Overlay on Main Map Marker click
function showMainMapOverlay(complex, coords) {
  if (mainOverlayInstance) {
    mainOverlayInstance.setMap(null);
  }
  
  const maxTxToShow = 5;
  const slicedTx = complex.transactions.slice(0, maxTxToShow);
  const remainingCount = complex.transactions.length - maxTxToShow;
  
  let txHtml = '';
  slicedTx.forEach(tx => {
    const cancelStr = tx.isCancelled ? ' <span class="badge-cancelled" style="font-size: 9px; padding: 1px 3px;"><i class="fa-solid fa-ban"></i> 취소</span>' : '';
    txHtml += `
      <div class="overlay-tx-item">
        <span>${tx.excluUseAr.toFixed(1)}㎡ | ${tx.floor}층${cancelStr}</span>
        <span class="overlay-tx-price">${formatAmount(tx.dealAmount)}</span>
      </div>
    `;
  });
  
  if (remainingCount > 0) {
    txHtml += `
      <div style="font-size: 10px; color: var(--text-muted); text-align: center; margin-top: 6px;">
        외 ${remainingCount}건의 거래가 더 있습니다.
      </div>
    `;
  }
  
  const contentEl = document.createElement('div');
  contentEl.className = 'map-custom-overlay';
  
  contentEl.innerHTML = `
    <div class="overlay-header">
      <span class="overlay-title" title="${complex.aptNm}">${complex.aptNm}</span>
      <button class="overlay-close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="overlay-tx-list">
      ${txHtml}
    </div>
    <div style="text-align: right;">
      <a class="overlay-action-link"><i class="fa-solid fa-list"></i> 상세 내역 보기</a>
    </div>
  `;
  
  const closeBtn = contentEl.querySelector('.overlay-close');
  closeBtn.addEventListener('click', () => {
    if (mainOverlayInstance) {
      mainOverlayInstance.setMap(null);
      mainOverlayInstance = null;
    }
  });
  
  const actionLink = contentEl.querySelector('.overlay-action-link');
  actionLink.addEventListener('click', (e) => {
    e.preventDefault();
    tableSearchInput.value = complex.aptNm;
    currentPage = 1;
    filterTableData();
    
    const dataPanel = document.querySelector('.data-panel');
    if (dataPanel) {
      dataPanel.scrollIntoView({ behavior: 'smooth' });
    }
  });
  
  mainOverlayInstance = new kakao.maps.CustomOverlay({
    content: contentEl,
    map: mainMapInstance,
    position: coords
  });
}

// Initialize Filter Selects
async function initFilters() {
  // Populate Years (2015 to current year 2026)
  const currentYear = new Date().getFullYear();
  yearSelect.innerHTML = '';
  for (let y = currentYear; y >= 2015; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y}년`;
    yearSelect.appendChild(opt);
  }
  
  // Set default month to previous month
  const today = new Date();
  let prevMonth = today.getMonth(); // 0-indexed, so today.getMonth() is previous month (e.g. May in June)
  if (prevMonth === 0) {
    prevMonth = 12;
    // set year to previous year
    yearSelect.value = today.getFullYear() - 1;
  }
  monthSelect.value = String(prevMonth).padStart(2, '0');

  // Load Sigungu list
  try {
    const response = await fetch('/sigungu.json');
    if (!response.ok) throw new Error('Failed to load Sigungu list');
    const sigunguList = await response.json();
    
    // Group by Sido
    sidoSigunguMap = {};
    sigunguNameMap = {};
    
    sigunguList.forEach(item => {
      // Store in map for fast name lookup (needs to be full name for compatibility)
      sigunguNameMap[item.code] = item.name;
      
      const firstSpaceIndex = item.name.indexOf(' ');
      let sido = item.name;
      let sigungu = '';
      if (firstSpaceIndex !== -1) {
        sido = item.name.substring(0, firstSpaceIndex);
        sigungu = item.name.substring(firstSpaceIndex + 1);
      }
      
      if (!sidoSigunguMap[sido]) {
        sidoSigunguMap[sido] = [];
      }
      sidoSigunguMap[sido].push({
        code: item.code,
        name: sigungu || sido
      });
    });
    
    // Populate Sido select
    sidoSelect.innerHTML = '<option value="" disabled selected>시도 선택</option>';
    Object.keys(sidoSigunguMap).sort().forEach(sido => {
      const opt = document.createElement('option');
      opt.value = sido;
      opt.textContent = sido;
      sidoSelect.appendChild(opt);
    });
    
    // Reset Sigungu select
    sigunguSelect.innerHTML = '<option value="" disabled selected>시도 먼저 선택</option>';
    sigunguSelect.disabled = true;
    
  } catch (error) {
    console.error('Error initializing Sigungu select:', error);
    sidoSelect.innerHTML = '<option value="" disabled>오류 발생</option>';
    sigunguSelect.innerHTML = '<option value="" disabled>지역 정보를 불러오지 못했습니다</option>';
  }
}

// Sido Change Listener
function handleSidoChange() {
  const selectedSido = sidoSelect.value;
  if (!selectedSido) {
    sigunguSelect.innerHTML = '<option value="" disabled selected>시도 먼저 선택</option>';
    sigunguSelect.disabled = true;
    return;
  }
  
  const districts = sidoSigunguMap[selectedSido] || [];
  
  sigunguSelect.innerHTML = '<option value="" disabled selected>시군구 선택</option>';
  // Sort Sigungu names alphabetically
  districts.sort((a, b) => a.name.localeCompare(b.name)).forEach(dist => {
    const opt = document.createElement('option');
    opt.value = dist.code;
    opt.textContent = dist.name;
    sigunguSelect.appendChild(opt);
  });
  
  sigunguSelect.disabled = false;
}

// Event Listeners Setup
function setupEventListeners() {
  // Search Form Submit
  searchForm.addEventListener('submit', handleSearch);

  // Sido Select Change
  sidoSelect.addEventListener('change', handleSidoChange);

  // Search inside Table (Debounced input)
  let searchTimeout;
  tableSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentPage = 1;
      filterTableData();
    }, 200);
  });

  // Table Sort Handlers
  const headers = [
    { id: 'th-aptNm', key: 'aptNm' },
    { id: 'th-aptDong', key: 'aptDong' },
    { id: 'th-excluUseAr', key: 'excluUseAr' },
    { id: 'th-dealAmount', key: 'dealAmount' },
    { id: 'th-dealDate', key: 'dealDate' },
    { id: 'th-floor', key: 'floor' },
    { id: 'th-buildYear', key: 'buildYear' }
  ];

  headers.forEach(h => {
    const el = document.getElementById(h.id);
    if (el) {
      el.addEventListener('click', () => handleSort(h.key));
    }
  });

  // Export CSV Click
  exportCsvBtn.addEventListener('click', exportToCsv);

  // Modal Close Handlers
  modalCloseBtn.addEventListener('click', closeModal);
  modalCloseBtnBottom.addEventListener('click', closeModal);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeModal();
  });
}

// Handle Sorting
function handleSort(key) {
  if (currentSortCol === key) {
    isSortAsc = !isSortAsc; // Toggle direction
  } else {
    currentSortCol = key;
    // Default sort direction: descending for dates/prices, ascending for text
    isSortAsc = (key === 'aptNm' || key === 'aptDong');
  }

  // Update Sort Icon UI
  updateSortIcons();
  
  // Sort and render
  sortData();
  renderTable();
}

// Update Header Icons
function updateSortIcons() {
  const headers = ['aptNm', 'aptDong', 'excluUseAr', 'dealAmount', 'dealDate', 'floor', 'buildYear'];
  headers.forEach(h => {
    const el = document.getElementById(`th-${h}`);
    if (el) {
      const icon = el.querySelector('i');
      if (h === currentSortCol) {
        icon.className = isSortAsc ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
        icon.style.color = 'var(--accent-blue)';
      } else {
        icon.className = 'fa-solid fa-sort';
        icon.style.color = 'var(--text-muted)';
      }
    }
  });
}

// Search Action Handler
async function handleSearch() {
  const lawdCd = sigunguSelect.value;
  const year = yearSelect.value;
  const month = monthSelect.value;
  const dealYmd = `${year}${month}`;

  if (!lawdCd) {
    alert('시군구 지역을 선택해 주세요.');
    return;
  }

  // Save selected region name
  currentSigunguName = sigunguNameMap[lawdCd] || '';

  // Switch UI states
  introState.style.display = 'none';
  dashboardContent.style.display = 'block';
  loadingOverlay.classList.add('active');
  searchBtn.disabled = true;
  searchBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 로딩 중...';

  try {
    const response = await fetch(`/api/transactions?lawdCd=${lawdCd}&dealYmd=${dealYmd}`);
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || '실거래가 데이터를 가져오지 못했습니다.');
    }

    const result = await response.json();
    allTransactions = result.transactions || [];
    filteredTransactions = [...allTransactions];
    
    // Clear search input
    tableSearchInput.value = '';
    currentPage = 1;
    
    // Process Dashboard
    calculateKPIs();
    updateCharts();
    sortData();
    renderTable();
    updateMainMapMarkers();

  } catch (error) {
    console.error('Error fetching transactions:', error);
    alert(error.message);
    // Return to intro if empty
    if (allTransactions.length === 0) {
      introState.style.display = 'block';
      dashboardContent.style.display = 'none';
    }
  } finally {
    loadingOverlay.classList.remove('active');
    searchBtn.disabled = false;
    searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> 거래가 조회';
  }
}

// Format Price: 만원 -> 억/천만원
function formatAmount(amountMan) {
  if (amountMan >= 10000) {
    const eok = Math.floor(amountMan / 10000);
    const man = amountMan % 10000;
    if (man === 0) {
      return `${eok}억`;
    }
    return `${eok}억 ${man.toLocaleString()}만`;
  }
  return `${amountMan.toLocaleString()}만`;
}

// Calculate KPI Summary Metrics
function calculateKPIs() {
  const totalCount = allTransactions.length;
  kpiTotalCount.textContent = `${totalCount.toLocaleString()}건`;

  // Filter out cancelled transactions for price statistics
  const validDeals = allTransactions.filter(t => !t.isCancelled);

  if (validDeals.length === 0) {
    kpiAvgPrice.textContent = '-';
    kpiMaxPrice.textContent = '-';
    kpiMaxApt.innerHTML = '거래 건수 없음';
    kpiMinPrice.textContent = '-';
    kpiMinApt.innerHTML = '거래 건수 없음';
    return;
  }

  // Average Price
  const sumPrice = validDeals.reduce((sum, t) => sum + t.dealAmount, 0);
  const avgPrice = Math.round(sumPrice / validDeals.length);
  kpiAvgPrice.textContent = formatAmount(avgPrice);

  // Highest Price
  let maxDeal = validDeals[0];
  validDeals.forEach(t => {
    if (t.dealAmount > maxDeal.dealAmount) maxDeal = t;
  });
  kpiMaxPrice.textContent = formatAmount(maxDeal.dealAmount);
  kpiMaxApt.innerHTML = `<span>${maxDeal.aptNm}</span> (${maxDeal.excluUseAr}㎡, ${maxDeal.floor}층)`;

  // Lowest Price
  let minDeal = validDeals[0];
  validDeals.forEach(t => {
    if (t.dealAmount < minDeal.dealAmount) minDeal = t;
  });
  kpiMinPrice.textContent = formatAmount(minDeal.dealAmount);
  kpiMinApt.innerHTML = `<span>${minDeal.aptNm}</span> (${minDeal.excluUseAr}㎡, ${minDeal.floor}층)`;
}

// Client-side local filtering (table search input)
function filterTableData() {
  const query = tableSearchInput.value.toLowerCase().trim();
  if (query === '') {
    filteredTransactions = [...allTransactions];
  } else {
    filteredTransactions = allTransactions.filter(t => 
      t.aptNm.toLowerCase().includes(query) || 
      t.aptDong.toLowerCase().includes(query)
    );
  }
  sortData();
  renderTable();
}

// Client-side Sorting Logic
function sortData() {
  filteredTransactions.sort((a, b) => {
    let valA = a[currentSortCol];
    let valB = b[currentSortCol];

    // Handle null values
    if (valA === null) return 1;
    if (valB === null) return -1;

    // String comparison
    if (typeof valA === 'string') {
      return isSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    
    // Number comparison
    return isSortAsc ? valA - valB : valB - valA;
  });
}

// Render Transaction Table Rows & Pagination controls
function renderTable() {
  transactionTableBody.innerHTML = '';
  
  if (filteredTransactions.length === 0) {
    transactionTableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 10px; display: block;"></i>
          검색 조건에 맞는 거래 데이터가 없습니다.
        </td>
      </tr>
    `;
    pageInfo.textContent = '검색 결과: 0건';
    paginationButtons.innerHTML = '';
    return;
  }

  // Calculate slice range
  const startIndex = (currentPage - 1) * rowsPerPage;
  const endIndex = Math.min(startIndex + rowsPerPage, filteredTransactions.length);
  const paginatedItems = filteredTransactions.slice(startIndex, endIndex);

  // Render Rows
  paginatedItems.forEach(t => {
    const tr = document.createElement('tr');
    if (t.isCancelled) {
      tr.className = 'cancelled';
    }

    // Amount String formatted for table row
    const amountStr = t.dealAmount.toLocaleString();
    
    tr.innerHTML = `
      <td style="font-weight: 600;">${t.aptNm}</td>
      <td>${t.aptDong}</td>
      <td class="area-col">${t.excluUseAr.toFixed(2)}</td>
      <td class="price-col">${amountStr}</td>
      <td class="date-col">${t.dealDate}</td>
      <td style="text-align: center;">${t.floor ? `${t.floor}층` : '-'}</td>
      <td style="text-align: center;">${t.buildYear || '-'}</td>
      <td>
        ${t.isCancelled 
          ? `<span class="badge-cancelled" title="${t.cdealDate} 해제"><i class="fa-solid fa-ban"></i> 거래 해제</span>` 
          : '<span style="color: var(--accent-teal); font-size: 12px; font-weight: 500;"><i class="fa-solid fa-check"></i> 완료</span>'}
      </td>
    `;

    // Row Click Event -> details modal
    tr.addEventListener('click', () => openDetailModal(t));
    transactionTableBody.appendChild(tr);
  });

  // Page Info text
  pageInfo.textContent = `검색 결과: 총 ${filteredTransactions.length}건 (${startIndex + 1} - ${endIndex}건 표시 중)`;

  // Render Pagination Buttons
  renderPagination();
}

// Generate Pagination Controls
function renderPagination() {
  paginationButtons.innerHTML = '';
  const totalPages = Math.ceil(filteredTransactions.length / rowsPerPage);
  
  if (totalPages <= 1) return;

  // Previous Page Button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'page-btn';
  prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener('click', () => {
    currentPage--;
    renderTable();
  });
  paginationButtons.appendChild(prevBtn);

  // Page Number Buttons (Show max 5 pages, centered on current page)
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  
  if (endPage - startPage < 4) {
    startPage = Math.max(1, endPage - 4);
  }

  for (let p = startPage; p <= endPage; p++) {
    const pageBtn = document.createElement('button');
    pageBtn.className = `page-btn ${p === currentPage ? 'active' : ''}`;
    pageBtn.textContent = p;
    pageBtn.addEventListener('click', () => {
      currentPage = p;
      renderTable();
    });
    paginationButtons.appendChild(pageBtn);
  }

  // Next Page Button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'page-btn';
  nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener('click', () => {
    currentPage++;
    renderTable();
  });
  paginationButtons.appendChild(nextBtn);
}

// Render and Update Chart.js Visualizations
function updateCharts() {
  const validDeals = allTransactions.filter(t => !t.isCancelled);

  // Chart 1: Price vs. Area Scatter Chart
  const scatterData = validDeals.map(t => ({
    x: t.excluUseAr,
    y: t.dealAmount / 10000 // Convert to Eok (억)
  }));

  if (scatterChart) {
    scatterChart.destroy();
  }

  const ctxScatter = document.getElementById('priceScatterChart').getContext('2d');
  
  // Custom tooltip callbacks
  const scatterTooltips = {
    callbacks: {
      label: function(context) {
        const item = validDeals[context.dataIndex];
        return `${item.aptNm}: ${formatAmount(item.dealAmount)} (${item.excluUseAr}㎡, ${item.floor}층)`;
      }
    }
  };

  scatterChart = new Chart(ctxScatter, {
    type: 'scatter',
    data: {
      datasets: [{
        label: '아파트 거래',
        data: scatterData,
        backgroundColor: 'rgba(59, 130, 246, 0.6)',
        borderColor: '#3b82f6',
        borderWidth: 1,
        pointRadius: 6,
        pointHoverRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: scatterTooltips
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '전용면적 (㎡)',
            color: 'var(--text-secondary)',
            font: { family: 'Outfit' }
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'var(--text-secondary)' }
        },
        y: {
          title: {
            display: true,
            text: '거래금액 (억원)',
            color: 'var(--text-secondary)',
            font: { family: 'Outfit' }
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: 'var(--text-secondary)' }
        }
      }
    }
  });

  // Chart 2: Price range distribution Bar Chart
  // Buckets: <1억, 1억~3억, 3억~6억, 6억~9억, 9억~15억, >=15억
  const buckets = [0, 0, 0, 0, 0, 0];
  validDeals.forEach(t => {
    const amt = t.dealAmount;
    if (amt < 10000) buckets[0]++;          // Under 1억
    else if (amt < 30000) buckets[1]++;     // 1억~3억
    else if (amt < 60000) buckets[2]++;     // 3억~6억
    else if (amt < 90000) buckets[3]++;     // 6억~9억
    else if (amt < 150000) buckets[4]++;    // 9억~15억
    else buckets[5]++;                      // Over 15억
  });

  if (distChart) {
    distChart.destroy();
  }

  const ctxDist = document.getElementById('priceDistChart').getContext('2d');
  distChart = new Chart(ctxDist, {
    type: 'bar',
    data: {
      labels: ['1억 미만', '1억~3억', '3억~6억', '6억~9억', '9억~15억', '15억 이상'],
      datasets: [{
        label: '거래 건수',
        data: buckets,
        backgroundColor: [
          'rgba(20, 184, 166, 0.6)', // Teal
          'rgba(59, 130, 246, 0.6)', // Blue
          'rgba(139, 92, 246, 0.6)', // Purple
          'rgba(245, 158, 11, 0.6)', // Amber
          'rgba(244, 63, 94, 0.6)',  // Rose
          'rgba(239, 68, 68, 0.6)'   // Red
        ],
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: 'var(--text-secondary)' }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { 
            color: 'var(--text-secondary)',
            precision: 0
          }
        }
      }
    }
  });
}

// Modal Detail Popup View
function openDetailModal(item) {
  modalAptName.textContent = item.aptNm;
  
  // Format full address
  let fullAddress = `${currentSigunguName} ${item.aptDong} ${item.jibun}`;
  let queryAddress = `${currentSigunguName} ${item.aptDong} ${item.aptNm}`;
  if (item.dongBuilding && item.dongBuilding.trim() !== '' && item.dongBuilding !== '0') {
    fullAddress += ` (${item.dongBuilding}동)`;
    queryAddress += ` ${item.dongBuilding}동`;
  }
  
  detailAddress.textContent = fullAddress;
  detailDate.textContent = item.dealDate;
  detailArea.textContent = `${item.excluUseAr.toFixed(4)} ㎡ (약 ${(item.excluUseAr / 3.3057).toFixed(1)} 평)`;
  detailAmount.textContent = `${item.dealAmount.toLocaleString()} 만원 (${formatAmount(item.dealAmount)})`;
  detailFloor.textContent = item.floor ? `${item.floor} 층` : '-';
  detailBuildYear.textContent = item.buildYear ? `${item.buildYear} 년` : '-';

  // Cancel details row
  if (item.isCancelled) {
    detailCancelRow.style.display = 'flex';
    detailCancelStatus.textContent = `${item.cdealDate} 거래 해제`;
  } else {
    detailCancelRow.style.display = 'none';
  }

  // Kakao Map search link
  kakaoMapLink.href = `https://map.kakao.com/?q=${encodeURIComponent(queryAddress)}`;

  // Show Modal
  detailModal.classList.add('active');
  
  // Render Kakao Map inside modal
  renderModalMap(item);
}

// Render Kakao Map in Modal using Address Geocoding
function renderModalMap(item) {
  const modalMapDiv = document.getElementById('modalMap');
  
  if (!kakaoMapReady) {
    modalMapDiv.style.display = 'none';
    return;
  }

  const geocoder = new kakao.maps.services.Geocoder();
  const address = `${currentSigunguName} ${item.aptDong} ${item.jibun}`;

  geocoder.addressSearch(address, function(result, status) {
    if (status === kakao.maps.services.Status.OK) {
      modalMapDiv.style.display = 'block';
      const coords = new kakao.maps.LatLng(result[0].y, result[0].x);

      // Create map if it doesn't exist
      if (!kakaoMapInstance) {
        kakaoMapInstance = new kakao.maps.Map(modalMapDiv, {
          center: coords,
          level: 3
        });
      } else {
        kakaoMapInstance.setCenter(coords);
        kakaoMapInstance.setLevel(3);
      }

      // Reset marker
      if (kakaoMarkerInstance) {
        kakaoMarkerInstance.setMap(null);
      }
      kakaoMarkerInstance = new kakao.maps.Marker({
        map: kakaoMapInstance,
        position: coords
      });

      // Reset InfoWindow
      if (kakaoInfoWindowInstance) {
        kakaoInfoWindowInstance.close();
      }
      
      const iwContent = `
        <div style="padding:6px 12px; font-size:12px; font-weight:600; color:#1e293b; text-align:center; min-width:150px; font-family:'Inter','Noto Sans KR';">
          ${item.aptNm}<br/>
          <span style="color:#2563eb; font-weight:700;">${formatAmount(item.dealAmount)}</span>
        </div>
      `;
      kakaoInfoWindowInstance = new kakao.maps.InfoWindow({
        content: iwContent
      });
      kakaoInfoWindowInstance.open(kakaoMapInstance, kakaoMarkerInstance);

      // Relayout & center after modal finishes animation
      setTimeout(() => {
        if (kakaoMapInstance) {
          kakaoMapInstance.relayout();
          kakaoMapInstance.setCenter(coords);
        }
      }, 150);

    } else {
      // Fallback to Sigungu + Dong
      const fallbackAddress = `${currentSigunguName} ${item.aptDong}`;
      console.log(`Specific address geocoding failed. Trying fallback: ${fallbackAddress}`);
      
      geocoder.addressSearch(fallbackAddress, function(fbResult, fbStatus) {
        if (fbStatus === kakao.maps.services.Status.OK) {
          modalMapDiv.style.display = 'block';
          const coords = new kakao.maps.LatLng(fbResult[0].y, fbResult[0].x);

          if (!kakaoMapInstance) {
            kakaoMapInstance = new kakao.maps.Map(modalMapDiv, {
              center: coords,
              level: 5
            });
          } else {
            kakaoMapInstance.setCenter(coords);
            kakaoMapInstance.setLevel(5);
          }

          if (kakaoMarkerInstance) {
            kakaoMarkerInstance.setMap(null);
          }
          if (kakaoInfoWindowInstance) {
            kakaoInfoWindowInstance.close();
          }

          // Center without marker to show neighborhood
          setTimeout(() => {
            if (kakaoMapInstance) {
              kakaoMapInstance.relayout();
              kakaoMapInstance.setCenter(coords);
            }
          }, 150);
        } else {
          modalMapDiv.style.display = 'none';
        }
      });
    }
  });
}

function closeModal() {
  detailModal.classList.remove('active');
}

// Export Filtered Data to CSV file
function exportToCsv() {
  if (filteredTransactions.length === 0) {
    alert('내보낼 거래 내역 데이터가 없습니다.');
    return;
  }

  // CSV Headers
  let csvContent = '\uFEFF'; // UTF-8 BOM to prevent Korean character corruption in Excel
  csvContent += '아파트명,법정동,전용면적(㎡),거래금액(만원),계약일,층,건축년도,취소여부\n';

  // Add rows
  filteredTransactions.forEach(t => {
    const aptNameClean = t.aptNm.replace(/"/g, '""');
    const dongClean = t.aptDong.replace(/"/g, '""');
    const isCancelStr = t.isCancelled ? '취소됨' : '정상';
    
    csvContent += `"${aptNameClean}","${dongClean}",${t.excluUseAr},${t.dealAmount},"${t.dealDate}",${t.floor || ''},${t.buildYear || ''},"${isCancelStr}"\n`;
  });

  // Download Anchor trigger
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  
  // File Name formatting (e.g. 서울특별시_종로구_202401_실거래가.csv)
  const regionNameClean = currentSigunguName.replace(/\s+/g, '_');
  const dateStr = `${yearSelect.value}${monthSelect.value}`;
  link.setAttribute('href', url);
  link.setAttribute('download', `${regionNameClean}_${dateStr}_실거래가.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
