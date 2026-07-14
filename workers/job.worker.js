  // workers/job.worker.js

const { Worker } = require("bullmq");
const Redis = require("ioredis");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const db = require("../config/sqlite.config");
const { prepareIncomingFiles, isUnsupportedMediaType } = require("../service/archive.service.js");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const execPromise = util.promisify(exec);

// Resolve uploads relative to the backend root (not process.cwd())
const BACKEND_ROOT = path.resolve(__dirname, "..");
const UPLOADS_DIR = path.join(BACKEND_ROOT, "uploads");

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
    console.error("REDIS_URL not set in .env. Worker cannot start.");
    process.exit(1);
}

const BATCH_WINDOW_MS = Number(process.env.WHATSAPP_BATCH_WINDOW_MS || 6000);

// -------------------- Redis Connections --------------------
const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null
});
const pubClient = new Redis(redisUrl);
const batchClient = new Redis(redisUrl);

connection.on("connect", () => {
    console.log("Redis connected for worker");
});

connection.on("error", (err) => {
    console.error("Worker Redis connection error:", err.message);
});

// -------------------- SQLite Helper --------------------
const runQuery = (query, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

// -------------------- Page Counter Helper --------------------
const getPageCount = async (filePath, mimeType) => {
    if (mimeType === "application/pdf") {
        try {
            const { stdout } = await execPromise(`pdfinfo "${filePath}"`);
            const match = stdout.match(/Pages:\s+(\d+)/);
            if (match && match[1]) {
                return parseInt(match[1], 10);
            }
            return 1;
        } catch (error) {
            console.warn(`pdfinfo failed for ${filePath}. Defaulting to 1.`, error.message);
            return 1;
        }
    }
    return 1;
};

// -------------------- Worker --------------------
const worker = new Worker(
    "whatsapp-jobs",
    async (job) => {
        try {
            const data = job.data.payload || job.data;
            const storeId = job.data.storeId || 1;
            const preparedFiles = Array.isArray(job.data.preparedFiles) ? job.data.preparedFiles : null;

            console.log("JOB DATA RECEIVED:", data);

            if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
                console.error(
                    "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set. " +
                    "Media downloads will fail with 401 Unauthorized."
                );
            }

            const senderPhone = (data.From || "UNKNOWN").replace("whatsapp:", "");
            const jobId = data.MessageSid;
            const messageType = data.MessageType || "";
            const bodyText = data.Body || "";
            const mediaCount = Number(data.NumMedia || 0);

            console.log(`Processing message: ${jobId} from ${senderPhone} for store-${storeId}`);

            // -------------------- Detect Unsupported Media --------------------
            // When MessageType is 'document' but NumMedia is 0 and Body contains
            // a filename, Twilio/WhatsApp couldn't deliver the file as media.
            // This happens with ZIP, RAR, EXE, and other unsupported file types.
            let unsupportedFileName = null;
            if (mediaCount === 0 && messageType === "document" && bodyText) {
                const hasExtension = /\.\w{2,5}$/.test(bodyText.trim());
                if (hasExtension) {
                    unsupportedFileName = bodyText.trim();
                    console.warn(
                        `⚠ Unsupported media detected: "${unsupportedFileName}" from ${senderPhone}. ` +
                        `WhatsApp/Twilio does not support this file type for media delivery. ` +
                        `NumMedia=0, MessageType=document.`
                    );
                }
            }

            // -------------------- Process Files --------------------
            let files = [];

            if (preparedFiles && preparedFiles.length > 0) {
                files = preparedFiles;
            } else if (mediaCount > 0 || !unsupportedFileName) {
                files = await prepareIncomingFiles(data);
            }
            // If unsupportedFileName is set and no media, files stays empty

            if (mediaCount > 0 && files.length === 0) {
                throw new Error(
                    `All media file(s) failed to download for message ${jobId}. ` +
                    `Check TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and Twilio media URL validity.`
                );
            }

            // -------------------- Batch With Other Messages --------------------
            const batchKey = `printflow:batch:${storeId}:${senderPhone}`;
            const lockKey = `${batchKey}:owner`;

            const entry = JSON.stringify({ jobId, files, unsupportedFileName });

            await batchClient.rpush(batchKey, entry);
            await batchClient.pexpire(batchKey, BATCH_WINDOW_MS + 2000);

            const gotLock = await batchClient.set(lockKey, jobId, "PX", BATCH_WINDOW_MS, "NX");

            if (!gotLock) {
                console.log(`Message ${jobId} appended to existing batch for ${senderPhone}, owner handles finalize.`);
                return { jobId, batched: true };
            }

            await new Promise((resolve) => setTimeout(resolve, BATCH_WINDOW_MS));

            const rawEntries = await batchClient.lrange(batchKey, 0, -1);
            await batchClient.del(batchKey);
            await batchClient.del(lockKey);

            const allEntries = rawEntries.map((e) => JSON.parse(e));
            const allFiles = allEntries.flatMap((e) => e.files);
            const memberJobIds = allEntries.map((e) => e.jobId);

            // Collect any unsupported file names from the batch
            const unsupportedNames = allEntries
                .map((e) => e.unsupportedFileName)
                .filter(Boolean);

            const finalJobId = jobId;
            const totalPages = allFiles.reduce((sum, file) => sum + (file.pages || 0), 0);

            // Determine job status
            let jobStatus = "pending";
            let jobNotes = null;

            if (allFiles.length === 0 && unsupportedNames.length > 0) {
                jobStatus = "failed";
                jobNotes = `Unsupported file type(s): ${unsupportedNames.join(", ")}. ` +
                    `WhatsApp does not support ZIP/RAR/archive files. ` +
                    `Please send files as PDF, JPG, PNG, DOC, DOCX, PPTX, or XLSX.`;
            }

            console.log(
                `Finalizing batched job ${finalJobId} for ${senderPhone}: ` +
                `${allFiles.length} file(s) across ${memberJobIds.length} message(s) [${memberJobIds.join(", ")}]` +
                (unsupportedNames.length > 0 ? ` (unsupported: ${unsupportedNames.join(", ")})` : "")
            );

            // -------------------- DB Inserts --------------------
            await runQuery(
                `INSERT INTO print_jobs 
                (job_id, store_id, sender_phone, source, file_count, total_pages, status, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [finalJobId, storeId, senderPhone, "whatsapp", allFiles.length, totalPages, jobStatus, jobNotes]
            );

            for (const file of allFiles) {
                await runQuery(
                    `INSERT INTO print_job_files 
                    (job_id, file_name, file_path, file_type, pages)
                    VALUES (?, ?, ?, ?, ?)`,
                    [finalJobId, file.fileName, file.localPath, file.contentType, file.pages]
                );
            }

            console.log("Job and files successfully saved to SQLite database:", finalJobId);

            // -------------------- Broadcast Event --------------------
            const createdJob = {
                jobId: finalJobId,
                job_id: finalJobId,
                storeId: storeId,
                store_id: storeId,
                senderPhone: senderPhone,
                sender_phone: senderPhone,
                customer_name: `WhatsApp (${senderPhone.slice(-4)})`,
                source: "whatsapp",
                fileCount: allFiles.length,
                file_count: allFiles.length,
                totalPages: totalPages,
                total_pages: totalPages,
                // Map file properties to match what the frontend expects
                files: allFiles.map(f => ({
                    file_name: f.fileName || f.file_name || path.basename(f.localPath || "document.pdf"),
                    fileName: f.fileName || f.file_name || path.basename(f.localPath || "document.pdf"),
                    file_path: f.localPath || f.file_path || "",
                    filePath: f.localPath || f.file_path || "",
                    file_type: f.contentType || f.file_type || "application/octet-stream",
                    fileType: f.contentType || f.file_type || "application/octet-stream",
                    pages: f.pages || 1,
                    // Keep localPath for the worker's own reference
                    localPath: f.localPath || f.file_path || ""
                })),
                status: jobStatus,
                notes: jobNotes,
                cost_of_job: 0,
                createdAt: new Date().toISOString()
            };

            await pubClient.publish(
                "store-events",
                JSON.stringify({
                    storeId: storeId,
                    event: "new-job",
                    data: createdJob
                })
            );

            console.log(`Emitted real-time job payload to store channel store-${storeId}`);
            
            return createdJob;

        } catch (err) {
            console.error("Worker lifecycle processing error:", err);
            throw err; 
        }
    },
    { connection }
);

// -------------------- Events --------------------
worker.on("completed", (job) => {
    console.log("Job completed successfully:", job.id);
});

worker.on("failed", (job, err) => {
    console.error("Job failed:", job?.id, err.message);
});