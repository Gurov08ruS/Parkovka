const $ = (id) => document.getElementById(id);
const accountDialog = $("account-dialog");
const accountForm = $("account-form");
const accountMessage = $("account-message");
const accountSubmit = $("account-submit");
const panel = $("panel-dialog");
const panelContent = $("tab-content");
const tabTitles = { home: "Главная", history: "Мои обращения", achievements: "Мои достижения", profile: "Мой аккаунт" };
let currentTab = "home";
let tabAnimation;
let loginRequest = null;
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

function showSessionError(content, error, retry) {
    content.replaceChildren(statusMessage(error.message), button("Повторить", retry));
    if (error.status === 403) {
        const message = statusMessage();
        content.append(button("Выйти из аккаунта", async () => {
            try {
                setSession(await request("/api/logout", {}));
                if (panel.open) panel.close();
                retry();
            } catch (logoutError) {
                message.textContent = logoutError.message;
            }
        }), message);
    }
}

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
    updateHeaderAvatar(data.user);
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

function updateHeaderAvatar(user) {
    const header = $("header-profile");
    const avatar = header?.querySelector("img");
    const icon = header?.querySelector("svg");
    if (!avatar || !icon) return;
    avatar.onload = null;
    avatar.onerror = null;
    avatar.hidden = true;
    icon.hidden = false;
    avatar.removeAttribute("src");
    if (user?.photo_url) {
        avatar.onload = () => { avatar.hidden = false; icon.hidden = true; };
        avatar.onerror = () => { avatar.hidden = true; icon.hidden = false; };
        avatar.src = user.photo_url;
    }
}

export function requestMaxCameraAccess() {
    return bridge ? requestBridgeCameraAccess() : null;
}

async function requestBridgeCameraAccess() {
    const app = await Promise.race([bridge, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    const manager = app?.PermissionsManager;
    if (!manager) return;
    if (!manager.isInited) await manager.init();
    try {
        await manager.requestAccess(["camera"], "Для съёмки знака и автомобиля");
    } catch (error) {
        const code = error?.error?.code || "";
        if (code.endsWith("app_permission_denied")) {
            throw new DOMException("Разрешите доступ к камере в настройках мини-приложения MAX.", "MaxAppPermissionDenied");
        }
        if (code.endsWith("system_permission_denied")) {
            throw new DOMException("Разрешите доступ MAX к камере в настройках устройства.", "MaxSystemPermissionDenied");
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
    if (currentTab === "home") {
        accountDialog.append(accountForm);
        if (!accountDialog.open) accountDialog.showModal();
    } else {
        panelContent.replaceChildren(element("h3", "Вход"), accountForm);
    }
}

export async function requireAccount(action) {
    const version = panelVersion;
    try {
        if (loginRequest) await loginRequest;
        const data = await request("/api/session");
        if (version !== panelVersion) return;
        setSession(data);
    } catch (error) {
        if (version !== panelVersion) return;
        const content = currentTab === "home" ? openModalPanel("Вход") : panelContent;
        showSessionError(content, error, () => {
            if (panel.open) panel.close();
            requireAccount(action);
        });
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
    if (loginRequest) return;
    const action = afterLogin;
    const version = panelVersion;
    const input = session.mode === "test"
        ? Object.fromEntries(new FormData(accountForm))
        : { init_data: initData() };
    accountSubmit.disabled = true;
    accountMessage.textContent = "Входим…";
    try {
        loginRequest = request("/api/session", input);
        const data = await loginRequest;
        if (version !== panelVersion || action !== afterLogin) return;
        setSession(data);
        accountForm.reset();
        if (accountDialog.open) accountDialog.close();
        afterLogin = null;
        action?.();
    } catch (error) {
        if (version === panelVersion && action === afterLogin) accountMessage.textContent = error.message;
    } finally {
        loginRequest = null;
        accountSubmit.disabled = session.mode === "max" && !initData();
    }
});
accountDialog.addEventListener("close", () => {
    if (!accountDialog.open && currentTab === "home") afterLogin = null;
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

function openModalPanel(title) {
    $("panel-title").textContent = title;
    const content = $("panel-content");
    content.replaceChildren();
    if (!panel.open) panel.showModal();
    return content;
}

function openPanel(title) {
    panelVersion += 1;
    if (panelContent.contains(accountForm)) accountDialog.append(accountForm);
    $("tab-title").textContent = title;
    panelContent.replaceChildren();
    window.scrollTo(0, 0);
    return panelVersion;
}

function activePanel(version) {
    return currentTab !== "home" && panelVersion === version;
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
    const version = openPanel("Мой аккаунт");
    const user = session?.user;
    const identity = element("div", "", "profile-card");
    const avatar = element("span", user ? user.first_name.slice(0, 1).toUpperCase() : "○", "profile-avatar");
    avatar.setAttribute("aria-hidden", "true");
    const text = element("div");
    text.append(element("strong", user ? `${user.first_name} ${user.last_name}`.trim() : "Гость"),
        element("p", user ? `ID MAX: ${user.max_id}` : "Войдите, чтобы отправлять обращения"));
    identity.append(avatar, text);
    panelContent.append(identity);
    const menu = element("div", "", "profile-menu");
    if (user) menu.append(button("Личные данные", showEditProfile));
    menu.append(
        button("Мои достижения", () => navigate("achievements")),
        button("Черновики", () => navigate("history", null, "drafts")),
        button("О проекте", showAbout),
    );
    panelContent.append(menu);

    if (!user) {
        panelContent.append(button("Войти в аккаунт", () => requireAccount(showProfile), true));
        return;
    }
    if (user.reviewer) {
        panelContent.append(button("Очередь проверки", () => showList(true), true));
    } else if (session.review_enabled) {
        const review = element("form", "", "panel-stack capture-section");
        const message = statusMessage();
        review.append(
            element("h3", "Вход для проверяющего"),
            field("Секрет проверяющего", "key", { type: "password", required: true }),
            submitButton("Войти в очередь проверки"), message,
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
            if (activePanel(version)) showProfile();
        } catch (error) {
            logoutMessage.textContent = error.message;
        } finally {
            logout.disabled = false;
        }
    });
    panelContent.append(logout, logoutMessage);
}

function showEditProfile() {
    const version = openPanel("Личные данные");
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
        if (activePanel(version)) showProfile();
    });
    panelContent.append(button("Назад", showProfile), profile);
}

function showAchievements() {
    openPanel("Мои достижения");
    panelContent.append(element("p", "Здесь собраны достижения, которые можно получить во время использования сервиса. Начисление достижений находится в разработке."));
    const grid = element("div", "", "achievement-grid");
    for (const [icon, title, description] of [
        ["★", "Первый шаг", "За первое отправленное обращение"],
        ["◉", "Чёткий кадр", "За два качественных снимка"],
        ["☁", "Всегда на связи", "За успешную синхронизацию"],
        ["⌖", "Внимательный наблюдатель", "За точные координаты и время"],
        ["✓", "Знаю правила", "За ознакомление с правилами сервиса"],
        ["♡", "Надёжный помощник", "За ответственное использование сервиса"],
    ]) {
        const card = element("article", "", "achievement-card");
        const badge = element("span", icon, "achievement-icon");
        badge.setAttribute("aria-hidden", "true");
        card.append(badge, element("strong", title), element("p", description));
        grid.append(card);
    }
    panelContent.append(grid);
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

async function showList(reviewer = false, filter = "sent") {
    const version = openPanel(reviewer ? "Очередь проверки" : "Мои обращения");
    const message = statusMessage("Загружаем обращения…");
    if (!reviewer) {
        const filters = element("div", "", "report-filter");
        for (const [name, label] of [["sent", "Отправленные"], ["drafts", "Черновики"]]) {
            const control = button(label, () => showList(false, name), filter === name);
            control.setAttribute("aria-pressed", String(filter === name));
            filters.append(control);
        }
        panelContent.append(filters);
    }
    panelContent.append(message);
    try {
        const { reports } = await request(reviewer ? "/api/review" : "/api/reports");
        if (!activePanel(version)) return;
        const visible = reviewer ? reports : reports.filter((report) => (report.status === "draft") === (filter === "drafts"));
        if (visible.length === 0) {
            message.classList.add("empty-card");
            message.textContent = reviewer ? "В очереди пока нет обращений." : filter === "drafts"
                ? "Черновиков пока нет." : "Пока нет обращений. После отправки здесь появится их история и статус.";
        } else {
            message.remove();
        }
        for (const report of visible) {
            const card = element("article", "", "report-card");
            const heading = element("div", "", "report-card-head");
            heading.append(element("strong", `Обращение №${report.id}`), reportStatus(report));
            card.append(heading, element("small", `${placeLabel(report)} · ${dateLabel(report.submitted_at || report.created_at)}`));
            if (report.plate_number) {
                card.append(element("p", `Госномер: ${report.plate_number} · Не подтверждён`, "report-plate-summary"));
            }
            if (report.has_photo) {
                const gallery = element("div", "", "report-photos");
                for (const [exists, kind, alt] of [[report.has_photo, "overview", "Основной снимок"], [report.has_detail_photo, "detail", "Дополнительный снимок"]]) {
                    if (!exists) continue;
                    const image = element("img");
                    image.src = `${reviewer ? "/api/review" : "/api/reports"}/${report.id}/photos/${kind}`;
                    image.alt = alt;
                    gallery.append(image);
                }
                card.append(gallery);
            }
            card.append(button("Подробнее об обращении", () => showDetails(report.id, reviewer, filter)));
            panelContent.append(card);
        }
    } catch (error) {
        message.textContent = error.message;
        if (activePanel(version)) panelContent.append(button("Повторить", () => showList(reviewer, filter)));
    }
}

export function showHistory(identifier) {
    navigate("history", identifier);
}

async function showDetails(identifier, reviewer = false, filter = "sent") {
    const version = openPanel(`Обращение №${identifier}`);
    const message = statusMessage("Загружаем обращение…");
    panelContent.append(button("К списку", () => showList(reviewer, filter)), message);
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
        if (report.plate_number) {
            const plate = element("div", "", "report-plate-summary");
            plate.append(element("strong", report.plate_number), element("span", "Не подтверждён"));
            panelContent.append(plate);
        }
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
        if (reviewer && report.author) showAuthorControls(report, path, version);
        if (reviewer && ["pending", "under_review"].includes(report.status)) {
            showReviewForm(report, path, version);
        }
    } catch (error) {
        message.textContent = error.message;
        if (activePanel(version)) panelContent.append(button("Повторить", () => showDetails(identifier, reviewer, filter)));
    }
}

function showAuthorControls(report, path, version) {
    const author = report.author;
    const card = element("section", "", "panel-stack capture-section");
    card.append(
        element("h3", "Автор обращения"),
        element("p", `${author.first_name} ${author.last_name}`.trim()),
        element("p", `ID MAX: ${author.max_id}`),
        element("p", author.banned ? "Аккаунт заблокирован" : "Аккаунт активен"),
    );
    if (author.banned && author.ban_reason) {
        card.append(element("p", `Причина: ${author.ban_reason}`, "report-comment"));
    }
    const form = element("form", "", "panel-stack");
    const message = statusMessage();
    if (!author.banned) {
        form.append(field("Причина блокировки", "reason", { multiline: true, maxLength: 1000, required: true }));
    }
    const submit = submitButton(author.banned ? "Разблокировать аккаунт" : "Заблокировать аккаунт");
    form.append(submit, message);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        message.textContent = "Сохраняем…";
        try {
            const reason = author.banned ? "" : new FormData(form).get("reason");
            await request(`${path}/author-ban`, { banned: !author.banned, reason });
            if (activePanel(version)) showDetails(report.id, true);
        } catch (error) {
            message.textContent = error.message;
        } finally {
            submit.disabled = false;
        }
    });
    card.append(form);
    panelContent.append(card);
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
    const content = openModalPanel("О проекте");
    content.append(
        element("p", "«ЧУЖОЕ МЕСТО» помогает сохранять доступность парковочных мест для людей с инвалидностью."),
        element("h3", "Как отправить обращение"),
    );
    const steps = element("ol", "", "report-events");
    for (const step of [
        "Разрешите геолокацию и проверьте, что адрес соответствует месту.",
        "Снимите автомобиль, госномер и парковочный знак. Если всё хорошо видно на одном кадре, второго не нужно.",
        "Отправьте материалы на внутреннюю проверку и смотрите решение в разделе «Мои обращения».",
    ]) steps.append(element("li", step));
    content.append(steps, element("p", "Результат внутренней проверки описывает качество и содержание материалов."));
}

function tabFromUrl() {
    const tab = new URL(location.href).searchParams.get("tab");
    return Object.hasOwn(tabTitles, tab) ? tab : "home";
}

function renderTab(tab, identifier, filter = "sent") {
    const tabs = Object.keys(tabTitles);
    const tabIndex = tabs.indexOf(tab);
    const direction = Math.sign(tabIndex - tabs.indexOf(currentTab));
    document.querySelector(".tab-bar").style.setProperty("--indicator-offset", `${tabIndex * 100}%`);
    currentTab = tab;
    afterLogin = null;
    if (accountDialog.open) accountDialog.close();
    if (panel.open) panel.close();
    $("home-content").hidden = tab !== "home";
    $("tab-screen").hidden = tab === "home";
    for (const name of tabs) {
        const control = $("open-" + name);
        if (name === tab) control.setAttribute("aria-current", "page");
        else control.removeAttribute("aria-current");
    }
    openPanel(tabTitles[tab]);
    if (tab === "home") return;
    if (direction && window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
        tabAnimation?.cancel();
        tabAnimation = $("tab-screen").animate?.([
            { opacity: 0.3, transform: `translateX(${direction * 22}px)` },
            { opacity: 1, transform: "none" },
        ], { duration: 360, easing: "cubic-bezier(.25,.7,.25,1)" });
    }
    panelContent.append(statusMessage("Загрузка…"));
    if (tab === "achievements") {
        showAchievements();
        return;
    }
    if (tab === "profile") {
        const version = panelVersion;
        request("/api/session").then((data) => {
            if (activePanel(version)) { setSession(data); showProfile(); }
        }).catch((error) => {
            if (activePanel(version)) showSessionError(panelContent, error, () => renderTab("profile"));
        });
        return;
    }
    requireAccount(() => {
        if (identifier) showDetails(identifier);
        else showList(false, filter);
    });
}

function navigate(tab, identifier, filter) {
    if (tab !== currentTab) {
        const url = new URL(location.href);
        if (tab === "home") url.searchParams.delete("tab");
        else url.searchParams.set("tab", tab);
        history.pushState(null, "", url);
    }
    renderTab(tab, identifier, filter);
}

for (const tab of Object.keys(tabTitles)) {
    $("open-" + tab).addEventListener("click", () => navigate(tab));
}
window.addEventListener("popstate", () => renderTab(tabFromUrl()));
$("open-about").addEventListener("click", showAbout);
$("home-reports").addEventListener("click", () => navigate("history"));
$("header-profile")?.addEventListener("click", () => navigate("profile"));
request("/api/session").then((data) => {
    if (session === null) setSession(data);
}).catch(() => {});
if (tabFromUrl() !== "home") renderTab(tabFromUrl());
