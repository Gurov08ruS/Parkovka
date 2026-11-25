export async function request(path, body) {
    let response;
    try {
        response = await fetch(path, body === undefined ? {} : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
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

let sessionRequest = null;
let maxLaunchChecked = false;

async function fetchSession() {
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
