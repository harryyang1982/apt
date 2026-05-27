/**
 * GitHub Task Manager Client Module
 * Integrates GitHub REST API with a glassmorphic Kanban dashboard.
 */

// Simple Markdown Parser for Issue description and comments
function parseMarkdown(text) {
  if (!text) return '<em>설명이 없습니다.</em>';
  
  // Escape HTML to prevent XSS
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Code blocks: ```code```
  html = html.replace(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Headers: #, ##, ###
  html = html.replace(/^### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^## (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^# (.*$)/gim, '<h2>$1</h2>');
  
  // Bold: **text** or __text__
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
  
  // Italic: *text* or _text_
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: var(--accent-blue); text-decoration: underline;">$1</a>');
  
  // Bullet lists: - item or * item
  html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li style="margin-left: 16px; margin-bottom: 4px;">$1</li>');
  
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

// GitHub API Class
class GitHubAPI {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.baseUrl = 'https://api.github.com';
  }

  get headers() {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }
    return headers;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers
      }
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: response.statusText };
      }
      throw new Error(errorData.message || `API Error: ${response.status}`);
    }

    if (response.status === 204) return null; // No content
    return response.json();
  }

  // Get repository information to test connection
  async getRepoInfo() {
    return this.request(`/repos/${this.owner}/${this.repo}`);
  }

  // Fetch all issues (excluding PRs)
  async getIssues() {
    // state=all to fetch both open and closed issues
    const data = await this.request(`/repos/${this.owner}/${this.repo}/issues?state=all&per_page=100&sort=updated`);
    // GitHub Issues endpoint also returns pull requests, filter them out
    return data.filter(issue => !issue.pull_request);
  }

  // Create a new issue (task)
  async createIssue(title, body, assignees = [], labels = []) {
    return this.request(`/repos/${this.owner}/${this.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body, assignees, labels })
    });
  }

  // Update an issue (edit details or change state)
  async updateIssue(number, updateData) {
    return this.request(`/repos/${this.owner}/${this.repo}/issues/${number}`, {
      method: 'PATCH',
      body: JSON.stringify(updateData)
    });
  }

  // Fetch comments for a specific issue
  async getComments(number) {
    return this.request(`/repos/${this.owner}/${this.repo}/issues/${number}/comments`);
  }

  // Post a comment on an issue
  async createComment(number, body) {
    return this.request(`/repos/${this.owner}/${this.repo}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }

  // Fetch assignees/collaborators of the repo
  async getAssignees() {
    try {
      return await this.request(`/repos/${this.owner}/${this.repo}/assignees`);
    } catch (e) {
      console.warn("Failed to fetch assignees:", e);
      return []; // Return empty if not authorized
    }
  }

  // Fetch labels defined in the repo
  async getLabels() {
    try {
      return await this.request(`/repos/${this.owner}/${this.repo}/labels`);
    } catch (e) {
      console.warn("Failed to fetch labels:", e);
      return [];
    }
  }
}

// GitHub UI Controller Class
class GitHubUI {
  constructor() {
    this.api = null;
    this.issues = [];
    this.assignees = [];
    this.labels = [];
    this.currentFilters = {
      label: '',
      assignee: '',
      search: ''
    };
    
    this.labelChart = null;
    this.statusChart = null;

    // Elements
    this.configForm = null;
    this.tokenInput = null;
    this.ownerInput = null;
    this.repoInput = null;
    this.connectBtn = null;
    
    this.connSetupSection = null;
    this.dashboardSection = null;
    this.repoInfoCard = null;
    
    // Kanban lists
    this.todoList = null;
    this.progressList = null;
    this.doneList = null;

    // Modals
    this.detailModal = null;
    this.createModal = null;
  }

  async init() {
    this.bindElements();
    this.bindEvents();
    
    // Check if configuration exists in Server .env
    try {
      const response = await fetch('/api/github/config');
      if (response.ok) {
        const serverConfig = await response.json();
        if (serverConfig.token && serverConfig.owner && serverConfig.repo) {
          this.tokenInput.value = serverConfig.token;
          this.ownerInput.value = serverConfig.owner;
          this.repoInput.value = serverConfig.repo;
          
          this.logDebug("[System] Loaded GitHub config from server .env. Attempting auto-connect...");
          await this.connect(serverConfig.token, serverConfig.owner, serverConfig.repo);
          return;
        }
      }
    } catch (err) {
      console.error("Error loading server GitHub config:", err);
    }

    // Otherwise check LocalStorage
    const savedToken = localStorage.getItem('gh_token');
    const savedOwner = localStorage.getItem('gh_owner');
    const savedRepo = localStorage.getItem('gh_repo');

    if (savedToken && savedOwner && savedRepo) {
      this.tokenInput.value = savedToken;
      this.ownerInput.value = savedOwner;
      this.repoInput.value = savedRepo;
      
      this.logDebug("[System] Loaded GitHub credentials from LocalStorage. Attempting auto-connect...");
      await this.connect(savedToken, savedOwner, savedRepo);
    } else {
      this.logDebug("[System] GitHub connection credentials required.");
      this.showSetup();
    }
  }

  bindElements() {
    this.configForm = document.getElementById('githubConfigForm');
    this.tokenInput = document.getElementById('ghTokenInput');
    this.ownerInput = document.getElementById('ghOwnerInput');
    this.repoInput = document.getElementById('ghRepoInput');
    this.connectBtn = document.getElementById('ghConnectBtn');
    
    this.connSetupSection = document.getElementById('githubConnSetup');
    this.dashboardSection = document.getElementById('githubDashboard');
    this.repoInfoCard = document.getElementById('githubRepoInfoCard');
    
    this.todoList = document.getElementById('todoCards');
    this.progressList = document.getElementById('progressCards');
    this.doneList = document.getElementById('doneCards');

    this.detailModal = document.getElementById('githubDetailModal');
    this.createModal = document.getElementById('githubCreateModal');
  }

  bindEvents() {
    // Config Form Submit
    this.configForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = this.tokenInput.value.trim();
      const owner = this.ownerInput.value.trim();
      const repo = this.repoInput.value.trim();

      if (!token || !owner || !repo) {
        alert("모든 필드를 입력해 주세요.");
        return;
      }

      await this.connect(token, owner, repo, true);
    });

    // Disconnect Button
    document.getElementById('ghDisconnectBtn').addEventListener('click', () => {
      this.disconnect();
    });

    // Refresh Button
    document.getElementById('ghRefreshBtn').addEventListener('click', () => {
      this.refreshData();
    });

    // Filters
    document.getElementById('ghFilterLabel').addEventListener('change', (e) => {
      this.currentFilters.label = e.target.value;
      this.renderKanban();
    });

    document.getElementById('ghFilterAssignee').addEventListener('change', (e) => {
      this.currentFilters.assignee = e.target.value;
      this.renderKanban();
    });

    document.getElementById('ghSearchInput').addEventListener('input', (e) => {
      this.currentFilters.search = e.target.value.toLowerCase().trim();
      this.renderKanban();
    });

    // Create Issue Modal Trigger
    document.getElementById('ghCreateTaskBtn').addEventListener('click', () => {
      this.openCreateModal();
    });

    // Create Issue Form Submit
    document.getElementById('githubCreateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleCreateTask();
    });

    // Modal Close buttons
    document.getElementById('ghCreateModalClose').addEventListener('click', () => this.closeCreateModal());
    document.getElementById('ghCreateModalCancel').addEventListener('click', () => this.closeCreateModal());
    document.getElementById('ghDetailModalClose').addEventListener('click', () => this.closeDetailModal());
    document.getElementById('ghDetailModalCloseBottom').addEventListener('click', () => this.closeDetailModal());

    // Post Comment Form
    document.getElementById('ghCommentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handlePostComment();
    });
  }

  logDebug(message) {
    const consoleDiv = document.getElementById('debugLogs');
    if (consoleDiv) {
      const logLine = document.createElement('div');
      logLine.innerText = message;
      consoleDiv.appendChild(logLine);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
    }
  }

  showSetup() {
    this.connSetupSection.style.display = 'block';
    this.dashboardSection.style.display = 'none';
  }

  showDashboard() {
    this.connSetupSection.style.display = 'none';
    this.dashboardSection.style.display = 'block';
  }

  async connect(token, owner, repo, saveToStorage = false) {
    this.connectBtn.disabled = true;
    this.connectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 연결 중...';
    
    try {
      this.api = new GitHubAPI(token, owner, repo);
      this.logDebug(`[GitHub] Repository 조회 시도: ${owner}/${repo}`);
      
      const repoInfo = await this.api.getRepoInfo();
      this.logDebug(`[GitHub] 연결 성공: ${repoInfo.full_name}`);
      
      // Connection details saved
      if (saveToStorage) {
        localStorage.setItem('gh_token', token);
        localStorage.setItem('gh_owner', owner);
        localStorage.setItem('gh_repo', repo);
      }

      this.renderRepoInfo(repoInfo);
      this.showDashboard();
      
      // Fetch metadata & issues asynchronously
      await this.refreshData();
      
    } catch (err) {
      this.logDebug(`[GitHub] 연결 실패: ${err.message}`);
      alert(`GitHub 연동에 실패했습니다.\n사유: ${err.message}\n입력 정보를 다시 확인해 주세요.`);
      this.showSetup();
      this.api = null;
    } finally {
      this.connectBtn.disabled = false;
      this.connectBtn.innerHTML = '<i class="fa-solid fa-link"></i> GitHub 연결';
    }
  }

  disconnect() {
    localStorage.removeItem('gh_token');
    localStorage.removeItem('gh_owner');
    localStorage.removeItem('gh_repo');
    
    this.tokenInput.value = '';
    this.ownerInput.value = '';
    this.repoInput.value = '';
    
    this.api = null;
    this.issues = [];
    this.assignees = [];
    this.labels = [];
    
    this.logDebug("[System] GitHub 연동이 해제되었습니다.");
    this.showSetup();
  }

  async refreshData() {
    if (!this.api) return;
    
    const dashboardLoading = document.getElementById('githubLoading');
    dashboardLoading.classList.add('active');
    
    try {
      this.logDebug("[GitHub] 이슈 및 설정 데이터 갱신 중...");
      
      // Run parallel fetches
      const [issues, assignees, labels] = await Promise.all([
        this.api.getIssues(),
        this.api.getAssignees(),
        this.api.getLabels()
      ]);
      
      this.issues = issues;
      this.assignees = assignees;
      this.labels = labels;

      this.logDebug(`[GitHub] 데이터 로드 완료 (이슈: ${issues.length}건, 담당자: ${assignees.length}명, 라벨: ${labels.length}개)`);
      
      // Update filters dropdowns
      this.populateFilterDropdowns();
      
      // Render Kanban board
      this.renderKanban();
      
      // Render Charts
      this.renderCharts();
      
    } catch (err) {
      this.logDebug(`[GitHub] 데이터 로드 오류: ${err.message}`);
      alert(`데이터 갱신 중 오류가 발생했습니다: ${err.message}`);
    } finally {
      dashboardLoading.classList.remove('active');
    }
  }

  renderRepoInfo(repoInfo) {
    this.repoInfoCard.innerHTML = `
      <div class="github-repo-card glass-panel" style="margin-bottom: 0px; border-color: rgba(59, 130, 246, 0.2);">
        <div class="github-repo-info">
          <div class="github-repo-icon">
            <i class="fa-brands fa-github"></i>
          </div>
          <div class="github-repo-details">
            <h3><a href="${repoInfo.html_url}" target="_blank" style="color: inherit; text-decoration: none;">${repoInfo.full_name} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size: 12px; color: var(--text-secondary);"></i></a></h3>
            <p>${repoInfo.description || '저장소 설명이 없습니다.'}</p>
          </div>
        </div>
        <div class="github-repo-stats">
          <div class="github-stat-pill">
            <i class="fa-solid fa-circle-dot" style="color: var(--accent-purple);"></i>
            <span>Issues: ${repoInfo.open_issues_count}</span>
          </div>
          <div class="github-stat-pill">
            <i class="fa-solid fa-star" style="color: var(--accent-amber);"></i>
            <span>Stars: ${repoInfo.stargazers_count}</span>
          </div>
          <div class="github-stat-pill">
            <i class="fa-solid fa-code-fork" style="color: var(--accent-teal);"></i>
            <span>Forks: ${repoInfo.forks_count}</span>
          </div>
          <button id="ghDisconnectBtnInner" class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px; margin-left: 10px;">
            <i class="fa-solid fa-unlink"></i> 연동 해제
          </button>
        </div>
      </div>
    `;

    document.getElementById('ghDisconnectBtnInner').addEventListener('click', () => this.disconnect());
  }

  populateFilterDropdowns() {
    const filterLabel = document.getElementById('ghFilterLabel');
    const filterAssignee = document.getElementById('ghFilterAssignee');
    
    // Save current values to restore them if possible
    const currentLabelVal = filterLabel.value;
    const currentAssigneeVal = filterAssignee.value;

    // Reset dropdowns
    filterLabel.innerHTML = '<option value="">모든 라벨</option>';
    filterAssignee.innerHTML = '<option value="">모든 담당자</option>';

    // Add labels
    this.labels.forEach(label => {
      const opt = document.createElement('option');
      opt.value = label.name;
      opt.innerText = label.name;
      filterLabel.appendChild(opt);
    });

    // Add assignees
    this.assignees.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.login;
      opt.innerText = user.login;
      filterAssignee.appendChild(opt);
    });

    // Populate modal dropdowns in create issue form
    const createAssignees = document.getElementById('ghCreateAssignees');
    const createLabels = document.getElementById('ghCreateLabels');
    
    createAssignees.innerHTML = '';
    createLabels.innerHTML = '';

    this.assignees.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.login;
      opt.innerText = user.login;
      createAssignees.appendChild(opt);
    });

    this.labels.forEach(label => {
      const opt = document.createElement('option');
      opt.value = label.name;
      opt.innerText = label.name;
      createLabels.appendChild(opt);
    });

    // Restore previous selection
    if (this.labels.some(l => l.name === currentLabelVal)) filterLabel.value = currentLabelVal;
    if (this.assignees.some(a => a.login === currentAssigneeVal)) filterAssignee.value = currentAssigneeVal;
  }

  // Categorize issues and render to columns
  renderKanban() {
    this.todoList.innerHTML = '';
    this.progressList.innerHTML = '';
    this.doneList.innerHTML = '';

    let todoCount = 0;
    let progressCount = 0;
    let doneCount = 0;

    // Filter issues
    const filteredIssues = this.issues.filter(issue => {
      // 1. Label Filter
      if (this.currentFilters.label && !issue.labels.some(l => l.name === this.currentFilters.label)) {
        return false;
      }
      // 2. Assignee Filter
      if (this.currentFilters.assignee) {
        if (!issue.assignee || issue.assignee.login !== this.currentFilters.assignee) {
          return false;
        }
      }
      // 3. Text Search (Title or number or body)
      if (this.currentFilters.search) {
        const query = this.currentFilters.search;
        const matchesTitle = issue.title.toLowerCase().includes(query);
        const matchesNumber = String(issue.number).includes(query);
        const matchesBody = issue.body && issue.body.toLowerCase().includes(query);
        if (!matchesTitle && !matchesNumber && !matchesBody) {
          return false;
        }
      }
      return true;
    });

    // Distribute into Columns
    filteredIssues.forEach(issue => {
      const card = this.createKanbanCardElement(issue);

      if (issue.state === 'closed') {
        this.doneList.appendChild(card);
        doneCount++;
      } else {
        // Decide if In Progress or Todo
        // In Progress if has assignee, OR has 'in-progress' / 'progress' label
        const hasAssignee = issue.assignees && issue.assignees.length > 0;
        const hasProgressLabel = issue.labels.some(l => 
          ['in-progress', '진행중', 'progress', 'doing'].includes(l.name.toLowerCase())
        );

        if (hasAssignee || hasProgressLabel) {
          this.progressList.appendChild(card);
          progressCount++;
        } else {
          this.todoList.appendChild(card);
          todoCount++;
        }
      }
    });

    // Update Counts on UI
    document.getElementById('todoCount').innerText = todoCount;
    document.getElementById('progressCount').innerText = progressCount;
    document.getElementById('doneCount').innerText = doneCount;

    // Show empty placeholder if no cards
    this.checkEmptyColumn(this.todoList, "등록된 할 일이 없습니다.");
    this.checkEmptyColumn(this.progressList, "진행 중인 작업이 없습니다.");
    this.checkEmptyColumn(this.doneList, "완료된 작업이 없습니다.");

    // Update statistics numbers
    const totalCount = this.issues.length;
    const openCount = this.issues.filter(i => i.state === 'open').length;
    const closedCount = totalCount - openCount;
    const myCount = this.issues.filter(i => i.state === 'open' && i.assignees.some(a => a.login === this.api.owner)).length;

    document.getElementById('kpiGithubTotalCount').innerText = totalCount;
    document.getElementById('kpiGithubOpenCount').innerText = openCount;
    document.getElementById('kpiGithubClosedCount').innerText = closedCount;
    document.getElementById('kpiGithubMyCount').innerText = myCount;
  }

  checkEmptyColumn(container, msg) {
    if (container.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.padding = '30px 10px';
      empty.style.background = 'rgba(255,255,255,0.01)';
      empty.style.borderRadius = 'var(--radius-sm)';
      empty.style.border = '1px dashed rgba(255,255,255,0.04)';
      empty.style.margin = '10px 0';
      empty.innerHTML = `
        <i class="fa-solid fa-clipboard-list" style="font-size: 24px; opacity: 0.3;"></i>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${msg}</p>
      `;
      container.appendChild(empty);
    }
  }

  createKanbanCardElement(issue) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.setAttribute('data-id', issue.number);
    
    // Labels string
    let labelsHtml = '';
    if (issue.labels && issue.labels.length > 0) {
      labelsHtml = '<div class="kanban-card-labels">';
      issue.labels.forEach(label => {
        // Use text color based on background lightness or simply provide default
        const rgb = this.hexToRgb(label.color) || { r: 255, g: 255, b: 255 };
        const textCol = (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) > 186 ? '#111827' : '#ffffff';
        labelsHtml += `<span class="github-badge" style="background-color: #${label.color}; color: ${textCol};">${label.name}</span>`;
      });
      labelsHtml += '</div>';
    }

    // Assignees avatar
    let assigneeAvatarHtml = '<div class="avatar-round" style="border: 1px dashed var(--text-muted); display:flex; align-items:center; justify-content:center;"><i class="fa-solid fa-user" style="font-size: 9px; color: var(--text-muted);"></i></div>';
    if (issue.assignees && issue.assignees.length > 0) {
      const primaryAssignee = issue.assignees[0];
      assigneeAvatarHtml = `
        <img src="${primaryAssignee.avatar_url}" 
             alt="${primaryAssignee.login}" 
             class="avatar-round" 
             title="담당자: ${primaryAssignee.login}">
      `;
    }

    // Action buttons depending on issue state
    let actionButtonsHtml = '<div class="kanban-card-actions">';
    
    if (issue.state === 'open') {
      const hasAssignees = issue.assignees && issue.assignees.length > 0;
      const isTodo = !hasAssignees && !issue.labels.some(l => ['in-progress', '진행중', 'progress'].includes(l.name.toLowerCase()));
      
      if (isTodo) {
        actionButtonsHtml += `
          <button class="card-action-btn move-progress-btn" title="진행 시작" data-number="${issue.number}">
            <i class="fa-solid fa-play"></i>
          </button>
        `;
      }
      
      actionButtonsHtml += `
        <button class="card-action-btn close-btn" style="color: var(--accent-rose);" title="완료 처리" data-number="${issue.number}">
          <i class="fa-solid fa-check"></i>
        </button>
      `;
    } else {
      actionButtonsHtml += `
        <button class="card-action-btn reopen-btn" title="재개 (Reopen)" data-number="${issue.number}">
          <i class="fa-solid fa-rotate-left"></i>
        </button>
      `;
    }
    
    actionButtonsHtml += '</div>';

    // Format date nicely
    const updatedDate = new Date(issue.updated_at).toLocaleDateString('ko-KR', {
      month: 'short',
      day: 'numeric'
    });

    card.innerHTML = `
      <div class="kanban-card-header">
        <span class="kanban-card-number">#${issue.number}</span>
        ${labelsHtml}
      </div>
      <div class="kanban-card-title">${issue.title}</div>
      <div class="kanban-card-footer">
        <div class="kanban-card-meta">
          <div class="kanban-card-meta-item">
            ${assigneeAvatarHtml}
          </div>
          <div class="kanban-card-meta-item">
            <i class="fa-regular fa-comment"></i>
            <span>${issue.comments}</span>
          </div>
          <div class="kanban-card-meta-item">
            <i class="fa-regular fa-clock"></i>
            <span>${updatedDate}</span>
          </div>
        </div>
        ${actionButtonsHtml}
      </div>
    `;

    // Click event to view card details
    card.addEventListener('click', (e) => {
      // If user clicked action buttons, don't open modal
      if (e.target.closest('.card-action-btn') || e.target.closest('.kanban-card-actions')) {
        return;
      }
      this.openDetailModal(issue);
    });

    // Action button listeners
    const progressBtn = card.querySelector('.move-progress-btn');
    if (progressBtn) {
      progressBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.moveIssueToProgress(issue.number);
      });
    }

    const closeBtn = card.querySelector('.close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.updateIssueState(issue.number, 'closed');
      });
    }

    const reopenBtn = card.querySelector('.reopen-btn');
    if (reopenBtn) {
      reopenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.updateIssueState(issue.number, 'open');
      });
    }

    return card;
  }

  hexToRgb(hex) {
    const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  // Move issue from Todo to Progress by assigning current user (owner of repo)
  async moveIssueToProgress(number) {
    if (!confirm("이 작업을 진행하시겠습니까?\n작업 진행 시 본인(" + this.api.owner + ")이 담당자로 지정됩니다.")) return;
    
    const dashboardLoading = document.getElementById('githubLoading');
    dashboardLoading.classList.add('active');
    
    try {
      this.logDebug(`[GitHub] 작업 #${number} 진행 시작 설정...`);
      // Update assignee to the owner (or the current authenticated user, default to owner)
      await this.api.updateIssue(number, {
        assignees: [this.api.owner]
      });
      this.logDebug(`[GitHub] 작업 #${number} 진행 설정 완료.`);
      await this.refreshData();
    } catch (e) {
      alert(`작업 진행 처리 중 오류가 발생했습니다: ${e.message}`);
      dashboardLoading.classList.remove('active');
    }
  }

  // Update state (open/close)
  async updateIssueState(number, state) {
    const stateStr = state === 'closed' ? '완료' : '재개';
    if (!confirm(`작업 #${number}번을 ${stateStr} 처리하시겠습니까?`)) return;
    
    const dashboardLoading = document.getElementById('githubLoading');
    dashboardLoading.classList.add('active');
    
    try {
      this.logDebug(`[GitHub] 작업 #${number} 상태를 ${state}로 변경 중...`);
      await this.api.updateIssue(number, { state });
      this.logDebug(`[GitHub] 작업 #${number} 상태 변경 완료.`);
      await this.refreshData();
    } catch (e) {
      alert(`작업 상태 변경 중 오류가 발생했습니다: ${e.message}`);
      dashboardLoading.classList.remove('active');
    }
  }

  // Render Charts
  renderCharts() {
    if (!this.issues.length) return;

    // Destroy existing charts to prevent hover bugs
    if (this.labelChart) this.labelChart.destroy();
    if (this.statusChart) this.statusChart.destroy();

    // 1. Status Doughnut Chart
    const openIssues = this.issues.filter(i => i.state === 'open');
    const closedIssues = this.issues.filter(i => i.state === 'closed');
    
    const statusCtx = document.getElementById('githubStatusChart').getContext('2d');
    this.statusChart = new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['미해결 작업', '완료된 작업'],
        datasets: [{
          data: [openIssues.length, closedIssues.length],
          backgroundColor: ['#8b5cf6', '#14b8a6'],
          borderColor: 'rgba(255,255,255,0.05)',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#9ca3af', font: { family: 'Inter' } }
          }
        }
      }
    });

    // 2. Labels Horizontal Bar Chart
    const labelCounts = {};
    this.issues.forEach(issue => {
      issue.labels.forEach(label => {
        labelCounts[label.name] = (labelCounts[label.name] || 0) + 1;
      });
    });

    // Sort labels by frequency
    const sortedLabels = Object.entries(labelCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7); // Show top 7

    const labelNames = sortedLabels.map(l => l[0]);
    const labelValues = sortedLabels.map(l => l[1]);

    const labelCtx = document.getElementById('githubLabelChart').getContext('2d');
    this.labelChart = new Chart(labelCtx, {
      type: 'bar',
      data: {
        labels: labelNames,
        datasets: [{
          label: '이슈 개수',
          data: labelValues,
          backgroundColor: 'rgba(59, 130, 246, 0.6)',
          borderColor: '#3b82f6',
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            ticks: { color: '#9ca3af', stepSize: 1 },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          y: {
            ticks: { color: '#9ca3af' },
            grid: { display: false }
          }
        }
      }
    });
  }

  // Create Issue Modal Management
  openCreateModal() {
    document.getElementById('ghCreateTitle').value = '';
    document.getElementById('ghCreateBody').value = '';
    
    // Reset selections
    const assigneesSel = document.getElementById('ghCreateAssignees');
    const labelsSel = document.getElementById('ghCreateLabels');
    
    for (let i = 0; i < assigneesSel.options.length; i++) {
      assigneesSel.options[i].selected = false;
    }
    for (let i = 0; i < labelsSel.options.length; i++) {
      labelsSel.options[i].selected = false;
    }

    this.createModal.classList.add('active');
  }

  closeCreateModal() {
    this.createModal.classList.remove('active');
  }

  async handleCreateTask() {
    const title = document.getElementById('ghCreateTitle').value.trim();
    const body = document.getElementById('ghCreateBody').value.trim();
    
    if (!title) {
      alert("작업 제목은 필수 입력 사항입니다.");
      return;
    }

    // Get selected assignees & labels
    const assigneesSel = document.getElementById('ghCreateAssignees');
    const selectedAssignees = Array.from(assigneesSel.selectedOptions).map(opt => opt.value);

    const labelsSel = document.getElementById('ghCreateLabels');
    const selectedLabels = Array.from(labelsSel.selectedOptions).map(opt => opt.value);

    this.closeCreateModal();
    
    const dashboardLoading = document.getElementById('githubLoading');
    dashboardLoading.classList.add('active');

    try {
      this.logDebug(`[GitHub] 새 작업 생성 중: ${title}`);
      await this.api.createIssue(title, body, selectedAssignees, selectedLabels);
      this.logDebug("[GitHub] 새 작업이 성공적으로 생성되었습니다.");
      await this.refreshData();
    } catch (e) {
      alert(`작업 생성에 실패했습니다: ${e.message}`);
      dashboardLoading.classList.remove('active');
    }
  }

  // Detail Modal Management
  async openDetailModal(issue) {
    this.currentDetailIssueNumber = issue.number;
    
    // Set headers & static fields
    document.getElementById('ghDetailTitle').innerText = issue.title;
    document.getElementById('ghDetailNumber').innerText = `#${issue.number}`;
    
    // State Badge
    const stateBadge = document.getElementById('ghDetailState');
    if (issue.state === 'open') {
      stateBadge.className = 'badge-cancelled';
      stateBadge.style.backgroundColor = 'rgba(139, 92, 246, 0.15)';
      stateBadge.style.color = 'var(--accent-purple)';
      stateBadge.innerHTML = '<i class="fa-solid fa-circle-dot"></i> 미해결 (Open)';
    } else {
      stateBadge.className = 'badge-cancelled';
      stateBadge.style.backgroundColor = 'rgba(20, 184, 166, 0.15)';
      stateBadge.style.color = 'var(--accent-teal)';
      stateBadge.innerHTML = '<i class="fa-solid fa-circle-check"></i> 해결완료 (Closed)';
    }

    // Action button in detail modal (Close/Reopen)
    const toggleStateBtn = document.getElementById('ghDetailStateBtn');
    if (issue.state === 'open') {
      toggleStateBtn.innerHTML = '<i class="fa-solid fa-check"></i> 작업 완료 처리';
      toggleStateBtn.className = 'btn btn-primary';
      toggleStateBtn.style.background = 'var(--accent-rose)';
      toggleStateBtn.style.color = 'white';
      toggleStateBtn.style.boxShadow = 'none';
      toggleStateBtn.onclick = async () => {
        this.closeDetailModal();
        await this.updateIssueState(issue.number, 'closed');
      };
    } else {
      toggleStateBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 작업 다시 시작';
      toggleStateBtn.className = 'btn btn-primary';
      toggleStateBtn.style.background = 'var(--accent-blue-gradient)';
      toggleStateBtn.onclick = async () => {
        this.closeDetailModal();
        await this.updateIssueState(issue.number, 'open');
      };
    }

    // Details sidebar info
    // Assignee
    const assigneeDiv = document.getElementById('ghDetailAssignee');
    if (issue.assignees && issue.assignees.length > 0) {
      assigneeDiv.innerHTML = issue.assignees.map(a => `
        <div style="display:flex; align-items:center; gap:8px;">
          <img src="${a.avatar_url}" class="avatar-round" style="width:24px; height:24px;">
          <span>${a.login}</span>
        </div>
      `).join('');
    } else {
      assigneeDiv.innerHTML = '<span style="color:var(--text-muted);">지정 없음</span>';
    }

    // Labels
    const labelsDiv = document.getElementById('ghDetailLabels');
    if (issue.labels && issue.labels.length > 0) {
      labelsDiv.innerHTML = issue.labels.map(l => {
        const rgb = this.hexToRgb(l.color) || { r: 255, g: 255, b: 255 };
        const textCol = (rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114) > 186 ? '#111827' : '#ffffff';
        return `<span class="github-badge" style="background-color: #${l.color}; color: ${textCol}; font-size:11px; margin-right:4px;">${l.name}</span>`;
      }).join('');
    } else {
      labelsDiv.innerHTML = '<span style="color:var(--text-muted);">지정 없음</span>';
    }

    // Date / Author
    document.getElementById('ghDetailCreated').innerText = new Date(issue.created_at).toLocaleString('ko-KR');
    document.getElementById('ghDetailAuthor').innerText = issue.user.login;

    // Body Markdown render
    document.getElementById('ghDetailBody').innerHTML = parseMarkdown(issue.body);

    // Fetch comments
    const commentsList = document.getElementById('ghCommentsList');
    commentsList.innerHTML = '<div style="text-align:center; padding: 10px; color:var(--text-muted);"><i class="fa-solid fa-circle-notch fa-spin"></i> 댓글 로딩 중...</div>';
    
    // Clear comment input
    document.getElementById('ghCommentText').value = '';

    this.detailModal.classList.add('active');

    try {
      const comments = await this.api.getComments(issue.number);
      commentsList.innerHTML = '';
      
      if (comments.length === 0) {
        commentsList.innerHTML = '<div style="text-align:center; padding:20px 10px; color:var(--text-muted); font-size:12px;">등록된 댓글이 없습니다.</div>';
      } else {
        comments.forEach(comment => {
          const div = document.createElement('div');
          div.className = 'comment-item';
          
          const createdDate = new Date(comment.created_at).toLocaleString('ko-KR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });

          div.innerHTML = `
            <div class="comment-avatar-wrapper">
              <img src="${comment.user.avatar_url}" alt="${comment.user.login}" class="avatar-round" style="width:28px; height:28px;">
            </div>
            <div class="comment-content-wrapper">
              <div class="comment-header">
                <span class="comment-author">${comment.user.login}</span>
                <span class="comment-date">${createdDate}</span>
              </div>
              <div class="comment-body github-markdown-body">
                ${parseMarkdown(comment.body)}
              </div>
            </div>
          `;
          commentsList.appendChild(div);
        });
      }
      commentsList.scrollTop = commentsList.scrollHeight;
    } catch (e) {
      commentsList.innerHTML = `<div style="color:var(--accent-rose); font-size:12px; padding:10px; text-align:center;">댓글을 불러오지 못했습니다: ${e.message}</div>`;
    }
  }

  closeDetailModal() {
    this.detailModal.classList.remove('active');
    this.currentDetailIssueNumber = null;
  }

  async handlePostComment() {
    const text = document.getElementById('ghCommentText').value.trim();
    if (!text) {
      alert("댓글 내용을 입력해 주세요.");
      return;
    }

    const number = this.currentDetailIssueNumber;
    if (!number) return;

    const postBtn = document.getElementById('ghPostCommentBtn');
    postBtn.disabled = true;
    postBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
      this.logDebug(`[GitHub] 작업 #${number}에 댓글 작성 중...`);
      await this.api.createComment(number, text);
      
      // Reload modal
      const issue = this.issues.find(i => i.number === number);
      if (issue) {
        // Increment comment count locally
        issue.comments++;
        await this.openDetailModal(issue);
        
        // Refresh behind board
        this.renderKanban();
      }
      this.logDebug(`[GitHub] 댓글이 등록되었습니다.`);
    } catch (e) {
      alert(`댓글 등록 중 오류가 발생했습니다: ${e.message}`);
    } finally {
      postBtn.disabled = false;
      postBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    }
  }
}

// Global initialization
window.githubUI = new GitHubUI();
document.addEventListener('DOMContentLoaded', () => {
  // Tab System integration
  const aptTabBtn = document.getElementById('tabAptBtn');
  const githubTabBtn = document.getElementById('tabGithubBtn');
  
  const aptTab = document.getElementById('aptTab');
  const githubTab = document.getElementById('githubTab');

  if (aptTabBtn && githubTabBtn && aptTab && githubTab) {
    aptTabBtn.addEventListener('click', () => {
      aptTabBtn.classList.add('active');
      githubTabBtn.classList.remove('active');
      aptTab.classList.add('active');
      githubTab.classList.remove('active');
    });

    githubTabBtn.addEventListener('click', async () => {
      githubTabBtn.classList.add('active');
      aptTabBtn.classList.remove('active');
      githubTab.classList.add('active');
      aptTab.classList.remove('active');
      
      // Initialize GitHub UI if not done yet
      if (!window.githubUI.api) {
        await window.githubUI.init();
      }
    });
  }
});
