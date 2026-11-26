const MAX_BOT_URL = "https://max.ru/se15128211_bot";

export async function request(path, body, { keepalive = false } = {}) {
    let response;
    try {
        response = await fetch(path, body === undefined ? {} : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            keepalive,
        });
    } catch {
        throw new Error("Не удалось связаться с сервером. Попробуйте ещё раз");
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("Сервер вернул неожиданный ответ");
    }
    if (!response.ok) {
        const message = String(data.error || "Не удалось выполнить запрос");
        const error = new Error(message.endsWith(".") && !message.endsWith("..") ? message.slice(0, -1) : message);
        error.status = response.status;
        throw error;
    }
    return data;
}

export function initData() {
    return window.WebApp?.initData || new URLSearchParams(location.hash.slice(1)).get("WebAppData");
}

export function needsMax(session) {
    return session.mode === "max" && !session.user && !initData();
}

export async function showSiteVersion(footer) {
    try {
        const { version, bot, test } = await request("/api/version");
        const labels = [version ? `Версия ${version}` : "Версия неизвестна"];
        if (!bot) labels.push("без бота");
        if (test) labels.push("тестовый режим");
        footer.textContent = labels.join(" · ");
        footer.hidden = false;
    } catch {
        footer.hidden = true;
    }
}

export async function withTimeout(promise, milliseconds, code) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new DOMException("", code)), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

let sessionRequest = null;
let maxLaunchChecked = false;

async function fetchSession() {
    const url = new URL(location.href);
    const ticket = new URLSearchParams(url.hash.slice(1)).get("camera_ticket");
    if (ticket) {
        url.hash = "";
        history.replaceState(history.state, "", url);
        try {
            return { ...await request("/api/session/camera", { ticket }), camera_login: true };
        } catch (error) {
            return { ...await request("/api/session"), camera_login_error: error.message };
        }
    }
    const launchData = initData();
    if (!maxLaunchChecked && launchData) {
        try {
            const session = await request("/api/session", { init_data: launchData });
            maxLaunchChecked = true;
            return session;
        } catch (error) {
            if (error.status !== 400 && error.status !== 401) throw error;
            maxLaunchChecked = true;
        }
    }
    return request("/api/session");
}

export function loadSession() {
    sessionRequest ??= fetchSession().finally(() => { sessionRequest = null; });
    return sessionRequest;
}

export async function logoutSession() {
    maxLaunchChecked = true;
    await sessionRequest?.catch(() => {});
    return request("/api/logout", {});
}

export function element(tag, text = "", className = "") {
    const node = document.createElement(tag);
    if (text !== "") node.textContent = text;
    if (className) node.className = className;
    return node;
}

export function statusMessage(text = "") {
    const message = element("p", text);
    message.setAttribute("role", "status");
    return message;
}

export function profileAvatar(profile, fallback = "○") {
    const letter = profile?.first_name?.match(/\p{L}/u)?.[0] || profile?.last_name?.match(/\p{L}/u)?.[0] || fallback;
    const [initial] = letter.toUpperCase();
    const avatar = element("span", initial, "profile-avatar");
    avatar.setAttribute("aria-hidden", "true");
    if (profile?.photo_url) {
        const photo = element("img");
        photo.alt = "";
        photo.referrerPolicy = "no-referrer";
        photo.hidden = true;
        photo.onload = () => { photo.hidden = false; };
        photo.src = profile.photo_url;
        avatar.append(photo);
    }
    return avatar;
}

export function button(text, action, primary = false) {
    const node = element("button", text, primary ? "panel-button primary-button" : "panel-button");
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}

export function submitButton(text) {
    const node = element("button", text, "panel-button primary-button");
    node.type = "submit";
    return node;
}

export function panelLink(text, href, primary = false) {
    const link = element("a", text, primary ? "panel-button primary-button" : "panel-button");
    link.href = href;
    return link;
}

export function maxBotLink() {
    return panelLink("Перейти в бота MAX", MAX_BOT_URL, true);
}

export function field(label, name, options = {}) {
    const wrapper = element("label", label);
    const input = element(options.multiline ? "textarea" : "input");
    input.name = name;
    if (options.type) input.type = options.type;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.autocomplete) input.autocomplete = options.autocomplete;
    if (options.inputMode) input.inputMode = options.inputMode;
    if (options.value) input.value = options.value;
    if (options.required) input.required = true;
    if (options.multiline) input.rows = 3;
    wrapper.append(input);
    return wrapper;
}

export function formHandler(form, message, path, onSuccess, mapValues = (values) => values) {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = form.querySelector("button[type='submit']");
        submit.disabled = true;
        message.textContent = "Подождите…";
        try {
            const values = Object.fromEntries(new FormData(form));
            await onSuccess(await request(path, mapValues(values)));
        } catch (error) {
            message.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });
}
