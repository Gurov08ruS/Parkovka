import { request, requestMaxCameraAccess, requireAccount, showHistory } from "./app.js";

const dialog = document.querySelector("#report-dialog");
const form = document.querySelector("#report-form");
const locateButton = document.querySelector("#locate");
const cameraButton = document.querySelector("#open-camera");
const detailButton = document.querySelector("#open-detail");
const removeDetail = document.querySelector("#remove-detail");
const takeButton = document.querySelector("#take-photo");
const saveButton = document.querySelector("#save-report");
const closeButton = document.querySelector("#close-report");
const locationStatus = document.querySelector("#location-status");
const cameraStatus = document.querySelector("#camera-status");
const saveStatus = document.querySelector("#save-status");
const cameraView = document.querySelector("#camera-view");
const video = document.querySelector("#camera-preview");
const preview = document.querySelector("#photo-preview");
const detailPreview = document.querySelector("#detail-preview");
const photoPreviews = document.querySelector("#photo-previews");
const comment = document.querySelector("#report-comment");
const showSubmitted = document.querySelector("#show-submitted");

const locationPrompt = "Разрешите доступ к геолокации, чтобы определить адрес.";
const photoPrompt = "На одном или двух кадрах должны быть видны парковочный знак и госномер автомобиля.";
const secureContextMessage = "По HTTP в локальной сети браузер блокирует доступ. Используйте доверенный HTTPS или откройте 127.0.0.1 на компьютере с сервером.";

let session = 0;
let position = null;
let address = null;
let photo = null;
let detailPhoto = null;
let capturedAt = null;
let photoKind = "overview";
let captureId = null;
let submittedId = null;
let stream = null;
let locating = false;
let openingCamera = false;
let saving = false;

function updateButtons() {
    const saved = submittedId !== null;
    const cameraActive = Boolean(stream);
    locateButton.disabled = locating || saving || saved;
    cameraButton.hidden = cameraActive;
    cameraButton.disabled = openingCamera || cameraActive || saving || saved;
    detailButton.hidden = cameraActive || !photo;
    detailButton.disabled = cameraButton.disabled || !photo;
    removeDetail.hidden = cameraActive || !detailPhoto;
    removeDetail.disabled = cameraButton.disabled;
    comment.disabled = saving || saved;
    takeButton.disabled = openingCamera || !stream || video.readyState < 2;
    closeButton.disabled = saving;
    saveButton.disabled = !position || !photo || locating || openingCamera || cameraActive || saving || saved;
    saveButton.hidden = saved;
    showSubmitted.hidden = !saved;
}

function stopCamera() {
    const activeStream = stream;
    stream = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    cameraView.hidden = true;
    photoPreviews.hidden = !photo;
    preview.closest("figure").hidden = !photo;
    detailPreview.closest("figure").hidden = !detailPhoto;
    updateButtons();
}

function clearDraft() {
    session += 1;
    position = address = photo = detailPhoto = capturedAt = captureId = submittedId = null;
    locating = openingCamera = saving = false;
    stopCamera();
    preview.removeAttribute("src");
    detailPreview.removeAttribute("src");
    comment.value = "";
    locateButton.textContent = "Определить местоположение";
    cameraButton.textContent = "Открыть камеру";
    detailButton.textContent = "Сделать второе фото";
    locationStatus.textContent = locationPrompt;
    cameraStatus.textContent = photoPrompt;
    saveStatus.textContent = "";
}

async function locate() {
    if (!window.isSecureContext || !navigator.geolocation) {
        locationStatus.textContent = window.isSecureContext
            ? "Этот браузер не поддерживает геолокацию."
            : secureContextMessage;
        return;
    }

    const current = session;
    locating = true;
    updateButtons();
    locationStatus.textContent = "Запрашиваем местоположение…";
    try {
        const { coords } = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 12000,
            });
        });
        if (current !== session) return;
        position = { latitude: coords.latitude, longitude: coords.longitude };
        address = captureId = null;
        const display = `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)} (точность ±${Math.round(coords.accuracy)} м)`;
        locationStatus.textContent = `${display}. Ищем адрес…`;
        try {
            const result = await request("/api/geocode", position);
            if (current !== session) return;
            address = result.address;
        } catch {
            if (current !== session) return;
        }
        locationStatus.textContent = address
            ? `Ближайший адрес: ${address}. ${display}.`
            : `Адрес недоступен. В обращении будут координаты: ${display}.`;
        locateButton.textContent = "Определить заново";
    } catch (error) {
        if (current !== session) return;
        const previous = position ? " Сохранено предыдущее местоположение." : "";
        locationStatus.textContent = (error.code === 1
            ? "Разрешите доступ к геолокации в настройках сайта и попробуйте ещё раз."
            : "Не удалось получить местоположение. Попробуйте ещё раз.") + previous;
    } finally {
        if (current === session) {
            locating = false;
            updateButtons();
        }
    }
}

async function openCamera(kind) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        cameraStatus.textContent = window.isSecureContext
            ? "Этот браузер не поддерживает съёмку с камеры."
            : secureContextMessage;
        return;
    }

    const current = session;
    photoKind = kind;
    openingCamera = true;
    updateButtons();
    cameraStatus.textContent = "Запрашиваем доступ к камере…";
    try {
        await requestMaxCameraAccess();
        if (current !== session) return;
        const activeStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
        });
        if (current !== session || document.hidden) {
            activeStream.getTracks().forEach((track) => track.stop());
            if (current === session) cameraStatus.textContent = "Откройте камеру ещё раз.";
            return;
        }
        stream = activeStream;
        stream.getVideoTracks()[0].addEventListener("ended", () => {
            if (stream === activeStream) {
                stopCamera();
                cameraStatus.textContent = "Камера отключилась. Откройте её ещё раз.";
            }
        });
        video.srcObject = stream;
        cameraView.hidden = false;
        photoPreviews.hidden = true;
        updateButtons();
        await video.play();
        if (stream === activeStream) {
            cameraStatus.textContent = kind === "overview"
                ? photoPrompt
                : "Крупным планом снимите знак или госномер, который хуже виден на первом кадре.";
            cameraView.scrollIntoView({ block: "nearest" });
        }
    } catch (error) {
        if (current !== session) return;
        stopCamera();
        cameraStatus.textContent = error?.name === "NotAllowedError"
            ? (error.message?.includes("MAX") ? error.message
                : "Разрешите доступ к камере в настройках сайта и попробуйте ещё раз.")
            : "Не удалось открыть камеру. Проверьте, что она доступна.";
    } finally {
        if (current === session) {
            openingCamera = false;
            updateButtons();
        }
    }
}

function takePhoto() {
    if (!stream?.getVideoTracks().some((track) => track.readyState === "live")
        || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.85);
    const encoded = image.split(",", 2)[1];
    if (!image.startsWith("data:image/jpeg;base64,")) {
        cameraStatus.textContent = "Не удалось создать снимок JPEG. Попробуйте ещё раз.";
        return;
    }
    if (!encoded || encoded.length * 3 / 4 > 2 * 1024 * 1024 + 2) {
        cameraStatus.textContent = "Снимок слишком большой. Попробуйте ещё раз.";
        return;
    }
    captureId = null;
    if (photoKind === "overview") {
        photo = encoded;
        capturedAt = new Date().toISOString();
        preview.src = image;
        cameraButton.textContent = "Переснять основное фото";
    } else {
        detailPhoto = encoded;
        detailPreview.src = image;
        detailButton.textContent = "Переснять второе фото";
    }
    cameraStatus.textContent = "Проверьте, что знак и госномер хорошо видны на снимках.";
    stopCamera();
    photoPreviews.scrollIntoView({ block: "nearest" });
}

async function saveReport(event) {
    event.preventDefault();
    if (saveButton.disabled) return;

    captureId ??= crypto.randomUUID();
    saving = true;
    updateButtons();
    saveStatus.textContent = "Отправляем обращение…";
    try {
        const result = await request("/api/reports/capture", {
            ...position, address, photo, detail_photo: detailPhoto, captured_at: capturedAt,
            comment: comment.value, capture_id: captureId,
        });
        submittedId = result.id;
        saveStatus.textContent = `Обращение №${result.id} принято на внутреннюю проверку.`;
    } catch (error) {
        saveStatus.textContent = error.message;
        if (error.status === 401) {
            requireAccount(() => {
                saveStatus.textContent = "Вход выполнен. Повторите отправку.";
            });
        }
    } finally {
        saving = false;
        updateButtons();
    }
}

document.querySelector("#open-report").addEventListener("click", () => {
    requireAccount(() => {
        if (dialog.open) return;
        clearDraft();
        dialog.showModal();
    });
});
closeButton.addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
});
dialog.addEventListener("close", clearDraft);
for (const eventName of ["dragover", "drop"]) {
    dialog.addEventListener(eventName, (event) => event.preventDefault());
}
locateButton.addEventListener("click", locate);
cameraButton.addEventListener("click", () => openCamera("overview"));
detailButton.addEventListener("click", () => openCamera("detail"));
removeDetail.addEventListener("click", () => {
    detailPhoto = captureId = null;
    detailPreview.removeAttribute("src");
    detailButton.textContent = "Сделать второе фото";
    stopCamera();
});
comment.addEventListener("input", () => { captureId = null; });
showSubmitted.addEventListener("click", () => {
    const identifier = submittedId;
    dialog.close();
    showHistory(identifier);
});
video.addEventListener("loadeddata", updateButtons);
takeButton.addEventListener("click", takePhoto);
document.querySelector("#cancel-camera").addEventListener("click", () => {
    stopCamera();
    cameraStatus.textContent = photo ? "Проверьте, что знак и госномер хорошо видны на снимках." : photoPrompt;
    (photoKind === "detail" ? detailButton : cameraButton).focus();
});
form.addEventListener("submit", saveReport);
document.addEventListener("visibilitychange", () => {
    if (document.hidden && stream) {
        stopCamera();
        cameraStatus.textContent = "Откройте камеру ещё раз.";
    }
});
window.addEventListener("pagehide", stopCamera);
