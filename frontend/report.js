import { registerDraftEditor, registerOfflineDraftSync, requestMaxCameraAccess, maxCameraSettings, requireAccount, showHistory } from "./app.js";
import { request, initData, loadSession, withTimeout } from "./ui.js";
import { saveOfflineDraft, removeOfflineDraft, uploadOfflineDrafts } from "./offline-drafts.js";

const dialog = document.querySelector("#report-dialog");
const form = document.querySelector("#report-form");
const locateButton = document.querySelector("#locate");
const cameraButton = document.querySelector("#open-camera");
const cameraSettingsButton = document.querySelector("#camera-settings");
const browserCameraLink = document.querySelector("#open-browser-camera");
const detailButton = document.querySelector("#open-detail");
const takeButton = document.querySelector("#take-photo");
const playButton = document.querySelector("#play-camera");
const switchButton = document.querySelector("#switch-camera");
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
const plateRegion = document.querySelector("#plate-region");
const plateRegionFlag = document.querySelector("#plate-region-flag");
const plateRegionNote = document.querySelector("#plate-region-note");
const showSubmitted = document.querySelector("#show-submitted");
const photoStep = document.querySelector("#photo-step");
const reviewStep = document.querySelector("#review-step");
const placeholder = document.querySelector("#photo-placeholder");
const nextStep = document.querySelector("#next-step");
const reviewPhotos = document.querySelector("#review-photos");

const locationPrompt = "Разрешите доступ к геолокации, чтобы определить адрес";
const photoPrompt = "На одном или двух кадрах должны быть видны парковочный знак и госномер автомобиля";
const latinPlateLetters = "ABEKMHOPCTYX";
const plateLetters = "АВЕКМНОРСТУХ";
const invalidRegionMessage = "Такого кода региона нет. Проверьте номер автомобиля.";
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
let startedOffline = false;
let localOnly = false;
let remoteSaved = false;
const queuedDraftSync = new Map();
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
let locationSource = "geolocation";
let locationAttempted = false;
let locationRegion = "";
let plateRegions;
let openingCamera = false;
let saving = false;
let openCameraSettings;
let browserCameraGeneration = 0;
let recognitionGeneration = 0;

function maxPlatform() {
    return window.WebApp?.platform || new URLSearchParams(location.hash.slice(1)).get("WebAppPlatform") || "unknown";
}

function deviceFailure(device, stage, code, details = {}) {
    const inMax = Boolean(initData());
    const platform = inMax ? maxPlatform() : "browser";
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
    const cameraBlocked = (stage === "stream" && ["NotAllowedError", "SecurityError"].includes(code))
        || (stage === "context" && ["policy_blocked", "api_unavailable"].includes(code));
    if (cameraBlocked && initData() && (maxPlatform() === "android" || /Android/i.test(navigator.userAgent))) {
        void prepareBrowserCamera();
    }
}

function hideBrowserCamera() {
    browserCameraGeneration += 1;
    browserCameraLink.hidden = true;
    browserCameraLink.removeAttribute("href");
}

async function prepareBrowserCamera() {
    const generation = ++browserCameraGeneration;
    try {
        await flushDraft();
        if (generation !== browserCameraGeneration || submittedId !== null) return;
        const { ticket } = await request("/api/camera/handoff", { init_data: initData() });
        if (generation !== browserCameraGeneration || submittedId !== null) return;
        const destination = new URL("/", location.origin);
        if (photo) {
            destination.searchParams.set("tab", "history");
            destination.searchParams.set("filter", "drafts");
        }
        destination.hash = new URLSearchParams({ camera_ticket: ticket }).toString();
        browserCameraLink.href = destination.href;
        browserCameraLink.hidden = false;
        cameraStatus.textContent = "Камера недоступна в MAX. Продолжите съёмку в браузере";
    } catch (error) {
        if (generation === browserCameraGeneration) {
            cameraStatus.textContent = `Не удалось подготовить переход в браузер. ${error.message}`;
        }
    }
}

function updateButtons() {
    const saved = submittedId !== null;
    const cameraActive = Boolean(stream);
    locateButton.disabled = locating || saving || saved;
    document.querySelector("#search-location").disabled = locating || saving || saved;
    document.querySelector("#location-search").disabled = locating || saving || saved;
    cameraButton.hidden = cameraActive || step !== 1;
    cameraButton.disabled = openingCamera || cameraActive || saving || saved;
    detailButton.hidden = cameraActive || step !== 2;
    detailButton.disabled = cameraButton.disabled || !photo;
    comment.disabled = saving || saved;
    plateNumber.disabled = saving || saved;
    plateRegion.disabled = plateNumber.disabled;
    const cameraBusy = openingCamera || capturing || changingFlash;
    takeButton.disabled = cameraBusy || !stream || !playButton.hidden || !hasCameraFrame();
    switchButton.disabled = cameraBusy || !cameraActive || !lastCamera || saved;
    flashButton.disabled = cameraBusy || !stream;
    flashButton.hidden = !cameraActive || !flashAvailable;
    flashButton.setAttribute("aria-pressed", String(flash !== "off"));
    closeButton.disabled = saving;
    saveButton.disabled = !position || !photo || locating || openingCamera || cameraActive || saving || saved;
    saveButton.hidden = saved;
    showSubmitted.hidden = !saved;
    nextStep.disabled = detailButton.disabled;
    nextStep.hidden = step === 3;
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

function stopCamera({ keepView = false } = {}) {
    const activeStream = stream;
    stream = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    flash = "off";
    changingFlash = capturing = false;
    flashAvailable = false;
    playButton.hidden = true;
    if (!keepView && cameraView.open) cameraView.close();
    updateButtons();
}

function resetReport() {
    session += 1;
    step = 1;
    position = address = photo = detailPhoto = capturedAt = captureId = captureOwner = submittedId = null;
    locationSource = "geolocation";
    document.querySelector("#location-search").value = "";
    document.querySelector("#location-results").replaceChildren();
    startedOffline = localOnly = remoteSaved = false;
    draftRevision = savedRevision = 0;
    draftSave = null;
    clearTimeout(draftTimer);
    window.removeEventListener("beforeunload", protectDraft);
    locating = openingCamera = saving = false;
    locationAttempted = false;
    locationRegion = "";
    openCameraSettings = undefined;
    cameraSettingsButton.hidden = true;
    lastCamera = null;
    stopCamera();
    preview.removeAttribute("src");
    detailPreview.removeAttribute("src");
    comment.value = "";
    plateNumber.value = "";
    plateRegion.value = "";
    updatePlateRegion();
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
    hideBrowserCamera();
    step = value;
    photoStep.hidden = step === 3;
    reviewStep.hidden = step !== 3;
    document.querySelector("#step-count").textContent = `Шаг ${step} из 3`;
    document.querySelector("#step-name").textContent = ["Общий вид", "Государственный номер", "Проверка"][step - 1];
    document.querySelector(".step-progress").setAttribute("aria-valuenow", String(step));
    document.querySelector("#step-progress").style.width = `${step * 100 / 3}%`;
    document.querySelector("#photo-title").textContent = step === 1
        ? "Сделайте фото автомобиля на парковочном месте" : "Если номер плохо виден, сделайте второе фото";
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
    if (step === 3) {
        updatePlateRegion();
        locatePlateRegion();
    }
}

function splitPlate(value) {
    return /^(?<plate>[a-zа-я]\s*[0-9]{3}\s*[a-zа-я]\s*[a-zа-я])[\s-]*(?<region>[0-9]{2,3})$/iu.exec(value.trim())?.groups
        ?? { plate: value, region: "" };
}

function loadPlateRegions() {
    plateRegions ??= request("/plate-regions.json").then((regions) => new Map(
        Object.entries(regions).flatMap(([primary, region]) =>
            [primary, ...(region.codes || [])].map((code) => [code, { ...region, primary }])),
    )).catch(() => {
        plateRegions = null;
        return null;
    });
    return plateRegions;
}

function showPlateRegionError(message) {
    plateRegion.setCustomValidity(message);
    if (message) plateRegion.setAttribute("aria-invalid", "true");
    else plateRegion.removeAttribute("aria-invalid");
    plateRegionNote.classList.toggle("field-error", Boolean(message));
    if (message) {
        plateRegionNote.textContent = message;
        plateRegionNote.hidden = false;
    }
}

function updatePlateRegion() {
    const manual = plateRegion.value || splitPlate(plateNumber.value).region;
    plateRegion.placeholder = locationRegion || "—";
    plateRegionNote.hidden = true;
    plateRegionFlag.hidden = true;
    showPlateRegionError(manual.length === 1 ? "Введите две или три цифры кода региона." : "");
    if (!/^[0-9]{2,3}$/.test(manual || locationRegion)) return;
    void loadPlateRegions().then((regions) => {
        const confirmed = plateRegion.value || splitPlate(plateNumber.value).region;
        const code = confirmed || locationRegion;
        if (!regions || !/^[0-9]{2,3}$/.test(code)) return;
        const region = regions.get(code);
        if (!region && confirmed) {
            showPlateRegionError(invalidRegionMessage);
            return;
        }
        showPlateRegionError("");
        if (region && region.flag !== false) {
            const slot = Number(region.primary);
            plateRegionFlag.style.backgroundPosition = `${slot % 10 * 100 / 9}% ${Math.floor(slot / 10) * 100 / 9}%`;
            plateRegionFlag.setAttribute("aria-label", `Флаг региона: ${region.name}`);
            plateRegionFlag.hidden = false;
        }
        plateRegionNote.textContent = [region?.name, !confirmed && "Предположение по месту съёмки"].filter(Boolean).join(" · ");
        plateRegionNote.hidden = !plateRegionNote.textContent;
    });
}

function locatePlateRegion() {
    if (!saving && !locationAttempted && !locationRegion && !plateRegion.value && !splitPlate(plateNumber.value).region) {
        void locate({ reusePosition: Boolean(position) });
    }
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

async function locate({ reusePosition = false } = {}) {
    if (locating) return;
    locationAttempted = true;
    if (!reusePosition && !window.isSecureContext) {
        locationStatus.textContent = secureContextMessage;
        deviceFailure("location", "context", "insecure_context");
        return;
    }
    if (!reusePosition && !navigator.geolocation) {
        locationStatus.textContent = "Этот браузер не поддерживает геолокацию";
        deviceFailure("location", "context", "api_unavailable");
        return;
    }

    const current = session;
    locating = true;
    updateButtons();
    locationStatus.textContent = "Запрашиваем местоположение…";
    try {
        let accuracy;
        if (!reusePosition) {
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
            const { latitude, longitude, accuracy: meters } = result.coords;
            if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
                || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
                throw { code: "invalid_coordinates" };
            }
            position = { latitude, longitude };
            locationSource = "geolocation";
            accuracy = meters;
            address = null;
            locationRegion = "";
            updatePlateRegion();
            scheduleDraft();
        }
        const precision = Number.isFinite(accuracy) ? ` (точность ±${Math.round(accuracy)} м)` : "";
        const display = `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}${precision}`;
        locationStatus.textContent = `${display}. Ищем адрес…`;
        try {
            const result = await request("/api/geocode", position);
            if (current !== session || saving) return;
            address = result.address || address;
            locationRegion = result.region_code || "";
            updatePlateRegion();
            if (address || locationRegion) scheduleDraft();
            if (!address) deviceFailure("location", "address", "address_not_found");
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
    hideBrowserCamera();
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
    video.defaultMuted = video.muted = true;
    video.srcObject = activeStream;
    cameraStatus.textContent = "Камера подключена. Ждём первый кадр…";
    cameraViewStatus.textContent = "Камера подключена. Ждём первый кадр…";
    if (!cameraView.open) cameraView.showModal();
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
    } catch (error) {
        if (stream !== activeStream) return;
        if (error?.name === "NotAllowedError") {
            playButton.hidden = false;
            cameraFailure("preview", "NotAllowedError", "Камера подключена. Нажмите «Запустить предпросмотр»");
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
    const switching = () => current === session && cameraView.open && !document.hidden;
    const { deviceId, facingMode } = lastCamera;
    openingCamera = true;
    updateButtons();
    try {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!switching()) return;
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
        cameraViewStatus.textContent = cameraStatus.textContent;
        stopCamera({ keepView: true });
        for (const video of choices) {
            let next;
            try {
                next = await getCameraStream(video);
            } catch (error) {
                if (!switching()) return;
                if (error?.name === "CameraStreamTimeout") throw error;
                continue;
            }
            if (!switching()) {
                next.getTracks().forEach((item) => item.stop());
                return;
            }
            const nextDeviceId = next.getVideoTracks()[0]?.getSettings().deviceId;
            if (deviceId && nextDeviceId === deviceId) {
                next.getTracks().forEach((item) => item.stop());
                continue;
            }
            preferredCamera = video;
            await showCamera(next, current);
            return;
        }

        const restored = await getCameraStream(previous);
        if (!switching()) {
            restored.getTracks().forEach((item) => item.stop());
            return;
        }
        await showCamera(restored, current);
        if (!switching()) return;
        cameraFailure("switch", "NotFoundError", stream && playButton.hidden
            ? "Не удалось открыть другую камеру. Текущая камера восстановлена"
            : "Не удалось открыть другую камеру. Проверьте доступные камеры в настройках браузера");
    } catch (error) {
        if (!switching()) return;
        stopCamera();
        const code = cameraMessages.has(error?.name) ? error.name : "UnknownError";
        cameraFailure("switch", code, "Не удалось переключить камеру. Откройте её ещё раз");
    } finally {
        if (current === session) {
            openingCamera = false;
            updateButtons();
            if (!cameraView.open && dialog.open && !document.hidden) focusCameraOpener();
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
    if (captureId === null) {
        captureId = crypto.randomUUID();
        startedOffline = !navigator.onLine;
    }
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
    void recognizePlate(encoded, photoKind, session);
}

async function recognizePlate(encoded, kind, currentSession) {
    const generation = ++recognitionGeneration;
    if (!navigator.onLine) {
        cameraStatus.textContent = "Снимок сохранён. Номер проверим после подключения к интернету.";
        return;
    }
    cameraStatus.textContent = "Ищем госномер на снимке…";
    try {
        const result = await request("/api/plates/detect", { photo: encoded });
        if (session !== currentSession || generation !== recognitionGeneration || (kind === "overview" ? photo : detailPhoto) !== encoded) return;
        if (!result.found) {
            cameraStatus.textContent = "Госномер не найден. Переснимите фото или снимите номер крупнее на втором фото.";
        } else if (result.multiple) {
            cameraStatus.textContent = "Найдено несколько номеров. Снимите нужный номер крупнее на втором фото.";
        } else if (result.plate) {
            if (!plateNumber.value) {
                plateNumber.value = result.plate;
                if (!plateRegion.value) plateRegion.value = result.region;
            }
            updatePlateRegion();
            scheduleDraft();
            cameraStatus.textContent = "Номер распознан. Проверьте его перед отправкой обращения.";
        } else {
            cameraStatus.textContent = "Номер найден, но прочитать его не удалось. Укажите номер вручную или переснимите фото крупнее.";
        }
    } catch (error) {
        if (session === currentSession && generation === recognitionGeneration && (kind === "overview" ? photo : detailPhoto) === encoded) {
            cameraStatus.textContent = `Не удалось проверить номер: ${error.message}`;
        }
    }
}

function capturePayload(regions = null) {
    const { plate, region } = splitPlate(plateNumber.value);
    const manualRegion = plateRegion.value || region;
    const regionCode = manualRegion || locationRegion;
    return {
        ...position, address, photo, detail_photo: detailPhoto, captured_at: capturedAt,
        location_source: locationSource,
        comment: comment.value, plate_number: plate, capture_id: captureId, owner_max_id: captureOwner,
        offline_created: startedOffline,
        plate_region: /^[0-9]{2,3}$/.test(regionCode) && (!regions || regions.has(regionCode)) ? regionCode : null,
        plate_region_source: manualRegion ? "manual" : "location",
    };
}

function protectDraft(event) {
    event.preventDefault();
    event.returnValue = "";
}

function flushDraft() {
    clearTimeout(draftTimer);
    if (draftSave) return draftSave;
    if (!photo || submittedId !== null || (savedRevision === draftRevision && !(localOnly && navigator.onLine))) {
        return Promise.resolve();
    }
    const current = session;
    draftStatus.textContent = "Сохраняем черновик…";
    draftSave = (async () => {
        while (savedRevision !== draftRevision || (localOnly && navigator.onLine)) {
            const revision = draftRevision;
            const regions = plateRegion.value || splitPlate(plateNumber.value).region ? await loadPlateRegions() : null;
            if (current !== session) return;
            const payload = capturePayload(regions);
            if (localOnly || !navigator.onLine) {
                await saveOfflineDraft(payload);
                localOnly = true;
                if (!navigator.onLine) {
                    savedRevision = revision;
                    continue;
                }
            }
            let result;
            try {
                result = await request("/api/reports/capture/draft", payload);
            } catch (error) {
                if (!error.connectionFailed || current !== session) throw error;
                startedOffline ||= !remoteSaved;
                await saveOfflineDraft({ ...payload, offline_created: startedOffline });
                localOnly = true;
                savedRevision = revision;
                if (savedRevision !== draftRevision) draftTimer = setTimeout(autosaveDraft, 650);
                break;
            }
            remoteSaved = true;
            if (localOnly) {
                await removeOfflineDraft(payload.capture_id);
                localOnly = false;
            }
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
        draftStatus.textContent = localOnly ? "Черновик сохранён на устройстве и синхронизируется после подключения."
            : submittedId === null ? "Черновик сохранён" : "Обращение уже отправлено";
    })().finally(() => {
        if (current === session) draftSave = null;
    });
    return draftSave;
}

function syncDraftsFor(owner) {
    if (!queuedDraftSync.has(owner)) {
        const pending = uploadOfflineDrafts(owner, () => dialog.open ? captureId : null).catch((error) => {
            console.warn("Не удалось синхронизировать черновики", error);
        }).finally(() => { queuedDraftSync.delete(owner); });
        queuedDraftSync.set(owner, pending);
    }
    return queuedDraftSync.get(owner);
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
        if (navigator.onLine && !localOnly) showHistory(identifier, identifier === null ? "drafts" : "sent");
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
        remoteSaved = true;
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
            locationSource = report.location_source || "geolocation";
            address = report.address;
            locationStatus.textContent = address || `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`;
            locateButton.textContent = "Определить заново";
        }
        comment.value = report.comment;
        const { plate, region } = splitPlate(report.plate_number || "");
        plateNumber.value = plate;
        if (report.plate_region_source === "location") locationRegion = report.plate_region || "";
        else plateRegion.value = report.plate_region || region;
        showStep(3);
        draftStatus.textContent = "Черновик сохранён";
    } catch (error) {
        draftStatus.textContent = error.message;
    } finally {
        saving = false;
        updateButtons();
        if (step === 3) locatePlateRegion();
    }
}

async function saveReport(event) {
    event.preventDefault();
    if (saveButton.disabled) return;
    if (plateRegion.value || splitPlate(plateNumber.value).region) {
        const regions = await loadPlateRegions();
        const code = plateRegion.value || splitPlate(plateNumber.value).region;
        if (code && regions && !regions.has(code)) {
            showPlateRegionError(invalidRegionMessage);
            plateRegion.reportValidity();
            return;
        }
        if (saveButton.disabled) return;
    }

    clearTimeout(draftTimer);
    saving = true;
    updateButtons();
    saveStatus.textContent = "Отправляем обращение…";
    try {
        if (!navigator.onLine || localOnly) {
            await flushDraft();
            if (!navigator.onLine) {
                saveStatus.textContent = "Черновик сохранён. Подключитесь к интернету, чтобы отправить обращение.";
                return;
            }
        } else {
            await draftSave?.catch(() => {});
        }
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
    }, { allowOffline: true });
});
registerDraftEditor((report) => requireAccount((user) => openDraft(report, user)));
registerOfflineDraftSync(syncDraftsFor);
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
locateButton.addEventListener("click", () => locate());
document.querySelector("#search-location").addEventListener("click", async () => {
    const field = document.querySelector("#location-search");
    const results = document.querySelector("#location-results");
    const current = session;
    results.textContent = "Ищем адрес…";
    try {
        const data = await request("/api/geocode/search", { query: field.value });
        if (current !== session) return;
        results.replaceChildren();
        if (!data.results.length) results.textContent = "Адрес не найден. Уточните запрос.";
        for (const result of data.results) {
            const choice = document.createElement("button");
            choice.type = "button";
            choice.textContent = result.address;
            choice.addEventListener("click", () => {
                position = { latitude: result.latitude, longitude: result.longitude };
                locationSource = "manual";
                address = result.address;
                locationRegion = "";
                updatePlateRegion();
                locationStatus.textContent = `Выбранный адрес: ${address}. Проверьте место на снимках.`;
                results.replaceChildren();
                scheduleDraft();
                updateButtons();
            });
            results.append(choice);
        }
    } catch (error) {
        if (current === session) results.textContent = error.message;
    }
});
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
browserCameraLink.addEventListener("click", (event) => {
    if (browserCameraLink.hidden || typeof window.WebApp?.openLink !== "function") return;
    try {
        window.WebApp.openLink(browserCameraLink.href);
        event.preventDefault();
    } catch {
        // Let the link open normally if the bridge rejects the call.
    }
});
nextStep.addEventListener("click", () => showStep(step + 1));
document.querySelector("#back-to-photos").addEventListener("click", () => showStep(1));
comment.addEventListener("input", () => scheduleDraft(650));
plateNumber.addEventListener("input", () => {
    const normalize = (value) => value.toUpperCase()
        .replace(/[ABEKMHOPCTYX]/g, (letter) => plateLetters[latinPlateLetters.indexOf(letter)])
        .replace(/[^АВЕКМНОРСТУХ0-9 -]/g, "");
    const original = plateNumber.value;
    const filtered = normalize(original);
    if (filtered !== original) {
        const cursor = normalize(original.slice(0, plateNumber.selectionStart)).length;
        plateNumber.value = filtered;
        plateNumber.setSelectionRange(cursor, cursor);
    }
    updatePlateRegion();
    scheduleDraft(650);
});
plateNumber.addEventListener("change", () => {
    const { plate, region } = splitPlate(plateNumber.value);
    if (!region) return;
    plateNumber.value = plate;
    plateRegion.value ||= region;
    updatePlateRegion();
});
plateRegion.addEventListener("input", () => {
    plateRegion.value = plateRegion.value.replace(/[^0-9]/g, "");
    updatePlateRegion();
    locatePlateRegion();
    scheduleDraft(650);
});
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
function focusCameraOpener() {
    (photoKind === "detail" ? detailButton : cameraButton).focus();
}

function closeCamera() {
    lastCamera = null;
    stopCamera();
    cameraStatus.textContent = photo ? "Проверьте, что знак и госномер хорошо видны на снимках" : photoPrompt;
    focusCameraOpener();
}

cancelCameraButton.addEventListener("click", closeCamera);
cameraView.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCamera();
});
form.addEventListener("submit", saveReport);
document.addEventListener("visibilitychange", () => {
    if (document.hidden && dialog.open && !saving) void autosaveDraft();
    if (document.hidden && cameraView.open) {
        stopCamera();
        cameraFailure("stream", "document_hidden", "Камера остановлена, пока вкладка была скрыта. Откройте её ещё раз");
    }
});
window.addEventListener("online", async () => {
    try {
        const { user } = await loadSession();
        if (!user) return;
        if (dialog.open && !saving && captureOwner === user.max_id) void autosaveDraft();
        await syncDraftsFor(user.max_id);
    } catch (error) {
        console.warn("Не удалось восстановить синхронизацию", error);
    }
});
window.addEventListener("pagehide", () => stopCamera());
