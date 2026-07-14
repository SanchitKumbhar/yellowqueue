/**
 * PrintFlow Frontend – app.js
 * Full backend integration via api.js service layer.
 * Keeps all UI rendering logic intact; replaces mock data with real API calls.
 */

"use strict";

const { ipcRenderer } = require("electron");
const api = require("./api");
const fs = require("fs");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

document.addEventListener("DOMContentLoaded", () => {

    // ── Cleanup on reload: remove all iframes/previews to prevent download triggers ──
    window.addEventListener("beforeunload", () => {
        // Remove all iframes immediately so Chromium doesn't re-request
        // their file:// or http:// sources during reload teardown
        document.querySelectorAll("iframe").forEach(f => {
            f.src = "about:blank";
            f.remove();
        });
        const previewCard = document.getElementById("preview-document-card");
        if (previewCard) previewCard.innerHTML = "";
        const detailCanvas = document.getElementById("detail-preview-canvas");
        if (detailCanvas) detailCanvas.innerHTML = "";
    });

    // ==========================================
    // UI LAYOUT OVERRIDES (Wider Panel & Smooth Transitions)
    // ==========================================
    const layoutStyles = document.createElement('style');
    layoutStyles.innerHTML = `
        .details-panel {
            width: 950px !important;
            max-width: 90vw !important;
        }
        .details-body-wrapper {
            display: grid !important;
            grid-template-columns: 380px 1fr !important;
            gap: 24px !important;
        }
        .mini-preview-viewport {
            height: 480px !important;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: #0F172A;
            border-radius: 8px;
        }
        .mini-preview-content {
            flex: 1;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            box-sizing: border-box;
        }
        /* Base iframe setup to support aspect-ratio paper sizing */
        .mini-preview-content iframe {
            background: white;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            height: 100%;
            aspect-ratio: 1 / 1.414; /* Default A4 aspect ratio */
            border: none;
            border-radius: 4px;
        }
    `;
    document.head.appendChild(layoutStyles);

    // ==========================================
    // STATE MANAGEMENT
    // ==========================================
    let sidebarCollapsed = false;
    let activeScreen = "dashboard";
    let activeSettingsTab = "general";

    let printers = [];
    let jobs = [];
    let incomingJobs = [];
    let activities = [];
    let dashboardSummary = null;
    let userProfile = null;

    let selectedJobIds = [];
    let expandedPhoneCards = {}; 
    
    let activePreviewFile = { name: null, url: null }; 
    let drawerPreviewState = { zoom: 100 };

    // ==========================================
    // DOM ELEMENT SELECTORS
    // ==========================================
    const appContainer      = document.getElementById("main-app-container");
    const authContainer     = document.getElementById("auth-container");
    const loginForm         = document.getElementById("login-form");
    const signupForm        = document.getElementById("signup-form");
    const toggleToSignup    = document.getElementById("toggle-to-signup");
    const toggleToLogin     = document.getElementById("toggle-to-login");

    const sidebar           = document.getElementById("sidebar");
    const sidebarToggle     = document.getElementById("sidebar-toggle");
    const navItems          = document.querySelectorAll(".sidebar-nav .nav-item");
    const screens           = document.querySelectorAll(".screen-view");

    const detailsPanel      = document.getElementById("details-panel");
    const detailsCloseBtn   = document.getElementById("details-close-btn");
    const detailJobId       = document.getElementById("detail-job-id");
    const detailStatusBadge = document.getElementById("detail-status-badge");
    const detailCustomerName = document.getElementById("detail-customer-name");
    const detailPhoneNumber = document.getElementById("detail-phone-number");
    const detailSource      = document.getElementById("detail-source");
    const detailTimestamp   = document.getElementById("detail-timestamp");

    const detailPrinterSelect  = document.getElementById("detail-printer-select");
    const detailPrinterRefresh = document.getElementById("detail-printer-refresh");
    const detailPrinterTest    = document.getElementById("detail-printer-test");
    const detailSelectedPrinterInfo = document.getElementById("detail-selected-printer-info");

    const detailConfigCopies       = document.getElementById("detail-config-copies");
    const detailConfigColor        = document.getElementById("detail-config-color");
    const detailConfigDuplex       = document.getElementById("detail-config-duplex");
    const detailConfigPageselect   = document.getElementById("detail-config-pageselect");
    const detailConfigPagerange    = document.getElementById("detail-config-pagerange");
    const detailCustomPagesGroup   = document.getElementById("detail-custom-pages-group");
    const detailConfigSize         = document.getElementById("detail-config-size");
    const detailConfigOrientation  = document.getElementById("detail-config-orientation");
    const detailConfigQuality      = document.getElementById("detail-config-quality");
    const detailConfigPagesPerSheet = document.getElementById("detail-config-pages-per-sheet");
    const detailConfigScaleType    = document.getElementById("detail-config-scale-type");
    const detailConfigScalePct     = document.getElementById("detail-config-scale-pct");

    const detailCostBw    = document.getElementById("detail-cost-bw");
    const detailCostColor = document.getElementById("detail-cost-color");
    const detailCostExtra = document.getElementById("detail-cost-extra");
    const detailCostGst   = document.getElementById("detail-cost-gst");
    const detailCostTotal = document.getElementById("detail-cost-total");

    const detailDocName              = document.getElementById("detail-doc-name");
    const detailDocMeta              = document.getElementById("detail-doc-meta");
    const detailPreviewCanvas        = document.getElementById("detail-preview-canvas");
    const detailPreviewPageIndicator = document.getElementById("detail-preview-page-indicator");
    const detailPreviewZoomIn        = document.getElementById("detail-preview-zoom-in");
    const detailPreviewZoomOut       = document.getElementById("detail-preview-zoom-out");

    const detailSpoolPrinterName    = document.getElementById("detail-spool-printer-name");
    const detailSpoolProgressLabel  = document.getElementById("detail-spool-progress-label");
    const detailSpoolProgressBar    = document.getElementById("detail-spool-progress-bar");

    const detailActionPrintNow      = document.getElementById("detail-action-print-now");
    const detailActionPreviewMain   = document.getElementById("detail-action-preview-main"); 
    const detailActionPause         = document.getElementById("detail-action-pause");
    const detailActionResume        = document.getElementById("detail-action-resume");
    const detailActionCancel        = document.getElementById("detail-action-cancel");
    const detailActionComplete      = document.getElementById("detail-action-complete");
    const detailActionReprint       = document.getElementById("detail-action-reprint");
    const detailActionDownload      = document.getElementById("detail-action-download");
    const detailActionSaveSettings  = document.getElementById("detail-action-save-settings");

    const clockDisplay = document.getElementById("date-time-clock");
    const sidebarProfileName = document.getElementById("sidebar-profile-name");
    const sidebarProfileRole = document.getElementById("sidebar-profile-role");
    const sidebarProfileAvatar = document.getElementById("sidebar-profile-avatar");

    const settingsStoreName = document.getElementById("settings-store-name");
    const settingsPhoneNumber = document.getElementById("settings-phone-number");
    const settingsEmail = document.getElementById("settings-email");
    const settingsDistrict = document.getElementById("settings-district");
    const settingsState = document.getElementById("settings-state");
    const settingsAddress = document.getElementById("settings-address");
    const settingsCacheFolder = document.getElementById("settings-cache-folder");
    const settingsSaveBtn = document.getElementById("settings-save-btn");

    const localUploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(localUploadDir)) fs.mkdirSync(localUploadDir, { recursive: true });

    // ==========================================
    // LOCAL FILE DOWNLOAD HELPER
    // ==========================================
    async function downloadFileLocally(url, fileName) {
        const safeName = path.basename(fileName || "document.pdf");
        const targetPath = path.join(localUploadDir, `${Date.now()}_${safeName}`);

        if (!url) return null;

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            const localSource = url.startsWith("file://") ? fileURLToPath(url) : url;

            if (fs.existsSync(localSource)) {
                fs.copyFileSync(localSource, targetPath);
                return targetPath;
            }

            return localSource;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch file from server: ${response.statusText}`);
        
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(targetPath, buffer);
        return targetPath;
    }

    async function cacheFilesLocally(files) {
        if (!Array.isArray(files) || files.length === 0) return [];

        const cachedFiles = [];

        for (const file of files) {
            const remoteUrl = file.url || api.getFileUrl(file.file_path) || file.file_path;
            const sourceName = getDisplayFileName(file);

            try {
                const localPath = await downloadFileLocally(remoteUrl, sourceName);
                cachedFiles.push({
                    ...file,
                    url: remoteUrl && remoteUrl.startsWith("http") ? remoteUrl : null,
                    original_name: file.original_name || sourceName,
                    local_path: localPath
                });
            } catch (err) {
                console.warn("Failed to cache file locally:", err.message);
                cachedFiles.push({
                    ...file,
                    url: remoteUrl && remoteUrl.startsWith("http") ? remoteUrl : null,
                    original_name: file.original_name || sourceName,
                    local_path: file.local_path || remoteUrl || null
                });
            }
        }

        return cachedFiles;
    }

    function getDisplayFileName(file = {}) {
        return file.file_name || file.original_name || path.basename(file.file_path || file.local_path || file.url || "document.pdf");
    }

    function resolvePreviewSource(file = {}) {
        if (file.local_path && fs.existsSync(file.local_path)) {
            return file.local_path;
        }

        const remoteUrl = file.url || api.getFileUrl(file.file_path) || file.file_path;
        if (remoteUrl && remoteUrl.startsWith("http")) {
            return remoteUrl;
        }

        if (remoteUrl && fs.existsSync(remoteUrl)) {
            return remoteUrl;
        }

        if (file.file_path && fs.existsSync(file.file_path)) {
            return file.file_path;
        }

        return file.local_path || remoteUrl || null;
    }

    function toRenderableUrl(source) {
        if (!source) return null;
        if (source.startsWith("http://") || source.startsWith("https://")) {
            return source;
        }
        const localPath = source.startsWith("file://") ? fileURLToPath(source) : source;
        return pathToFileURL(localPath).href;
    }

    function isImageFile(fileName = "") {
        return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
    }

    // ==========================================
    // INITIALIZATION & BOOTSTRAP
    // ==========================================
    async function init() {
        lucide.createIcons();
        bindAuthEvents();
        if (!api.isAuthenticated()) return showAuthScreen("login");
        await startApp();
    }

    async function startApp() {
        authContainer.style.display = "none";
        appContainer.style.display = "flex";

        updateClock();
        setInterval(updateClock, 1000);

        showToast("Loading print jobs...", "info");

        await loadProfileFromBackend();
        await loadOrdersFromBackend();
        await populatePrintersDropdown();
        await loadDashboardSummaryFromBackend();

        renderDashboard();
        renderQueueTable();
        updateCostCalculator();

        connectRealTimeSocket();
        bindEvents();
    }

    async function loadProfileFromBackend() {
        try {
            userProfile = await api.getProfile();
            applyProfileToUi();
        } catch (err) {
            console.warn("Failed to load profile:", err.message);
        }
    }

    async function loadDashboardSummaryFromBackend() {
        try {
            dashboardSummary = await api.getDashboardSummary();
        } catch (err) {
            console.warn("Failed to load dashboard summary:", err.message);
            dashboardSummary = null;
        }
    }

    function applyProfileToUi() {
        if (!userProfile) return;

        const displayName = userProfile.store_name || "Store User";
        const initials = displayName
            .split(" ")
            .filter(Boolean)
            .slice(0, 2)
            .map(x => x[0].toUpperCase())
            .join("") || "SU";

        if (sidebarProfileName) sidebarProfileName.textContent = displayName;
        if (sidebarProfileRole) sidebarProfileRole.textContent = userProfile.phone_number || "Operator";
        if (sidebarProfileAvatar) sidebarProfileAvatar.textContent = initials;

        if (settingsStoreName) settingsStoreName.value = userProfile.store_name || "";
        if (settingsPhoneNumber) settingsPhoneNumber.value = userProfile.phone_number || "";
        if (settingsEmail) settingsEmail.value = userProfile.email || "";
        if (settingsDistrict) settingsDistrict.value = userProfile.district || "";
        if (settingsState) settingsState.value = userProfile.state || "";
        if (settingsAddress) settingsAddress.value = userProfile.address || "";
        if (settingsCacheFolder) settingsCacheFolder.value = userProfile.cache_folder || "";
    }

    async function loadOrdersFromBackend() {
        try {
            const rawOrders = await api.getOrders();
            jobs = rawOrders.map(api.normalizeJob);
            jobs.forEach(job => recalculateJobCosts(job));
        } catch (err) {
            console.error("Failed to load orders:", err.message);
            showToast("Could not load jobs from server: " + err.message, "error");
            jobs = []; 
        }
    }

    function connectRealTimeSocket() {
        const storeId = api.getStoreId();
        if (!storeId) return;

        api.connectSocket(storeId, {
            onConnect: () => console.log("Real-time connection established for store", storeId),
            onNewJob: (data) => {
                const incoming = api.normalizeSocketJob(data);
                
                // Defensive array initialization
                if (!window.incomingJobs) window.incomingJobs = [];
                if (!incomingJobs) incomingJobs = [];

                if (!incomingJobs.some(j => j.jobId === incoming.jobId)) {
                    incomingJobs.unshift(incoming);
                }

                const rawJobData = data.rawData || data;
                const backendFiles = rawJobData.files || data.files || [];
                
                const normalized = api.normalizeJob({
                    job_id: rawJobData.jobId || rawJobData.job_id,
                    customer_name: rawJobData.customer_name || rawJobData.customerName,
                    sender_phone: rawJobData.senderPhone || rawJobData.sender_phone,
                    source: rawJobData.source || "whatsapp",
                    total_pages: rawJobData.totalPages || rawJobData.total_pages || 0,
                    file_count: backendFiles.length || rawJobData.fileCount || rawJobData.file_count || 1,
                    status: rawJobData.status || "pending",
                    cost_of_job: rawJobData.cost_of_job || rawJobData.costOfJob || 0,
                    created_at: rawJobData.createdAt || rawJobData.created_at || new Date().toISOString()
                });

                // Set secure fallback defaults so cost calculation never crashes
                normalized.settings = normalized.settings || {
                    printer: "",
                    copies: 1,
                    color: "bw",
                    duplex: "single",
                    pageselect: "all",
                    size: "a4",
                    orientation: "portrait",
                    quality: "standard"
                };

                if (backendFiles.length > 0) {
                    normalized.files = backendFiles.map(f => {
                        // The socket event may use localPath, filePath, file_path — resolve all
                        const rawPath = f.filePath || f.file_path || f.localPath || "";
                        return {
                            file_name: f.fileName || f.file_name || "document.pdf",
                            file_path: rawPath,
                            // Build HTTP URL so the frontend can fetch/preview the file
                            url: api.getFileUrl(rawPath) || rawPath,
                            pages: f.pages || 1,
                            file_type: f.fileType || f.file_type || "document"
                        };
                    });

                    // Set job-level file info from the first file for queue table display
                    normalized.fileName = normalized.files[0].file_name;
                    normalized.filePath = normalized.files[0].url || normalized.files[0].file_path;
                    normalized.fileType = normalized.files[0].file_type;
                    // Update total pages from actual files
                    normalized.pages = normalized.files.reduce((sum, f) => sum + (f.pages || 1), 0);

                    cacheFilesLocally(normalized.files).then((cachedFiles) => {
                        normalized.files = cachedFiles;
                        if (activeScreen === "dashboard") renderDashboard();
                        else if (activeScreen === "print-queue") renderQueueTable();
                    });
                }

                // Append safely before calculating
                if (!window.jobs) window.jobs = jobs || [];
                if (!jobs.some(j => j.id === normalized.id)) {
                    jobs.unshift(normalized);
                }

                recalculateJobCosts(normalized);
                dashboardSummary = null;

                if (activeScreen === "dashboard") renderDashboard();
                else if (activeScreen === "print-queue") renderQueueTable();
                
                showToast(`New file received from ${incoming.client}`, "success");
            },
            onJobUpdated: (data) => {
                const payload = data.rawData || data;
                const jobId = payload.jobId || payload.job_id;
                
                const existingJob = jobs.find(j => j.id === jobId);
                if (existingJob) {
                    const backendFiles = payload.files || data.files || [];
                    if (backendFiles.length > 0) {
                        const parsed = backendFiles.map(f => {
                            const rawPath = f.filePath || f.file_path || f.localPath || "";
                            return {
                                file_name: f.fileName || f.file_name || "document.pdf",
                                file_path: rawPath,
                                url: api.getFileUrl(rawPath) || rawPath,
                                pages: f.pages || 1,
                                file_type: f.fileType || f.file_type || "document"
                            };
                        });

                        // Dedupe by file_path so a job that already has files
                        // (e.g. loaded via the lazy REST fetch in openDetailsPanel,
                        // or from an earlier new-job/job-updated event) doesn't end
                        // up with the same file listed twice.
                        const existingPaths = new Set((existingJob.files || []).map(f => f.file_path));
                        const newFiles = parsed.filter(f => !existingPaths.has(f.file_path));

                        existingJob.files = [...(existingJob.files || []), ...newFiles];

                        cacheFilesLocally(newFiles).then((cachedFiles) => {
                            if (!cachedFiles.length) return;

                            const existingCachePaths = new Set((existingJob.files || []).map(f => f.file_path || f.local_path));
                            const mergedFiles = cachedFiles.filter(f => !existingCachePaths.has(f.file_path || f.local_path));
                            existingJob.files = [...(existingJob.files || []), ...mergedFiles];

                            if (activeScreen === "dashboard") renderDashboard();
                            else if (activeScreen === "print-queue") renderQueueTable();
                        });
                    }
                    existingJob.pages += (payload.addedPages || 0);
                    recalculateJobCosts(existingJob);
                    dashboardSummary = null;
                    
                    if (activeScreen === "dashboard") renderDashboard();
                    else if (activeScreen === "print-queue") renderQueueTable();
                    
                    if (detailsPanel.classList.contains("open") && selectedJobIds.includes(jobId)) openDetailsPanel();
                    showToast(`Additional file added to Customer Container`, "info");
                }
            },
            onDisconnect: (reason) => console.warn("Socket disconnected:", reason)
        });
    }

    function bindAuthEvents() {
        if (toggleToSignup) toggleToSignup.addEventListener("click", (e) => { e.preventDefault(); showAuthScreen("signup"); });
        if (toggleToLogin)  toggleToLogin.addEventListener("click",  (e) => { e.preventDefault(); showAuthScreen("login"); });

        if (loginForm) {
            loginForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                const phone    = document.getElementById("login-phone").value.trim();
                const password = document.getElementById("login-password").value;
                const btn      = loginForm.querySelector("button[type=submit]");
                if (!phone || !password) return showToast("Phone number and password are required.", "error");

                btn.textContent = "Signing in...";
                btn.disabled = true;
                try {
                    await api.login(phone, password);
                    btn.textContent = "Sign In";
                    btn.disabled = false;
                    await startApp();
                } catch (err) {
                    btn.textContent = "Sign In";
                    btn.disabled = false;
                    showToast(err.message || "Login failed.", "error");
                }
            });
        }

        if (signupForm) {
            signupForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                const name     = document.getElementById("signup-name")?.value.trim();
                const phone    = document.getElementById("signup-phone")?.value.trim();
                const password = document.getElementById("signup-password")?.value;
                const btn      = signupForm.querySelector("button[type=submit]");

                if (!name || !phone || !password) {
                    return showToast("Store name, phone number, and password are required.", "error");
                }
                if (password.length < 6) {
                    return showToast("Password must be at least 6 characters.", "error");
                }

                btn.textContent = "Creating account...";
                btn.disabled = true;
                try {
                    await api.signup(name, phone, password);
                    btn.textContent = "Sign Up";
                    btn.disabled = false;
                    await startApp();
                } catch (err) {
                    btn.textContent = "Sign Up";
                    btn.disabled = false;
                    showToast(err.message || "Signup failed.", "error");
                }
            });
        }
    }

    function showAuthScreen(type) {
        document.getElementById("login-section").style.display  = type === "login"  ? "block" : "none";
        document.getElementById("signup-section").style.display = type === "signup" ? "block" : "none";
    }

    function updateClock() {
        const now = new Date();
        let hours = now.getHours();
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12 || 12;
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        if (clockDisplay) clockDisplay.textContent = `${hours}:${minutes} ${ampm} - ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    }

    function showToast(message, type = "info") {
        let toastContainer = document.getElementById("pf-toast-container");
        if (!toastContainer) {
            toastContainer = document.createElement("div");
            toastContainer.id = "pf-toast-container";
            toastContainer.style.cssText = `position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 8px;`;
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement("div");
        const bgColor = type === "error" ? "#EF4444" : type === "success" ? "#22C55E" : "#3B82F6";
        toast.style.cssText = `background: ${bgColor}; color: white; padding: 12px 16px; border-radius: 6px; font-size: 13px; max-width: 320px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); animation: pf-slide-in 0.2s ease;`;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transition = "opacity 0.3s";
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // ==========================================
    // EVENT BINDINGS
    // ==========================================
    function bindEvents() {
        sidebarToggle.addEventListener("click", toggleSidebar);

        navItems.forEach(item => {
            item.addEventListener("click", (e) => {
                e.preventDefault();
                switchScreen(item.getAttribute("data-screen"));
            });
        });

        detailsCloseBtn.addEventListener("click", closeDetailsPanel);

        detailPrinterRefresh.addEventListener("click", async () => {
            detailPrinterRefresh.classList.add("loading");
            await populatePrintersDropdown();
            updateSelectedPrinterBox();
            detailPrinterRefresh.classList.remove("loading");
            showToast("Printers refreshed.", "success");
        });

        detailPrinterSelect.addEventListener("change", () => {
            selectedJobIds.forEach(id => {
                const job = jobs.find(j => j.id === id);
                if (job) { job.settings.printer = detailPrinterSelect.value; recalculateJobCosts(job); }
            });
            updateSelectedPrinterBox();
            if (selectedJobIds.length === 1) recalculatePanelCosts(jobs.find(j => j.id === selectedJobIds[0]));
        });

        const printConfigInputs = [
            detailConfigCopies, detailConfigColor, detailConfigDuplex, detailConfigPageselect,
            detailConfigPagerange, detailConfigSize, detailConfigOrientation, detailConfigQuality,
            detailConfigPagesPerSheet, detailConfigScaleType, detailConfigScalePct
        ];

        printConfigInputs.forEach(input => {
            if (!input) return;
            input.addEventListener("input", () => {
                if (detailConfigPageselect && detailCustomPagesGroup) {
                    detailCustomPagesGroup.style.display = detailConfigPageselect.value === "custom" ? "block" : "none";
                }
                if (detailConfigScaleType && detailConfigScalePct) {
                    detailConfigScalePct.style.display   = detailConfigScaleType.value === "custom" ? "block" : "none";
                }
                
                savePanelInputsToJob();
                if (selectedJobIds.length === 1) recalculatePanelCosts(jobs.find(j => j.id === selectedJobIds[0]));
                applyLivePreviewFilters();
            });
        });

        if (detailPreviewZoomIn) {
            detailPreviewZoomIn.addEventListener("click", () => {
                if (drawerPreviewState.zoom < 250) drawerPreviewState.zoom += 15;
                applyLivePreviewFilters();
            });
        }
        if (detailPreviewZoomOut) {
            detailPreviewZoomOut.addEventListener("click", () => {
                if (drawerPreviewState.zoom > 30) drawerPreviewState.zoom -= 15;
                applyLivePreviewFilters();
            });
        }

        detailActionPrintNow.addEventListener("click", dispatchActiveJobSpooler);
        detailActionSaveSettings.addEventListener("click", async () => {
            savePanelInputsToJob();
            renderQueueTable();
            showToast(`Settings saved for ${selectedJobIds.length} item(s).`, "success");
        });
        
        if (detailActionPreviewMain) {
            detailActionPreviewMain.addEventListener("click", () => {
                if (!activePreviewFile.url) return showToast("No file loaded to preview.", "error");
                
                switchScreen("files");
                closeDetailsPanel();
                
                const previewCard = document.getElementById("preview-document-card");
                const activeName = document.getElementById("preview-active-filename");
                const loadingOverlay = document.getElementById("preview-loading-overlay");
                
                if (activeName) activeName.textContent = activePreviewFile.name || "Document";
                
                if (previewCard) {
                    const src = activePreviewFile.url.startsWith("http")
                        ? activePreviewFile.url
                        : `file:///${activePreviewFile.url.replace(/\\/g, "/")}`;
                    
                    previewCard.innerHTML = `<iframe src="${src}#toolbar=1&navpanes=0" style="width: 100%; height: calc(100vh - 200px); border: none; border-radius: 8px; background: white;"></iframe>`;
                }
                if (loadingOverlay) loadingOverlay.style.display = "none";
            });
        }

        const searchInput = document.getElementById("queue-search-input");
        if (searchInput) searchInput.addEventListener("input", renderQueueTable);

        document.getElementById("logout-btn")?.addEventListener("click", () => {
            api.logout();
            location.reload();
        });

        if (settingsSaveBtn) {
            settingsSaveBtn.addEventListener("click", async () => {
                try {
                    settingsSaveBtn.disabled = true;
                    const updatedProfile = await api.updateProfile({
                        store_name: settingsStoreName?.value?.trim() || "",
                        email: settingsEmail?.value?.trim() || "",
                        district: settingsDistrict?.value?.trim() || "",
                        state: settingsState?.value?.trim() || "",
                        address: settingsAddress?.value?.trim() || "",
                        cache_folder: settingsCacheFolder?.value?.trim() || ""
                    });

                    userProfile = updatedProfile;
                    applyProfileToUi();
                    showToast("Profile updated successfully.", "success");
                } catch (err) {
                    showToast(err.message || "Failed to update profile.", "error");
                } finally {
                    settingsSaveBtn.disabled = false;
                }
            });
        }
    }

    function toggleSidebar() {
        sidebarCollapsed = !sidebarCollapsed;
        sidebar.classList.toggle("collapsed", sidebarCollapsed);
        lucide.createIcons();
    }

    function switchScreen(screenId) {
        activeScreen = screenId;
        navItems.forEach(item => {
            item.classList.toggle("active", item.getAttribute("data-screen") === screenId);
        });
        screens.forEach(screen => {
            screen.classList.toggle("active", screen.getAttribute("id") === `screen-${screenId}`);
        });
        if (screenId === "dashboard") {
            loadDashboardSummaryFromBackend().finally(() => renderDashboard());
        } else if (screenId === "print-queue") {
            renderQueueTable();
        } else if (screenId === "settings") {
            applyProfileToUi();
        }
    }

    // ==========================================
    // GLOBAL CONTAINER SELECTION HANDLERS
    // ==========================================
    window.togglePhoneCard = function(phone) {
        expandedPhoneCards[phone] = !expandedPhoneCards[phone];
        renderQueueTable();
    };

    window.selectSpecificJob = function(jobId) {
        if (!selectedJobIds.includes(jobId)) selectedJobIds.push(jobId);
        else selectedJobIds = selectedJobIds.filter(id => id !== jobId);
        
        renderQueueTable();
        selectedJobIds.length > 0 ? openDetailsPanel() : closeDetailsPanel();
    };

    window.quickClearJobs = async function(jobIdsString) {
        const idsToClear = jobIdsString.split(',');
        if (idsToClear.length === 0) return;

        const btn = document.querySelector("#quick-clear-container button");
        if (btn) {
            btn.textContent = "Processing...";
            btn.style.opacity = "0.7";
            btn.disabled = true;
        }

        selectedJobIds = idsToClear;
        for (const id of idsToClear) {
            const job = jobs.find(j => j.id === id);
            if (job) job.payment_status = "paid";
        }

        await dispatchActiveJobSpooler();
        
        const searchInput = document.getElementById("queue-search-input");
        if (searchInput) searchInput.value = "";
        
        selectedJobIds = [];
        renderQueueTable();
        showToast(`Payment collected and files sent to printer.`, "success");
    };


    async function populatePrintersDropdown() {
        try {
            printers = await ipcRenderer.invoke("get-printers");
            if (!printers || printers.length === 0) {
                detailPrinterSelect.innerHTML = `<option disabled selected>No printers found on OS</option>`;
                return;
            }
            detailPrinterSelect.innerHTML = printers
                .map(p => `<option value="${p.name}">${p.name}${p.isDefault ? " (Default)" : ""}</option>`)
                .join("");
        } catch (error) {
            console.error("get-printers IPC error:", error);
            detailPrinterSelect.innerHTML = `<option disabled selected>Error loading printers</option>`;
        }
    }

    function updateSelectedPrinterBox() {
        const p = printers.find(x => x.name === detailPrinterSelect.value);
        if (p && detailSpoolPrinterName) detailSpoolPrinterName.textContent = p.name;
    }

    function renderDashboard() {
        const fallback = {
            total: jobs.length,
            pending: jobs.filter(j => j.status === "pending").length,
            printing: jobs.filter(j => j.status === "printing").length,
            completed: jobs.filter(j => j.status === "completed").length,
            revenue: jobs.reduce((sum, j) => {
                const serverCost = (j._raw && typeof j._raw.cost_of_job === "number") ? j._raw.cost_of_job : 0;
                return sum + serverCost;
            }, 0),
            queueLoad: jobs.length > 0 ? Math.round((jobs.filter(j => j.status === "pending").length / jobs.length) * 100) : 0,
            incomingJobs: jobs.slice(0, 5).map(j => ({
                job_id: j.id,
                customer_name: j.customer,
                sender_phone: j.phone,
                total_pages: j.pages,
                file_count: (j.files && j.files.length) || 1,
                source: j.source,
                created_at: j._raw?.created_at || new Date().toISOString()
            })),
            recentActivity: jobs.slice(0, 8).map(j => ({
                job_id: j.id,
                status: j.status,
                customer_name: j.customer,
                sender_phone: j.phone,
                updated_at: j._raw?.updated_at || j._raw?.created_at || new Date().toISOString()
            }))
        };

        const data = dashboardSummary || fallback;

        const statTotal = document.getElementById("stat-total-orders");
        const statPending = document.getElementById("stat-pending-jobs");
        const statPrinting = document.getElementById("stat-printing-jobs");
        const statCompleted = document.getElementById("stat-completed-jobs");
        const statRevenue = document.getElementById("stat-revenue-today");
        const queueLoadLabel = document.getElementById("sys-queue-load");
        const queueLoadBar = document.querySelector(".status-bar-fill.warning");
        const incomingCount = document.getElementById("incoming-jobs-count");

        if (statTotal) statTotal.textContent = Number(data.total || 0);
        if (statPending) statPending.textContent = Number(data.pending || 0);
        if (statPrinting) statPrinting.textContent = Number(data.printing || 0);
        if (statCompleted) statCompleted.textContent = Number(data.completed || 0);
        if (statRevenue) statRevenue.textContent = `₹${Number(data.revenue || 0).toFixed(2)}`;

        const queueLoad = Number(data.queueLoad || 0);
        if (queueLoadLabel) queueLoadLabel.textContent = `${queueLoad}%`;
        if (queueLoadBar) queueLoadBar.style.width = `${queueLoad}%`;

        if (incomingCount) incomingCount.textContent = `${(data.incomingJobs || []).length} New Jobs`;

        renderDashboardIncomingJobs(data.incomingJobs || []);
        renderDashboardActivity(data.recentActivity || []);
        renderDashboardPrinters();
    }

    function renderDashboardIncomingJobs(list) {
        const incomingList = document.getElementById("incoming-jobs-list");
        if (!incomingList) return;

        if (!list.length) {
            incomingList.innerHTML = `<div style="color:#94A3B8;font-size:13px;padding:8px;">No incoming jobs yet.</div>`;
            return;
        }

        incomingList.innerHTML = list.map(item => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,0.15);">
                <div style="display:flex;flex-direction:column;gap:3px;">
                    <span style="font-size:13px;font-weight:600;color:#E2E8F0;">${item.customer_name || item.sender_phone || "Customer"}</span>
                    <span style="font-size:11px;color:#94A3B8;">${item.file_count || 0} files • ${item.total_pages || 0} pages</span>
                </div>
                <span style="font-size:11px;color:#64748B;">${new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
        `).join("");
    }

    function renderDashboardActivity(list) {
        const activityFeed = document.getElementById("dashboard-activity-feed");
        if (!activityFeed) return;

        if (!list.length) {
            activityFeed.innerHTML = `<div style="color:#94A3B8;font-size:13px;padding:8px;">No recent activity.</div>`;
            return;
        }

        activityFeed.innerHTML = list.map(item => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(148,163,184,0.12);">
                <span style="font-size:12px;color:#CBD5E1;">Job ${item.job_id} moved to ${String(item.status || "pending").toUpperCase()}</span>
                <span style="font-size:11px;color:#64748B;">${new Date(item.updated_at || item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
        `).join("");
    }

    function renderDashboardPrinters() {
        const printersList = document.getElementById("dashboard-printers-list");
        if (!printersList) return;

        if (!printers.length) {
            printersList.innerHTML = `<span style="font-size:12px;color:#94A3B8;">No printers detected</span>`;
            return;
        }

        printersList.innerHTML = printers.map(p => `
            <div style="display:flex;justify-content:space-between;align-items:center;background:#0F172A;padding:8px 10px;border:1px solid #334155;border-radius:8px;">
                <span style="font-size:12px;color:#E2E8F0;">${p.name}</span>
                <span style="font-size:11px;color:${p.status === 0 ? "#22C55E" : "#F59E0B"};">${p.status === 0 ? "Ready" : "Busy"}${p.isDefault ? " • Default" : ""}</span>
            </div>
        `).join("");
    }

    // ==========================================
    // PHONE CONTAINER CARD RENDER LOGIC
    // ==========================================
    function renderQueueTable() {
        const tableContainer = document.querySelector(".data-table-container");
        if (!tableContainer) return;

        const searchVal = (document.getElementById("queue-search-input")?.value || "").trim().toLowerCase();

        let quickClearContainer = document.getElementById("quick-clear-container");
        if (!quickClearContainer) {
            quickClearContainer = document.createElement("div");
            quickClearContainer.id = "quick-clear-container";
            quickClearContainer.style.marginBottom = "16px";
            tableContainer.parentNode.insertBefore(quickClearContainer, tableContainer);
        }
        
        const filteredJobs = jobs.filter(job =>
            job.status !== "completed" && 
            (job.customer.toLowerCase().includes(searchVal) ||
            job.phone.toLowerCase().includes(searchVal) ||
            job.id.toLowerCase().includes(searchVal) ||
            (job.fileName || "").toLowerCase().includes(searchVal))
        );

        if (searchVal.length > 2) {
            const unpaidJobs = filteredJobs.filter(j => j.payment_status === "unpaid" || !j.payment_status);
            if (unpaidJobs.length > 0) {
                const grandTotal = unpaidJobs.reduce((sum, j) => sum + (j.amount || 0), 0);
                const unpaidIds = unpaidJobs.map(j => j.id).join(',');
                quickClearContainer.style.display = "flex";
                quickClearContainer.innerHTML = `
                    <div style="width: 100%; background: #059669; border-radius: 8px; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <div style="color: white;">
                            <span style="font-weight: 700; font-size: 16px;">${unpaidJobs.length} Unpaid Order(s) Found</span>
                            <span style="display: block; font-size: 12px; opacity: 0.9;">Clicking below will mark them paid and send them to the printer.</span>
                        </div>
                        <button onclick="window.quickClearJobs('${unpaidIds}')" style="background: white; color: #059669; border: none; padding: 10px 24px; border-radius: 6px; font-weight: 700; font-size: 16px; cursor: pointer;">
                            Collect ₹${grandTotal.toFixed(2)} & Print All
                        </button>
                    </div>
                `;
            } else {
                quickClearContainer.style.display = "none";
            }
        } else {
            quickClearContainer.style.display = "none";
        }

        if (filteredJobs.length === 0) {
            tableContainer.innerHTML = `<div style="text-align:center;padding:60px 0;color:#64748B;font-size:15px;background:#1E293B;border-radius:12px;border:1px dashed #334155;">No active print files in queue</div>`;
            return;
        }

        const groupedByPhone = {};
        filteredJobs.forEach(job => {
            const phoneKey = job.phone || "Unknown";
            if (!groupedByPhone[phoneKey]) {
                groupedByPhone[phoneKey] = {
                    phone: phoneKey,
                    customer: job.customer,
                    jobs: [],
                    totalAmount: 0
                };
            }
            groupedByPhone[phoneKey].jobs.push(job);
            groupedByPhone[phoneKey].totalAmount += (job.amount || 0);
        });

        let html = `<div style="display:flex; flex-direction:column; gap:16px;">`;

        Object.values(groupedByPhone).forEach(group => {
            const isExpanded = expandedPhoneCards[group.phone];

            let totalFiles = 0;
            let totalPages = 0;
            group.jobs.forEach(j => {
                const files = (j.files && j.files.length > 0) ? j.files : [{pages: j.pages}];
                totalFiles += files.length;
                files.forEach(f => totalPages += (f.pages || 1));
            });

            const groupJobIds = group.jobs.map(j => j.id);
            const hasSelection = groupJobIds.some(id => selectedJobIds.includes(id));
            const borderStyle = hasSelection ? "border: 2px solid #3B82F6;" : "border: 1px solid #334155;";

            html += `
                <div class="phone-card" style="background: #1E293B; border-radius: 12px; ${borderStyle} overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: all 0.2s ease;">
                    <div style="padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background 0.2s;" onclick="window.togglePhoneCard('${group.phone}')" onmouseover="this.style.background='#1e293b'" onmouseout="this.style.background='transparent'">
                        <div style="display: flex; align-items: center; gap: 16px;">
                            <div style="background: #0F172A; width: 48px; height: 48px; border-radius: 12px; border: 1px solid #334155; display: flex; align-items: center; justify-content: center;">
                                <i data-lucide="folder-open" style="color: #3B82F6; width: 24px; height: 24px;"></i>
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 4px;">
                                <span style="font-weight: 700; font-size: 16px; color: #F8FAFC; letter-spacing: 0.5px;">${group.phone}</span>
                                <span style="font-size: 13px; color: #94A3B8;">${group.customer} • ${totalFiles} Document(s) • ${totalPages} Pages</span>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 24px;">
                            <div style="text-align: right;">
                                <div style="font-size: 12px; color: #94A3B8; margin-bottom: 2px;">Pending Total</div>
                                <div style="font-size: 16px; font-weight: 800; color: #10B981;">₹${group.totalAmount.toFixed(2)}</div>
                            </div>
                            <div style="background: #0F172A; padding: 6px; border-radius: 6px; border: 1px solid #334155;">
                                <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" style="color: #94A3B8; width: 18px; height: 18px;"></i>
                            </div>
                        </div>
                    </div>

                    <div style="display: ${isExpanded ? 'block' : 'none'}; padding: 0 20px 20px 20px; background: #0F172A; border-top: 1px solid #334155;">
                        <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 10px;">
            `;

            group.jobs.forEach(job => {
                const isJobSelected = selectedJobIds.includes(job.id);
                const filesToRender = (job.files && job.files.length > 0) ? job.files : [{ file_name: job.fileName, pages: job.pages }];

                filesToRender.forEach((file) => {
                    let tagHtml = "";
                    if (job.status === "printing") {
                        tagHtml = `<span style="background: rgba(234, 179, 8, 0.2); color: #FDE047; border: 1px solid #CA8A04; padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px;">PRINTING...</span>`;
                    } else {
                        tagHtml = `<span style="background: rgba(16, 185, 129, 0.2); color: #6EE7B7; border: 1px solid #059669; padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px;">NEW</span>`;
                    }

                    html += `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #1E293B; border-radius: 8px; border: 1px solid ${isJobSelected ? '#3B82F6' : '#334155'}; cursor: pointer; transition: all 0.2s;" onclick="window.selectSpecificJob('${job.id}'); event.stopPropagation();" onmouseover="this.style.borderColor='#475569'" onmouseout="this.style.borderColor='${isJobSelected ? '#3B82F6' : '#334155'}'">
                            
                            <div style="display: flex; align-items: center; gap: 16px; flex: 1; overflow: hidden;">
                                <div style="width: 20px; height: 20px; border-radius: 4px; border: 2px solid ${isJobSelected ? '#3B82F6' : '#475569'}; background: ${isJobSelected ? '#3B82F6' : 'transparent'}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                                    ${isJobSelected ? '<i data-lucide="check" style="color: white; width: 14px; height: 14px;"></i>' : ''}
                                </div>
                                <div style="display: flex; flex-direction: column; overflow: hidden;">
                                    <span style="font-size: 14px; font-weight: 600; color: #E2E8F0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px;">${file.file_name || "Document"}</span>
                                    <span style="font-size: 12px; color: #94A3B8; display: flex; align-items: center; gap: 6px;">
                                        <i data-lucide="file-text" style="width: 12px; height: 12px;"></i> ${file.pages || 1} Pages • ${job.time}
                                    </span>
                                </div>
                            </div>
                            
                            <div style="flex-shrink: 0; margin-left: 16px; display: flex; align-items: center; gap: 12px;">
                                ${tagHtml}
                                <button class="btn-secondary" style="height: 32px; font-size: 12px; padding: 0 12px; border-color: ${isJobSelected ? '#3B82F6' : '#334155'};" onclick="window.selectSpecificJob('${job.id}'); event.stopPropagation();">
                                    ${isJobSelected ? 'Settings Open' : 'Print Options'}
                                </button>
                            </div>
                        </div>
                    `;
                });
            });

            html += `
                        </div>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        tableContainer.innerHTML = html;
        lucide.createIcons();
    }

    async function dispatchActiveJobSpooler() {
        if (selectedJobIds.length === 0) return;
        const printerName = detailPrinterSelect.value;
        if (!printerName) return showToast("No valid printer selected.", "error");

        savePanelInputsToJob();
        detailActionPrintNow.disabled = true;

        for (const id of selectedJobIds) {
            const activeJob = jobs.find(j => j.id === id);
            if (!activeJob || activeJob.status === "completed") continue;

            let filesToPrint = [];

            if (selectedJobIds.length === 1 && detailsPanel.classList.contains("open")) {
                const checkboxes = document.querySelectorAll(".job-file-checkbox");
                if (checkboxes.length > 0) {
                    checkboxes.forEach(cb => {
                        if (cb.checked) {
                            const idx = parseInt(cb.getAttribute("data-idx"));
                            if (activeJob.files && activeJob.files[idx]) filesToPrint.push(activeJob.files[idx]);
                        }
                    });
                } else if (activeJob.files && activeJob.files.length > 0) filesToPrint = activeJob.files;
            } else {
                if (activeJob.files && activeJob.files.length > 0) filesToPrint = activeJob.files;
            }

            if (filesToPrint.length === 0 && activeJob.filePath) {
                 filesToPrint = [{ file_name: activeJob.fileName, file_path: activeJob.filePath, url: activeJob.filePath }];
            }

            if (filesToPrint.length === 0) continue;

            activeJob.status = "printing";
            try { await api.updateStatus(id, "printing"); } catch (_) {}
            renderQueueTable();

            for (let i = 0; i < filesToPrint.length; i++) {
                const fileObj = filesToPrint[i];
                if (detailSpoolProgressLabel) detailSpoolProgressLabel.textContent = `Downloading file ${i + 1}...`;
                
                let targetPrintPath = fileObj.url || api.getFileUrl(fileObj.file_path) || fileObj.file_path;

                if (targetPrintPath && targetPrintPath.startsWith("http")) {
                    try {
                        targetPrintPath = await downloadFileLocally(targetPrintPath, fileObj.file_name || "document.pdf");
                        fileObj.local_path = targetPrintPath; 
                    } catch (downloadErr) {
                        continue; 
                    }
                } else if (fileObj.local_path) {
                    targetPrintPath = fileObj.local_path;
                }

                if (targetPrintPath && !targetPrintPath.startsWith("http")) {
                    targetPrintPath = path.resolve(targetPrintPath);
                    if (!fs.existsSync(targetPrintPath)) continue;
                }

                if (detailSpoolProgressLabel) detailSpoolProgressLabel.textContent = `Spooling file ${i + 1} to printer...`;
                
                if (targetPrintPath) {
                    try {
                        await ipcRenderer.invoke("print-job", {
                            filePath: targetPrintPath,
                            printerName,
                            copies: parseInt(activeJob.settings.copies),
                            duplex: activeJob.settings.duplex,
                            color: activeJob.settings.color
                        });
                    } catch (err) {
                        console.error("Print IPC error:", err);
                    }
                }
            } 
            activeJob.status = "completed";
            try { await api.updateStatus(id, "completed"); } catch (_) {}
        }

        if (detailSpoolProgressLabel) detailSpoolProgressLabel.textContent = "Batch Spooling Finished";
        if (detailSpoolProgressBar) detailSpoolProgressBar.style.width = "100%";
        detailActionPrintNow.disabled = false;

        selectedJobIds = []; 
        dashboardSummary = null;
        renderQueueTable();
        renderDashboard();
        closeDetailsPanel();
    }

    // ==========================================
    // DETAILS PANEL
    // ==========================================
    function openDetailsPanel() {
        if (selectedJobIds.length === 0) return closeDetailsPanel();
        const primaryJob = jobs.find(j => j.id === selectedJobIds[0]);
        if (!primaryJob) return;

        if (selectedJobIds.length > 1) {
            const selectedJobs = selectedJobIds.map(id => jobs.find(j => j.id === id)).filter(Boolean);
            const uniquePhones = [...new Set(selectedJobs.map(j => j.phone))];
            const isSameCustomer = uniquePhones.length === 1;

            detailJobId.textContent = `Batch Edit (${selectedJobIds.length} Orders)`;
            
            if (isSameCustomer) {
                detailCustomerName.textContent = selectedJobs[0].customer;
                detailPhoneNumber.textContent  = uniquePhones[0];
            } else {
                detailCustomerName.textContent = "Multiple Customers";
                detailPhoneNumber.textContent  = "---";
            }

            detailDocName.textContent      = "Multiple Orders Selected";
            detailDocMeta.textContent      = "Mixed Formats";
            detailStatusBadge.textContent  = "BATCH MODE";
            detailStatusBadge.className    = "status-badge pending";
            
            const grandTotal = selectedJobs.reduce((sum, j) => sum + (j.amount || 0), 0);
            detailCostTotal.textContent    = `₹${grandTotal.toFixed(2)}`;
            
            const fileListContainer = document.getElementById("dynamic-file-selection-list");
            if (fileListContainer) fileListContainer.style.display = "none";
            
        } else {
            detailJobId.textContent        = `Job #${primaryJob.id}`;
            detailCustomerName.textContent = primaryJob.customer;
            detailPhoneNumber.textContent  = primaryJob.phone;
            detailTimestamp.textContent    = primaryJob.time;
            detailStatusBadge.textContent  = primaryJob.status.toUpperCase();
            detailStatusBadge.className    = `status-badge ${primaryJob.status}`;
            detailSource.textContent       = primaryJob.source;
            detailSource.className         = `source-badge ${primaryJob.source}`;
            detailDocMeta.textContent      = `Total Pages: ${primaryJob.pages}`;
            recalculatePanelCosts(primaryJob);
        }

        detailPrinterSelect.value = primaryJob.settings.printer || (printers.length > 0 ? printers[0].name : "");
        updateSelectedPrinterBox();
        detailConfigCopies.value      = primaryJob.settings.copies;
        detailConfigColor.value       = primaryJob.settings.color;
        detailConfigDuplex.value      = primaryJob.settings.duplex;
        detailConfigPageselect.value  = primaryJob.settings.pageselect;
        detailConfigSize.value        = primaryJob.settings.size;
        detailConfigOrientation.value = primaryJob.settings.orientation;
        detailConfigQuality.value     = primaryJob.settings.quality;

        detailsPanel.classList.add("open");

        if (selectedJobIds.length === 1) {
            if (!primaryJob.files || primaryJob.files.length === 0) {
                if (primaryJob.id && !primaryJob.id.startsWith("LOCAL-")) {
                    api.getJobFiles(primaryJob.id).then(files => {
                        if (files.length > 0) {
                            primaryJob.files = files.map(f => ({
                                ...f,
                                url: api.getFileUrl(f.file_path),
                                original_name: f.file_name
                            }));

                            cacheFilesLocally(primaryJob.files).then((cachedFiles) => {
                                primaryJob.files = cachedFiles;
                                renderFileListUI(primaryJob);
                                renderPanelPreviewCanvas(primaryJob, 0);
                            });
                            
                            primaryJob.fileName = getDisplayFileName(files[0]);
                            primaryJob.filePath = primaryJob.files[0].url;
                            primaryJob.fileType = files[0].file_type || "document";
                            
                            detailDocName.textContent = `${files.length} File(s) Attached`;
                            renderFileListUI(primaryJob);
                            renderPanelPreviewCanvas(primaryJob, 0); 
                        } else {
                             detailDocName.textContent = getDisplayFileName(primaryJob);
                             renderPanelPreviewCanvas(primaryJob);
                        }
                    }).catch(() => {});
                }
            } else {
                detailDocName.textContent = `${primaryJob.files.length} File(s) Attached`;
                renderFileListUI(primaryJob);
                renderPanelPreviewCanvas(primaryJob, 0);
            }
        }
        
        lucide.createIcons();
    }

    function renderFileListUI(job) {
        const containerId = "dynamic-file-selection-list";
        let container = document.getElementById(containerId);

        if (!container && detailPreviewCanvas) {
            container = document.createElement("div");
            container.id = containerId;
            container.style.cssText = "margin-top: 12px; margin-bottom: 12px; max-height: 140px; overflow-y: auto; background: rgba(0,0,0,0.1); border: 1px solid #334155; border-radius: 6px; padding: 6px;";
            detailPreviewCanvas.parentElement.insertBefore(container, detailPreviewCanvas);
        }

        if (!container || !job.files || job.files.length === 0) return;

        container.style.display = "block";
        container.innerHTML = job.files.map((file, idx) => `
            <div class="job-file-item" style="display: flex; align-items: center; padding: 6px 8px; gap: 8px; cursor: pointer; border-radius: 4px; transition: background 0.2s;" onmouseover="this.style.background='#334155'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" class="job-file-checkbox" data-idx="${idx}" checked style="cursor:pointer;" onclick="event.stopPropagation()">
                <div onclick="window.previewSpecificFile('${job.id}', ${idx})" style="flex:1; display:flex; align-items:center; overflow:hidden;">
                    <i data-lucide="file-text" style="width:14px; height:14px; margin-right:6px; color:#94A3B8;"></i>
                    <span title="${getDisplayFileName(file)}" style="font-size: 13px; color: #E2E8F0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${getDisplayFileName(file)}</span>
                </div>
                <span style="font-size: 11px; color: #64748B; font-weight:600;">${file.pages || 1}p</span>
            </div>
        `).join('');

        lucide.createIcons();
    }

    window.previewSpecificFile = function(jobId, idx) {
        const job = jobs.find(j => j.id === jobId);
        if (!job || !job.files || !job.files[idx]) return;
        renderPanelPreviewCanvas(job, idx);
    };

    function renderPanelPreviewCanvas(primaryJob, fileIndex = 0) {
        if (!detailPreviewCanvas || !primaryJob) return;

        let fileUrl = primaryJob.filePath;
        let fileName = primaryJob.fileName || getDisplayFileName(primaryJob);

        if (primaryJob.files && primaryJob.files[fileIndex]) {
            const activeFile = primaryJob.files[fileIndex];
            fileUrl = resolvePreviewSource(activeFile);
            fileName = getDisplayFileName(activeFile);
        }
        
        activePreviewFile = { name: fileName, url: fileUrl };

        if (detailPreviewPageIndicator) detailPreviewPageIndicator.textContent = `Previewing: ${fileName}`;

        if (fileUrl) {
            const src = toRenderableUrl(fileUrl);
            if (isImageFile(fileName)) {
                detailPreviewCanvas.innerHTML = `<img src="${src}" alt="${fileName}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;background:white;" />`;
            } else {
                detailPreviewCanvas.innerHTML = `<iframe src="${src}#toolbar=0&navpanes=0"></iframe>`;
            }
        } else {
            detailPreviewCanvas.innerHTML = `
                <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#64748B;font-size:13px;flex-direction:column;gap:8px;">
                    <i data-lucide="file" style="width:32px;height:32px;"></i>
                    <span>File preview unavailable</span>
                </div>`;
            lucide.createIcons();
        }
        
        applyLivePreviewFilters();
    }

    // ==============================================================
    // LIVE VISUAL EDIT ENGINE (CSS Hardware Acceleration)
    // ==============================================================
    function applyLivePreviewFilters() {
        const iframe = detailPreviewCanvas?.querySelector("iframe");
        if (!iframe) return;

        const colorMode = document.getElementById("detail-config-color")?.value || "color";
        const qualityMode = document.getElementById("detail-config-quality")?.value || "standard";
        
        let filterString = "none";
        
        if (colorMode === "bw") {
            filterString = "grayscale(100%) contrast(1.15) brightness(1.05)";
        } else {
            filterString = "contrast(1) brightness(1)";
        }

        if (qualityMode === "draft") {
            filterString += " opacity(0.85) blur(0.3px)";
        } else if (qualityMode === "high") {
            filterString += " contrast(1.1) saturate(1.1)";
        }
        
        iframe.style.filter = filterString;

        let scale = drawerPreviewState.zoom / 100;

        const scaleType = document.getElementById("detail-config-scale-type")?.value;
        if (scaleType === "custom") {
            const customPct = parseInt(document.getElementById("detail-config-scale-pct")?.value) || 100;
            scale *= (customPct / 100);
        }

        const orientation = document.getElementById("detail-config-orientation")?.value || "portrait";
        const rotateDeg = orientation === "landscape" ? -90 : 0;

        const paperSize = document.getElementById("detail-config-size")?.value || "a4";
        
        if (paperSize === "a3") {
            iframe.style.aspectRatio = "1 / 1.414";
            scale *= 1.15;
        } else if (paperSize === "letter") {
            iframe.style.aspectRatio = "8.5 / 11";
        } else if (paperSize === "legal") {
            iframe.style.aspectRatio = "8.5 / 14";
        } else {
            iframe.style.aspectRatio = "1 / 1.414";
        }

        iframe.style.transform = `scale(${scale}) rotate(${rotateDeg}deg)`;
        iframe.style.transformOrigin = "center center";
    }

    function savePanelInputsToJob() {
        selectedJobIds.forEach(id => {
            const job = jobs.find(j => j.id === id);
            if (!job) return;
            job.settings.printer     = detailPrinterSelect.value;
            job.settings.copies      = parseInt(detailConfigCopies.value) || 1;
            job.settings.color       = detailConfigColor.value;
            job.settings.duplex      = detailConfigDuplex.value;
            job.settings.pageselect  = detailConfigPageselect.value;
            job.settings.size        = detailConfigSize.value;
            job.settings.orientation = detailConfigOrientation.value;
            job.settings.quality     = detailConfigQuality.value;
            recalculateJobCosts(job);
        });
    }

    function closeDetailsPanel() {
        detailsPanel.classList.remove("open");
        const fileListContainer = document.getElementById("dynamic-file-selection-list");
        if (fileListContainer) fileListContainer.style.display = "none";
    }

    function recalculatePanelCosts(job) {
        if (!job || !job.settings) return;

        const duplexMode = job.settings.duplex || "single";
        const colorMode = job.settings.color || "bw";
        const paperSize = job.settings.size || "a4";
        const copyCount = parseInt(job.settings.copies) || 1;

        const sheets   = Math.ceil((job.pages || 1) / (duplexMode === "double" ? 2 : 1));
        const baseRate = paperSize === "a3" ? 0.15 : 0.05;
        const colorAdd = colorMode === "color" ? 0.35 : 0;
        const subtotal = sheets * (baseRate + colorAdd) * copyCount;
        const gst      = subtotal * 0.18;
        const final    = subtotal + gst;

        if (selectedJobIds.length === 1 && selectedJobIds[0] === job.id) {
            if (detailCostBw)    detailCostBw.textContent    = colorMode === "bw"    ? `₹${subtotal.toFixed(2)}` : "₹0.00";
            if (detailCostColor) detailCostColor.textContent = colorMode === "color" ? `₹${subtotal.toFixed(2)}` : "₹0.00";
            if (detailCostGst)   detailCostGst.textContent   = `₹${gst.toFixed(2)}`;
            if (detailCostTotal) detailCostTotal.textContent = `₹${final.toFixed(2)}`;
        }
        job.amount = parseFloat(final.toFixed(2));
    }

    function recalculateJobCosts(job) {
        recalculatePanelCosts(job);
    }

    function updateCostCalculator() {
        const pages  = parseInt(document.getElementById("calc-pages")?.value) || 1;
        const copies = parseInt(document.getElementById("calc-copies")?.value) || 1;

        const sidesVal = document.querySelector("[data-input=\"calc-sides\"].selected")?.getAttribute("data-value");
        const colorVal = document.querySelector("[data-input=\"calc-color\"].selected")?.getAttribute("data-value");
        const sizeVal  = document.querySelector("[data-input=\"calc-size\"].selected")?.getAttribute("data-value");

        if (!sidesVal) return;

        const sheets      = sidesVal === "double" ? Math.ceil(pages / 2) : pages;
        const baseRate    = sizeVal === "a3" ? 0.15 : 0.05;
        const colorAdd    = colorVal === "color" ? 0.30 : 0;
        const totalAmount = parseFloat((sheets * (baseRate + colorAdd) * copies).toFixed(2));

        const display = document.getElementById("calc-total-display");
        if (display) display.textContent = `₹${totalAmount.toFixed(2)}`;
    }

    init();
});