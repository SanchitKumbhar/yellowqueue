const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

// Resolve uploads relative to the backend root (not process.cwd())
const BACKEND_ROOT = path.resolve(__dirname, "..");
const UPLOADS_DIR = path.join(BACKEND_ROOT, "uploads");

const MIME_BY_EXTENSION = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".txt": "text/plain",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

// Supported media types that Twilio/WhatsApp actually delivers as downloadable media
const SUPPORTED_MEDIA_EXTENSIONS = [
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
    ".tif", ".tiff", ".doc", ".docx", ".pptx", ".xlsx",
    ".mp4", ".ogg", ".amr", ".3gp", ".aac", ".mp3"
];

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sanitizeSegment(value) {
    return String(value || "archive")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "archive";
}

/**
 * Check if a filename/content-type indicates an archive (zip/rar).
 * Note: Twilio/WhatsApp does NOT deliver zip/rar as downloadable media,
 * so this is primarily for detection and user notification purposes.
 */
function isArchiveAttachment(contentType = "", fileName = "") {
    const normalizedType = String(contentType || "").toLowerCase();
    const normalizedName = String(fileName || "").toLowerCase();

    return (
        normalizedType.includes("zip") ||
        normalizedType.includes("rar") ||
        normalizedType.includes("x-7z") ||
        normalizedName.endsWith(".zip") ||
        normalizedName.endsWith(".rar") ||
        normalizedName.endsWith(".7z")
    );
}

/**
 * Check if a filename represents an unsupported media type for WhatsApp/Twilio.
 * Returns true if the file type is NOT in the supported list.
 */
function isUnsupportedMediaType(fileName = "") {
    if (!fileName) return false;
    const ext = path.extname(fileName).toLowerCase();
    if (!ext) return false;
    return !SUPPORTED_MEDIA_EXTENSIONS.includes(ext);
}

function getExtensionFromMedia(contentType = "", fileName = "") {
    const normalizedName = String(fileName || "").toLowerCase();
    const nameExt = path.extname(normalizedName);
    if (nameExt) return nameExt.replace(".", "");

    const normalizedType = String(contentType || "").toLowerCase();
    if (normalizedType.includes("pdf")) return "pdf";
    if (normalizedType.includes("jpeg") || normalizedType.includes("jpg")) return "jpg";
    if (normalizedType.includes("png")) return "png";
    if (normalizedType.includes("gif")) return "gif";
    if (normalizedType.includes("webp")) return "webp";
    if (normalizedType.includes("zip")) return "zip";
    if (normalizedType.includes("rar")) return "rar";

    return "bin";
}

/**
 * Download media from a Twilio-protected URL with auth.
 */
async function downloadMedia(url, messageSid, extension) {
    ensureDir(UPLOADS_DIR);

    const fileName = `${messageSid}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${extension}`;
    const filePath = path.join(UPLOADS_DIR, fileName);

    const response = await axios({
        method: "GET",
        url,
        responseType: "stream",
        auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
        },
        timeout: 30000,
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        let errBody = "";
        try {
            for await (const chunk of response.data) {
                errBody += chunk.toString("utf8");
                if (errBody.length > 500) break;
            }
        } catch (_) {}

        throw new Error(
            `Twilio media download failed (HTTP ${response.status}) for ${url}. ` +
            `Response: ${errBody.slice(0, 300)}`
        );
    }

    const contentLength = Number(response.headers["content-length"] || 0);
    if (contentLength > 0 && contentLength < 100) {
        throw new Error(
            `Twilio media response too small (${contentLength} bytes) for ${url}, ` +
            `likely an auth/error response rather than the actual file.`
        );
    }

    const writer = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
        response.data.on("error", reject);
    });

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
        fs.unlinkSync(filePath);
        throw new Error(`Downloaded file is empty (0 bytes): ${filePath}`);
    }

    return filePath;
}

/**
 * Fetch media subresources from the Twilio REST API for a given MessageSid.
 * This is the fallback path when NumMedia === 0 but MessageType suggests media.
 */
async function fetchTwilioMessageMedia(messageSid) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken || !messageSid) {
        return [];
    }

    try {
        const mediaListUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${messageSid}/Media.json`;
        const response = await axios({
            method: "GET",
            url: mediaListUrl,
            auth: {
                username: accountSid,
                password: authToken
            },
            timeout: 15000,
            validateStatus: () => true
        });

        if (response.status < 200 || response.status >= 300) {
            return [];
        }

        const body = response.data || {};
        const mediaItems = body.media_list || body.media || [];
        if (!Array.isArray(mediaItems)) {
            return [];
        }

        return mediaItems
            .map((item) => {
                const mediaSid = item.sid || item.media_sid || item.mediaSid;
                const mediaUri = item.uri || item.url || item.media_url || item.mediaUri;
                const contentUri = mediaSid && mediaUri && mediaUri.includes("/Media/")
                    ? mediaUri.replace(/\.json$/i, "")
                    : mediaUri;
                const resolvedUrl = contentUri && contentUri.startsWith("http")
                    ? contentUri
                    : contentUri
                        ? `https://api.twilio.com${contentUri}`
                        : null;

                return {
                    url: resolvedUrl,
                    fileName: item.filename || item.file_name || item.name || mediaSid || "document",
                    contentType: item.content_type || item.contentType || item.mime_type || "application/octet-stream"
                };
            })
            .filter((item) => item.url);
    } catch (err) {
        console.warn("fetchTwilioMessageMedia error:", err.message);
        return [];
    }
}

/**
 * Get page count for a PDF using pdfinfo (poppler-utils).
 * Returns 1 for non-PDF or on failure.
 */
async function getPageCount(filePath, mimeType) {
    if (mimeType === "application/pdf") {
        try {
            const { stdout } = await execPromise(`pdfinfo "${filePath}"`);
            const match = stdout.match(/Pages:\s+(\d+)/);
            if (match && match[1]) {
                return parseInt(match[1], 10);
            }
        } catch (error) {
            console.warn(`pdfinfo failed for ${filePath}; defaulting to 1.`, error.message);
        }
    }

    return 1;
}

function guessMimeType(filePath) {
    return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function walkFiles(dirPath) {
    const entries = [];
    if (!fs.existsSync(dirPath)) return entries;

    const children = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const child of children) {
        const fullPath = path.join(dirPath, child.name);
        if (child.isDirectory()) {
            entries.push(...walkFiles(fullPath));
        } else {
            entries.push(fullPath);
        }
    }

    return entries;
}

function makeUniqueUploadPath(sourceName, archivePrefix) {
    ensureDir(UPLOADS_DIR);

    const baseName = path.basename(sourceName, path.extname(sourceName));
    const extension = path.extname(sourceName) || ".bin";
    const safeBaseName = sanitizeSegment(baseName);
    const safePrefix = sanitizeSegment(archivePrefix || "archive");

    return path.join(
        UPLOADS_DIR,
        `${safePrefix}_${safeBaseName}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${extension}`
    );
}

async function findSevenZipExecutable() {
    const candidates = [
        process.env.SEVEN_ZIP_PATH,
        "C:\\Program Files\\7-Zip\\7z.exe",
        "C:\\Program Files (x86)\\7-Zip\\7z.exe",
        "7z"
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (candidate === "7z") return candidate;
        if (fs.existsSync(candidate)) return candidate;
    }

    return null;
}

/**
 * Extract an archive file (ZIP or RAR) and return an array of file descriptors.
 * Note: This is kept for future use / local file upload support.
 * Twilio/WhatsApp does NOT deliver zip/rar as downloadable media.
 */
async function extractArchiveFile(archivePath, archiveFileName, extractedRootDir) {
    const resolvedArchiveName = archiveFileName || archivePath;
    const archiveExt = path.extname(resolvedArchiveName).toLowerCase() || path.extname(archivePath).toLowerCase();
    const archiveBaseName = sanitizeSegment(path.basename(resolvedArchiveName, archiveExt));
    const outputDir = path.join(extractedRootDir, archiveBaseName);
    ensureDir(outputDir);

    if (archiveExt === ".zip") {
        const quotedArchive = archivePath.replace(/'/g, "''");
        const quotedOutput = outputDir.replace(/'/g, "''");
        await execFilePromise("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${quotedArchive}' -DestinationPath '${quotedOutput}' -Force`
        ]);
    } else if (archiveExt === ".rar" || archiveExt === ".7z") {
        const sevenZip = await findSevenZipExecutable();
        if (!sevenZip) {
            throw new Error("RAR/7z extraction requires 7-Zip (7z.exe). Set SEVEN_ZIP_PATH or install 7-Zip.");
        }

        await execFilePromise(sevenZip, ["x", `-o${outputDir}`, "-y", archivePath]);
    } else {
        throw new Error(`Unsupported archive format: ${archiveExt || "unknown"}`);
    }

    const files = walkFiles(outputDir);
    return Promise.all(files.map(async (filePath) => {
        const uploadPath = makeUniqueUploadPath(filePath, archiveBaseName);
        fs.copyFileSync(filePath, uploadPath);
        const contentType = guessMimeType(filePath);
        return {
            localPath: uploadPath,
            fileName: path.basename(filePath),
            contentType,
            pages: await getPageCount(uploadPath, contentType)
        };
    }));
}

/**
 * Main entry point: prepare incoming files from a Twilio WhatsApp webhook payload.
 *
 * Returns an array of file descriptors: { localPath, fileName, contentType, pages }
 *
 * Handles:
 * 1. Direct media from payload (MediaUrl0, MediaUrl1, ...)
 * 2. Fallback via Twilio REST API when NumMedia=0 but media may exist
 * 3. Archive extraction for zip/rar if files are somehow downloadable
 * 4. Unsupported media type detection (zip via WhatsApp = no downloadable media)
 */
async function prepareIncomingFiles(payload) {
    const messageSid = payload.MessageSid || `archive-${Date.now()}`;
    const extractedRootDir = path.join(UPLOADS_DIR, "archive-temp", sanitizeSegment(messageSid));
    ensureDir(extractedRootDir);

    const files = [];
    const directMediaCount = Number(payload.NumMedia || 0);

    // Build list of media entries from direct webhook params
    const mediaEntries = [];

    for (let i = 0; i < directMediaCount; i++) {
        mediaEntries.push({
            url: payload[`MediaUrl${i}`],
            contentType: payload[`MediaContentType${i}`] || "",
            fileName: payload[`MediaFilename${i}`] || payload[`MediaName${i}`] || `${messageSid}_${i}`
        });
    }

    // If no direct media, try REST API fallback
    if (mediaEntries.length === 0) {
        const fallbackMedia = await fetchTwilioMessageMedia(messageSid);
        if (fallbackMedia.length > 0) {
            mediaEntries.push(...fallbackMedia);
        }
    }

    // Process each media entry
    for (let i = 0; i < mediaEntries.length; i++) {
        const mediaUrl = mediaEntries[i].url;
        const contentType = mediaEntries[i].contentType || "";
        const fileName = mediaEntries[i].fileName || `${messageSid}_${i}`;
        const extension = getExtensionFromMedia(contentType, fileName);

        if (!mediaUrl) continue;

        try {
            const downloadedPath = await downloadMedia(mediaUrl, `${messageSid}_${i}`, extension);

            if (isArchiveAttachment(contentType, fileName)) {
                const extractedFiles = await extractArchiveFile(downloadedPath, fileName, extractedRootDir);
                files.push(...extractedFiles);
                continue;
            }

            files.push({
                localPath: downloadedPath,
                fileName: path.basename(fileName),
                contentType: contentType || guessMimeType(downloadedPath),
                pages: await getPageCount(downloadedPath, contentType)
            });
        } catch (err) {
            console.error(`Failed to process media ${i} for message ${messageSid}:`, err.message);
        }
    }

    return files;
}

module.exports = {
    isArchiveAttachment,
    isUnsupportedMediaType,
    prepareIncomingFiles,
    fetchTwilioMessageMedia,
    downloadMedia,
    getPageCount,
    UPLOADS_DIR
};
