const { processIncomingMessage } = require("../service/print.webhook.service.js");
const { isArchiveAttachment, prepareIncomingFiles } = require("../service/archive.service.js");
const jobService = require("../service/jobs.service.js");

/**
 * Webhook receiver — fast hand-off to BullMQ queue.
 * Detects archive attachments and routes them to the archive queue if available.
 */
const receiveWebhook = async (req, res) => {
    try {
        const payload = req.body;
        const jobId = payload.MessageSid;
        const storeId = req.storeId || 6;
        const io = req.app.get("io");

        // Detect if any attachment is an archive (zip/rar)
        const numMedia = Number(payload.NumMedia || 0);
        const hasArchive = numMedia > 0 && Array.from({ length: numMedia }).some((_, index) => {
            const contentType = payload[`MediaContentType${index}`] || "";
            const fileName = payload[`MediaFilename${index}`] || payload[`MediaName${index}`] || payload[`MediaUrl${index}`] || "";
            return isArchiveAttachment(contentType, fileName);
        });

        const messageQueue = req.app.get("messageQueue");
        const archiveQueue = req.app.get("archiveQueue");

        // Route archives to dedicated extraction queue if available
        if (hasArchive) {
            if (archiveQueue) {
                await archiveQueue.add("unzip-archive", { payload, storeId }, { jobId });
                return res.status(200).json({ success: true, message: "Archive received and queued for extraction." });
            }

            // Fallback: extract in-process if no archive queue
            const preparedFiles = await prepareIncomingFiles(payload);
            await processIncomingMessage(payload, io, storeId, preparedFiles);
            return res.status(200).json({ success: true, message: "Archive processed in standalone mode." });
        }

        if (!messageQueue) {
            console.warn("Webhook received but BullMQ unavailable.");
            await processIncomingMessage(payload, io, storeId);
            return res.status(200).json({ success: true, message: "Standalone mode execution." });
        }

        await messageQueue.add("process-message", { payload, storeId }, { jobId });

        return res.status(200).json({ success: true, message: "Webhook accepted and queued." });
    } catch (error) {
        console.error("receiveWebhook error:", error);
        try {
            const payload = req.body;
            const storeId = req.storeId || 6;
            const io = req.app.get("io");
            await processIncomingMessage(payload, io, storeId);
            return res.status(200).json({ success: true, message: "Processed after queue failure." });
        } catch (fallbackError) {
            console.error("receiveWebhook fallback error:", fallbackError);
        }
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

/**
 * Get print jobs for authenticated store.
 */
const printJobsController = async (req, res) => {
    try {
        const store_id = req.storeId;
        const result = await jobService(store_id);
        return res.status(200).json({ data: result.jobs });
    } catch (error) {
        console.error("printJobsController error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

module.exports = {
    receiveWebhook,
    printJobsController
};
