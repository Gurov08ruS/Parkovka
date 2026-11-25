import { request, initData, element, statusMessage, button, submitButton, field, formHandler, panelLink } from "./ui.js";
import { appendReportDetails, reportCard, decisionStats, reviewPageUrl } from "./report-view.js";

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
let session = null;
let afterLogin = null;
let panelVersion = 0;
let bridge;
let editDraft;

export function registerDraftEditor(editor) {
    editDraft = editor;
}

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
    if (currentTab === "home" || $("report-dialog").open) {
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
        const content = currentTab === "home" || $("report-dialog").open ? openModalPanel("Вход") : panelContent;
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
    action(session.user);
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
        action?.(session.user);
    } catch (error) {
        if (version === panelVersion && action === afterLogin) accountMessage.textContent = error.message;
    } finally {
        loginRequest = null;
        accountSubmit.disabled = session.mode === "max" && !initData();
    }
});
accountDialog.addEventListener("close", () => {
    if (!accountDialog.open) afterLogin = null;
});

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
    const stats = element("section", "", "panel-stack capture-section");
    const statsMessage = statusMessage("Загружаем статистику…");
    stats.append(element("h3", "Мои обращения"), statsMessage);
    identity.after(stats);
    request("/api/reports/stats").then((data) => {
        if (activePanel(version)) statsMessage.replaceWith(decisionStats(data));
    }).catch((error) => {
        if (activePanel(version)) statsMessage.textContent = error.message;
    });
    if (user.reviewer) {
        panelContent.append(panelLink("Кабинет проверяющего", reviewPageUrl(), true));
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

async function showList(filter = "sent") {
    const version = openPanel("Мои обращения");
    const filters = element("div", "", "report-filter");
    for (const [name, label] of [["sent", "Отправленные"], ["drafts", "Черновики"]]) {
        const control = button(label, () => navigate("history", undefined, name), filter === name);
        control.setAttribute("aria-pressed", String(filter === name));
        filters.append(control);
    }
    const message = statusMessage("Загружаем обращения…");
    panelContent.append(filters, message);
    try {
        const { reports } = await request("/api/reports");
        if (!activePanel(version)) return;
        const visible = reports.filter((report) => {
            const draft = report.status === "draft" || (report.auto_rejected && !report.submitted_at);
            return draft === (filter === "drafts");
        });
        if (visible.length === 0) {
            message.classList.add("empty-card");
            message.textContent = filter === "drafts"
                ? "Черновиков пока нет." : "Пока нет обращений. После отправки здесь появится их история и статус.";
            return;
        }
        message.remove();
        for (const report of visible) {
            const control = button("Подробнее об обращении", () => showDetails(report.id, filter));
            panelContent.append(reportCard(report, `/api/reports/${report.id}`, control));
        }
    } catch (error) {
        if (!activePanel(version)) return;
        message.textContent = error.message;
        panelContent.append(button("Повторить", () => showList(filter)));
    }
}

export function showHistory(identifier, filter) {
    navigate("history", identifier, filter);
}

async function showDetails(identifier, filter = "sent") {
    const version = openPanel(`Обращение №${identifier}`);
    const message = statusMessage("Загружаем обращение…");
    panelContent.append(button("К списку", () => showList(filter)), message);
    const path = `/api/reports/${identifier}`;
    try {
        const report = await request(path);
        if (!activePanel(version)) return;
        message.remove();
        appendReportDetails(panelContent, report, path);
        if (report.capture_id && editDraft) {
            panelContent.append(button("Продолжить черновик", () => editDraft(report), true));
        }
    } catch (error) {
        if (!activePanel(version)) return;
        message.textContent = error.message;
        panelContent.append(button("Повторить", () => showDetails(identifier, filter)));
    }
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
            if (!activePanel(version)) return;
            setSession(data);
            showProfile();
        }).catch((error) => {
            if (activePanel(version)) showSessionError(panelContent, error, () => renderTab("profile"));
        });
        return;
    }
    requireAccount(() => {
        if (identifier) showDetails(identifier);
        else showList(filter);
    });
}

function tabUrl(tab, filter) {
    const url = new URL(location.href);
    if (tab === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    if (tab === "history" && filter === "drafts") url.searchParams.set("filter", "drafts");
    else url.searchParams.delete("filter");
    url.searchParams.delete("review");
    return url;
}

function navigate(tab, identifier, filter) {
    const url = tabUrl(tab, filter);
    if (url.href !== location.href) history.pushState(null, "", url);
    renderTab(tab, identifier, filter);
}

function renderLocation() {
    const tab = tabFromUrl();
    const params = new URL(location.href).searchParams;
    const review = params.get("review");
    if (tab === "profile" && (review === "queue" || /^[1-9][0-9]{0,18}$/.test(review))) {
        location.replace(reviewPageUrl(review === "queue" ? undefined : review));
        return;
    }
    renderTab(tab, undefined, params.get("filter") === "drafts" ? "drafts" : "sent");
}

for (const tab of Object.keys(tabTitles)) {
    $("open-" + tab).addEventListener("click", () => navigate(tab));
}
window.addEventListener("popstate", renderLocation);
$("open-about").addEventListener("click", showAbout);
$("home-reports").addEventListener("click", () => navigate("history"));
$("header-profile")?.addEventListener("click", () => navigate("profile"));
request("/api/session").then((data) => {
    if (session === null) setSession(data);
}).catch(() => {});
if (tabFromUrl() !== "home") renderLocation();
