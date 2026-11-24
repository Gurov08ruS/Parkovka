import { request, requestMaxCameraAccess, requireAccount, showHistory } from "./app.js";

const dialog = document.querySelector("#report-dialog");
const form = document.querySelector("#report-form");
const locateButton = document.querySelector("#locate");
const cameraButton = document.querySelector("#open-camera");
const detailButton = document.querySelector("#open-detail");
const removeDetail = document.querySelector("#remove-detail");
const takeButton = document.querySelector("#take-photo");
const playButton = document.querySelector("#play-camera");
const switchButton = document.querySelector("#switch-camera");
const cameraToolbar = document.querySelector("#camera-toolbar");
const cancelCameraButton = document.querySelector("#cancel-camera");
const flashButton = document.querySelector("#camera-flash");
const cameraViewStatus = document.querySelector("#camera-view-status");
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
const defaultCamera = { facingMode: { ideal: "environment" } };
const cameraMessages = new Map([
    ["NotAllowedError", "Разрешите доступ к камере в настройках браузера и устройства."],
    ["NotFoundError", "Камера не найдена. Подключите камеру или проверьте настройки устройства."],
    ["NotReadableError", "Камера недоступна. Закройте приложения, которые могут её использовать, и повторите попытку."],
    ["AbortError", "Устройство прервало запуск камеры. Попробуйте ещё раз."],
    ["OverconstrainedError", "Камера не поддерживает выбранный режим съёмки."],
    ["SecurityError", "Браузер запретил доступ к камере. Проверьте настройки сайта."],
    ["InvalidStateError", "Откройте эту вкладку и попробуйте снова."],
    ["NotSupportedError", "Устройство не поддерживает предпросмотр камеры."],
    ["TypeError", "Не удалось включить камеру в этом браузере."],
    ["MaxAppPermissionDenied", "Разрешите доступ к камере в настройках мини-приложения MAX."],
    ["MaxSystemPermissionDenied", "Разрешите доступ MAX к камере в настройках устройства."],
]);

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
let preferredCamera = defaultCamera;
let lastCamera = null;
let flash = "off";
let flashAvailable = false;
let changingFlash = false;
let capturing = false;
let locating = false;
let openingCamera = false;
let saving = false;

function deviceFailure(device, stage, code, details = {}) {
    const inMax = Boolean(window.WebApp || new URLSearchParams(location.hash.slice(1)).has("WebAppData"));
    const event = { stage, code, secure_context: window.isSecureContext, in_max: inMax, ...details };
    console.warn("Ошибка устройства", device, event);
    void request(`/api/diagnostics/${device}`, event).catch(() => {
        console.warn("Запись не дошла до серверного журнала.");
    });
}

function cameraFailure(stage, code, message) {
    cameraStatus.textContent = message;
    cameraViewStatus.textContent = message;
    deviceFailure("camera", stage, code, { photo: photoKind });
}

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
    const cameraBusy = openingCamera || capturing || changingFlash;
    takeButton.disabled = cameraBusy || !stream || !playButton.hidden || !hasCameraFrame();
    cameraToolbar.hidden = !cameraActive && !lastCamera;
    cancelCameraButton.hidden = !cameraActive;
    switchButton.disabled = cameraBusy || !lastCamera || saved;
    flashButton.disabled = cameraBusy || !stream;
    flashButton.hidden = !cameraActive || !flashAvailable;
    flashButton.setAttribute("aria-pressed", String(flash !== "off"));
    closeButton.disabled = saving;
    saveButton.disabled = !position || !photo || locating || openingCamera || cameraActive || saving || saved;
    saveButton.hidden = saved;
    showSubmitted.hidden = !saved;
}

function hasCameraFrame() {
    return !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

function stopCamera() {
    const activeStream = stream;
    stream = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    flash = "off";
    changingFlash = capturing = false;
    flashAvailable = false;
    playButton.hidden = true;
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
    lastCamera = null;
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

function getPosition(enableHighAccuracy) {
    return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy,
            maximumAge: enableHighAccuracy ? 0 : 30000,
            timeout: enableHighAccuracy ? 7000 : 10000,
        });
    });
}

async function locate() {
    if (!window.isSecureContext) {
        locationStatus.textContent = secureContextMessage;
        deviceFailure("location", "context", "insecure_context");
        return;
    }
    if (!navigator.geolocation) {
        locationStatus.textContent = "Этот браузер не поддерживает геолокацию.";
        deviceFailure("location", "context", "api_unavailable");
        return;
    }

    const current = session;
    locating = true;
    updateButtons();
    locationStatus.textContent = "Запрашиваем местоположение…";
    try {
        let result;
        try {
            result = await getPosition(true);
        } catch (error) {
            if (current !== session) return;
            if (error?.code !== 2 && error?.code !== 3) throw error;
            locationStatus.textContent = "Точная позиция недоступна. Пробуем обычный режим…";
            result = await getPosition(false);
        }
        if (current !== session) return;
        const { coords } = result;
        if (!Number.isFinite(coords.latitude) || Math.abs(coords.latitude) > 90
            || !Number.isFinite(coords.longitude) || Math.abs(coords.longitude) > 180) {
            throw { code: "invalid_coordinates" };
        }
        position = { latitude: coords.latitude, longitude: coords.longitude };
        address = captureId = null;
        const accuracy = Number.isFinite(coords.accuracy) ? ` (точность ±${Math.round(coords.accuracy)} м)` : "";
        const display = `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}${accuracy}`;
        locationStatus.textContent = `${display}. Ищем адрес…`;
        try {
            const result = await request("/api/geocode", position);
            if (current !== session) return;
            address = result.address;
        } catch {
            if (current !== session) return;
            deviceFailure("location", "address", "lookup_failed");
        }
        locationStatus.textContent = address
            ? `Ближайший адрес: ${address}. ${display}.`
            : `Адрес недоступен. В обращении будут координаты: ${display}.`;
        locateButton.textContent = "Определить заново";
    } catch (error) {
        if (current !== session) return;
        const previous = position ? " Сохранено предыдущее местоположение." : "";
        const code = ({ 1: "permission_denied", 2: "position_unavailable", 3: "timeout" })[error?.code]
            || (error?.code === "invalid_coordinates" ? "invalid_coordinates" : "unknown_error");
        locationStatus.textContent = (code === "permission_denied"
            ? "Разрешите доступ к геолокации в настройках сайта и устройства."
            : "Устройство не смогло определить местоположение. Проверьте, включены ли службы геолокации, и повторите попытку.") + previous;
        deviceFailure("location", "position", code);
    } finally {
        if (current === session) {
            locating = false;
            updateButtons();
        }
    }
}

async function openCamera(kind) {
    photoKind = kind;
    if (!window.isSecureContext) {
        cameraFailure("context", "insecure_context", secureContextMessage);
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        cameraFailure("context", "api_unavailable", "Этот браузер не поддерживает съёмку с камеры.");
        return;
    }

    const current = session;
    let stage = "max_permissions";
    openingCamera = true;
    updateButtons();
    cameraStatus.textContent = "Запрашиваем доступ к камере…";
    try {
        const bridgeAccess = requestMaxCameraAccess();
        if (bridgeAccess) await bridgeAccess;
        if (current !== session) return;
        stage = "stream";
        let activeStream;
        try {
            activeStream = await navigator.mediaDevices.getUserMedia({ video: preferredCamera, audio: false });
        } catch (error) {
            if (current !== session) return;
            if (preferredCamera === defaultCamera || !["NotFoundError", "OverconstrainedError"].includes(error?.name)) throw error;
            preferredCamera = defaultCamera;
            activeStream = await navigator.mediaDevices.getUserMedia({ video: preferredCamera, audio: false });
        }
        await showCamera(activeStream, current);
    } catch (error) {
        if (current !== session) return;
        const code = cameraMessages.has(error?.name)
            ? error.name
            : (stage === "max_permissions" ? "MaxPermissionError" : "UnknownError");
        stopCamera();
        cameraFailure(stage, code, cameraMessages.get(code) || "Не удалось открыть камеру. Попробуйте ещё раз.");
    } finally {
        if (current === session) {
            openingCamera = false;
            updateButtons();
        }
    }
}

async function showCamera(activeStream, current) {
    if (current !== session || document.hidden) {
        activeStream.getTracks().forEach((track) => track.stop());
        if (current === session) {
            cameraFailure("stream", "document_hidden", "Вернитесь во вкладку приложения и откройте камеру ещё раз.");
        }
        return;
    }
    stream = activeStream;
    const [track] = stream.getVideoTracks();
    if (!track) throw new DOMException("", "NotFoundError");
    lastCamera = track.getSettings();
    const torch = track.getCapabilities?.().torch;
    flashAvailable = torch === true || (Array.isArray(torch) && torch.includes(true) && torch.includes(false));
    track.addEventListener("ended", () => {
        if (stream === activeStream) {
            stopCamera();
            cameraFailure("stream", "track_ended", "Камера отключилась. Откройте её ещё раз.");
        }
    });
    cameraView.hidden = false;
    photoPreviews.hidden = true;
    video.defaultMuted = video.muted = true;
    video.srcObject = activeStream;
    cameraStatus.textContent = "Камера подключена. Ждём первый кадр…";
    cameraViewStatus.textContent = "Камера подключена. Ждём первый кадр…";
    cameraView.scrollIntoView({ block: "nearest" });
    updateButtons();
    await playCamera();
}

async function playCamera() {
    const activeStream = stream;
    if (!activeStream) return;
    const listeners = new AbortController();
    let timer;
    let framePoll;
    playButton.disabled = true;
    try {
        const frame = new Promise((resolve) => {
            const check = () => {
                if (hasCameraFrame()) resolve();
            };
            for (const event of ["loadedmetadata", "loadeddata", "playing", "resize", "timeupdate"]) {
                video.addEventListener(event, check, { signal: listeners.signal });
            }
            framePoll = setInterval(check, 150);
            check();
        });
        await Promise.race([
            Promise.all([video.play(), frame]),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new DOMException("", "preview_timeout")), 8000);
            }),
        ]);
        if (stream !== activeStream) return;
        playButton.hidden = true;
        cameraStatus.textContent = photoKind === "overview"
            ? photoPrompt
            : "Крупным планом снимите знак или госномер, который хуже виден на первом кадре.";
        cameraViewStatus.textContent = cameraStatus.textContent;
        cameraView.scrollIntoView({ block: "nearest" });
    } catch (error) {
        if (stream !== activeStream) return;
        if (error?.name === "NotAllowedError") {
            playButton.hidden = false;
            cameraFailure("preview", "NotAllowedError", "Камера подключена. Нажмите «Запустить предпросмотр».");
            cameraView.scrollIntoView({ block: "nearest" });
        } else if (error?.name === "preview_timeout") {
            playButton.hidden = false;
            cameraFailure("preview", "preview_timeout", "Камера не передала кадр. Запустите предпросмотр заново или выберите другую камеру.");
        } else {
            const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
            stopCamera();
            cameraFailure("preview", code, "Камера не показывает изображение. Откройте её ещё раз.");
        }
    } finally {
        listeners.abort();
        clearInterval(framePoll);
        clearTimeout(timer);
        playButton.disabled = false;
        updateButtons();
    }
}

async function switchCamera() {
    if (switchButton.disabled || !lastCamera) return;
    const current = session;
    const activeStream = stream;
    const { deviceId, facingMode } = lastCamera;
    openingCamera = true;
    updateButtons();
    try {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (current !== session || stream !== activeStream) return;
        const cameras = devices.filter((device) => device.kind === "videoinput" && device.deviceId);
        const index = cameras.findIndex((device) => device.deviceId === deviceId);
        const nextId = cameras.length > 1 && index >= 0 ? cameras[(index + 1) % cameras.length].deviceId : null;
        const opposite = facingMode === "environment" ? "user" : facingMode === "user" ? "environment" : null;
        const choices = [];
        if (opposite) choices.push({ facingMode: { exact: opposite } });
        if (nextId) choices.push({ deviceId: { exact: nextId } });
        if (!choices.length) {
            cameraStatus.textContent = "Браузер видит только одну камеру.";
            cameraViewStatus.textContent = cameraStatus.textContent;
            return;
        }

        const previous = deviceId ? { deviceId: { exact: deviceId } } : preferredCamera;
        cameraStatus.textContent = "Переключаем камеру…";
        stopCamera();
        for (const video of choices) {
            let next;
            try {
                next = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            } catch {
                if (current !== session || document.hidden) return;
                continue;
            }
            const nextDeviceId = next.getVideoTracks()[0]?.getSettings().deviceId;
            if (deviceId && nextDeviceId === deviceId) {
                next.getTracks().forEach((item) => item.stop());
                continue;
            }
            if (current === session && !document.hidden) preferredCamera = video;
            await showCamera(next, current);
            return;
        }

        if (activeStream) {
            await showCamera(await navigator.mediaDevices.getUserMedia({ video: previous, audio: false }), current);
        }
        if (current !== session) return;
        cameraFailure("switch", "NotFoundError", stream && playButton.hidden
            ? "Не удалось открыть другую камеру. Текущая камера восстановлена."
            : "Не удалось открыть другую камеру. Проверьте доступные камеры в настройках браузера.");
    } catch (error) {
        if (current !== session) return;
        stopCamera();
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        cameraFailure("switch", code, "Не удалось переключить камеру. Откройте её ещё раз.");
    } finally {
        if (current === session) {
            openingCamera = false;
            updateButtons();
        }
    }
}

async function toggleFlash() {
    if (!stream || flashButton.disabled) return;
    const activeStream = stream;
    const [track] = activeStream.getVideoTracks();
    if (!flashAvailable) return;
    const next = flash === "off" ? "torch" : "off";
    changingFlash = true;
    updateButtons();
    try {
        await track.applyConstraints({ advanced: [{ torch: next === "torch" }] });
        if (stream !== activeStream) return;
        if (next === "torch" && track.getSettings().torch === false) throw new Error("torch unavailable");
        flash = next;
        cameraStatus.textContent = flash === "off" ? "Вспышка выключена."
            : "Подсветка камеры включена.";
        cameraViewStatus.textContent = cameraStatus.textContent;
    } catch (error) {
        if (stream !== activeStream) return;
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        if (next === "torch") flashAvailable = false;
        cameraFailure("flash", code, "Не удалось переключить подсветку камеры.");
    } finally {
        if (stream === activeStream) {
            changingFlash = false;
            updateButtons();
        }
    }
}

function takePhoto() {
    if (takeButton.disabled) return;
    if (!stream?.getVideoTracks().some((track) => track.readyState === "live")
        || !hasCameraFrame()) {
        cameraFailure("capture", "frame_unavailable", "Кадр ещё недоступен. Повторите съёмку.");
        return;
    }

    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    let image;
    try {
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        image = canvas.toDataURL("image/jpeg", 0.85);
    } catch (error) {
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        cameraFailure("capture", code, "Не удалось сохранить кадр. Попробуйте ещё раз.");
        return;
    }
    const encoded = image.split(",", 2)[1];
    if (!image.startsWith("data:image/jpeg;base64,")) {
        cameraFailure("capture", "invalid_jpeg", "Не удалось создать снимок JPEG. Попробуйте ещё раз.");
        return;
    }
    if (!encoded || encoded.length * 3 / 4 > 2 * 1024 * 1024 + 2) {
        cameraFailure("capture", "photo_too_large", "Снимок слишком большой. Попробуйте ещё раз.");
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
    lastCamera = null;
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
video.addEventListener("playing", updateButtons);
video.addEventListener("error", () => {
    if (!stream || !video.error) return;
    stopCamera();
    cameraFailure("preview", "video_error", "Предпросмотр прервался. Откройте камеру ещё раз.");
});
playButton.addEventListener("click", playCamera);
switchButton.addEventListener("click", switchCamera);
flashButton.addEventListener("click", toggleFlash);
takeButton.addEventListener("click", takePhoto);
cancelCameraButton.addEventListener("click", () => {
    lastCamera = null;
    stopCamera();
    cameraStatus.textContent = photo ? "Проверьте, что знак и госномер хорошо видны на снимках." : photoPrompt;
    (photoKind === "detail" ? detailButton : cameraButton).focus();
});
form.addEventListener("submit", saveReport);
document.addEventListener("visibilitychange", () => {
    if (document.hidden && stream) {
        stopCamera();
        cameraFailure("stream", "document_hidden", "Камера остановлена, пока вкладка была скрыта. Откройте её ещё раз.");
    }
});
window.addEventListener("pagehide", stopCamera);
