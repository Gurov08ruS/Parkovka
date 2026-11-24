const $ = (id) => document.getElementById(id);
const accountDialog = $("account-dialog");
const accountForm = $("account-form");
const accountMessage = $("account-message");
const accountSubmit = $("account-submit");
const panel = $("panel-dialog");
const panelContent = $("panel-content");
const statuses = {
    draft: "Черновик",
    pending: "Ожидает проверки",
    under_review: "На проверке",
    approved: "Проверено",
    rejected: "Отклонено",
};

let session = null;
let afterLogin = null;
let panelVersion = 0;
let bridge;

export async function request(path, body) {
    let response;
    try {
        response = await fetch(path, body === undefined ? {} : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error("Не удалось связаться с сервером. Попробуйте ещё раз.");
    }
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("Сервер вернул неожиданный ответ.");
    }
    if (!response.ok) {
        const error = new Error(data.error || "Не удалось выполнить запрос.");
        error.status = response.status;
        throw error;
    }
    return data;
}

function initData() {
    return window.WebApp?.initData || new URLSearchParams(location.hash.slice(1)).get("WebAppData");
}

function setSession(data) {
    session = data;
    if (data.mode === "max" && initData() && !bridge) {
        bridge = new Promise((resolve) => {
            if (window.WebApp) {
                resolve(window.WebApp);
                return;
            }
            const script = document.createElement("script");
            script.src = "https://st.max.ru/js/max-web-app.js";
            script.onload = () => resolve(window.WebApp);
            script.onerror = () => resolve(null);
            document.head.append(script);
        });
    }
}

export async function requestMaxCameraAccess() {
    if (!bridge) return;
    const app = await Promise.race([bridge, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    const manager = app?.PermissionsManager;
    if (!manager) return;
    if (!manager.isInited) await manager.init();
    try {
        await manager.requestAccess(["camera"], "Для съёмки знака и автомобиля");
    } catch (error) {
        const code = error?.error?.code || "";
        if (code.endsWith("app_permission_denied") || code.endsWith("system_permission_denied")) {
            throw new DOMException("Разрешите доступ к камере в настройках MAX или устройства.", "NotAllowedError");
        }
        throw error;
    }
}

function openLogin(action) {
    const test = session.mode === "test";
    const testFields = $("test-login");
    testFields.hidden = !test;
    for (const input of testFields.querySelectorAll("input")) input.disabled = !test;
    $("max-login").hidden = test || Boolean(initData());
    accountSubmit.textContent = test ? "Войти" : "Войти через MAX";
    accountSubmit.disabled = !test && !initData();
    accountMessage.textContent = "";
    afterLogin = action;
    if (!accountDialog.open) accountDialog.showModal();
}

export async function requireAccount(action) {
    try {
        setSession(await request("/api/session"));
    } catch (error) {
        openPanel("Вход");
        panelContent.append(statusMessage(error.message), button("Повторить", () => requireAccount(action)));
        return;
    }
    if (!session.user) {
        openLogin(action);
        return;
    }
    action();
}

accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = session.mode === "test"
        ? Object.fromEntries(new FormData(accountForm))
        : { init_data: initData() };
    accountSubmit.disabled = true;
    accountMessage.textContent = "Входим…";
    try {
        setSession(await request("/api/session", input));
        const action = afterLogin;
        accountForm.reset();
        if (accountDialog.open) {
            accountDialog.close();
            action?.();
        }
    } catch (error) {
        accountMessage.textContent = error.message;
    } finally {
        accountSubmit.disabled = session.mode === "max" && !initData();
    }
});
accountDialog.addEventListener("close", () => {
    if (!accountDialog.open) afterLogin = null;
});

function element(tag, text = "", className = "") {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function statusMessage(text = "") {
    const message = element("p", text);
    message.setAttribute("role", "status");
    return message;
}

function button(text, action, primary = false) {
    const node = element("button", text, primary ? "panel-button primary-button" : "panel-button");
    node.type = "button";
    node.addEventListener("click", action);
    return node;
}

function submitButton(text) {
    const node = element("button", text, "panel-button primary-button");
    node.type = "submit";
    return node;
}

function field(label, name, options = {}) {
    const wrapper = element("label", label);
    const input = element(options.multiline ? "textarea" : "input");
    input.name = name;
    if (options.type) input.type = options.type;
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.value) input.value = options.value;
    if (options.required) input.required = true;
    if (options.multiline) input.rows = 3;
    wrapper.append(input);
    return wrapper;
}

function openPanel(title) {
    panelVersion += 1;
    $("panel-title").textContent = title;
    panelContent.replaceChildren();
    if (!panel.open) panel.showModal();
    return panelVersion;
}

function activePanel(version) {
    return panel.open && panelVersion === version;
}

function formHandler(form, message, path, onSuccess) {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const submit = form.querySelector("button[type='submit']");
        submit.disabled = true;
        message.textContent = "Подождите…";
        try {
            onSuccess(await request(path, Object.fromEntries(new FormData(form))));
        } catch (error) {
            message.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });
}

function showProfile() {
    const version = openPanel("Личный кабинет");
    const user = session.user;
    const profile = element("form", "", "panel-stack");
    const profileMessage = statusMessage();
    profile.append(
        element("p", `ID MAX: ${user.max_id}`),
        field("Имя", "first_name", { value: user.first_name, maxLength: 80, required: true }),
        field("Фамилия", "last_name", { value: user.last_name, maxLength: 80, required: session.mode === "test" }),
        submitButton("Сохранить профиль"),
        profileMessage,
    );
    formHandler(profile, profileMessage, "/api/profile", (data) => {
        setSession(data);
        profileMessage.textContent = "Профиль сохранён.";
    });
    panelContent.append(profile);

    if (user.reviewer) {
        panelContent.append(button("Очередь проверки", () => showList(true), true));
    } else if (session.review_enabled) {
        const review = element("form", "", "panel-stack capture-section");
        const message = statusMessage();
        review.append(
            element("h3", "Вход для проверяющего"),
            field("Секрет проверяющего", "key", { type: "password", required: true }),
            submitButton("Войти в очередь проверки"),
            message,
        );
        formHandler(review, message, "/api/reviewer", (data) => {
            review.reset();
            setSession(data);
            if (activePanel(version)) showList(true);
        });
        panelContent.append(review);
    }

    const logoutMessage = statusMessage();
    const logout = button("Выйти из аккаунта", async () => {
        logout.disabled = true;
        try {
            setSession(await request("/api/logout", {}));
            if (activePanel(version)) panel.close();
        } catch (error) {
            logoutMessage.textContent = error.message;
        } finally {
            logout.disabled = false;
        }
    });
    panelContent.append(logout, logoutMessage);
}

function dateLabel(value) {
    return value ? new Date(value).toLocaleString("ru-RU") : "";
}

function placeLabel(report) {
    if (report.address) return report.address;
    if (report.latitude !== null) return `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`;
    return "Местоположение отсутствует";
}

function reportStatus(report) {
    return element("span", statuses[report.status] || report.status, `report-status status-${report.status}`);
}

async function showList(reviewer = false) {
    const version = openPanel(reviewer ? "Очередь проверки" : "Мои обращения");
    const message = statusMessage("Загружаем обращения…");
    panelContent.append(message, button("Обновить список", () => showList(reviewer)));
    try {
        const { reports } = await request(reviewer ? "/api/review" : "/api/reports");
        if (!activePanel(version)) return;
        if (reports.length === 0) {
            message.textContent = reviewer ? "В очереди пока нет обращений." : "У вас пока нет обращений.";
        } else {
            message.remove();
        }
        for (const report of reports) {
            const row = button(`№${report.id} · ${placeLabel(report)}`, () => showDetails(report.id, reviewer));
            row.classList.add("report-row");
            row.append(reportStatus(report), element("small", dateLabel(report.submitted_at || report.created_at)));
            panelContent.append(row);
        }
    } catch (error) {
        message.textContent = error.message;
    }
}

export function showHistory(identifier) {
    if (identifier) showDetails(identifier);
    else showList();
}

async function showDetails(identifier, reviewer = false) {
    const version = openPanel(`Обращение №${identifier}`);
    const message = statusMessage("Загружаем обращение…");
    panelContent.append(button("К списку", () => showList(reviewer)), message);
    const path = `${reviewer ? "/api/review" : "/api/reports"}/${identifier}`;
    try {
        const report = await request(path);
        if (!activePanel(version)) return;
        message.remove();
        panelContent.append(
            reportStatus(report),
            element("p", placeLabel(report)),
            element("p", `Создано ${dateLabel(report.created_at)}`),
        );
        if (report.captured_at) panelContent.append(element("p", `Снято ${dateLabel(report.captured_at)}`));
        if (report.comment) panelContent.append(element("p", report.comment, "report-comment"));
        const gallery = element("div", "", "report-photos");
        for (const [exists, kind, label] of [
            [report.has_photo, "overview", "Основной снимок"],
            [report.has_detail_photo, "detail", "Дополнительный снимок"],
        ]) {
            if (!exists) continue;
            const image = element("img");
            image.src = `${path}/photos/${kind}`;
            image.alt = label;
            const figure = element("figure");
            figure.append(image, element("figcaption", label));
            gallery.append(figure);
        }
        if (gallery.children.length) panelContent.append(gallery);
        if (report.events.length) {
            const log = element("ol", "", "report-events");
            for (const entry of report.events) {
                const item = element("li", `${statuses[entry.status]} · ${dateLabel(entry.occurred_at)}`);
                if (entry.note) item.append(element("p", entry.note, "report-comment"));
                log.append(item);
            }
            panelContent.append(element("h3", "История статусов"), log);
        }
        if (reviewer && ["pending", "under_review"].includes(report.status)) {
            showReviewForm(report, path, version);
        }
    } catch (error) {
        message.textContent = error.message;
        if (activePanel(version)) panelContent.append(button("Повторить", () => showDetails(identifier, reviewer)));
    }
}

function showReviewForm(report, path, version) {
    const form = element("form", "", "panel-stack capture-section");
    const label = element("label", "Новый статус");
    const select = element("select");
    select.name = "status";
    const choices = report.status === "pending" ? ["under_review", "approved", "rejected"] : ["approved", "rejected"];
    for (const value of choices) {
        const option = element("option", statuses[value]);
        option.value = value;
        select.append(option);
    }
    label.append(select);
    const note = field("Комментарий к решению. Для отказа обязателен.", "note", { multiline: true, maxLength: 1000 });
    select.addEventListener("change", () => {
        note.querySelector("textarea").required = select.value === "rejected";
    });
    const message = statusMessage();
    form.append(element("h3", "Решение проверяющего"), label, note, submitButton("Сохранить решение"), message);
    formHandler(form, message, `${path}/status`, () => {
        if (activePanel(version)) showDetails(report.id, true);
    });
    panelContent.append(form);
}

function showAbout() {
    openPanel("О проекте");
    panelContent.append(
        element("p", "«ЧУЖОЕ МЕСТО» помогает сохранять доступность парковочных мест для людей с инвалидностью."),
        element("h3", "Как отправить обращение"),
    );
    const steps = element("ol", "", "report-events");
    for (const step of [
        "Разрешите геолокацию и проверьте, что адрес соответствует месту.",
        "Снимите автомобиль, госномер и парковочный знак. Если всё хорошо видно на одном кадре, второго не нужно.",
        "Отправьте материалы на внутреннюю проверку и смотрите решение в разделе «Мои обращения».",
    ]) steps.append(element("li", step));
    panelContent.append(steps, element("p", "Результат внутренней проверки описывает качество и содержание материалов."));
}

$("open-profile").addEventListener("click", () => requireAccount(showProfile));
$("open-history").addEventListener("click", () => requireAccount(() => showHistory()));
$("open-about").addEventListener("click", showAbout);
