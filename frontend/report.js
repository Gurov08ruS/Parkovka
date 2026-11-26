import { registerDraftEditor, requestMaxCameraAccess, maxCameraSettings, requireAccount, showHistory } from "./app.js";
import { request, initData, withTimeout } from "./ui.js";

const dialog = document.querySelector("#report-dialog");
const form = document.querySelector("#report-form");
const locateButton = document.querySelector("#locate");
const cameraButton = document.querySelector("#open-camera");
const cameraSettingsButton = document.querySelector("#camera-settings");
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
const draftStatus = document.querySelector("#draft-status");
const cameraView = document.querySelector("#camera-view");
const video = document.querySelector("#camera-preview");
const preview = document.querySelector("#photo-preview");
const detailPreview = document.querySelector("#detail-preview");
const photoPreviews = document.querySelector("#photo-previews");
const comment = document.querySelector("#report-comment");
const plateNumber = document.querySelector("#plate-number");
const showSubmitted = document.querySelector("#show-submitted");
const photoStep = document.querySelector("#photo-step");
const reviewStep = document.querySelector("#review-step");
const placeholder = document.querySelector("#photo-placeholder");
const nextStep = document.querySelector("#next-step");
const previousStep = document.querySelector("#previous-step");
const skipDetail = document.querySelector("#skip-detail");
const reviewPhotos = document.querySelector("#review-photos");

const locationPrompt = "Разрешите доступ к геолокации, чтобы определить адрес";
const photoPrompt = "На одном или двух кадрах должны быть видны парковочный знак и госномер автомобиля";
const secureContextMessage = "По HTTP в локальной сети браузер блокирует доступ. Используйте доверенный HTTPS или откройте 127.0.0.1 на компьютере с сервером";
const defaultCamera = { facingMode: { ideal: "environment" } };
const cameraMessages = new Map([
    ["NotAllowedError", "Разрешите доступ к камере в настройках браузера и устройства"],
    ["NotFoundError", "Камера не найдена. Подключите камеру или проверьте настройки устройства"],
    ["NotReadableError", "Камера недоступна. Закройте приложения, которые могут её использовать, и повторите попытку"],
    ["AbortError", "Устройство прервало запуск камеры. Попробуйте ещё раз"],
    ["OverconstrainedError", "Камера не поддерживает выбранный режим съёмки"],
    ["SecurityError", "Браузер запретил доступ к камере. Проверьте настройки сайта"],
    ["InvalidStateError", "Откройте эту вкладку и попробуйте снова"],
    ["NotSupportedError", "Устройство не поддерживает предпросмотр камеры"],
    ["TypeError", "Не удалось включить камеру в этом браузере"],
    ["MaxAppPermissionDenied", "Разрешите доступ к камере в настройках мини-приложения MAX"],
    ["MaxSystemPermissionDenied", "Разрешите доступ MAX к камере в настройках устройства"],
    ["MaxPermissionError", "Не удалось получить доступ к камере в MAX. Попробуйте ещё раз"],
    ["MaxPermissionTimeout", "MAX не ответил на запрос доступа. Проверьте разрешения камеры и попробуйте ещё раз"],
    ["CameraStreamTimeout", "Камера не ответила. Проверьте разрешения и попробуйте ещё раз"],
]);

let session = 0;
let step = 1;
let position = null;
let address = null;
let photo = null;
let detailPhoto = null;
let capturedAt = null;
let photoKind = "overview";
let captureId = null;
let captureOwner = null;
let submittedId = null;
let draftRevision = 0;
let savedRevision = 0;
let draftTimer;
let draftSave = null;
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
let openCameraSettings;

function deviceFailure(device, stage, code, details = {}) {
    const inMax = Boolean(initData());
    const platform = inMax
        ? window.WebApp?.platform || new URLSearchParams(location.hash.slice(1)).get("WebAppPlatform") || "unknown"
        : "browser";
    const event = { stage, code, secure_context: Boolean(window.isSecureContext), in_max: inMax, platform, ...details };
    console.warn("Ошибка устройства", device, event);
    void request(`/api/diagnostics/${device}`, event, { keepalive: true }).catch(() => {
        console.warn("Запись не дошла до серверного журнала.");
    });
}

function cameraFailure(stage, code, message, { settings = code, ...details } = {}) {
    cameraStatus.textContent = message;
    cameraViewStatus.textContent = message;
    openCameraSettings = maxCameraSettings(settings);
    cameraSettingsButton.hidden = !openCameraSettings;
    deviceFailure("camera", stage, code, { photo: photoKind, ...details });
}

function updateButtons() {
    const saved = submittedId !== null;
    const cameraActive = Boolean(stream);
    locateButton.disabled = locating || saving || saved;
    cameraButton.hidden = cameraActive || step !== 1;
    cameraButton.disabled = openingCamera || cameraActive || saving || saved;
    detailButton.hidden = cameraActive || step !== 2;
    detailButton.disabled = cameraButton.disabled || !photo;
    removeDetail.hidden = cameraActive || step !== 2 || !detailPhoto;
    removeDetail.disabled = cameraButton.disabled;
    comment.disabled = saving || saved;
    plateNumber.disabled = saving || saved;
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
    nextStep.disabled = openingCamera || saving || (step === 1 ? !photo : !detailPhoto);
    nextStep.hidden = step === 3;
    skipDetail.hidden = step !== 2 || Boolean(detailPhoto);
    skipDetail.disabled = openingCamera || saving;
    previousStep.hidden = step !== 2;
    previousStep.disabled = openingCamera || saving;
    const backToPhotos = document.querySelector("#back-to-photos");
    backToPhotos.hidden = saved;
    backToPhotos.disabled = saving;
    photoPreviews.hidden = step === 3 || !(step === 1 ? photo : detailPhoto);
    preview.closest("figure").hidden = step !== 1 || !photo;
    detailPreview.closest("figure").hidden = step !== 2 || !detailPhoto;
    placeholder.hidden = !photoPreviews.hidden;
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
    updateButtons();
}

function resetReport() {
    session += 1;
    step = 1;
    position = address = photo = detailPhoto = capturedAt = captureId = captureOwner = submittedId = null;
    draftRevision = savedRevision = 0;
    draftSave = null;
    clearTimeout(draftTimer);
    window.removeEventListener("beforeunload", protectDraft);
    locating = openingCamera = saving = false;
    openCameraSettings = undefined;
    cameraSettingsButton.hidden = true;
    lastCamera = null;
    stopCamera();
    preview.removeAttribute("src");
    detailPreview.removeAttribute("src");
    comment.value = "";
    plateNumber.value = "";
    locateButton.textContent = "Определить местоположение";
    cameraButton.textContent = "Открыть камеру";
    detailButton.textContent = "Сделать второе фото";
    locationStatus.textContent = locationPrompt;
    cameraStatus.textContent = photoPrompt;
    saveStatus.textContent = "";
    draftStatus.textContent = "";
    showStep(1);
}

function showStep(value) {
    step = value;
    photoStep.hidden = step === 3;
    reviewStep.hidden = step !== 3;
    document.querySelector("#step-count").textContent = `Шаг ${step} из 3`;
    document.querySelector("#step-name").textContent = ["Общий вид", "Государственный номер", "Проверка"][step - 1];
    document.querySelector(".step-progress").setAttribute("aria-valuenow", String(step));
    document.querySelector("#step-progress").style.width = `${step * 100 / 3}%`;
    document.querySelector("#photo-title").textContent = step === 1
        ? "Сделайте фото автомобиля на парковочном месте" : "Сделайте фото государственного номера";
    cameraStatus.textContent = step === 1
        ? "В кадре должны быть видны автомобиль, парковочное место и знак или разметка"
        : "На снимке должен быть чётко виден номер этого же автомобиля";
    nextStep.textContent = step === 1 ? "К следующему фото" : "Перейти к проверке";
    reviewPhotos.replaceChildren();
    for (const [source, label] of [[photo && preview.src, "Фото автомобиля"], [detailPhoto && detailPreview.src, "Фото номера"]]) {
        if (!source) continue;
        const image = document.createElement("img");
        image.src = source;
        image.alt = label;
        reviewPhotos.append(image);
    }
    updateButtons();
    dialog.scrollTop = 0;
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
        locationStatus.textContent = "Этот браузер не поддерживает геолокацию";
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
        if (current !== session || saving) return;
        const { coords } = result;
        if (!Number.isFinite(coords.latitude) || Math.abs(coords.latitude) > 90
            || !Number.isFinite(coords.longitude) || Math.abs(coords.longitude) > 180) {
            throw { code: "invalid_coordinates" };
        }
        position = { latitude: coords.latitude, longitude: coords.longitude };
        address = null;
        scheduleDraft();
        const accuracy = Number.isFinite(coords.accuracy) ? ` (точность ±${Math.round(coords.accuracy)} м)` : "";
        const display = `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}${accuracy}`;
        locationStatus.textContent = `${display}. Ищем адрес…`;
        try {
            const result = await request("/api/geocode", position);
            if (current !== session || saving) return;
            address = result.address;
            if (address) scheduleDraft();
            else deviceFailure("location", "address", "address_not_found");
        } catch {
            if (current !== session) return;
            deviceFailure("location", "address", "lookup_failed");
        }
        locationStatus.textContent = address
            ? `Ближайший адрес: ${address}. ${display}`
            : `Адрес недоступен. В обращении будут координаты: ${display}`;
        locateButton.textContent = "Определить заново";
    } catch (error) {
        if (current !== session) return;
        const code = ({ 1: "permission_denied", 2: "position_unavailable", 3: "timeout" })[error?.code]
            || (error?.code === "invalid_coordinates" ? "invalid_coordinates" : "unknown_error");
        const message = code === "permission_denied"
            ? "Разрешите доступ к геолокации в настройках сайта и устройства"
            : "Устройство не смогло определить местоположение. Проверьте, включены ли службы геолокации, и повторите попытку";
        locationStatus.textContent = position ? `${message}. Сохранено предыдущее местоположение` : message;
        deviceFailure("location", "position", code);
    } finally {
        if (current === session) {
            locating = false;
            updateButtons();
        }
    }
}

async function getCameraStream(video) {
    let expired = false;
    const pending = navigator.mediaDevices.getUserMedia({ video, audio: false }).then((stream) => {
        if (expired) stream.getTracks().forEach((track) => track.stop());
        return stream;
    });
    try {
        return await withTimeout(pending, 25000, "CameraStreamTimeout");
    } catch (error) {
        expired = true;
        throw error;
    }
}

async function openCamera(kind) {
    photoKind = kind;
    openCameraSettings = undefined;
    cameraSettingsButton.hidden = true;
    if (!window.isSecureContext) {
        cameraFailure("context", "insecure_context", secureContextMessage);
        return;
    }
    const current = session;
    let maxPermissionIssue;
    openingCamera = true;
    updateButtons();
    cameraStatus.textContent = "Запрашиваем доступ к камере…";
    try {
        try {
            await requestMaxCameraAccess();
        } catch (error) {
            if (current !== session) return;
            maxPermissionIssue = error.name;
            const details = { photo: kind, bridge_code: error.bridgeCode, bridge_step: error.bridgeStep };
            if (maxPermissionIssue === "MaxAppPermissionDenied") {
                cameraFailure("max_permissions", maxPermissionIssue, cameraMessages.get(maxPermissionIssue), details);
                return;
            }
            deviceFailure("camera", "max_permissions", maxPermissionIssue, details);
        }
        if (current !== session) return;
        const policy = document.permissionsPolicy ?? document.featurePolicy;
        if (policy?.allowsFeature?.("camera") === false) {
            cameraFailure("context", "policy_blocked", "Камера заблокирована для этой страницы. Откройте мини-приложение из чата с ботом MAX");
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            cameraFailure("context", "api_unavailable", "Этот браузер не поддерживает съёмку с камеры");
            return;
        }
        for (const video of new Set([preferredCamera, defaultCamera, true])) {
            let activeStream;
            try {
                activeStream = await getCameraStream(video);
            } catch (error) {
                if (current !== session || video === true || !["NotFoundError", "OverconstrainedError"].includes(error?.name)) throw error;
                continue;
            }
            if (current === session) preferredCamera = video;
            await showCamera(activeStream, current);
            break;
        }
    } catch (error) {
        if (current !== session) return;
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        const settings = code === "NotAllowedError" && maxPermissionIssue === "MaxSystemPermissionDenied" ? maxPermissionIssue : code;
        stopCamera();
        cameraFailure("stream", code, cameraMessages.get(settings) || "Не удалось открыть камеру. Попробуйте ещё раз", { settings });
    } finally {
        if (current === session) {
            openingCamera = false;
            updateButtons();
        }
    }
}

async function showCamera(activeStream, current) {
    if (current !== session || document.hidden || saving) {
        activeStream.getTracks().forEach((track) => track.stop());
        if (current === session && !saving) {
            cameraFailure("stream", "document_hidden", "Вернитесь во вкладку приложения и откройте камеру ещё раз");
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
            cameraFailure("stream", "track_ended", "Камера отключилась. Откройте её ещё раз");
        }
    });
    cameraView.hidden = false;
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
            : "Крупным планом снимите знак или госномер, который хуже виден на первом кадре";
        cameraViewStatus.textContent = cameraStatus.textContent;
        cameraView.scrollIntoView({ block: "nearest" });
    } catch (error) {
        if (stream !== activeStream) return;
        if (error?.name === "NotAllowedError") {
            playButton.hidden = false;
            cameraFailure("preview", "NotAllowedError", "Камера подключена. Нажмите «Запустить предпросмотр»");
            cameraView.scrollIntoView({ block: "nearest" });
        } else if (error?.name === "preview_timeout") {
            playButton.hidden = false;
            cameraFailure("preview", "preview_timeout", "Камера не передала кадр. Запустите предпросмотр заново или выберите другую камеру");
        } else {
            const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
            stopCamera();
            cameraFailure("preview", code, "Камера не показывает изображение. Откройте её ещё раз");
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
            cameraStatus.textContent = "Браузер видит только одну камеру";
            cameraViewStatus.textContent = cameraStatus.textContent;
            return;
        }

        const previous = deviceId ? { deviceId: { exact: deviceId } } : preferredCamera;
        cameraStatus.textContent = "Переключаем камеру…";
        stopCamera();
        for (const video of choices) {
            let next;
            try {
                next = await getCameraStream(video);
            } catch (error) {
                if (current !== session || document.hidden) return;
                if (error?.name === "CameraStreamTimeout") throw error;
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
            await showCamera(await getCameraStream(previous), current);
        }
        if (current !== session) return;
        cameraFailure("switch", "NotFoundError", stream && playButton.hidden
            ? "Не удалось открыть другую камеру. Текущая камера восстановлена"
            : "Не удалось открыть другую камеру. Проверьте доступные камеры в настройках браузера");
    } catch (error) {
        if (current !== session) return;
        stopCamera();
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        cameraFailure("switch", code, "Не удалось переключить камеру. Откройте её ещё раз");
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
        cameraStatus.textContent = flash === "off" ? "Вспышка выключена"
            : "Подсветка камеры включена";
        cameraViewStatus.textContent = cameraStatus.textContent;
    } catch (error) {
        if (stream !== activeStream) return;
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        if (next === "torch") flashAvailable = false;
        cameraFailure("flash", code, "Не удалось переключить подсветку камеры");
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
        cameraFailure("capture", "frame_unavailable", "Кадр ещё недоступен. Повторите съёмку");
        return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    let image;
    try {
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        image = canvas.toDataURL("image/png");
    } catch (error) {
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        cameraFailure("capture", code, "Не удалось сохранить кадр. Попробуйте ещё раз");
        return;
    }
    const encoded = image.split(",", 2)[1];
    if (!image.startsWith("data:image/png;base64,")) {
        cameraFailure("capture", "invalid_image", "Не удалось создать снимок PNG. Попробуйте ещё раз");
        return;
    }
    if (!encoded || encoded.length * 3 / 4 > 64 * 1024 * 1024 + 2) {
        cameraFailure("capture", "photo_too_large", "Снимок слишком большой. Попробуйте ещё раз");
        return;
    }
    captureId ??= crypto.randomUUID();
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
    cameraStatus.textContent = "Проверьте, что знак и госномер хорошо видны на снимках";
    lastCamera = null;
    stopCamera();
    scheduleDraft();
    photoPreviews.scrollIntoView({ block: "nearest" });
}

function capturePayload() {
    return {
        ...position, address, photo, detail_photo: detailPhoto, captured_at: capturedAt,
        comment: comment.value, plate_number: plateNumber.value, capture_id: captureId, owner_max_id: captureOwner,
    };
}

function protectDraft(event) {
    event.preventDefault();
    event.returnValue = "";
}

function flushDraft() {
    clearTimeout(draftTimer);
    if (draftSave) return draftSave;
    if (!photo || submittedId !== null || savedRevision === draftRevision) return Promise.resolve();
    const current = session;
    draftStatus.textContent = "Сохраняем черновик…";
    draftSave = (async () => {
        while (savedRevision !== draftRevision) {
            const revision = draftRevision;
            const result = await request("/api/reports/capture/draft", capturePayload());
            if (current !== session) return;
            savedRevision = revision;
            if (result.submitted_at) {
                submittedId = result.id;
                saveStatus.textContent = `Обращение №${result.id} уже отправлено`;
                updateButtons();
                break;
            }
        }
        window.removeEventListener("beforeunload", protectDraft);
        draftStatus.textContent = submittedId === null ? "Черновик сохранён" : "Обращение уже отправлено";
    })().finally(() => {
        if (current === session) draftSave = null;
    });
    return draftSave;
}

async function autosaveDraft() {
    const current = session;
    try {
        await flushDraft();
    } catch (error) {
        if (current === session) draftStatus.textContent = `Не удалось сохранить черновик. ${error.message}`;
    }
}

function scheduleDraft(delay = 0) {
    if (!photo || submittedId !== null) return;
    draftRevision += 1;
    window.addEventListener("beforeunload", protectDraft);
    clearTimeout(draftTimer);
    if (delay) draftTimer = setTimeout(autosaveDraft, delay);
    else void autosaveDraft();
}

async function closeReport() {
    if (saving) return;
    if (!photo || submittedId !== null) {
        dialog.close();
        return;
    }
    saving = true;
    stopCamera();
    try {
        await flushDraft();
        const identifier = submittedId;
        dialog.close();
        showHistory(identifier, identifier === null ? "drafts" : "sent");
    } catch (error) {
        draftStatus.textContent = `Не удалось сохранить черновик. ${error.message}`;
        if (error.status === 401) void requireAccount(closeReport);
    } finally {
        saving = false;
        updateButtons();
    }
}

async function readDraftPhoto(identifier, kind) {
    const response = await fetch(`/api/reports/${identifier}/photos/${kind}`);
    if (!response.ok) throw new Error("Не удалось загрузить фото из черновика. Откройте его ещё раз");
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Не удалось прочитать фото из черновика"));
        reader.readAsDataURL(blob);
    });
}

async function openDraft(report, user) {
    if (dialog.open) return;
    resetReport();
    dialog.showModal();
    saving = true;
    updateButtons();
    draftStatus.textContent = "Открываем черновик…";
    try {
        const [main, detail] = await Promise.all([
            readDraftPhoto(report.id, "overview"),
            report.has_detail_photo ? readDraftPhoto(report.id, "detail") : null,
        ]);
        captureId = report.capture_id;
        captureOwner = user.max_id;
        capturedAt = report.captured_at;
        photo = main.split(",", 2)[1];
        preview.src = main;
        cameraButton.textContent = "Переснять основное фото";
        if (detail) {
            detailPhoto = detail.split(",", 2)[1];
            detailPreview.src = detail;
            detailButton.textContent = "Переснять второе фото";
        }
        if (report.latitude !== null) {
            position = { latitude: report.latitude, longitude: report.longitude };
            address = report.address;
            locationStatus.textContent = address || `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`;
            locateButton.textContent = "Определить заново";
        }
        comment.value = report.comment;
        plateNumber.value = report.plate_number || "";
        showStep(3);
        draftStatus.textContent = "Черновик сохранён";
    } catch (error) {
        draftStatus.textContent = error.message;
    } finally {
        saving = false;
        updateButtons();
    }
}

async function saveReport(event) {
    event.preventDefault();
    if (saveButton.disabled) return;

    clearTimeout(draftTimer);
    saving = true;
    updateButtons();
    saveStatus.textContent = "Отправляем обращение…";
    try {
        await draftSave?.catch(() => {});
        const result = await request("/api/reports/capture", capturePayload());
        submittedId = result.id;
        window.removeEventListener("beforeunload", protectDraft);
        draftStatus.textContent = "";
        saveStatus.textContent = `Обращение №${result.id} принято на внутреннюю проверку`;
    } catch (error) {
        saveStatus.textContent = error.message;
        if (error.status === 401) {
            requireAccount(() => {
                saveStatus.textContent = "Вход выполнен. Повторите отправку";
            });
        }
    } finally {
        saving = false;
        updateButtons();
    }
}

document.querySelector("#open-report").addEventListener("click", () => {
    requireAccount((user) => {
        if (dialog.open) return;
        resetReport();
        captureOwner = user.max_id;
        dialog.showModal();
    });
});
registerDraftEditor((report) => requireAccount((user) => openDraft(report, user)));
closeButton.addEventListener("click", closeReport);
dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void closeReport();
});
dialog.addEventListener("close", () => {
    if (!dialog.open) resetReport();
});
for (const eventName of ["dragover", "drop"]) {
    dialog.addEventListener(eventName, (event) => event.preventDefault());
}
locateButton.addEventListener("click", locate);
cameraButton.addEventListener("click", () => openCamera("overview"));
detailButton.addEventListener("click", () => openCamera("detail"));
cameraSettingsButton.addEventListener("click", async () => {
    try {
        await openCameraSettings?.();
    } catch {
        deviceFailure("camera", "max_permissions", "MaxSettingsError", { photo: photoKind });
        cameraStatus.textContent = "Не удалось открыть настройки. Проверьте разрешения MAX в настройках телефона";
    }
});
nextStep.addEventListener("click", () => showStep(step + 1));
skipDetail.addEventListener("click", () => showStep(3));
previousStep.addEventListener("click", () => showStep(1));
document.querySelector("#back-to-photos").addEventListener("click", () => showStep(2));
removeDetail.addEventListener("click", () => {
    detailPhoto = null;
    detailPreview.removeAttribute("src");
    detailButton.textContent = "Сделать второе фото";
    stopCamera();
    scheduleDraft();
});
comment.addEventListener("input", () => scheduleDraft(650));
plateNumber.addEventListener("input", () => scheduleDraft(650));
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
    cameraFailure("preview", "video_error", "Предпросмотр прервался. Откройте камеру ещё раз");
});
playButton.addEventListener("click", playCamera);
switchButton.addEventListener("click", switchCamera);
flashButton.addEventListener("click", toggleFlash);
takeButton.addEventListener("click", takePhoto);
cancelCameraButton.addEventListener("click", () => {
    lastCamera = null;
    stopCamera();
    cameraStatus.textContent = photo ? "Проверьте, что знак и госномер хорошо видны на снимках" : photoPrompt;
    (photoKind === "detail" ? detailButton : cameraButton).focus();
});
form.addEventListener("submit", saveReport);
document.addEventListener("visibilitychange", () => {
    if (document.hidden && dialog.open && !saving) void autosaveDraft();
    if (document.hidden && stream) {
        stopCamera();
        cameraFailure("stream", "document_hidden", "Камера остановлена, пока вкладка была скрыта. Откройте её ещё раз");
    }
});
window.addEventListener("online", () => {
    if (dialog.open && !saving) void autosaveDraft();
});
window.addEventListener("pagehide", stopCamera);
