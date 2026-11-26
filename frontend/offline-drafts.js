import { request } from "./ui.js";

let database;

function openDatabase() {
    database ??= new Promise((resolve, reject) => {
        const open = indexedDB.open("parkovka-offline", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("drafts", { keyPath: "capture_id" })
            .createIndex("owner", "owner_max_id");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    }).catch((error) => {
        database = null;
        throw error;
    });
    return database;
}

async function draftOperation(mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("drafts", mode);
        const operation = action(transaction.objectStore("drafts"));
        transaction.oncomplete = () => resolve(operation.result);
        transaction.onabort = () => reject(transaction.error);
    });
}

export function saveOfflineDraft(data) {
    return draftOperation("readwrite", (drafts) => drafts.put(data));
}

export function removeOfflineDraft(captureId) {
    return draftOperation("readwrite", (drafts) => drafts.delete(captureId));
}

export async function uploadOfflineDrafts(owner, activeCapture) {
    for (const draft of await draftOperation("readonly", (drafts) => drafts.index("owner").getAll(owner))) {
        if (draft.capture_id === activeCapture()) continue;
        try {
            await request("/api/reports/capture/draft", draft);
        } catch (error) {
            if (error.status !== 410) throw error;
        }
        await removeOfflineDraft(draft.capture_id);
    }
}
