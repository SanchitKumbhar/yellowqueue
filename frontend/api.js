/**
 * PrintFlow API Service Layer
 * Handles all communication with the PrintFlow backend (http://localhost:5000)
 * Uses fetch (available in Electron's Chromium renderer) for HTTP and
 * requires socket.io-client for real-time events.
 */

"use strict";

const API_BASE = "http://localhost:5000";

// ─────────────────────────────────────────────
// Token helpers (persisted in localStorage)
// ─────────────────────────────────────────────
function getToken() {
    return localStorage.getItem("pf_token") || null;
}

function getStoreId() {
    const raw = localStorage.getItem("pf_store_id");
    return raw ? parseInt(raw, 10) : null;
}

function saveSession(token) {
    localStorage.setItem("pf_token", token);
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        localStorage.setItem("pf_store_id", String(payload.storeId));
    } catch (_) {}
}

function clearSession() {
    localStorage.removeItem("pf_token");
    localStorage.removeItem("pf_store_id");
}

function isAuthenticated() {
    const token = getToken();
    if (!token) return false;
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        // Check expiry (exp is in seconds)
        return payload.exp * 1000 > Date.now();
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────
// Core HTTP helper
// ─────────────────────────────────────────────
async function apiRequest(method, urlPath, body) {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res;
    try {
        res = await fetch(`${API_BASE}${urlPath}`, opts);
    } catch (networkErr) {
        throw new Error("Cannot reach PrintFlow server. Is the backend running?");
    }

    let data;
    try {
        data = await res.json();
    } catch (_) {
        data = {};
    }

    if (!res.ok) {
        const msg = data.message || data.error || `HTTP ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }

    return data;
}

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────
async function login(phonenumber, password) {
    const data = await apiRequest("POST", "/api/user-auth/v1/login", {
        phonenumber,
        password
    });
    if (data.token) saveSession(data.token);
    return data;
}

async function signup(name, phonenumber, password, email) {
    const data = await apiRequest("POST", "/api/user-auth/v1/signup", {
        name,
        phonenumber,
        password,
        email: email || "",
        district: "",
        state: "",
        address: "",
        cache_folder: ""
    });
    if (data.token) saveSession(data.token);
    return data;
}

function logout() {
    clearSession();
    disconnectSocket();
}

// ─────────────────────────────────────────────
// Print Jobs / Orders
// ─────────────────────────────────────────────

/** Fetch all print jobs for the authenticated store */
async function getOrders() {
    const data = await apiRequest("GET", "/api/orders/v1/get-order");
    return data.data || [];
}

/** Fetch dashboard summary stats and recent activity */
async function getDashboardSummary() {
    const data = await apiRequest("GET", "/api/orders/v1/dashboard-summary");
    return data.data || null;
}

/** Update a job's status */
async function updateStatus(jobId, status) {
    return apiRequest("PATCH", "/api/orders/v1/update-status", { jobId, status });
}

/** Update a job's cost */
async function updateCost(jobId, cost) {
    return apiRequest("PATCH", "/api/orders/v1/cost-order", { jobId, cost });
}

/** Create a manual (walk-in) job */
async function createManualJob(jobData) {
    const data = await apiRequest("POST", "/api/orders/v1/create-manual-job", jobData);
    return data.job || null;
}

/** Get the files associated with a job */
async function getJobFiles(jobId) {
    const data = await apiRequest("GET", `/api/orders/v1/files/${encodeURIComponent(jobId)}`);
    return data.files || [];
}

/** Get logged-in store profile */
async function getProfile() {
    const data = await apiRequest("GET", "/api/user-auth/v1/profile");
    return data.data || null;
}

/** Update logged-in store profile */
async function updateProfile(payload) {
    const data = await apiRequest("PATCH", "/api/user-auth/v1/profile", payload);
    return data.data || null;
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
async function checkHealth() {
    try {
        const data = await apiRequest("GET", "/health");
        return data.status === "ok";
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────
// File URL helpers
// ─────────────────────────────────────────────

/** Returns the HTTP URL for a file stored on the backend */
function getFileUrl(filePath) {
    if (!filePath) return null;
    const normalized = filePath.replace(/\\/g, "/");
    // If the file is in workers/uploads, serve via /worker-uploads route
    if (normalized.includes("workers/uploads")) {
        const fileName = normalized.split("workers/uploads/").pop();
        return `${API_BASE}/worker-uploads/${fileName}`;
    }
    // Generic uploads folder
    if (normalized.includes("/uploads/")) {
        const fileName = normalized.split("/uploads/").pop();
        return `${API_BASE}/uploads/${fileName}`;
    }
    return null;
}

// ─────────────────────────────────────────────
// Socket.IO real-time connection
// ─────────────────────────────────────────────
let _socket = null;

function connectSocket(storeId, callbacks = {}) {
    if (_socket && _socket.connected) return _socket;

    let io;
    try {
        io = require("socket.io-client");
    } catch (_) {
        console.error("socket.io-client not installed. Run: npm install in frontend/");
        return null;
    }

    _socket = io(API_BASE, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 10
    });

    _socket.on("connect", () => {
        console.log("Socket.IO connected:", _socket.id);
        _socket.emit("register-store", { storeId });
        if (callbacks.onConnect) callbacks.onConnect();
    });

    _socket.on("new-job", (data) => {
        console.log("Real-time: new-job received", data.jobId || data.job_id);
        if (callbacks.onNewJob) callbacks.onNewJob(data);
    });

    // ─────────────────────────────────────────────
    // FIX: this listener was missing entirely, so files that
    // arrive AFTER the initial "new-job" event (e.g. WhatsApp
    // media that finishes downloading/processing a moment later)
    // were never delivered to the UI. onJobUpdated in app.js
    // already existed and expected this — it just never fired.
    //
    // IMPORTANT: "job-updated" is the event name app.js's callback
    // is written for. Confirm this matches whatever your backend
    // actually calls via io.to(...).emit(EVENT_NAME, ...) when it
    // attaches files to an existing job. If your backend uses a
    // different name, update the string below (and/or add another
    // alias line the same way) — everything else stays the same.
    // ─────────────────────────────────────────────
    const jobUpdateEventAliases = ["job-updated", "job_updated", "files-added", "file-added"];
    jobUpdateEventAliases.forEach((eventName) => {
        _socket.on(eventName, (data) => {
            console.log(`Real-time: ${eventName} received`, data.jobId || data.job_id);
            if (callbacks.onJobUpdated) callbacks.onJobUpdated(data);
        });
    });

    _socket.on("disconnect", (reason) => {
        console.log("Socket.IO disconnected:", reason);
        if (callbacks.onDisconnect) callbacks.onDisconnect(reason);
    });

    _socket.on("connect_error", (err) => {
        console.warn("Socket.IO connection error:", err.message);
    });

    return _socket;
}

function disconnectSocket() {
    if (_socket) {
        _socket.disconnect();
        _socket = null;
    }
}

// ─────────────────────────────────────────────
// Normalize backend job → frontend job shape
// ─────────────────────────────────────────────
function normalizeJob(raw) {
    const createdAt = raw.created_at ? new Date(raw.created_at) : new Date();
    const timeStr = createdAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    });

    return {
        id: raw.job_id,
        // customer_name for manual jobs, sender_phone for WhatsApp jobs
        customer: raw.customer_name || raw.sender_phone || "Unknown",
        phone: raw.sender_phone || "N/A",
        fileName: `job_${raw.job_id}.files`,
        filePath: null,         // loaded lazily via getJobFiles()
        fileType: "mixed",
        fileSize: "N/A",
        pages: raw.total_pages || 0,
        copies: 1,
        amount: raw.cost_of_job || 0,
        source: raw.source || "manual",
        time: timeStr,
        status: raw.status || "pending",
        priority: "medium",
        notes: raw.notes || "",
        settings: {
            printer: "",
            copies: 1,
            color: "bw",
            duplex: "double",
            pageselect: "all",
            pagerange: "All",
            size: "a4",
            orientation: "portrait",
            quality: "standard",
            pagesPerSheet: "1",
            scaleType: "fit",
            scalePct: 100
        },
        timeline: [
            { time: timeStr, text: `Job received via ${raw.source || "manual"}` }
        ],
        _raw: raw  // keep original for reference
    };
}

// ─────────────────────────────────────────────
// Normalize real-time "new-job" socket payload
// ─────────────────────────────────────────────
function normalizeSocketJob(data) {
    const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    const timeStr = createdAt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    });

    const filesCount = data.fileCount || data.file_count || 0;
    const preview = data.files && data.files[0]
        ? (data.files[0].fileName || data.files[0].file_name || "document")
        : `${filesCount} file(s)`;

    return {
        client: data.senderPhone || data.sender_phone || "Unknown",
        source: data.source || "whatsapp",
        time: "Just now",
        filesCount,
        pages: data.totalPages || data.total_pages || 0,
        preview,
        jobId: data.jobId || data.job_id,
        storeId: data.storeId || data.store_id,
        rawData: data
    };
}

module.exports = {
    // Auth
    getToken,
    getStoreId,
    isAuthenticated,
    logout,
    login,
    signup,
    // Data
    getOrders,
    getDashboardSummary,
    updateStatus,
    updateCost,
    createManualJob,
    getJobFiles,
    getProfile,
    updateProfile,
    checkHealth,
    // Util
    getFileUrl,
    normalizeJob,
    normalizeSocketJob,
    // Socket
    connectSocket,
    disconnectSocket
};