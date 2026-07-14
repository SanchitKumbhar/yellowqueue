const fs = require("fs");
const path = require("path");
const db = require("../config/sqlite.config");
const { prepareIncomingFiles, isUnsupportedMediaType } = require("./archive.service.js");

/**
 * Insert file record into print_job_files table.
 */
const insertFileRecord = (jobId, file) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO print_job_files
            (job_id, file_name, file_path, file_type, pages)
            VALUES (?, ?, ?, ?, ?)`,
            [
                jobId,
                file.fileName || path.basename(file.localPath || ""),
                file.localPath || file.file_path || "",
                file.contentType || file.file_type || "application/octet-stream",
                file.pages || 0
            ],
            (err) => {
                if (err) return reject(err);
                resolve();
            }
        );
    });
};

/**
 * Main message processor — standalone mode (no BullMQ).
 * Handles downloading media, archive extraction, and DB persistence.
 *
 * @param {Object} payload - Twilio webhook payload
 * @param {Object} io - Socket.IO server instance
 * @param {number} storeId - Store ID for tenant isolation
 * @param {Array|null} preparedFiles - Pre-extracted files (from archive worker)
 */
const processIncomingMessage = async (payload, io, storeId = 1, preparedFiles = null) => {
    try {
        const senderPhone = (payload.From || "UNKNOWN").replace("whatsapp:", "");
        const jobId = payload.MessageSid;
        const messageType = payload.MessageType || "";
        const bodyText = payload.Body || "";
        const mediaCount = Number(payload.NumMedia || 0);

        // Detect unsupported media (e.g. ZIP sent via WhatsApp)
        let unsupportedFileName = null;
        if (mediaCount === 0 && messageType === "document" && bodyText) {
            const hasExtension = /\.\w{2,5}$/.test(bodyText.trim());
            if (hasExtension && isUnsupportedMediaType(bodyText.trim())) {
                unsupportedFileName = bodyText.trim();
                console.warn(
                    `⚠ Unsupported media: "${unsupportedFileName}" from ${senderPhone}. ` +
                    `WhatsApp/Twilio does not support this file type.`
                );
            }
        }

        // Process files
        let files;
        if (Array.isArray(preparedFiles) && preparedFiles.length > 0) {
            files = preparedFiles;
        } else if (mediaCount > 0 || !unsupportedFileName) {
            files = await prepareIncomingFiles(payload);
        } else {
            files = [];
        }

        // Determine status
        let jobStatus = "pending";
        let jobNotes = null;

        if (files.length === 0 && unsupportedFileName) {
            jobStatus = "failed";
            jobNotes = `Unsupported file type: ${unsupportedFileName}. ` +
                `WhatsApp does not support ZIP/RAR files. ` +
                `Please send as PDF, JPG, PNG, DOC, DOCX, PPTX, or XLSX.`;
        }

        const totalPages = files.reduce((sum, f) => sum + (f.pages || 0), 0);

        // Begin Transaction
        await new Promise((resolve, reject) => {
            db.run("BEGIN TRANSACTION", (err) => {
                if (err) return reject(err);
                resolve();
            });
        });

        try {
            // Insert Job
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO print_jobs
                    (job_id, store_id, sender_phone, source, file_count, total_pages, status, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [jobId, storeId, senderPhone, "whatsapp", files.length, totalPages, jobStatus, jobNotes],
                    function (err) {
                        if (err) return reject(err);
                        resolve();
                    }
                );
            });

            // Insert all file records
            await Promise.all(
                files.map(file => insertFileRecord(jobId, file))
            );

            // Commit
            await new Promise((resolve, reject) => {
                db.run("COMMIT", (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });

        } catch (err) {
            await new Promise((resolve) => {
                db.run("ROLLBACK", () => resolve());
            });
            throw err;
        }

        // Response Object
        const createdJob = {
            jobId,
            job_id: jobId,
            storeId,
            store_id: storeId,
            senderPhone,
            sender_phone: senderPhone,
            customer_name: `WhatsApp (${senderPhone.slice(-4)})`,
            source: "whatsapp",
            status: jobStatus,
            notes: jobNotes,
            fileCount: files.length,
            file_count: files.length,
            totalPages: totalPages,
            total_pages: totalPages,
            // Map file properties to match what the frontend expects
            files: files.map(f => ({
                file_name: f.fileName || f.file_name || path.basename(f.localPath || "document.pdf"),
                fileName: f.fileName || f.file_name || path.basename(f.localPath || "document.pdf"),
                file_path: f.localPath || f.file_path || "",
                filePath: f.localPath || f.file_path || "",
                file_type: f.contentType || f.file_type || "application/octet-stream",
                fileType: f.contentType || f.file_type || "application/octet-stream",
                pages: f.pages || 1,
                localPath: f.localPath || f.file_path || ""
            })),
            cost_of_job: 0,
            createdAt: new Date().toISOString()
        };

        // Notify desktop clients
        if (io) {
            io.to(`store-${storeId}`).emit("new-job", createdJob);
        }

        return createdJob;

    } catch (error) {
        console.error("processIncomingMessage error:", error);
        throw error;
    }
};

module.exports = {
    processIncomingMessage
};